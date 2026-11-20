// `gh webhook forward` as the default onboarding (design §5, path 1): one supervised child per
// forward-mode target, `gh webhook forward --org <o> | --repo <r> --events <list> --url
// http://127.0.0.1:<ingress>/github/hooks --secret <s>`, using GitHub's `cli/gh-webhook` extension
// (installed when missing). GitHub's limits, stated in `hub webhook setup` and `hub status`: testing
// and development only, one forwarder per repo or org at a time ("Hook already exists"), hook-admin
// rights, and delivery only while the machine is awake and the child runs. The hub caps children at
// 20 and suggests a tunnel past that.
//
// A child's exit marks the path `down` (and opens a gap); it restarts with backoff (1 s doubling to
// 5 min; "Hook already exists" waits the full 5 min, since another machine holds the org). Once a
// child runs, the hub looks up the hook it registered (name `cli`, or a `webhook-forwarder` URL) so
// the health pings and redelivery work for it too, when GitHub keeps it listed.
//
// The secret goes on the child's command line (gh-webhook has no other way to take it), so another
// local user may see it in the process list on a shared machine; it only guards the loopback ingress.

import { redactLine } from "../shared/redact.ts";
import type { GitHub } from "./github.ts";
import { hooksApiPath, parseTarget } from "./hooks.ts";

export const MAX_FORWARDERS = 20;
export const BACKOFF_START_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** A child that ran this long resets its backoff. */
export const STABLE_MS = 60_000;

export interface ChildHandle {
  readonly pid: number;
  readonly status: Promise<{ code: number }>;
  readonly stderrLines: AsyncIterable<string>;
  kill(): void;
}

export type Spawner = (cmd: string, args: readonly string[]) => ChildHandle;

/** The real spawner: stdout discarded (forwarded payloads), stderr read for errors. */
export const denoSpawner: Spawner = (cmd, args) => {
  const child = new Deno.Command(cmd, {
    args: [...args],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).spawn();
  return {
    pid: child.pid,
    status: child.status.then((s) => ({ code: s.code })),
    stderrLines: lines(child.stderr),
    kill: () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    },
  };
};

async function* lines(s: ReadableStream<Uint8Array>): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of s.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
    if (buf.length > 8192) buf = buf.slice(-4096);
  }
  if (buf) yield buf;
}

/** `gh webhook forward`'s arguments for a target (no secret: added by the caller). */
export function forwardArgs(
  target: string,
  events: readonly string[],
  ingressPort: number,
): string[] {
  const t = parseTarget(target);
  if (!t) throw new Error(`bad target ${JSON.stringify(target)}`);
  return [
    "webhook",
    "forward",
    t.kind === "org" ? `--org=${t.owner}` : `--repo=${t.repo}`,
    `--events=${events.join(",")}`,
    `--url=http://127.0.0.1:${ingressPort}/github/hooks`,
  ];
}

export interface ForwarderDeps {
  readonly gh: string | null;
  readonly ingressPort: number;
  readonly api: GitHub | null;
  readonly secretFor: (target: string) => Promise<string | null>;
  readonly onExit: (target: string, reason: string) => void;
  readonly onStart: (target: string) => void;
  readonly onHookId: (target: string, id: number | null) => void;
  readonly log: (line: string) => void;
  readonly spawn?: Spawner;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Running {
  child: ChildHandle | null;
  stopped: boolean;
  backoff: number;
  lastError: string | null;
}

export class Forwarders {
  readonly #d: ForwarderDeps;
  readonly #spawn: Spawner;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #kids = new Map<string, Running>();

  constructor(d: ForwarderDeps) {
    this.#d = d;
    this.#spawn = d.spawn ?? denoSpawner;
    this.#now = d.now ?? Date.now;
    this.#sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Install GitHub's gh-webhook extension when missing. */
  async ensureExtension(): Promise<string | null> {
    const gh = this.#d.gh;
    if (!gh) return "gh is not installed in a known location";
    const list = await new Deno.Command(gh, {
      args: ["extension", "list"],
      stdout: "piped",
      stderr: "null",
    })
      .output();
    if (new TextDecoder().decode(list.stdout).includes("cli/gh-webhook")) return null;
    const r = await new Deno.Command(gh, {
      args: ["extension", "install", "cli/gh-webhook"],
      stdout: "null",
      stderr: "piped",
    }).output();
    return r.success ? null : redactLine(new TextDecoder().decode(r.stderr).trim().slice(0, 300));
  }

  running(): { target: string; pid: number | null; error: string | null }[] {
    return [...this.#kids].map(([target, r]) => ({
      target,
      pid: r.child?.pid ?? null,
      error: r.lastError,
    }));
  }

