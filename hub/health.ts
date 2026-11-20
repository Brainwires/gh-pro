// Webhook health (design §5): quiet is a problem to surface, never a cue to poll. For every path
// whose hook id the hub knows, every `healthMinutes` (15) it asks GitHub to ping the hook and expects
// the `ping` within 60 s, and lists the hook's recent deliveries to catch failed ones. A forwarder's
// child exiting is `down` at once.
//
//   live      pings arrive, no failed deliveries
//   degraded  some deliveries failed / were missed and are being redelivered
//   down      the ping didn't arrive, or the forwarder died   → a `bad` health event (a problem)
//   gap       a reconciliation is running or couldn't recover everything
//
// Each change is a `hub.health.<state>` event in the log (so `--derived problems` and `health` see
// it); a `down` opens a gap from the last good moment, and the path coming back (a ping arrives, the
// forwarder restarts) hands the gap to reconciliation.

import type { HealthState, WireHookHealth } from "../shared/protocol.ts";
import type { Severity } from "../shared/events.ts";
import type { GapStore } from "./gaps.ts";
import { type GitHub, GitHubError } from "./github.ts";
import { type HookPath, hooksApiPath, type HookStore, parseTarget } from "./hooks.ts";
import type { EventLog } from "./log.ts";

export const PING_TIMEOUT_MS = 60_000;

export interface PathHealth {
  state: HealthState;
  since: number | null;
  reason: string | null;
  pingSentAt: number | null;
  pingDeadline: number | null;
  nextCheckAt: number;
  failed: number;
  /** Last moment the path was known good (last delivery or ping). */
  goodAt: number | null;
}

/** A delivery as GitHub's deliveries list returns it. */
export interface HookDeliveryRecord {
  readonly id: number;
  readonly guid: string;
  readonly delivered_at: string;
  readonly redelivery: boolean;
  readonly status: string;
  readonly status_code: number;
  readonly event: string;
  readonly action?: string | null;
}

export interface HealthDeps {
  readonly hooks: HookStore;
  readonly gh: GitHub | null;
  readonly log: EventLog;
  readonly gaps: GapStore;
  readonly intervalMs: number;
  readonly now?: () => number;
  /** A gap is ready to reconcile (the path is back, or deliveries are missing). */
  readonly onReconcile?: (target: string) => void;
  readonly onLog?: (line: string) => void;
}

const SEV: Record<HealthState, Severity> = {
  live: "ok",
  degraded: "warn",
  down: "bad",
  gap: "warn",
  unknown: "info",
};

