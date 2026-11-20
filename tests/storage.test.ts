// The log, retention, search (FTS5 and its fallback) and tokens, on real SQLite files.

import { assert, assertEquals, assertFalse, assertNotEquals } from "@std/assert";
import { hasFts5, openHubDb } from "../hub/db.ts";
import { EventLog } from "../hub/log.ts";
import { prune } from "../hub/retention.ts";
import { SearchIndex } from "../hub/search.ts";
import { DEFAULT_SETTINGS } from "../hub/settings.ts";
import { TokenStore } from "../hub/tokens.ts";
import type { NewEvent } from "../shared/events.ts";
import { NOW } from "./helpers.ts";

const DAY = 86_400_000;

/** Incompressible bytes (getRandomValues takes at most 64 KiB a call). */
function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) {
    crypto.getRandomValues(out.subarray(o, Math.min(n, o + 65536)));
  }
  return out;
}

function ev(over: Partial<NewEvent> = {}): NewEvent {
  return {
    at: NOW,
    received_at: NOW,
    source: "webhook",
    kind: "actions.job.completed",
    owner: "acme",
    repo: "acme/web",
    sev: "info",
    text: "job done",
    data: {},
    ...over,
  };
}

async function tmpDb(fts?: boolean) {
  const dir = await Deno.makeTempDir({ prefix: "ghpro-db-" });
  const h = openHubDb(`${dir}/hub.db`, { fts });
  return { ...h, dir, done: async () => (h.close(), await Deno.remove(dir, { recursive: true })) };
}

Deno.test("phase-1 risk: Deno's node:sqlite has FTS5", () => {
  assert(hasFts5(), "FTS5 missing: search falls back to LIKE");
});

Deno.test("log: seqs increase, are never reused after a prune, and text is sanitized", async () => {
  const h = await tmpDb();
  const log = new EventLog(h.db, () => NOW);
  const seen: number[] = [];
  log.onAppend((es) => seen.push(...es.map((e) => e.seq)));
  const a = log.append([ev({ text: "one\nline" }), ev()]);
  assertEquals(a.map((e) => e.seq), [1, 2]);
  assertEquals(a[0].text, "one line");
  assertEquals(seen, [1, 2]);
  h.db.exec("DELETE FROM events");
  assertEquals(log.append([ev()])[0].seq, 3);
  assertEquals(log.lastSeq(), 3);
  assertEquals(log.oldestSeq(), 3);
  await h.done();
});

Deno.test("log: pages filter, cursor and has_more; gap when since is too old", async () => {
  const h = await tmpDb();
  const log = new EventLog(h.db, () => NOW);
  for (let i = 0; i < 30; i++) {
    log.append([
      ev({
        kind: i % 3 === 0 ? "issues.issue.opened" : "actions.job.completed",
        repo: i % 2 ? "acme/web" : "acme/api",
      }),
    ]);
  }
  const p1 = log.page({ kind: ["issues.*"] }, 0, 4);
  assertEquals(p1.events.length, 4);
  assert(p1.has_more);
  const p2 = log.page({ kind: ["issues.*"] }, p1.next_seq, 100);
  assertEquals(p2.events.length, 6);
  assertFalse(p2.has_more);
  assertEquals(
    log.page({ repo: ["api"], kind: ["actions.job.completed"] }, 0, 100).events.length,
    10,
  );
  h.db.exec("DELETE FROM events WHERE seq <= 10");
  assertEquals(log.page({}, 2, 5).gap, { from: 3, to: 10, oldest_seq: 11 });
  assertEquals(log.page({}, 10, 5).gap, undefined);
  await h.done();
});

Deno.test("log: since by age; payloads round-trip deflated; deliveries de-dupe", async () => {
  const h = await tmpDb();
  const log = new EventLog(h.db, () => NOW);
  log.append([ev({ received_at: NOW - 3 * 3_600_000 }), ev({ received_at: NOW - 600_000 })]);
  assertEquals(log.resolveSince({ ageMs: 3_600_000 }), 1);
  assertEquals(log.resolveSince({ now: true }), 2);
  const body = new TextEncoder().encode(JSON.stringify({ big: "x".repeat(10_000) }));
  const ref = await log.storePayload("g1", "issues", NOW, body);
  assertEquals(await log.storePayload("g1", "issues", NOW, body), ref);
  const size = (h.db.prepare("SELECT size FROM payloads").get() as { size: number }).size;
  assert(size < 1000, `deflated: ${size}`);
  assertEquals(await log.payload(ref), { big: "x".repeat(10_000) });
  assert(log.rememberDelivery("g1", NOW, 5, "issues"));
  assertFalse(log.rememberDelivery("g1", NOW, 5, "issues"));
  assert(log.seenDelivery("g1"));
  await h.done();
});

