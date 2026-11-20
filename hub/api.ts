// The client API (design §3), the same HTTP/1.1 API on every transport: the Unix socket (primary;
// 0600 in a 0700 folder), the Windows named pipe, and 127.0.0.1:8790 (HTTP / SSE / WebSocket). Every
// request carries a client token (Bearer; `?token=` only on the stream endpoints, for clients that
// can't set headers). On TCP the Host and Origin must be loopback (Fleet's DNS-rebinding rule).
//
//   GET  /v1/hello                        version, seqs, ingress health, scope, budget, scopes
//   GET  /v1/events?since=N&<filters>     a page (limit ≤ 1000): { events, next_seq, has_more, gap? }
//   GET  /v1/events/stream?<filters>      SSE            GET /v1/events/ws?<filters>   WebSocket
//   POST /v1/subscriptions/scope          { owners?, repos? } → synced scope (+ backfill)   [admin]
//   GET  /v1/state/actions/{runs,jobs,runners}?…                                           [read]
//   GET  /v1/search?q=…&kinds=…                                                           [read]
//   GET  /v1/admin/status                 everything `hub status` prints                  [admin]
//   GET|POST /v1/admin/tokens, DELETE /v1/admin/tokens/<name>, POST …/<name>/rotate        [admin]
//   GET  /v1/admin/scope, DELETE /v1/admin/scope/<target>                                 [admin]
//   GET|POST /v1/admin/webhooks, POST /v1/admin/webhooks/test, DELETE /v1/admin/webhooks/<t> [admin]
//   POST /v1/admin/reconcile { since? }   GET /v1/admin/logs?tail=N   POST /v1/admin/stop  [admin]
//
// Phase 2+ endpoints (writes, inbox, sync on demand) answer 501 with the phase that adds them.

import { parseSince, parseSubscription } from "../shared/filter.ts";
import { redactLine } from "../shared/redact.ts";
import type { HubEvent } from "../shared/events.ts";
import type { EventLog } from "./log.ts";
import type { StreamHub } from "./stream.ts";
import { json } from "./stream.ts";
import {
  type ClientRecord,
  hasScope,
  parseScopes,
  type Scope,
  type TokenStore,
  validName,
} from "./tokens.ts";
import type { SyncEngine } from "./sync.ts";
import type { SearchIndex } from "./search.ts";
import { type HookMode, validSecretRef } from "./hooks.ts";
import type { SetupRequest, SetupResult } from "./webhooks.ts";

export type Transport = "unix" | "pipe" | "tcp";

export interface HubServices {
  readonly version: string;
  readonly log: EventLog;
  readonly tokens: TokenStore;
  readonly stream: StreamHub;
  readonly sync: SyncEngine;
  readonly search: SearchIndex;
  hello(): Record<string, unknown>;
  status(): Record<string, unknown>;
  addScope(targets: string[], by: string): Promise<{ added: string[]; existing: string[] }>;
  setupWebhook(req: SetupRequest): Promise<SetupResult>;
  removeWebhook(target: string): boolean;
  webhooks(): unknown[];
  testWebhook(target: string): Promise<string>;
  reconcile(since: number): Promise<unknown>;
  logTail(n: number): Promise<string[]>;
  payload(ref: string): Promise<unknown>;
  stop(): void;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

/** A TCP request whose Host or Origin isn't loopback: refused (a DNS-rebinding page names its own). */
export function loopbackRefusal(req: Request): Response | null {
  const host = req.headers.get("host");
  if (!host || !LOOPBACK.has(hostName(host))) return json(403, { error: "forbidden: host" });
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(u.hostname);
    } catch {
      ok = false;
    }
    if (!ok) return json(403, { error: "forbidden: origin" });
  }
  return null;
}

