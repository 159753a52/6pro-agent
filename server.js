const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 17888;
let currentWorkspace = path.resolve("D:\\Project\\Workspace");

// Ensure workspace directory exists
if (!fs.existsSync(currentWorkspace)) {
  fs.mkdirSync(currentWorkspace, { recursive: true });
}

function getSessionsDir() {
  const dir = path.join(currentWorkspace, "sessions");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Windows NTFS safe file operations with backoff retry
function safeReadFile(filePath, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      if (!fs.existsSync(filePath)) return "";
      return fs.readFileSync(filePath, "utf8");
    } catch {
      if (i === maxRetries - 1) return "";
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return "";
}

function safeWriteFile(filePath, content, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.writeFileSync(filePath, content, "utf8");
      return true;
    } catch {
      if (i === maxRetries - 1) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return false;
}

function safeAppendFile(filePath, content, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.appendFileSync(filePath, content, "utf8");
      return true;
    } catch {
      if (i === maxRetries - 1) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  return false;
}

function sanitizeSessionId(id) {
  if (!id || typeof id !== "string") return "default";
  const clean = id.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  const isReserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(clean);
  if (!clean || isReserved) return "default";
  return clean.slice(0, 64);
}

// Task line format: "id|content". For backward compatibility, lines without "|" are treated as id-less.
function makeTaskLine(taskText) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return `${id}|${taskText.replace(/\|/g, "｜")}`;
}

function parseTaskLine(line) {
  const sep = line.indexOf("|");
  if (sep > 0 && /^[a-zA-Z0-9]+$/.test(line.slice(0, sep))) {
    return { id: line.slice(0, sep), content: line.slice(sep + 1) };
  }
  return { id: "", content: line };
}

