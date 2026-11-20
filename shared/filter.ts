// The subscription filter grammar (design §3): fields are ANDed, values within a field ORed. A
// field may repeat in the query (`kind=a&kind=b`) or list values with commas (`kind=a,b`). Pure.
//
// `kind` globs: `*` matches within one dotted segment (`actions.*.completed`), and a trailing `.*`
// matches any rest (`actions.*` is every Actions event, `actions.job.*` every job event).

import { type HubEvent, isProblem, subjectKeys } from "./events.ts";

export interface EventFilter {
  readonly owner?: readonly string[];
  readonly repo?: readonly string[];
  readonly kind?: readonly string[];
  readonly gh_event?: readonly string[];
  readonly action?: readonly string[];
  readonly derived?: readonly string[];
  readonly branch?: readonly string[];
  readonly pool?: readonly string[];
  readonly subject?: readonly string[];
}

/** Replay start: a seq, `now`, or an age (`-1h`, `-30m`, `-2d`). */
export type Since = { readonly seq: number } | { readonly now: true } | { readonly ageMs: number };

export type PayloadLevel = "none" | "summary" | "full";

export interface Subscription {
  readonly filter: EventFilter;
  readonly since: Since;
  readonly payload: PayloadLevel;
  readonly format: "json" | "line";
}

export const FILTER_FIELDS = [
  "owner",
  "repo",
  "kind",
  "gh_event",
  "action",
  "derived",
  "branch",
  "pool",
  "subject",
] as const;

/** Derived streams the hub knows. `ci`, `inbox` and `board:*` fill in later phases. */
export const DERIVED = ["problems", "health", "agent", "ci", "inbox"] as const;

const MAX_VALUES = 50;
const MAX_VALUE_LEN = 200;

function values(q: URLSearchParams, k: string): string[] | string | undefined {
  const raw = q.getAll(k);
  if (raw.length === 0) return undefined;
  const out = raw.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  if (out.length > MAX_VALUES) return `${k}: at most ${MAX_VALUES} values`;
  if (out.some((v) => v.length > MAX_VALUE_LEN)) return `${k}: a value is too long`;
  return out.length ? out : undefined;
}

/** `1200`, `now`, `-1h` → a Since; else an error string. */
export function parseSince(v: string | null | undefined): Since | string {
  if (v === null || v === undefined || v === "" || v === "now") return { now: true };
  if (/^\d{1,15}$/.test(v)) return { seq: Number(v) };
  const m = /^-(\d{1,6})([smhd])$/.exec(v);
  if (m) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
    return { ageMs: Number(m[1]) * unit };
  }
  return "since must be a seq, now, or an age like -1h";
}

/** A query (and SSE's Last-Event-ID, which wins over `since`) → a subscription, or the error. */
export function parseSubscription(
  q: URLSearchParams,
  lastEventId: string | null = null,
): Subscription | string {
  const filter: Record<string, string[]> = {};
  for (const k of FILTER_FIELDS) {
    const v = values(q, k);
    if (typeof v === "string") return v;
    if (v) filter[k] = v;
  }
  for (const d of filter.derived ?? []) {
    if (!(DERIVED as readonly string[]).includes(d) && !/^board:[\w.-]+\/\d+$/.test(d)) {
      return `unknown derived stream ${JSON.stringify(d.slice(0, 40))}`;
    }
  }
  const since = parseSince(lastEventId && /^\d+$/.test(lastEventId) ? lastEventId : q.get("since"));
  if (typeof since === "string") return since;
  const payload = q.get("payload") ?? "summary";
  if (payload !== "none" && payload !== "summary" && payload !== "full") {
    return "payload must be none, summary or full";
  }
  const format = q.get("format") ?? "json";
  if (format !== "json" && format !== "line") return "format must be json or line";
  return { filter, since, payload, format };
}

/** A filter back into query parameters (the client's side). */
export function filterQuery(f: EventFilter, q: URLSearchParams = new URLSearchParams()) {
  for (const k of FILTER_FIELDS) {
    const v = f[k];
    if (v && v.length) q.set(k, v.join(","));
  }
  return q;
}

const globCache = new Map<string, RegExp>();

/** Whether a kind matches a glob (see the header). */
export function kindMatches(glob: string, kind: string): boolean {
  if (!glob.includes("*")) return glob === kind;
  let re = globCache.get(glob);
  if (!re) {
    const tail = glob.endsWith(".*");
    const body = tail ? glob.slice(0, -2) : glob;
    const src = body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^.]*");
    re = new RegExp(`^${src}${tail ? "\\..+" : ""}$`);
    if (globCache.size > 500) globCache.clear();
    globCache.set(glob, re);
  }
  return re.test(kind);
}

/** `owner/name` or a bare `name`, case-insensitive. */
export function repoMatches(want: string, repo: string | undefined): boolean {
  if (!repo) return false;
  const w = want.toLowerCase();
  const r = repo.toLowerCase();
  return w.includes("/") ? r === w : r.slice(r.indexOf("/") + 1) === w;
}

function derivedMatches(name: string, e: HubEvent): boolean {
  switch (name) {
    case "problems":
      return isProblem(e);
    case "health":
      return e.kind.startsWith("hub.health.");
    case "agent":
      return e.agent !== undefined;
    default:
      return e.source === "derived" && e.data.stream === name;
  }
}

const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : null);

/** Whether an event passes a filter. */
export function matchEvent(f: EventFilter, e: HubEvent): boolean {
  if (f.owner && !f.owner.some((o) => o.toLowerCase() === e.owner.toLowerCase())) return false;
  if (f.repo && !f.repo.some((r) => repoMatches(r, e.repo))) return false;
  if (f.kind && !f.kind.some((k) => kindMatches(k, e.kind))) return false;
  if (f.gh_event && !f.gh_event.includes(e.gh_event ?? "")) return false;
  if (f.action && !f.action.includes(e.action ?? "")) return false;
  if (f.derived && !f.derived.some((d) => derivedMatches(d, e))) return false;
  if (f.branch && !f.branch.includes(String(e.data.branch ?? ""))) return false;
  if (f.pool && !f.pool.some((p) => p.toLowerCase() === lower(e.data.pool))) return false;
  if (f.subject) {
    const keys = subjectKeys(e).map((k) => k.toLowerCase());
    if (!f.subject.some((s) => keys.includes(s.toLowerCase()))) return false;
  }
  return true;
}
