// The sync engine, Actions part (design §6 (a), (b)): the hub reads the GitHub API only to sync.
//
// - Backfill, when a target joins the synced scope: its repos, then each repo's active runs (queued,
//   in progress, waiting) and its 30 most recent, the jobs of active runs, and the owner's
//   self-hosted runners. The first page is P1 (the user just asked); the rest P3.
// - Targeted re-read after a gap that redelivery couldn't cover: runs created since the gap's start;
//   every difference against state becomes a `sync` event with `data.reconciled = true`
//   ("…, while the hub was offline"). Intermediate steps are lost, and the text says so.
// - Webhooks keep the same state current: workflow_run / workflow_job payloads are upserted here.
//
// State rows are upserted only when the incoming `updated_at` is newer (webhooks arrive out of
// order; a redelivery or a re-read may carry older data than a webhook already applied).

import type { DatabaseSync } from "node:sqlite";
import { clean, type NewEvent } from "../shared/events.ts";
import type { Priority } from "./budget.ts";
import type { GitHub } from "./github.ts";
import { GitHubError } from "./github.ts";
import { type HookStore, parseTarget } from "./hooks.ts";
import type { EventLog } from "./log.ts";
import { conclusionSev, isUntrustedRun } from "./normalize.ts";

type Obj = Record<string, unknown>;

export const RECENT_RUNS = 30;
export const ACTIVE_STATUSES = ["queued", "in_progress", "waiting"] as const;
/** Repos per backfill (an org with more is paged in the background up to this). */
export const MAX_REPOS = 500;

const ts = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};

export interface RunChange {
  readonly id: number;
  readonly repo: string;
  readonly before: { status: string | null; conclusion: string | null } | null;
  readonly after: { status: string | null; conclusion: string | null };
}

export class ScopeError extends Error {}

export class SyncEngine {
  constructor(
    readonly db: DatabaseSync,
    readonly gh: GitHub | null,
    readonly log: EventLog,
    readonly hooks: HookStore,
    readonly now: () => number = Date.now,
    readonly onLog: (line: string) => void = () => {},
  ) {}

  // ---- state ----

  /** Upsert a run; the change when it is new or its status / conclusion moved, else null. */
  upsertRun(repo: string, run: Obj): RunChange | null {
    const id = Number(run.id);
    if (!Number.isFinite(id)) return null;
    const updated = ts(run.updated_at) || ts(run.created_at);
    const prev = this.db.prepare(
      "SELECT updated_at, status, conclusion FROM state_runs WHERE id = ?",
    )
      .get(id) as
        | { updated_at: number; status: string | null; conclusion: string | null }
        | undefined;
    if (prev && Number(prev.updated_at) > updated) return null;
    const status = typeof run.status === "string" ? run.status : null;
    const conclusion = typeof run.conclusion === "string" ? run.conclusion : null;
    this.db.prepare(
      `INSERT INTO state_runs (id, repo, updated_at, status, conclusion, json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, updated_at = excluded.updated_at,
         status = excluded.status, conclusion = excluded.conclusion, json = excluded.json,
         fetched_at = excluded.fetched_at`,
    ).run(id, repo, updated, status, conclusion, JSON.stringify(slimRun(run, repo)), this.now());
    if (prev && prev.status === status && prev.conclusion === conclusion) return null;
    return {
      id,
      repo,
      before: prev ? { status: prev.status, conclusion: prev.conclusion } : null,
      after: { status, conclusion },
    };
  }

  upsertJob(repo: string, job: Obj): boolean {
    const id = Number(job.id);
    if (!Number.isFinite(id)) return false;
    const updated = ts(job.completed_at) || ts(job.started_at) || ts(job.created_at);
    const prev = this.db.prepare("SELECT updated_at, status FROM state_jobs WHERE id = ?").get(
      id,
    ) as
      | { updated_at: number; status: string }
      | undefined;
    // Jobs have no updated_at: a completed job never goes back to in_progress.
    if (
      prev &&
      (Number(prev.updated_at) > updated ||
        prev.status === "completed" && job.status !== "completed")
    ) {
      return false;
    }
    this.db.prepare(
      `INSERT INTO state_jobs (id, run_id, repo, updated_at, status, conclusion, json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status,
         conclusion = excluded.conclusion, json = excluded.json, fetched_at = excluded.fetched_at`,
    ).run(
      id,
      Number(job.run_id) || 0,
      repo,
      updated,
      typeof job.status === "string" ? job.status : null,
      typeof job.conclusion === "string" ? job.conclusion : null,
      JSON.stringify(slimJob(job)),
      this.now(),
    );
    return true;
  }