Deno.test("retention: events 90 days, problems and agent events a year, payload cap", async () => {
  const h = await tmpDb();
  const log = new EventLog(h.db, () => NOW);
  log.append([
    ev({ received_at: NOW - 100 * DAY }),
    ev({ received_at: NOW - 100 * DAY, sev: "bad" }),
    ev({ received_at: NOW - 100 * DAY, agent: { client: "mcp" } }),
    ev({ received_at: NOW - 400 * DAY, sev: "bad" }),
    ev({ received_at: NOW - DAY }),
  ]);
  for (let i = 0; i < 5; i++) {
    await log.storePayload(
      `p${i}`,
      "x",
      NOW - i * 1000,
      noise(400_000),
    );
  }
  await log.storePayload("old", "x", NOW - 8 * DAY, new Uint8Array(10));
  log.rememberDelivery("d-old", NOW - 15 * DAY, null, "x");
  log.rememberDelivery("d-new", NOW - DAY, null, "x");
  const r = prune(h.db, { ...DEFAULT_SETTINGS.retention, payloadMaxMB: 1 }, NOW);
  assertEquals(r.events, 2);
  assertEquals(log.count(), 3);
  assertEquals(r.deliveries, 1);
  const left = h.db.prepare("SELECT delivery_id FROM payloads ORDER BY received_at DESC").all() as {
    delivery_id: string;
  }[];
  assertEquals(left.map((x) => x.delivery_id), ["p0", "p1"], "newest kept under 1 MB");
  await h.done();
});

for (const fts of [true, false]) {
  Deno.test(`search (${fts ? "fts5" : "LIKE fallback"}): terms all match, kinds filter, updates win`, async () => {
    const h = await tmpDb(fts);
    assertEquals(h.searchMode, fts ? "fts5" : "like");
    const s = new SearchIndex(h.db, h.searchMode);
    s.upsert({
      subject: "issue:acme/web#1",
      kind: "issue",
      repo: "acme/web",
      title: "SSE replay drops",
      body: "the stream loses events",
      updated_at: 1,
    });
    s.upsert({
      subject: "pull:acme/web#2",
      kind: "pull",
      title: "Fix replay",
      body: "closes #1",
      updated_at: 2,
    });
    s.upsert({
      subject: "issue:acme/web#3",
      kind: "issue",
      title: "100% CPU",
      body: "under_score",
      updated_at: 3,
    });
    assertEquals(s.search("replay").length, 2);
    assertEquals(s.search("replay stream").map((x) => x.subject), ["issue:acme/web#1"]);
    assertEquals(s.search("replay", { kinds: ["pull"] }).map((x) => x.subject), [
      "pull:acme/web#2",
    ]);
    assertEquals(s.search('" OR 1=1 --').length, 0, "operators are quoted");
    s.upsert({
      subject: "pull:acme/web#2",
      kind: "pull",
      title: "Renamed",
      body: "",
      updated_at: 1,
    });
    assertEquals(s.search("renamed").length, 0, "an older update doesn't overwrite");
    s.remove("issue:acme/web#1");
    assertEquals(s.search("stream").length, 0);
    await h.done();
  });
}

Deno.test("tokens: 0600 files in a 0700 folder, hashed, scoped, revocable, rotatable", async () => {
  const h = await tmpDb();
  const t = new TokenStore(h.db, `${h.dir}/tokens`, () => NOW);
  const made = await t.ensureDefaults(true);
  assertEquals(made.sort(), ["board", "cli", "fleet", "mcp"]);
  assertEquals(await t.ensureDefaults(true), []);
  const mcp = t.get("mcp")!;
  assert(mcp.agent);
  assertEquals(mcp.scopes, ["read", "write:projects", "write:issues"]);
  const file = t.tokenPath("cli");
  const token = (await Deno.readTextFile(file)).trim();
  assert(token.startsWith("ghpro."));
  if (Deno.build.os !== "windows") {
    assertEquals((await Deno.stat(file)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(`${h.dir}/tokens`)).mode! & 0o777, 0o700);
  }
  const stored = h.db.prepare("SELECT token_hash FROM clients WHERE name = 'cli'").get() as {
    token_hash: string;
  };
  assertNotEquals(stored.token_hash, token);
  assertEquals((await t.verify(token))?.name, "cli");
  assertEquals(await t.verify("ghpro.nope"), null);
  assertEquals(await t.verify(null), null);
  await t.rotate("cli");
  assertEquals(await t.verify(token), null, "the old token stops working");
  assert(await t.revoke("board"));
  assertFalse(await t.revoke("board"));
  await Deno.remove(t.tokenPath("fleet"));
  assertEquals((await t.ensureDefaults(false)).sort(), ["board", "fleet"]);
  await h.done();
});
