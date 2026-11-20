// A real hub on temp folders and random loopback ports (no GitHub: a fake fetch), driven through
// its Unix socket, its TCP listener, its ingress and `gh pro watch`'s loop.

import { assert, assertEquals } from "@std/assert";
import { startHub } from "../hub/daemon.ts";
import { createApi } from "../hub/api.ts";
import { signBody } from "../hub/ingress.ts";
import { HubClient, readToken } from "../shared/client.ts";
import type { WireMessage } from "../shared/protocol.ts";
import { watch } from "../cli/watch.ts";
import {
  fakeFetch,
  fakeToken,
  jobPayload,
  runPayload,
  tempPaths,
  testSettings,
} from "./helpers.ts";

async function hub() {
  const paths = await tempPaths();
  const { fetch } = fakeFetch({});
  // The hub's clock is real here (the ingress's replay window compares payload times with it).
  const h = await startHub({
    paths,
    settings: testSettings(),
    token: fakeToken(),
    fetch,
    quiet: true,
  });
  const cli = await HubClient.open({ paths });
  return {
    h,
    paths,
    cli,
    async done() {
      cli.close();
      await h.stop();
      await paths.cleanup();
    },
  };
}

async function deliver(port: number, secret: string, event: string, id: string, payload: unknown) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const r = await fetch(`http://127.0.0.1:${port}/github/hooks`, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": id,
      "x-hub-signature-256": await signBody(secret, body),
    },
  });
  await r.body?.cancel();
  return r.status;
}

const fresh = (o: Record<string, unknown> = {}) => {
  const t = new Date().toISOString();
  return jobPayload({ created_at: t, started_at: t, completed_at: t, ...o });
};

async function until<T>(fn: () => Promise<T | null> | T | null, ms = 3000): Promise<T> {
  for (let t = 0; t < ms; t += 20) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

Deno.test("hub e2e: socket + TCP hello, tokens and scopes enforced, loopback-only TCP", async () => {
  const t = await hub();
  try {
    const hello = await t.cli.get("/v1/hello");
    assertEquals(hello.client, "cli");
    assertEquals(hello.search, "fts5");
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(t.paths.socket)).mode! & 0o777, 0o600);
    }
    const tcp = await HubClient.open({ paths: t.paths, tcp: true });
    assertEquals((await tcp.get("/v1/hello")).version, hello.version);
    tcp.close();
    const mcp = await HubClient.open({ paths: t.paths, client: "mcp" });
    let status = 0;
    await mcp.get("/v1/admin/status").catch((e) => (status = e.status));
    assertEquals(status, 403, "mcp has read only");
    mcp.close();
    const api = createApi(t.h.services)("tcp");
    const token = await readToken(t.paths, "cli");
    const evil = await api(
      new Request("http://x/v1/hello", {
        headers: { host: "evil.example", authorization: `Bearer ${token}` },
      }),
    );
    assertEquals(evil.status, 403);
    const origin = await api(
      new Request("http://x/v1/hello", {
        headers: {
          host: "127.0.0.1:1",
          origin: "https://evil.example",
          authorization: `Bearer ${token}`,
        },
      }),
    );
    assertEquals(origin.status, 403);
    const bad = await api(
      new Request("http://x/v1/hello", {
        headers: { host: "127.0.0.1:1", authorization: "Bearer ghpro.nope" },
      }),
    );
    assertEquals(bad.status, 401);
    const qtok = await api(
      new Request(`http://x/v1/hello?token=${token}`, { headers: { host: "localhost" } }),
    );
    assertEquals(qtok.status, 401, "?token= only on stream endpoints");
    await Promise.all([evil, origin, bad, qtok].map((r) => r.body?.cancel()));
  } finally {
    await t.done();
  }
});

