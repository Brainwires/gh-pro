// gh-pro: the `gh pro …` extension's entry point (the precompiled binary `gh-pro`). Phase 1 verbs:
//
//   gh pro hub run                       the daemon (what the user service runs)
//   gh pro hub start|stop|restart        start (installing nothing), stop, restart
//   gh pro hub status [--json]           health, webhook paths, gaps, budget, scope, DB, clients
//   gh pro hub install|uninstall         the launchd agent / systemd user unit
//   gh pro hub token create|list|revoke|rotate
//   gh pro hub webhook setup|status|test|remove
//   gh pro hub scope add|remove|list
//   gh pro hub reconcile [--since -2h]
//   gh pro hub logs [--follow] [--tail N]
//   gh pro watch [--derived problems] [--repo r] [--kind k] [--since N] [--json]
//   gh pro version
//
// Read verbs exit 4 when the hub is down (they never call the GitHub API themselves).

import { many, one, parseArgs, type Parsed } from "./args.ts";
import * as service from "./service.ts";
import { watch } from "./watch.ts";
import { HubAuthError, HubClient, HubDown, HubError, readRuntime } from "../shared/client.ts";
import { hubPaths } from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";

export const EXIT = { ok: 0, fail: 1, usage: 2, auth: 3, down: 4 } as const;

const USAGE = `gh pro ${VERSION}: one GitHub client per machine

  gh pro hub start | stop | restart | status [--json] | install | uninstall | run
  gh pro hub token create --name <n> --scopes a,b [--agent] | list | revoke <n> | rotate <n>
  gh pro hub webhook setup <org|owner/repo> [--mode forward|tunnel|relay] [--url https://…/github/hooks]
                           [--events a,b] [--hook-id N [--update-events]]
                           [--secret-keychain service:account | --secret-env NAME | --secret-file PATH]
  gh pro hub webhook status | test <target> | remove <target>
  gh pro hub scope add|remove <owner|owner/repo> | list
  gh pro hub reconcile [--since -2h]
  gh pro hub logs [--follow] [--tail N]
  gh pro watch [--derived problems] [--repo r] [--owner o] [--kind k] [--branch b] [--since N|-1h]
               [--json] [--no-status]
  gh pro version`;

const out = (s: string) => console.log(s);
const err = (s: string) => console.error(s);

