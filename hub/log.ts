// The event log (design §3, §4): every event gets a `seq` from SQLite's AUTOINCREMENT, which is
// never reused, even after the prune deletes the newest rows. Raw payloads are stored deflated
// beside it and attached only for `payload=full`. Delivery ids are kept 14 days for de-duplication.

import type { DatabaseSync } from "node:sqlite";
import { clean, type HubEvent, MAX_TEXT, type NewEvent, ulid } from "../shared/events.ts";
import { type EventFilter, matchEvent, type Since } from "../shared/filter.ts";
import { tx } from "./db.ts";

/** A page of events and where to continue. */
export interface EventPage {
  readonly events: HubEvent[];
  readonly next_seq: number;
  readonly has_more: boolean;
  readonly gap?: { from: number; to: number; oldest_seq: number };
}

/** Rows looked at per page request before handing back a cursor. */
export const SCAN_CAP = 20_000;
export const MAX_PAGE = 1000;

type Row = Record<string, unknown>;

const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : undefined);

function rowEvent(r: Row): HubEvent {
  const e: Record<string, unknown> = {
    seq: Number(r.seq),
    id: r.id,
    at: Number(r.at),
    received_at: Number(r.received_at),
    source: r.source,
    kind: r.kind,
    owner: r.owner,
    sev: r.sev,
    text: r.text,
    data: parse(r.data) ?? {},
    untrusted: true,
  };
  if (r.gh_event) e.gh_event = r.gh_event;
  if (r.action) e.action = r.action;
  if (r.delivery_id) e.delivery_id = r.delivery_id;
  if (r.repo) e.repo = r.repo;
  if (r.subject) e.subject = parse(r.subject);
  if (r.actor) e.actor = parse(r.actor);
  if (r.agent) e.agent = parse(r.agent);
  if (r.wrapped) e.wrapped = true;
  if (r.payload_ref) e.payload_ref = r.payload_ref;
  return e as unknown as HubEvent;
}

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}
export const deflate = (b: Uint8Array) => pipe(b, new CompressionStream("deflate"));
export const inflate = (b: Uint8Array) => pipe(b, new DecompressionStream("deflate"));

export type AppendListener = (events: readonly HubEvent[]) => void;

