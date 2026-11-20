// The hub's own log: `<state>/hub.log`, 0600, every line through the redaction function (tokens,
// Authorization headers, secrets, URLs with token=), rotated at 10 MB (one `.1` kept).

import { redactLine } from "../shared/redact.ts";

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export class HubLogger {
  #size = -1;
  #queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string | null, readonly echo: boolean = false) {}

  line(msg: string): void {
    const l = `${new Date().toISOString()} ${redactLine(msg)}\n`;
    if (this.echo) console.error(l.trimEnd());
    if (!this.path) return;
    const path = this.path;
    this.#queue = this.#queue.then(async () => {
      try {
        if (this.#size < 0) this.#size = (await Deno.stat(path).catch(() => ({ size: 0 }))).size;
        if (this.#size + l.length > LOG_ROTATE_BYTES) {
          await Deno.rename(path, `${path}.1`).catch(() => {});
          this.#size = 0;
        }
        await Deno.writeTextFile(path, l, { append: true, mode: 0o600 });
        this.#size += l.length;
      } catch {
        // Logging never takes the hub down.
      }
    });
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  /** The last `n` lines (the current file, then the rotated one when short). */
  async tail(n: number): Promise<string[]> {
    if (!this.path) return [];
    await this.flush();
    const read = (p: string) =>
      Deno.readTextFile(p).then((t) => t.split("\n").filter(Boolean)).catch(() => []);
    let lines = await read(this.path);
    if (lines.length < n) lines = [...(await read(`${this.path}.1`)), ...lines];
    return lines.slice(-n);
  }
}
