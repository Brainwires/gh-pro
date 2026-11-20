import { assert, assertEquals } from "@std/assert";
import {
  createIngressHandler,
  type IngressDelivery,
  MAX_ACTIONS_BODY,
  signBody,
} from "../hub/ingress.ts";
import { jobPayload, NOW } from "./helpers.ts";

const SECRET = "s".repeat(40);
const OTHER = "o".repeat(40);

async function req(
  body: unknown,
  o: { event?: string; id?: string; secret?: string; path?: string; type?: string; hook?: string } =
    {},
) {
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  return new Request(`http://127.0.0.1:8789${o.path ?? "/github/hooks"}`, {
    method: "POST",
    body: bytes,
    headers: {
      "content-type": o.type ?? "application/json",
      "x-github-event": o.event ?? "workflow_job",
      "x-github-delivery": o.id ?? "guid-1",
      "x-hub-signature-256": await signBody(o.secret ?? SECRET, bytes),
      ...(o.hook ? { "x-github-hook-id": o.hook } : {}),
    },
  });
}

function handler(extra: Partial<Parameters<typeof createIngressHandler>[0]> = {}) {
  const got: IngressDelivery[] = [];
  const rejects: string[] = [];
  const verified: [string, number | null][] = [];
  const h = createIngressHandler({
    secrets: () => [OTHER, SECRET],
    onDelivery: (d) => got.push(d),
    onVerified: (e, id) => verified.push([e, id]),
    onReject: (w) => rejects.push(w),
    defer: (fn) => fn(),
    now: () => NOW,
    ...extra,
  });
  return { h, got, rejects, verified };
}

Deno.test("ingress: one route, JSON only, signature first", async () => {
  const { h, got, rejects } = handler();
  assertEquals((await h(new Request("http://x/other", { method: "POST" }))).status, 404);
  assertEquals((await h(new Request("http://x/github/hooks"))).status, 404);
  assertEquals((await h(await req({}, { type: "text/plain" }))).status, 415);
  assertEquals((await h(await req(jobPayload(), { secret: "w".repeat(40) }))).status, 401);
  assertEquals(rejects, ["route", "route", "type", "signature"]);
  assertEquals(got.length, 0);
});

Deno.test("ingress: any known secret verifies; hook id passed; ping 200", async () => {
  const { h, got, verified } = handler();
  const r = await h(await req(jobPayload(), { secret: OTHER, hook: "77" }));
  assertEquals(r.status, 202);
  assertEquals(got.length, 1);
  assertEquals(got[0].hookId, 77);
  assertEquals(got[0].redelivery, false);
  assertEquals((await h(await req({ zen: "hi" }, { event: "ping", id: "p" }))).status, 200);
  assertEquals(verified.map((v) => v[0]), ["workflow_job", "ping"]);
});

Deno.test("ingress: non-Actions events are accepted now (widened from Fleet)", async () => {
  const { h, got } = handler();
  const r = await h(
    await req({ action: "opened", issue: { number: 1 } }, { event: "issues", id: "i1" }),
  );
  assertEquals(r.status, 202);
  assertEquals(got[0].event, "issues");
});

Deno.test("ingress: duplicates (memory and database) dropped", async () => {
  const known = new Set(["old"]);
  const { h, got } = handler({ isKnown: (id) => known.has(id) });
  await h(await req(jobPayload(), { id: "a" }));
  assertEquals(await (await h(await req(jobPayload(), { id: "a" }))).text(), "duplicate");
  assertEquals(await (await h(await req(jobPayload(), { id: "old" }))).text(), "duplicate");
  assertEquals(got.length, 1);
});

Deno.test("ingress: an old Actions delivery is a replay unless the hub asked for it", async () => {
  const old = jobPayload({
    created_at: new Date(NOW - 86_400_000).toISOString(),
    started_at: new Date(NOW - 86_400_000).toISOString(),
    completed_at: new Date(NOW - 86_400_000).toISOString(),
  });
  const expected = new Set(["redo"]);
  const { h, got, rejects } = handler({ expectedRedelivery: (id) => expected.delete(id) });
  assertEquals(await (await h(await req(old, { id: "late" }))).text(), "stale");
  assertEquals(rejects, ["stale"]);
  assertEquals((await h(await req(old, { id: "redo" }))).status, 202);
  assertEquals(got.length, 1);
  assert(got[0].redelivery);
  // Past GitHub's 3 days, even a requested redelivery is refused.
  const ancient = jobPayload({
    created_at: new Date(NOW - 5 * 86_400_000).toISOString(),
    started_at: null,
    completed_at: null,
  });
  expected.add("redo2");
  assertEquals(await (await h(await req(ancient, { id: "redo2" }))).text(), "stale");
});

Deno.test("ingress: 1 MiB cap for Actions, 25 MiB for the rest", async () => {
  const { h } = handler();
  const big = { action: "opened", pad: "x".repeat(MAX_ACTIONS_BODY + 10) };
  assertEquals((await h(await req(big, { event: "workflow_job", id: "b1" }))).status, 413);
  assertEquals((await h(await req(big, { event: "issues", id: "b2" }))).status, 202);
});

Deno.test("ingress: no secret configured refuses everything", async () => {
  const { h, rejects } = handler({ secrets: () => [] });
  assertEquals((await h(await req(jobPayload()))).status, 401);
  assertEquals(rejects, ["no-secret"]);
});
