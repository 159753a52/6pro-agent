const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const taskStore = require("./lib/task-store.cjs");
const { runtimeInfo } = require("./lib/runtime-info.cjs");

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

function getSessionDir(sessionId) {
  const safeId = sanitizeSessionId(sessionId);
  // Resolving a path must never resurrect a deleted session during a read/SSE update.
  return path.join(currentWorkspace, "sessions", safeId);
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
  taskStore.atomic(metaPath, JSON.stringify(meta, null, 2));
}

function getSessionActivity(sessionId, now = Date.now()) {
  const dir = getSessionDir(sessionId);
  const heartbeat = Number(safeReadFile(path.join(dir, ".heartbeat")).trim());
  const lastActivityAt = Number.isFinite(heartbeat) && heartbeat > 0 && heartbeat <= now ? heartbeat : 0;
  const age = lastActivityAt ? now - lastActivityAt : Infinity;
  const hasTask = Boolean(safeReadFile(path.join(dir, ".active_task")).trim() || taskStore.json(path.join(dir, ".active_task.json")));
  const stopping = Boolean(safeReadFile(path.join(dir, ".stop_requested")).trim());
  const stopped = Boolean(safeReadFile(path.join(dir, ".stopped")).trim());
  const activity = stopping ? "stopping" : stopped ? "offline" : age < 45000 ? (hasTask ? "running" : "waiting") : hasTask ? "unknown" : "offline";
  return { activity, lastActivityAt, lastInteractionAt: Number(safeReadFile(path.join(dir, ".last_interaction"))) || 0 };
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
      ...getSessionActivity(sId),
    });
  }

  const priority = { running: 0, waiting: 1, stopping: 2, unknown: 2, offline: 3 };
  result.sort((a, b) => priority[a.activity] - priority[b.activity]
    || (b.lastInteractionAt || b.updatedAt) - (a.lastInteractionAt || a.updatedAt)
    || a.id.localeCompare(b.id));
  return result;
}


function readSessionTasks(sessionId) {
  return taskStore.queue(getSessionDir(sessionId)).map(task => task.content);
}

function readSessionTaskIds(sessionId) {
  return taskStore.queue(getSessionDir(sessionId)).map(task => task.id);
}

function readSessionResponse(sessionId) {
  const dir = getSessionDir(sessionId);
  const p = path.join(dir, "RESPONSE.md");
  return safeReadFile(p);
}

function deleteStoredSession(sessionId) {
  const dir = getSessionDir(sessionId);
  if (fs.existsSync(dir)) taskStore.deleteSession(dir);
}

const activeSessionFile = () => path.join(currentWorkspace, ".active_session");

function getActiveSessionId() {
  const saved = safeReadFile(activeSessionFile()).trim();
  if (saved && fs.existsSync(getSessionDir(saved)) && !getSessionMeta(saved).deleted) {
    return sanitizeSessionId(saved);
  }
  return "default";
}

function setActiveSessionId(sessionId) {
  const clean = sanitizeSessionId(sessionId);
  taskStore.atomic(activeSessionFile(), clean);
  return clean;
}

function getAgentStatus(tasksCount = 0, sessionId = "default") {
  const status = getSessionActivity(sessionId);
  const descriptions = {
    running: ["正在执行任务", "该会话有执行中任务，且最近 45 秒内收到心跳。"],
    waiting: ["在线待命", "该会话心跳正常，等待领取任务。"],
    stopping: ["已请求停止 · 等待执行端确认", "停止请求将在执行端下次领取任务时确认；当前命令可能仍在执行。"],
    unknown: ["连接状态待确认", "执行中任务仍保留，但心跳已过期；无法确认模型是否还在运行。"],
    offline: ["离线 / 已停止", "当前没有有效心跳。启动或续接后才能领取待办任务。"],
  };
  const [label, summary] = descriptions[status.activity];
  const dir = getSessionDir(sessionId);
  const current = taskStore.json(path.join(dir, ".active_task.json"));
  const worker = taskStore.json(path.join(dir, ".worker.json"));
  const detail = current ? `${summary} 当前任务：${current.content}` : summary;
  return { state: status.activity, label, detail, tasksCount, sessionId, gatewayProtocol: worker?.protocol || null,
    lastActive: status.lastActivityAt ? new Date(status.lastActivityAt).toLocaleTimeString("zh-CN", { hour12: false }) : "" };
}

const sseClients = new Set();

