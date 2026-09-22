const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");

test("running and waiting sessions precede selected offline sessions, and expire independently", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "6pro-activity-"));
  try {
    const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const storage = source.slice(0, source.indexOf("const activeSessionFile ="))
      .replace(/let currentWorkspace = .*;/, `let currentWorkspace = ${JSON.stringify(workspace)};`);
    const api = vm.runInNewContext(storage + "\n({listSessions, getSessionActivity});", { require: require('node:module').createRequire(path.join(__dirname, '..', 'server.js')) });
    const now = Date.now();
    function session(id, heartbeat, task = "", stopped = false, updatedAt = 1) {
      const dir = path.join(workspace, "sessions", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, updatedAt }));
      fs.writeFileSync(path.join(dir, ".heartbeat"), String(heartbeat));
      fs.writeFileSync(path.join(dir, ".active_task"), task);
      fs.writeFileSync(path.join(dir, ".last_interaction"), String(heartbeat));
      if (stopped) fs.writeFileSync(path.join(dir, ".stopped"), "1");
    }
    session("selected", 0, "", false, now);
    session("working", now - 10000, "Assigned task");
    session("waiting_old", now - 10000);
    session("waiting_new", now - 1000);
    session("stopped", now, "Old task", true);
    session("stale_task", now - 700000, "Abandoned task");
    fs.writeFileSync(path.join(workspace, ".active_session"), "selected");
    const ids = () => Array.from(api.listSessions(), s => s.id);
    assert.deepEqual(ids().slice(0, 3), ["working", "waiting_new", "waiting_old"]);
    fs.writeFileSync(path.join(workspace, "sessions", "waiting_old", ".heartbeat"), String(now));
    assert.deepEqual(ids().slice(0, 3), ["working", "waiting_new", "waiting_old"], "heartbeat must not reshuffle peers");
    assert.equal(api.getSessionActivity("waiting_new", now + 45000).activity, "offline");
    assert.equal(api.getSessionActivity("working", now + 600000).activity, "unknown");
    assert.equal(api.getSessionActivity("stopped").activity, "offline");
    assert.equal(api.getSessionActivity("stale_task").activity, "unknown");
    // A background session becomes active without selecting it or changing metadata.
    fs.writeFileSync(path.join(workspace, "sessions", "stale_task", ".heartbeat"), String(now));
    fs.writeFileSync(path.join(workspace, "sessions", "stale_task", ".last_interaction"), String(now));
    assert.equal(ids()[0], "stale_task");
    fs.writeFileSync(path.join(workspace, ".active_session"), "waiting_old");
    assert.equal(ids()[0], "stale_task");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
