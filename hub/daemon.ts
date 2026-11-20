// The hub daemon (`gh pro hub run`): wires storage, ingress, health, reconciliation, the sync engine
// and the client API, and runs until SIGINT / SIGTERM or `POST /v1/admin/stop`.
//
// Listeners (design §3): the ingress on 127.0.0.1:<ingressPort> (POST /github/hooks only); the
// client API on the Unix socket (or a named pipe on Windows) and 127.0.0.1:<apiPort>. Never a
// wildcard address. `<state>/hub.json` tells clients where it is.

import { type HubEvent, type NewEvent } from "../shared/events.ts";
import {
  ensurePrivateDir,
  type HubPaths,
  hubPaths,
  type RuntimeInfo,
  writePrivateFile,
} from "../shared/paths.ts";
import { VERSION } from "../shared/version.ts";
import { createApi, type HubServices } from "./api.ts";
import { Budget } from "./budget.ts";
import { getMeta, openHubDb, setMeta } from "./db.ts";
import { Forwarders } from "./forward.ts";
import { GapStore } from "./gaps.ts";
import { findGh, ghTokenProvider, GitHub, missingScopes, type TokenProvider } from "./github.ts";
import { HealthMonitor } from "./health.ts";
import { hooksApiPath, HookStore, readSecret } from "./hooks.ts";
import { appendSpool, createIngressHandler, HOOK_HOST, type IngressDelivery } from "./ingress.ts";
import { EventLog } from "./log.ts";
import { HubLogger } from "./logger.ts";
import { normalize } from "./normalize.ts";
import { ExpectedRedeliveries, Reconciler } from "./reconcile.ts";
import { dbBytes, prune } from "./retention.ts";
import { SearchIndex } from "./search.ts";
import { expandHome, type HubSettings, loadSettings } from "./settings.ts";
import { StreamHub } from "./stream.ts";
import { SyncEngine } from "./sync.ts";
import { TokenStore } from "./tokens.ts";
import { FORWARD_NOTES, setupWebhook } from "./webhooks.ts";

export const ALIVE_EVERY_MS = 60_000;
export const PRUNE_EVERY_MS = 3_600_000;
/** Hub downtime shorter than this opens no gap (a quick restart, an upgrade). */
export const DOWNTIME_GAP_MS = 2 * 60_000;

export interface HubOptions {
  readonly paths?: HubPaths;
  readonly settings?: HubSettings;
  /** Echo the log to stderr (foreground runs). */
  readonly echo?: boolean;
  /** Tests: a token provider and fetch instead of `gh` and the network. */
  readonly token?: TokenProvider;
  readonly fetch?: typeof fetch;
  /** Tests: no forwarder children, no timers. */
  readonly quiet?: boolean;
  readonly now?: () => number;
}

