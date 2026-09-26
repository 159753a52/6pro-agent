# 6Pro Assistant

6Pro 额度复用交互助手本地控制台。

基于 MCP 工具中继循环机制，在单次 ChatGPT Web 6pro 会话轮次内实现持续交互、任务追加与结果同步。

## 功能特性
- **单轮复用**：利用本地任务中继保持 6pro 会话不终结，支持多步追问与任务连续执行。
- **实时同步**：基于 SSE（Server-Sent Events）实现秒级结果回传与汇报展示。
- **优雅退出**：支持一键 `/exit` 触发完整阶段工作总结并安全交付。

## 快速启动
双击运行 `启动6Pro助手.bat` 或执行：
```bash
bun server.js
```
访问：`http://127.0.0.1:17888`

可选环境变量：`SIXPRO_WORKSPACE`（工作区，默认 `D:\Project\Workspace`）、`SIXPRO_GATEWAY_ROOT`（网关源码目录）、`CODEX_BIN`（`ask-6pro spawn` 使用的 codex.js）、`SIXPRO_MAX_WORKERS`（同时运行的会话上限，默认 2；所有会话共用一个 tunnel，再多容易把它堵坏）。

原 turn 意外中断、会话显示“连接状态待确认”时：点击“重置执行端”把未完成任务退回队首，或直接启动新的 turn——新 turn 会等待并在重置/停止后自动接手，不会白白消耗一次额度。协议细节见 `TASK_PROTOCOL.md`。