async function withClient<T>(fn: (c: HubClient) => Promise<T>): Promise<T> {
  const c = await HubClient.open();
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

function age(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

type Obj = Record<string, unknown>;

export function formatStatus(s: Obj): string {
  const lines: string[] = [];
  const db = s.db as Obj;
  const b = s.budget as Obj;
  lines.push(`hub ${s.version} · pid ${s.pid} · up ${Math.round(Number(s.uptime_s) / 60)} min`);
  lines.push(
    `  ingress 127.0.0.1:${(s.ports as Obj).ingress} · api 127.0.0.1:${
      (s.ports as Obj).api
    } · ${s.socket}`,
  );
  const hooks = (s.webhooks as Obj[]) ?? [];
  lines.push(`webhooks (${hooks.length}):`);
  if (!hooks.length) lines.push("  none: gh pro hub webhook setup <org|owner/repo>");
  for (const h of hooks) {
    lines.push(
      `  ${h.target} · ${h.mode}${h.hook_id ? ` #${h.hook_id}` : ""} · ${h.state}${
        h.reason ? ` (${h.reason})` : ""
      } · ` +
        `last delivery ${age(h.last_delivery_at as string)} · last ping ${
          age(h.last_ping_at as string)
        }`,
    );
    const fw = h.forwarder as Obj | undefined;
    if (fw?.error) lines.push(`    forwarder: ${fw.error}`);
    for (const n of (h.notes as string[] | undefined) ?? []) lines.push(`    note: ${n}`);
  }
  const gaps = s.gaps as { open: Obj[] };
  for (const g of gaps.open) {
    lines.push(
      `  gap open: ${g.target} since ${new Date(Number(g.fromAt)).toISOString()} (${g.reason})`,
    );
  }
  const res = (k: string) => {
    const r = b[k] as Obj | null;
    return r ? `${r.remaining}/${r.limit}` : "?";
  };
  lines.push(
    `budget: core ${res("core")} · graphql ${
      res("graphql")
    } · sync ${b.sync_spent_last_hour}/${b.sync_cap_per_hour} an hour` +
      (b.backoff_until ? ` · backing off until ${b.backoff_until}` : ""),
  );
  const br = b.by_reason as Record<string, number>;
  lines.push(`  reads last hour: ${Object.entries(br).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const miss = s.missing_scopes as string[];
  if (miss?.length) {
    lines.push(`missing scopes: ${miss.join(", ")} → gh auth refresh -s ${miss.join(",")}`);
  }
  const scope = s.scope as Obj[];
  lines.push(
    `scope: ${
      scope.length
        ? scope.map((x) => `${x.target}${x.backfilled_at ? "" : " (backfilling)"}`).join(", ")
        : "none (gh pro hub scope add …)"
    }`,
  );
  lines.push(
    `db: ${
      (Number(db.bytes) / 1048576).toFixed(1)
    } MB · ${db.events} events · seq ${db.oldest_seq}–${db.last_seq} · search ${db.search}`,
  );
  lines.push(
    `clients: ${(s.clients as Obj[]).map((c) => c.name).join(", ")} · ${s.streams} streams`,
  );
  for (const w of (s.settings_warnings as string[]) ?? []) lines.push(`settings: ${w}`);
  return lines.join("\n");
}

async function hubUp(): Promise<Obj | null> {
  try {
    return await withClient((c) => c.get("/v1/hello"));
  } catch {
    return null;
  }
}

async function waitUp(ms: number): Promise<Obj | null> {
  for (let t = 0; t < ms; t += 250) {
    const h = await hubUp();
    if (h) return h;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitDown(ms: number): Promise<boolean> {
  for (let t = 0; t < ms; t += 250) {
    if (!(await hubUp())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function start(): Promise<number> {
  const paths = hubPaths();
  const up = await hubUp();
  if (up) {
    if (up.version === VERSION) {
      out(`hub ${VERSION} is running`);
      return EXIT.ok;
    }
    out(`hub ${up.version} is running; this gh-pro is ${VERSION}: restarting it`);
    await stop();
  }
  if (!(await service.serviceStart())) service.spawnDetached();
  const h = await waitUp(15_000);
  if (!h) {
    err(`the hub didn't come up: see ${paths.log}`);
    return EXIT.fail;
  }
  out(`hub ${h.version} is running (${(await readRuntime(paths))?.socket ?? ""})`);
  const ingress = (h.ingress as Obj[]) ?? [];
  if (!ingress.length) await firstRunWebhook();
  return EXIT.ok;
}

/** First run with no webhook path: offer the default (gh webhook forward) when interactive. */
async function firstRunWebhook(): Promise<void> {
  if (!Deno.stdin.isTerminal()) {
    out("next: gh pro hub webhook setup <org|owner/repo>   (gh webhook forward, the default path)");
    return;
  }
  const target = prompt("Org or owner/repo to receive webhooks for (blank to skip):")?.trim();
  if (!target) {
    out("skipped: gh pro hub webhook setup <org|owner/repo> when ready");
    return;
  }
  await webhookSetup({ pos: [target], vals: new Map(), flags: new Set() });
}

async function stop(): Promise<number> {
  const viaService = await service.serviceStop();
  if (!viaService) {
    try {
      await withClient((c) => c.post("/v1/admin/stop"));
    } catch (e) {
      if (e instanceof HubDown) {
        out("the hub isn't running");
        return EXIT.ok;
      }
      throw e;
    }
  }
  if (await waitDown(15_000)) {
    out("hub stopped");
    return EXIT.ok;
  }
  err("the hub didn't stop within 15 s");
  return EXIT.fail;
}

function secretFlag(p: Parsed): Obj | undefined | string {
  const kc = one(p, "secret-keychain");
  const env = one(p, "secret-env");
  const file = one(p, "secret-file");
  if ([kc, env, file].filter(Boolean).length > 1) return "pick one --secret-* option";
  if (kc) {
    const [service, ...rest] = kc.split(":");
    const account = rest.join(":");
    if (!service || !account) return "--secret-keychain service:account";
    return { source: "keychain", service, account };
  }
  if (env) return { source: "env", name: env };
  if (file) return { source: "file", path: file };
  return undefined;
}

async function webhookSetup(p: Parsed): Promise<number> {
  const target = p.pos[0];
  if (!target) {
    err("usage: gh pro hub webhook setup <org|owner/repo> [--mode …]");
    return EXIT.usage;
  }
  const secret = secretFlag(p);
  if (typeof secret === "string") {
    err(secret);
    return EXIT.usage;
  }
  const hookId = one(p, "hook-id");
  const r = await withClient((c) =>
    c.post("/v1/admin/webhooks", {
      target,
      mode: one(p, "mode") ?? "forward",
      url: one(p, "url"),
      events: many(p, "events"),
      secret,
      hook_id: hookId === undefined ? undefined : Number(hookId),
      update_events: p.flags.has("update-events"),
    })
  );
  out(`${r.target}: ${r.mode}${r.hook_id ? ` (hook ${r.hook_id})` : ""}`);
  for (const n of (r.notes as string[]) ?? []) out(`  · ${n}`);
  if (r.tunnel_config) out(`\n${r.tunnel_config}`);
  return EXIT.ok;
}

async function logs(p: Parsed): Promise<number> {
  const paths = hubPaths();
  const tail = Number(one(p, "tail") ?? 100);
  let text = "";
  try {
    text = await Deno.readTextFile(paths.log);
  } catch {
    err(`no log yet at ${paths.log}`);
    return p.flags.has("follow") ? EXIT.ok : EXIT.fail;
  }
  for (const l of text.split("\n").filter(Boolean).slice(-tail)) out(l);
  if (!p.flags.has("follow")) return EXIT.ok;
  let size = new TextEncoder().encode(text).length;
  // The log file is already redacted by the hub; follow it with a file watch (no API calls).
  for await (const _ of Deno.watchFs(paths.log)) {
    const st = await Deno.stat(paths.log).catch(() => null);
    if (!st) continue;
    if (st.size < size) size = 0;
    if (st.size === size) continue;
    const f = await Deno.open(paths.log);
    await f.seek(size, Deno.SeekMode.Start);
    const buf = new Uint8Array(st.size - size);
    await f.read(buf);
    f.close();
    size = st.size;
    for (const l of new TextDecoder().decode(buf).split("\n").filter(Boolean)) out(l);
  }
  return EXIT.ok;
}

const VALUED = [
  "name",
  "scopes",
  "mode",
  "url",
  "events",
  "hook-id",
  "secret-keychain",
  "secret-env",
  "secret-file",
  "since",
  "tail",
  "derived",
  "repo",
  "owner",
  "kind",
  "branch",
  "pool",
  "subject",
  "gh-event",
  "action",
  "client",
  "payload",
];
const BOOLS = ["json", "agent", "update-events", "follow", "no-status", "help", "foreground"];

export async function main(argv: readonly string[]): Promise<number> {
  const p = parseArgs(argv, VALUED, BOOLS);
  if (typeof p === "string") {
    err(`${p}\n\n${USAGE}`);
    return EXIT.usage;
  }
  const [verb, sub, ...rest] = p.pos;
  if (!verb || p.flags.has("help") || verb === "help") {
    out(USAGE);
    return EXIT.ok;
  }
  if (verb === "version" || verb === "--version") {
    out(`gh-pro ${VERSION}`);
    return EXIT.ok;
  }
  if (verb === "watch") {
    const filter = {
      derived: many(p, "derived"),
      repo: many(p, "repo"),
      owner: many(p, "owner"),
      kind: many(p, "kind"),
      branch: many(p, "branch"),
      pool: many(p, "pool"),
      subject: many(p, "subject"),
      gh_event: many(p, "gh-event"),
      action: many(p, "action"),
    };
    const ac = new AbortController();
    Deno.addSignalListener("SIGINT", () => ac.abort());
    return await watch({
      filter: Object.fromEntries(Object.entries(filter).filter(([, v]) => v.length)),
      since: one(p, "since") ?? null,
      json: p.flags.has("json"),
      status: !p.flags.has("no-status"),
      client: one(p, "client") ?? "cli",
      payload: one(p, "payload") as "none" | "summary" | "full" | undefined,
    }, {
      out,
      err,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      signal: ac.signal,
    });
  }
  if (verb !== "hub") {
    err(
      `unknown verb ${verb} (phase 2 adds runs, jobs, pools, wait, mcp; phase 4 board, triage)\n\n${USAGE}`,
    );
    return EXIT.usage;
  }
  try {
    switch (sub) {
      case "run": {
        const { runHub } = await import("../hub/daemon.ts");
        await runHub({ echo: p.flags.has("foreground") || Deno.stderr.isTerminal() });
        return EXIT.ok;
      }
      case "start":
        return await start();
      case "stop":
        return await stop();
      case "restart":
        await stop();
        return await start();
      case "status": {
        const s = await withClient((c) => c.get("/v1/admin/status"));
        out(p.flags.has("json") ? JSON.stringify(s, null, 2) : formatStatus(s));
        if (s.version !== VERSION) {
          out(`note: the hub runs ${s.version}, this gh-pro is ${VERSION}: gh pro hub restart`);
        }
        return EXIT.ok;
      }
      case "install": {
        const path = await service.install(hubPaths().log);
        out(`installed ${path}`);
        return (await waitUp(15_000)) ? EXIT.ok : EXIT.fail;
      }
      case "uninstall": {
        const path = await service.uninstall();
        out(path ? `removed ${path}` : "nothing installed");
        return EXIT.ok;
      }
      case "token": {
        const [act, name] = rest;
        return await withClient(async (c) => {
          if (act === "list") {
            const r = await c.get("/v1/admin/tokens");
            for (const x of r.clients as Obj[]) {
              out(
                `${x.name}\t${(x.scopes as string[]).join(",")}${
                  x.agent ? "\tagent" : ""
                }\tlast used ${
                  age(x.last_used_at ? new Date(Number(x.last_used_at)).toISOString() : null)
                }`,
              );
            }
            return EXIT.ok;
          }
          if (act === "create") {
            const r = await c.post("/v1/admin/tokens", {
              name: one(p, "name") ?? name,
              scopes: many(p, "scopes").join(",") || "read",
              agent: p.flags.has("agent"),
            });
            out(`${r.name}: ${(r.scopes as string[]).join(",")} → ${r.token_file}`);
            return EXIT.ok;
          }
          if ((act === "revoke" || act === "rotate") && name) {
            const r = act === "revoke"
              ? await c.del(`/v1/admin/tokens/${encodeURIComponent(name)}`)
              : await c.post(`/v1/admin/tokens/${encodeURIComponent(name)}/rotate`);
            out(act === "revoke" ? `revoked ${r.revoked}` : `rotated ${r.name} → ${r.token_file}`);
            return EXIT.ok;
          }
          err(
            "usage: gh pro hub token create --name <n> --scopes a,b [--agent] | list | revoke <n> | rotate <n>",
          );
          return EXIT.usage;
        });
      }
      case "webhook": {
        const [act, target] = rest;
        if (act === "setup") return await webhookSetup({ ...p, pos: rest.slice(1) });
        return await withClient(async (c) => {
          if (act === "status" || act === undefined) {
            const r = await c.get("/v1/admin/webhooks");
            const list = r.webhooks as Obj[];
            if (p.flags.has("json")) out(JSON.stringify(list, null, 2));
            else if (!list.length) {
              out("no webhook paths: gh pro hub webhook setup <org|owner/repo>");
            } else {for (const h of list) {
                out(
                  `${h.target}\t${h.mode}\t${h.state}${
                    h.reason ? ` (${h.reason})` : ""
                  }\tlast delivery ${age(h.last_delivery_at as string)}`,
                );
              }}
            return EXIT.ok;
          }
          if (act === "test" && target) {
            out(String((await c.post("/v1/admin/webhooks/test", { target })).result));
            return EXIT.ok;
          }
          if (act === "remove" && target) {
            await c.del(`/v1/admin/webhooks/${encodeURIComponent(target)}`);
            out(`removed ${target} (the GitHub webhook itself is left in place)`);
            return EXIT.ok;
          }
          err("usage: gh pro hub webhook setup|status|test <target>|remove <target>");
          return EXIT.usage;
        });
      }
      case "scope": {
        const [act, target] = rest;
        return await withClient(async (c) => {
          if (act === "list" || act === undefined) {
            const r = await c.get("/v1/admin/scope");
            for (const s of r.scope as Obj[]) {
              out(
                `${s.target}\t${s.kind}\t${
                  s.backfilled_at
                    ? `backfilled ${age(new Date(Number(s.backfilled_at)).toISOString())}`
                    : "backfilling"
                }`,
              );
            }
            return EXIT.ok;
          }
          if (act === "add" && target) {
            const key = target.includes("/") ? "repos" : "owners";
            const r = await c.post("/v1/subscriptions/scope", { [key]: [target] });
            out(
              (r.added as string[]).length
                ? `added ${target}: backfill running (gh pro watch --kind hub.sync.*)`
                : `${target} is already in scope`,
            );
            return EXIT.ok;
          }
          if (act === "remove" && target) {
            await c.del(`/v1/admin/scope/${encodeURIComponent(target)}`);
            out(`removed ${target}`);
            return EXIT.ok;
          }
          err("usage: gh pro hub scope add|remove <owner|owner/repo> | list");
          return EXIT.usage;
        });
      }
      case "reconcile": {
        const r = await withClient((c) =>
          c.post("/v1/admin/reconcile", { since: one(p, "since") ?? "-1h" })
        );
        const res = r.results as Obj[];
        if (!res.length) out("no webhook paths to reconcile");
        for (const x of res) out(`${x.target}: ${x.state}: ${x.detail}`);
        return EXIT.ok;
      }
      case "logs":
        return await logs(p);
      default:
        err(USAGE);
        return EXIT.usage;
    }
  } catch (e) {
    if (e instanceof HubDown) {
      err(e.message);
      return EXIT.down;
    }
    if (e instanceof HubAuthError) {
      err(e.message);
      return EXIT.auth;
    }
    if (e instanceof HubError) {
      err(e.message);
      return EXIT.fail;
    }
    throw e;
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