export interface RunningHub {
  readonly services: HubServices;
  readonly paths: HubPaths;
  readonly settings: HubSettings;
  readonly ingressPort: number;
  readonly apiPort: number;
  /** Feed a delivery as the ingress would after verifying it (tests). */
  readonly ingest: (d: IngressDelivery) => Promise<HubEvent[]>;
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

async function socketAnswers(path: string): Promise<boolean> {
  try {
    const c = await Deno.connect({ transport: "unix", path });
    c.close();
    return true;
  } catch {
    return false;
  }
}

export async function startHub(o: HubOptions = {}): Promise<RunningHub> {
  const paths = o.paths ?? hubPaths();
  const now = o.now ?? Date.now;
  await ensurePrivateDir(paths.state);
  if (paths.config !== paths.state) await ensurePrivateDir(paths.config);
  const loaded = o.settings
    ? { settings: o.settings, warnings: [] }
    : await loadSettings(paths.settings);
  const settings = loaded.settings;
  const logger = new HubLogger(paths.log, o.echo ?? false);
  for (const w of loaded.warnings) logger.line(`settings: ${w}`);

  const hdb = openHubDb(paths.db);
  const db = hdb.db;
  const log = new EventLog(db, now);
  const tokens = new TokenStore(db, paths.tokens, now);
  const made = await tokens.ensureDefaults(settings.mcpAgentWrites);
  if (made.length) logger.line(`client tokens created: ${made.join(", ")}`);
  const budget = new Budget(settings.syncCapPerHour, now);
  const gh = new GitHub({ token: o.token ?? ghTokenProvider(), budget, db, fetch: o.fetch, now });
  const hooks = new HookStore(db, now);
  const gaps = new GapStore(db, now);
  const search = new SearchIndex(db, hdb.searchMode);
  const sync = new SyncEngine(db, gh, log, hooks, now, (l) => logger.line(l));
  const expected = new ExpectedRedeliveries(now);
  let reconciler: Reconciler | null = null;
  const health = new HealthMonitor({
    hooks,
    gh,
    log,
    gaps,
    intervalMs: settings.healthMinutes * 60_000,
    now,
    onReconcile: (t) =>
      void reconciler?.reconcileTarget(t).catch((e) => logger.line(`reconcile ${t}: ${e}`)),
    onLog: (l) => logger.line(l),
  });
  reconciler = new Reconciler({
    gh,
    hooks,
    gaps,
    log,
    sync,
    health,
    expected,
    now,
    onLog: (l) => logger.line(l),
  });

  // Secrets for the ingress, re-resolved when paths change.
  let secrets: string[] = [];
  const secretOf = new Map<string, string>();
  const refreshSecrets = async () => {
    secretOf.clear();
    for (const p of hooks.list()) {
      const s = await readSecret(p.secret);
      if (s) secretOf.set(p.target, s);
      else logger.line(`webhook ${p.target}: its secret can't be read`);
    }
    secrets = [...new Set(secretOf.values())];
  };
  await refreshSecrets();

  const stream: StreamHub = new StreamHub({
    log,
    version: VERSION,
    heartbeatMs: settings.heartbeatSeconds * 1000,
    status: () => ({
      type: "status",
      at: new Date(now()).toISOString(),
      last_seq: log.lastSeq(),
      hooks: health.states(),
      clients: stream.size,
    }),
    payload: (ref) => log.payload(ref),
  });
  log.onAppend((events) => stream.publish(events));

  const spoolDir = settings.spoolDir
    ? expandHome(settings.spoolDir, Deno.env.get("HOME") ?? null)
    : null;

  /** A verified delivery → payload, de-dupe, state, event, spool. */
  const ingest = async (d: IngressDelivery): Promise<HubEvent[]> => {
    if (!log.rememberDelivery(d.id, d.receivedAt, d.hookId, d.event)) return [];
    const ref = await log.storePayload(d.id, d.event, d.receivedAt, d.body);
    sync.applyWebhook(d.event, d.payload);
    const ev: NewEvent = normalize(
      {
        id: d.id,
        event: d.event,
        receivedAt: d.receivedAt,
        payload: d.payload,
        redelivery: d.redelivery,
        payloadRef: ref,
      },
      { runUntrusted: (id) => sync.runUntrusted(id) },
    );
    const path = hooks.forDelivery(d.hookId, ev.repo, ev.owner);
    if (path && path.hookId === null && d.hookId !== null && path.mode === "forward") {
      hooks.setHookId(path.target, d.hookId);
    }
    health.onVerified(path?.target ?? null, d.event, d.receivedAt);
    const out = log.append([ev]);
    if (spoolDir) await appendSpool(d, spoolDir).catch((e) => logger.line(`spool: ${e}`));
    return out;
  };

  const ingressHandler = createIngressHandler({
    secrets: () => secrets,
    isKnown: (id) => log.seenDelivery(id),
    expectedRedelivery: (id) => expected.take(id),
    onDelivery: (d) => void ingest(d).catch((e) => logger.line(`ingest ${d.event} ${d.id}: ${e}`)),
    onVerified: (event, hookId, at) => {
      if (event !== "ping") return;
      const byId = hookId !== null ? hooks.byHookId(hookId) : null;
      const all = hooks.list();
      health.onVerified(byId?.target ?? (all.length === 1 ? all[0].target : null), "ping", at);
    },
    onReject: (why) => logger.line(`ingress: rejected (${why})`),
    now,
  });

  const ghPath = await findGh();
  const forwarders = new Forwarders({
    gh: ghPath,
    get ingressPort() {
      return bound.ingress;
    },
    api: gh,
    secretFor: (t) => Promise.resolve(secretOf.get(t) ?? null),
    onExit: (t, why) => health.forwarderExited(t, why),
    onStart: (t) => health.forwarderStarted(t),
    onHookId: (t, id) => {
      if (id !== null) hooks.setHookId(t, id);
      logger.line(`forwarder ${t}: hook id ${id ?? "not listed"}`);
    },
    log: (l) => logger.line(l),
  });

  const startedAt = now();
  /** The bound ports (settings may say 0: any free port). */
  const bound = { ingress: settings.ingressPort, api: settings.apiPort };
  let stopping: Promise<void> | null = null;
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => (resolveFinished = r));

