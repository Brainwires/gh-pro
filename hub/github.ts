// The hub's GitHub REST client: the machine's only API caller (design §2, §6). Every call names its
// reason and priority class and passes the budget first; every GET is conditional (ETag /
// Last-Modified from `http_cache`, LRU 5,000 URLs), and an authenticated 304 is free.
//
// The token comes from `gh auth token`, run from fixed paths only (never a `gh` from PATH, Fleet's
// rule), held in memory, re-read once on a 401. It is never logged, written or returned.

import type { DatabaseSync } from "node:sqlite";
import { redactLine } from "../shared/redact.ts";
import type { Budget, Priority, ReadReason, Resource } from "./budget.ts";

export const API_BASE = "https://api.github.com";
export const HTTP_CACHE_MAX = 5000;

/** Where `gh` may be, by OS: absolute paths only. */
export const GH_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
  linux: ["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"],
  windows: ["C:\\Program Files\\GitHub CLI\\gh.exe"],
};

/** The first `gh` binary that exists on this OS, or null. */
export async function findGh(os: string = Deno.build.os): Promise<string | null> {
  for (const path of GH_PATHS[os] ?? []) {
    try {
      if ((await Deno.stat(path)).isFile) return path;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** `gh auth token`'s output (validated), or null. stderr is discarded; nothing is logged. */
export async function ghToken(os: string = Deno.build.os): Promise<string | null> {
  const gh = await findGh(os);
  if (!gh) return null;
  try {
    const out = await new Deno.Command(gh, {
      args: ["auth", "token", "--hostname", "github.com"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return null;
    const token = new TextDecoder().decode(out.stdout).trim();
    return /^[A-Za-z0-9_]{20,255}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

export interface TokenProvider {
  get(): Promise<string | null>;
  /** The last token was refused: the next get() re-reads it. */
  invalidate(): void;
}

export function ghTokenProvider(
  read: () => Promise<string | null> = () => ghToken(),
): TokenProvider {
  let cached: string | null = null;
  return {
    async get() {
      cached ??= await read();
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
}

export class GitHubError extends Error {
  constructor(readonly status: number, message: string, readonly until: number | null = null) {
    super(redactLine(message));
  }
}

export interface CallOptions {
  readonly priority: Priority;
  readonly reason: ReadReason;
  readonly body?: unknown;
  readonly resource?: Resource;
  /** Skip the conditional-request cache (a mutation-like GET, or a list that must be fresh). */
  readonly noCache?: boolean;
}

export interface ApiResponse<T> {
  readonly status: number;
  readonly data: T;
  readonly headers: Headers;
  /** Served from the ETag cache (a 304). */
  readonly cached: boolean;
}

export interface GitHubDeps {
  readonly token: TokenProvider;
  readonly budget: Budget;
  readonly db?: DatabaseSync;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly base?: string;
}

export class GitHub {
  readonly #d: GitHubDeps;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  /** The token's scopes from x-oauth-scopes (null until a response says). */
  scopes: string[] | null = null;
  #writesSinceTrim = 0;

  constructor(d: GitHubDeps) {
    this.#d = d;
    this.#fetch = d.fetch ?? fetch;
    this.#now = d.now ?? Date.now;
  }

  get budget(): Budget {
    return this.#d.budget;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    o: CallOptions,
  ): Promise<ApiResponse<T>> {
    const verdict = this.#d.budget.check(o.priority, o.resource ?? "core");
    if (!verdict.ok) throw new GitHubError(0, `budget: ${verdict.why}`, verdict.until);
    const url = path.startsWith("https://") ? path : `${this.#d.base ?? API_BASE}${path}`;
    if (!url.startsWith(this.#d.base ?? API_BASE)) {
      throw new GitHubError(0, "refusing a non-API URL");
    }
    const key = `${method} ${url}`;
    const cacheable = method === "GET" && !o.noCache && this.#d.db !== undefined;
    const hit = cacheable ? this.#cacheGet(key) : null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#d.token.get();
      if (!token) throw new GitHubError(401, "no GitHub token: run `gh auth login`");
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "gh-pro",
        authorization: `Bearer ${token}`,
      };
      if (hit?.etag) headers["if-none-match"] = hit.etag;
      else if (hit?.last_modified) headers["if-modified-since"] = hit.last_modified;
      if (o.body !== undefined) headers["content-type"] = "application/json";
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method,
          headers,
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
        });
      } catch (e) {
        throw new GitHubError(0, `network: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.#rateFrom(res.headers, o.resource);
      const scopes = res.headers.get("x-oauth-scopes");
      if (scopes !== null) this.scopes = scopes.split(",").map((s) => s.trim()).filter(Boolean);
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel();
        this.#d.token.invalidate();
        continue;
      }
      if (res.status === 304 && hit) {
        await res.body?.cancel();
        this.#d.budget.record(o.reason, o.priority, false);
        return { status: 200, data: JSON.parse(hit.body) as T, headers: res.headers, cached: true };
      }
      const text = await res.text();
      if (res.status === 403 || res.status === 429) {
        const limited = res.headers.get("x-ratelimit-remaining") === "0" ||
          res.headers.has("retry-after") || /rate limit/i.test(text);
        if (limited) {
          const ra = Number(res.headers.get("retry-after"));
          this.#d.budget.penalize(Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
          throw new GitHubError(res.status, "rate limited", this.#d.budget.backoffUntil());
        }
      }
      this.#d.budget.record(o.reason, o.priority, true);
      if (!res.ok) {
        let msg = text.slice(0, 300);
        try {
          msg = String((JSON.parse(text) as { message?: string }).message ?? msg);
        } catch {
          // Not JSON.
        }
        throw new GitHubError(res.status, `${method} ${path}: ${res.status} ${msg}`);
      }
      const data = (text ? JSON.parse(text) : null) as T;
      if (cacheable && (res.headers.get("etag") || res.headers.get("last-modified"))) {
        this.#cachePut(key, res.headers.get("etag"), res.headers.get("last-modified"), text);
      }
      return { status: res.status, data, headers: res.headers, cached: false };
    }
    throw new GitHubError(401, "GitHub refused the token: run `gh auth refresh`");
  }

  /** Every page of a list (Link: rel="next"), at most `maxPages`. `key` picks the array. */
  async paginate<T>(path: string, o: CallOptions, key?: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const r: ApiResponse<unknown> = await this.request(
        "GET",
        next,
        i === 0 ? o : { ...o, priority: Math.max(o.priority, 1) as Priority },
      );
      const list = key ? (r.data as Record<string, unknown>)[key] : r.data;
      if (Array.isArray(list)) out.push(...(list as T[]));
      next = nextLink(r.headers.get("link"));
    }
    return out;
  }

  #rateFrom(h: Headers, fallback?: Resource): void {
    const rem = Number(h.get("x-ratelimit-remaining"));
    const lim = Number(h.get("x-ratelimit-limit"));
    const reset = Number(h.get("x-ratelimit-reset"));
    if (!h.has("x-ratelimit-remaining") || !Number.isFinite(rem)) return;
    const res = (h.get("x-ratelimit-resource") ?? fallback ?? "core") as Resource;
    if (res !== "core" && res !== "graphql" && res !== "search") return;
    this.#d.budget.update(res, rem, Number.isFinite(lim) ? lim : 5000, reset * 1000);
  }

  #cacheGet(key: string) {
    return (this.#d.db!.prepare("SELECT etag, last_modified, body FROM http_cache WHERE key = ?")
      .get(key) as
        | { etag: string | null; last_modified: string | null; body: string }
        | undefined) ??
      null;
  }

  #cachePut(key: string, etag: string | null, lm: string | null, body: string) {
    const db = this.#d.db!;
    db.prepare(
      `INSERT INTO http_cache (key, etag, last_modified, body, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, last_modified = excluded.last_modified,
         body = excluded.body, fetched_at = excluded.fetched_at`,
    ).run(key, etag, lm, body, this.#now());
    if (++this.#writesSinceTrim >= 100) {
      this.#writesSinceTrim = 0;
      db.prepare(
        `DELETE FROM http_cache WHERE key IN (SELECT key FROM http_cache ORDER BY fetched_at DESC
         LIMIT -1 OFFSET ?)`,
      ).run(HTTP_CACHE_MAX);
    }
  }
}

/** The `rel="next"` URL of a Link header, or null. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/** The scopes the hub needs (design §2), and the `gh auth refresh` line for any missing. */
export const NEEDED_SCOPES = ["repo", "read:org", "project", "admin:org_hook"] as const;

export function missingScopes(have: readonly string[] | null): string[] {
  if (have === null) return [];
  // admin:org_hook implies the hook rights; `repo` implies admin:repo_hook for owned repos.
  return NEEDED_SCOPES.filter((s) =>
    !have.includes(s) && !(s === "read:org" && have.includes("admin:org"))
  );
}
