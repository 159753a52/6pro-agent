# 6pro 任务服务一键停止脚本
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "            6Pro 服务一键停止脚本                   " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

# 1. 停止 17888 (6pro 控制台)
$port17888 = Get-NetTCPConnection -LocalPort 17888 -State Listen -ErrorAction SilentlyContinue
if ($port17888) {
    $pid17888 = $port17888[0].OwningProcess
    Stop-Process -Id $pid17888 -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已停止 17888 6pro 控制台服务 (PID: $pid17888)" -ForegroundColor Green
} else {
    Write-Host "[--] 17888 服务未在运行" -ForegroundColor Gray
}

# 2. 停止 17841 (codex-chatgpt-web 调度守护进程)
$port17841 = Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue
if ($port17841) {
    $pid17841 = $port17841[0].OwningProcess
    Stop-Process -Id $pid17841 -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] 已停止 17841 调度服务 (PID: $pid17841)" -ForegroundColor Green
} else {
    Write-Host "[--] 17841 服务未在运行" -ForegroundColor Gray
}

# 3. 停止 tunnel-client (OpenAI MCP 隧道网关)
$tunnelProc = Get-Process -Name "tunnel-client" -ErrorAction SilentlyContinue
if ($tunnelProc) {
    foreach ($p in $tunnelProc) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] 已停止 tunnel-client 进程 (PID: $($p.Id))" -ForegroundColor Green
    }
} else {
    Write-Host "[--] tunnel-client 网关未在运行" -ForegroundColor Gray
}

Write-Host "`n所有 6pro 相关后台服务已安全停止。" -ForegroundColor Yellow
Write-Host "按回车键退出..." -ForegroundColor Gray
[void][System.Console]::ReadLine()