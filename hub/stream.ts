// Filtered event streams with replay (design §3), adapted from Fleet's lib/stream.ts: SSE
// (`GET /v1/events/stream`, `id: <seq>`, Last-Event-ID honoured) and WebSocket (`GET /v1/events/ws`,
// filters changeable with `{"op":"filter", …}`).
//
// A client gets `hello`, a `status`, then (with `since`) a `gap` when `since` is older than what is
// kept, the stored matching events after `since`, then live events, each seq once. Live events that
// arrive during the replay wait and are de-duplicated by seq. A client that doesn't keep up (256
// queued SSE messages, 1 MB unsent on a WebSocket) loses messages, never blocks the others, and is
// told the seq range to replay (`dropped`). Caps: 8 streams per client, 32 in all.

import type { HubEvent } from "../shared/events.ts";
import {
  type EventFilter,
  FILTER_FIELDS,
  matchEvent,
  type Subscription,
} from "../shared/filter.ts";
import {
  formatLine,
  type WireDropped,
  type WireMessage,
  type WireStatus,
} from "../shared/protocol.ts";
import type { EventLog } from "./log.ts";

export const SSE_MAX_QUEUE = 256;
export const WS_MAX_BUFFERED = 1024 * 1024;
export const MAX_REPLAY = 5000;
export const MAX_PER_CLIENT = 8;
export const MAX_STREAMS = 32;

export interface StreamSink {
  canSend(): boolean;
  write(frame: string): void;
  close(): void;
}

export interface StreamDeps {
  readonly log: EventLog;
  readonly version: string;
  readonly status: () => WireStatus;
  readonly heartbeatMs: number;
  /** Attach a raw payload (payload=full). */
  readonly payload?: (ref: string) => Promise<unknown>;
  readonly maxQueue?: number;
  readonly wsMaxBuffered?: number;
  readonly maxReplay?: number;
}

interface Client {
  readonly name: string;
  filter: EventFilter;
  readonly sub: Subscription;
  readonly sink: StreamSink;
  readonly sse: boolean;
  ready: boolean;
  pending: WireMessage[];
  sentSeq: number;
  dropped: { count: number; first: number | null; last: number | null } | null;
  /** Serializes payload=full lookups so order holds. */
  chain: Promise<void>;
}

/** One frame: an SSE record, or a WebSocket message's text. */
export function frame(m: WireMessage, format: "json" | "line", sse: boolean): string {
  const payload = format === "line" ? formatLine(m) : JSON.stringify(m);
  if (!sse) return payload;
  const id = m.type === "event" ? `id: ${m.seq}\n` : "";
  return `${id}event: ${m.type}\ndata: ${payload}\n\n`;
}

/** An event shaped by the subscription's payload level. */
function shape(e: HubEvent, level: Subscription["payload"]): HubEvent {
  if (level === "none") {
    const { data: _d, payload_ref: _p, ...rest } = e;
    return { ...rest, data: {} } as HubEvent;
  }
  return e;
}

export class StreamHub {
  readonly #d: StreamDeps;
  readonly #clients = new Set<Client>();
  #beat: ReturnType<typeof setInterval> | null = null;
  #stopped = false;
  readonly #enc = new TextEncoder();

  constructor(d: StreamDeps) {
    this.#d = d;
  }

  get size(): number {
    return this.#clients.size;
  }

