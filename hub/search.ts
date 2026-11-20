// Full-text search over cached subjects (titles, bodies, comments). Phase 4 fills the index from
// issue / PR / discussion state; phase 1 lands the store and its fallback, because whether FTS5 is
// there decides the shape (design §4's phase-1 risk).
//
// - fts5: `search` (external-content FTS5 over `search_docs`, kept in step by triggers), ranked by
//   bm25;
// - like: a case-insensitive LIKE per term over `search_docs` (all terms must match), newest first.
//   Slower, fine for tens of thousands of items.

import type { DatabaseSync } from "node:sqlite";
import type { SearchMode } from "./db.ts";

export interface SearchDoc {
  readonly subject: string;
  readonly kind: string;
  readonly repo?: string;
  readonly title: string;
  readonly body: string;
  readonly updated_at: number;
}

export interface SearchHit {
  readonly subject: string;
  readonly kind: string;
  readonly repo: string | null;
  readonly title: string;
  readonly updated_at: number;
}

const MAX_BODY = 64 * 1024;

export class SearchIndex {
  constructor(readonly db: DatabaseSync, readonly mode: SearchMode) {}

  upsert(d: SearchDoc): void {
    this.db.prepare(
      `INSERT INTO search_docs (subject, kind, repo, title, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject) DO UPDATE SET kind = excluded.kind, repo = excluded.repo,
         title = excluded.title, body = excluded.body, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= search_docs.updated_at`,
    ).run(d.subject, d.kind, d.repo ?? null, d.title, d.body.slice(0, MAX_BODY), d.updated_at);
  }

  remove(subject: string): void {
    this.db.prepare("DELETE FROM search_docs WHERE subject = ?").run(subject);
  }

  /** Terms: words of the query (letters, digits, `_-#`), at most 8. */
  static terms(q: string): string[] {
    return (q.match(/[\p{L}\p{N}_#-]+/gu) ?? []).slice(0, 8);
  }

  search(q: string, opts: { kinds?: readonly string[]; limit?: number } = {}): SearchHit[] {
    const terms = SearchIndex.terms(q);
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const kinds = opts.kinds?.length ? opts.kinds : null;
    const kindSql = kinds ? ` AND d.kind IN (${kinds.map(() => "?").join(",")})` : "";
    if (this.mode === "fts5") {
      // Each term quoted (no FTS operators from user text), prefix-matched.
      const match = terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
      return this.db.prepare(
        `SELECT d.subject, d.kind, d.repo, d.title, d.updated_at FROM search s
         JOIN search_docs d ON d.rowid = s.rowid
         WHERE search MATCH ?${kindSql} ORDER BY bm25(search) LIMIT ?`,
      ).all(match, ...(kinds ?? []), limit) as unknown as SearchHit[];
    }
    const esc = (t: string) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const termSql = terms.map(() => "(d.title LIKE ? ESCAPE '\\' OR d.body LIKE ? ESCAPE '\\')")
      .join(" AND ");
    return this.db.prepare(
      `SELECT d.subject, d.kind, d.repo, d.title, d.updated_at FROM search_docs d
       WHERE ${termSql}${kindSql} ORDER BY d.updated_at DESC LIMIT ?`,
    ).all(
      ...terms.flatMap((t) => [esc(t), esc(t)]),
      ...(kinds ?? []),
      limit,
    ) as unknown as SearchHit[];
  }
}