  const services: HubServices = {
    version: VERSION,
    log,
    tokens,
    stream,
    sync,
    search,
    hello: () => ({
      version: VERSION,
      api: 1,
      last_seq: log.lastSeq(),
      oldest_seq: log.oldestSeq(),
      ingress: health.states(),
      scope: sync.scopeList().map((s) => ({
        target: s.target,
        backfilled: s.backfilled_at !== null,
      })),
      budget: budget.snapshot(),
      gh_scopes: gh.scopes,
      search: search.mode,
    }),
    status: () => ({
      version: VERSION,
      pid: Deno.pid,
      started_at: new Date(startedAt).toISOString(),
      uptime_s: Math.round((now() - startedAt) / 1000),
      ports: { ...bound },
      socket: paths.socket,
      state_dir: paths.state,
      webhooks: services.webhooks(),
      gaps: { open: gaps.listOpen(), recent: gaps.recent(10) },
      budget: budget.snapshot(),
      gh_scopes: gh.scopes,
      missing_scopes: missingScopes(gh.scopes),
      scope: sync.scopeList(),
      db: {
        bytes: dbBytes(db),
        events: log.count(),
        last_seq: log.lastSeq(),
        oldest_seq: log.oldestSeq(),
        search: search.mode,
      },
      clients: tokens.list(),
      streams: stream.size,
      settings_warnings: loaded.warnings,
    }),
    addScope: (targets, by) => {
      const added: string[] = [];
      const existing: string[] = [];
      for (const t of targets) (sync.addScope(t, by) ? added : existing).push(t);
      for (const t of added) {
        void sync.backfill(t).catch((e) => logger.line(`backfill ${t}: ${e}`));
      }
      return Promise.resolve({ added, existing });
    },
    setupWebhook: async (req) => {
      const r = await setupWebhook(req, {
        hooks,
        gh,
        secretFile: `${paths.state}/ingress-secret`,
        ingressPort: bound.ingress,
      });
      await refreshSecrets();
      if (r.path.mode === "forward" && !o.quiet) {
        const err = await forwarders.ensureExtension().catch((e) => String(e));
        if (err) r.notes.push(`gh-webhook extension: ${err}`);
        const why = forwarders.start(r.path.target, r.path.events);
        if (why) r.notes.push(why);
      } else forwarders.stop(r.path.target);
      return r;
    },
    removeWebhook: (t) => {
      forwarders.stop(t);
      const ok = hooks.remove(t);
      void refreshSecrets();
      return ok;
    },
    webhooks: () =>
      hooks.list().map((p) => {
        const h = health.detail(p.target);
        const fw = forwarders.running().find((f) => f.target === p.target);
        return {
          target: p.target,
          mode: p.mode,
          hook_id: p.hookId,
          url: p.url,
          events: p.events,
          secret: p.secret.source,
          state: h.state,
          since: h.since ? new Date(h.since).toISOString() : null,
          reason: h.reason,
          last_delivery_at: p.lastDeliveryAt ? new Date(p.lastDeliveryAt).toISOString() : null,
          last_ping_at: p.lastPingAt ? new Date(p.lastPingAt).toISOString() : null,
          last_reconciled_at: p.lastReconciledAt
            ? new Date(p.lastReconciledAt).toISOString()
            : null,
          forwarder: fw ? { pid: fw.pid, error: fw.error } : undefined,
          notes: p.mode === "forward" ? [FORWARD_NOTES.at(-1)] : undefined,
        };
      }),
    testWebhook: async (target) => {
      const p = hooks.get(target);
      if (!p) throw new Error(`no webhook path for ${target}`);
      if (p.hookId === null) {
        throw new Error("the hook id isn't known yet (a forwarder that just started?)");
      }
      const before = p.lastPingAt;
      await gh.request("POST", `${hooksApiPath(p.target)}/${p.hookId}/pings`, {
        priority: 0,
        reason: "health",
      });
      const sent = now();
      // Wait for the ping on our own ingress (local state, not GitHub polling).
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const at = hooks.get(target)?.lastPingAt ?? null;
        if (at !== null && at !== before) {
          return `ping arrived after ${at - sent} ms: live end to end`;
        }
      }
      return "no ping within 30 s: check the tunnel / forwarder (gh pro hub logs)";
    },
    reconcile: (since) => reconciler!.reconcileAll(since),
    logTail: (n) => logger.tail(n),
    payload: (ref) => log.payload(ref),
    stop: () => void stop(),
  };

  // ---- listeners ----
  const servers: Deno.HttpServer[] = [];
  const onError = (e: unknown) => {
    logger.line(`http: ${e instanceof Error ? e.message : e}`);
    return new Response("internal error", { status: 500 });
  };
  const ingressServer = Deno.serve(
    { hostname: HOOK_HOST, port: settings.ingressPort, onListen() {}, onError },
    ingressHandler,
  );
  servers.push(ingressServer);
  const api = createApi(services);
  const apiServer = Deno.serve({
    hostname: "127.0.0.1",
    port: settings.apiPort,
    onListen() {},
    onError,
  }, api("tcp"));
  servers.push(apiServer);
  let pipe: { close(): Promise<void> } | null = null;
  if (Deno.build.os === "windows") {
    const { startPipeBridge } = await import("./pipe.ts");
    pipe = await startPipeBridge(paths.socket, apiServer.addr.port).catch((e) => {
      logger.line(`named pipe: ${e}`);
      return null;
    });
  } else {
    const dir = paths.socket.replace(/\/[^/]+$/, "");
    await ensurePrivateDir(dir);
    if (await socketAnswers(paths.socket)) {
      await Promise.all(servers.map((s) => s.shutdown()));
      hdb.close();
      throw new Error(`another hub answers on ${paths.socket}`);
    }
    await Deno.remove(paths.socket).catch(() => {});
    servers.push(Deno.serve({ path: paths.socket, onListen() {}, onError }, api("unix")));
    await Deno.chmod(paths.socket, 0o600);
  }
  const ingressPort = (ingressServer.addr as Deno.NetAddr).port;
  const apiPort = (apiServer.addr as Deno.NetAddr).port;
  bound.ingress = ingressPort;
  bound.api = apiPort;
  const runtime: RuntimeInfo = {
    socket: paths.socket,
    port: apiPort,
    ingress_port: ingressPort,
    pid: Deno.pid,
    version: VERSION,
    started_at: new Date(startedAt).toISOString(),
  };
  await writePrivateFile(paths.runtime, JSON.stringify(runtime, null, 2) + "\n");
  logger.line(
    `hub ${VERSION} up: ingress 127.0.0.1:${ingressPort}, api 127.0.0.1:${apiPort}, socket ${paths.socket}`,
  );

  // ---- downtime gap, timers, forwarders ----
  const lastAlive = Number(getMeta(db, "last_alive_at") ?? 0);
  setMeta(db, "last_alive_at", String(now()));
  const timers: ReturnType<typeof setInterval>[] = [];
  if (!o.quiet) {
    if (lastAlive && now() - lastAlive > DOWNTIME_GAP_MS && hooks.list().length) {
      health.hubWasDown(lastAlive);
      logger.line(`hub was down since ${new Date(lastAlive).toISOString()}: gaps opened`);
      for (const p of hooks.list()) {
        // Tunnel / relay paths reconcile now; forward paths once their child is up.
        if (p.mode !== "forward") void reconciler.reconcileTarget(p.target).catch(() => {});
      }
    }
    timers.push(setInterval(() => setMeta(db, "last_alive_at", String(now())), ALIVE_EVERY_MS));
    timers.push(setInterval(() => {
      try {
        const r = prune(db, settings.retention, now());
        logger.line(`prune: ${JSON.stringify(r)}`);
      } catch (e) {
        logger.line(`prune: ${e}`);
      }
    }, PRUNE_EVERY_MS));
    health.start();
    const fwPaths = hooks.list().filter((p) => p.mode === "forward");
    if (fwPaths.length) {
      const err = await forwarders.ensureExtension().catch((e) => String(e));
      if (err) logger.line(`gh-webhook extension: ${err}`);
      for (const p of fwPaths) {
        const why = forwarders.start(p.target, p.events);
        if (why) logger.line(`forwarder ${p.target}: ${why}`);
      }
    }
    void gh.request("GET", "/rate_limit", { priority: 1, reason: "health", noCache: true }).catch((
      e,
    ) => logger.line(`GitHub: ${e instanceof Error ? e.message : e}`));
  }

  async function stop(): Promise<void> {
    stopping ??= (async () => {
      logger.line("hub stopping");
      stream.restarting();
      forwarders.stopAll();
      health.stop();
      for (const t of timers) clearInterval(t);
      try {
        setMeta(db, "last_alive_at", String(now()));
      } catch {
        // Closed.
      }
      await Promise.all(servers.map((s) => s.shutdown().catch(() => {})));
      await pipe?.close().catch(() => {});
      if (Deno.build.os !== "windows") await Deno.remove(paths.socket).catch(() => {});
      await Deno.remove(paths.runtime).catch(() => {});
      await logger.flush();
      hdb.close();
      resolveFinished();
    })();
    return await stopping;
  }

  return { services, paths, settings, ingressPort, apiPort, ingest, finished, stop };
}

/** `gh pro hub run`: start, stop on signals, resolve when stopped. */
export async function runHub(o: HubOptions = {}): Promise<void> {
  const hub = await startHub(o);
  const onSignal = () => void hub.stop();
  Deno.addSignalListener("SIGINT", onSignal);
  if (Deno.build.os !== "windows") Deno.addSignalListener("SIGTERM", onSignal);
  await hub.finished;
}
