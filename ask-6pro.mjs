#!/usr/bin/env node
/**
 * 6Pro Agent CLI - 直接在终端下发任务、查询状态、一键新建会话并自动闭环
 * 既可由开发者直接在终端运行，也可供 Antigravity / Codex Subagent 作为工具直接调用
 */

import http from "node:http";
import { closeSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

const BASE_URL = process.env.SIXPRO_SERVER_URL || "http://127.0.0.1:17888";
// Each spawn/resume starts one ChatGPT turn; Pro quota is scarce, so it is never the default.
const DEFAULT_MODEL = "chatgpt-web/high";

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.setTimeout(10000, () => req.destroy(new Error("请求超时")));
    req.on("error", (err) => {
      reject(new Error(`无法连接到 6pro 服务 (${BASE_URL}): ${err.message}。请确认 server.js 是否已启动。`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getInfo(sessionId = "", sessionDir = "", taskId = "") {
  const query = `?${new URLSearchParams({ ...(sessionId ? { session_id: sessionId } : {}), ...(sessionDir ? { session_dir: sessionDir } : {}), ...(taskId ? { task_id: taskId } : {}) })}`;
  const res = await request("GET", `/api/info${query}`);
  if (res.status !== 200) {
    const error = new Error(`获取信息失败 (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    error.status = res.status;
    throw error;
  }
  return res.data;
}

async function sendTask(taskText, sessionId = "", sessionDir = "") {
  const res = await request("POST", "/api/add-task", {
    task: taskText,
    session_id: sessionId || undefined,
    session_dir: sessionDir || undefined,
  });
  if (res.status !== 200 || !res.data.success) {
    throw new Error(`添加任务失败: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function cmdStatus(sessionId = "") {
  const info = await getInfo(sessionId);
  const status = info.agentStatus || {};
  const activeSess = info.activeSessionId || "default";
  const tasksCount = (info.tasks || []).length;

  console.log(`\n=== 6Pro Agent 运行状态 ===`);
  console.log(`当前激活会话: ${activeSess}`);
  console.log(`通道在线状态: ${status.label || status.state || "未知"}`);
  console.log(`详细状态说明: ${status.detail || "无"}`);
  console.log(`待办任务队列: ${tasksCount} 个任务待处理`);
  if (tasksCount > 0) {
    info.tasks.forEach((t, i) => console.log(`  [${i + 1}] ${t}`));
  }
  if (status.lastActive) {
    console.log(`最近活跃时间: ${status.lastActive}`);
  }
  console.log(`===========================\n`);
}

async function cmdSend(taskText, sessionId = "") {
  if (!taskText || !taskText.trim()) {
    console.error("错误: 请提供任务内容。例如: ask-6pro send \"帮我分析一下架构\"");
    process.exit(1);
  }
  const info = await getInfo(sessionId);
  const sId = sessionId || info.activeSessionId || "default";
  const res = await sendTask(taskText.trim(), sId, join(info.workspace, "sessions", sId));
  if (res.stopRequested) {
    console.log(res.stopped ? "✅ 当前没有在线执行端，会话已直接停止。" : "✅ 已请求停止，执行端将在下次领取任务时确认。");
    return;
  }
  console.log(`✅ 任务已加入会话 ${sId} 的待办队列（队列中 ${res.tasks.length} 个）。`);
  console.log(`任务 ID: ${res.taskId}`);
  console.log(`查看结果: wait --session ${sId} --task ${res.taskId}`);
  if (["offline", "unknown"].includes(info.agentStatus?.state)) {
    console.log(`⚠️ 会话当前没有在线执行端（${info.agentStatus.label}）；可用 resume --session ${sId} 拉起新的执行 turn。`);
  }
}

async function waitForAnswer(sId, taskId, timeoutSec = 300, sessionDir = "") {
  if (!taskId) throw new Error("服务端未返回 taskId，请更新任务服务后重试");
  const startedAt = Date.now();
  let lastState = "";
  let warnedIdle = false;
  while (Date.now() - startedAt < timeoutSec * 1000) {
    try {
      const info = await getInfo(sId, sessionDir, taskId);
      const task = info.task;
      if (task?.state === "completed") {
        console.log(`\n=== 任务 ${taskId} 已完成 ===\n${task.response}`);
        return task.response;
      }
      if (task?.state === "cancelled") throw Object.assign(new Error(task.reason || "任务已取消"), { terminal: true });
      if (!task || task.state === "unknown") throw Object.assign(new Error("任务记录不可用；请检查网关是否已更新到任务协议 3"), { terminal: true });
      if (task.state !== lastState) {
        lastState = task.state;
        console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] 任务状态: ${task.state === "running" ? "模型已领取，正在处理" : "排队中"}`);
      }
      // A queued task on a session without a live worker waits forever; say so once.
      if (!warnedIdle && task.state === "queued" && ["offline", "unknown"].includes(info.agentStatus?.state)) {
        warnedIdle = true;
        console.log(`⚠️ 会话 ${sId} 当前没有在线执行端（${info.agentStatus.label}），任务会一直排队；可用 resume --session ${sId} 拉起新的执行 turn。`);
      }
    } catch (error) {
      if (error.terminal || (error.status >= 400 && error.status < 500)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`等待任务 ${taskId} 超时 (${timeoutSec}秒)；这不会取消任务。稍后可用 wait --session ${sId} --task ${taskId} 继续等待结果。`);
}

async function cmdAsk(question, timeoutSec = 300, sessionId = "") {
  if (!question || !question.trim()) {
    console.error("错误: 请提供提问内容。例如: ask-6pro ask \"请解释下这段代码怎么优化\"");
    process.exit(1);
  }

  const initInfo = await getInfo(sessionId);
  const sId = sessionId || initInfo.activeSessionId || "default";
  const sessionDir = join(initInfo.workspace, "sessions", sId);
  const status = initInfo.agentStatus || {};

  if (status.state === "offline") {
    console.warn(`⚠️ 警告: 6Pro 当前似乎未在线 (状态: ${status.label})。`);
    console.warn(`提示: 可使用 'ask-6pro spawn' 自动创建新会话并自动开辟对话！`);
  }


  console.log(`\n🚀 正在向 6Pro 提问 [会话: ${sId}]...`);
  console.log(`❓ 问题: ${question}`);
  const submitted = await sendTask(question.trim(), sId, sessionDir);
  if (submitted.stopRequested) {
    console.log(submitted.stopped ? "✅ 当前没有在线执行端，会话已直接停止。" : "✅ 已请求停止，执行端将在下次领取任务时确认。");
    return "";
  }
  console.log(`⏳ 任务已入队（任务 ID: ${submitted.taskId}），等待 6Pro 领取并开始推理...\n`);

  return await waitForAnswer(sId, submitted.taskId, timeoutSec, sessionDir);
}

function buildLaunchPrompt(sessionName, sessionId) {
  return `你当前已绑定本地会话【${sessionName}】（Session ID: ${sessionId}）。
当前工作目录就是此会话目录；不要再拼接 sessions/${sessionId}/。

【任务执行与协同规范】
1. 任务流转与状态同步：通过 MCP 工具 codex_fetch_next_task 与本地工作区保持同步。
   - 调用参数：必须传入 session_id="${sessionId}"，step_summary 仅传入简短状态标识（如 "Idle", "Poll", "Done"）。
2. 单次独立调用：每次由模型自身发起单次独立的工具调用，等待返回后再进行下一步。
3. 成果直接落盘：完成任务时通过 codex_fetch_next_task 的 task_id（领取时返回的原值）和 response_text 参数提交成果，由服务端追加到绑定会话的 RESPONSE.md，不要自行选择回复路径。
4. 持续协同监听：只要 has_next 为 true，在完成当前阶段任务并落盘后，请继续调用 codex_fetch_next_task 接收下一条指令。
5. 退出通道：当 codex_fetch_next_task 返回 has_next=false（用户输入 /exit）时，输出最终总结并结束本轮。
现在请调用 codex_fetch_next_task(session_id="${sessionId}", step_summary="Idle") 获取首个任务或进入待命状态。`;
}

// Start one Codex turn bound to the session directory and wait for its first heartbeat there.
async function launchWorker({ sessionId, sessionName, sessionDir, timeoutSec, model }) {
  const launchPrompt = buildLaunchPrompt(sessionName, sessionId);
  console.log(`🚀 正在通过无头模式拉起 Codex CLI (${model})...`);
  const codexBin = process.env.CODEX_BIN || "D:\\tools\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js";
  const logPath = join(sessionDir, "codex-cli.log");
  const logFd = openSync(logPath, "a");
  const startedAt = Date.now();
  let cp;
  try {
    cp = spawn(process.execPath, [codexBin, "exec", "--cd", sessionDir, "--model", model, "--skip-git-repo-check", "-"], {
      cwd: sessionDir,
      stdio: ["pipe", logFd, logFd],
      windowsHide: true,
      detached: true,
    });
  } finally {
    closeSync(logFd);
  }
  let launchError;
  cp.on("error", err => { launchError = err; });
  cp.stdin.on("error", err => { launchError = err; });
  cp.stdin.end(launchPrompt);
  cp.unref();

  // Only a heartbeat in this exact session confirms the MCP binding.
  const heartbeat = () => { try { return Number(readFileSync(join(sessionDir, ".heartbeat"), "utf8")); } catch { return 0; } };
  while (!(heartbeat() >= startedAt) && Date.now() - startedAt < timeoutSec * 1000) {
    if (launchError) throw launchError;
    if (cp.exitCode !== null || cp.signalCode !== null) throw new Error(`Codex CLI 已退出 (${cp.exitCode ?? cp.signalCode})，参见 ${logPath}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!(heartbeat() >= startedAt)) throw new Error(`目标会话 ${sessionId} 建联超时；后台进程可能仍在运行，参见 ${logPath}`);
  console.log(`✅ 已确认目标会话 ${sessionId} 的 MCP 心跳。日志：${logPath}`);
}

async function cmdResume(sessionId, timeoutSec, model) {
  if (!sessionId) throw new Error("resume 需要 --session <sessionId>");
  const info = await getInfo(sessionId);
  const status = info.agentStatus || {};
  if (["running", "waiting"].includes(status.state)) {
    console.log(`会话 ${sessionId} 已有在线执行端（${status.label}），不需要再拉起；直接用 send/ask 发送消息。`);
    return;
  }
  if (["unknown", "stopping"].includes(status.state)) {
    // A new turn would only wait for the old one here; that cannot be confirmed by a heartbeat.
    throw new Error(`会话 ${sessionId} 状态为「${status.label}」：旧 turn 仍持有任务或尚未确认停止。确认旧 turn 已中断后，先在控制台重置执行端，或用 stop 停止后再 resume。`);
  }
  const session = (info.sessions || []).find(s => s.id === sessionId);
  await launchWorker({ sessionId, sessionName: session?.name || sessionId, sessionDir: join(info.workspace, "sessions", sessionId), timeoutSec, model });
}

async function cmdSpawn(sessionName = "", initialTask = "", timeoutSec = 300, model = DEFAULT_MODEL) {
  const finalName = (sessionName && sessionName.trim()) ? sessionName.trim() : `新会话_${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;

  // 1. 创建新会话
  const createRes = await request("POST", "/api/sessions/create", { name: finalName });
  if (createRes.status !== 200 || !createRes.data.success) {
    throw new Error(`创建新会话失败: ${JSON.stringify(createRes.data)}`);
  }
  const session = createRes.data.session;
  const sessionId = session.id;
  const sessionDir = createRes.data.sessionDir;
  if (typeof sessionDir !== "string" || !isAbsolute(sessionDir)) {
    throw new Error("服务端没有返回绝对会话目录；请更新并重启 6pro-agent 服务后重试，不能使用当前界面会话兜底。");
  }
  console.log(`\n✨ 已创建全新会话: 【${session.name}】(${sessionId})`);
  console.log(`会话 ID: ${sessionId}`);

  let taskId;
  // 2. 如果提供了初始任务，先将其推入队列
  if (initialTask && initialTask.trim()) {
    taskId = (await sendTask(initialTask.trim(), sessionId, sessionDir)).taskId;
    console.log(`📋 初始任务已加入待办队列（任务 ID: ${taskId}）: "${initialTask.trim()}"`);
  }

  // 3. 后台无头拉起 Codex CLI，向网关发起握手
  await launchWorker({ sessionId, sessionName: session.name, sessionDir, timeoutSec, model });

  // 4. 持续监控与结果提取
  if (initialTask && initialTask.trim()) {
    console.log(`⏳ 正在等待 6Pro 自动建联并完成初始任务 (超时限制: ${timeoutSec}s)...`);
    return await waitForAnswer(sessionId, taskId, timeoutSec, sessionDir);
  } else {
    console.log(`✅ 新会话建联指令已在后台拉起，您可使用 ask-6pro status --session ${sessionId} 查看状态。`);
  }
}

async function cmdHistory(sessionId = "") {
  const info = await getInfo(sessionId);
  console.log(`\n=== 会话历史回复 [${info.activeSessionId || "default"}] ===\n`);
  console.log(info.response || "(暂无回复内容)");
  console.log(`\n=========================================\n`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clock = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

async function cmdWait(sessionId, taskId, timeoutSec) {
  if (!taskId) throw new Error("wait 需要 --task <taskId>");
  const info = await getInfo(sessionId);
  const sId = sessionId || info.activeSessionId || "default";
  return await waitForAnswer(sId, taskId, timeoutSec, join(info.workspace, "sessions", sId));
}

// Streams status changes and whatever the service appends to RESPONSE.md (task and report records)
// for one or more sessions (--session a,b); with several sessions every line is tagged with its ID.
async function cmdWatch(sessionArg, timeoutSec) {
  const ids = sessionArg ? sessionArg.split(",").map(id => id.trim()).filter(Boolean) : [(await getInfo()).activeSessionId || "default"];
  const tag = id => ids.length > 1 ? `[${id}] ` : "";
  const watched = new Map();
  for (const id of ids) watched.set(id, { seen: ((await getInfo(id)).response || "").length, status: "" });
  console.log(`👀 正在监控会话 ${ids.join(", ")} 的新回复（最长 ${timeoutSec} 秒）...`);
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    for (const [id, state] of watched) {
      let info;
      try { info = await getInfo(id); }
      catch (error) {
        if (error.status >= 400 && error.status < 500) throw error;
        continue;
      }
      const status = `${info.agentStatus?.label || info.agentStatus?.state || "未知"}，待办 ${(info.tasks || []).length}`;
      if (status !== state.status) {
        console.log(`[${clock()}] ${tag(id)}状态: ${status}`);
        state.status = status;
      }
      const response = info.response || "";
      if (response.length < state.seen) state.seen = 0; // The history display was cleared.
      if (response.length > state.seen) {
        console.log(response.slice(state.seen).trim().split("\n").map(line => tag(id) + line).join("\n"));
        state.seen = response.length;
      }
    }
    await sleep(2000);
  }
  console.log(`[${clock()}] 监控结束（${timeoutSec} 秒）。`);
}

async function cmdStop(sessionId) {
  if (!sessionId) throw new Error("stop 需要 --session <sessionId>");
  const res = await sendTask("/exit", sessionId);
  console.log(res.stopped ? `✅ 会话 ${sessionId} 当前没有在线执行端，已直接停止。` : `✅ 已请求停止会话 ${sessionId}，执行端将在下次领取任务时确认。`);
}

async function cmdSessions() {
  const res = await request("GET", "/api/sessions");
  if (res.status !== 200) throw new Error(`获取会话列表失败 (HTTP ${res.status})`);
  const labels = { running: "执行中", waiting: "在线待命", stopping: "停止中", unknown: "状态待确认", offline: "离线" };
  for (const s of res.data.sessions) console.log(`${s.id}\t${labels[s.activity] || s.activity}\t待办 ${s.taskCount}\t${s.name}`);
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const option = /^--(session|timeout|task|model)$/.exec(argv[i]);
    if (option && i + 1 < argv.length) options[option[1]] = argv[++i];
    else positional.push(argv[i]);
  }
  return { options, positional };
}

async function main() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] || "status";
  const rest = positional.slice(1);
  const sessionArg = options.session || "";
  const timeoutArg = parseInt(options.timeout, 10) || 300;
  const modelArg = options.model || DEFAULT_MODEL;

  try {
    switch (cmd) {
      case "status":
        await cmdStatus(sessionArg);
        break;
      case "sessions":
        await cmdSessions();
        break;
      case "send":
        await cmdSend(rest.join(" "), sessionArg);
        break;
      case "ask":
        await cmdAsk(rest.join(" "), timeoutArg, sessionArg);
        break;
      case "wait":
        await cmdWait(sessionArg, options.task, timeoutArg);
        break;
      case "watch":
        await cmdWatch(sessionArg, timeoutArg);
        break;
      case "spawn":
        // ask-6pro spawn [sessionName] [initialTask]
        await cmdSpawn(rest[0] || "", rest.slice(1).join(" "), timeoutArg, modelArg);
        break;
      case "resume":
        await cmdResume(sessionArg, timeoutArg, modelArg);
        break;
      case "stop":
        await cmdStop(sessionArg);
        break;
      case "history":
        await cmdHistory(sessionArg);
        break;
      default:
        console.log(`用法:
  ask-6pro sessions                          # 列出所有会话及在线状态
  ask-6pro status [--session <id>]           # 查看会话在线状态与待办队列
  ask-6pro spawn "<会话名称>" ["<初始任务>"]   # 新建会话并拉起一个执行 turn；有初始任务时等待其回复
  ask-6pro resume --session <id>             # 为已有但离线的会话拉起新的执行 turn
  ask-6pro send "<消息>" --session <id>       # 向会话发送消息（不等待），输出任务 ID
  ask-6pro ask "<问题>" --session <id>        # 发送并等待这条消息的回复
  ask-6pro wait --task <taskId> --session <id> # 等待某个任务的回复
  ask-6pro watch --session <id>[,<id>...]    # 持续监控一个或多个会话的新回复与状态变化
  ask-6pro stop --session <id>               # 请求结束会话当前的执行 turn
  ask-6pro history [--session <id>]          # 查看会话完整历史回复

选项:
  --session <sessionId>   指定会话；不指定时使用控制台当前选中的会话
  --timeout <seconds>     等待/监控/建联超时 (默认 300 秒)；超时不会取消任务
  --task <taskId>         wait 使用的任务 ID
  --model <model>         spawn/resume 使用的模型 (默认 ${DEFAULT_MODEL})
`);
    }
  } catch (err) {
    console.error(`\n❌ 执行失败: ${err.message}\n`);
    process.exit(1);
  }
}

main();