const STREAM_PATHS = new Set(["/v1/events/stream", "/v1/events/ws"]);

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 64 * 1024) return null;
  try {
    const t = await req.text();
    if (t.length > 64 * 1024) return null;
    const v = t ? JSON.parse(t) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const strList = (v: unknown): string[] | null =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every((s) => typeof s === "string" && s.length < 200)
    ? v as string[]
    : null;

export function createApi(s: HubServices) {
  async function authed(req: Request, url: URL): Promise<ClientRecord | Response> {
    const h = req.headers.get("authorization");
    const token = h?.startsWith("Bearer ")
      ? h.slice(7).trim()
      : STREAM_PATHS.has(url.pathname)
      ? url.searchParams.get("token")
      : null;
    const c = await s.tokens.verify(token);
    if (!c) {
      return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="gh-pro"' });
    }
    return c;
  }

  const need = (c: ClientRecord, sc: Scope): Response | null =>
    hasScope(c, sc) ? null : json(403, { error: `needs the ${sc} scope` });

  async function route(req: Request, url: URL, c: ClientRecord): Promise<Response> {
    const p = url.pathname;
    const m = req.method;
    const q = url.searchParams;

    if (p === "/v1/hello" && m === "GET") {
      return json(200, { ...s.hello(), client: c.name, scopes: c.scopes });
    }

    if (p === "/v1/events" || STREAM_PATHS.has(p)) {
      if (m !== "GET") return json(405, { error: "method not allowed" }, { allow: "GET" });
      const denied = need(c, "read");
      if (denied) return denied;
      const sub = parseSubscription(q, req.headers.get("last-event-id"));
      if (typeof sub === "string") return json(400, { error: sub });
      if (sub.payload === "full" && !hasScope(c, "read:payloads")) {
        return json(403, { error: "payload=full needs the read:payloads scope" });
      }
      if (p === "/v1/events/stream") return s.stream.sse(req, c.name, sub);
      if (p === "/v1/events/ws") return s.stream.ws(req, c.name, sub);
      // A page: `since` defaults to 0 here (a page reads history), not `now`.
      const since = q.has("since") ? s.log.resolveSince(sub.since) : 0;
      const limit = Number(q.get("limit") ?? 100);
      if (!Number.isInteger(limit) || limit < 1) return json(400, { error: "limit must be ≥ 1" });
      const page = s.log.page(sub.filter, since, limit);
      let events: HubEvent[] = page.events;
      if (sub.payload === "none") {
        events = events.map((e) => ({ ...e, data: {}, payload_ref: undefined }));
      }
      if (sub.payload === "full") {
        events = await Promise.all(
          events.map(async (
            e,
          ) => (e.payload_ref ? { ...e, payload: await s.payload(e.payload_ref) } : e)),
        );
      }
      return json(200, { ...page, events });
    }

    if (p === "/v1/subscriptions/scope" && m === "POST") {
      const denied = need(c, "admin");
      if (denied) return denied;
      const b = await body(req);
      const owners = strList(b?.owners);
      const repos = strList(b?.repos);
      const projects = strList(b?.projects);
      if (!b || !owners || !repos || !projects) {
        return json(400, { error: "{ owners?, repos? } as string lists" });
      }
      if (projects.length) return json(501, { error: "Projects scope arrives in phase 4" });
      try {
        return json(200, await s.addScope([...owners, ...repos], c.name));
      } catch (e) {
        return json(400, { error: redactLine(e instanceof Error ? e.message : String(e)) });
      }
    }

    if (p.startsWith("/v1/state/") && m === "GET") {
      const denied = need(c, "read");
      if (denied) return denied;
      const limit = q.has("limit") ? Number(q.get("limit")) : undefined;
      if (p === "/v1/state/actions/runs") {
        return json(200, {
          runs: s.sync.runs({
            repo: q.get("repo") ?? undefined,
            status: q.get("status") ?? undefined,
            branch: q.get("branch") ?? undefined,
            limit,
          }),
        });
      }
      if (p === "/v1/state/actions/jobs") {
        const run = q.get("run_id");
        if (run !== null && !/^\d{1,15}$/.test(run)) {
          return json(400, { error: "run_id must be a number" });
        }
        return json(200, {
          jobs: s.sync.jobs({
            runId: run === null ? undefined : Number(run),
            status: q.get("status") ?? undefined,
            limit,
          }),
        });
      }
      if (p === "/v1/state/actions/runners") {
        return json(200, { runners: s.sync.runners(q.get("owner") ?? undefined) });
      }
      return json(501, {
        error: "this state view arrives in a later phase (pools: 2; issues, PRs, boards: 4)",
      });
    }

    if (p === "/v1/search" && m === "GET") {
      const denied = need(c, "read");
      if (denied) return denied;
      const qs = q.get("q") ?? "";
      if (qs.length > 500) return json(400, { error: "q is too long" });
      const kinds = (q.get("kinds") ?? "").split(",").filter(Boolean);
      return json(200, { mode: s.search.mode, hits: s.search.search(qs, { kinds }) });
    }

    if (p === "/v1/writes" || p.startsWith("/v1/writes/")) {
      return json(501, { error: "writes arrive in phase 2 (actions) and 4" });
    }
    if (p.startsWith("/v1/inbox")) return json(501, { error: "the inbox arrives in phase 4" });
    if (p === "/v1/sync") return json(501, { error: "on-demand reads arrive in phase 2 and 4" });

    if (p.startsWith("/v1/admin/")) {
      const denied = need(c, "admin");
      if (denied) return denied;
      return await admin(req, url, c);
    }
    return json(404, { error: "not found" });
  }

  async function admin(req: Request, url: URL, c: ClientRecord): Promise<Response> {
    const p = url.pathname.slice("/v1/admin".length);
    const m = req.method;
    if (p === "/status" && m === "GET") return json(200, s.status());
    if (p === "/tokens" && m === "GET") return json(200, { clients: s.tokens.list() });
    if (p === "/tokens" && m === "POST") {
      const b = await body(req);
      const name = String(b?.name ?? "");
      if (!validName(name)) {
        return json(400, { error: "name: lower-case letters, digits, - and _" });
      }
      const scopes = parseScopes(String(b?.scopes ?? "read"));
      if (typeof scopes === "string") return json(400, { error: scopes });
      const path = await s.tokens.create(name, scopes, b?.agent === true);
      return json(201, { name, scopes, agent: b?.agent === true, token_file: path });
    }
    let mm = /^\/tokens\/([a-z0-9_-]{1,40})(\/rotate)?$/.exec(p);
    if (mm && m === "DELETE" && !mm[2]) {
      if (mm[1] === c.name) return json(400, { error: "a client can't revoke its own token" });
      return (await s.tokens.revoke(mm[1]))
        ? json(200, { revoked: mm[1] })
        : json(404, { error: "no such client" });
    }
    if (mm && m === "POST" && mm[2]) {
      try {
        return json(200, { name: mm[1], token_file: await s.tokens.rotate(mm[1]) });
      } catch (e) {
        return json(404, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (p === "/scope" && m === "GET") return json(200, { scope: s.sync.scopeList() });
    mm = /^\/scope\/(.+)$/.exec(p);
    if (mm && m === "DELETE") {
      const t = decodeURIComponent(mm[1]);
      return s.sync.removeScope(t)
        ? json(200, { removed: t })
        : json(404, { error: "not in scope" });
    }
    if (p === "/webhooks" && m === "GET") return json(200, { webhooks: s.webhooks() });
    if (p === "/webhooks" && m === "POST") {
      const b = await body(req);
      if (!b || typeof b.target !== "string") return json(400, { error: "target is required" });
      const mode = (b.mode ?? "forward") as HookMode;
      if (!["forward", "tunnel", "relay"].includes(mode)) {
        return json(400, { error: "mode: forward, tunnel or relay" });
      }
      const events = strList(b.events);
      if (!events) return json(400, { error: "events: a string list" });
      const secret = b.secret === undefined ? undefined : validSecretRef(b.secret);
      if (secret === null) {
        return json(400, { error: "secret: a reference (file / keychain / env), never a value" });
      }
      const hookId = b.hook_id === undefined ? undefined : Number(b.hook_id);
      if (hookId !== undefined && !Number.isInteger(hookId)) {
        return json(400, { error: "hook_id: a number" });
      }
      try {
        const r = await s.setupWebhook({
          target: b.target,
          mode,
          url: typeof b.url === "string" ? b.url : undefined,
          events,
          secret,
          hookId,
          updateEvents: b.update_events === true,
        });
        return json(200, {
          target: r.path.target,
          mode: r.path.mode,
          hook_id: r.path.hookId,
          notes: r.notes,
          tunnel_config: r.tunnelConfig,
        });
      } catch (e) {
        return json(400, { error: redactLine(e instanceof Error ? e.message : String(e)) });
      }
    }
    mm = /^\/webhooks\/(.+)$/.exec(p);
    if (mm && m === "DELETE" && mm[1] !== "test") {
      const t = decodeURIComponent(mm[1]);
      return s.removeWebhook(t)
        ? json(200, { removed: t })
        : json(404, { error: "no such webhook path" });
    }
    if (p === "/webhooks/test" && m === "POST") {
      const b = await body(req);
      if (!b || typeof b.target !== "string") return json(400, { error: "target is required" });
      try {
        return json(200, { result: await s.testWebhook(b.target) });
      } catch (e) {
        return json(400, { error: redactLine(e instanceof Error ? e.message : String(e)) });
      }
    }
    if (p === "/reconcile" && m === "POST") {
      const b = await body(req);
      const since = parseSince(typeof b?.since === "string" ? b.since : "-1h");
      if (typeof since === "string" || !("ageMs" in since)) {
        return json(400, { error: "since: an age like -2h" });
      }
      return json(200, { results: await s.reconcile(Date.now() - since.ageMs) });
    }
    if (p === "/logs" && m === "GET") {
      const n = Math.max(1, Math.min(Number(url.searchParams.get("tail") ?? 200) || 200, 5000));
      return json(200, { lines: await s.logTail(n) });
    }
    if (p === "/stop" && m === "POST") {
      setTimeout(() => s.stop(), 50);
      return json(202, { stopping: true });
    }
    return json(404, { error: "not found" });
  }

  /** The handler for one transport. */
  return (transport: Transport) => async (req: Request): Promise<Response> => {
    if (transport === "tcp") {
      const refused = loopbackRefusal(req);
      if (refused) return refused;
    }
    const url = new URL(req.url);
    const c = await authed(req, url);
    if (c instanceof Response) return c;
    try {
      return await route(req, url, c);
    } catch (e) {
      return json(500, { error: redactLine(e instanceof Error ? e.message : String(e)) });
    }
  };
}
