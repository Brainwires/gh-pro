// The hub's settings: `<config>/settings.json`, written by the user (or `gh pro`), read at start.
// Webhook paths are not here: they live in the database's `hooks` table, managed through
// `gh pro hub webhook setup` (the admin API), because the hub updates them (hook ids, delivery
// times). Runtime facts (socket, pid) are `<state>/hub.json`. Everything is validated; unknown
// keys are ignored, a bad value falls back to its default with a warning.

export interface RetentionSettings {
  readonly payloadDays: number;
  readonly payloadMaxMB: number;
  readonly eventDays: number;
  /** Derived `problems` and `agent` events. */
  readonly problemDays: number;
  readonly deliveryDays: number;
  readonly writeDays: number;
}

export interface HubSettings {
  readonly v: 1;
  /** GitHub's ingress (POST /github/hooks only). */
  readonly ingressPort: number;
  /** The loopback client API (HTTP / SSE / WebSocket). */
  readonly apiPort: number;
  /**
   * Also append verified workflow_job / workflow_run deliveries to `<spoolDir>/events.jsonl`, in
   * Fleet's spool format, for a runner scheduler that reads it. `null`: off.
   */
  readonly spoolDir: string | null;
  readonly retention: RetentionSettings;
  /** Counted (non-304) sync requests an hour, backfills included. */
  readonly syncCapPerHour: number;
  readonly heartbeatSeconds: number;
  /** The `mcp` client token gets write:projects / write:issues when first created. */
  readonly mcpAgentWrites: boolean;
  /** Health check interval per hook (ping + deliveries list), minutes. */
  readonly healthMinutes: number;
}

export const DEFAULT_SETTINGS: HubSettings = {
  v: 1,
  ingressPort: 8789,
  apiPort: 8790,
  spoolDir: null,
  retention: {
    payloadDays: 7,
    payloadMaxMB: 1024,
    eventDays: 90,
    problemDays: 365,
    deliveryDays: 14,
    writeDays: 90,
  },
  syncCapPerHour: 1200,
  heartbeatSeconds: 60,
  mcpAgentWrites: false,
  healthMinutes: 15,
};

const int = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;

/** Settings from parsed JSON; `warnings` names every value that fell back. */
export function validateSettings(raw: unknown): { settings: HubSettings; warnings: string[] } {
  const warnings: string[] = [];
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const pick = (k: string, v: unknown, ok: unknown, fallback: unknown) => {
    if (v === undefined) return fallback;
    if (ok === null) {
      warnings.push(`${k}: invalid, using ${JSON.stringify(fallback)}`);
      return fallback;
    }
    return ok;
  };
  const port = (k: "ingressPort" | "apiPort") => pick(k, r[k], int(r[k], 1, 65535), d[k]) as number;
  const ret = (r.retention && typeof r.retention === "object" ? r.retention : {}) as Record<
    string,
    unknown
  >;
  const retention = Object.fromEntries(
    Object.entries(d.retention).map(([k, def]) => [
      k,
      pick(`retention.${k}`, ret[k], int(ret[k], 1, 100_000), def),
    ]),
  ) as unknown as RetentionSettings;
  const spool = r.spoolDir;
  const settings: HubSettings = {
    v: 1,
    ingressPort: port("ingressPort"),
    apiPort: port("apiPort"),
    spoolDir: pick(
      "spoolDir",
      spool,
      spool === null || (typeof spool === "string" && spool.length < 1024) ? spool : null,
      d.spoolDir,
    ) as string | null,
    retention,
    syncCapPerHour: pick(
      "syncCapPerHour",
      r.syncCapPerHour,
      int(r.syncCapPerHour, 10, 5000),
      d.syncCapPerHour,
    ) as number,
    heartbeatSeconds: pick(
      "heartbeatSeconds",
      r.heartbeatSeconds,
      int(r.heartbeatSeconds, 5, 3600),
      d.heartbeatSeconds,
    ) as number,
    mcpAgentWrites: pick(
      "mcpAgentWrites",
      r.mcpAgentWrites,
      typeof r.mcpAgentWrites === "boolean" ? r.mcpAgentWrites : null,
      d.mcpAgentWrites,
    ) as boolean,
    healthMinutes: pick(
      "healthMinutes",
      r.healthMinutes,
      int(r.healthMinutes, 1, 1440),
      d.healthMinutes,
    ) as number,
  };
  if (settings.ingressPort === settings.apiPort) {
    warnings.push("ingressPort and apiPort must differ: using the defaults");
    return { settings: { ...settings, ingressPort: d.ingressPort, apiPort: d.apiPort }, warnings };
  }
  return { settings, warnings };
}

/** `~/` expanded against HOME. */
export function expandHome(p: string, home: string | null): string {
  return p.startsWith("~/") && home ? `${home}${p.slice(1)}` : p;
}

export async function loadSettings(
  path: string,
): Promise<{ settings: HubSettings; warnings: string[] }> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      return { settings: DEFAULT_SETTINGS, warnings: [`${path}: not valid JSON, using defaults`] };
    }
  }
  return validateSettings(raw);
}
