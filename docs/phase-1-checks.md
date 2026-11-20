# Phase 1 checks

The design named three things to verify in phase 1. Results (2026-11-20):

| Check                                                | Result                                                                                                                                                                                                                                                                                               | How                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| FTS5 in Deno's `node:sqlite`                         | **Present.** Deno 2.9.8 ships SQLite 3.54.1 with `ENABLE_FTS5` (and trigram tokenizing). The hub probes at open anyway and falls back to `LIKE` over `search_docs` without it. Both paths are tested (`tests/storage.test.ts`).                                                                      | `PRAGMA compile_options`, plus creating an FTS5 table          |
| Runner-status webhooks                               | **Absent, as assumed.** GitHub's webhook event list has no runner event (online / offline / added / removed). The only runner data is `workflow_job`'s `runner_name` and its `in_progress` action. Pool online / offline stays with the watchdog file or a read at backfill / on demand (design §6). | GitHub's "Webhook events and payloads" reference, read in full |
| Does a stopped forwarder's hook keep its deliveries? | **Not verified yet.** This needs a test org with hook-admin rights and a real `gh webhook forward` run. The code assumes the worst: if the hook is gone (404 on its deliveries list), reconciliation falls back to the targeted re-read.                                                             | needs a live run (see "Still to verify live")                  |

## Found while building

- **Unix sockets need `--allow-net` in Deno 2.9** (as `unix:<path>`), on top of read / write. An
  exact-path grant works, but the hub's socket path depends on the user (and can move to `$TMPDIR`),
  so no fixed scope can name it. The compiled binary therefore bakes an unscoped `--allow-net`. That
  differs from design §8's "connect to api.github.com, listen on loopback". Clients need `localhost`
  in their grant too, because `fetch` over a Unix-socket client is also checked against the URL's
  host.
- **Deno's `fetch` has no named-pipe transport.** On Windows the CLI talks to the hub over loopback
  TCP. The hub also listens on a per-user named pipe (`\\.\pipe\gh-pro-<user>-hub`) through
  `node:net`, bridged to its loopback listener, for clients that can use a pipe. That bridge has not
  run on Windows yet.
- **`gh webhook forward` takes its secret only on the command line** (`--secret`), so another local
  user can see it in the process list on a shared machine. It only guards the loopback ingress.

## Still to verify live (before the hub takes port 8789)

1. Shadow mode: run a second hub with its own state folder (`GH_PRO_HOME=…`) and its own ports
   (`settings.json`: `ingressPort`, `apiPort`), fed by a forwarder on a test org. Over a CI train,
   compare its problem lines with Fleet's:

   ```sh
   gh pro watch --derived problems
   fleet-stream --kinds problems
   ```
2. Stop the forwarder for 10 minutes, start it again, and check whether its hook's deliveries are
   still listed (decides if forward-mode gaps can be redelivered).
3. Adopt the existing org webhook in tunnel mode without changing its events, then test it:

   ```sh
   gh pro hub webhook setup <org> --mode tunnel --url <public URL> --hook-id <id> \
     --secret-keychain <service>:<account>
   gh pro hub webhook test <org>
   ```
4. Check that a requested redelivery arrives with the original `X-GitHub-Delivery` GUID. The
   ingress's 3-day replay allowance depends on it.
