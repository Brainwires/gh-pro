// The hub's API client, used by every client (the CLI now; the MCP server, Fleet and Docket later).
// It reads `<state>/hub.json` first (the socket path may have moved to $TMPDIR), then talks HTTP over
// the Unix socket, or loopback TCP on Windows (Deno's fetch has no named-pipe transport). The token is
// the client's file `<state>/tokens/<client>.token`, or GH_PRO_TOKEN.

import { type HubPaths, hubPaths, parseRuntime, type RuntimeInfo } from "./paths.ts";
import { isWireMessage, type WireMessage } from "./protocol.ts";

/** The hub isn't running (or not answering). Read verbs exit 4 on it. */
export class HubDown extends Error {}
/** The hub refused the token. */
export class HubAuthError extends Error {}
export class HubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ClientOptions {
  readonly paths?: HubPaths;
  readonly client?: string;
  readonly token?: string;
  /** Force loopback TCP (the default on Windows). */
  readonly tcp?: boolean;
}

export async function readToken(paths: HubPaths, client: string): Promise<string | null> {
  const env = (() => {
    try {
      return Deno.env.get("GH_PRO_TOKEN");
    } catch {
      return undefined;
    }
  })();
  if (env) return env.trim();
  try {
    return (await Deno.readTextFile(`${paths.tokens}/${client}.token`)).trim() || null;
  } catch {
    return null;
  }
}

export async function readRuntime(paths: HubPaths): Promise<RuntimeInfo | null> {
  try {
    return parseRuntime(await Deno.readTextFile(paths.runtime));
  } catch {
    return null;
  }
}

export class HubClient {
  readonly runtime: RuntimeInfo;
  readonly #token: string;
  readonly #http: Deno.HttpClient | null;
  readonly #base: string;

  private constructor(runtime: RuntimeInfo, token: string, tcp: boolean) {
    this.runtime = runtime;
    this.#token = token;
    if (tcp || Deno.build.os === "windows") {
      this.#http = null;
      this.#base = `http://127.0.0.1:${runtime.port}`;
    } else {
      this.#http = Deno.createHttpClient({ proxy: { transport: "unix", path: runtime.socket } });
      this.#base = "http://localhost";
    }
  }

  /** Connect (no request yet). Throws HubDown without a runtime file, HubAuthError without a token. */
  static async open(o: ClientOptions = {}): Promise<HubClient> {
    const paths = o.paths ?? hubPaths();
    const rt = await readRuntime(paths);
    if (!rt) throw new HubDown("the hub isn't running (gh pro hub start)");
    const token = o.token ?? await readToken(paths, o.client ?? "cli");
    if (!token) {
      throw new HubAuthError(`no token for client "${o.client ?? "cli"}" in ${paths.tokens}`);
    }
    return new HubClient(rt, token, o.tcp ?? false);
  }

  close(): void {
    this.#http?.close();
  }

  async request<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        ...(this.#http ? { client: this.#http } : {}),
      } as RequestInit);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new HubDown(`the hub isn't answering (${e instanceof Error ? e.message : e})`);
    }
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text.slice(0, 300) };
    }
    if (res.status === 401) throw new HubAuthError("the hub refused this client's token");
    if (!res.ok) throw new HubError(res.status, String(data.error ?? `HTTP ${res.status}`));
    return data as T;
  }

  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  del<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /**
   * Read `GET /v1/events/stream?<query>` until it ends or `signal` aborts, calling `on` per message.
   * Resolves when the stream ends (the caller reconnects with `since`).
   */
  async stream(
    query: URLSearchParams,
    on: (m: WireMessage) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}/v1/events/stream?${query}`, {
        headers: { authorization: `Bearer ${this.#token}`, accept: "text/event-stream" },
        signal,
        ...(this.#http ? { client: this.#http } : {}),
      } as RequestInit);
    } catch (e) {
      if (signal?.aborted) return;
      throw new HubDown(`the hub isn't answering (${e instanceof Error ? e.message : e})`);
    }
    if (res.status === 401) throw new HubAuthError("the hub refused this client's token");
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      throw new HubError(res.status, t.slice(0, 300));
    }
    await readSse(res.body, on, signal);
  }
}

/** Parse an SSE body into wire messages. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  on: (m: WireMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  let buf = "";
  let data: string[] = [];
  try {
    for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
      if (signal?.aborted) break;
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") {
          if (data.length) {
            try {
              const v = JSON.parse(data.join("\n"));
              if (isWireMessage(v)) on(v);
            } catch {
              // A line-format stream or junk: ignored by this reader.
            }
          }
          data = [];
        } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (buf.length > 4 * 1024 * 1024) throw new Error("SSE line too long");
    }
  } catch (e) {
    if (!signal?.aborted) throw e;
  }
}
