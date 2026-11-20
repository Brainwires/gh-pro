// Ported from Fleet's lib/redact.ts (behaviour unchanged): one redaction function for every log line
// and every error the hub surfaces to a client.

// Secrets out of log text before it reaches the page or an agent: runner JIT configs, GitHub
// tokens, bearer / basic credentials, JWTs, signed-URL signatures, credentials in URLs, values of
// secret-named keys, and any long token-shaped string. Pure; applied per line, so a secret never
// straddles two calls (readers drop a chunk's partial first line). Lines are also capped, so a
// megabyte-long line can't hide anything past what is shown.

/** What a redacted value becomes. */
export const REDACTED = "[redacted]";
/** A line longer than this is cut (and marked). */
export const MAX_LINE = 4000;

const RULES: readonly [RegExp, string | ((...m: string[]) => string)][] = [
  // `--jitconfig <value>` / `--jitconfig=<value>` (a runner's whole registration, a credential).
  [/(--jitconfig(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, `$1${REDACTED}`],
  // JSON / env / YAML keys that hold a JIT config, a token, a secret or a password.
  [
    /((?:["']?)(?:[A-Za-z0-9_.-]*(?:jit_?config|jitconfig|encoded_?jit_?config|token|secret|password|passwd|api_?key|apikey|private_?key|credentials?|client_?secret|access_?key|session_?key|auth)(?:["']?))\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
    (_m, k: string, v: string) => (isHarmless(v) ? `${k}${v}` : `${k}${REDACTED}`),
  ],
  // Authorization headers and their kin.
  [/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [/\b(token)\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{20,}/gi, `$1 ${REDACTED}`],
  // GitHub tokens: classic / OAuth / app / refresh / fine-grained.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED],
  // Other well-known token prefixes (Slack, npm, AWS keys, Stripe, PyPI).
  [
    /\b(?:xox[abposr]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pypi-[A-Za-z0-9_-]{30,})\b/g,
    REDACTED,
  ],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  // Credentials in a URL (`https://x-access-token:…@github.com`).
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Signed-URL signatures and tokens in query strings (Azure SAS `sig`, S3 `X-Amz-Signature`, …).
  [
    /([?&](?:sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|token|access_token|code|se|skoid|sktid|skt|ske|sks|skv|sv)=)[^&\s"']+/gi,
    `$1${REDACTED}`,
  ],
  // PEM private keys (one line of a key, or its header).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
];

/** A value that isn't a secret (a key's value like `true`, `null`, a number, a short word). */
function isHarmless(v: string): boolean {
  const s = v.replace(/^["']|["']$/g, "");
  return s === "" || /^(true|false|null|none|undefined|\*+|\[redacted\])$/i.test(s) ||
    /^\d{1,6}$/.test(s);
}

/**
 * A long run of token characters: at least 32 characters mixing upper and lower case letters and
 * digits (base64 / base62 shapes). Hex alone (git SHAs, digests) and paths are left as they are.
 */
const TOKENISH = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

function tokenShaped(s: string): boolean {
  if (/^[0-9a-f]+$/i.test(s)) return false; // a SHA or digest
  if (/^[A-Za-z]+$/.test(s) || /^[0-9]+$/.test(s)) return false;
  if (s.includes("/") && /^[\w./-]+$/.test(s) && !/[+=]/.test(s)) return false; // a path
  if (/^[a-z0-9_-]+$/.test(s) && /[-_]/.test(s)) return false; // a slug, kebab or snake name
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

/** One line, redacted (and capped). */
export function redactLine(line: string): string {
  let out = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} … [line cut]` : line;
  for (const [re, to] of RULES) out = out.replace(re, to as string);
  out = out.replace(TOKENISH, (m) => (tokenShaped(m) ? REDACTED : m));
  return out;
}

/** Text, redacted line by line. */
export function redactText(text: string): string {
  return text.split("\n").map(redactLine).join("\n");
}

/** ANSI escape sequences (CSI, OSC) and other control characters, out. */
export function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
