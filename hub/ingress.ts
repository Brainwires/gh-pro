// GitHub's ingress: `POST /github/hooks` on its own 127.0.0.1 listener (8789 by default), the only
// route (everything else is 404), so a tunnel can never reach the client API. Ported from Fleet's
// lib/hooks.ts with its behaviour kept, in order, before anything is parsed:
//
// 1. one route: anything but `POST /github/hooks` is 404;
// 2. `content-type: application/json`, else 415;
// 3. the body is at most 1 MiB for Actions events and 25 MiB (GitHub's own cap) for the rest, else
//    413 (a larger Content-Length is refused unread; a longer stream is cut off at the cap). The cap
//    is picked from the unverified X-GitHub-Event header: it only sizes the read;
// 4. `X-Hub-Signature-256` is the HMAC-SHA256 of the raw body under one of the known webhook
//    secrets (each path may have its own; constant-time compare), else 401 and nothing else is read;
// 5. then: `ping` → 200 (the health check's answer); every other event → 202 and queued. A delivery
//    id seen before is acknowledged and dropped (14 days of ids in the database). An Actions delivery
//    whose newest timestamp is over 10 min old is a replay and dropped, unless its GUID is one the hub
//    itself asked GitHub to redeliver (reconciliation), which may be up to 3 days old.
//
// Payloads are data: nothing in one is executed, fetched or handed to a shell.

import { ACTIONS_EVENTS } from "./normalize.ts";

export const HOOK_PATH = "/github/hooks";
export const HOOK_HOST = "127.0.0.1";
export const MAX_ACTIONS_BODY = 1024 * 1024;
export const MAX_BODY = 25 * 1024 * 1024;
export const HOOK_MAX_AGE_MS = 10 * 60_000;
export const REDELIVERY_MAX_AGE_MS = 3 * 86_400_000;
/** Delivery ids remembered in memory (the database keeps 14 days). */
export const DEDUPE_KEEP = 10_000;

export interface IngressDelivery {
  readonly id: string;
  readonly event: string;
  readonly hookId: number | null;
  readonly receivedAt: number;
  readonly payload: Record<string, unknown>;
  readonly body: Uint8Array;
  /** One the hub asked GitHub to redeliver. */
  readonly redelivery: boolean;
}

export type RejectReason = "signature" | "size" | "type" | "route" | "json" | "stale" | "no-secret";

export interface IngressOptions {
  /** The webhook secrets to try (each path's own). Never logged. */
  readonly secrets: () => readonly string[];
  readonly onDelivery: (d: IngressDelivery) => void;
  /** Every verified delivery, `ping` included (health: "last delivery", "ping arrived"). */
  readonly onVerified?: (event: string, hookId: number | null, at: number) => void;
  readonly onReject?: (why: RejectReason) => void;
  /** A delivery id already stored (the database's 14 days). */
  readonly isKnown?: (id: string) => boolean;
  /** GUIDs the hub asked to be redelivered; consumed on arrival. */
  readonly expectedRedelivery?: (id: string) => boolean;
  readonly now?: () => number;
  readonly defer?: (fn: () => void) => void;
  readonly clockOffset?: () => number;
}

