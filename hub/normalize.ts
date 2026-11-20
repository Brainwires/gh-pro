// A verified webhook delivery → one normalized event (design §3). Pure. Families:
//
//   workflow_run → actions.run.*      workflow_job → actions.job.*
//   check_suite → checks.suite.*      check_run → checks.run.*       status → checks.status.<state>
//   issues → issues.issue.*           issue_comment → issues.comment.*
//   pull_request → pulls.pr.*         pull_request_review → pulls.review.*
//   pull_request_review_comment → pulls.review_comment.*
//   pull_request_review_thread → pulls.review_thread.*
//   discussion → discussions.discussion.*      discussion_comment → discussions.comment.*
//   projects_v2_item → projects.item.*         projects_v2 → projects.project.*
//   projects_v2_status_update → projects.status_update.*
//   label → repo.label.*   milestone → repo.milestone.*   repository → repo.repository.*
//   anything else → github.<event>.<action>
//
// Actions events get Fleet's severities (a failed job is `bad`, so it is a problem) and, for a
// failed job, the failed step from the payload. A fork / pull_request_target subject is wrapped:
// its names go into `data` as `{ untrusted: "…" }` and the text leaves out its failed step and
// title (Fleet's rule). Phase 2's derivers add STALLED / QUEUED-LONG and pool health on top.

import { clean, nameField, type NewEvent, type Severity, type Subject } from "../shared/events.ts";

type Obj = Record<string, unknown>;

const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

const FAMILY: Record<string, string> = {
  workflow_run: "actions.run",
  workflow_job: "actions.job",
  check_suite: "checks.suite",
  check_run: "checks.run",
  status: "checks.status",
  issues: "issues.issue",
  issue_comment: "issues.comment",
  pull_request: "pulls.pr",
  pull_request_review: "pulls.review",
  pull_request_review_comment: "pulls.review_comment",
  pull_request_review_thread: "pulls.review_thread",
  discussion: "discussions.discussion",
  discussion_comment: "discussions.comment",
  projects_v2_item: "projects.item",
  projects_v2: "projects.project",
  projects_v2_status_update: "projects.status_update",
  label: "repo.label",
  milestone: "repo.milestone",
  repository: "repo.repository",
};

/** The events the hub asks a webhook for (design §5). */
export const HOOK_EVENTS: readonly string[] = [
  "workflow_job",
  "workflow_run",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "discussion",
  "discussion_comment",
  "projects_v2",
  "projects_v2_item",
  "projects_v2_status_update",
  "label",
  "check_suite",
  "status",
  "repository",
  "milestone",
];

/** Actions events: the ones Fleet's 1 MiB cap and replay window apply to. */
export const ACTIONS_EVENTS: ReadonlySet<string> = new Set(["workflow_job", "workflow_run"]);

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export function conclusionSev(c: string | null | undefined): Severity {
  if (c === "success") return "ok";
  if (c && FAILED.has(c)) return "bad";
  if (c === "action_required") return "warn";
  return "muted";
}

function time(...vals: unknown[]): number | undefined {
  let best: number | undefined;
  for (const v of vals) {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && (best === undefined || t > best)) best = t;
  }
  return best;
}

/** A fork's or pull_request_target's run: someone else's text. */
export function isUntrustedRun(run: Obj | null, repoFull: string | undefined): boolean {
  if (!run) return false;
  if (run.event === "pull_request_target") return true;
  const head = str(obj(run.head_repository)?.full_name);
  return head !== undefined && repoFull !== undefined &&
    head.toLowerCase() !== repoFull.toLowerCase();
}

function actor(p: Obj): NewEvent["actor"] {
  const s = obj(p.sender);
  const login = clean(s?.login, 60);
  if (!login) return undefined;
  return { login, type: s?.type === "Bot" ? "Bot" : "User" };
}

export interface Delivery {
  readonly id: string;
  readonly event: string;
  readonly receivedAt: number;
  readonly payload: Obj;
  readonly redelivery?: boolean;
  readonly payloadRef?: string;
}

