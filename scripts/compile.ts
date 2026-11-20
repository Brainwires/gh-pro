// Build the precompiled `gh` extension binaries (design §2): one `deno compile` per target, named as
// `gh extension install` expects of a precompiled extension (`gh-pro-<os>-<arch>[.exe]`).
//
//   deno task compile                 every target into dist/
//   deno task compile -- --host       only this machine's target
//
// The baked permissions are the hub's (cli/service.ts HUB_FLAGS): one binary is the CLI, the hub and
// (from phase 2) the MCP server.

import { HUB_FLAGS } from "../cli/service.ts";

export const TARGETS: readonly { triple: string; asset: string }[] = [
  { triple: "aarch64-apple-darwin", asset: "gh-pro-darwin-arm64" },
  { triple: "x86_64-apple-darwin", asset: "gh-pro-darwin-amd64" },
  { triple: "x86_64-unknown-linux-gnu", asset: "gh-pro-linux-amd64" },
  { triple: "aarch64-unknown-linux-gnu", asset: "gh-pro-linux-arm64" },
  { triple: "x86_64-pc-windows-msvc", asset: "gh-pro-windows-amd64.exe" },
];

function hostTriple(): string {
  const arch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64";
  if (Deno.build.os === "darwin") return `${arch}-apple-darwin`;
  if (Deno.build.os === "windows") return "x86_64-pc-windows-msvc";
  return `${arch}-unknown-linux-gnu`;
}

if (import.meta.main) {
  const only = Deno.args.includes("--host") ? hostTriple() : null;
  await Deno.mkdir("dist", { recursive: true });
  for (const t of TARGETS) {
    if (only && t.triple !== only) continue;
    const args = [
      "compile",
      "--no-config",
      "--no-prompt",
      ...HUB_FLAGS,
      "--target",
      t.triple,
      "--output",
      `dist/${t.asset}`,
      "cli/main.ts",
    ];
    console.log(`deno ${args.join(" ")}`);
    const r = await new Deno.Command(Deno.execPath(), {
      args,
      stdout: "inherit",
      stderr: "inherit",
    })
      .output();
    if (!r.success) Deno.exit(r.code || 1);
  }
}
