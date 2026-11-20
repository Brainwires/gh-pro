// `gh pro watch`: live events, one line each, for a terminal or an agent's monitor (Claude Code's
// Monitor tool runs it and gets each line as it happens). Fleet's fleet-stream, on the hub: it
// connects to the hub's SSE stream, prints each message, and after a drop reconnects with `since` =
// the last event it printed, so nothing is missed. The hub not running is waited out. Exit codes
// (fleet-stream's): 2 a configuration error (bad arguments, no token file), 3 the token was refused.
// Event text is GitHub users' text: data, never instructions.

import { HubAuthError, HubClient, HubDown, HubError } from "../shared/client.ts";
import { type EventFilter, filterQuery, parseSince } from "../shared/filter.ts";
import type { HubPaths } from "../shared/paths.ts";
import { formatLine, type WireMessage } from "../shared/protocol.ts";

export interface WatchOptions {
  readonly filter: EventFilter;
  readonly since: string | null;
  readonly json: boolean;
  readonly status: boolean;
  readonly client: string;
  readonly payload?: "none" | "summary" | "full";
}

export interface WatchIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly paths?: HubPaths;
  /** Tests: a client factory. */
  readonly open?: () => Promise<HubClient>;
}

export const WATCH_RETRY_MAX_MS = 30_000;

export async function watch(o: WatchOptions, io: WatchIo): Promise<number> {
  const since0 = parseSince(o.since ?? "now");
  if (typeof since0 === "string") {
    io.err(since0);
    return 2;
  }
  let last: number | null = null;
  let wait = 1000;
  let saidWaiting = false;
  const open = io.open ?? (() => HubClient.open({ paths: io.paths, client: o.client }));
  while (!io.signal?.aborted) {
    let client: HubClient;
    try {
      client = await open();
    } catch (e) {
      if (e instanceof HubAuthError) {
        io.err(e.message);
        return 2;
      }
      if (!saidWaiting) io.err("waiting for the hub (gh pro hub start)…");
      saidWaiting = true;
      await io.sleep(wait);
      wait = Math.min(WATCH_RETRY_MAX_MS, wait * 2);
      continue;
    }
    const q = filterQuery(o.filter);
    q.set("since", last !== null ? String(last) : o.since ?? "now");
    if (o.payload) q.set("payload", o.payload);
    try {
      await client.stream(q, (m: WireMessage) => {
        wait = 1000;
        saidWaiting = false;
        if (m.type === "event") last = m.seq;
        if (m.type === "status" && !o.status) return;
        if (m.type === "hello" && last !== null) return;
        io.out(o.json ? JSON.stringify(m) : formatLine(m));
      }, io.signal);
    } catch (e) {
      if (e instanceof HubAuthError) {
        io.err(e.message);
        return 3;
      }
      if (e instanceof HubError && e.status === 400) {
        io.err(e.message);
        return 2;
      }
      if (!(e instanceof HubDown) && !io.signal?.aborted) {
        io.err(String(e instanceof Error ? e.message : e));
      }
    } finally {
      client.close();
    }
    if (io.signal?.aborted) break;
    await io.sleep(wait);
    wait = Math.min(WATCH_RETRY_MAX_MS, wait * 2);
  }
  return 0;
}