/** The failed step's name of a completed job, from its payload's steps. */
export function failedStep(job: Obj): string | null {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const s of steps) {
    const o = obj(s);
    if (o && FAILED.has(String(o.conclusion))) return clean(o.name);
  }
  return null;
}

function actionsJob(
  p: Obj,
  repo: string | undefined,
  base: Partial<NewEvent>,
  ctx: NormalizeContext,
): Partial<NewEvent> {
  const job = obj(p.workflow_job) ?? {};
  const action = str(p.action) ?? "";
  // A job payload names no head repository, so whether its run is a fork's comes from the run's
  // own events (or a backfill) through the context.
  const runId = num(job.run_id);
  const wrapped = runId !== undefined && (ctx.runUntrusted?.(runId) ?? false);
  const name = clean(job.name);
  const conclusion = str(job.conclusion) ?? null;
  const branch = clean(job.head_branch);
  const labels = Array.isArray(job.labels)
    ? job.labels.map((l) => clean(l, 60)).filter(Boolean)
    : [];
  const runner = clean(job.runner_name, 80);
  let sev: Severity = "info";
  let text = `job "${name}" ${action}`;
  if (action === "completed") {
    sev = conclusionSev(conclusion);
    const step = sev === "bad" && !wrapped ? failedStep(job) : null;
    text = `job "${name}" ${conclusion ?? "completed"}${step ? ` at step "${step}"` : ""}`;
  } else if (action === "in_progress") {
    text = `job "${name}" started${runner ? ` on ${runner}` : ""}`;
  } else if (action === "queued") {
    text = `job "${name}" queued${labels.length ? ` for ${labels.join(",")}` : ""}`;
  } else if (action === "waiting") {
    text = `job "${name}" waiting for approval`;
    sev = "warn";
  }
  if (branch && !wrapped) text += ` · ${branch}`;
  const id = num(job.id);
  return {
    ...base,
    at: time(job.completed_at, job.started_at, job.created_at) ?? base.at,
    sev,
    text,
    wrapped,
    subject: id !== undefined ? { type: "job", id: String(id), url: str(job.html_url) } : undefined,
    data: {
      status: str(job.status) ?? null,
      conclusion,
      job_id: id ?? null,
      run_id: num(job.run_id) ?? null,
      run_attempt: num(job.run_attempt) ?? null,
      workflow: nameField(job.workflow_name, wrapped),
      job: nameField(job.name, wrapped),
      branch: wrapped ? null : branch || null,
      head_sha: str(job.head_sha) ?? null,
      labels,
      runner_name: runner || null,
      runner_group: clean(job.runner_group_name, 80) || null,
      failed_step: sev === "bad" ? nameField(failedStep(job), wrapped) : null,
    },
    repo,
  };
}

function actionsRun(p: Obj, repo: string | undefined, base: Partial<NewEvent>): Partial<NewEvent> {
  const run = obj(p.workflow_run) ?? {};
  const action = str(p.action) ?? "";
  const wrapped = isUntrustedRun(run, repo);
  const name = clean(run.name);
  const conclusion = str(run.conclusion) ?? null;
  const branch = clean(run.head_branch);
  let sev: Severity = "info";
  let text = `run "${name}" #${num(run.run_number) ?? "?"} ${action}`;
  if (action === "completed") {
    sev = conclusionSev(conclusion);
    text = `run "${name}" #${num(run.run_number) ?? "?"} ${conclusion ?? "completed"}`;
  }
  if (!wrapped && branch) text += ` · ${branch}`;
  if (wrapped) text += " (fork / pull_request_target)";
  const id = num(run.id);
  return {
    ...base,
    at: time(run.updated_at, run.run_started_at, run.created_at) ?? base.at,
    sev,
    text,
    wrapped,
    subject: id !== undefined ? { type: "run", id: String(id), url: str(run.html_url) } : undefined,
    data: {
      status: str(run.status) ?? null,
      conclusion,
      run_id: id ?? null,
      run_number: num(run.run_number) ?? null,
      run_attempt: num(run.run_attempt) ?? null,
      workflow: nameField(run.name, wrapped),
      title: nameField(run.display_title, wrapped),
      branch: wrapped ? null : branch || null,
      head_branch: nameField(run.head_branch, wrapped),
      head_sha: str(run.head_sha) ?? null,
      event: str(run.event) ?? null,
    },
    repo,
  };
}

