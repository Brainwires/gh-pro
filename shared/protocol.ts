// The client API's stream messages (SSE and WebSocket) and their one-line form (`format=line`,
// `gh pro watch`). Pure. Every free-text field is sanitized by the hub; the line form strips control
// characters again, so a line is always one line whatever a hub hands it.

import { clean, type HubEvent } from "./events.ts";

export const API_VERSION = 1;

export interface WireHello {
  readonly type: "hello";
  readonly v: number;
  readonly version: string;
  readonly last_seq: number;
  readonly oldest_seq: number;
  readonly heartbeat_s: number;
}

export type WireEvent = { readonly type: "event" } & HubEvent;

/** Ingress health per webhook path, in the heartbeat. */
export interface WireHookHealth {
  readonly target: string;
  readonly mode: string;
  readonly state: HealthState;
  readonly since: string | null;
}

export type HealthState = "live" | "degraded" | "down" | "gap" | "unknown";

export interface WireStatus {
  readonly type: "status";
  readonly at: string;
  readonly last_seq: number;
  readonly hooks: readonly WireHookHealth[];
  readonly clients: number;
}

/** `since` was older than the oldest retained event: re-read state before trusting the stream. */
export interface WireGap {
  readonly type: "gap";
  readonly from: number;
  readonly to: number;
  readonly oldest_seq: number;
}

/** A slow client lost messages: replay this seq range. */
export interface WireDropped {
  readonly type: "dropped";
  readonly count: number;
  readonly first_seq: number | null;
  readonly last_seq: number | null;
}

export interface WireRestarting {
  readonly type: "hub-restarting";
  readonly at: string;
}

export type WireMessage =
  | WireHello
  | WireEvent
  | WireStatus
  | WireGap
  | WireDropped
  | WireRestarting;

const GLYPH: Record<string, string> = { info: "·", ok: "✓", warn: "!", bad: "✕", muted: "-" };

/** HH:MM:SS of an ISO time or ms, local time. */
function hms(at: string | number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0"))
    .join(":");
}

/** One human-readable line per message. */
export function formatLine(m: WireMessage): string {
  switch (m.type) {
    case "event": {
      const where = m.repo ? ` ${clean(m.repo)}` : m.owner ? ` ${clean(m.owner)}` : "";
      const src = m.source === "webhook" ? "" : ` (${m.source})`;
      return `${hms(m.at)} ${GLYPH[m.sev] ?? "?"} #${m.seq} ${clean(m.kind, 60)}${where}: ${
        clean(m.text, 300)
      }${src}`;
    }
    case "hello":
      return `hub ${clean(m.version, 40)} connected · last seq ${m.last_seq}`;
    case "status": {
      const hooks = m.hooks.map((h) => `${clean(h.target)} ${h.state}`).join(", ") || "no webhooks";
      return `${hms(m.at)} status · seq ${m.last_seq} · ${hooks}`;
    }
    case "gap":
      return `gap: events ${m.from}–${m.to} are no longer kept (oldest ${m.oldest_seq}); ` +
        `re-read state before trusting the stream`;
    case "dropped":
      return `dropped ${m.count} message(s)` +
        (m.first_seq !== null ? ` (seq ${m.first_seq}–${m.last_seq}; replay with --since)` : "");
    case "hub-restarting":
      return `${hms(m.at)} hub restarting`;
  }
}

/** Whether a parsed value looks like a wire message. */
export function isWireMessage(v: unknown): v is WireMessage {
  const t = (v as { type?: unknown } | null)?.type;
  return typeof t === "string" &&
    ["hello", "event", "status", "gap", "dropped", "hub-restarting"].includes(t);
}
