// `gh pro hub install` / `uninstall` (design §2): the hub as a user service, never under `gh`.
//
// - macOS: a launchd agent `~/Library/LaunchAgents/dev.brainwires.ghpro.hub.plist` (RunAtLoad,
//   restarted only after a crash), loaded with `launchctl bootstrap gui/<uid>`.
// - Linux: a systemd user unit `~/.config/systemd/user/gh-pro-hub.service`, `systemctl --user enable
//   --now` (written in phase 1; its install flow is exercised in phase 7).
// - Windows: a scheduled task at logon arrives in phase 7.
//
// The command line is the installed binary (a `deno compile` output: `<binary> hub run`), or, when
// running from source, the Deno binary with the hub's permission flags and this checkout's entry.

import { SERVICE_LABEL } from "../shared/paths.ts";

export const LAUNCHCTL = "/bin/launchctl";
export const SYSTEMCTL = ["/usr/bin/systemctl", "/bin/systemctl"];
export const SYSTEMD_UNIT = "gh-pro-hub.service";

/** The hub's permission flags when run from source (the compiled binary bakes the same). */
export const HUB_FLAGS = [
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
];

/** Whether this process is a `deno compile` binary. */
export function isCompiled(mainModule: string = Deno.mainModule): boolean {
  return /[\\/]deno-compile-/.test(mainModule);
}

/** The argv that runs the hub daemon. */
export function hubCommand(
  execPath: string = Deno.execPath(),
  mainModule: string = Deno.mainModule,
): string[] {
  if (isCompiled(mainModule)) return [execPath, "hub", "run"];
  const entry = mainModule.startsWith("file://")
    ? decodeURIComponent(new URL(mainModule).pathname)
    : mainModule;
  return [execPath, "run", ...HUB_FLAGS, entry, "hub", "run"];
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPlist(
  argv: readonly string[],
  logPath: string,
  env: Record<string, string> = {},
): string {
  const envXml = Object.keys(env).length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${
      Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
        .join("\n")
    }\n  </dict>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
${envXml}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const sq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

export function systemdUnit(argv: readonly string[]): string {
  return `[Unit]
Description=gh-pro hub (local GitHub event service)
After=network-online.target

[Service]
ExecStart=${argv.map(sq).join(" ")}
Restart=on-failure
RestartSec=10
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export interface ServiceFiles {
  readonly path: string;
  readonly text: string;
}

export function servicePath(os: string, home: string): string | null {
  if (os === "darwin") return `${home}/Library/LaunchAgents/${SERVICE_LABEL}.plist`;
  if (os === "linux") return `${home}/.config/systemd/user/${SYSTEMD_UNIT}`;
  return null;
}

async function run(cmd: string, args: string[]): Promise<{ ok: boolean; err: string }> {
  try {
    const r = await new Deno.Command(cmd, { args, stdout: "null", stderr: "piped" }).output();
    return { ok: r.success, err: new TextDecoder().decode(r.stderr).trim() };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

async function systemctl(): Promise<string | null> {
  for (const p of SYSTEMCTL) {
    try {
      if ((await Deno.stat(p)).isFile) return p;
    } catch {
      // Not here.
    }
  }
  return null;
}

export async function installed(
  os: string = Deno.build.os,
  home = Deno.env.get("HOME") ?? "",
): Promise<boolean> {
  const p = servicePath(os, home);
  if (!p) return false;
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function install(logPath: string, env: Record<string, string> = {}): Promise<string> {
  const os = Deno.build.os;
  const home = Deno.env.get("HOME") ?? "";
  const path = servicePath(os, home);
  if (!path) {
    throw new Error("a Windows scheduled task arrives in phase 7: run `gh pro hub run` meanwhile");
  }
  const argv = hubCommand();
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  if (os === "darwin") {
    await Deno.writeTextFile(path, launchdPlist(argv, logPath, env), { mode: 0o644 });
    await run(LAUNCHCTL, ["bootout", `gui/${Deno.uid()}/${SERVICE_LABEL}`]);
    const r = await run(LAUNCHCTL, ["bootstrap", `gui/${Deno.uid()}`, path]);
    if (!r.ok) throw new Error(`launchctl bootstrap: ${r.err}`);
    return path;
  }
  await Deno.writeTextFile(path, systemdUnit(argv), { mode: 0o644 });
  const sc = await systemctl();
  if (!sc) throw new Error(`wrote ${path}, but systemctl isn't there`);
  await run(sc, ["--user", "daemon-reload"]);
  const r = await run(sc, ["--user", "enable", "--now", SYSTEMD_UNIT]);
  if (!r.ok) throw new Error(`systemctl enable: ${r.err}`);
  return path;
}

export async function uninstall(): Promise<string | null> {
  const os = Deno.build.os;
  const path = servicePath(os, Deno.env.get("HOME") ?? "");
  if (!path) return null;
  if (os === "darwin") await run(LAUNCHCTL, ["bootout", `gui/${Deno.uid()}/${SERVICE_LABEL}`]);
  else {
    const sc = await systemctl();
    if (sc) await run(sc, ["--user", "disable", "--now", SYSTEMD_UNIT]);
  }
  try {
    await Deno.remove(path);
    return path;
  } catch {
    return null;
  }
}

/** Start the installed service (no-op success when it is already running). */
export async function serviceStart(): Promise<boolean> {
  const os = Deno.build.os;
  const path = servicePath(os, Deno.env.get("HOME") ?? "");
  if (!path || !(await installed())) return false;
  if (os === "darwin") {
    await run(LAUNCHCTL, ["bootstrap", `gui/${Deno.uid()}`, path]);
    return (await run(LAUNCHCTL, ["kickstart", `gui/${Deno.uid()}/${SERVICE_LABEL}`])).ok;
  }
  const sc = await systemctl();
  return sc ? (await run(sc, ["--user", "start", SYSTEMD_UNIT])).ok : false;
}

/** Stop the installed service so its manager doesn't restart it. */
export async function serviceStop(): Promise<boolean> {
  const os = Deno.build.os;
  if (!(await installed())) return false;
  if (os === "darwin") {
    return (await run(LAUNCHCTL, ["bootout", `gui/${Deno.uid()}/${SERVICE_LABEL}`])).ok;
  }
  const sc = await systemctl();
  return sc ? (await run(sc, ["--user", "stop", SYSTEMD_UNIT])).ok : false;
}

/** Start the hub detached (no service installed). */
export function spawnDetached(): number {
  const [cmd, ...args] = hubCommand();
  const child = new Deno.Command(
    cmd,
    { args, stdin: "null", stdout: "null", stderr: "null", detached: true } as Deno.CommandOptions,
  )
    .spawn();
  child.unref();
  return child.pid;
}