Deno.test("hub e2e: webhook path → signed delivery through the ingress → event, state, payload", async () => {
  const t = await hub();
  try {
    const setup = await t.cli.post("/v1/admin/webhooks", { target: "acme", mode: "forward" });
    assertEquals(setup.mode, "forward");
    assert((setup.notes as string[]).some((n) => n.includes("testing")));
    const secret = (await Deno.readTextFile(`${t.paths.state}/ingress-secret`)).trim();
    assertEquals(await deliver(t.h.ingressPort, "w".repeat(40), "workflow_job", "x", fresh()), 401);
    assertEquals(
      await deliver(
        t.h.ingressPort,
        secret,
        "workflow_run",
        "r1",
        runPayload({ updated_at: new Date().toISOString() }),
      ),
      202,
    );
    assertEquals(await deliver(t.h.ingressPort, secret, "workflow_job", "j1", fresh()), 202);
    assertEquals(
      await deliver(t.h.ingressPort, secret, "workflow_job", "j1", fresh()),
      202,
      "a duplicate is acknowledged",
    );
    const page = await until(async () => {
      const p = await t.cli.get<{ events: { kind: string; sev: string; payload_ref?: string }[] }>(
        "/v1/events?since=0&kind=actions.*",
      );
      return p.events.length >= 2 ? p : null;
    });
    assertEquals(page.events.map((e) => e.kind), [
      "actions.run.completed",
      "actions.job.completed",
    ]);
    assertEquals(page.events[1].sev, "bad");
    const health = await t.cli.get<{ events: { kind: string }[] }>(
      "/v1/events?since=0&derived=health",
    );
    assertEquals(health.events.map((e) => e.kind), ["hub.health.live"], "first delivery: live");
    const runs = await t.cli.get<{ runs: { id: number }[] }>("/v1/state/actions/runs?repo=web");
    assertEquals(runs.runs.map((r) => r.id), [7]);
    const full = await t.cli.get<{ events: { payload: { workflow_job: { id: number } } }[] }>(
      "/v1/events?since=0&kind=actions.job.completed&payload=full",
    );
    assertEquals(full.events[0].payload.workflow_job.id, 11);
    const status = await t.cli.get("/v1/admin/status");
    assertEquals((status.webhooks as { target: string; state: string }[])[0].state, "live");
    // Scope: refused without a covering path, accepted with one.
    let err = "";
    await t.cli.post("/v1/subscriptions/scope", { owners: ["other"] }).catch((
      e,
    ) => (err = e.message));
    assert(err.includes("webhook setup other"), err);
    assertEquals((await t.cli.post("/v1/subscriptions/scope", { repos: ["acme/web"] })).added, [
      "acme/web",
    ]);
  } finally {
    await t.done();
  }
});

Deno.test("hub e2e: SSE replay then live, filtered; `gh pro watch` prints and resumes from its last seq", async () => {
  const t = await hub();
  try {
    await t.cli.post("/v1/admin/webhooks", { target: "acme", mode: "forward" });
    const secret = (await Deno.readTextFile(`${t.paths.state}/ingress-secret`)).trim();
    await deliver(t.h.ingressPort, secret, "workflow_job", "a", fresh());
    await deliver(
      t.h.ingressPort,
      secret,
      "workflow_job",
      "b",
      fresh({ conclusion: "success", id: 12 }),
    );
    await until(
      async () => ((await t.cli.get<{ events: unknown[] }>("/v1/events?since=0&kind=actions.*"))
          .events.length ===
          2
        ? true
        : null),
    );

    const got: WireMessage[] = [];
    const ac = new AbortController();
    const q = new URLSearchParams({ since: "0", derived: "problems" });
    const reading = t.cli.stream(q, (m) => got.push(m), ac.signal);
    await until(() => got.some((m) => m.type === "event") ? true : null);
    await deliver(t.h.ingressPort, secret, "workflow_job", "c", fresh({ id: 13 }));
    await deliver(
      t.h.ingressPort,
      secret,
      "workflow_job",
      "d",
      fresh({ id: 14, conclusion: "success" }),
    );
    await until(() => got.filter((m) => m.type === "event").length >= 2 ? true : null);
    ac.abort();
    await reading;
    const evs = got.filter((m) => m.type === "event") as { seq: number; sev: string }[];
    assertEquals(got[0].type, "hello");
    assertEquals(evs.map((e) => e.sev), ["bad", "bad"], "the ok jobs are filtered out");
    // seq 1 is the path's health event (live), 2–5 the four jobs.
    assertEquals(evs.map((e) => e.seq), [2, 4]);

    // watch: prints one line per event; started at since=2 it gets seq 4 only (problems).
    const lines: string[] = [];
    const wac = new AbortController();
    const code = watch(
      { filter: { derived: ["problems"] }, since: "2", json: false, status: false, client: "cli" },
      {
        out: (l) => {
          lines.push(l);
          if (l.includes("#4")) wac.abort();
        },
        err: () => {},
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        signal: wac.signal,
        paths: t.paths,
      },
    );
    assertEquals(await code, 0);
    assert(lines[0].startsWith("hub "), lines[0]);
    assert(
      lines.some((l) =>
        /✕ #4 actions\.job\.completed acme\/web: job "build \(linux\)" failure at step "Run tests"/
          .test(l)
      ),
      lines.join("\n"),
    );
  } finally {
    await t.done();
  }
});

Deno.test("hub e2e: a revoked token is refused (watch exits 3); stop removes the runtime file", async () => {
  const t = await hub();
  try {
    await t.cli.post("/v1/admin/tokens", { name: "bot", scopes: "read", agent: true });
    const bot = (await Deno.readTextFile(`${t.paths.tokens}/bot.token`)).trim();
    await t.cli.del("/v1/admin/tokens/bot");
    const code = await watch(
      { filter: {}, since: null, json: true, status: false, client: "bot" },
      {
        out: () => {},
        err: () => {},
        sleep: () => Promise.resolve(),
        paths: t.paths,
        open: () => HubClient.open({ paths: t.paths, token: bot }),
      },
    );
    assertEquals(code, 3);
  } finally {
    await t.done();
  }
  let gone = false;
  await Deno.stat(t.paths.runtime).catch(() => (gone = true));
  assert(gone);
});
