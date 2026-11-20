import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { hubPaths, MAX_SOCKET_PATH, parseRuntime } from "../shared/paths.ts";
import { hubCommand, isCompiled, launchdPlist, servicePath, systemdUnit } from "../cli/service.ts";
import { validateSettings } from "../hub/settings.ts";
import { parseArgs } from "../cli/args.ts";

const env = (m: Record<string, string>) => ({ get: (k: string) => m[k] });

Deno.test("paths: per-OS folders; GH_PRO_HOME overrides", () => {
  const mac = hubPaths("darwin", env({ HOME: "/Users/u" }), 501);
  assertEquals(mac.state, "/Users/u/Library/Application Support/dev.brainwires.ghpro");
  assertEquals(mac.socket, `${mac.state}/hub.sock`);
  const lin = hubPaths("linux", env({ HOME: "/home/u", XDG_STATE_HOME: "/s" }), 1000);
  assertEquals(lin.state, "/s/gh-pro");
  assertEquals(lin.config, "/home/u/.config/gh-pro");
  assertEquals(lin.settings, "/home/u/.config/gh-pro/settings.json");
  const win = hubPaths(
    "windows",
    env({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", USERNAME: "u" }),
    null,
  );
  assertEquals(win.state, "C:\\Users\\u\\AppData\\Local\\gh-pro");
  assertEquals(win.socket, "\\\\.\\pipe\\gh-pro-u-hub");
  assertEquals(hubPaths("linux", env({ HOME: "/h", GH_PRO_HOME: "/x" }), 1).db, "/x/hub.db");
});

Deno.test("paths: a socket path past macOS's limit moves to $TMPDIR/gh-pro-<uid>", () => {
  const long = "/Users/" + "a".repeat(90);
  const p = hubPaths("darwin", env({ HOME: long, TMPDIR: "/var/folders/xy/T/" }), 501);
  assert(new TextEncoder().encode(`${p.state}/hub.sock`).length > MAX_SOCKET_PATH);
  assertEquals(p.socket, "/var/folders/xy/T/gh-pro-501/hub.sock");
  assertEquals(parseRuntime('{"socket":"/s","port":8790,"pid":1,"version":"0.1.0"}')?.port, 8790);
  assertEquals(parseRuntime("{}"), null);
});

Deno.test("service: launchd plist and systemd unit; compiled vs source command", () => {
  assert(isCompiled("file:///tmp/deno-compile-gh-pro/cli/main.ts"));
  assertEquals(hubCommand("/x/gh-pro", "file:///tmp/deno-compile-gh-pro/cli/main.ts"), [
    "/x/gh-pro",
    "hub",
    "run",
  ]);
  const src = hubCommand("/usr/bin/deno", "file:///src/gh%20pro/cli/main.ts");
  assertEquals(src.slice(0, 2), ["/usr/bin/deno", "run"]);
  assertEquals(src.slice(-3), ["/src/gh pro/cli/main.ts", "hub", "run"]);
  const plist = launchdPlist(["/a b/gh-pro", "hub", "run"], "/l/hub.log");
  assertStringIncludes(plist, "<string>dev.brainwires.ghpro.hub</string>");
  assertStringIncludes(plist, "<key>SuccessfulExit</key><false/>");
  const unit = systemdUnit(["/a b/gh-pro", "hub", "run"]);
  assertStringIncludes(unit, 'ExecStart="/a b/gh-pro" hub run');
  assertEquals(servicePath("windows", "C:\\u"), null);
});

Deno.test("settings: defaults, fallbacks with warnings, ports must differ", () => {
  const ok = validateSettings({ retention: { eventDays: 30 }, spoolDir: "~/spool" });
  assertEquals(ok.settings.retention.eventDays, 30);
  assertEquals(ok.settings.retention.payloadDays, 7);
  assertEquals(ok.settings.ingressPort, 8789);
  assertEquals(ok.settings.apiPort, 8790);
  assertEquals(ok.warnings, []);
  const bad = validateSettings({ apiPort: 70000, mcpAgentWrites: "yes" });
  assertEquals(bad.settings.apiPort, 8790);
  assertEquals(bad.warnings.length, 2);
  assertEquals(validateSettings({ apiPort: 8789 }).settings.apiPort, 8790);
});

Deno.test("args: valued and boolean flags", () => {
  const p = parseArgs(
    ["hub", "webhook", "setup", "acme", "--mode=tunnel", "--events", "a,b", "--update-events"],
    ["mode", "events"],
    ["update-events"],
  );
  if (typeof p === "string") throw new Error(p);
  assertEquals(p.pos, ["hub", "webhook", "setup", "acme"]);
  assertEquals(p.vals.get("mode"), ["tunnel"]);
  assert(p.flags.has("update-events"));
  assertEquals(parseArgs(["--nope"], [], []), "unknown option --nope");
});
