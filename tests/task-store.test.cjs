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
  assert.throws(() => store.poll(dir, 'other'), /owns the unfinished/);
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