  countFor(name: string): number {
    let n = 0;
    for (const c of this.#clients) if (c.name === name) n++;
    return n;
  }

  /** Room for a new stream for this client? (`null`: yes, else why not.) */
  refusal(name: string): string | null {
    if (this.#stopped) return "hub stopping";
    if (this.#clients.size >= MAX_STREAMS) return "too many streams";
    if (this.countFor(name) >= MAX_PER_CLIENT) {
      return `at most ${MAX_PER_CLIENT} streams per client`;
    }
    return null;
  }

  #write(c: Client, m: WireMessage) {
    try {
      c.sink.write(frame(m, c.sub.format, c.sse));
    } catch {
      this.#remove(c);
    }
  }

  #drop(c: Client, m: WireMessage) {
    const d = c.dropped ?? { count: 0, first: null, last: null };
    d.count++;
    if (m.type === "event") {
      d.first ??= m.seq;
      d.last = m.seq;
    }
    c.dropped = d;
  }

  #push(c: Client, m: WireMessage) {
    if (m.type === "event" && m.seq <= c.sentSeq) return;
    if (!c.sink.canSend()) return this.#drop(c, m);
    if (c.dropped) {
      const d: WireDropped = {
        type: "dropped",
        count: c.dropped.count,
        first_seq: c.dropped.first,
        last_seq: c.dropped.last,
      };
      c.dropped = null;
      this.#write(c, d);
    }
    this.#write(c, m);
    if (m.type === "event") c.sentSeq = m.seq;
  }

