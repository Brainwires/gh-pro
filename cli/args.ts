// A small argument parser: positionals, `--flag value`, `--flag=value`, and boolean flags.

export interface Parsed {
  readonly pos: string[];
  readonly vals: Map<string, string[]>;
  readonly flags: Set<string>;
}

export function parseArgs(
  args: readonly string[],
  valued: readonly string[],
  booleans: readonly string[],
): Parsed | string {
  const pos: string[] = [];
  const vals = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (valued.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : args[++i];
      if (v === undefined) return `--${name} needs a value`;
      vals.set(name, [...(vals.get(name) ?? []), v]);
    } else if (booleans.includes(name) && eq < 0) flags.add(name);
    else return `unknown option --${name}`;
  }
  return { pos, vals, flags };
}

export const one = (p: Parsed, k: string): string | undefined => p.vals.get(k)?.at(-1);
export const many = (p: Parsed, k: string): string[] =>
  (p.vals.get(k) ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
