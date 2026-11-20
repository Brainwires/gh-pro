// Per-client bearer tokens (design §3 Auth). Each client's token is a file,
// `<state>/tokens/<client>.token` (0600 in a 0700 folder, 32 random bytes base64url); the database
// keeps only its SHA-256 with the client's name, scopes and agent flag. On the Unix socket the token
// is still required: the OS permissions are the first gate, the token names the client and its scopes.
//
// Token text never starts with a prefix secret scanners treat as a GitHub token: it is `ghpro.`
// + base64url, which none of them match.

import type { DatabaseSync } from "node:sqlite";
import { ensurePrivateDir, writePrivateFile } from "../shared/paths.ts";

export const SCOPES = [
  "read",
  "read:payloads",
  "write:actions",
  "write:issues",
  "write:projects",
  "write:discussions",
  "admin",
] as const;
export type Scope = (typeof SCOPES)[number];

export const TOKEN_PREFIX = "ghpro.";

export interface ClientRecord {
  readonly name: string;
  readonly scopes: readonly Scope[];
  readonly agent: boolean;
  readonly created_at: number;
  readonly last_used_at: number | null;
}

/** The known clients and their default scopes. */
export function defaultClients(mcpAgentWrites: boolean): {
  name: string;
  scopes: Scope[];
  agent: boolean;
}[] {
  return [
    { name: "cli", scopes: [...SCOPES], agent: false },
    {
      name: "mcp",
      scopes: mcpAgentWrites ? ["read", "write:projects", "write:issues"] : ["read"],
      agent: true,
    },
    { name: "fleet", scopes: ["read", "write:actions"], agent: false },
    {
      name: "board",
      scopes: ["read", "write:issues", "write:projects", "write:discussions"],
      agent: false,
    },
  ];
}

export function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name);
}

export function parseScopes(list: string): Scope[] | string {
  const out = new Set<Scope>();
  for (const s of list.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (!(SCOPES as readonly string[]).includes(s)) return `unknown scope ${JSON.stringify(s)}`;
    out.add(s as Scope);
  }
  if (out.size === 0) return "at least one scope";
  return [...out];
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newToken(): string {
  return TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

type Row = {
  name: string;
  scopes: string;
  agent: number;
  created_at: number;
  last_used_at: number | null;
};

const record = (r: Row): ClientRecord => ({
  name: r.name,
  scopes: r.scopes.split(",").filter(Boolean) as Scope[],
  agent: r.agent === 1,
  created_at: Number(r.created_at),
  last_used_at: r.last_used_at === null ? null : Number(r.last_used_at),
});

export class TokenStore {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #now: () => number;
  /** last_used_at is written at most once a minute per client. */
  readonly #touched = new Map<string, number>();

  constructor(db: DatabaseSync, dir: string, now: () => number = Date.now) {
    this.#db = db;
    this.#dir = dir;
    this.#now = now;
  }

  tokenPath(name: string): string {
    return `${this.#dir}/${name}.token`;
  }

  /** Create (or replace) a client's token; writes its file and returns the path. */
  async create(name: string, scopes: readonly Scope[], agent: boolean): Promise<string> {
    if (!validName(name)) throw new Error(`invalid client name ${JSON.stringify(name)}`);
    await ensurePrivateDir(this.#dir);
    const token = newToken();
    const hash = await sha256(token);
    this.#db.prepare(
      `INSERT INTO clients (name, token_hash, scopes, agent, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET token_hash = excluded.token_hash, scopes = excluded.scopes,
         agent = excluded.agent, created_at = excluded.created_at, last_used_at = NULL`,
    ).run(name, hash, scopes.join(","), agent ? 1 : 0, this.#now());
    const path = this.tokenPath(name);
    await writePrivateFile(path, token + "\n");
    return path;
  }

  /** A new token for an existing client, same scopes. */
  async rotate(name: string): Promise<string> {
    const c = this.get(name);
    if (!c) throw new Error(`no client ${JSON.stringify(name)}`);
    return await this.create(name, c.scopes, c.agent);
  }

  /** Remove a client and its file; false when there was none. */
  async revoke(name: string): Promise<boolean> {
    const r = this.#db.prepare("DELETE FROM clients WHERE name = ?").run(name);
    try {
      await Deno.remove(this.tokenPath(name));
    } catch {
      // Already gone.
    }
    return Number(r.changes) > 0;
  }

  get(name: string): ClientRecord | null {
    const r = this.#db.prepare("SELECT * FROM clients WHERE name = ?").get(name) as Row | undefined;
    return r ? record(r) : null;
  }

  list(): ClientRecord[] {
    return (this.#db.prepare("SELECT * FROM clients ORDER BY name").all() as Row[]).map(record);
  }

  /** The client a presented token belongs to, or null. */
  async verify(token: string | null): Promise<ClientRecord | null> {
    if (!token || token.length > 200 || !token.startsWith(TOKEN_PREFIX)) return null;
    const hash = await sha256(token);
    const r = this.#db.prepare("SELECT * FROM clients WHERE token_hash = ?").get(hash) as
      | Row
      | undefined;
    if (!r) return null;
    const now = this.#now();
    if ((this.#touched.get(r.name) ?? 0) < now - 60_000) {
      this.#touched.set(r.name, now);
      this.#db.prepare("UPDATE clients SET last_used_at = ? WHERE name = ?").run(now, r.name);
    }
    return record(r);
  }

  /**
   * The known clients' tokens, created when missing (a client whose file was deleted gets a new
   * token, since the hub can't recover the old one from its hash). Returns the names created.
   */
  async ensureDefaults(mcpAgentWrites: boolean): Promise<string[]> {
    const made: string[] = [];
    for (const c of defaultClients(mcpAgentWrites)) {
      let hasFile = true;
      try {
        await Deno.stat(this.tokenPath(c.name));
      } catch {
        hasFile = false;
      }
      const row = this.get(c.name);
      if (row && hasFile) continue;
      await this.create(c.name, row?.scopes ?? c.scopes, row?.agent ?? c.agent);
      made.push(c.name);
    }
    return made;
  }
}

/** Whether a client has a scope (`admin` does not imply the others: `cli` simply has them all). */
export function hasScope(c: ClientRecord, s: Scope): boolean {
  return c.scopes.includes(s);
}
