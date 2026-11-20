# Setting up the hub

## Install and start

```sh
gh extension install Brainwires/gh-pro
gh pro hub install                     # macOS: launchd agent; Linux: systemd user unit
gh pro hub start                       # or run it once without a service
gh pro hub status
```

From a checkout: `deno task hub` runs the daemon in the foreground, and `deno task pro -- <verb>`
runs any verb.

The state lives in `~/Library/Application Support/dev.brainwires.ghpro/` (macOS),
`$XDG_STATE_HOME/gh-pro/` (Linux) or `%LOCALAPPDATA%\gh-pro\` (Windows). It holds:

- `hub.db`: the event log, state and tokens' hashes;
- `hub.json`: where a running hub listens;
- `tokens/`: one 0600 file per client;
- `hub.log`: the hub's log, redacted.

Settings go in `settings.json`: ports, retention, `spoolDir`, `syncCapPerHour`, `mcpAgentWrites`,
`healthMinutes`.

`GH_PRO_HOME=<dir>` puts everything in one folder. Use it to run a second hub beside a live one;
give that hub other ports in its `settings.json`.

## A webhook path (required: webhooks are the only live source)

### `gh webhook forward` (the default)

```sh
gh pro hub webhook setup <org>          # or <owner/repo>
```

No tunnel, DNS or secret to manage. GitHub's limits apply:

- it is a testing and development tool;
- only one forwarder can run per repo or org at a time;
- it needs hook-admin rights;
- it delivers only while this machine is awake.

The hub runs one supervised child per target (20 at most). A child that dies opens a gap, and the
gap is reconciled when the child is back.

### Your own tunnel (always-on)

```sh
gh pro hub webhook setup <org> --mode tunnel --url https://<host>/github/hooks
```

The hub creates or updates the webhook with a generated secret and prints a tunnel rule that passes
only `POST /github/hooks`.

To adopt an existing hook without touching its events, add `--hook-id <id>` and point at its secret
by reference:

- `--secret-keychain <service>:<account>`: macOS login keychain;
- `--secret-env <NAME>`: an environment variable;
- `--secret-file <path>`: a file.

The hub stores the reference, never the secret.

### A relay (smee.io and the like)

`--mode relay --url …`. The relay sees your payloads; signatures are still checked locally.

## Scope and watching

```sh
gh pro hub scope add <org|owner/repo>   # backfills Actions state; refused without a webhook path
gh pro watch --derived problems         # one line per problem, resumes after drops (Monitor-friendly)
gh pro watch --kind 'actions.job.*' --repo web --since -1h --json
```

`gh pro watch` exits with 2 on a configuration error and 3 when its token is refused. It waits out a
hub that isn't running.

Read verbs exit with 4 when the hub is down. They never call the GitHub API themselves.

## Health and gaps

`gh pro hub status` shows each webhook path's health:

| State      | Meaning                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `live`     | pings arrive and no deliveries failed                                                                                     |
| `degraded` | some deliveries failed or were missed, and are being redelivered                                                          |
| `down`     | a ping didn't arrive within 60 s, or the forwarder died; logged as a `bad` health event, so `--derived problems` shows it |
| `gap`      | reconciling                                                                                                               |

Health is checked every 15 minutes by pinging the hook and listing its deliveries. Nothing polls in
any state.

Reconciliation redelivers what the hub missed, matched by GUID, as far back as GitHub keeps
deliveries (3 days). If that can't cover the gap, the hub re-reads Actions runs instead.

`gh pro hub reconcile --since -2h` runs a reconciliation now.

## Client tokens

```sh
gh pro hub token list
gh pro hub token create --name my-tool --scopes read
gh pro hub token create --name agent --agent --scopes read,write:issues
gh pro hub token revoke my-tool
gh pro hub token rotate cli
```