  /** Start supervising a target (no-op when already running). */
  start(target: string, events: readonly string[]): string | null {
    if (this.#kids.has(target)) return null;
    if (!this.#d.gh) return "gh is not installed in a known location";
    if (this.#kids.size >= MAX_FORWARDERS) {
      return `at most ${MAX_FORWARDERS} forwarders: use a tunnel for more (gh pro hub webhook setup --mode tunnel)`;
    }
    const r: Running = { child: null, stopped: false, backoff: BACKOFF_START_MS, lastError: null };
    this.#kids.set(target, r);
    void this.#loop(target, events, r);
    return null;
  }

  async #loop(target: string, events: readonly string[], r: Running): Promise<void> {
    while (!r.stopped) {
      const secret = await this.#d.secretFor(target);
      if (!secret) {
        r.lastError = "webhook secret unreadable";
        this.#d.onExit(target, r.lastError);
        await this.#sleep(BACKOFF_MAX_MS);
        continue;
      }
      const startedAt = this.#now();
      let exists = false;
      try {
        r.child = this.#spawn(this.#d.gh!, [
          ...forwardArgs(target, events, this.#d.ingressPort),
          `--secret=${secret}`,
        ]);
      } catch (e) {
        r.lastError = `spawn failed: ${e instanceof Error ? e.message : e}`;
        this.#d.onExit(target, r.lastError);
        await this.#sleep(r.backoff);
        r.backoff = Math.min(BACKOFF_MAX_MS, r.backoff * 2);
        continue;
      }
      this.#d.log(`forwarder ${target}: started (pid ${r.child.pid})`);
      this.#d.onStart(target);
      void this.#findHook(target);
      const child = r.child;
      void (async () => {
        for await (const line of child.stderrLines) {
          const l = redactLine(line.replaceAll(secret, "[redacted]")).slice(0, 300);
          if (/hook already exists/i.test(l)) exists = true;
          if (l.trim()) this.#d.log(`forwarder ${target}: ${l}`);
        }
      })().catch(() => {});
      const { code } = await child.status;
      r.child = null;
      if (r.stopped) break;
      if (this.#now() - startedAt > STABLE_MS) r.backoff = BACKOFF_START_MS;
      r.lastError = exists
        ? "Hook already exists: another forwarder (another machine or user) holds this target"
        : `exited with code ${code}`;
      this.#d.onExit(target, r.lastError);
      const wait = exists ? BACKOFF_MAX_MS : r.backoff;
      r.backoff = Math.min(BACKOFF_MAX_MS, r.backoff * 2);
      await this.#sleep(wait);
    }
  }

  /** The hook a forwarder registered, for pings and redelivery (when GitHub lists it). */
  async #findHook(target: string): Promise<void> {
    if (!this.#d.api) return;
    await this.#sleep(5000);
    try {
      const r = await this.#d.api.request<
        { id: number; name: string; config?: { url?: string } }[]
      >(
        "GET",
        `${hooksApiPath(target)}?per_page=100`,
        { priority: 1, reason: "health", noCache: true },
      );
      const hook = r.data.find((h) =>
        h.name === "cli" || /webhook-forwarder/.test(h.config?.url ?? "")
      );
      this.#d.onHookId(target, hook?.id ?? null);
    } catch (e) {
      this.#d.log(`forwarder ${target}: hook lookup failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  stop(target: string): void {
    const r = this.#kids.get(target);
    if (!r) return;
    r.stopped = true;
    r.child?.kill();
    this.#kids.delete(target);
  }

  stopAll(): void {
    for (const t of [...this.#kids.keys()]) this.stop(t);
  }
}