function serializeTaskLines(lines) {
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function getTaskContents(lines) {
  return lines.map(l => parseTaskLine(l).content);
}

function getTaskIds(lines) {
  return lines.map(l => parseTaskLine(l).id);
}

function getSessionDir(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  const dir = path.join(getSessionsDir(), safeId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function ensureDefaultSession() {
  const defaultDir = path.join(getSessionsDir(), "default");
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }
  const metaPath = path.join(defaultDir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    safeWriteFile(metaPath, JSON.stringify({
      id: "default",
      name: "默认会话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2));
  }
  // Sync legacy root files if default session files are empty
  const defaultTasksPath = path.join(defaultDir, "TASKS.txt");
  const rootTasksPath = path.join(currentWorkspace, "TASKS.txt");
  if (!fs.existsSync(defaultTasksPath) && fs.existsSync(rootTasksPath)) {
    safeWriteFile(defaultTasksPath, safeReadFile(rootTasksPath));
  }
  const defaultResponsePath = path.join(defaultDir, "RESPONSE.md");
  const rootResponsePath = path.join(currentWorkspace, "RESPONSE.md");
  if (!fs.existsSync(defaultResponsePath) && fs.existsSync(rootResponsePath)) {
    safeWriteFile(defaultResponsePath, safeReadFile(rootResponsePath));
  }
}
ensureDefaultSession();

function getSessionMeta(sessionId) {
  const dir = getSessionDir(sessionId);
  const metaPath = path.join(dir, "meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(safeReadFile(metaPath));
    } catch {}
  }
  return {
    id: sessionId,
    name: sessionId === "default" ? "默认会话" : sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function saveSessionMeta(sessionId, meta) {
  const dir = getSessionDir(sessionId);
  const metaPath = path.join(dir, "meta.json");
  safeWriteFile(metaPath, JSON.stringify(meta, null, 2));
}

function listSessions() {
  ensureDefaultSession();
  const sessionsDir = getSessionsDir();
  const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.endsWith(".tombstone") || entry.name.startsWith(".")) continue;
    const sId = entry.name;
    const meta = getSessionMeta(sId);
    if (meta.deleted) continue;
    const tasks = readSessionTasks(sId);
    result.push({
      id: sId,
      name: (meta.name && meta.name !== "新会话" && meta.name !== "新对话") ? meta.name : (sId === "default" ? "默认会话" : sId),
      createdAt: meta.createdAt || 0,
      updatedAt: meta.updatedAt || 0,
      taskCount: tasks.length,
    });
  }

  // Sort: most recently updated first
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  return result;
}

const sessionTasksCache = new Map();
const isClearingTasks = new Set();

function readSessionTasks(sessionId) {
  const dir = getSessionDir(sessionId);
  const p = path.join(dir, "TASKS.txt");
  const raw = safeReadFile(p);
  const currentTaskLines = raw ? raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];
  const currentTasks = getTaskContents(currentTaskLines);

  if (!sessionTasksCache.has(sessionId)) {
    sessionTasksCache.set(sessionId, currentTasks);
    return currentTasks;
  }

  const prevTasks = sessionTasksCache.get(sessionId);
  sessionTasksCache.set(sessionId, currentTasks);

  if (isClearingTasks.has(sessionId)) {
    return currentTasks;
  }

  // Detect if tasks were consumed from the head of the queue by the model
  if (prevTasks.length > currentTasks.length) {
    const poppedCount = prevTasks.length - currentTasks.length;
    // Verify if remaining tasks match the tail of prevTasks
    const matchesTail = currentTasks.every((t, i) => t === prevTasks[i + poppedCount]);
    if (matchesTail) {
      const poppedTasks = prevTasks.slice(0, poppedCount);
      const responsePath = path.join(getSessionDir(sessionId), "RESPONSE.md");
      const timeStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      for (const pt of poppedTasks) {
        if (pt && pt.trim()) {
          const userTaskBlock = `\n\n### 用户任务 [${timeStr}]\n${pt.trim()}\n\n### 阶段汇报 [${timeStr}]\n\n`;
          safeAppendFile(responsePath, userTaskBlock);
        }
      }
    }
  }

  return currentTasks;
}

function readSessionTaskIds(sessionId) {
  const p = path.join(getSessionDir(sessionId), "TASKS.txt");
  const raw = safeReadFile(p);
  const lines = raw ? raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];
  return getTaskIds(lines);
}

function readSessionResponse(sessionId) {
  const dir = getSessionDir(sessionId);
  const p = path.join(dir, "RESPONSE.md");
  return safeReadFile(p);
}

const activeSessionFile = path.join(currentWorkspace, ".active_session");

function getActiveSessionId() {
  const saved = safeReadFile(activeSessionFile).trim();
  if (saved && fs.existsSync(getSessionDir(saved))) {
    return sanitizeSessionId(saved);
  }
  return "default";
}

function setActiveSessionId(sessionId) {
  const clean = sanitizeSessionId(sessionId);
  safeWriteFile(activeSessionFile, clean);
  return clean;
}

const LOG_PATH = "C:\\Users\\13914\\.local\\state\\tunnel-client\\logs\\codex-chatgpt-web.log";
const LAUNCHER_LOG_PATH = path.join(
  process.env.APPDATA || "C:\\Users\\13914\\AppData\\Roaming",
  "Codex Web GPT",
  "logs",
  "launcher.jsonl"
);

function getBrowserStatus() {
  try {
    if (!fs.existsSync(LAUNCHER_LOG_PATH)) return { isGenerating: false, lastEvent: null, ageSec: 999 };
    const stat = fs.statSync(LAUNCHER_LOG_PATH);
    const readSize = Math.min(stat.size, 16384);
    const fd = fs.openSync(LAUNCHER_LOG_PATH, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buffer.toString("utf8").trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (item.event === "browser.turn_ended") {
          const ageSec = (Date.now() - new Date(item.at).getTime()) / 1000;
          return { isGenerating: false, lastEvent: "turn_ended", ageSec };
        }
        if (item.event === "browser.turn_heartbeat") {
          const ageSec = (Date.now() - new Date(item.at).getTime()) / 1000;
          return { isGenerating: ageSec < 25, lastEvent: "turn_heartbeat", ageSec };
        }
      } catch {}
    }
  } catch {}
  return { isGenerating: false, lastEvent: null, ageSec: 999 };
}

function getAgentStatus(tasksCount = 0, sessionId = "default") {
  try {
    const sessionDir = getSessionDir(sessionId);
    const heartbeatPath = path.join(sessionDir, ".heartbeat");
    const activeTaskPath = path.join(sessionDir, ".active_task");
    const now = Date.now();

    let heartbeatTime = 0;
    if (fs.existsSync(heartbeatPath)) {
      const hbStr = safeReadFile(heartbeatPath).trim();
      const parsed = parseInt(hbStr, 10);
      if (!isNaN(parsed) && parsed > 0) {
        heartbeatTime = parsed;
      } else if (parsed === 0) {
        heartbeatTime = 0;
      } else {
        heartbeatTime = fs.statSync(heartbeatPath).mtimeMs;
      }
    }

    // Check if this session has an active task being executed
    const hasActiveTask = fs.existsSync(activeTaskPath) && safeReadFile(activeTaskPath).trim().length > 0;

    // Check session age: use .turn_started (written by gateway at turn start) as the 1h timeout baseline;
    // fall back to meta.createdAt for legacy sessions.
    let sessionAgeMin = 0;
    try {
      const turnStartedPath = path.join(sessionDir, ".turn_started");
      let turnStartMs = 0;
      if (fs.existsSync(turnStartedPath)) {
        turnStartMs = parseInt(safeReadFile(turnStartedPath).trim(), 10) || 0;
      }
      if (!turnStartMs) {
        const metaPath = path.join(sessionDir, "meta.json");
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          if (meta.createdAt) turnStartMs = meta.createdAt;
        }
      }
      if (turnStartMs) {
        sessionAgeMin = (now - turnStartMs) / 60000;
      }
    } catch {}

    const resumePrompt = `你当前继续绑定本地会话【${sessionId}】。\n【1小时额度复用长连接铁律】：即使没有待办任务，也必须保持挂起常驻！严禁向用户输出任何文字、结束语或总结，严禁停笔交卷！\n请立即调用 MCP 工具 codex_fetch_next_task(step_summary="续接执行任务【${sessionId}】") 领取任务或进入常驻挂起监听。\n【工作流与落盘铁律】：后台静默端到端执行；中间微观探查不打卡；实质阶段性成果与详细报告必须以【追加模式 (append / >>)】写入本地 sessions/${sessionId}/RESPONSE.md 末尾，严禁覆盖历史已有内容！step_summary 参数严禁传入大段文本或代码（防云端拦截），只允许传入 30 字以内极简指针（例如：详见本地RESPONSE.md）；若暂无新任务，必须立即循环调用 codex_fetch_next_task 保持长连接挂起！`;

    const browser = getBrowserStatus();

    const stoppedPath = path.join(sessionDir, ".stopped");
    if (fs.existsSync(stoppedPath)) {
      return {
        state: "offline",
        label: "6Pro 已结束本轮 (/exit)",
        detail: "本轮推导已由 /exit 优雅终结。如需发起新一轮，请点击右上角【复制启动词】在网页重新发送。",
        lastActive: heartbeatTime ? new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false }) : ""
      };
    }

    // Case 0: If this session has NEVER received a heartbeat, it's NOT connected yet!
    if (!heartbeatTime) {
      return {
        state: "offline",
        label: "6Pro 待启动 / 未连接",
        detail: "请点击右上角【复制启动词】并在 ChatGPT 网页端发送以激活此会话",
      };
    }

    const hbAgeSec = (now - heartbeatTime) / 1000;
    const isSessionActive = hbAgeSec < 45;

    // Case 1: 1-hour timeout (session age >= 50m and not generating and heartbeat expired)
    if (sessionAgeMin >= 50 && hbAgeSec > 90 && !browser.isGenerating) {
      return {
        state: "timeout_1h",
        label: "⚠️ 1小时限时已达 · 待续接",
        title: "检测到模型单轮 1 小时限时已达（已停止思考）",
        tag: "1h Timeout",
        detail: `会话已进行 ${Math.round(sessionAgeMin)} 分钟，已达云端单轮推导限时。待办任务完好保留在队列中，请在原网页直接发送指令接力下一轮！`,
        resumePrompt,
        sessionId,
        tasksCount,
        lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
      };
    }

    // Case 2: Actively executing a task
    // Either heartbeat is fresh (< 45s), browser is generating, or active task is within reasonable execution window (< 10min)
    if (hasActiveTask && (isSessionActive || browser.isGenerating || hbAgeSec < 600)) {
      return {
        state: "running",
        label: "6Pro 正在执行任务...",
        detail: `模型正在深度推理与执行命令中（已运行 ${Math.round(hbAgeSec)} 秒）...`,
        lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
      };
    }

    // Case 3: Idle keep-alive hanging (session is active, no active task, task queue empty)
    if (isSessionActive && !hasActiveTask && tasksCount === 0) {
      return {
        state: "waiting",
        label: "6Pro 在线保活中 · 等待任务",
        detail: "长连接心跳保活中，随时下发新任务将在 500ms 内执行",
        lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
      };
    }

    // Case 4: Actively processing task or pending queue
    if (browser.isGenerating && (hasActiveTask || tasksCount > 0)) {
      return {
        state: "running",
        label: "6Pro 深度思考 / 执行中...",
        detail: "网页端正在实时推理与处理中（心跳正常）...",
        lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
      };
    }

    // Case 4b: Fallback idle keep-alive if session heartbeat is fresh
    if (isSessionActive) {
      return {
        state: "waiting",
        label: "6Pro 在线保活中 · 等待任务",
        detail: "长连接心跳保活中，随时下发新任务将在 500ms 内执行",
        lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
      };
    }

    // Case 5: Heartbeat expired (> 45s) AND browser is NOT generating -> Actually stopped!
    if (tasksCount > 0 || hasActiveTask) {
      return {
        state: "waiting_resume",
        label: "⚠️ 网页端已停止 · 待发指令接力",
        title: "检测到模型在网页端已停止生成（待命接力）",
        tag: "Turn Ended",
        detail: `模型在上一轮已停笔，队列中有 ${tasksCount + (hasActiveTask ? 1 : 0)} 项任务尚未完成。请在网页端发送“继续”接力！`,
        resumePrompt,
        sessionId,
        tasksCount: tasksCount + (hasActiveTask ? 1 : 0),
        lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
      };
    }

    return {
      state: "turn_ended",
      label: "● 网页端已停止生成 · 待命",
      title: "检测到模型在网页端已停止生成",
      tag: "Turn Ended",
      detail: "模型在网页端上一轮推导已停止，当前暂无待办任务。在下方发送新任务，或在网页端发送指令即可唤醒！",
      resumePrompt,
      sessionId,
      tasksCount: 0,
      lastActive: new Date(heartbeatTime).toLocaleTimeString("zh-CN", { hour12: false })
    };
  } catch (e) {
    return { state: "unknown", label: "状态检测中", detail: e.message };
  }
}

