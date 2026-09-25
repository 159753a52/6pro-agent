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

test('CLI sends to an explicit session, waits for that task, watches new replies and stops the turn', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '6pro-cli-'));
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
    const cli = (...args) => exec(process.execPath, [path.join(__dirname, '..', 'ask-6pro.mjs'), ...args],
      { env: { ...process.env, SIXPRO_SERVER_URL: `http://127.0.0.1:${port}` }, windowsHide: true, timeout: 15000 });
    const create = id => fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    await create('cli_a');
    await create('cli_b'); // The console now selects cli_b; --session must still address cli_a.
    const dir = path.join(root, 'sessions', 'cli_a');
    store.poll(dir, 'worker');

    const sent = await cli('send', '第一行\n\n第二段', '--session', 'cli_a');
    const taskId = /任务 ID: (\S+)/.exec(sent.stdout)[1];
    const watching = cli('watch', '--session', 'cli_a', '--timeout', '6');
    const waiting = cli('wait', '--session', 'cli_a', '--task', taskId, '--timeout', '10');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(store.poll(dir, 'worker').task_id, taskId);
    store.poll(dir, 'worker', { task_id: taskId, response_text: '收到' });
    assert.match((await waiting).stdout, /收到/);
    const watched = (await watching).stdout;
    assert.match(watched, /第二段/);
    assert.match(watched, /收到/);

    assert.match((await cli('stop', '--session', 'cli_a')).stdout, /已请求停止会话 cli_a/);
    assert.equal(store.poll(dir, 'worker').has_next, false);
    await assert.rejects(cli('resume'), /resume 需要 --session/);
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
