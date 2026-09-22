// Task protocol v2. This file is also shipped by codex-chatgpt-web; keep the copies identical.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const PROTOCOL_VERSION = 2;
function retryIO(action) {
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (error) {
      if (attempt >= 39 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
function read(file) {
  try { return retryIO(() => fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function json(file) { const text = read(file); return text ? JSON.parse(text) : null; }
function atomic(file, value) {
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, value, 'utf8'); retryIO(() => fs.renameSync(temp, file)); }
  finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function writeJson(file, value) { atomic(file, JSON.stringify(value)); }
function withQueueLock(dir, action) {
  const file = path.join(dir, '.pop_lock');
  const token = `${process.pid}_${Date.now()}_${randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + 2000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, token); }
    catch (error) {
      if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(read(file).split('_')[0]);
        if (Date.now() - fs.statSync(file).mtimeMs > 15000 && owner > 0) {
          try { process.kill(owner, 0); }
          catch (probe) { if (probe.code === 'ESRCH') fs.unlinkSync(file); }
        }
      } catch (probe) { if (probe.code !== 'ENOENT') throw probe; }
      if (Date.now() >= deadline) throw Object.assign(new Error('队列正忙，请稍后重试'), { status: 409 });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return action(); }
  finally { fs.closeSync(fd); if (read(file) === token) retryIO(() => fs.unlinkSync(file)); }
}
function parse(line) {
  const separator = line.indexOf('|');
  return separator > 0 && /^[a-zA-Z0-9_-]+$/.test(line.slice(0, separator))
    ? { id: line.slice(0, separator), content: line.slice(separator + 1) }
    : { id: '', content: line };
}
function queue(dir) {
  return read(path.join(dir, 'TASKS.txt')).split(/\r?\n/).filter(line => line.trim()).map(parse)
    .filter(task => !task.id || !result(dir, task.id));
}
function saveQueue(dir, tasks) { atomic(path.join(dir, 'TASKS.txt'), tasks.map(t => `${t.id}|${t.content}\n`).join('')); }
function validId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid task ID'); return id; }
function resultPath(dir, id) { return path.join(dir, 'results', `${validId(id)}.json`); }
function result(dir, id) { return json(resultPath(dir, id)); }
function saveResult(dir, data) { fs.mkdirSync(path.join(dir, 'results'), { recursive: true }); writeJson(resultPath(dir, data.id), data); }
function active(dir) { return json(path.join(dir, '.active_task.json')); }
function clearActive(dir) { atomic(path.join(dir, '.active_task'), ''); atomic(path.join(dir, '.active_task.json'), ''); }
function requireSession(dir) {
  const meta = json(path.join(dir, 'meta.json'));
  if (!meta || meta.deleted) throw Object.assign(new Error('会话已删除或不存在'), { status: 410 });
  return meta;
}
function touchInteraction(dir) { atomic(path.join(dir, '.last_interaction'), String(Date.now())); }
function cancel(dir, tasks, reason) {
  for (const task of tasks) if (task.id) saveResult(dir, { ...task, state: 'cancelled', reason, completedAt: Date.now() });
}
function enqueue(dir, text, requestedId) {
  return withQueueLock(dir, () => {
    requireSession(dir);
    if (typeof text !== 'string' || !text.trim()) throw new Error('任务不能为空');
    const content = text.trim().replace(/\r?\n+/g, ' ');
    if (content === '/exit' || content === '__FINISH__') {
      atomic(path.join(dir, '.stop_requested'), String(Date.now()));
      return { stopRequested: true };
    }
    if (read(path.join(dir, '.stop_requested'))) throw Object.assign(new Error('正在等待停止确认，请稍后提交'), { status: 409 });
    const id = requestedId ? validId(requestedId) : randomBytes(12).toString('hex');
    const tasks = queue(dir);
    const existing = result(dir, id) || (active(dir)?.id === id ? active(dir) : tasks.find(t => t.id === id));
    if (existing) {
      if (existing.content !== content) throw Object.assign(new Error('任务 ID 已用于另一条任务'), { status: 409 });
      return { taskId: id };
    }
    saveQueue(dir, [...tasks, { id, content }]);
    touchInteraction(dir);
    return { taskId: id };
  });
}
function editQueue(dir, mode, ids = [], content = '') {
  return withQueueLock(dir, () => {
    requireSession(dir);
    ids.forEach(validId);
    const tasks = queue(dir);
    if (mode !== 'clear' && (!ids.length || ids.some(id => !tasks.some(t => t.id === id)))) {
      throw Object.assign(new Error('任务已被领取或移除，无法修改待办队列'), { status: 409 });
    }
    if (mode === 'edit') {
      if (!content.trim()) throw new Error('任务不能为空');
      saveQueue(dir, tasks.map(t => t.id === ids[0] ? { ...t, content: content.trim().replace(/\r?\n+/g, ' ') } : t));
    } else {
      const removed = mode === 'clear' ? tasks : tasks.filter(t => ids.includes(t.id));
      cancel(dir, removed, '从待办队列移除');
      saveQueue(dir, tasks.filter(t => !removed.includes(t)));
    }
    touchInteraction(dir);
  });
}
function deleteSession(dir) {
  return withQueueLock(dir, () => {
    const meta = json(path.join(dir, 'meta.json')) || { id: path.basename(dir) };
    writeJson(path.join(dir, 'meta.json'), { ...meta, deleted: true });
    atomic(path.join(dir, '.stop_requested'), String(Date.now()));
    cancel(dir, queue(dir), '会话已删除');
    saveQueue(dir, []);
  });
}
function taskStatus(dir, id) {
  validId(id);
  const finished = result(dir, id);
  if (finished) return finished;
  const current = active(dir);
  if (current?.id === id) return { ...current, state: 'running' };
  const pending = queue(dir).find(t => t.id === id);
  return pending ? { ...pending, state: 'queued' } : { id, state: 'unknown' };
}
function renderResult(dir, data) {
  const file = path.join(dir, 'RESPONSE.md');
  const previous = read(file);
  const marker = `<!-- task:${data.id} -->`;
  if (!previous.includes(marker)) atomic(file, `${previous}\n\n${marker}\n### 用户任务 [${new Date(data.completedAt).toLocaleTimeString('zh-CN', { hour12: false })}]\n${data.content}\n\n### 阶段汇报\n${data.response}\n`);
}
function poll(dir, owner, input = {}) {
  return withQueueLock(dir, () => {
    const now = Date.now();
    const meta = json(path.join(dir, 'meta.json'));
    if (!meta) throw new Error('Missing session metadata');
    let current = active(dir);
    let tasks = queue(dir);
    const worker = json(path.join(dir, '.worker.json'));
    const stopping = meta.deleted || Boolean(read(path.join(dir, '.stop_requested'))) || ['/exit', '__FINISH__'].includes(tasks[0]?.content);
    if (current?.owner && current.owner !== owner && !stopping) {
      throw new Error('Another turn owns the unfinished task; request stop before replacing its worker');
    }
    if (worker?.owner !== owner && worker?.state !== 'stopped' && now - (worker?.seenAt || 0) < 45000) {
      throw new Error('This session already has a live worker; refusing duplicate execution');
    }
    // Repair an interrupted completion before dispatching anything else.
    if (current && result(dir, current.id)) {
      const finished = result(dir, current.id);
      if (finished.state === 'completed') renderResult(dir, finished);
      clearActive(dir); current = null;
    }
    if (input.response_text !== undefined) {
      validId(input.task_id);
      const completed = result(dir, input.task_id);
      if (completed) {
        if (completed.state !== 'completed' || completed.response !== input.response_text) throw new Error('Task was cancelled or already completed with a different result');
        renderResult(dir, completed);
      } else {
        if (!current || current.id !== input.task_id) throw new Error('Result task_id does not match the active task');
        const finished = { id: current.id, content: current.content, state: 'completed', response: input.response_text, completedAt: now };
        saveResult(dir, finished);
        renderResult(dir, finished);
        clearActive(dir); current = null;
        touchInteraction(dir);
      }
    }
    if (stopping) {
      if (current) cancel(dir, [current], '执行端已确认停止');
      clearActive(dir);
      saveQueue(dir, tasks.filter(t => !['/exit', '__FINISH__'].includes(t.content)));
      atomic(path.join(dir, '.stopped'), String(now));
      atomic(path.join(dir, '.stop_requested'), '');
      atomic(path.join(dir, '.heartbeat'), '0');
      writeJson(path.join(dir, '.worker.json'), { protocol: PROTOCOL_VERSION, owner, seenAt: now, state: 'stopped' });
      return { has_next: false, message: '执行端已确认停止。待办任务保留；已删除会话不再执行。' };
    }
    if (worker?.owner === owner && worker.state === 'stopped') return { has_next: false, message: 'This turn has already stopped' };
    if (!current && read(path.join(dir, '.active_task')).trim()) {
      throw new Error('Legacy active task detected: finish or request stop before upgrading this session');
    }
    if (fs.existsSync(path.join(dir, '.stopped'))) fs.unlinkSync(path.join(dir, '.stopped'));
    atomic(path.join(dir, '.heartbeat'), String(now));
    writeJson(path.join(dir, '.worker.json'), { protocol: PROTOCOL_VERSION, owner, seenAt: now, state: 'online' });
    if (current) {
      // Claim write precedes queue removal; recover from a crash between the two writes.
      if (tasks.some(t => t.id === current.id)) saveQueue(dir, tasks.filter(t => t.id !== current.id));
    } else if (tasks.length) {
      if (!tasks[0].id) {
        tasks[0].id = randomBytes(12).toString('hex');
        saveQueue(dir, tasks); // Persist a legacy task ID before writing the claim receipt.
      }
      const next = tasks[0];
      current = { ...next, id: next.id || randomBytes(12).toString('hex'), owner, startedAt: now };
      writeJson(path.join(dir, '.active_task.json'), current);
      atomic(path.join(dir, '.active_task'), current.content);
      saveQueue(dir, tasks.slice(1));
      touchInteraction(dir);
    }
    return current ? { has_next: true, task_id: current.id, next_task: current.content,
      message: 'Execute this task; submit its task_id and response_text together when complete. Do not infer completion from status keywords.' }
      : { has_next: true, next_task: '__POLL__', message: 'POLL' };
  });
}
module.exports = { PROTOCOL_VERSION, read, json, atomic, withQueueLock, queue, enqueue, editQueue, deleteSession, taskStatus, poll };
