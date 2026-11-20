import { assert, assertEquals, assertFalse } from "@std/assert";
import { kindMatches, matchEvent, parseSince, parseSubscription } from "../shared/filter.ts";
import { clean, type HubEvent, isProblem, ulid } from "../shared/events.ts";
import { normalize } from "../hub/normalize.ts";
import { formatLine } from "../shared/protocol.ts";
import { jobPayload, NOW, runPayload } from "./helpers.ts";

const ev = (over: Partial<HubEvent>): HubEvent => ({
  seq: 1,
  id: "x",
  at: NOW,
  received_at: NOW,
  source: "webhook",
  kind: "actions.job.completed",
  owner: "acme",
  repo: "acme/web",
  sev: "bad",
  text: "t",
  data: { branch: "main", pool: "linux" },
  untrusted: true,
  ...over,
});

Deno.test("kind globs: * within a segment, trailing .* for the rest", () => {
  assert(kindMatches("actions.job.*", "actions.job.completed"));
  assert(kindMatches("actions.*", "actions.job.completed"));
  assert(kindMatches("actions.*.completed", "actions.run.completed"));
  assertFalse(kindMatches("actions.*.completed", "actions.run.x.completed"));
  assertFalse(kindMatches("actions.job.*", "actions.jobs.completed"));
  assert(kindMatches("issues.issue.labeled", "issues.issue.labeled"));
});

Deno.test("filters: fields AND, values OR; bare repo names; derived problems / health", () => {
  const s = parseSubscription(
    new URLSearchParams("repo=web,other&kind=actions.*&derived=problems"),
  );
  if (typeof s === "string") throw new Error(s);
  assert(matchEvent(s.filter, ev({})));
  assertFalse(matchEvent(s.filter, ev({ sev: "ok" })));
  assertFalse(matchEvent(s.filter, ev({ repo: "acme/api" })));
  const h = parseSubscription(new URLSearchParams("derived=health"));
  if (typeof h === "string") throw new Error(h);
  assert(matchEvent(h.filter, ev({ kind: "hub.health.down" })));
  assertFalse(matchEvent(h.filter, ev({})));
  const sub = parseSubscription(new URLSearchParams("subject=issue:acme/web%2312"));
  if (typeof sub === "string") throw new Error(sub);
  assert(matchEvent(sub.filter, ev({ subject: { type: "issue", id: "999", number: 12 } })));
});

Deno.test("subscriptions: bad input refused; since forms; Last-Event-ID wins", () => {
  assertEquals(typeof parseSubscription(new URLSearchParams("derived=nope")), "string");
  assertEquals(typeof parseSubscription(new URLSearchParams("format=xml")), "string");
  assertEquals(parseSince("-2h"), { ageMs: 7_200_000 });
  assertEquals(parseSince("15"), { seq: 15 });
  assertEquals(parseSince(null), { now: true });
  assertEquals(typeof parseSince("yesterday"), "string");
  const s = parseSubscription(new URLSearchParams("since=3"), "40");
  assertEquals(typeof s !== "string" && s.since, { seq: 40 });
});

Deno.test("normalize: a failed job is a bad problem event with its failed step", () => {
  const e = normalize({ id: "d1", event: "workflow_job", receivedAt: NOW, payload: jobPayload() });
  assertEquals(e.kind, "actions.job.completed");
  assertEquals(e.sev, "bad");
  assert(isProblem(e));
  assert(e.text.includes('at step "Run tests"'), e.text);
  assertEquals(e.data.failed_step, "Run tests");
  assertEquals(e.subject?.type, "job");
  assertEquals(e.owner, "acme");
  assertEquals(e.actor, { login: "jo", type: "User" });
});

Deno.test("normalize: a fork run is wrapped; its job hides the failed step", () => {
  const fork = runPayload({ head_repository: { full_name: "mallory/web" }, conclusion: "failure" });
  const r = normalize({ id: "d2", event: "workflow_run", receivedAt: NOW, payload: fork });
  assert(r.wrapped);
  assertEquals(r.data.title, { untrusted: "Fix the thing" });
  assertEquals(r.data.branch, null);
  const j = normalize(
    { id: "d3", event: "workflow_job", receivedAt: NOW, payload: jobPayload() },
    { runUntrusted: (id) => id === 7 },
  );
  assert(j.wrapped);
  assertFalse(j.text.includes("Run tests"));
  assertEquals(j.data.failed_step, { untrusted: "Run tests" });
});

Deno.test("normalize: issues, PRs, projects and unknown events", () => {
  const issue = normalize({
    id: "d4",
    event: "issues",
    receivedAt: NOW,
    payload: {
      action: "labeled",
      label: { name: "bug" },
      issue: { number: 12, id: 900, title: "Crash\non start", updated_at: "2026-11-16T11:00:00Z" },
      repository: { full_name: "acme/web", owner: { login: "acme" } },
    },
  });
  assertEquals(issue.kind, "issues.issue.labeled");
  assertEquals(issue.text, 'issue #12 labeled "bug": Crash on start');
  assertEquals(issue.subject?.number, 12);
  const pr = normalize({
    id: "d5",
    event: "pull_request",
    receivedAt: NOW,
    payload: {
      action: "closed",
      pull_request: {
        number: 3,
        id: 30,
        merged: true,
        title: "x",
        head: { repo: { full_name: "acme/web" } },
      },
      repository: { full_name: "acme/web", owner: { login: "acme" } },
    },
  });
  assertEquals(pr.text, "PR #3 merged: x");
  const item = normalize({
    id: "d6",
    event: "projects_v2_item",
    receivedAt: NOW,
    payload: {
      action: "edited",
      projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1", content_type: "Issue" },
      changes: { field_value: { field_node_id: "PVTF_1", field_type: "single_select" } },
      organization: { login: "acme" },
    },
  });
  assertEquals(item.kind, "projects.item.edited");
  assertEquals(item.owner, "acme");
  assertEquals(item.subject?.id, "PVTI_1");
  const odd = normalize({
    id: "d7",
    event: "star",
    receivedAt: NOW,
    payload: { action: "created" },
  });
  assertEquals(odd.kind, "github.star.created");
});

Deno.test("sanitizers and the line form keep one line", () => {
  assertEquals(clean("a b\x1b[31mc"), "a b [31mc");
  assertEquals(clean("x".repeat(200)).length, 120);
  const line = formatLine({ type: "event", ...ev({ text: "two\nlines" }) });
  assertFalse(line.includes("\n"));
  const a = ulid(NOW);
  const b = ulid(NOW);
  assertEquals(a.length, 26);
  assert(b > a, "monotonic within a millisecond");
});
