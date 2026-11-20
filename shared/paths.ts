// Where the hub keeps things (design §4), and the runtime file every client reads first (§3).
//
// - macOS: ~/Library/Application Support/dev.brainwires.ghpro/ (state and settings)
// - Linux: $XDG_STATE_HOME/gh-pro/ (state), $XDG_CONFIG_HOME/gh-pro/ (settings)
// - Windows: %LOCALAPPDATA%\gh-pro\ (both)
//
// `GH_PRO_HOME` puts state and settings in one folder instead: tests, and a second hub in shadow
// mode beside a live one (its own ports in its settings).

export const APP_ID = "dev.brainwires.ghpro";
export const SERVICE_LABEL = `${APP_ID}.hub`;
export const RUNTIME_FILE = "hub.json";
export const SETTINGS_FILE = "settings.json";
export const DB_FILE = "hub.db";
export const LOG_FILE = "hub.log";
export const TOKENS_DIR = "tokens";
export const SOCKET_FILE = "hub.sock";
/** Unix socket paths longer than this (macOS's sun_path is 104 bytes with the NUL) move to $TMPDIR. */
export const MAX_SOCKET_PATH = 103;

export interface Env {
  get(name: string): string | undefined;
}

const sysEnv: Env = {
  get(name) {
    try {
      return Deno.env.get(name);
    } catch {
      return undefined;
    }
  },
};

export interface HubPaths {
  readonly state: string;
  readonly config: string;
  readonly db: string;
  readonly log: string;
  readonly tokens: string;
  readonly runtime: string;
  readonly settings: string;
  /** The Unix socket path (or the named pipe on Windows). */
  readonly socket: string;
}

function join(os: string, ...parts: string[]): string {
  const sep = os === "windows" ? "\\" : "/";
  return parts.map((
    p,
    i,
  ) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

/** The hub's folders for an OS and environment. Throws when no home folder is known. */
export function hubPaths(
  os: string = Deno.build.os,
  env: Env = sysEnv,
  uid: number | null = safeUid(),
): HubPaths {
  const override = env.get("GH_PRO_HOME");
  let state: string;
  let config: string;
  if (override) {
    state = config = override;
  } else if (os === "windows") {
    const base = env.get("LOCALAPPDATA");
    if (!base) throw new Error("LOCALAPPDATA is not set");
    state = config = join(os, base, "gh-pro");
  } else {
    const home = env.get("HOME");
    if (!home) throw new Error("HOME is not set");
    if (os === "darwin") {
      state = config = join(os, home, "Library", "Application Support", APP_ID);
    } else {
      state = join(os, env.get("XDG_STATE_HOME") || join(os, home, ".local", "state"), "gh-pro");
      config = join(os, env.get("XDG_CONFIG_HOME") || join(os, home, ".config"), "gh-pro");
    }
  }
  return {
    state,
    config,
    db: join(os, state, DB_FILE),
    log: join(os, state, LOG_FILE),
    tokens: join(os, state, TOKENS_DIR),
    runtime: join(os, state, RUNTIME_FILE),
    settings: join(os, config, SETTINGS_FILE),
    socket: socketPath(os, state, env, uid),
  };
}

function safeUid(): number | null {
  try {
    return Deno.uid();
  } catch {
    return null;
  }
}

/**
 * `<state>/hub.sock`, or `$TMPDIR/gh-pro-<uid>/hub.sock` when that is too long for a socket address;
 * on Windows a named pipe per user.
 */
export function socketPath(os: string, state: string, env: Env, uid: number | null): string {
  if (os === "windows") {
    const user = (env.get("USERNAME") ?? "user").replace(/[^\w.-]/g, "_");
    const scoped = env.get("GH_PRO_HOME") ? `-${hashTag(state)}` : "";
    return `\\\\.\\pipe\\gh-pro-${user}${scoped}-hub`;
  }
  const direct = join(os, state, SOCKET_FILE);
  if (new TextEncoder().encode(direct).length <= MAX_SOCKET_PATH) return direct;
  const tmp = (env.get("TMPDIR") || "/tmp").replace(/\/+$/, "");
  const scoped = env.get("GH_PRO_HOME") ? `-${hashTag(state)}` : "";
  return `${tmp}/gh-pro-${uid ?? "u"}${scoped}/${SOCKET_FILE}`;
}

/** A short stable tag for a path (FNV-1a), so two hubs' fallback sockets don't collide. */
function hashTag(s: string): string {
  let h = 0x811c9dc5;
  for (const c of new TextEncoder().encode(s)) {
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** What a running hub writes to `<state>/hub.json`. */
export interface RuntimeInfo {
  readonly socket: string;
  readonly port: number;
  readonly ingress_port: number;
  readonly pid: number;
  readonly version: string;
  readonly started_at: string;
}

export function parseRuntime(text: string): RuntimeInfo | null {
  try {
    const v = JSON.parse(text) as Partial<RuntimeInfo>;
    if (
      typeof v.socket === "string" && typeof v.port === "number" && typeof v.pid === "number" &&
      typeof v.version === "string"
    ) {
      return {
        socket: v.socket,
        port: v.port,
        ingress_port: typeof v.ingress_port === "number" ? v.ingress_port : 0,
        pid: v.pid,
        version: v.version,
        started_at: typeof v.started_at === "string" ? v.started_at : "",
      };
    }
  } catch {
    // Not JSON.
  }
  return null;
}

/** Owner-only folder (and tighten one made earlier). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  if (Deno.build.os === "windows") return;
  const st = await Deno.stat(dir);
  if (st.mode !== null && (st.mode & 0o777) !== 0o700) await Deno.chmod(dir, 0o700);
}

/** Write a file owner-only, atomically (temp file + rename). */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await Deno.writeTextFile(tmp, text, { mode: 0o600 });
  if (Deno.build.os !== "windows") await Deno.chmod(tmp, 0o600);
  await Deno.rename(tmp, path);
}
