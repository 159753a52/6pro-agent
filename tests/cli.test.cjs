const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const store = require('../lib/task-store.cjs');
const exec = promisify(execFile);

// Runs the real server against a temporary workspace; `cli` passes extra environment to the CLI.
// CODEX_BIN defaults to a stub that exits at once: a real Codex worker would open a paid ChatGPT turn.
async function withServer(action) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '6pro-cli-'));
  const noCodex = path.join(root, 'no-codex.cjs');
  fs.writeFileSync(noCodex, '');
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
    const cli = (args, env = {}) => exec(process.execPath, [path.join(__dirname, '..', 'ask-6pro.mjs'), ...args],
      { env: { ...process.env, CODEX_BIN: noCodex, ...env, SIXPRO_SERVER_URL: `http://127.0.0.1:${port}` }, windowsHide: true, timeout: 15000 });
    await action({ root, port, cli });
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('CLI sends to an explicit session, waits for that task, watches new replies and stops the turn', { timeout: 30000 }, () =>
  withServer(async ({ root, port, cli: run }) => {
    const cli = (...args) => run(args);
    const create = id => fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    await create('cli_a');
    await create('cli_b'); // The console now selects cli_b; --session must still address cli_a.
    const dir = path.join(root, 'sessions', 'cli_a');
    const otherDir = path.join(root, 'sessions', 'cli_b');
    store.poll(dir, 'worker');
    store.poll(otherDir, 'other-worker');

    const sent = await cli('send', '第一行\n\n第二段', '--session', 'cli_a');
    const taskId = /任务 ID: (\S+)/.exec(sent.stdout)[1];
    const otherTaskId = /任务 ID: (\S+)/.exec((await cli('send', 'B 的问题', '--session', 'cli_b')).stdout)[1];
    const watching = cli('watch', '--session', 'cli_a,cli_b', '--timeout', '6');
    const waiting = cli('wait', '--session', 'cli_a', '--task', taskId, '--timeout', '10');
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(store.poll(dir, 'worker').task_id, taskId);
    store.poll(dir, 'worker', { task_id: taskId, response_text: '收到' });
    assert.equal(store.poll(otherDir, 'other-worker').task_id, otherTaskId);
    store.poll(otherDir, 'other-worker', { task_id: otherTaskId, response_text: 'B 的回复' });
    assert.match((await waiting).stdout, /收到/);
    const watched = (await watching).stdout;
    assert.match(watched, /\[cli_a\] 第二段/);
    assert.match(watched, /\[cli_a\] 收到/);
    assert.match(watched, /\[cli_b\] B 的回复/);
    assert.doesNotMatch(watched, /\[cli_a\] B 的回复/);

    assert.match((await cli('stop', '--session', 'cli_a')).stdout, /已请求停止会话 cli_a/);
    assert.equal(store.poll(dir, 'worker').has_next, false);
    await assert.rejects(cli('resume'), /resume 需要 --session/);
  }));

test('spawn routes the Codex worker to the local gateway instead of the global Codex provider', { timeout: 30000 }, () =>
  withServer(async ({ root, cli }) => {
    const argsFile = path.join(root, 'codex-args.json');
    const fakeCodex = path.join(root, 'fake-codex.cjs');
    fs.writeFileSync(fakeCodex, `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`);
    await assert.rejects(cli(['spawn', '网关路由', '--timeout', '10'], { CODEX_BIN: fakeCodex }),
      error => /Codex CLI 已退出 \(0\)/.test(error.stdout + error.stderr));
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    for (const override of ['model_provider="sixpro_gateway"', 'model_providers.sixpro_gateway.base_url="http://127.0.0.1:17841/v1"']) {
      assert.equal(args[args.indexOf(override) - 1], '-c', override);
    }
    assert.equal(args.at(-1), '-');
  }));

test('kill also requests a stop, so a ChatGPT turn still polling the queue ends at its next poll', { timeout: 30000 }, () =>
  withServer(async ({ root, port, cli }) => {
    await fetch(`http://127.0.0.1:${port}/api/sessions/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'orphan' }),
    });
    const dir = path.join(root, 'sessions', 'orphan');
    assert.equal(store.poll(dir, 'turn').next_task, '__POLL__'); // The ChatGPT turn is live and idle.
    const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '__supervise', dir], { stdio: 'ignore', windowsHide: true });
    const exited = once(worker, 'exit');
    try {
      assert.match((await cli(['kill', '--session', 'orphan'])).stdout, /已强制结束会话 orphan .*下次领取任务时确认停止/);
      await exited;
      assert.equal(store.poll(dir, 'turn').has_next, false);
    } finally {
      worker.kill();
    }
  }));

test('spawn refuses another turn at the live-worker limit, before creating a session', { timeout: 30000 }, () =>
  withServer(async ({ root, cli }) => {
    // listWorkers() recognises a worker by its `__supervise <workspace>/sessions/<id>` arguments.
    const busy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '__supervise', path.join(root, 'sessions', 'busy')],
      { stdio: 'ignore', windowsHide: true });
    const sessions = () => fs.readdirSync(path.join(root, 'sessions')).sort();
    try {
      const before = sessions();
      await assert.rejects(cli(['spawn', '第二个会话', '--timeout', '5'], { SIXPRO_MAX_WORKERS: '1' }),
        error => /已有 \d+ 个会话在运行（[^）]*busy/.test(error.stdout + error.stderr));
      assert.deepEqual(sessions(), before);
    } finally {
      busy.kill();
    }
  }));
