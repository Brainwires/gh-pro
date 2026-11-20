// Webhook health and gap reconciliation against a fake GitHub.

import { assert, assertEquals } from "@std/assert";
import { openHubDb } from "../hub/db.ts";
import { EventLog } from "../hub/log.ts";
import { GapStore } from "../hub/gaps.ts";
import { HookStore } from "../hub/hooks.ts";
import { HealthMonitor, missedDeliveries } from "../hub/health.ts";
import { SyncEngine } from "../hub/sync.ts";
import { ExpectedRedeliveries, Reconciler } from "../hub/reconcile.ts";
import { matchEvent } from "../shared/filter.ts";
import { fakeGitHub, NOW, type Route, type Seen } from "./helpers.ts";

const iso = (ms: number) => new Date(ms).toISOString();

function setup(routes: Record<string, Route | ((s: Seen) => Route)>) {
  let now = NOW;
  const clock = () => now;
  const h = openHubDb(":memory:");
  const log = new EventLog(h.db, clock);
  const hooks = new HookStore(h.db, () => NOW - 86_400_000);
  const gaps = new GapStore(h.db, clock);
  const { gh, seen } = fakeGitHub(routes, clock);
  const sync = new SyncEngine(h.db, gh, log, hooks, clock);
  const reconcileCalls: string[] = [];
  const health = new HealthMonitor({
    hooks,
    gh,
    log,
    gaps,
    intervalMs: 15 * 60_000,
    now: clock,
    onReconcile: (t) => reconcileCalls.push(t),
  });
  const expected = new ExpectedRedeliveries(clock);
  const rec = new Reconciler({ gh, hooks, gaps, log, sync, health, expected, now: clock });
  hooks.upsert({
    target: "acme",
    mode: "tunnel",
    url: "https://hooks.example.test/github/hooks",
    events: ["workflow_job"],
    secret: { source: "env", name: "X" },
    hookId: 5,
  });
  return {
    h,
    log,
    hooks,
    gaps,
    health,
    rec,
    sync,
    seen,
    expected,
    reconcileCalls,
    advance: (ms: number) => (now += ms),
  };
}

Deno.test("health: a missing ping is a bad health problem and opens a gap; the ping's arrival recovers", async () => {
  const t = setup({
    "POST /orgs/acme/hooks/5/pings": { status: 204 },
    "/orgs/acme/hooks/5/deliveries?per_page=100": { body: [] },
  });
  t.health.onVerified("acme", "workflow_job", NOW);
  await t.health.tick();
  assertEquals(t.seen.map((s) => `${s.method} ${new URL(s.url).pathname}`), [
    "POST /orgs/acme/hooks/5/pings",
    "GET /orgs/acme/hooks/5/deliveries",
  ]);
  t.advance(61_000);
  await t.health.tick();
  const page = t.log.page({ derived: ["problems"] }, 0);
  assertEquals(page.events.map((e) => e.kind), ["hub.health.down"]);
  assert(matchEvent({ derived: ["health"] }, page.events[0]));
  const gap = t.gaps.openFor("acme")!;
  assertEquals(gap.fromAt, NOW, "from the last good moment");
  t.health.onVerified("acme", "ping", NOW + 120_000);
  assertEquals(t.health.detail("acme").state, "live");
  assertEquals(t.reconcileCalls, ["acme"]);
});

Deno.test("health: failed or missed deliveries make the path degraded and ask for reconciliation", async () => {
  const t = setup({
    "POST /orgs/acme/hooks/5/pings": { status: 204 },
    "/orgs/acme/hooks/5/deliveries?per_page=100": {
      body: [
        {
          id: 1,
          guid: "g-ok",
          delivered_at: iso(NOW - 600_000),
          redelivery: false,
          status: "OK",
          status_code: 202,
          event: "workflow_job",
        },
        {
          id: 2,
          guid: "g-miss",
          delivered_at: iso(NOW - 300_000),
          redelivery: false,
          status: "Bad Gateway",
          status_code: 502,
          event: "workflow_job",
        },
        {
          id: 3,
          guid: "p",
          delivered_at: iso(NOW - 200_000),
          redelivery: false,
          status: "OK",
          status_code: 200,
          event: "ping",
        },
      ],
    },
  });
  t.log.rememberDelivery("g-ok", NOW - 600_000, 5, "workflow_job");
  await t.health.tick();
  assertEquals(t.health.detail("acme").state, "degraded");
  assertEquals(t.health.detail("acme").failed, 1);
  assertEquals(t.gaps.openFor("acme")?.fromAt, NOW - 300_000);
  assertEquals(t.reconcileCalls, ["acme"]);
});

Deno.test("missedDeliveries: one per GUID, not pings, inside the window", () => {
  const d = (guid: string, at: number, event = "issues") => ({
    id: 1,
    guid,
    delivered_at: iso(at),
    redelivery: false,
    status: "OK",
    status_code: 200,
    event,
  });
  const list = [
    d("a", NOW - 10),
    d("a", NOW - 20),
    d("b", NOW - 1000),
    d("c", NOW - 5, "ping"),
    d("e", NOW + 10),
  ];
  assertEquals(missedDeliveries(list, () => false, NOW - 500, NOW).map((x) => x.guid), ["a"]);
});