  /** A webhook payload into state (workflow_run / workflow_job only in phase 1). */
  applyWebhook(event: string, p: Obj): void {
    const repo = (p.repository as Obj | undefined)?.full_name;
    if (typeof repo !== "string") return;
    if (event === "workflow_run" && p.workflow_run) this.upsertRun(repo, p.workflow_run as Obj);
    if (event === "workflow_job" && p.workflow_job) this.upsertJob(repo, p.workflow_job as Obj);
  }

  /** Whether a known run is a fork's / pull_request_target's. */
  runUntrusted(runId: number): boolean {
    const r = this.db.prepare("SELECT json FROM state_runs WHERE id = ?").get(runId) as
      | { json: string }
      | undefined;
    return r ? JSON.parse(r.json).untrusted === true : false;
  }

  runs(o: { repo?: string; status?: string; branch?: string; limit?: number } = {}): Obj[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.repo) {
      where.push(o.repo.includes("/") ? "repo = ? COLLATE NOCASE" : "repo LIKE ? ESCAPE '\\'");
      args.push(o.repo.includes("/") ? o.repo : `%/${o.repo.replace(/[\\%_]/g, (c) => `\\${c}`)}`);
    }
    if (o.status === "active") {
      where.push(`status IN ('queued','in_progress','waiting','pending','requested')`);
    } else if (o.status) {
      where.push("(status = ? OR conclusion = ?)");
      args.push(o.status, o.status);
    }
    const limit = Math.max(1, Math.min(o.limit ?? 100, 1000));
    const rows = this.db.prepare(
      `SELECT json FROM state_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(...args, limit) as { json: string }[];
    const out = rows.map((r) => JSON.parse(r.json) as Obj);
    return o.branch ? out.filter((r) => r.branch === o.branch) : out;
  }

  jobs(o: { runId?: number; status?: string; limit?: number } = {}): Obj[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.runId !== undefined) {
      where.push("run_id = ?");
      args.push(o.runId);
    }
    if (o.status) {
      where.push("(status = ? OR conclusion = ?)");
      args.push(o.status, o.status);
    }
    const limit = Math.max(1, Math.min(o.limit ?? 200, 2000));
    return (this.db.prepare(
      `SELECT json FROM state_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(...args, limit) as { json: string }[]).map((r) => JSON.parse(r.json) as Obj);
  }

  runners(owner?: string): Obj[] {
    const rows = (owner
      ? this.db.prepare(
        "SELECT json, fetched_at FROM state_runners WHERE owner = ? COLLATE NOCASE",
      ).all(owner)
      : this.db.prepare("SELECT json, fetched_at FROM state_runners").all()) as {
        json: string;
        fetched_at: number;
      }[];
    return rows.map((r) => ({
      ...JSON.parse(r.json),
      as_of: new Date(Number(r.fetched_at)).toISOString(),
    }));
  }

  // ---- scope ----

  scopeList(): {
    target: string;
    kind: string;
    added_by: string;
    added_at: number;
    backfilled_at: number | null;
  }[] {
    return this.db.prepare("SELECT * FROM scope ORDER BY target").all() as never;
  }

  /**
   * Add a target to the synced scope. Refused without a webhook path covering it (webhooks are the
   * only live source). Projects (`owner/project-N`) are phase 4. Returns whether it was new.
   */
  addScope(target: string, addedBy: string): boolean {
    if (/\/project-\d+$/.test(target)) {
      throw new ScopeError("Projects scope arrives in phase 4 (issues, PRs and boards)");
    }
    const t = parseTarget(target);
    if (!t) throw new ScopeError(`not an owner or owner/repo: ${JSON.stringify(target)}`);
    if (!this.hooks.covering(target)) {
      throw new ScopeError(
        `no webhook path covers ${target}: run \`gh pro hub webhook setup ${
          t.repo ?? t.owner
        }\` first`,
      );
    }
    const r = this.db.prepare(
      "INSERT OR IGNORE INTO scope (target, kind, added_by, added_at) VALUES (?, ?, ?, ?)",
    ).run(target, t.kind === "org" ? "owner" : "repo", addedBy, this.now());
    return Number(r.changes) > 0;
  }

  removeScope(target: string): boolean {
    return Number(
      this.db.prepare("DELETE FROM scope WHERE target = ? COLLATE NOCASE").run(target).changes,
    ) > 0;
  }

  /** The repos a scope target means (an owner's: listed and stored; a repo: itself). */
  async reposOf(target: string, priority: Priority): Promise<string[]> {
    const t = parseTarget(target);
    if (!t) return [];
    if (t.repo) return [t.repo];
    if (!this.gh) return [];
    let list: Obj[];
    try {
      list = await this.gh.paginate<Obj>(
        `/orgs/${t.owner}/repos?per_page=100&type=all`,
        {
          priority,
          reason: "backfill",
        },
        undefined,
        MAX_REPOS / 100,
      );
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      list = await this.gh.paginate<Obj>(
        `/users/${t.owner}/repos?per_page=100&type=owner`,
        {
          priority,
          reason: "backfill",
        },
        undefined,
        MAX_REPOS / 100,
      );
    }
    const now = this.now();
    const ins = this.db.prepare(
      `INSERT INTO state_repos (full_name, owner, json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(full_name) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
    );
    const out: string[] = [];
    for (const r of list) {
      if (typeof r.full_name !== "string" || r.archived === true) continue;
      ins.run(
        r.full_name,
        t.owner,
        JSON.stringify({
          full_name: r.full_name,
          default_branch: r.default_branch ?? null,
          private: r.private === true,
        }),
        now,
      );
      out.push(r.full_name);
    }
    return out;
  }

  /** The full backfill of one scope target. */
  async backfill(target: string): Promise<{ repos: number; runs: number; jobs: number }> {
    if (!this.gh) throw new ScopeError("no GitHub client (not signed in to gh?)");
    const now = this.now();
    this.#event(target, "hub.sync.started", "info", `backfill of ${target} started`);
    const repos = await this.reposOf(target, 1);
    let runs = 0;
    let jobs = 0;
    for (const [i, repo] of repos.entries()) {
      const pr: Priority = i === 0 ? 1 : 3;
      try {
        const active: Obj[] = [];
        for (const s of ACTIVE_STATUSES) {
          const r = await this.gh.request<{ workflow_runs: Obj[] }>(
            "GET",
            `/repos/${repo}/actions/runs?status=${s}&per_page=100`,
            { priority: pr, reason: "backfill" },
          );
          active.push(...(r.data.workflow_runs ?? []));
        }
        const recent = await this.gh.request<{ workflow_runs: Obj[] }>(
          "GET",
          `/repos/${repo}/actions/runs?per_page=${RECENT_RUNS}`,
          { priority: pr, reason: "backfill" },
        );
        for (const run of [...recent.data.workflow_runs ?? [], ...active]) {
          this.upsertRun(repo, run);
          runs++;
        }
        for (const run of active) {
          const js = await this.gh.paginate<Obj>(
            `/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
            { priority: pr, reason: "backfill" },
            "jobs",
            3,
          );
          for (const j of js) if (this.upsertJob(repo, j)) jobs++;
        }
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) continue;
        throw e;
      }
    }
    await this.#runners(target).catch((e) => this.onLog(`runners ${target}: ${e}`));
    this.db.prepare("UPDATE scope SET backfilled_at = ? WHERE target = ?").run(this.now(), target);
    this.#event(
      target,
      "hub.sync.finished",
      "ok",
      `backfill of ${target}: ${repos.length} repos, ${runs} runs, ${jobs} jobs (${
        Math.round((this.now() - now) / 1000)
      } s)`,
    );
    return { repos: repos.length, runs, jobs };
  }

  async #runners(target: string): Promise<void> {
    const t = parseTarget(target);
    if (!t || !this.gh) return;
    const path = t.repo
      ? `/repos/${t.repo}/actions/runners?per_page=100`
      : `/orgs/${t.owner}/actions/runners?per_page=100`;
    let list: Obj[];
    try {
      list = await this.gh.paginate<Obj>(path, { priority: 3, reason: "backfill" }, "runners", 5);
    } catch (e) {
      // Runner lists need admin rights; without them pools show no online / offline (design §6).
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) return;
      throw e;
    }
    const now = this.now();
    const ins = this.db.prepare(
      `INSERT INTO state_runners (key, owner, json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`,
    );
    for (const r of list) {
      ins.run(
        `${target}:${r.id}`,
        t.owner,
        JSON.stringify({
          id: r.id,
          name: clean(r.name),
          status: r.status ?? null,
          busy: r.busy === true,
          labels: Array.isArray(r.labels)
            ? r.labels.map((l) => clean((l as Obj).name, 60)).filter(Boolean)
            : [],
        }),
        now,
      );
    }
  }

  /**
   * Gap step 2: re-read runs created since `since` in the target's synced repos; differences become
   * reconciled `sync` events. Returns them (already appended).
   */
  async rereadActions(target: string, since: number): Promise<NewEvent[]> {
    if (!this.gh) return [];
    const repos = await this.reposOf(target, 1);
    const iso = new Date(since).toISOString().replace(/\.\d+Z$/, "Z");
    const events: NewEvent[] = [];
    for (const repo of repos) {
      let list: Obj[];
      try {
        list = await this.gh.paginate<Obj>(
          `/repos/${repo}/actions/runs?created=${encodeURIComponent(`>=${iso}`)}&per_page=100`,
          { priority: 1, reason: "reconcile", noCache: true },
          "workflow_runs",
          5,
        );
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) continue;
        throw e;
      }
      for (const run of list) {
        const ch = this.upsertRun(repo, run);
        if (ch) events.push(reconciledRunEvent(repo, run, ch, this.now()));
      }
    }
    return this.log.append(events);
  }

  #event(target: string, kind: string, sev: "info" | "ok" | "warn", text: string) {
    const now = this.now();
    this.log.append([{
      at: now,
      received_at: now,
      source: "sync",
      kind,
      owner: parseTarget(target)?.owner ?? target,
      sev,
      text,
      data: { target },
    }]);
  }
}

