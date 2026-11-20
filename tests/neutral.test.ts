// Public-repo hygiene (design §8): no host names, home paths, private addresses, hook ids or
// keychain item names of any one installation in the source. Fleet's tree test, for gh-pro.

import { assertEquals } from "@std/assert";

const ROOT = new URL("../", import.meta.url);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".deno"]);

/** Patterns that name one installation (assembled so this file doesn't match itself). */
const FORBIDDEN: [string, RegExp][] = [
  // Fixtures use the placeholder user `u` (and a long run of `a`s).
  ["a home folder", new RegExp(["/Users/", "(?!u\\b|a+\\b)[a-z]"].join(""), "i")],
  ["a Linux home", new RegExp("/home/(?!u\\b|linuxbrew)[a-z]+/")],
  ["a private address", /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ["a hook id", /\b7107\d{5}\b/],
  ["a tunnel host", new RegExp(["ci-", "hooks\\."].join(""))],
  ["a runner host", new RegExp(["bisc", "uits|mac-", "mini|peachy"].join(""), "i")],
  ["a keychain item", new RegExp(["denext-ci", "-hooks"].join(""))],
];

/** Every checked file, as a path relative to the repo root (URLs, so Windows works too). */
async function* files(dir: URL, rel = ""): AsyncIterable<[URL, string]> {
  for await (const e of Deno.readDir(dir)) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (e.isDirectory) yield* files(new URL(`${e.name}/`, dir), `${rel}${e.name}/`);
    else if (/\.(ts|md|json|yml|yaml)$/.test(e.name)) yield [new URL(e.name, dir), rel + e.name];
  }
}

Deno.test("neutral: nothing about one installation in the tree", async () => {
  const hits: string[] = [];
  for await (const [url, f] of files(ROOT)) {
    if (f === "tests/neutral.test.ts" || f === "deno.lock") continue;
    const text = await Deno.readTextFile(url);
    for (const [what, re] of FORBIDDEN) {
      const m = re.exec(text);
      if (m) hits.push(`${f}: ${what} (${m[0]})`);
    }
  }
  assertEquals(hits, []);
});