const sseClients = new Set();

function broadcastUpdate() {
  const currentActive = getActiveSessionId();
  const sessions = listSessions();
  for (const client of sseClients) {
    try {
      const sessId = client._targetSessionId || currentActive;
      const tasks = readSessionTasks(sessId);
      const data = JSON.stringify({
        workspace: currentWorkspace,
        activeSessionId: sessId,
        sessions,
        tasks,
        taskIds: readSessionTaskIds(sessId),
        response: readSessionResponse(sessId),
        agentStatus: getAgentStatus(tasks.length, sessId),
        epoch: Date.now(),
      });
      client.write(`data: ${data}\n\n`);
    } catch {}
  }
}

// Single debounced watcher on Workspace directory (avoids Windows handle leaks)
let workspaceWatcher = null;
let watchDebounce = null;
function setupWatcher() {
  try {
    if (workspaceWatcher) {
      try { workspaceWatcher.close(); } catch {}
      workspaceWatcher = null;
    }
    workspaceWatcher = fs.watch(currentWorkspace, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (filename.includes("TASKS.txt") || filename.includes("RESPONSE.md") || filename.includes("meta.json")) {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          broadcastUpdate();
        }, 80);
      }
    });
  } catch (e) {
    console.error("Watcher error:", e);
  }
}
setupWatcher();

