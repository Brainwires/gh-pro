// Gaps (design §5): spans in which a webhook path may have missed deliveries — the hub was down,
// a ping didn't arrive, deliveries failed, a forwarder restarted. At most one open gap per target;
// a new reason widens it back to the earliest start. Reconciliation closes it as `reconciled` or
// `unrecoverable`.

import type { DatabaseSync } from "node:sqlite";

export type GapState = "open" | "reconciled" | "unrecoverable";

export interface Gap {
  readonly id: number;
  readonly target: string;
  readonly fromAt: number;
  readonly toAt: number | null;
  readonly reason: string;
  readonly state: GapState;
  readonly detail: string | null;
  readonly openedAt: number;
  readonly closedAt: number | null;
}

type Row = {
  id: number;
  target: string;
  from_at: number;
  to_at: number | null;
  reason: string;
  state: GapState;
  detail: string | null;
  opened_at: number;
  closed_at: number | null;
};

const fromRow = (r: Row): Gap => ({
  id: Number(r.id),
  target: r.target,
  fromAt: Number(r.from_at),
  toAt: r.to_at === null ? null : Number(r.to_at),
  reason: r.reason,
  state: r.state,
  detail: r.detail,
  openedAt: Number(r.opened_at),
  closedAt: r.closed_at === null ? null : Number(r.closed_at),
});

export class GapStore {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}

  /** Open (or widen) the target's gap. */
  open(target: string, fromAt: number, reason: string): Gap {
    const had = this.openFor(target);
    if (had) {
      if (fromAt < had.fromAt) {
        this.db.prepare("UPDATE gaps SET from_at = ?, reason = ? WHERE id = ?").run(
          fromAt,
          `${had.reason}; ${reason}`.slice(0, 300),
          had.id,
        );
      }
      return this.get(had.id)!;
    }
    const r = this.db.prepare(
      "INSERT INTO gaps (target, from_at, reason, state, opened_at) VALUES (?, ?, ?, 'open', ?)",
    ).run(target, fromAt, reason.slice(0, 300), this.now());
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Gap | null {
    const r = this.db.prepare("SELECT * FROM gaps WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  openFor(target: string): Gap | null {
    const r = this.db.prepare("SELECT * FROM gaps WHERE target = ? AND state = 'open'").get(
      target,
    ) as
      | Row
      | undefined;
    return r ? fromRow(r) : null;
  }

  listOpen(): Gap[] {
    return (this.db.prepare("SELECT * FROM gaps WHERE state = 'open' ORDER BY from_at")
      .all() as Row[])
      .map(fromRow);
  }

  recent(limit = 20): Gap[] {
    return (this.db.prepare("SELECT * FROM gaps ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(
      fromRow,
    );
  }

  close(id: number, state: Exclude<GapState, "open">, detail: string): void {
    const now = this.now();
    this.db.prepare(
      "UPDATE gaps SET state = ?, detail = ?, to_at = COALESCE(to_at, ?), closed_at = ? WHERE id = ?",
    ).run(state, detail.slice(0, 1000), now, now, id);
  }
}
