// The rate budget (design §6). The hub is the only GitHub caller on the machine, so it sees the
// whole budget in GitHub's response headers, including what other tools on the same token spend.
// It reads only to sync, in priority classes, each allowed while the resource's remaining budget is
// at least its floor:
//
//   P0  writes; on-demand reads the user is waiting on            ≥ 300
//   P1  gap reconciliation; health pings; a backfill's first page ≥ 800
//   P2  Projects gap reads                                        ≥ 1,500
//   P3  the rest of a backfill                                    ≥ 2,500, paused while the user waits
//
// On top: the hub's own counted (non-304) sync requests an hour are capped (syncCapPerHour, Fleet's
// 1,200), P0 exempt; a 403 / 429 naming a rate limit backs everything off (Retry-After when given,
// else doubling from 1 min to 15 min, Fleet's), cleared by the next success. A figure whose reset
// time has passed is ignored. Ported from Fleet's lib/budget.ts thresholds, reshaped into classes.

export type Priority = 0 | 1 | 2 | 3;
export type Resource = "core" | "graphql" | "search";
export type ReadReason = "backfill" | "reconcile" | "projects" | "on-demand" | "health" | "write";

export const FLOORS: Readonly<Record<Priority, number>> = { 0: 300, 1: 800, 2: 1500, 3: 2500 };
export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
const HOUR = 3_600_000;

export interface RateFigure {
  readonly remaining: number;
  readonly limit: number;
  /** ms */
  readonly resetAt: number;
  readonly seenAt: number;
}

export type BudgetVerdict = { ok: true } | { ok: false; until: number | null; why: string };

export class Budget {
  readonly #rates = new Map<Resource, RateFigure>();
  readonly #spent: { at: number; reason: ReadReason; priority: Priority }[] = [];
  #backoffUntil = 0;
  #backoffMs = 0;
  #waiting = 0;

  constructor(readonly syncCapPerHour: number, readonly now: () => number = Date.now) {}

  /** From a response's x-ratelimit-* headers. */
  update(resource: Resource, remaining: number, limit: number, resetAt: number): void {
    this.#rates.set(resource, { remaining, limit, resetAt, seenAt: this.now() });
  }

  rate(resource: Resource): RateFigure | null {
    const r = this.#rates.get(resource);
    if (!r || r.resetAt <= this.now()) return null;
    return r;
  }

  /** The user is waiting on an on-demand read: P3 pauses until `done()`. */
  userWaiting(): () => void {
    this.#waiting++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.#waiting--;
      }
    };
  }

  #trim(): void {
    const from = this.now() - HOUR;
    while (this.#spent.length && this.#spent[0].at < from) this.#spent.shift();
  }

  /** Counted sync requests in the last hour (P0 excluded). */
  syncSpentLastHour(): number {
    this.#trim();
    return this.#spent.filter((s) => s.priority > 0).length;
  }

  /** Counted requests in the last hour by reason (`hub status`). */
  byReason(): Record<ReadReason, number> {
    this.#trim();
    const out = { backfill: 0, reconcile: 0, projects: 0, "on-demand": 0, health: 0, write: 0 };
    for (const s of this.#spent) out[s.reason]++;
    return out;
  }

  check(priority: Priority, resource: Resource = "core"): BudgetVerdict {
    const now = this.now();
    if (now < this.#backoffUntil) {
      return { ok: false, until: this.#backoffUntil, why: "secondary rate limit backoff" };
    }
    if (priority === 3 && this.#waiting > 0) {
      return { ok: false, until: null, why: "paused while the user waits" };
    }
    const r = this.rate(resource);
    if (r && r.remaining < FLOORS[priority]) {
      return { ok: false, until: r.resetAt, why: `${resource} budget below ${FLOORS[priority]}` };
    }
    if (priority > 0 && this.syncSpentLastHour() >= this.syncCapPerHour) {
      const oldest = this.#spent.find((s) => s.priority > 0);
      return {
        ok: false,
        until: oldest ? oldest.at + HOUR : now + 60_000,
        why: `sync cap of ${this.syncCapPerHour} an hour reached`,
      };
    }
    return { ok: true };
  }

  /** A request was answered. 304s don't count against GitHub's limit, so they don't here. */
  record(reason: ReadReason, priority: Priority, counted: boolean): void {
    if (counted) this.#spent.push({ at: this.now(), reason, priority });
    this.#backoffMs = 0;
  }

  /** A 403 / 429 naming a rate limit. */
  penalize(retryAfterMs: number | null): void {
    this.#backoffMs = retryAfterMs ??
      Math.min(BACKOFF_MAX_MS, this.#backoffMs ? this.#backoffMs * 2 : BACKOFF_MIN_MS);
    this.#backoffUntil = this.now() + this.#backoffMs;
  }

  backoffUntil(): number | null {
    return this.#backoffUntil > this.now() ? this.#backoffUntil : null;
  }

  snapshot() {
    const res = (k: Resource) => {
      const r = this.rate(k);
      return r
        ? { remaining: r.remaining, limit: r.limit, reset_at: new Date(r.resetAt).toISOString() }
        : null;
    };
    return {
      core: res("core"),
      graphql: res("graphql"),
      search: res("search"),
      sync_spent_last_hour: this.syncSpentLastHour(),
      sync_cap_per_hour: this.syncCapPerHour,
      by_reason: this.byReason(),
      backoff_until: this.backoffUntil() ? new Date(this.#backoffUntil).toISOString() : null,
    };
  }
}