// Status change poll every 2.5 seconds to instantly reflect agent waiting / running state
let lastBroadcastStatusKey = "";
setInterval(() => {
  const currentActive = getActiveSessionId();
  const tasks = readSessionTasks(currentActive);
  const st = getAgentStatus(tasks.length, currentActive);
  const statusKey = `${st.state}:${st.label}:${st.detail}`;
  if (statusKey !== lastBroadcastStatusKey) {
    lastBroadcastStatusKey = statusKey;
    broadcastUpdate();
  }
}, 2500);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // SSE stream
  if (url.pathname === "/api/events") {
    const querySession = sanitizeSessionId(url.searchParams.get("session_id"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res._targetSessionId = querySession;
    sseClients.add(res);

    res.on("error", () => {
      sseClients.delete(res);
    });

    // Initial state
    const sessions = listSessions();
    const queryTasks = readSessionTasks(querySession);
    try {
      res.write(`data: ${JSON.stringify({
        workspace: currentWorkspace,
        activeSessionId: querySession,
        sessions,
        tasks: queryTasks,
        taskIds: readSessionTaskIds(querySession),
        response: readSessionResponse(querySession),
        agentStatus: getAgentStatus(queryTasks.length, querySession),
        epoch: Date.now(),
      })}\n\n`);
    } catch {
      sseClients.delete(res);
    }

    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // Switch active session
  if (url.pathname === "/api/sessions/switch" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { session_id } = JSON.parse(body || "{}");
        const safeId = sanitizeSessionId(session_id);
        setActiveSessionId(safeId);
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, activeSessionId: safeId, tasks: readSessionTasks(safeId), response: readSessionResponse(safeId) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Get session list
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: listSessions() }));
    return;
  }

  // Create session
  if (url.pathname === "/api/sessions/create" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { id, name } = JSON.parse(body || "{}");
        const safeId = sanitizeSessionId(id || `sess_${Date.now().toString(36)}`);
        const sessionDir = getSessionDir(safeId);
        const meta = {
          id: safeId,
          name: (name && name.trim() && name.trim() !== "新会话" && name.trim() !== "新对话") ? name.trim().slice(0, 40) : (safeId === "default" ? "默认会话" : safeId),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveSessionMeta(safeId, meta);
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, session: meta, sessions: listSessions() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Rename session
  if (url.pathname === "/api/sessions/rename" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { id, name } = JSON.parse(body || "{}");
        const safeId = sanitizeSessionId(id);
        const meta = getSessionMeta(safeId);
        if (name && name.trim()) {
          meta.name = name.trim().slice(0, 40);
          meta.updatedAt = Date.now();
          saveSessionMeta(safeId, meta);
          broadcastUpdate();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, session: meta, sessions: listSessions() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Delete session (Soft delete with .tombstone to prevent Windows handle lock crashes)
  if (url.pathname === "/api/sessions/delete" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body || "{}");
        const safeId = sanitizeSessionId(id);
        if (safeId === "default") {
          // Default session cannot be deleted; clear it instead
          safeWriteFile(path.join(getSessionDir("default"), "TASKS.txt"), "");
          safeWriteFile(path.join(getSessionDir("default"), "RESPONSE.md"), "");
        } else {
          const dir = path.join(getSessionsDir(), safeId);
          if (fs.existsSync(dir)) {
            // Close watcher to release directory handles on Windows
            if (workspaceWatcher) {
              try { workspaceWatcher.close(); } catch {}
              workspaceWatcher = null;
            }

            // Step 1: Write deleted flag into meta.json while dir still exists
            const meta = getSessionMeta(safeId);
            meta.deleted = true;
            saveSessionMeta(safeId, meta);

            // Step 2: Empty the directory contents except meta.json
            try {
              for (const item of fs.readdirSync(dir)) {
                if (item === "meta.json") continue;
                fs.rmSync(path.join(dir, item), { recursive: true, force: true });
              }
            } catch {}

            // Step 3: Remove the now-empty directory
            try {
              fs.rmdirSync(dir);
            } catch {
              // Fallback: rename as tombstone
              const tombstonePath = path.join(getSessionsDir(), `.deleted_${safeId}_${Date.now()}`);
              try {
                fs.renameSync(dir, tombstonePath);
                try { fs.rmSync(tombstonePath, { recursive: true, force: true }); } catch {}
              } catch {}
            }

            // Re-setup watcher after deletion
            setupWatcher();
          }
          if (getActiveSessionId() === safeId) {
            const remaining = listSessions();
            const nextId = remaining.length > 0 ? remaining[0].id : "default";
            setActiveSessionId(nextId);
          }
        }
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, sessions: listSessions() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Clean empty sessions (bulk remove untitled sessions with no tasks and no responses)
  if (url.pathname === "/api/sessions/clean-empty" && req.method === "POST") {
    try {
      const sessions = listSessions();
      for (const s of sessions) {
        if (s.id !== "default" && s.taskCount === 0) {
          const resp = readSessionResponse(s.id);
          if (!resp || !resp.trim()) {
            const dir = path.join(getSessionsDir(), s.id);
            const meta = getSessionMeta(s.id);
            meta.deleted = true;
            saveSessionMeta(s.id, meta);
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
          }
        }
      }
      if (getActiveSessionId() && !listSessions().some(s => s.id === getActiveSessionId())) {
        const remaining = listSessions();
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : "default");
      }
      broadcastUpdate();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, sessions: listSessions() }));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Get current state
  if (url.pathname === "/api/info" && req.method === "GET") {
    const sId = sanitizeSessionId(url.searchParams.get("session_id"));
    const tasks = readSessionTasks(sId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      workspace: currentWorkspace,
      activeSessionId: sId,
      sessions: listSessions(),
      tasks,
      taskIds: readSessionTaskIds(sId),
      response: readSessionResponse(sId),
      agentStatus: getAgentStatus(tasks.length, sId),
    }));
    return;
  }

  // Add a task
  if (url.pathname === "/api/add-task" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { task, session_id } = JSON.parse(body || "{}");
        const sId = sanitizeSessionId(session_id);
        if (task && task.trim()) {
          const singleLineTask = task.trim().replace(/\r?\n+/g, " ");
          const sessionDir = getSessionDir(sId);
          const tasksPath = path.join(sessionDir, "TASKS.txt");

          // Update cache so readSessionTasks knows this addition is queued by user
          const prev = sessionTasksCache.get(sId) || [];
          // If user sends /exit, mark session as stopped immediately
          const stoppedPath = path.join(sessionDir, ".stopped");
          if (singleLineTask === "/exit" || singleLineTask === "__FINISH__") {
            safeWriteFile(stoppedPath, String(Date.now()));
          } else if (fs.existsSync(stoppedPath)) {
            try { fs.unlinkSync(stoppedPath); } catch {}
          }

          safeAppendFile(tasksPath, makeTaskLine(singleLineTask) + "\n");

          // Note: Do NOT append to RESPONSE.md here!
          // Tasks stay in the left queue until the model actually pops them!

          // Update meta
          const meta = getSessionMeta(sId);
          meta.updatedAt = Date.now();
          // Auto-name untitled session based on the first task
          if (meta.name === "新对话" || meta.name === "新会话" || meta.name === sId) {
            meta.name = singleLineTask.slice(0, 24);
          }
          saveSessionMeta(sId, meta);
          setActiveSessionId(sId);

          broadcastUpdate();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, tasks: readSessionTasks(sId), taskIds: readSessionTaskIds(sId), sessions: listSessions() }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Update a single task in queue (by task id for stability under concurrent pops)
  if (url.pathname === "/api/update-task" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { session_id, id, task } = JSON.parse(body || "{}");
        const sId = sanitizeSessionId(session_id);
        const p = path.join(getSessionDir(sId), "TASKS.txt");
        const raw = safeReadFile(p) || "";
        const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const taskId = String(id || "").trim();
        const cleanTask = typeof task === "string" ? task.trim().replace(/\r?\n+/g, " ") : "";
        if (taskId && cleanTask) {
          const idx = lines.findIndex(l => getTaskLineId(l) === taskId);
          if (idx >= 0) {
            lines[idx] = makeTaskLine(cleanTask);
            isClearingTasks.add(sId);
            sessionTasksCache.set(sId, getTaskContents(lines));
            safeWriteFile(p, serializeTaskLines(lines));
            setTimeout(() => isClearingTasks.delete(sId), 500);
            broadcastUpdate();
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, tasks: readSessionTasks(sId), taskIds: readSessionTaskIds(sId) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Delete a specific task or multiple tasks from queue (by task id for stability)
  if (url.pathname === "/api/delete-task" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { session_id, id, ids } = JSON.parse(body || "{}");
        const sId = sanitizeSessionId(session_id);
        const p = path.join(getSessionDir(sId), "TASKS.txt");
        const raw = safeReadFile(p) || "";
        let lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

        const toDelete = new Set();
        if (Array.isArray(ids)) {
          ids.forEach(i => toDelete.add(String(i)));
        } else if (id !== undefined && id !== null) {
          toDelete.add(String(id));
        }

        if (toDelete.size > 0) {
          lines = lines.filter(l => !toDelete.has(getTaskLineId(l)));
          isClearingTasks.add(sId);
          sessionTasksCache.set(sId, getTaskContents(lines));
          safeWriteFile(p, serializeTaskLines(lines));
          setTimeout(() => isClearingTasks.delete(sId), 500);
          broadcastUpdate();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, tasks: readSessionTasks(sId), taskIds: readSessionTaskIds(sId) }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Clear tasks
  if (url.pathname === "/api/clear-tasks" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { session_id } = JSON.parse(body || "{}");
        const sId = sanitizeSessionId(session_id);
        isClearingTasks.add(sId);
        sessionTasksCache.set(sId, []);
        const p = path.join(getSessionDir(sId), "TASKS.txt");
        safeWriteFile(p, "");
        setTimeout(() => isClearingTasks.delete(sId), 500);
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Clear response
  if (url.pathname === "/api/clear-response" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { session_id } = JSON.parse(body || "{}");
        const sId = sanitizeSessionId(session_id);
        const p = path.join(getSessionDir(sId), "RESPONSE.md");
        safeWriteFile(p, "");
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Upload image (Supports base64 clipboard paste and file pick)
  if (url.pathname === "/api/upload-image" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { image, session_id, filename } = JSON.parse(body || "{}");
        if (!image || typeof image !== "string") throw new Error("Image data is required");
        const sId = sanitizeSessionId(session_id);
        const match = image.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
        if (!match) throw new Error("Invalid base64 image data");
        let ext = match[1].toLowerCase();
        if (ext === "jpeg") ext = "jpg";
        if (!["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext)) ext = "png";
        const buffer = Buffer.from(match[2], "base64");

        const sessionDir = getSessionDir(sId);
        const imgDir = path.join(sessionDir, "images");
        if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

        const safeBaseName = filename ? path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]/g, "_") : "img";
        const targetFilename = `${safeBaseName}_${Date.now()}.${ext}`;
        const targetPath = path.join(imgDir, targetFilename);

        fs.writeFileSync(targetPath, buffer);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success: true,
          path: targetPath,
          filename: targetFilename,
          size: buffer.length,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Set workspace
  if (url.pathname === "/api/set-workspace" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { workspace } = JSON.parse(body || "{}");
        if (workspace && fs.existsSync(workspace)) {
          currentWorkspace = path.resolve(workspace);
          ensureDefaultSession();
          setupWatcher();
          // Write pointer so the MCP gateway can discover the active workspace across processes.
          try {
            safeWriteFile(path.join("D:\\Project\\Workspace", ".workspace_pointer"), currentWorkspace);
          } catch {}
          broadcastUpdate();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, workspace: currentWorkspace }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve static files
  let filePath = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
    };
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

let listenRetries = 0;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    if (listenRetries < 5) {
      listenRetries++;
      console.warn(`Port ${PORT} in use/TIME_WAIT. Retrying in 1s (${listenRetries}/5)...`);
      setTimeout(() => {
        server.close();
        server.listen(PORT, "127.0.0.1");
      }, 1000);
    } else {
      console.error(`Port ${PORT} is already in use after retries. Exiting.`);
      process.exit(1);
    }
  } else {
    console.error("Server error:", err);
  }
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (prevented crash):", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (prevented crash):", reason);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`6Pro Assistant Server running at http://127.0.0.1:${PORT}`);
});

// Event loop keepalive timer to ensure daemon process never drains
setInterval(() => {}, 60_000);