Deno.test("reconcile: redelivers exactly the deliveries the hub never received", async () => {
  const attempts: string[] = [];
  const t = setup({
    "/orgs/acme/hooks/5/deliveries?per_page=100": {
      body: [
        {
          id: 30,
          guid: "g3",
          delivered_at: iso(NOW - 60_000),
          redelivery: false,
          status: "OK",
          status_code: 202,
          event: "issues",
        },
        {
          id: 20,
          guid: "g2",
          delivered_at: iso(NOW - 120_000),
          redelivery: false,
          status: "timeout",
          status_code: 0,
          event: "workflow_job",
        },
        {
          id: 10,
          guid: "g1",
          delivered_at: iso(NOW - 7_200_000),
          redelivery: false,
          status: "OK",
          status_code: 202,
          event: "workflow_job",
        },
      ],
    },
    "POST /orgs/acme/hooks/5/deliveries/20/attempts": (
      s,
    ) => (attempts.push(s.url), { status: 202 }),
    "POST /orgs/acme/hooks/5/deliveries/30/attempts": (
      s,
    ) => (attempts.push(s.url), { status: 202 }),
  });
  t.log.rememberDelivery("g3", NOW - 60_000, 5, "issues");
  t.gaps.open("acme", NOW - 3_600_000, "hub was not running");
  const r = await t.rec.reconcileTarget("acme");
  assertEquals(r?.state, "reconciled");
  assertEquals(r?.redelivered, 1);
  assertEquals(attempts.length, 1);
  assert(attempts[0].endsWith("/deliveries/20/attempts"));
  assert(t.expected.take("g2"), "the ingress will accept g2 past its replay window");
  assertEquals(t.gaps.openFor("acme"), null);
  assertEquals(t.health.detail("acme").state, "live");
});

Deno.test("reconcile: a vanished hook falls back to a targeted re-read with reconciled sync events", async () => {
  const t = setup({
    "/orgs/acme/repos?per_page=100&type=all": {
      body: [{ full_name: "acme/web" }, { full_name: "acme/old", archived: true }],
    },
    [
      `/repos/acme/web/actions/runs?created=${
        encodeURIComponent(">=" + iso(NOW - 3_600_000).replace(/\.\d+Z$/, "Z"))
      }&per_page=100`
    ]: {
      body: {
        workflow_runs: [
          {
            id: 7,
            name: "CI",
            run_number: 42,
            status: "completed",
            conclusion: "failure",
            head_branch: "main",
            head_repository: { full_name: "acme/web" },
            updated_at: iso(NOW - 600_000),
            created_at: iso(NOW - 900_000),
          },
          {
            id: 8,
            name: "CI",
            run_number: 43,
            status: "completed",
            conclusion: "success",
            head_branch: "main",
            head_repository: { full_name: "acme/web" },
            updated_at: iso(NOW - 500_000),
            created_at: iso(NOW - 800_000),
          },
        ],
      },
    },
  });
  // Run 8 is already known in that state: no event for it.
  t.sync.upsertRun("acme/web", {
    id: 8,
    status: "completed",
    conclusion: "success",
    updated_at: iso(NOW - 500_000),
  });
  t.gaps.open("acme", NOW - 3_600_000, "forwarder stopped");
  const r = await t.rec.reconcileTarget("acme");
  assertEquals(r?.state, "reconciled");
  assertEquals(r?.reread, 1);
  const evs = t.log.page({ kind: ["actions.run.*"] }, 0).events;
  assertEquals(evs.length, 1);
  assertEquals(evs[0].source, "sync");
  assertEquals(evs[0].sev, "bad");
  assertEquals(evs[0].data.reconciled, true);
  assert(evs[0].text.includes("while the hub was offline"));
  assert(t.gaps.recent(1)[0].detail?.includes("not recovered until phase 4"));
});

Deno.test("sync: state upserts only move forward; scope needs a covering webhook path", () => {
  const t = setup({});
  assert(t.sync.upsertRun("acme/web", { id: 1, status: "in_progress", updated_at: iso(NOW) }));
  assertEquals(
    t.sync.upsertRun("acme/web", { id: 1, status: "queued", updated_at: iso(NOW - 1000) }),
    null,
  );
  assertEquals(t.sync.runs({ repo: "web" })[0].status, "in_progress");
  assert(
    t.sync.upsertJob("acme/web", {
      id: 2,
      run_id: 1,
      status: "completed",
      conclusion: "success",
      completed_at: iso(NOW),
    }),
  );
  assertEquals(
    t.sync.upsertJob("acme/web", {
      id: 2,
      run_id: 1,
      status: "in_progress",
      started_at: iso(NOW + 5),
    }),
    false,
  );
  assert(t.sync.addScope("acme/web", "cli"), "the org hook covers its repos");
  let refused = "";
  try {
    t.sync.addScope("other", "cli");
  } catch (e) {
    refused = String(e);
  }
  assert(refused.includes("webhook setup other"), refused);
});