export class EventLog {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #listeners = new Set<AppendListener>();

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /** Be told of every appended batch, in seq order. Returns the unsubscribe. */
  onAppend(fn: AppendListener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Number, store and fan out events. Text is sanitized and capped here, whoever made it. */
  append(events: readonly NewEvent[]): HubEvent[] {
    if (events.length === 0) return [];
    const ins = this.#db.prepare(
      `INSERT INTO events (id, at, received_at, source, kind, gh_event, action, delivery_id, owner,
        repo, subject_type, subject_id, subject, actor, agent, sev, text, data, wrapped, payload_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const out = tx(this.#db, () =>
      events.map((n) => {
        const id = n.id ?? ulid(n.received_at);
        const text = clean(n.text, MAX_TEXT);
        const r = ins.run(
          id,
          n.at,
          n.received_at,
          n.source,
          n.kind,
          n.gh_event ?? null,
          n.action ?? null,
          n.delivery_id ?? null,
          n.owner,
          n.repo ?? null,
          n.subject?.type ?? null,
          n.subject?.id ?? null,
          n.subject ? JSON.stringify(n.subject) : null,
          n.actor ? JSON.stringify(n.actor) : null,
          n.agent ? JSON.stringify(n.agent) : null,
          n.sev,
          text,
          JSON.stringify(n.data ?? {}),
          n.wrapped ? 1 : 0,
          n.payload_ref ?? null,
        );
        const { id: _id, ...rest } = n;
        return { ...rest, seq: Number(r.lastInsertRowid), id, text, untrusted: true } as HubEvent;
      }));
    for (const fn of [...this.#listeners]) {
      try {
        fn(out);
      } catch {
        // A listener's failure never stops the log.
      }
    }
    return out;
  }

  /** The newest seq ever handed out (0 when none). */
  lastSeq(): number {
    const r = this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
      | { seq: number }
      | undefined;
    return Number(r?.seq ?? 0);
  }

  /** The oldest retained seq; `lastSeq + 1` when nothing is retained. */
  oldestSeq(): number {
    const r = this.#db.prepare("SELECT MIN(seq) AS s FROM events").get() as { s: number | null };
    return r.s === null ? this.lastSeq() + 1 : Number(r.s);
  }

  /** The seq a `since` starts after. */
  resolveSince(s: Since): number {
    if ("seq" in s) return s.seq;
    if ("now" in s) return this.lastSeq();
    const from = this.#now() - s.ageMs;
    const r = this.#db.prepare("SELECT MIN(seq) AS s FROM events WHERE received_at >= ?").get(
      from,
    ) as { s: number | null };
    return r.s === null ? this.lastSeq() : Number(r.s) - 1;
  }

  /** `since` older than what is kept → the gap to report. */
  gapFor(since: number): EventPage["gap"] | undefined {
    const oldest = this.oldestSeq();
    if (since + 1 >= oldest || since >= this.lastSeq()) return undefined;
    return { from: since + 1, to: oldest - 1, oldest_seq: oldest };
  }

  /** Events after `since` that match, oldest first. */
  page(filter: EventFilter, since: number, limit = MAX_PAGE, scanCap = SCAN_CAP): EventPage {
    limit = Math.max(1, Math.min(limit, MAX_PAGE));
    const gap = this.gapFor(since);
    const exactKinds = filter.kind && filter.kind.every((k) => !k.includes("*"))
      ? filter.kind
      : null;
    const where = exactKinds ? ` AND kind IN (${exactKinds.map(() => "?").join(",")})` : "";
    const stmt = this.#db.prepare(
      `SELECT * FROM events WHERE seq > ?${where} ORDER BY seq LIMIT ?`,
    );
    const events: HubEvent[] = [];
    let cursor = since;
    let scanned = 0;
    let exhausted = false;
    const batch = 500;
    while (events.length < limit && scanned < scanCap) {
      const rows = stmt.all(cursor, ...(exactKinds ?? []), batch) as Row[];
      for (const r of rows) {
        scanned++;
        cursor = Number(r.seq);
        const e = rowEvent(r);
        if (matchEvent(filter, e)) {
          events.push(e);
          if (events.length >= limit) break;
        }
      }
      if (rows.length < batch) {
        exhausted = events.length < limit || rows.length === 0;
        break;
      }
    }
    if (!exhausted && events.length >= limit) {
      const more = stmt.get(cursor, ...(exactKinds ?? []), 1) as Row | undefined;
      exhausted = !more;
    }
    return { events, next_seq: cursor, has_more: !exhausted, ...(gap ? { gap } : {}) };
  }

  /** One event by seq. */
  get(seq: number): HubEvent | null {
    const r = this.#db.prepare("SELECT * FROM events WHERE seq = ?").get(seq) as Row | undefined;
    return r ? rowEvent(r) : null;
  }

  /** Events retained (status). */
  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
  }

  // ---- payloads ----

  /** Store a raw payload (deflated); returns its ref. A delivery stored before keeps its ref. */
  async storePayload(
    deliveryId: string | null,
    ghEvent: string,
    receivedAt: number,
    bytes: Uint8Array,
  ): Promise<string> {
    if (deliveryId) {
      const had = this.#db.prepare("SELECT ref FROM payloads WHERE delivery_id = ?").get(
        deliveryId,
      ) as { ref: string } | undefined;
      if (had) return had.ref;
    }
    const ref = ulid(receivedAt);
    const z = await deflate(bytes);
    this.#db.prepare(
      "INSERT INTO payloads (ref, delivery_id, gh_event, received_at, size, bytes) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ref, deliveryId, ghEvent, receivedAt, z.length, z);
    return ref;
  }

  /** A stored payload, parsed; `null` when pruned. */
  async payload(ref: string): Promise<unknown> {
    const r = this.#db.prepare("SELECT bytes FROM payloads WHERE ref = ?").get(ref) as
      | { bytes: Uint8Array }
      | undefined;
    if (!r) return null;
    return JSON.parse(new TextDecoder().decode(await inflate(r.bytes)));
  }

  // ---- delivery de-duplication ----

  seenDelivery(id: string): boolean {
    return this.#db.prepare("SELECT 1 FROM deliveries WHERE delivery_id = ?").get(id) !== undefined;
  }

  /** Remember a delivery id; false when it was already known (a duplicate). */
  rememberDelivery(id: string, at: number, hookId: number | null, ghEvent: string): boolean {
    const r = this.#db.prepare(
      "INSERT OR IGNORE INTO deliveries (delivery_id, received_at, hook_id, gh_event) VALUES (?, ?, ?, ?)",
    ).run(id, at, hookId, ghEvent);
    return Number(r.changes) > 0;
  }
}
