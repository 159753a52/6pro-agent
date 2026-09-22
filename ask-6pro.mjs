#!/usr/bin/env node
/**
 * 6Pro Agent CLI - 直接在终端下发任务、查询状态、一键向 6Pro 提问并等待回复
 * 既可由开发者直接在终端运行，也可供 Antigravity / Codex Subagent 作为工具直接调用
 */

import http from "node:http";

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

async function getInfo(sessionId = "") {
  const query = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
  const res = await request("GET", `/api/info${query}`);
  if (res.status !== 200) {
    throw new Error(`获取信息失败 (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function sendTask(taskText, sessionId = "") {
  const res = await request("POST", "/api/add-task", {
    task: taskText,
    session_id: sessionId || undefined,
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

async function cmdAsk(question, timeoutSec = 300, sessionId = "") {
  if (!question || !question.trim()) {
    console.error("错误: 请提供提问内容。例如: ask-6pro ask \"请解释下这段代码怎么优化\"");
    process.exit(1);
  }

  // 1. 获取当前基础信息
  const initInfo = await getInfo(sessionId);
  const sId = sessionId || initInfo.activeSessionId || "default";
  const status = initInfo.agentStatus || {};

  if (status.state === "offline") {
    console.warn(`⚠️ 警告: 6Pro 当前似乎未在线 (状态: ${status.label})。`);
    console.warn(`提示: 请在网页端 ChatGPT 发送启动词激活此会话后再试。`);
  }

  const initialResponse = initInfo.response || "";
  const initialLength = initialResponse.length;

  console.log(`\n🚀 正在向 6Pro 提问 [会话: ${sId}]...`);
  console.log(`❓ 问题: ${question}`);
  await sendTask(question.trim(), sId);
  console.log(`⏳ 任务已入队，等待 6Pro 领取并开始推理...\n`);

  const startTime = Date.now();
  let taskPickedUp = false;
  let responseStarted = false;
  let lastResponseLength = initialLength;
  let pollInterval = 1000;

  while (Date.now() - startTime < timeoutSec * 1000) {
    await new Promise((r) => setTimeout(r, pollInterval));
    try {
      const current = await getInfo(sId);
      const currStatus = current.agentStatus || {};
      const currResponse = current.response || "";
      const currTasks = current.tasks || [];

      // 任务是否已被 6Pro 出队开始执行
      if (!taskPickedUp && (!currTasks.some((t) => t.includes(question.trim().slice(0, 20))) || currStatus.state === "busy")) {
        taskPickedUp = true;
        process.stdout.write(`⚡ 6Pro 已领取任务，正在深度思考与执行...\n`);
      }

      // 回复是否已经开始写入 RESPONSE.md
      if (currResponse.length > initialLength) {
        if (!responseStarted) {
          responseStarted = true;
          process.stdout.write(`📝 6Pro 正在持续写盘输出中`);
        } else if (currResponse.length > lastResponseLength) {
          process.stdout.write(`.`);
          lastResponseLength = currResponse.length;
        }
      }

      // 判断执行完成标准：任务已被领走，且 6Pro 已回到 waiting/空闲状态，或者输出不再增长且有阶段汇报
      if (taskPickedUp && currStatus.state === "waiting" && currResponse.length > initialLength) {
        // 多等 1 秒确认写入完全落盘
        await new Promise((r) => setTimeout(r, 1000));
        const finalInfo = await getInfo(sId);
        const finalResponse = finalInfo.response || "";

        // 提取增量内容
        const incremental = finalResponse.slice(initialLength).trim();

        console.log(`\n\n=== 6Pro 回复完成 (耗时: ${Math.round((Date.now() - startTime) / 1000)}s) ===\n`);
        // 过滤掉用户任务和阶段汇报等标记，提炼出正文
        const cleanAnswer = extractAnswerText(incremental);
        console.log(cleanAnswer);
        console.log(`\n===============================================\n`);
        return cleanAnswer;
      }
    } catch (e) {
      // 临时网络重试
    }
  }

  throw new Error(`等待 6Pro 响应超时 (${timeoutSec}秒)。您可以稍后使用 'ask-6pro history' 查看是否已产出。`);
}

function extractAnswerText(text) {
  if (!text) return "";
  // 去除可能的 ### 用户任务 块
  let clean = text.replace(/###\s*用户任务\s*\[[0-9:]*\][\s\S]*?(?=###\s*阶段汇报|$)/g, "");
  // 去除 ### 阶段汇报 标题行
  clean = clean.replace(/###\s*阶段汇报\s*\[[0-9:]*\]/g, "");
  // 去除冗余的 Done, see RESPONSE.md
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

  // 解析通用参数 --session <id>
  let sessionArg = "";
  const sessIdx = args.indexOf("--session");
  if (sessIdx !== -1 && args[sessIdx + 1]) {
    sessionArg = args[sessIdx + 1];
  }

  try {
    switch (cmd) {
      case "status":
        await cmdStatus(sessionArg);
        break;
      case "send": {
        const text = args.filter((a, i) => i > 0 && a !== "--session" && args[i - 1] !== "--session").join(" ");
        await cmdSend(text, sessionArg);
        break;
      }
      case "ask": {
        const text = args.filter((a, i) => i > 0 && a !== "--session" && args[i - 1] !== "--session").join(" ");
        await cmdAsk(text, 300, sessionArg);
        break;
      }
      case "history":
        await cmdHistory(sessionArg);
        break;
      default:
        console.log(`用法:
  ask-6pro status                     # 查看 6pro 在线保活状态与队列
  ask-6pro send "<任务内容>"           # 异步下发任务到待办队列
  ask-6pro ask "<问题内容>"            # 一键提问，阻塞等待并提取 6pro 完整答复
  ask-6pro history                    # 查看当前会话完整历史回复

选项:
  --session <sessionId>               # 指定操作的会话 ID (默认当前活跃会话)
`);
    }
  } catch (err) {
    console.error(`\n❌ 执行失败: ${err.message}\n`);
    process.exit(1);
  }
}

main();