function broadcastUpdate() {
  const currentActive = getActiveSessionId();
  const sessions = listSessions();
  for (const client of sseClients) {
    try {
      const requestedId = client._targetSessionId || currentActive;
      const sessId = sessions.some(s => s.id === requestedId) ? requestedId : currentActive;
      client._targetSessionId = sessId;
      const tasks = readSessionTasks(sessId);
      const data = JSON.stringify({
        workspace: currentWorkspace,
        runtime: runtimeInfo(),
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
      if (filename.includes("TASKS.txt") || filename.includes("RESPONSE.md") || filename.includes("meta.json") || filename.includes(".last_interaction") || filename.includes(".stop_requested")) {
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
  // Observe every session so background activity and heartbeat expiry can reorder the sidebar.
  const activityKey = listSessions().map(s => `${s.id}:${s.activity}:${s.lastInteractionAt}`).join("|");
  const runtime = runtimeInfo();
  const statusKey = `${st.state}:${st.label}:${st.detail}:${st.gatewayProtocol}:${activityKey}:${runtime.needsRestart}:${runtime.gatewayBuild}`;
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
    const requestedSession = sanitizeSessionId(url.searchParams.get("session_id"));
    const querySession = listSessions().some(s => s.id === requestedSession) ? requestedSession : getActiveSessionId();
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
        runtime: runtimeInfo(),
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
        if (!listSessions().some(s => s.id === safeId)) throw new Error("Session no longer exists");
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
        if (fs.existsSync(sessionDir)) throw new Error("Session ID already exists or was deleted; use a new ID");
        fs.mkdirSync(sessionDir, { recursive: true });
        const meta = {
          id: safeId,
          name: (name && name.trim() && name.trim() !== "新会话" && name.trim() !== "新对话") ? name.trim().slice(0, 40) : (safeId === "default" ? "默认会话" : safeId),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveSessionMeta(safeId, meta);
        setActiveSessionId(safeId);
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, session: meta, sessionDir, sessions: listSessions() }));
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

  // Delete session while retaining a durable tombstone for stale readers and workers.
  if (url.pathname === "/api/sessions/delete" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body || "{}");
        const safeId = sanitizeSessionId(id);
        if (safeId === "default") {
          // Default session cannot be deleted; clear it instead
          taskStore.editQueue(getSessionDir("default"), "clear");
          taskStore.withQueueLock(getSessionDir("default"), () => taskStore.atomic(path.join(getSessionDir("default"), "RESPONSE.md"), ""));
        } else {
          const wasActive = getActiveSessionId() === safeId;
          deleteStoredSession(safeId);
          if (wasActive) {
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
            deleteStoredSession(s.id);
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
    const paramSess = url.searchParams.get("session_id");
    const sId = (paramSess && paramSess.trim()) ? sanitizeSessionId(paramSess) : getActiveSessionId();
    if (!listSessions().some(s => s.id === sId)) {
      res.writeHead(410, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session no longer exists" }));
      return;
    }
    const expectedDir = url.searchParams.get("session_dir");
    if (expectedDir && path.resolve(expectedDir) !== path.resolve(currentWorkspace, "sessions", sId)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Workspace changed; refusing to read another session directory" }));
      return;
    }
    if (url.searchParams.has("task_id") && !/^[a-zA-Z0-9_-]{1,100}$/.test(url.searchParams.get("task_id"))) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid task ID" })); return;
    }
    const tasks = readSessionTasks(sId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      workspace: currentWorkspace,
        runtime: runtimeInfo(),
      activeSessionId: sId,
      sessions: listSessions(),
      tasks,
      taskIds: readSessionTaskIds(sId),
      response: readSessionResponse(sId),
      agentStatus: getAgentStatus(tasks.length, sId),
      ...(url.searchParams.get("task_id") ? { task: taskStore.taskStatus(getSessionDir(sId), url.searchParams.get("task_id")) } : {}),
    }));
    return;
  }

  // Every task mutation uses the same cross-process lock as gateway dispatch/completion.
  const taskRoutes = ["/api/add-task", "/api/update-task", "/api/delete-task", "/api/clear-tasks", "/api/clear-response"];
  if (taskRoutes.includes(url.pathname) && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const input = JSON.parse(body || "{}");
        const sId = input.session_id ? sanitizeSessionId(input.session_id) : getActiveSessionId();
        const dir = getSessionDir(sId);
        if (input.session_dir && path.resolve(input.session_dir) !== path.resolve(dir)) {
          throw Object.assign(new Error("Workspace changed; refusing another session directory"), { status: 409 });
        }
        if (!fs.existsSync(path.join(dir, "meta.json")) || getSessionMeta(sId).deleted) {
          throw Object.assign(new Error("Session no longer exists"), { status: 410 });
        }
        let extra = {};
        if (url.pathname === "/api/add-task") {
          extra = taskStore.enqueue(dir, input.task, input.task_id);
        } else if (url.pathname === "/api/update-task") {
          taskStore.editQueue(dir, "edit", [String(input.id || "")], String(input.task || ""));
        } else if (url.pathname === "/api/delete-task") {
          const ids = Array.isArray(input.ids) ? input.ids.map(String) : [String(input.id || "")];
          taskStore.editQueue(dir, "delete", ids);
        } else if (url.pathname === "/api/clear-tasks") {
          taskStore.editQueue(dir, "clear");
        } else {
          taskStore.withQueueLock(dir, () => taskStore.atomic(path.join(dir, "RESPONSE.md"), ""));
        }
        broadcastUpdate();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, ...extra, tasks: readSessionTasks(sId), taskIds: readSessionTaskIds(sId), sessions: listSessions() }));
      } catch (error) {
        res.writeHead(error.status || 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
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
        if (!workspace || !path.isAbsolute(workspace) || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
          throw new Error("请选择存在的工作区绝对目录");
        }
        if (workspace) {
          currentWorkspace = path.resolve(workspace);
          ensureDefaultSession();
          setupWatcher();
          // Running workers retain their native cwd; changing the UI workspace cannot rebind them.
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

