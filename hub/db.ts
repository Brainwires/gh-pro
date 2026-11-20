// The hub's one SQLite database (design §4) through Deno's built-in node:sqlite: WAL, one writer
// (the hub), incremental auto-vacuum so the hourly prune can give space back in small steps.
//
// FTS5: Deno's SQLite is built with it (verified on Deno 2.9.8 / SQLite 3.54.1, see
// docs/phase-1-checks.md). The hub still probes at open: without it, search falls back to LIKE over
// `search_docs` (hub/search.ts), so a runtime built without FTS5 keeps working.

import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

export type SearchMode = "fts5" | "like";

export interface HubDb {
  readonly db: DatabaseSync;
  readonly searchMode: SearchMode;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  gh_event TEXT,
  action TEXT,
  delivery_id TEXT,
  owner TEXT NOT NULL,
  repo TEXT,
  subject_type TEXT,
  subject_id TEXT,
  subject TEXT,
  actor TEXT,
  agent TEXT,
  sev TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT NOT NULL,
  wrapped INTEGER NOT NULL DEFAULT 0,
  payload_ref TEXT
);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, seq);
CREATE INDEX IF NOT EXISTS events_repo ON events (repo, seq);
CREATE INDEX IF NOT EXISTS events_subject ON events (subject_id, seq);
CREATE INDEX IF NOT EXISTS events_received ON events (received_at);

CREATE TABLE IF NOT EXISTS payloads (
  ref TEXT PRIMARY KEY,
  delivery_id TEXT UNIQUE,
  gh_event TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS payloads_received ON payloads (received_at);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  hook_id INTEGER,
  gh_event TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_received ON deliveries (received_at);

CREATE TABLE IF NOT EXISTS clients (
  name TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  agent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS scope (
  target TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  backfilled_at INTEGER
);

CREATE TABLE IF NOT EXISTS hooks (
  target TEXT PRIMARY KEY,
  hook_id INTEGER,
  mode TEXT NOT NULL,
  url TEXT,
  events TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_delivery_at INTEGER,
  last_ping_at INTEGER,
  last_reconciled_at INTEGER
);

CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  from_at INTEGER NOT NULL,
  to_at INTEGER,
  reason TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS state_repos (
  full_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state_runs (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT,
  conclusion TEXT,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS state_runs_repo ON state_runs (repo, updated_at);

CREATE TABLE IF NOT EXISTS state_jobs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT,
  conclusion TEXT,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS state_jobs_run ON state_jobs (run_id);

CREATE TABLE IF NOT EXISTS state_runners (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  etag TEXT,
  last_modified TEXT,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS writes (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL,
  agent INTEGER NOT NULL DEFAULT 0,
  op TEXT NOT NULL,
  target TEXT NOT NULL,
  args TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);

CREATE TABLE IF NOT EXISTS search_docs (
  rowid INTEGER PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  repo TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  title, body, content='search_docs', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS search_ai AFTER INSERT ON search_docs BEGIN
  INSERT INTO search(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS search_ad AFTER DELETE ON search_docs BEGIN
  INSERT INTO search(search, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS search_au AFTER UPDATE ON search_docs BEGIN
  INSERT INTO search(search, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO search(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
`;

/** Whether this SQLite has FTS5 (a throwaway in-memory probe). */
export function hasFts5(): boolean {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

/** Open (and create or migrate) the database. `fts: false` forces the LIKE fallback (tests). */
export function openHubDb(path: string, opts: { fts?: boolean } = {}): HubDb {
  const db = new DatabaseSync(path);
  // Must precede the first table: switches the file to incremental vacuum.
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  const searchMode: SearchMode = opts.fts === false ? "like" : hasFts5() ? "fts5" : "like";
  if (searchMode === "fts5") db.exec(FTS);
  const v = getMeta(db, "schema_version");
  if (v === null) setMeta(db, "schema_version", String(SCHEMA_VERSION));
  else if (Number(v) > SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `hub.db is schema ${v}, newer than this hub (${SCHEMA_VERSION}): upgrade gh-pro`,
    );
  }
  setMeta(db, "search_mode", searchMode);
  if (path !== ":memory:" && Deno.build.os !== "windows") {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) {
      try {
        Deno.chmodSync(f, 0o600);
      } catch {
        // Not created yet.
      }
    }
  }
  return { db, searchMode, close: () => db.close() };
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return r?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .run(key, value, value);
}

/** Run `fn` in one transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