/** Issue / PR / discussion style subjects. */
function content(
  ev: string,
  p: Obj,
  repo: string | undefined,
  base: Partial<NewEvent>,
): Partial<NewEvent> {
  const action = str(p.action) ?? "";
  let item: Obj | null = null;
  let type: Subject["type"] = "issue";
  let noun = "issue";
  if (ev === "issues") item = obj(p.issue);
  else if (ev === "pull_request" || ev.startsWith("pull_request_review")) {
    item = obj(p.pull_request);
    type = "pull";
    noun = "PR";
  } else if (ev === "issue_comment") {
    item = obj(p.issue);
    if (item && obj(item.pull_request)) {
      type = "pull";
      noun = "PR";
    }
  } else if (ev === "discussion" || ev === "discussion_comment") {
    item = obj(p.discussion);
    type = "discussion";
    noun = "discussion";
  }
  const number = num(item?.number);
  // A PR from a fork: its title is someone else's text, wrapped (Fleet's rule for fork runs).
  const headRepo = str(obj(obj(item?.head)?.repo)?.full_name);
  const wrapped = type === "pull" && headRepo !== undefined && repo !== undefined &&
    headRepo.toLowerCase() !== repo.toLowerCase();
  const title = clean(item?.title);
  const ref = number !== undefined ? `${noun} #${number}` : noun;
  let what = action.replace(/_/g, " ");
  if (ev.endsWith("comment")) what = `comment ${action}`;
  else if (ev === "pull_request_review") what = `review ${str(obj(p.review)?.state) ?? action}`;
  else if (ev === "pull_request_review_thread") what = `review thread ${action}`;
  const label = clean(obj(p.label)?.name, 60);
  const assignee = clean(obj(p.assignee)?.login, 60);
  const requested = clean(obj(p.requested_reviewer)?.login, 60);
  const extra = label
    ? ` "${label}"`
    : assignee
    ? ` ${assignee}`
    : requested
    ? ` ${requested}`
    : "";
  const merged = ev === "pull_request" && action === "closed" && item?.merged === true;
  const text = `${ref} ${merged ? "merged" : what}${extra}${!wrapped && title ? `: ${title}` : ""}`;
  const comment = obj(p.comment);
  return {
    ...base,
    at: time(comment?.updated_at, obj(p.review)?.submitted_at, item?.updated_at) ?? base.at,
    sev: "info",
    text,
    wrapped,
    subject: number !== undefined
      ? {
        type,
        id: String(num(item?.id) ?? number),
        number,
        node_id: str(item?.node_id),
        url: str(item?.html_url),
      }
      : undefined,
    data: {
      title: nameField(item?.title, wrapped),
      state: str(item?.state) ?? null,
      merged: merged || undefined,
      label: label || undefined,
      assignee: assignee || undefined,
      requested_reviewer: requested || undefined,
      comment_id: num(comment?.id),
      updated_at: str(item?.updated_at) ?? null,
    },
    repo,
  };
}

function project(ev: string, p: Obj, base: Partial<NewEvent>): Partial<NewEvent> {
  const action = str(p.action) ?? "";
  const item = obj(p.projects_v2_item) ?? obj(p.projects_v2) ?? obj(p.projects_v2_status_update);
  const node = str(item?.node_id);
  const changes = obj(p.changes);
  const field = obj(changes?.field_value);
  const what = ev === "projects_v2_item"
    ? `item ${action}${field ? ` (${clean(field.field_name ?? field.field_node_id, 60)})` : ""}`
    : ev === "projects_v2"
    ? `project ${action}${item?.title ? `: ${clean(item.title)}` : ""}`
    : `status update ${action}`;
  return {
    ...base,
    at: time(item?.updated_at) ?? base.at,
    sev: "info",
    text: what,
    subject: node
      ? {
        type: ev === "projects_v2_item" ? "item" : "project",
        id: node,
        node_id: node,
        number: num(item?.number),
      }
      : undefined,
    data: {
      project_node_id: str(item?.project_node_id) ?? (ev === "projects_v2" ? node : undefined) ??
        null,
      content_node_id: str(item?.content_node_id) ?? null,
      content_type: str(item?.content_type) ?? null,
      field_node_id: str(field?.field_node_id) ?? null,
      field_type: str(field?.field_type) ?? null,
      updated_at: str(item?.updated_at) ?? null,
    },
  };
}

