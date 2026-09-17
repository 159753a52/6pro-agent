const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 17888;
let currentWorkspace = path.resolve("D:\\Project\\Workspace");

// Ensure workspace directory exists
if (!fs.existsSync(currentWorkspace)) {
  fs.mkdirSync(currentWorkspace, { recursive: true });
}

function getTasksPath() {
  return path.join(currentWorkspace, "TASKS.txt");
}

function getResponsePath() {
  return path.join(currentWorkspace, "RESPONSE.md");
}

function readTasks() {
  const p = getTasksPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function readResponse() {
  const p = getResponsePath();
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

const sseClients = new Set();

function broadcastUpdate() {
  const data = JSON.stringify({
    workspace: currentWorkspace,
    tasks: readTasks(),
    response: readResponse(),
  });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// Watch for file changes
let watchDebounce = null;
function setupWatcher() {
  try {
    fs.watch(currentWorkspace, (eventType, filename) => {
      if (filename === "TASKS.txt" || filename === "RESPONSE.md") {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => {
          broadcastUpdate();
        }, 150);
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    sseClients.add(res);
    // Send initial state
    res.write(`data: ${JSON.stringify({
      workspace: currentWorkspace,
      tasks: readTasks(),
      response: readResponse(),
    })}\n\n`);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  // Get current state
  if (url.pathname === "/api/info" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      workspace: currentWorkspace,
      tasks: readTasks(),
      response: readResponse(),
    }));
    return;
  }

  // Add a task
  if (url.pathname === "/api/add-task" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { task } = JSON.parse(body);
        if (task && task.trim()) {
          const p = getTasksPath();
          fs.appendFileSync(p, task.trim() + "\n", "utf8");
          broadcastUpdate();
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, tasks: readTasks() }));
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
        const { workspace } = JSON.parse(body);
        if (workspace && fs.existsSync(workspace)) {
          currentWorkspace = path.resolve(workspace);
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

  // Clear tasks
  if (url.pathname === "/api/clear-tasks" && req.method === "POST") {
    const p = getTasksPath();
    if (fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
    broadcastUpdate();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Clear response
  if (url.pathname === "/api/clear-response" && req.method === "POST") {
    const p = getResponsePath();
    if (fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
    broadcastUpdate();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
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
