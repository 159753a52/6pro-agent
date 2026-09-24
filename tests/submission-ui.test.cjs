const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
test('all inline page scripts parse', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
});
test('failed sends preserve text and id, concurrent clicks do not duplicate, and success clears only unchanged input', async () => {
  const start = html.indexOf('    let sendingTask = false;');
  const end = html.indexOf('\n    btnSend.addEventListener', start);
  await vm.runInNewContext(`(async () => {
    const elInput = { value: 'my task', style: {} }, btnSend = {};
    let activeSessionId = 'a', attempt = 0, ids = [], release;
    const crypto = { randomUUID: () => 'abc-def' };
    const alert = message => { throw new Error(message); };
    const apiFetch = async (url, options) => {
      ids.push(JSON.parse(options.body).task_id);
      if (++attempt === 1) throw new Error('offline');
      await new Promise(resolve => { release = resolve; });
      return { json: async () => ({ success: true }) };
    };
    ${html.slice(start, end)}
    await submitTask();
    assert.equal(elInput.value, 'my task');
    assert.equal(btnSend.disabled, false);
    const inFlight = submitTask();
    await submitTask();
    assert.equal(attempt, 2);
    elInput.value = 'new draft';
    release(); await inFlight;
    assert.equal(elInput.value, 'new draft');
    assert.equal(ids[0], ids[1]);
    const success = submitTask(); release(); await success;
    assert.equal(elInput.value, '');
  })()`, { assert });
});
test('heartbeat-only updates do not replace sidebar rows', () => {
  const start = html.indexOf('    let lastSessionRenderKey =');
  const end = html.indexOf('    // Render Task List', start);
  vm.runInNewContext(`
    let currentSessionsCache, activeSessionId = 'a', isDraftNewSession = false, writes = 0;
    const elSessionList = { set innerHTML(value) { writes++; } };
    const escapeHtml = value => value;
    ${html.slice(start, end)}
    renderSessions([{id:'a', name:'A', activity:'waiting', taskCount:0, lastActivityAt:1}]);
    renderSessions([{id:'a', name:'A', activity:'waiting', taskCount:0, lastActivityAt:2}]);
    assert.equal(writes, 1);
    renderSessions([{id:'a', name:'A', activity:'running', taskCount:1, lastActivityAt:3}]);
    assert.equal(writes, 2);
  `, { assert });
});
test('session names cannot break out of inline handlers and rendered markdown is sanitized', () => {
  const escapeStart = html.indexOf('    function escapeHtml(str) {');
  const escapeEnd = html.indexOf('    function fallbackCopyText', escapeStart);
  const start = html.indexOf('    let lastSessionRenderKey =');
  const end = html.indexOf('    // Render Task List', start);
  const markdownStart = html.indexOf('    function renderMarkdown(markdown) {');
  const markdownEnd = html.indexOf('    function formatAssistantBody', markdownStart);
  vm.runInNewContext(`
    let currentSessionsCache, activeSessionId = 'a', isDraftNewSession = false, markup = '';
    const elSessionList = { set innerHTML(value) { markup = value; } };
    ${html.slice(escapeStart, escapeEnd)}
    ${html.slice(start, end)}
    renderSessions([{ id: 'a', name: "x'); alert(1); //", activity: 'offline', taskCount: 0 }]);
    const handlers = markup.match(/onclick="[^"]*"/g);
    assert.ok(handlers.every(handler => !handler.includes('alert')));
    assert.match(markup, /data-name="x&#39;\\); alert\\(1\\); \\/\\/"/);
    const marked = { parse: text => text };
    const window = { DOMPurify: { sanitize: value => 'clean:' + value } };
    const DOMPurify = window.DOMPurify;
    ${html.slice(markdownStart, markdownEnd)}
    assert.equal(renderMarkdown('<img src=x onerror=alert(1)>'), 'clean:<img src=x onerror=alert(1)>');
    window.DOMPurify = undefined;
    assert.equal(renderMarkdown('<b>'), '<pre>&lt;b&gt;</pre>');
  `, { assert });
});