/** A run's fields clients read (state JSON). */
export function slimRun(run: Obj, repo: string): Obj {
  const untrusted = isUntrustedRun(run, repo);
  return {
    id: run.id,
    repo,
    name: clean(run.name),
    title: untrusted ? { untrusted: clean(run.display_title) } : clean(run.display_title),
    run_number: run.run_number ?? null,
    run_attempt: run.run_attempt ?? null,
    event: run.event ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    branch: untrusted ? null : clean(run.head_branch) || null,
    head_sha: run.head_sha ?? null,
    created_at: run.created_at ?? null,
    updated_at: run.updated_at ?? null,
    url: run.html_url ?? null,
    untrusted,
  };
}

export function slimJob(job: Obj): Obj {
  const steps = Array.isArray(job.steps) ? job.steps as Obj[] : [];
  const failed = steps.find((s) => ["failure", "timed_out"].includes(String(s.conclusion)));
  return {
    id: job.id,
    run_id: job.run_id ?? null,
    name: clean(job.name),
    workflow: clean(job.workflow_name),
    status: job.status ?? null,
    conclusion: job.conclusion ?? null,
    labels: Array.isArray(job.labels) ? job.labels.map((l) => clean(l, 60)) : [],
    runner_name: clean(job.runner_name, 80) || null,
    created_at: job.created_at ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    failed_step: failed ? clean(failed.name) : null,
    url: job.html_url ?? null,
  };
}

