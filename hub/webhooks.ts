// Webhook path setup (design §5): `gh pro hub webhook setup <target> [--mode forward|tunnel|relay]`.
//
// - forward (default): records the path with a generated file secret; the forwarder supervisor runs
//   `gh webhook forward` for it.
// - tunnel / relay: the public URL that reaches 127.0.0.1:<ingress>/github/hooks. The hub creates or
//   updates the org / repo webhook through the API (event list, JSON, the secret), or adopts an
//   existing hook by id (`--hook-id`, events left as they are unless `--update-events`), then pings it.
//   Returns the tunnel snippet that passes only `POST /github/hooks`.

import { type GitHub, GitHubError } from "./github.ts";
import {
  ensureFileSecret,
  type HookMode,
  type HookPath,
  hooksApiPath,
  type HookStore,
  parseTarget,
  readSecret,
  type SecretRef,
} from "./hooks.ts";
import { HOOK_EVENTS } from "./normalize.ts";

export interface SetupRequest {
  readonly target: string;
  readonly mode: HookMode;
  /** Public URL (tunnel / relay). */
  readonly url?: string;
  readonly events?: readonly string[];
  /** Default: a generated file secret in the state folder. */
  readonly secret?: SecretRef;
  /** Adopt an existing hook. */
  readonly hookId?: number;
  /** With hookId: also set its events / URL / secret (otherwise only verified and pinged). */
  readonly updateEvents?: boolean;
}

export interface SetupResult {
  readonly path: HookPath;
  readonly notes: string[];
  readonly tunnelConfig?: string;
}

export function validEvents(list: readonly string[]): string | null {
  for (const e of list) {
    if (!/^[a-z_0-9]{1,60}$/.test(e)) return `bad event name ${JSON.stringify(e)}`;
  }
  return list.length ? null : "at least one event";
}

export const FORWARD_NOTES = [
  "gh webhook forward is GitHub's testing / development tool: not for production",
  'one forwarder per repo or org at a time: a second machine or teammate gets "Hook already exists"',
  "deliveries arrive only while this machine is awake and the hub runs; gaps are reconciled after",
  "for always-on delivery, set up a tunnel: gh pro hub webhook setup <target> --mode tunnel --url …",
];

/** The cloudflared ingress rule that passes only the hook route (others: adapt the same rule). */
export function tunnelSnippet(url: string, ingressPort: number): string {
  const host = new URL(url).hostname;
  return [
    "# cloudflared config.yml: only POST /github/hooks reaches the hub; everything else is 404",
    "ingress:",
    `  - hostname: ${host}`,
    "    path: ^/github/hooks$",
    `    service: http://127.0.0.1:${ingressPort}`,
    "  - service: http_status:404",
  ].join("\n");
}

export async function setupWebhook(
  req: SetupRequest,
  deps: { hooks: HookStore; gh: GitHub | null; secretFile: string; ingressPort: number },
): Promise<SetupResult> {
  const t = parseTarget(req.target);
  if (!t) throw new Error(`not an org or owner/repo: ${JSON.stringify(req.target)}`);
  const events = req.events?.length ? req.events : HOOK_EVENTS;
  const bad = validEvents(events);
  if (bad) throw new Error(bad);
  const secretRef = req.secret ?? await ensureFileSecret(deps.secretFile);
  const secret = await readSecret(secretRef);
  if (!secret) {
    throw new Error("the webhook secret can't be read (or is shorter than 32 characters)");
  }
  if (req.mode === "forward") {
    const path = deps.hooks.upsert({
      target: req.target,
      mode: "forward",
      url: null,
      events,
      secret: secretRef,
      hookId: null,
    });
    return { path, notes: FORWARD_NOTES };
  }
  if (!req.url || !/^https:\/\//.test(req.url)) {
    throw new Error("a tunnel or relay needs --url https://…");
  }
  if (new URL(req.url).pathname !== "/github/hooks") {
    throw new Error("the URL's path must be /github/hooks (the only route the ingress serves)");
  }
  const gh = deps.gh;
  if (!gh) throw new Error("no GitHub client (gh not signed in?)");
  const api = hooksApiPath(req.target);
  const body = {
    active: true,
    events,
    config: { url: req.url, content_type: "json", insecure_ssl: "0", secret },
  };
  let hookId: number;
  const notes: string[] = [];
  if (req.hookId !== undefined) {
    if (req.updateEvents) {
      await gh.request("PATCH", `${api}/${req.hookId}`, { priority: 0, reason: "write", body });
      notes.push(`updated hook ${req.hookId}: events, URL and secret`);
    } else {
      await gh.request("GET", `${api}/${req.hookId}`, {
        priority: 0,
        reason: "write",
        noCache: true,
      });
      notes.push(`adopted hook ${req.hookId} as it is (its events were not changed)`);
    }
    hookId = req.hookId;
  } else {
    const list = await gh.request<{ id: number; config?: { url?: string } }[]>(
      "GET",
      `${api}?per_page=100`,
      { priority: 0, reason: "write", noCache: true },
    );
    const had = list.data.find((h) => h.config?.url === req.url);
    if (had) {
      await gh.request("PATCH", `${api}/${had.id}`, { priority: 0, reason: "write", body });
      hookId = had.id;
      notes.push(`updated the existing hook ${had.id} for this URL`);
    } else {
      const made = await gh.request<{ id: number }>("POST", api, {
        priority: 0,
        reason: "write",
        body: { name: "web", ...body },
      });
      hookId = made.data.id;
      notes.push(`created hook ${hookId}`);
    }
  }
  const path = deps.hooks.upsert({
    target: req.target,
    mode: req.mode,
    url: req.url,
    events,
    secret: secretRef,
    hookId,
  });
  try {
    await gh.request("POST", `${api}/${hookId}/pings`, { priority: 1, reason: "health" });
    notes.push("ping sent: `gh pro hub webhook status` shows live once it arrives");
  } catch (e) {
    notes.push(`ping failed: ${e instanceof GitHubError ? e.message : String(e)}`);
  }
  if (req.mode === "relay") {
    notes.push("a relay sees your payloads in transit (signatures are still checked here)");
  }
  return {
    path,
    notes,
    tunnelConfig: req.mode === "tunnel" ? tunnelSnippet(req.url, deps.ingressPort) : undefined,
  };
}
