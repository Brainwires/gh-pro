// The hub's event schema (design §3) and the sanitizers every string from GitHub goes through.
// Pure: no I/O. Every string in an event is someone's text (whoever opened the issue, pushed the
// branch or named the workflow): data, never instructions.

/** Where an event came from. `sync` is a backfill or a gap re-read, never a poll. */
export type EventSource = "webhook" | "redelivery" | "sync" | "write" | "derived";

/** A line's severity. `warn` and `bad` are problems. */
export type Severity = "info" | "ok" | "warn" | "bad" | "muted";

export type SubjectType =
  | "run"
  | "job"
  | "issue"
  | "pull"
  | "discussion"
  | "item"
  | "draft"
  | "comment"
  | "review"
  | "runner"
  | "pool"
  | "project"
  | "hook";

export interface Subject {
  readonly type: SubjectType;
  readonly id: string;
  readonly number?: number;
  readonly node_id?: string;
  readonly url?: string;
}

/** One event in the log. */
export interface HubEvent {
  /** Increasing across restarts, never reused. */
  readonly seq: number;
  /** A ULID: stable across replays. */
  readonly id: string;
  /** When it happened (GitHub's timestamp when there is one), ms. */
  readonly at: number;
  /** When the hub learned of it, ms. */
  readonly received_at: number;
  readonly source: EventSource;
  /** Normalized, `<family>.<subject>.<action>`. */
  readonly kind: string;
  readonly gh_event?: string;
  readonly action?: string;
  readonly delivery_id?: string;
  readonly owner: string;
  readonly repo?: string;
  readonly subject?: Subject;
  readonly actor?: { readonly login: string; readonly type: "User" | "Bot" };
  readonly agent?: { readonly client: string; readonly session?: string };
  readonly sev: Severity;
  /** One sanitized line, at most {@linkcode MAX_TEXT} characters. */
  readonly text: string;
  readonly data: Record<string, unknown>;
  /** Always true: every string in an event came from GitHub users. */
  readonly untrusted: true;
  /** A fork / pull_request_target subject: its names come as `{ untrusted: "…" }` in `data`. */
  readonly wrapped?: boolean;
  readonly payload_ref?: string;
  /** Attached only for `payload=full` (needs `read:payloads`). */
  readonly payload?: unknown;
}

/** An event before the log numbers it. */
export type NewEvent = Omit<HubEvent, "seq" | "id" | "untrusted" | "payload"> & {
  readonly id?: string;
};

/** Caps (Fleet's limits). */
export const MAX_TEXT = 300;
export const MAX_NAME = 120;

/** Control characters (newlines included) out, whitespace collapsed, capped. */
export function clean(v: unknown, max: number = MAX_NAME): string {
  if (typeof v !== "string") return "";
  // deno-lint-ignore no-control-regex
  const s = v.replace(/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A name for `data`: plain when trusted, `{ untrusted: "…" }` when the subject is wrapped. */
export function nameField(v: unknown, wrapped: boolean): string | { untrusted: string } | null {
  const s = clean(v);
  if (!s) return null;
  return wrapped ? { untrusted: s } : s;
}

const PROBLEM: ReadonlySet<Severity> = new Set(["warn", "bad"]);

/** Fleet's `isProblem`: warn / bad events. */
export function isProblem(e: Pick<HubEvent, "sev">): boolean {
  return PROBLEM.has(e.sev);
}

/** A subject's key for `subject=` filters: `issue:owner/repo#12`, else `run:123`. */
export function subjectKeys(e: Pick<HubEvent, "subject" | "repo">): string[] {
  const s = e.subject;
  if (!s) return [];
  const out = [`${s.type}:${s.id}`];
  if (s.number !== undefined && e.repo) out.push(`${s.type}:${e.repo}#${s.number}`);
  if (s.node_id) out.push(`${s.type}:${s.node_id}`);
  return out;
}

// ULIDs: 48-bit time + 80 random bits, Crockford base32. Monotonic within one millisecond.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = -1;
let lastRand: number[] = [];

/** A ULID for `now`. */
export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime) {
    rand = lastRand.slice();
    for (let i = rand.length - 1; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    rand = [...bytes].map((b) => b % 32);
  }
  lastTime = now;
  lastRand = rand;
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = B32[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + rand.map((r) => B32[r]).join("");
}
