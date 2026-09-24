# Session-bound launches

Task protocol 3 supersedes the report/validation details below. See `TASK_PROTOCOL.md`
for exact task IDs, stop acknowledgement, current offline validation and activation.

`/api/sessions/create` returns `sessionDir`, the absolute directory created by that
request. `ask-6pro spawn` passes that directory as Codex's cwd and `--cd` argument.
It waits for a heartbeat in that exact directory before reporting a connection.
CLI stdout/stderr are retained in `<sessionDir>/codex-cli.log`; a handshake timeout
does not prove that the detached CLI process has stopped.

The matching gateway binds task dispatch to the native cwd, rejects session changes,
and appends `response_text` reports on the server. Launch/resume prompts explicitly
include the target ID. UI selection remains independent of background execution.
Queue submission and result monitoring include `session_dir`; changing workspace
during a request returns HTTP 409 instead of using a different directory.

Upgrade the gateway and this server together. Older servers without `sessionDir`
are rejected by the new launcher. Manual CLI launches must start in the selected
workspace root (and supply `session_id`) or in its `sessions/<id>` directory.

No runtime validation, builds, service restarts, or live model requests were performed
for this fix, as requested. The gateway repository includes
`tests/task-session.test.ts` for later offline validation. After rebuilding and
restarting both services, test two sessions with distinct tasks while switching the
UI selection, then repeat after restarting MCP. Verify the result files, not only
the browser's submission status.