/** The newest of an Actions delivery's own timestamps (ms), or `null`. */
export function deliveryTime(event: string, payload: Record<string, unknown>): number | null {
  const item = (event === "workflow_job" ? payload.workflow_job : payload.workflow_run) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!item || typeof item !== "object") return null;
  const keys = event === "workflow_job"
    ? ["created_at", "started_at", "completed_at"]
    : ["updated_at", "created_at", "run_started_at"];
  let best: number | null = null;
  for (const k of keys) {
    const v = item[k];
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (the length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `sha256=<hex>` for a body under a secret (what GitHub sends). */
export async function signBody(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, body as BufferSource))}`;
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const len = Number(req.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export function createIngressHandler(o: IngressOptions): (req: Request) => Promise<Response> {
  const now = o.now ?? Date.now;
  const defer = o.defer ?? ((fn) => setTimeout(fn, 0));
  const seen = new Set<string>();
  const order: string[] = [];
  const remember = (id: string) => {
    seen.add(id);
    order.push(id);
    if (order.length > DEDUPE_KEEP) seen.delete(order.shift()!);
  };
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== HOOK_PATH) {
      await req.body?.cancel().catch(() => {});
      o.onReject?.("route");
      return text(404, "not found");
    }
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      await req.body?.cancel().catch(() => {});
      o.onReject?.("type");
      return text(415, "content-type must be application/json");
    }
    const claimed = req.headers.get("x-github-event") ?? "";
    const cap = ACTIONS_EVENTS.has(claimed) || claimed === "ping" ? MAX_ACTIONS_BODY : MAX_BODY;
    const body = await readCapped(req, cap);
    if (body === null) {
      o.onReject?.("size");
      return text(413, "body too large");
    }
    const sig = req.headers.get("x-hub-signature-256") ?? "";
    const secrets = o.secrets();
    if (secrets.length === 0) {
      o.onReject?.("no-secret");
      return text(401, "rejected signature");
    }
    let ok = false;
    for (const s of secrets) {
      // Every secret is tried (no early exit), so timing says nothing about which one matched.
      if (sig && safeEqual(sig, await signBody(s, body))) ok = true;
    }
    if (!ok) {
      o.onReject?.("signature");
      return text(401, "rejected signature");
    }
    // Verified: only now is anything else read.
    const event = claimed;
    const id = req.headers.get("x-github-delivery") ?? "";
    const hookRaw = req.headers.get("x-github-hook-id");
    const hookId = hookRaw && /^\d{1,15}$/.test(hookRaw) ? Number(hookRaw) : null;
    const at = now();
    o.onVerified?.(event, hookId, at);
    if (event === "ping") return text(200, "pong");
    if (!event) return text(202, "no event name");
    if (!id) return text(202, "no delivery id");
    if (seen.has(id) || o.isKnown?.(id)) return text(202, "duplicate");
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      o.onReject?.("json");
      return text(400, "bad json");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      o.onReject?.("json");
      return text(400, "bad json");
    }
    remember(id);
    const redelivery = o.expectedRedelivery?.(id) ?? false;
    if (ACTIONS_EVENTS.has(event)) {
      const t = deliveryTime(event, payload as Record<string, unknown>);
      const ghNow = at + (o.clockOffset?.() ?? 0);
      const maxAge = redelivery ? REDELIVERY_MAX_AGE_MS : HOOK_MAX_AGE_MS;
      if (t !== null && ghNow - t > maxAge) {
        o.onReject?.("stale");
        return text(202, "stale");
      }
    }
    const d: IngressDelivery = {
      id,
      event,
      hookId,
      receivedAt: at,
      payload: payload as Record<string, unknown>,
      body,
      redelivery,
    };
    defer(() => o.onDelivery(d));
    return text(202, "accepted");
  };
}

// ---- the scheduler's spool (Fleet's format, unchanged) ----

export const SPOOL_FILE = "events.jsonl";
export const SPOOL_ROTATE_BYTES = 20 * 1024 * 1024;

/** Append a verified workflow_job / workflow_run delivery to `<dir>/events.jsonl`, rotating at 20 MB. */
export async function appendSpool(d: IngressDelivery, dir: string): Promise<void> {
  if (!ACTIONS_EVENTS.has(d.event)) return;
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = `${dir}/${SPOOL_FILE}`;
  const line = JSON.stringify({
    received_at: new Date(d.receivedAt).toISOString(),
    delivery: d.id,
    event: d.event,
    payload: d.payload,
  }) + "\n";
  try {
    const st = await Deno.stat(path);
    if (st.size + line.length > SPOOL_ROTATE_BYTES) await Deno.rename(path, `${path}.1`);
  } catch {
    // No file yet.
  }
  await Deno.writeTextFile(path, line, { append: true, mode: 0o600 });
}