export class HealthMonitor {
  readonly #d: HealthDeps;
  readonly #now: () => number;
  readonly #paths = new Map<string, PathHealth>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(d: HealthDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
  }

  #get(target: string): PathHealth {
    let h = this.#paths.get(target);
    if (!h) {
      const p = this.#d.hooks.get(target);
      h = {
        state: "unknown",
        since: null,
        reason: null,
        pingSentAt: null,
        pingDeadline: null,
        nextCheckAt: this.#now(),
        failed: 0,
        goodAt: p?.lastDeliveryAt ?? p?.lastPingAt ?? null,
      };
      this.#paths.set(target, h);
    }
    return h;
  }

  /** Move a path to a state; an actual change is logged as a health event. */
  set(target: string, state: HealthState, reason: string): void {
    const h = this.#get(target);
    if (h.state === state && h.reason === reason) return;
    const prev = h.state;
    h.state = state;
    h.reason = reason;
    h.since = this.#now();
    if (prev === state) return;
    const owner = parseTarget(target)?.owner ?? target;
    const now = this.#now();
    this.#d.log.append([{
      at: now,
      received_at: now,
      source: "derived",
      kind: `hub.health.${state}`,
      owner,
      repo: target.includes("/") ? target : undefined,
      subject: { type: "hook", id: target },
      sev: SEV[state],
      text: `webhooks for ${target} ${state}: ${reason}`,
      data: { stream: "health", target, state, previous: prev, reason },
    }]);
    this.#d.onLog?.(`health ${target}: ${prev} → ${state} (${reason})`);
  }

  /** Every verified delivery (ping included), with its hook's target when known. */
  onVerified(target: string | null, event: string, at: number): void {
    if (!target) return;
    const h = this.#get(target);
    h.goodAt = at;
    this.#d.hooks.touch(target, event === "ping" ? "last_ping_at" : "last_delivery_at", at);
    if (event === "ping") {
      h.pingSentAt = null;
      h.pingDeadline = null;
    }
    if (h.state === "down" || h.state === "unknown") {
      const wasDown = h.state === "down";
      this.set(target, "live", event === "ping" ? "ping arrived" : "deliveries arriving");
      if (wasDown && this.#d.gaps.openFor(target)) this.#d.onReconcile?.(target);
    }
  }

  /** A forwarder child died: the path is down from its last good moment. */
  forwarderExited(target: string, reason: string): void {
    const h = this.#get(target);
    this.#d.gaps.open(target, h.goodAt ?? this.#now(), `forwarder stopped: ${reason}`);
    this.set(target, "down", `forwarder stopped (${reason})`);
  }

  /** A forwarder child (re)started: a ping proves it end to end, and the gap gets reconciled. */
  forwarderStarted(target: string): void {
    const h = this.#get(target);
    h.nextCheckAt = this.#now();
    if (this.#d.gaps.openFor(target)) this.#d.onReconcile?.(target);
  }

  /** The hub was down from `since` (last alive) to now: every path gets a gap. */
  hubWasDown(since: number): void {
    for (const p of this.#d.hooks.list()) {
      this.#d.gaps.open(p.target, since, "hub was not running");
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), 10_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One pass: expired ping deadlines → down; due checks → ping + deliveries list. */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const p of this.#d.hooks.list()) {
      const h = this.#get(p.target);
      if (h.pingDeadline !== null && now > h.pingDeadline) {
        h.pingDeadline = null;
        this.#d.gaps.open(p.target, h.goodAt ?? h.pingSentAt ?? now, "ping did not arrive");
        this.set(p.target, "down", "the ping didn't arrive within 60 s");
      }
      if (now >= h.nextCheckAt) {
        h.nextCheckAt = now + this.#d.intervalMs;
        await this.check(p).catch((e) => this.#d.onLog?.(`health check ${p.target}: ${e}`));
      }
    }
  }

  /** Ping the hook and list its recent deliveries (two P1 calls). */
  async check(p: HookPath): Promise<void> {
    const gh = this.#d.gh;
    if (!gh || p.hookId === null) return;
    const base = `${hooksApiPath(p.target)}/${p.hookId}`;
    try {
      await gh.request("POST", `${base}/pings`, { priority: 1, reason: "health" });
      const h = this.#get(p.target);
      h.pingSentAt = this.#now();
      h.pingDeadline = h.pingSentAt + PING_TIMEOUT_MS;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        this.#d.gaps.open(p.target, this.#get(p.target).goodAt ?? this.#now(), "hook not found");
        this.set(p.target, "down", "GitHub no longer has this webhook");
        return;
      }
      throw e;
    }
    const r = await gh.request<HookDeliveryRecord[]>("GET", `${base}/deliveries?per_page=100`, {
      priority: 1,
      reason: "health",
      noCache: true,
    });
    // Deliveries from before the path was registered weren't expected; the last 30 s may still be in
    // flight through the ingress.
    const missed = missedDeliveries(
      r.data,
      (g) => this.#d.log.seenDelivery(g),
      p.createdAt,
      this.#now() - 30_000,
    );
    const h = this.#get(p.target);
    h.failed = missed.length;
    if (missed.length > 0) {
      const oldest = Math.min(...missed.map((d) => Date.parse(d.delivered_at)));
      this.#d.gaps.open(p.target, oldest, `${missed.length} failed or missed deliveries`);
      this.set(p.target, "degraded", `${missed.length} deliveries failed or missed`);
      this.#d.onReconcile?.(p.target);
    }
  }

  /** During reconciliation and after it. */
  reconciling(target: string): void {
    this.set(target, "gap", "reconciling");
  }

  reconciled(target: string, ok: boolean, detail: string): void {
    this.set(target, ok ? "live" : "gap", detail);
  }

  states(): WireHookHealth[] {
    return this.#d.hooks.list().map((p) => {
      const h = this.#get(p.target);
      return {
        target: p.target,
        mode: p.mode,
        state: h.state,
        since: h.since ? new Date(h.since).toISOString() : null,
      };
    });
  }

  detail(target: string): Readonly<PathHealth> {
    return { ...this.#get(target) };
  }
}

/**
 * Deliveries the hub should have but doesn't: not pings, not received (by GUID), each GUID once,
 * delivered between `after` and `before` when given. A GUID with any received attempt is fine.
 */
export function missedDeliveries(
  list: readonly HookDeliveryRecord[],
  received: (guid: string) => boolean,
  after: number | null = null,
  before: number | null = null,
): HookDeliveryRecord[] {
  const byGuid = new Map<string, HookDeliveryRecord>();
  for (const d of list) {
    if (d.event === "ping" || !d.guid) continue;
    const t = Date.parse(d.delivered_at);
    if (after !== null && t < after) continue;
    if (before !== null && t > before) continue;
    if (!byGuid.has(d.guid)) byGuid.set(d.guid, d);
  }
  return [...byGuid.values()].filter((d) => !received(d.guid));
}
