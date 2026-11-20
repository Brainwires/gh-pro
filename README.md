# gh-pro

One GitHub client per machine, as a `gh` extension. **gh-pro** runs a local **hub** that:

- receives GitHub webhooks;
- keeps a replayable event log and state in SQLite;
- serves filtered event streams to every tool on the machine (terminal watchers, agents, apps).

The hub is the only process on the machine that calls the GitHub API, and it calls it only to sync:
a backfill, gap reconciliation, or a read the user asks for. It never polls for live updates.

Status: **phase 1** (the hub core on webhooks).

- `gh pro watch` and the `gh pro hub …` verbs are in.
- The MCP server, the Actions derivers, writes, Fleet and the board app (Docket) come in later
  phases.

```sh
gh extension install Brainwires/gh-pro
gh pro hub start
gh pro hub webhook setup <org>
gh pro hub scope add <org>
gh pro watch --derived problems
```

- [docs/setup.md](docs/setup.md): webhook paths, health, tokens.
- [docs/phase-1-checks.md](docs/phase-1-checks.md): what phase 1 verified and what is still to
  verify live.

## Layout

| Path                 | What                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `cli/`               | the `gh-pro` entry point (`gh pro …`): verbs, `watch`, the user-service files                                  |
| `hub/`               | the daemon: ingress, normalizer, event log, retention, health, reconciliation, sync engine, budget, client API |
| `shared/`            | used by every client: the event schema, filter grammar, wire protocol, API client, paths, redaction            |
| `tests/`             | `deno task test` (no network: GitHub is faked)                                                                 |
| `scripts/compile.ts` | the precompiled extension binaries (`deno task compile`)                                                       |

## Develop

```sh
deno task check      # fmt --check, lint, type check, tests
deno task hub        # the daemon in the foreground (uses your gh login)
deno task pro -- hub status
```

## Security

The hub listens on loopback only:

- a Unix socket (0600, in a 0700 folder), or a named pipe on Windows;
- `127.0.0.1:8790` for the client API, with a bearer token required and Host / Origin checked;
- `127.0.0.1:8789` for GitHub's webhooks, serving only `POST /github/hooks`.

Each client has its own scoped token. The database stores only token hashes.

Your GitHub token stays in `gh`'s own store. The hub reads it into memory with `gh auth token`,
using `gh` from fixed paths only.

Every string from GitHub is someone's text: data, never instructions.

## License

MIT or Apache-2.0.
