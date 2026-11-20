// Test helpers: a fake GitHub (routes → responses, every call recorded), temp hub folders, fixtures.

import type { HubPaths } from "../shared/paths.ts";
import { hubPaths } from "../shared/paths.ts";
import { DEFAULT_SETTINGS, type HubSettings } from "../hub/settings.ts";
import { Budget } from "../hub/budget.ts";
import { GitHub, type TokenProvider } from "../hub/github.ts";

export const NOW = Date.parse("2026-11-16T12:00:00Z");

export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/** A fetch that answers from `routes` keyed by "METHOD path?query" (or just "path?query" for GET). */
export function fakeFetch(
  routes: Record<string, Route | ((s: Seen) => Route)>,
  base = "https://api.github.com",
) {
  const seen: Seen[] = [];
  const f = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const s: Seen = {
      method,
      url,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    const r0 = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
    const r = typeof r0 === "function" ? r0(s) : r0;
    if (!r) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      );
    }
    return Promise.resolve(
      new Response(r.status === 304 || r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
        status: r.status ?? 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "4000",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3600),
          "x-ratelimit-resource": "core",
          ...r.headers,
        },
      }),
    );
  };
  return { fetch: f as typeof fetch, seen };
}

export const fakeToken = (t = "t".repeat(40)): TokenProvider & { invalidated: number } => {
  const p = {
    invalidated: 0,
    get: () => Promise.resolve(t),
    invalidate() {
      p.invalidated++;
    },
  };
  return p;
};

export function fakeGitHub(routes: Record<string, Route | ((s: Seen) => Route)>, now = () => NOW) {
  const { fetch, seen } = fakeFetch(routes);
  const budget = new Budget(1200, now);
  const gh = new GitHub({ token: fakeToken(), budget, fetch, now });
  return { gh, seen, budget };
}

/** A fresh temp hub home (state + settings in one folder). */
export async function tempPaths(): Promise<HubPaths & { cleanup: () => Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "ghpro-" });
  const env = { get: (k: string) => (k === "GH_PRO_HOME" ? dir : Deno.env.get(k)) };
  const paths = hubPaths(Deno.build.os, env, Deno.uid());
  return { ...paths, cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}) };
}

/** Settings on random free ports. */
export function testSettings(over: Partial<HubSettings> = {}): HubSettings {
  return { ...DEFAULT_SETTINGS, ingressPort: 0, apiPort: 0, heartbeatSeconds: 3600, ...over };
}

export function jobPayload(over: Record<string, unknown> = {}, action = "completed") {
  return {
    action,
    repository: { full_name: "acme/web", owner: { login: "acme" } },
    organization: { login: "acme" },
    sender: { login: "jo", type: "User" },
    workflow_job: {
      id: 11,
      run_id: 7,
      name: "build (linux)",
      workflow_name: "CI",
      head_branch: "main",
      head_sha: "abc1234def",
      status: action === "completed" ? "completed" : action,
      conclusion: action === "completed" ? "failure" : null,
      labels: ["self-hosted", "linux"],
      runner_name: "r1",
      created_at: new Date(NOW - 60_000).toISOString(),
      started_at: new Date(NOW - 50_000).toISOString(),
      completed_at: action === "completed" ? new Date(NOW - 1000).toISOString() : null,
      steps: [
        { name: "Checkout", conclusion: "success" },
        { name: "Run tests", conclusion: "failure" },
      ],
      ...over,
    },
  };
}

export function runPayload(over: Record<string, unknown> = {}, action = "completed") {
  return {
    action,
    repository: { full_name: "acme/web", owner: { login: "acme" } },
    sender: { login: "jo", type: "User" },
    workflow_run: {
      id: 7,
      name: "CI",
      run_number: 42,
      display_title: "Fix the thing",
      event: "push",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: "abc1234def",
      head_repository: { full_name: "acme/web" },
      created_at: new Date(NOW - 120_000).toISOString(),
      updated_at: new Date(NOW - 1000).toISOString(),
      html_url: "https://github.com/acme/web/actions/runs/7",
      ...over,
    },
  };
}