  #deliver(c: Client, m: WireMessage) {
    if (m.type === "event" && !matchEvent(c.filter, m)) return;
    if (!c.ready) {
      if (c.pending.length >= (this.#d.maxQueue ?? SSE_MAX_QUEUE)) return this.#drop(c, m);
      c.pending.push(m);
      return;
    }
    if (m.type === "event" && c.sub.payload === "full" && m.payload_ref && this.#d.payload) {
      const ref = m.payload_ref;
      c.chain = c.chain.then(async () => {
        const payload = await this.#d.payload!(ref).catch(() => null);
        this.#push(c, { ...m, payload });
      });
      return;
    }
    this.#push(c, m);
  }

  #remove(c: Client) {
    if (!this.#clients.delete(c)) return;
    try {
      c.sink.close();
    } catch {
      // Already closed.
    }
    if (this.#clients.size === 0 && this.#beat !== null) {
      clearInterval(this.#beat);
      this.#beat = null;
    }
  }

  #heartbeat = () => {
    if (this.#clients.size === 0) return;
    let m: WireStatus;
    try {
      m = this.#d.status();
    } catch {
      return;
    }
    for (const c of [...this.#clients]) this.#deliver(c, m);
  };

  /** Attach a client. Null when refused (caps, stopping). */
  connect(name: string, sink: StreamSink, sub: Subscription, sse: boolean): Client | null {
    if (this.refusal(name)) return null;
    const log = this.#d.log;
    const since = log.resolveSince(sub.since);
    const c: Client = {
      name,
      filter: sub.filter,
      sub,
      sink,
      sse,
      ready: false,
      pending: [],
      sentSeq: since,
      dropped: null,
      chain: Promise.resolve(),
    };
    this.#clients.add(c);
    if (this.#beat === null && !this.#stopped) {
      this.#beat = setInterval(this.#heartbeat, this.#d.heartbeatMs);
    }
    this.#write(c, {
      type: "hello",
      v: 1,
      version: this.#d.version,
      last_seq: log.lastSeq(),
      oldest_seq: log.oldestSeq(),
      heartbeat_s: Math.round(this.#d.heartbeatMs / 1000),
    });
    try {
      this.#write(c, this.#d.status());
    } catch {
      // The first heartbeat brings one.
    }
    void (async () => {
      const gap = log.gapFor(since);
      if (gap) this.#write(c, { type: "gap", ...gap });
      const max = this.#d.maxReplay ?? MAX_REPLAY;
      let cursor = since;
      let sent = 0;
      for (;;) {
        if (!this.#clients.has(c)) return;
        const page = log.page(c.filter, cursor, 1000);
        for (const e of page.events) {
          if (++sent > max) break;
          const ev = shape(e, sub.payload);
          const full = sub.payload === "full" && e.payload_ref && this.#d.payload
            ? { ...ev, payload: await this.#d.payload(e.payload_ref).catch(() => null) }
            : ev;
          this.#write(c, { type: "event", ...full });
          c.sentSeq = e.seq;
        }
        if (sent > max) {
          const last = log.lastSeq();
          this.#write(c, {
            type: "dropped",
            count: Math.max(0, last - c.sentSeq),
            first_seq: c.sentSeq + 1,
            last_seq: last,
          });
          c.sentSeq = last;
          break;
        }
        cursor = page.next_seq;
        c.sentSeq = Math.max(c.sentSeq, cursor);
        if (!page.has_more) break;
      }
      c.ready = true;
      const held = c.pending;
      c.pending = [];
      for (const m of held) this.#deliver(c, m);
    })();
    return c;
  }

  /** New events from the log, in seq order. */
  publish(events: readonly HubEvent[]): void {
    for (const e of events) {
      for (const c of [...this.#clients]) {
        this.#deliver(c, { type: "event", ...shape(e, c.sub.payload) });
      }
    }
  }

  /** The hub is stopping: tell every client, then close. */
  restarting(): void {
    this.#stopped = true;
    for (const c of [...this.#clients]) {
      this.#write(c, { type: "hub-restarting", at: new Date().toISOString() });
      this.#remove(c);
    }
    if (this.#beat) clearInterval(this.#beat);
    this.#beat = null;
  }

  /** `GET /v1/events/stream`. */
  sse(req: Request, name: string, sub: Subscription): Response {
    let client: Client | null = null;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const max = this.#d.maxQueue ?? SSE_MAX_QUEUE;
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c;
      },
      cancel: () => {
        closed = true;
        if (client) this.#remove(client);
      },
    }, new CountQueuingStrategy({ highWaterMark: max }));
    const sink: StreamSink = {
      canSend: () => !closed && (ctrl.desiredSize ?? 0) > 0,
      write: (f) => {
        if (!closed) ctrl.enqueue(this.#enc.encode(f));
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          ctrl.close();
        } catch {
          // Errored or closed.
        }
      },
    };
    sink.write("retry: 3000\n\n");
    client = this.connect(name, sink, sub, true);
    if (!client) {
      return json(503, { error: this.refusal(name) ?? "refused" }, { "retry-after": "10" });
    }
    req.signal?.addEventListener("abort", () => client && this.#remove(client), { once: true });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  /** `GET /v1/events/ws`. */
  ws(req: Request, name: string, sub: Subscription): Response {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return json(426, { error: "upgrade required: websocket" }, { upgrade: "websocket" });
    }
    const why = this.refusal(name);
    if (why) return json(503, { error: why }, { "retry-after": "10" });
    const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 0 });
    const wsMax = this.#d.wsMaxBuffered ?? WS_MAX_BUFFERED;
    let client: Client | null = null;
    const sink: StreamSink = {
      canSend: () => socket.readyState === WebSocket.OPEN && socket.bufferedAmount < wsMax,
      write: (f) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(f);
      },
      close: () => {
        try {
          socket.close(1000, "bye");
        } catch {
          // Closing.
        }
      },
    };
    socket.onopen = () => {
      client = this.connect(name, sink, sub, false);
      if (!client) socket.close(1013, "too many streams");
    };
    const gone = () => client && this.#remove(client);
    socket.onclose = gone;
    socket.onerror = gone;
    socket.onmessage = (m) => {
      if (!client || typeof m.data !== "string" || m.data.length > 16_384) return;
      const f = parseFilterOp(m.data);
      if (f) client.filter = f;
    };
    return response;
  }
}

/** `{"op":"filter","kind":["actions.*"],…}` → a filter, or null. */
export function parseFilterOp(text: string): EventFilter | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || v.op !== "filter") return null;
  const out: Record<string, string[]> = {};
  for (const k of FILTER_FIELDS) {
    const x = v[k];
    if (x === undefined) continue;
    const list = Array.isArray(x) ? x : [x];
    if (list.length > 50 || !list.every((s) => typeof s === "string" && s.length <= 200)) {
      return null;
    }
    out[k] = list as string[];
  }
  return out;
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body) + "\n", {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
