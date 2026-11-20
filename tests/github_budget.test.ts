import { assert, assertEquals, assertRejects } from "@std/assert";
import { Budget, FLOORS } from "../hub/budget.ts";
import { GitHub, GitHubError, missingScopes, nextLink } from "../hub/github.ts";
import { openHubDb } from "../hub/db.ts";
import { fakeFetch, fakeToken, NOW } from "./helpers.ts";

Deno.test("budget: floors per class, a stale figure ignored", () => {
  let now = NOW;
  const b = new Budget(1200, () => now);
  assert(b.check(3).ok, "no figure yet: allowed");
  b.update("core", 1000, 5000, NOW + 60_000);
  assert(b.check(0).ok);
  assert(b.check(1).ok);
  assertEquals(b.check(2).ok, false);
  assertEquals(b.check(3).ok, false);
  b.update("graphql", 100, 5000, NOW + 60_000);
  assertEquals(b.check(0, "graphql").ok, false);
  now = NOW + 61_000;
  assert(b.check(3).ok, "past the reset the old figure doesn't count");
  assertEquals(FLOORS[3], 2500);
});

Deno.test("budget: the hourly sync cap spares P0; P3 waits for the user; backoff doubles", () => {
  let now = NOW;
  const b = new Budget(3, () => now);
  for (let i = 0; i < 3; i++) b.record("backfill", 3, true);
  b.record("backfill", 3, false); // a 304: free
  assertEquals(b.check(1).ok, false);
  assert(b.check(0).ok);
  now += 3_600_001;
  assert(b.check(1).ok);
  const done = b.userWaiting();
  assertEquals(b.check(3).ok, false);
  assert(b.check(2).ok);
  done();
  assert(b.check(3).ok);
  b.penalize(null);
  assertEquals(b.backoffUntil(), now + 60_000);
  b.penalize(null);
  assertEquals(b.backoffUntil(), now + 120_000);
  b.penalize(5000);
  assertEquals(b.backoffUntil(), now + 5000);
  assertEquals(b.check(0).ok, false);
});

Deno.test("github: conditional GETs; a 304 is served from cache and not counted", async () => {
  const h = openHubDb(":memory:");
  let n = 0;
  const { fetch, seen } = fakeFetch({
    "/repos/acme/web":
      () => (n++ === 0 ? { body: { id: 1 }, headers: { etag: '"e1"' } } : { status: 304 }),
  });
  const budget = new Budget(1200, () => NOW);
  const gh = new GitHub({ token: fakeToken(), budget, db: h.db, fetch, now: () => NOW });
  const a = await gh.request("GET", "/repos/acme/web", { priority: 1, reason: "backfill" });
  const b = await gh.request("GET", "/repos/acme/web", { priority: 1, reason: "backfill" });
  assertEquals(a.data, { id: 1 });
  assertEquals(b.data, { id: 1 });
  assert(b.cached);
  assertEquals(seen[1].headers.get("if-none-match"), '"e1"');
  assertEquals(budget.byReason().backfill, 1);
  assertEquals(budget.rate("core")?.remaining, 4000);
  h.close();
});

Deno.test("github: a 401 re-reads the token once; a rate-limit 403 backs off", async () => {
  let calls = 0;
  const { fetch } = fakeFetch({
    "/user": () => (calls++ === 0
      ? { status: 401, body: { message: "Bad credentials" } }
      : { body: { login: "jo" } }),
    "POST /x": {
      status: 403,
      body: { message: "You have exceeded a secondary rate limit" },
      headers: { "retry-after": "30" },
    },
  });
  const token = fakeToken();
  const budget = new Budget(1200, () => NOW);
  const gh = new GitHub({ token, budget, fetch, now: () => NOW });
  assertEquals((await gh.request("GET", "/user", { priority: 0, reason: "on-demand" })).data, {
    login: "jo",
  });
  assertEquals(token.invalidated, 1);
  const e = await assertRejects(
    () => gh.request("POST", "/x", { priority: 0, reason: "write" }),
    GitHubError,
  );
  assertEquals(e.until, NOW + 30_000);
  await assertRejects(
    () => gh.request("GET", "/user", { priority: 0, reason: "on-demand" }),
    GitHubError,
    "backoff",
  );
});

Deno.test("github: pagination by Link, scopes from x-oauth-scopes, no non-API URLs", async () => {
  const { fetch } = fakeFetch({
    "/orgs/acme/repos?per_page=100": {
      body: [{ n: 1 }],
      headers: {
        link: '<https://api.github.com/orgs/acme/repos?per_page=100&page=2>; rel="next"',
        "x-oauth-scopes": "repo, read:org",
      },
    },
    "/orgs/acme/repos?per_page=100&page=2": { body: [{ n: 2 }] },
  });
  const gh = new GitHub({
    token: fakeToken(),
    budget: new Budget(1200, () => NOW),
    fetch,
    now: () => NOW,
  });
  assertEquals(
    await gh.paginate("/orgs/acme/repos?per_page=100", { priority: 1, reason: "backfill" }),
    [{ n: 1 }, { n: 2 }],
  );
  assertEquals(gh.scopes, ["repo", "read:org"]);
  assertEquals(missingScopes(gh.scopes), ["project", "admin:org_hook"]);
  await assertRejects(
    () => gh.request("GET", "https://evil.example/x", { priority: 0, reason: "on-demand" }),
    GitHubError,
  );
  assertEquals(nextLink('<a>; rel="prev", <b>; rel="next"'), "b");
});
