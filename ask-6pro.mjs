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

    req.on("error", (err) => {
      reject(new Error(`无法连接到 6pro 服务 (${BASE_URL}): ${err.message}。请确认 server.js 是否已启动。`));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getInfo(sessionId = "", sessionDir = "") {
  const query = `?${new URLSearchParams({ ...(sessionId ? { session_id: sessionId } : {}), ...(sessionDir ? { session_dir: sessionDir } : {}) })}`;
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
  const res = await sendTask(taskText.trim(), sessionId);
  console.log(`✅ 任务已成功加入待办队列！`);
  console.log(`当前队列剩余任务数: ${res.tasks.length}`);
}

async function waitForAnswer(sId, questionSnippet, initialLength = 0, timeoutSec = 300, sessionDir = "") {
  const startTime = Date.now();
  let taskPickedUp = false;
  let responseStarted = false;
  let lastResponseLength = initialLength;
  let pollInterval = 1000;

  while (Date.now() - startTime < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, pollInterval));
    try {
      const current = await getInfo(sId, sessionDir);
      const currStatus = current.agentStatus || {};
      const currResponse = current.response || "";
      const currTasks = current.tasks || [];

      // 任务是否已被 6Pro 出队开始执行
      if (!taskPickedUp && (!currTasks.some((t) => t.includes(questionSnippet.slice(0, 20))) || currStatus.state === "busy")) {
        taskPickedUp = true;
        process.stdout.write(`⚡ 6Pro 已出队领取任务，正在深度思考与执行...\n`);
      }

      // 回复是否已经开始写入实质内容
      const incrementalCandidate = currResponse.slice(initialLength);
      const cleanCandidate = extractAnswerText(incrementalCandidate);

      if (cleanCandidate.length > 0) {
        if (!responseStarted) {
          responseStarted = true;
          process.stdout.write(`📝 6Pro 正在持续落盘输出中`);
        } else if (currResponse.length > lastResponseLength) {
          process.stdout.write(`.`);
          lastResponseLength = currResponse.length;
        }
      }

      // 判断执行完成标准：任务已被领走，且 6Pro 已回到 waiting/空闲状态，且已产出实质内容
      if (taskPickedUp && currStatus.state === "waiting" && cleanCandidate.length > 10) {
        // 多等 1.5 秒确认写入完全落盘
        await new Promise((r) => setTimeout(r, 1500));
        const finalInfo = await getInfo(sId, sessionDir);
        const finalResponse = finalInfo.response || "";

        // 提取增量内容
        const incremental = finalResponse.slice(initialLength).trim();

        console.log(`\n\n=== 6Pro 回复完成 (耗时: ${Math.round((Date.now() - startTime) / 1000)}s) ===\n`);
        const cleanAnswer = extractAnswerText(incremental);
        console.log(cleanAnswer);
        console.log(`\n===============================================\n`);
        return cleanAnswer;
      }
    } catch (error) {
      if (error.status === 409) throw error;
      // 临时网络重试
    }
  }

  throw new Error(`等待 6Pro 响应超时 (${timeoutSec}秒)。您可以稍后使用 'ask-6pro history' 查看是否已产出。`);
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

  const initialResponse = initInfo.response || "";
  const initialLength = initialResponse.length;

  console.log(`\n🚀 正在向 6Pro 提问 [会话: ${sId}]...`);
  console.log(`❓ 问题: ${question}`);
  await sendTask(question.trim(), sId, sessionDir);
  console.log(`⏳ 任务已入队，等待 6Pro 领取并开始推理...\n`);

  return await waitForAnswer(sId, question.trim(), initialLength, timeoutSec, sessionDir);
}

function buildLaunchPrompt(sessionName, sessionId) {
  return `你当前已绑定本地会话【${sessionName}】（Session ID: ${sessionId}）。
当前工作目录就是此会话目录；不要再拼接 sessions/${sessionId}/。

【任务执行与协同规范】
1. 任务流转与状态同步：通过 MCP 工具 codex_fetch_next_task 与本地工作区保持同步。
   - 调用参数：必须传入 session_id="${sessionId}"，step_summary 仅传入简短状态标识（如 "Idle", "Poll", "Done"）。
2. 单次独立调用：每次由模型自身发起单次独立的工具调用，等待返回后再进行下一步。
3. 成果直接落盘：完成任务时通过 codex_fetch_next_task 的 response_text 参数提交成果，由服务端追加到绑定会话的 RESPONSE.md，不要自行选择回复路径。
4. 持续协同监听：只要 has_next 为 true，在完成当前阶段任务并落盘后，请继续调用 codex_fetch_next_task 接收下一条指令。
5. 退出通道：当 codex_fetch_next_task 返回 has_next=false（用户输入 /exit）时，输出最终总结并结束本轮。
现在请调用 codex_fetch_next_task(session_id="${sessionId}", step_summary="Idle") 获取首个任务或进入待命状态。`;
}

