const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/task-store.cjs');
function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '6pro-protocol-'));
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"id":"test"}');
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('task IDs survive edits, completion accepts short replies and retries do not duplicate reports', () => fixture(dir => {
  const a = store.enqueue(dir, 'Same beginning first task', 'first');
  store.enqueue(dir, 'Same beginning second task', 'second');
  assert.equal(a.taskId, 'first');
  assert.equal(store.enqueue(dir, 'Same beginning first task', 'first').taskId, 'first');
  assert.equal(store.queue(dir).length, 2);
  store.editQueue(dir, 'edit', ['first'], 'Edited task');
  assert.equal(store.queue(dir)[0].id, 'first');
  const task = store.poll(dir, 'worker');
  assert.equal(task.task_id, 'first');
  assert.throws(() => store.editQueue(dir, 'delete', ['first']), /领取/);
  assert.throws(() => store.poll(dir, 'worker', { task_id: 'second', response_text: 'wrong' }), /does not match/);
  assert.throws(() => store.poll(dir, 'worker', { response_text: 'wrong' }), /Invalid task ID/);
  assert.equal(store.poll(dir, 'worker', { task_id: 'first', response_text: '42' }).task_id, 'second');
  assert.equal(store.taskStatus(dir, 'first').response, '42');
  assert.equal(store.poll(dir, 'worker', { task_id: 'first', response_text: '42' }).task_id, 'second');
  assert.equal(store.read(path.join(dir, 'RESPONSE.md')).split('<!-- task:first -->').length, 2);
  assert.equal(store.taskStatus(dir, 'second').state, 'running');
}));
test('clear only cancels queued tasks; stop requires worker acknowledgement and preserves pending work', () => fixture(dir => {
  store.enqueue(dir, 'running', 'a');
  store.poll(dir, 'worker');
  store.enqueue(dir, 'queued', 'b');
  store.editQueue(dir, 'clear');
  assert.equal(store.taskStatus(dir, 'a').state, 'running');
  assert.equal(store.taskStatus(dir, 'b').state, 'cancelled');
  store.enqueue(dir, 'preserved', 'c');
  store.enqueue(dir, '/exit');
  assert.equal(fs.existsSync(path.join(dir, '.stopped')), false);
  assert.ok(store.read(path.join(dir, '.stop_requested')));
  assert.equal(store.poll(dir, 'worker').has_next, false);
  assert.equal(store.taskStatus(dir, 'a').state, 'cancelled');
  assert.equal(store.taskStatus(dir, 'c').state, 'queued');
  assert.ok(store.read(path.join(dir, '.stopped')));
  assert.equal(store.poll(dir, 'worker').has_next, false);
  assert.equal(store.poll(dir, 'new-worker').task_id, 'c');
}));
test('deletion stops dispatch and unfinished work cannot be taken over by another worker', () => fixture(dir => {
  store.enqueue(dir, 'task', 'a');
  store.poll(dir, 'worker');
  assert.throws(() => store.poll(dir, 'other'), /live worker/);
  store.deleteSession(dir);
  assert.equal(store.poll(dir, 'worker').has_next, false);
  assert.equal(store.taskStatus(dir, 'a').state, 'cancelled');
  assert.throws(() => store.enqueue(dir, 'new'), /删除/);
}));
test('queue write failures are surfaced and a completion crash is recovered without re-executing', () => fixture(dir => {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(dir, 'TASKS.txt')) throw new Error('disk failure'); return rename(from, to); };
  try { assert.throws(() => store.enqueue(dir, 'task', 'a'), /disk failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.queue(dir).length, 0);
  store.enqueue(dir, 'task', 'a');
  store.poll(dir, 'worker');
  fs.renameSync = (from, to) => { if (to === path.join(dir, 'RESPONSE.md')) throw new Error('report failure'); return rename(from, to); };
  try { assert.throws(() => store.poll(dir, 'worker', { task_id: 'a', response_text: 'ok' }), /report failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(store.poll(dir, 'worker').next_task, '__POLL__');
  assert.equal(store.taskStatus(dir, 'a').state, 'completed');
  assert.match(store.read(path.join(dir, 'RESPONSE.md')), /ok/);
}));
function expireWorker(dir) {
  const file = path.join(dir, '.worker.json');
  const worker = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...worker, seenAt: worker.seenAt - store.WORKER_LIVE_MS - 1 }));
}
test('a new turn waits for a silent turn, then a reset requeues the unfinished task to it', () => fixture(dir => {
  store.enqueue(dir, 'first', 'a');
  store.enqueue(dir, 'second', 'b');
  assert.equal(store.poll(dir, 'dead').task_id, 'a');
  assert.throws(() => store.releaseWorker(dir), /心跳/);
  expireWorker(dir);
  const waiting = store.poll(dir, 'fresh');
  assert.equal(waiting.has_next, true);
  assert.equal(waiting.next_task, '__POLL__');
  assert.equal(store.taskStatus(dir, 'a').state, 'running', 'waiting must not steal or cancel the claim');
  assert.equal(store.releaseWorker(dir).requeuedTaskId, 'a');
  assert.deepEqual(store.queue(dir).map(t => t.id), ['a', 'b']);
  assert.equal(store.poll(dir, 'fresh').task_id, 'a');
  assert.throws(() => store.poll(dir, 'dead', { task_id: 'a', response_text: 'late' }), /live worker/);
  assert.equal(store.poll(dir, 'fresh', { task_id: 'a', response_text: 'done' }).task_id, 'b');
  assert.equal(store.taskStatus(dir, 'a').response, 'done');
}));
test('a reset task can still be reported by the turn that executed it before anyone reclaims it', () => fixture(dir => {
  store.enqueue(dir, 'slow', 'a');
  store.poll(dir, 'slow-turn');
  expireWorker(dir);
  store.releaseWorker(dir);
  assert.equal(store.poll(dir, 'slow-turn', { task_id: 'a', response_text: 'finished' }).next_task, '__POLL__');
  assert.equal(store.taskStatus(dir, 'a').response, 'finished');
  assert.equal(store.queue(dir).length, 0);
}));
test('a stop aimed at a silent turn is acknowledged by the next turn, which keeps serving', () => fixture(dir => {
  store.enqueue(dir, 'abandoned', 'a');
  store.poll(dir, 'dead');
  expireWorker(dir);
  store.enqueue(dir, '/exit');
  store.enqueue(dir, 'accepted while stopping', 'b');
  const next = store.poll(dir, 'fresh');
  assert.equal(next.has_next, true);
  assert.equal(next.task_id, 'b');
  assert.equal(store.taskStatus(dir, 'a').state, 'cancelled');
  assert.equal(store.read(path.join(dir, '.stop_requested')), '');
}));
test('a stop with no worker to acknowledge it settles immediately and does not end the next turn', () => fixture(dir => {
  assert.deepEqual(store.enqueue(dir, '/exit'), { stopRequested: true, stopped: true });
  assert.equal(store.read(path.join(dir, '.stop_requested')), '');
  assert.ok(store.read(path.join(dir, '.stopped')));
  store.enqueue(dir, 'next job', 'a');
  assert.equal(store.poll(dir, 'new-turn').task_id, 'a');
}));
test('multi-line tasks keep their formatting and legacy queue lines migrate without growing pipes', () => fixture(dir => {
  const code = 'fix this:\r\n  def f():\n      return 1\n';
  store.enqueue(dir, code, 'code');
  store.editQueue(dir, 'edit', ['code'], code + '\n# edited');
  assert.equal(store.queue(dir)[0].content, 'fix this:\n  def f():\n      return 1\n\n# edited');
  fs.writeFileSync(path.join(dir, 'TASKS.txt'), 'legacy raw\n||corrupted legacy\nold|id task\n');
  store.enqueue(dir, 'new', 'n1');
  store.enqueue(dir, 'newer', 'n2');
  const tasks = store.queue(dir);
  assert.deepEqual(tasks.map(t => t.content), ['legacy raw', 'corrupted legacy', 'id task', 'new', 'newer']);
  assert.ok(tasks.every(t => /^[a-zA-Z0-9_-]+$/.test(t.id)));
  assert.equal(tasks[2].id, 'old');
  const claimed = store.poll(dir, 'worker');
  assert.equal(claimed.next_task, 'legacy raw');
  assert.equal(claimed.task_id, tasks[0].id);
}));
