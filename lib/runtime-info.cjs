const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROTOCOL_VERSION } = require('./task-store.cjs');
const root = path.resolve(__dirname, '..');
const startedAt = new Date().toISOString();
const serverFile = path.join(root, fs.existsSync(path.join(root, 'server.js')) ? 'server.js' : 'server.cjs');
function revision() {
  const hash = crypto.createHash('sha256');
  for (const file of [serverFile, __filename, path.join(__dirname, 'task-store.cjs')]) hash.update(fs.readFileSync(file));
  return hash.digest('hex').slice(0, 12);
}
const loadedRevision = revision();
let cached;
let checkedAt = 0;
function latestSourceTime(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? latestSourceTime(file) : fs.statSync(file).mtimeMs);
  }
  return latest;
}
function runtimeInfo() {
  if (cached && Date.now() - checkedAt < 5000) return cached;
  let gatewayBuild = 'unknown';
  let gatewayBuiltAt = null;
  try {
    const gatewayRoot = process.env.SIXPRO_GATEWAY_ROOT || 'D:/Project/codex-chatgpt-web';
    const bundle = fs.statSync(path.join(gatewayRoot, 'dist/runtime/app/cli.js'));
    gatewayBuiltAt = bundle.mtime.toISOString();
    gatewayBuild = latestSourceTime(path.join(gatewayRoot, 'src')) > bundle.mtimeMs ? 'needs_build' : 'built';
  } catch {}
  const diskRevision = revision();
  checkedAt = Date.now();
  return cached = { startedAt, loadedRevision, needsRestart: diskRevision !== loadedRevision,
    taskProtocol: PROTOCOL_VERSION, gatewayBuild, gatewayBuiltAt,
    gatewayBuildNote: '构建提示按源码与构建文件时间比较；不代表已运行的网关已更新。' };
}
module.exports = { runtimeInfo };