function reconciledRunEvent(repo: string, run: Obj, ch: RunChange, now: number): NewEvent {
  const s = ch.after.conclusion ?? ch.after.status ?? "changed";
  const untrusted = isUntrustedRun(run, repo);
  const name = clean(run.name);
  const seen = ch.before ? `${ch.before.conclusion ?? ch.before.status} → ${s}` : s;
  return {
    at: ts(run.updated_at) || now,
    received_at: now,
    source: "sync",
    kind: `actions.run.${
      ch.after.status === "completed" ? "completed" : ch.before ? "updated" : "requested"
    }`,
    gh_event: "workflow_run",
    owner: repo.split("/")[0],
    repo,
    subject: {
      type: "run",
      id: String(run.id),
      url: typeof run.html_url === "string" ? run.html_url : undefined,
    },
    sev: ch.after.status === "completed" ? conclusionSev(ch.after.conclusion) : "info",
    text: `run "${name}" #${
      run.run_number ?? "?"
    } ${seen}, while the hub was offline (intermediate steps not recorded)`,
    wrapped: untrusted,
    data: {
      reconciled: true,
      run_id: run.id,
      status: ch.after.status,
      conclusion: ch.after.conclusion,
      branch: untrusted ? null : clean(run.head_branch) || null,
    },
  };
}
