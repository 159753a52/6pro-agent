# Task protocol 3

Both 6pro-agent and codex-chatgpt-web ship the identical `task-store.cjs` module.
Keep `lib/task-store.cjs` and the gateway's `src/adapters/chatgpt-web/task-store.cjs`
in sync when changing the protocol. No process depends on the other checkout at runtime.

All queue writes, claims, reports, clear operations, stop requests and deletions take
the session's `.pop_lock`. Writes use temporary files plus replacement, with bounded
Windows file-sharing retries. A live lock owner is never evicted because it is slow.

- `TASKS.txt`: one JSON record `{"id","content"}` per line, so multi-line tasks keep their
  line breaks. Legacy `id|content` and ID-less lines are still read; ID-less lines receive a
  durable ID on the next queue write.
- `.active_task.json`: claimed ID, content, owner and start time; `.active_task` remains
  a compatibility display for older readers. A second turn cannot take unfinished work.
- `results/<id>.json`: authoritative completed/cancelled result. Reports require the
  exact `task_id`; status words do not complete work. Replayed identical results do
  not append duplicate reports. Completion receipts repair interrupted display writes.
- `.stop_requested`: a request, not confirmation, recording the owner of the turn it targets.
  That worker sets `.stopped` when it acknowledges at its next poll. If no live worker and no
  claimed task exist, the service settles the stop immediately. A different (newer) turn that
  polls while the old worker is still live waits (`__POLL__`) for it to acknowledge. Once the old
  worker's heartbeat has expired, the newer turn acknowledges the stop on its behalf, cancels the
  old claim and keeps serving instead of exiting. An already running shell command is not forcibly killed.
  Queued work survives stop, and new tasks may be queued while a stop is pending.
- A newer turn that finds a silent turn's unfinished claim waits (`__POLL__`) without touching
  it. `POST /api/sessions/reset-worker` (refused while the worker heartbeat is live) returns the
  claim to the head of the queue; the waiting turn then takes it. The original turn may still
  report that task until someone reclaims it.
- Deleted sessions retain a tombstone and request stop. Their history/results may
  remain on disk; removal from the list is not a secure data purge.
- `.worker.json`: owner, state (`online`, `stopped`, `released`) and last poll. A worker that
  polled within 45 seconds is live; another turn is refused as a duplicate.
- `.heartbeat`: liveness only. A task with a stale heartbeat is `unknown`, not proven
  running or failed. Sidebar and status cards consume this same classification.
- `.last_interaction`: stable ordering within activity groups. Heartbeats do not move
  peers or replace unchanged sidebar rows.

The CLI waits for its exact task receipt, including one-character answers. The page
retains drafts and submission IDs after failures. A timeout does not cancel work.
Legacy in-flight tasks without IDs must be stopped or completed before migration.

## Validation and activation

Offline checks: `node --test tests/*.test.cjs` and
`powershell -NoProfile -File scripts/test-process-scope.ps1`.
Tests use temporary workspaces, an ephemeral HTTP server, real CLI requests, parallel
queue producers/consumers and UI function execution. They do not call a model.
Gateway checks: `bun test tests/task-session.test.ts tests/task-queue-mcp.test.ts`
and `bun x --no-install tsc --noEmit`. MCP is tested through a local stdio client and broker.

Update both services together, and restart only when interruption is acceptable. The desktop
launcher (`scripts/start-all.ps1`) does this: it refuses differing `task-store.cjs` copies, rebuilds
a stale gateway into `dist/runtime-next` while the old services keep running, then stops them and
mirrors the whole bundle into `dist/runtime`, the Codex Web GPT app (`resources/runtime`) and the
MCP runtime under `~/.codex-chatgpt-web/versions`. The app checks every file against the bundle
manifest and exits at startup on a mismatch, so never copy single files into those runtimes; the
launcher waits for the app to pass that check. The page shows the loaded server revision/start
time, build freshness estimate, and observed worker protocol.

The installed ask-6pro skill forwards to this repository's `ask-6pro.mjs`, so it cannot drift. Tests
cover the local protocol; a real ChatGPT/browser/model end-to-end run remains deferred.

## HTTP access

The service only accepts requests whose Host is `127.0.0.1`, `localhost` or `[::1]`, whose
Origin (when sent) is the same origin, and POST bodies with `Content-Type: application/json`.
There is no CORS grant. This keeps other web pages (and DNS-rebinding hosts) from queueing
tasks for a model that has local tool access. Explicit session IDs must match
`[a-zA-Z0-9_-]{1,64}`; invalid IDs are rejected instead of being rewritten.

Paths can be overridden with `SIXPRO_WORKSPACE`, `SIXPRO_GATEWAY_ROOT` and `CODEX_BIN`.
