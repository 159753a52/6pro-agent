const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const vm = require("node:vm");

test("HTTP deletion retargets two subscribers and remains deleted after restart", { timeout: 20000 }, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "6pro-delete-http-"));
  const fixture = path.join(workspace, "server.cjs");
  // Run the real server on an ephemeral port with an isolated workspace.
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")
    .replace("const PORT = 17888;", "const PORT = 0;")
    .replace(/let currentWorkspace = .*;/, `let currentWorkspace = ${JSON.stringify(workspace)};`)
    .replace('console.log(`6Pro Assistant Server running at http://127.0.0.1:${PORT}`);',
      'process.send({ port: server.address().port });');
  fs.writeFileSync(fixture, source);
  let child;
  const controllers = [];
  const start = async () => {
    child = fork(fixture, [], { cwd: workspace, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(5000) });
    return `http://127.0.0.1:${message.port}`;
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  };
  try {
    let base = await start();
    const request = async (url, body) => {
      const response = await fetch(base + url, {
        ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      return { status: response.status, data: await response.json() };
    };
    for (const id of ["sess_a", "sess_b"]) {
      assert.equal((await request("/api/sessions/create", { id, name: id })).status, 200);
    }
    await request("/api/add-task", { session_id: "sess_a", task: "Task A" });
    const subscribe = async (id) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(base + `/api/events?session_id=${id}`, { signal: controller.signal });
      const reader = response.body.getReader();
      let buffer = "";
      return async (predicate) => {
        while (true) {
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (event.startsWith("data: ")) {
              const data = JSON.parse(event.slice(6));
              if (predicate(data)) return data;
            }
          }
          const { value, done } = await reader.read();
          assert.equal(done, false, "SSE unexpectedly closed");
          buffer += Buffer.from(value).toString();
        }
      };
    };
    const first = await subscribe("sess_a");
    const second = await subscribe("sess_a");
    await first(data => data.activeSessionId === "sess_a");
    await second(data => data.activeSessionId === "sess_a");
    // Heartbeats do not trigger the file watcher: the all-session timer must publish this change.
    await new Promise(resolve => setTimeout(resolve, 200)); // Drain creation/task watcher debounce.
    fs.writeFileSync(path.join(workspace, "sessions", "sess_b", ".active_task"), "Background task");
    fs.writeFileSync(path.join(workspace, "sessions", "sess_b", ".heartbeat"), String(Date.now()));
    const backgroundFirst = data => data.sessions[0]?.id === "sess_b" && data.sessions[0]?.activity === "running";
    assert.equal((await first(backgroundFirst)).activeSessionId, "sess_a");
    assert.equal((await second(backgroundFirst)).activeSessionId, "sess_a");
    const deleted = await request("/api/sessions/delete", { id: "sess_a" });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.data.sessions.some(s => s.id === "sess_a"), false);
    const retargeted = data => data.activeSessionId !== "sess_a" && !data.sessions.some(s => s.id === "sess_a");
    await Promise.all([first(retargeted), second(retargeted)]);
    assert.equal((await request("/api/info?session_id=sess_a")).status, 410);
    assert.equal((await request("/api/sessions/switch", { session_id: "sess_a" })).status, 400);
    assert.equal((await request("/api/add-task", { session_id: "sess_a", task: "Stale task" })).status, 400);
    assert.equal((await request("/api/sessions/create", { id: "sess_a" })).status, 400);
    const staleTab = await subscribe("sess_a");
    await staleTab(retargeted);
    fs.appendFileSync(path.join(workspace, "sessions", "sess_a", "RESPONSE.md"), "Late worker output");
    assert.equal((await request("/api/sessions")).data.sessions.some(s => s.id === "sess_a"), false);
    // Exercise the sibling bulk-deletion path with the same live subscriptions.
    await request("/api/sessions/clean-empty", {});
    assert.equal((await request("/api/sessions")).data.sessions.some(s => s.id === "sess_b"), false);
    controllers.forEach(controller => controller.abort());
    await stop();
    base = await start();
    const remaining = (await request("/api/sessions")).data.sessions.map(s => s.id);
    assert.deepEqual(remaining, ["default"]);
  } finally {
    controllers.forEach(controller => controller.abort());
    await stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("page ignores closed SSE callbacks and adopts the server's replacement session", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const start = html.indexOf("    function connectSSE(sessionId)");
  const end = html.indexOf("\n    connectSSE(activeSessionId);", start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(`
    let evtSource = null, activeSessionId = 'sess_a', lastEpoch = 0;
    const sources = [], rendered = [], saved = new Map();
    const localStorage = { setItem: (key, value) => saved.set(key, value) };
    const updateUI = data => rendered.push(data);
    class EventSource {
      constructor(url) { this.url = url; sources.push(this); }
      close() { this.closed = true; }
    }
    ${html.slice(start, end)}
    connectSSE(activeSessionId);
    const old = sources[0];
    old.onmessage({ data: JSON.stringify({ activeSessionId: 'sess_b', epoch: 2 }) });
    assert.equal(activeSessionId, 'sess_b');
    assert.equal(saved.get('6pro_active_session'), 'sess_b');
    assert.equal(old.closed, true);
    assert.equal(sources[1].url, '/api/events?session_id=sess_b');
    old.onmessage({ data: JSON.stringify({ activeSessionId: 'sess_a', epoch: 3 }) });
    sources[1].onmessage({ data: JSON.stringify({ activeSessionId: 'sess_a', epoch: 1 }) });
    assert.equal(activeSessionId, 'sess_b');
    assert.equal(rendered.length, 1);
  `, { assert });
});
