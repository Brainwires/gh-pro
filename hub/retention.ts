// The hourly prune (design §4): small batches, each its own short transaction, so the writer lock
// is never held long; then `PRAGMA incremental_vacuum` gives the space back.
//
// - raw payloads: older than payloadDays, and then the oldest until the total is under payloadMaxMB;
// - events: older than eventDays, except problems (warn / bad) and agent events, kept problemDays;
// - delivery ids: older than deliveryDays; writes: older than writeDays;
// - closed gaps: kept as long as events.

import type { DatabaseSync } from "node:sqlite";
import type { RetentionSettings } from "./settings.ts";

export const PRUNE_BATCH = 500;
const DAY = 86_400_000;

export interface PruneResult {
  payloads: number;
  events: number;
  deliveries: number;
  writes: number;
  gaps: number;
}

/** Delete rows a `select` names, `PRUNE_BATCH` at a time. */
function batched(db: DatabaseSync, table: string, key: string, where: string, ...args: number[]) {
  const sel = db.prepare(`SELECT ${key} AS k FROM ${table} WHERE ${where} LIMIT ${PRUNE_BATCH}`);
  const del = db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`);
  let total = 0;
  for (;;) {
    const keys = (sel.all(...args) as { k: string | number }[]).map((r) => r.k);
    if (keys.length === 0) break;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const k of keys) del.run(k);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    total += keys.length;
    if (keys.length < PRUNE_BATCH) break;
  }
  return total;
}

export function prune(db: DatabaseSync, r: RetentionSettings, now: number): PruneResult {
  const out: PruneResult = { payloads: 0, events: 0, deliveries: 0, writes: 0, gaps: 0 };
  out.payloads = batched(db, "payloads", "ref", "received_at < ?", now - r.payloadDays * DAY);
  // Size cap: drop the oldest until under it.
  const cap = r.payloadMaxMB * 1024 * 1024;
  let total = Number(
    (db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM payloads").get() as { s: number }).s,
  );
  if (total > cap) {
    const oldest = db.prepare(
      `SELECT ref, size FROM payloads ORDER BY received_at LIMIT ${PRUNE_BATCH}`,
    );
    const del = db.prepare("DELETE FROM payloads WHERE ref = ?");
    while (total > cap) {
      const rows = oldest.all() as { ref: string; size: number }[];
      if (rows.length === 0) break;
      db.exec("BEGIN IMMEDIATE");
      for (const row of rows) {
        if (total <= cap) break;
        del.run(row.ref);
        total -= row.size;
        out.payloads++;
      }
      db.exec("COMMIT");
    }
  }
  out.events = batched(
    db,
    "events",
    "seq",
    "received_at < ? AND NOT (sev IN ('warn', 'bad') OR agent IS NOT NULL)",
    now - r.eventDays * DAY,
  ) + batched(db, "events", "seq", "received_at < ?", now - r.problemDays * DAY);
  out.deliveries = batched(
    db,
    "deliveries",
    "delivery_id",
    "received_at < ?",
    now - r.deliveryDays * DAY,
  );
  out.writes = batched(db, "writes", "id", "created_at < ?", now - r.writeDays * DAY);
  out.gaps = batched(
    db,
    "gaps",
    "id",
    "state != 'open' AND closed_at < ?",
    now - r.eventDays * DAY,
  );
  db.exec("PRAGMA incremental_vacuum(2000)");
  return out;
}

/** The database's size in bytes (pages × page size), for `hub status`. */
export function dbBytes(db: DatabaseSync): number {
  const pc = db.prepare("PRAGMA page_count").get() as { page_count: number };
  const ps = db.prepare("PRAGMA page_size").get() as { page_size: number };
  return Number(pc.page_count) * Number(ps.page_size);
}
