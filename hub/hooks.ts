// Webhook paths (design §5): one per target, an org (`acme`) or a repo (`acme/web`), each in one
// mode: `forward` (gh webhook forward, the default onboarding), `tunnel` (your own public endpoint)
// or `relay` (smee.io and the like). Stored in the database's `hooks` table.
//
// Secrets are references, never values in the table or settings: `file` (a 0600 file in the state
// folder, generated), `keychain` (a macOS login-keychain item, read through /usr/bin/security) or
// `env` (an environment variable's name). They are resolved into memory for the ingress only.

import type { DatabaseSync } from "node:sqlite";
import { writePrivateFile } from "../shared/paths.ts";

export type HookMode = "forward" | "tunnel" | "relay";

export type SecretRef =
  | { readonly source: "file"; readonly path: string }
  | { readonly source: "keychain"; readonly service: string; readonly account: string }
  | { readonly source: "env"; readonly name: string };

export interface HookPath {
  readonly target: string;
  readonly hookId: number | null;
  readonly mode: HookMode;
  readonly url: string | null;
  readonly events: readonly string[];
  readonly secret: SecretRef;
  readonly createdAt: number;
  readonly lastDeliveryAt: number | null;
  readonly lastPingAt: number | null;
  readonly lastReconciledAt: number | null;
}

/** The shortest webhook secret accepted (Fleet's rule: a short HMAC key is guessable offline). */
export const MIN_SECRET_LENGTH = 32;
export const SECURITY_BIN = "/usr/bin/security";

/** `acme` → org, `acme/web` → repo; null when neither. */
export function parseTarget(
  t: string,
): { kind: "org" | "repo"; owner: string; repo?: string } | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9._-]{1,100}))?$/.exec(t);
  if (!m) return null;
  return m[2]
    ? { kind: "repo", owner: m[1], repo: `${m[1]}/${m[2]}` }
    : { kind: "org", owner: m[1] };
}

/** The REST path of a target's hooks: `/orgs/acme/hooks` or `/repos/acme/web/hooks`. */
export function hooksApiPath(target: string): string {
  const t = parseTarget(target);
  if (!t) throw new Error(`bad target ${JSON.stringify(target)}`);
  return t.kind === "org" ? `/orgs/${t.owner}/hooks` : `/repos/${t.repo}/hooks`;
}

export function validSecretRef(v: unknown): SecretRef | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (r.source === "file" && typeof r.path === "string" && r.path) {
    return { source: "file", path: r.path };
  }
  if (
    r.source === "keychain" && typeof r.service === "string" && r.service &&
    typeof r.account === "string" && r.account
  ) return { source: "keychain", service: r.service, account: r.account };
  if (r.source === "env" && typeof r.name === "string" && /^[A-Z_][A-Z0-9_]{0,63}$/.test(r.name)) {
    return { source: "env", name: r.name };
  }
  return null;
}

/** A secret as read, if it is long enough to use (never logged either way). */
export function usableSecret(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\r?\n$/, "");
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

/** Resolve a reference into memory; null when it can't be read or is too short. */
export async function readSecret(ref: SecretRef): Promise<string | null> {
  try {
    if (ref.source === "file") return usableSecret(await Deno.readTextFile(ref.path));
    if (ref.source === "env") return usableSecret(Deno.env.get(ref.name));
    if (Deno.build.os !== "darwin") return null;
    const r = await new Deno.Command(SECURITY_BIN, {
      args: ["find-generic-password", "-s", ref.service, "-a", ref.account, "-w"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return r.success ? usableSecret(new TextDecoder().decode(r.stdout)) : null;
  } catch {
    return null;
  }
}

/** A new 32-byte secret, hex, written 0600 to `path` (kept when one is already there). */
export async function ensureFileSecret(path: string): Promise<SecretRef> {
  const had = await readSecret({ source: "file", path });
  if (!had) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    await writePrivateFile(
      path,
      [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") + "\n",
    );
  }
  return { source: "file", path };
}

type Row = {
  target: string;
  hook_id: number | null;
  mode: HookMode;
  url: string | null;
  events: string;
  secret_ref: string;
  created_at: number;
  last_delivery_at: number | null;
  last_ping_at: number | null;
  last_reconciled_at: number | null;
};

const fromRow = (r: Row): HookPath => ({
  target: r.target,
  hookId: r.hook_id === null ? null : Number(r.hook_id),
  mode: r.mode,
  url: r.url,
  events: JSON.parse(r.events),
  secret: JSON.parse(r.secret_ref),
  createdAt: Number(r.created_at),
  lastDeliveryAt: r.last_delivery_at === null ? null : Number(r.last_delivery_at),
  lastPingAt: r.last_ping_at === null ? null : Number(r.last_ping_at),
  lastReconciledAt: r.last_reconciled_at === null ? null : Number(r.last_reconciled_at),
});

export class HookStore {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}

  list(): HookPath[] {
    return (this.db.prepare("SELECT * FROM hooks ORDER BY target").all() as Row[]).map(fromRow);
  }

  get(target: string): HookPath | null {
    const r = this.db.prepare("SELECT * FROM hooks WHERE target = ? COLLATE NOCASE").get(target) as
      | Row
      | undefined;
    return r ? fromRow(r) : null;
  }

  byHookId(id: number): HookPath | null {
    const r = this.db.prepare("SELECT * FROM hooks WHERE hook_id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  upsert(h: Pick<HookPath, "target" | "mode" | "url" | "events" | "secret" | "hookId">): HookPath {
    this.db.prepare(
      `INSERT INTO hooks (target, hook_id, mode, url, events, secret_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(target) DO UPDATE SET hook_id = excluded.hook_id, mode = excluded.mode,
         url = excluded.url, events = excluded.events, secret_ref = excluded.secret_ref`,
    ).run(
      h.target,
      h.hookId,
      h.mode,
      h.url,
      JSON.stringify(h.events),
      JSON.stringify(h.secret),
      this.now(),
    );
    return this.get(h.target)!;
  }

  remove(target: string): boolean {
    return Number(
      this.db.prepare("DELETE FROM hooks WHERE target = ? COLLATE NOCASE").run(target).changes,
    ) > 0;
  }

  setHookId(target: string, id: number | null): void {
    this.db.prepare("UPDATE hooks SET hook_id = ? WHERE target = ?").run(id, target);
  }

  touch(
    target: string,
    field: "last_delivery_at" | "last_ping_at" | "last_reconciled_at",
    at: number,
  ) {
    this.db.prepare(`UPDATE hooks SET ${field} = ? WHERE target = ?`).run(at, target);
  }

  /**
   * The path that covers a scope target: the repo's own, else its owner's (an org hook covers every
   * repo of the org). `acme/web` → `acme/web` or `acme`; `acme` → `acme`.
   */
  covering(target: string): HookPath | null {
    const t = parseTarget(target.replace(/\/\d+$/, "").replace(/^([^/]+)\/project-\d+$/, "$1"));
    if (!t) return null;
    return (t.repo ? this.get(t.repo) : null) ?? this.get(t.owner);
  }

  /** The path a delivery belongs to: by hook id, else by its repository / organization. */
  forDelivery(hookId: number | null, repo: string | undefined, owner: string): HookPath | null {
    if (hookId !== null) {
      const h = this.byHookId(hookId);
      if (h) return h;
    }
    return (repo ? this.get(repo) : null) ?? (owner ? this.get(owner) : null);
  }
}
