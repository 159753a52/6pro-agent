const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const store = require('../lib/task-store.cjs');

function raw(port, { method = 'POST', pathname, headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('the API refuses cross-site and rebinding requests, validates session IDs and keeps task formatting', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '6pro-guards-'));
  const fixture = path.join(root, 'server.cjs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
    .replace('const PORT = 17888;', 'const PORT = 0;')
    .replace(/let currentWorkspace = .*;/, `let currentWorkspace = ${JSON.stringify(root)};`)
    .replace('console.log(`6Pro Assistant Server running at http://127.0.0.1:${PORT}`);', 'process.send({ port: server.address().port });');
  fs.writeFileSync(fixture, source);
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(root, 'lib'), { recursive: true });
  const child = fork(fixture, [], { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    const [{ port }] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const json = (pathname, value, headers = {}) => raw(port, { pathname, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
    assert.equal((await json('/api/sessions/create', { id: 'sess_a' })).status, 200);
    const dir = path.join(root, 'sessions', 'sess_a');

    // A page on another site can only send "simple" requests without a preflight.
    const simple = await raw(port, { pathname: '/api/add-task', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ session_id: 'sess_a', task: 'evil' }) });
    assert.equal(simple.status, 403);
    assert.equal((await json('/api/add-task', { session_id: 'sess_a', task: 'evil' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await json('/api/add-task', { session_id: 'sess_a', task: 'evil' }, { Host: 'evil.example:17888' })).status, 403);
    assert.equal((await raw(port, { method: 'GET', pathname: '/api/info', headers: { Host: 'rebind.example' } })).status, 403);
    const preflight = await raw(port, { method: 'OPTIONS', pathname: '/api/add-task', headers: { Origin: 'https://evil.example' } });
    assert.equal(preflight.status, 403);
    assert.equal(store.queue(dir).length, 0);
    assert.equal((await json('/api/add-task', { session_id: 'sess_a', task: 'same origin' }, { Origin: `http://127.0.0.1:${port}` })).status, 200);

    // Explicit IDs are validated instead of being rewritten to another session.
    assert.equal((await json('/api/add-task', { session_id: 'sess a', task: 'x' })).status, 400);
    assert.equal((await json('/api/add-task', { session_id: '../sess_a', task: 'x' })).status, 400);
    assert.equal((await raw(port, { method: 'GET', pathname: '/api/info?session_id=sess%20a' })).status, 400);
    const upload = await json('/api/upload-image', { session_id: 'ghost', image: 'data:image/png;base64,AAAA' });
    assert.equal(upload.status, 410);
    assert.equal(fs.existsSync(path.join(root, 'sessions', 'ghost')), false);

    // Multi-line, multi-byte tasks survive HTTP chunking and the queue file.
    const task = `第一行 ${'汉'.repeat(40000)}\n  indented line\n`;
    const added = JSON.parse((await json('/api/add-task', { session_id: 'sess_a', task })).text);
    assert.equal(store.taskStatus(dir, added.taskId).content, task.trim());
    assert.equal((await json('/api/add-task', { session_id: 'sess_a', task: 'x'.repeat(33 * 1024 * 1024) })).status, 413);

    // A silent turn can be reset from the API; its task returns to the head of the queue.
    store.poll(dir, 'dead-turn');
    assert.equal((await json('/api/sessions/reset-worker', { session_id: 'sess_a' })).status, 409);
    const workerFile = path.join(dir, '.worker.json');
    const worker = JSON.parse(fs.readFileSync(workerFile, 'utf8'));
    fs.writeFileSync(workerFile, JSON.stringify({ ...worker, seenAt: 1 }));
    fs.writeFileSync(path.join(dir, '.heartbeat'), '1');
    const info = JSON.parse((await raw(port, { method: 'GET', pathname: '/api/info?session_id=sess_a' })).text);
    assert.equal(info.agentStatus.state, 'unknown');
    assert.equal(info.agentStatus.resettable, true);
    const reset = JSON.parse((await json('/api/sessions/reset-worker', { session_id: 'sess_a' })).text);
    assert.equal(reset.requeuedTaskId, store.queue(dir)[0].id);
    assert.equal(store.poll(dir, 'new-turn').next_task, 'same origin');

    // Stopping with nobody connected settles at once instead of blocking the next turn.
    const next = store.poll(dir, 'new-turn', { task_id: reset.requeuedTaskId, response_text: 'ok' });
    assert.equal(next.task_id, added.taskId);
    store.poll(dir, 'new-turn', { task_id: added.taskId, response_text: 'ok' });
    fs.writeFileSync(workerFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(workerFile, 'utf8')), seenAt: 1 }));
    const stop = JSON.parse((await json('/api/add-task', { session_id: 'sess_a', task: '/exit' })).text);
    assert.equal(stop.stopped, true);
    assert.equal((await json('/api/add-task', { session_id: 'sess_a', task: 'after stop' })).status, 200);
    assert.equal(store.poll(dir, 'third-turn').next_task, 'after stop');
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
