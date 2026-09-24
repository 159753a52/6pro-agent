const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const store = require('../lib/task-store.cjs');
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real HTTP and CLI use exact task results, coordinate queue mutations and isolate workspace selection', { timeout: 25000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '6pro-workflow-'));
  const fixture = path.join(root, 'server.cjs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .replace('const PORT = 17888;', 'const PORT = 0;')
    .replace(/let currentWorkspace = .*;/, `let currentWorkspace = ${JSON.stringify(root)};`)
    .replace('console.log(`6Pro Assistant Server running at http://127.0.0.1:${PORT}`);', 'process.send({ port: server.address().port });');
  fs.writeFileSync(fixture, source);
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(root, 'lib'), { recursive: true });
  const child = fork(fixture, [], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const base = `http://127.0.0.1:${ready.port}`;
    const request = async (url, body) => {
      const response = await fetch(base + url, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(6000) });
      return { status: response.status, data: await response.json() };
    };
    await request('/api/sessions/create', { id: 'session_a' });
    const dir = path.join(root, 'sessions', 'session_a');
    const submitted = await request('/api/add-task', { session_id: 'session_a', task: 'Edit me', task_id: 'edit' });
    assert.equal(submitted.data.taskId, 'edit');
    const edited = await request('/api/update-task', { session_id: 'session_a', id: 'edit', task: 'Edited' });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.taskIds[0], 'edit');
    assert.equal(edited.data.tasks[0], 'Edited');
    store.poll(dir, 'worker');
    const activeInfo = (await request('/api/info?session_id=session_a')).data;
    assert.equal(activeInfo.agentStatus.state, 'running');
    assert.equal(activeInfo.sessions.find(s => s.id === 'session_a').activity, activeInfo.agentStatus.state);
    assert.equal((await request('/api/delete-task', { session_id: 'session_a', id: 'edit' })).status, 409);
    store.poll(dir, 'worker', { task_id: 'edit', response_text: '42' });
    assert.equal((await request('/api/info?session_id=session_a&task_id=edit')).data.task.response, '42');

    // A genuine CLI "ask" request only uses the isolated HTTP server; it never launches a model.
    const replies = ['42', '好'];
    const cli = replies.map((_, index) => exec(process.execPath, [path.join(__dirname, '..', 'ask-6pro.mjs'), 'ask', `The same first twenty characters ${index}`, '--session', 'session_a', '--timeout', '8'],
      { env: { ...process.env, SIXPRO_SERVER_URL: base }, windowsHide: true, timeout: 10000 }));
    const cliResults = Promise.allSettled(cli);
    let received = 0;
    const deadline = Date.now() + 6000;
    while (received < 2 && Date.now() < deadline) {
      const task = store.poll(dir, 'worker');
      if (task.task_id) {
        const index = Number(task.next_task.slice(-1));
        // Reporting may also claim the next task, so process it on the next iteration.
        store.poll(dir, 'worker', { task_id: task.task_id, response_text: replies[index] });
        received++;
      }
      await sleep(20);
    }
    assert.equal(received, 2);
    const outputs = await cliResults;
    outputs.forEach((output, index) => {
      assert.equal(output.status, 'fulfilled', output.reason?.message);
      assert.ok(output.value.stdout.includes(`\n${replies[index]}\n`));
    });

    // API process enqueues while this process dispatches and completes under the same file lock.
    const additions = Promise.allSettled(Array.from({ length: 16 }, (_, index) => request('/api/add-task', { session_id: 'session_a', task_id: `parallel${index}`, task: `Parallel ${index}` })));
    const done = new Set();
    const concurrentDeadline = Date.now() + 6000;
    while (done.size < 16 && Date.now() < concurrentDeadline) {
      const task = store.poll(dir, 'worker');
      if (task.task_id) {
        assert.equal(done.has(task.task_id), false);
        store.poll(dir, 'worker', { task_id: task.task_id, response_text: 'ok' });
        done.add(task.task_id);
      }
      await sleep(10);
    }
    assert.equal(done.size, 16);
    assert.ok((await additions).every(r => r.status === 'fulfilled' && r.value.status === 200));
    assert.equal(store.queue(dir).length, 0);

    await request('/api/add-task', { session_id: 'session_a', task: 'Running', task_id: 'running' });
    store.poll(dir, 'worker');
    await request('/api/add-task', { session_id: 'session_a', task: 'Waiting', task_id: 'waiting' });
    await request('/api/clear-tasks', { session_id: 'session_a' });
    assert.equal(store.taskStatus(dir, 'running').state, 'running');
    assert.equal(store.taskStatus(dir, 'waiting').state, 'cancelled');
    await request('/api/add-task', { session_id: 'session_a', task: '/exit' });
    assert.equal((await request('/api/info?session_id=session_a')).data.agentStatus.state, 'stopping');
    store.poll(dir, 'worker');
    const stopped = (await request('/api/info?session_id=session_a')).data;
    assert.equal(stopped.agentStatus.state, 'offline');
    assert.equal(stopped.runtime.taskProtocol, store.PROTOCOL_VERSION);
    assert.equal(stopped.agentStatus.gatewayProtocol, store.PROTOCOL_VERSION);

    const secondWorkspace = path.join(root, 'other-workspace');
    fs.mkdirSync(secondWorkspace);
    assert.equal((await request('/api/set-workspace', { workspace: secondWorkspace })).status, 200);
    await request('/api/sessions/create', { id: 'session_b' });
    assert.equal(fs.readFileSync(path.join(root, '.active_session'), 'utf8'), 'session_a');
    assert.equal(fs.readFileSync(path.join(secondWorkspace, '.active_session'), 'utf8'), 'session_b');
    assert.equal((await request('/api/info')).data.activeSessionId, 'session_b');
    assert.equal((await request('/api/set-workspace', { workspace: 'missing-relative-path' })).status, 400);
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
