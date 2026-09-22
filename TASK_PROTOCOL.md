# Task protocol 2

Both 6pro-agent and codex-chatgpt-web ship the identical `task-store.cjs` module.
Keep `lib/task-store.cjs` and the gateway's `src/adapters/chatgpt-web/task-store.cjs`
in sync when changing the protocol. No process depends on the other checkout at runtime.

All queue writes, claims, reports, clear operations, stop requests and deletions take
the session's `.pop_lock`. Writes use temporary files plus replacement, with bounded
Windows file-sharing retries. A live lock owner is never evicted because it is slow.

- `TASKS.txt`: pending `id|content` records. Editing preserves the ID.
- `.active_task.json`: claimed ID, content, owner and start time; `.active_task` remains
  a compatibility display for older readers. A second turn cannot take unfinished work.
- `results/<id>.json`: authoritative completed/cancelled result. Reports require the
  exact `task_id`; status words do not complete work. Replayed identical results do
  not append duplicate reports. Completion receipts repair interrupted display writes.
- `.stop_requested`: a request, not confirmation. The worker sets `.stopped` only when
  it acknowledges at its next poll. An already running shell command is not forcibly
  killed. Queued work survives stop; clearing only cancels queued work.
- Deleted sessions retain a tombstone and request stop. Their history/results may
  remain on disk; removal from the list is not a secure data purge.
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

Update both services together. Build the gateway, update the runtime used by its MCP
profile as well as the HTTP gateway, then restart only when interruption is acceptable.
No deployed runtime was rebuilt or restarted for this change. The desktop launcher
refuses stale source/build timestamps before stopping services. The page shows the
loaded server revision/start time, build freshness estimate, and observed worker
protocol. A build timestamp is not proof that the running MCP profile uses that build.

The local installed ask-6pro script is synchronized with the repository CLI. Tests
cover the local protocol; a real ChatGPT/browser/model end-to-end run remains deferred.