/** What normalizing needs from the hub's state. */
export interface NormalizeContext {
  /** Whether a run is a fork's / pull_request_target's (from its workflow_run events). */
  readonly runUntrusted?: (runId: number) => boolean;
}

/** One delivery → one event (never throws; a malformed payload gives a plain `github.*` line). */
export function normalize(d: Delivery, ctx: NormalizeContext = {}): NewEvent {
  const p = d.payload;
  const repoObj = obj(p.repository);
  const repo = str(repoObj?.full_name);
  const owner = clean(
    str(obj(repoObj?.owner)?.login) ?? str(obj(p.organization)?.login) ?? repo?.split("/")[0] ?? "",
    100,
  );
  const action = str(p.action);
  const family = FAMILY[d.event];
  const kindAction = d.event === "status" ? clean(p.state, 30) || "updated" : action || "event";
  const kind = `${family ?? `github.${clean(d.event, 60)}`}.${kindAction}`;
  const base: Partial<NewEvent> = {
    at: d.receivedAt,
    received_at: d.receivedAt,
    source: d.redelivery ? "redelivery" : "webhook",
    kind,
    gh_event: d.event,
    action,
    delivery_id: d.id,
    owner,
    repo,
    actor: actor(p),
    payload_ref: d.payloadRef,
    sev: "info",
    data: {},
  };
  let ev: Partial<NewEvent>;
  try {
    if (d.event === "workflow_job") ev = actionsJob(p, repo, base, ctx);
    else if (d.event === "workflow_run") ev = actionsRun(p, repo, base);
    else if (
      family?.startsWith("issues.") || family?.startsWith("pulls.") ||
      family?.startsWith("discussions.")
    ) {
      ev = content(d.event, p, repo, base);
    } else if (family?.startsWith("projects.")) ev = project(d.event, p, base);
    else if (d.event === "check_suite" || d.event === "check_run") {
      const c = obj(p.check_suite) ?? obj(p.check_run) ?? {};
      const concl = str(c.conclusion) ?? null;
      ev = {
        ...base,
        sev: action === "completed" ? conclusionSev(concl) : "info",
        text: `${d.event === "check_suite" ? "check suite" : `check "${clean(c.name)}"`} ${
          action === "completed" ? concl ?? "completed" : action ?? ""
        } · ${clean(c.head_branch) || (str(c.head_sha) ?? "").slice(0, 7)}`,
        subject: num(c.id) !== undefined ? { type: "run", id: String(c.id) } : undefined,
        data: {
          status: str(c.status) ?? null,
          conclusion: concl,
          head_sha: str(c.head_sha) ?? null,
        },
      };
    } else if (d.event === "status") {
      const state = str(p.state) ?? "";
      ev = {
        ...base,
        sev: state === "success" ? "ok" : state === "failure" || state === "error" ? "bad" : "info",
        text: `status "${clean(p.context)}" ${state} · ${(str(p.sha) ?? "").slice(0, 7)}`,
        data: { state, context: clean(p.context), sha: str(p.sha) ?? null },
      };
    } else {
      const thing = obj(p.label) ?? obj(p.milestone) ?? repoObj;
      ev = {
        ...base,
        text: `${d.event.replace(/_/g, " ")} ${action ?? ""}${
          thing?.name || thing?.title ? `: ${clean(thing.name ?? thing.title)}` : ""
        }`,
      };
    }
  } catch {
    ev = { ...base, text: `${d.event} ${action ?? ""}` };
  }
  return {
    ...(base as NewEvent),
    ...ev,
    data: Object.fromEntries(Object.entries(ev.data ?? {}).filter(([, v]) => v !== undefined)),
  } as NewEvent;
}