async function cmdSpawn(sessionName = "", initialTask = "", timeoutSec = 300) {
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

  // 2. 如果提供了初始任务，先将其推入队列
  if (initialTask && initialTask.trim()) {
    await sendTask(initialTask.trim(), sessionId, sessionDir);
    console.log(`📋 初始任务已加入待办队列: "${initialTask.trim()}"`);
  }

  // 3. 构建专属启动词
  const launchPrompt = buildLaunchPrompt(session.name, sessionId);

  // 4. 后台无头拉起 Codex CLI，向网关发起握手
  console.log(`🚀 正在通过无头模式拉起 Codex CLI (chatgpt-web/high)...`);
  const codexBin = "D:\\tools\\nodejs\\node_modules\\@openai\\codex\\bin\\codex.js";
  const logPath = join(sessionDir, "codex-cli.log");
  const logFd = openSync(logPath, "a");
  const startedAt = Date.now();
  let cp;
  try {
    cp = spawn(process.execPath, [codexBin, "exec", "--cd", sessionDir, "--model", "chatgpt-web/high", "--skip-git-repo-check", "-"], {
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

  // Only a heartbeat in this exact new session confirms the MCP binding.
  while (Date.now() - startedAt < timeoutSec * 1000) {
    if (launchError) throw launchError;
    if (cp.exitCode !== null || cp.signalCode !== null) throw new Error(`Codex CLI 已退出 (${cp.exitCode ?? cp.signalCode})，参见 ${logPath}`);
    let heartbeat = 0;
    try { heartbeat = Number(readFileSync(join(sessionDir, ".heartbeat"), "utf8")); } catch {}
    if (Number.isFinite(heartbeat) && heartbeat >= startedAt) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  let heartbeat = 0;
  try { heartbeat = Number(readFileSync(join(sessionDir, ".heartbeat"), "utf8")); } catch {}
  if (!Number.isFinite(heartbeat) || heartbeat < startedAt) throw new Error(`目标会话 ${sessionId} 建联超时；后台进程可能仍在运行，参见 ${logPath}`);
  console.log(`✅ 已确认目标会话 ${sessionId} 的 MCP 心跳。日志：${logPath}`);

  // 5. 持续监控与结果提取
  if (initialTask && initialTask.trim()) {
    console.log(`⏳ 正在等待 6Pro 自动建联并完成初始任务 (超时限制: ${timeoutSec}s)...`);
    return await waitForAnswer(sessionId, initialTask.trim(), 0, timeoutSec, sessionDir);
  } else {
    console.log(`✅ 新会话建联指令已在后台拉起，您可使用 ask-6pro status --session ${sessionId} 查看状态。`);
  }
}

function extractAnswerText(text) {
  if (!text) return "";
  let clean = text.replace(/###\s*用户任务\s*\[[0-9:]*\][\s\S]*?(?=###\s*阶段汇报|$)/g, "");
  clean = clean.replace(/###\s*阶段汇报\s*\[[0-9:]*\]/g, "");
  clean = clean.replace(/^(?:(?:Done|Step complete|阶段任务已完成)[,\s]*)?(?:see|详见)\s*(?:本地\s*)?RESPONSE\.md\s*$/gim, "");
  return clean.trim();
}

async function cmdHistory(sessionId = "") {
  const info = await getInfo(sessionId);
  console.log(`\n=== 会话历史回复 [${info.activeSessionId || "default"}] ===\n`);
  console.log(info.response || "(暂无回复内容)");
  console.log(`\n=========================================\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || "status";

  let sessionArg = "";
  const sessIdx = args.indexOf("--session");
  if (sessIdx !== -1 && args[sessIdx + 1]) {
    sessionArg = args[sessIdx + 1];
  }

  let timeoutArg = 300;
  const timeoutIdx = args.indexOf("--timeout");
  if (timeoutIdx !== -1 && args[timeoutIdx + 1]) {
    timeoutArg = parseInt(args[timeoutIdx + 1], 10) || 300;
  }

  try {
    switch (cmd) {
      case "status":
        await cmdStatus(sessionArg);
        break;
      case "send": {
        const text = args.filter((a, i) => i > 0 && a !== "--session" && args[i - 1] !== "--session" && a !== "--timeout" && args[i - 1] !== "--timeout").join(" ");
        await cmdSend(text, sessionArg);
        break;
      }
      case "ask": {
        const text = args.filter((a, i) => i > 0 && a !== "--session" && args[i - 1] !== "--session" && a !== "--timeout" && args[i - 1] !== "--timeout").join(" ");
        await cmdAsk(text, timeoutArg, sessionArg);
        break;
      }
      case "spawn": {
        // ask-6pro spawn [sessionName] [initialTask]
        const nonOptions = args.slice(1).filter((a, i, arr) => a !== "--session" && arr[i - 1] !== "--session" && a !== "--timeout" && arr[i - 1] !== "--timeout");
        const name = nonOptions[0] || "";
        const task = nonOptions.slice(1).join(" ") || "";
        await cmdSpawn(name, task, timeoutArg);
        break;
      }
      case "history":
        await cmdHistory(sessionArg);
        break;
      default:
        console.log(`用法:
  ask-6pro status                     # 查看 6pro 在线保活状态与队列
  ask-6pro spawn "<会话名称>" ["<任务>"] # 一键新建会话、新开网页对话、拉起终端并监控
  ask-6pro send "<任务内容>"           # 异步下发任务到待办队列
  ask-6pro ask "<问题内容>"            # 一键提问当前会话，阻塞等待并提取回复
  ask-6pro history                    # 查看会话完整历史回复

选项:
  --session <sessionId>               # 指定操作的会话 ID
  --timeout <seconds>                 # 设置等待超时时间 (默认 300 秒)
`);
    }
  } catch (err) {
    console.error(`\n❌ 执行失败: ${err.message}\n`);
    process.exit(1);
  }
}

main();
