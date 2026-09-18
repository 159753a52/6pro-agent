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
    const tasks = readSessionTasks(sId);
    result.push({
      id: sId,
      name: meta.name || sId,
      createdAt: meta.createdAt || 0,
      updatedAt: meta.updatedAt || 0,
      taskCount: tasks.length,
    });
  }

  // Sort: most recently updated first
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  return result;
}

function readSessionTasks(sessionId) {
  const dir = getSessionDir(sessionId);
  const p = path.join(dir, "TASKS.txt");
  const raw = safeReadFile(p);
  if (!raw) return [];
  return raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
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

const sseClients = new Set();

function broadcastUpdate() {
  const currentActive = getActiveSessionId();
  const sessions = listSessions();
  for (const client of sseClients) {
    try {
      const sessId = client._targetSessionId || currentActive;
      const data = JSON.stringify({
        workspace: currentWorkspace,
        activeSessionId: sessId,
        sessions,
        tasks: readSessionTasks(sessId),
        response: readSessionResponse(sessId),
        epoch: Date.now(),
      });
      client.write(`data: ${data}\n\n`);
    } catch {}
  }
}

// Single debounced watcher on Workspace directory (avoids Windows handle leaks)
let watchDebounce = null;
function setupWatcher() {
  try {
    fs.watch(currentWorkspace, { recursive: true }, (eventType, filename) => {
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

    // Initial state
    const sessions = listSessions();
    res.write(`data: ${JSON.stringify({
      workspace: currentWorkspace,
      activeSessionId: querySession,
      sessions,
      tasks: readSessionTasks(querySession),
      response: readSessionResponse(querySession),
      epoch: Date.now(),
    })}\n\n`);

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
          name: (name && name.trim()) ? name.trim().slice(0, 40) : (safeId === "default" ? "默认会话" : "新对话"),
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
            const tombstonePath = path.join(getSessionsDir(), `${safeId}_${Date.now()}.tombstone`);
            try {
              fs.renameSync(dir, tombstonePath);
            } catch {
              // Fallback: mark in meta if locked
              const meta = getSessionMeta(safeId);
              meta.deleted = true;
              saveSessionMeta(safeId, meta);
            }
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

  // Get current state
  if (url.pathname === "/api/info" && req.method === "GET") {
    const sId = sanitizeSessionId(url.searchParams.get("session_id"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      workspace: currentWorkspace,
      activeSessionId: sId,
      sessions: listSessions(),
      tasks: readSessionTasks(sId),
      response: readSessionResponse(sId),
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
          safeAppendFile(tasksPath, singleLineTask + "\n");

          // Update meta
          const meta = getSessionMeta(sId);
          meta.updatedAt = Date.now();
          // Auto-name untitled session based on the first task
          if (meta.name === "新对话" || meta.name === sId) {
            meta.name = singleLineTask.slice(0, 24);
          }
          saveSessionMeta(sId, meta);
          setActiveSessionId(sId);

          broadcastUpdate();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, tasks: readSessionTasks(sId), sessions: listSessions() }));
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
        const p = path.join(getSessionDir(sId), "TASKS.txt");
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`6Pro Assistant Server running at http://127.0.0.1:${PORT}`);
});

