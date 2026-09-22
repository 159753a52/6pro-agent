const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

test("stale readers and late worker writes do not resurrect deleted sessions", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "6pro-delete-"));
  try {
    // Load the actual storage functions without starting HTTP, watchers, timers, or a model.
    const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const storage = source.slice(0, source.indexOf("const activeSessionFile ="))
      .replace(/let currentWorkspace = .*;/, `let currentWorkspace = ${JSON.stringify(workspace)};`);
    const load = () => vm.runInNewContext(storage + `\n({ getSessionDir, saveSessionMeta,
      readSessionTasks, readSessionTaskIds, readSessionResponse, listSessions, deleteStoredSession });`, { require });
    const api = load();
    const id = "sess_deleted";
    const dir = api.getSessionDir(id);
    assert.equal(fs.existsSync(dir), false);
    api.readSessionTasks(id);
    api.readSessionTaskIds(id);
    api.readSessionResponse(id);
    assert.equal(fs.existsSync(dir), false, "reading a missing session must not create it");

    fs.mkdirSync(dir);
    api.saveSessionMeta(id, { id, name: "Named session" });
    fs.writeFileSync(path.join(dir, "TASKS.txt"), "task-id|Pending task\n");
    api.readSessionTasks(id); // Reproduce a subscribed page's populated task cache.
    api.deleteStoredSession(id);
    api.readSessionTasks(id);
    api.readSessionResponse(id);
    fs.appendFileSync(path.join(dir, "RESPONSE.md"), "Late worker response");
    assert.equal(api.listSessions().some(s => s.id === id), false);
    assert.equal(load().listSessions().some(s => s.id === id), false, "deletion survives server restart");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).deleted, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
