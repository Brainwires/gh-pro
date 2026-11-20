// Reconciliation after a gap (design §5):
//
//   1. Redeliver. List the hook's deliveries back to the gap's start (GitHub keeps 3 days) and ask
//      GitHub to redeliver each one the hub never received (matched on the GUID = X-GitHub-Delivery).
//      They arrive through the ingress as source "redelivery", de-duplicated as usual.
//   2. When that can't cover the gap (older than 3 days, a hook the hub can't list, a forwarder whose
//      hook is gone): a targeted re-read of what changed since the gap's start (phase 1: Actions runs),
//      whose differences become reconciled `sync` events.
//
// Reconciliation is budget class P1. One reconciliation per target at a time.

import type { Gap, GapStore } from "./gaps.ts";
import { type GitHub, GitHubError } from "./github.ts";
import type { HealthMonitor, HookDeliveryRecord } from "./health.ts";
import { hooksApiPath, type HookStore } from "./hooks.ts";
import type { EventLog } from "./log.ts";
import type { SyncEngine } from "./sync.ts";

export const DELIVERY_WINDOW_MS = 3 * 86_400_000;
/** Redeliveries asked for in one reconciliation (more: the rest by re-read). */
export const MAX_REDELIVER = 500;
const EXPECT_TTL_MS = 30 * 60_000;

export interface ReconcileResult {
  readonly target: string;
  readonly redelivered: number;
  readonly reread: number;
  readonly state: "reconciled" | "unrecoverable";
  readonly detail: string;
}

/** GUIDs the hub asked to be redelivered, accepted by the ingress past its 10-minute window. */
export class ExpectedRedeliveries {
  readonly #m = new Map<string, number>();
  constructor(readonly now: () => number = Date.now) {}
  add(guid: string): void {
    this.#m.set(guid, this.now() + EXPECT_TTL_MS);
  }
  /** Consume: true once per expected GUID. */
  take(guid: string): boolean {
    const until = this.#m.get(guid);
    if (until === undefined) return false;
    this.#m.delete(guid);
    return until >= this.now();
  }
  get size(): number {
    return this.#m.size;
  }
}

export interface ReconcileDeps {
  readonly gh: GitHub | null;
  readonly hooks: HookStore;
  readonly gaps: GapStore;
  readonly log: EventLog;
  readonly sync: SyncEngine;
  readonly health: HealthMonitor;
  readonly expected: ExpectedRedeliveries;
  readonly now?: () => number;
  readonly onLog?: (line: string) => void;
}

export class Reconciler {
  readonly #d: ReconcileDeps;
  readonly #now: () => number;
  readonly #running = new Map<string, Promise<ReconcileResult | null>>();

  constructor(d: ReconcileDeps) {
    this.#d = d;
    this.#now = d.now ?? Date.now;
  }

  /** Reconcile the target's open gap, if any (a running one is joined). */
  reconcileTarget(target: string): Promise<ReconcileResult | null> {
    const running = this.#running.get(target);
    if (running) return running;
    const gap = this.#d.gaps.openFor(target);
    if (!gap) return Promise.resolve(null);
    const p = this.run(gap).finally(() => this.#running.delete(target));
    this.#running.set(target, p);
    return p;
  }

  /** `gh pro hub reconcile [--since]`: open a gap from `since` on every path, then reconcile each. */
  async reconcileAll(since: number): Promise<ReconcileResult[]> {
    const out: ReconcileResult[] = [];
    for (const p of this.#d.hooks.list()) {
      this.#d.gaps.open(p.target, since, "requested");
      const r = await this.reconcileTarget(p.target);
      if (r) out.push(r);
    }
    return out;
  }

  async run(gap: Gap): Promise<ReconcileResult> {
    const { hooks, health, gaps } = this.#d;
    health.reconciling(gap.target);
    let redelivered = 0;
    let covered = false;
    let why = "";
    const path = hooks.get(gap.target);
    try {
      if (!path) why = "no webhook path";
      else if (path.hookId === null) why = "hook id unknown";
      else if (this.#now() - gap.fromAt > DELIVERY_WINDOW_MS) why = "older than GitHub's 3 days";
      else {
        const r = await this.#redeliver(path.target, path.hookId, gap.fromAt);
        redelivered = r.count;
        covered = r.complete;
        if (!covered) why = r.why;
      }
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    let reread = 0;
    let state: ReconcileResult["state"] = "reconciled";
    if (!covered) {
      try {
        reread = (await this.#d.sync.rereadActions(gap.target, gap.fromAt)).length;
      } catch (e) {
        state = "unrecoverable";
        why += `; re-read failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    const detail = covered
      ? `redelivered ${redelivered} deliveries`
      : `re-read Actions since ${new Date(gap.fromAt).toISOString()} (${reread} changes; ${why})` +
        (redelivered ? `, redelivered ${redelivered}` : "") +
        "; issue / PR / board changes in the span are not recovered until phase 4";
    gaps.close(gap.id, state, detail);
    hooks.touch(gap.target, "last_reconciled_at", this.#now());
    health.reconciled(gap.target, state === "reconciled", detail);
    this.#d.onLog?.(`reconcile ${gap.target}: ${state}: ${detail}`);
    return { target: gap.target, redelivered, reread, state, detail };
  }

  async #redeliver(
    target: string,
    hookId: number,
    from: number,
  ): Promise<{ count: number; complete: boolean; why: string }> {
    const gh = this.#d.gh;
    if (!gh) return { count: 0, complete: false, why: "no GitHub client" };
    const base = `${hooksApiPath(target)}/${hookId}/deliveries`;
    const all: HookDeliveryRecord[] = [];
    let url: string | null = `${base}?per_page=100`;
    let reachedStart = false;
    try {
      for (let page = 0; url && page < 30; page++) {
        const r: { data: HookDeliveryRecord[]; headers: Headers } = await gh.request<
          HookDeliveryRecord[]
        >("GET", url, { priority: 1, reason: "reconcile", noCache: true });
        all.push(...r.data);
        if (r.data.some((d) => Date.parse(d.delivered_at) < from) || r.data.length === 0) {
          reachedStart = true;
          break;
        }
        const next = /<([^>]+)>\s*;\s*rel="next"/.exec(r.headers.get("link") ?? "");
        url = next ? next[1] : null;
        if (!url) reachedStart = true;
      }
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) {
        return { count: 0, complete: false, why: "the hook is gone (a stopped forwarder?)" };
      }
      throw e;
    }
    const seen = new Set<string>();
    const todo: HookDeliveryRecord[] = [];
    for (const d of all) {
      if (d.event === "ping" || Date.parse(d.delivered_at) < from || seen.has(d.guid)) continue;
      seen.add(d.guid);
      if (!this.#d.log.seenDelivery(d.guid)) todo.push(d);
    }
    let count = 0;
    for (const d of todo.slice(0, MAX_REDELIVER)) {
      this.#d.expected.add(d.guid);
      await gh.request("POST", `${base}/${d.id}/attempts`, { priority: 1, reason: "reconcile" });
      count++;
    }
    const complete = reachedStart && todo.length <= MAX_REDELIVER;
    return {
      count,
      complete,
      why: !reachedStart ? "delivery list didn't reach the gap's start" : "too many to redeliver",
    };
  }
}
