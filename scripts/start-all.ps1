$ErrorActionPreference = 'Stop'
$restartMutex = New-Object System.Threading.Mutex($false, 'Local\SixProServiceRestart')
$restartOwned = $false
try {
    try { $restartOwned = $restartMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $restartOwned = $true }
    if (!$restartOwned) { Write-Host '6pro 正在启动，请勿重复点击。'; return }
# 6pro 任务服务一键启动脚本
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "        6Pro & ChatGPT Web 一键启动服务检查          " -ForegroundColor Cyan
Write-Host "====================================================" -ForegroundColor Cyan

$bunExe = "C:\Users\13914\.codex-chatgpt-web\versions\5.0.8-win32-x64\runtime\bun.exe"
$cliJs = "D:\Project\codex-chatgpt-web\dist\runtime\app\cli.js"
$tunnelBin = "C:\Users\13914\.codex-chatgpt-web\bin\tunnel-client.exe"
$tunnelProfiles = "C:\Users\13914\.codex-chatgpt-web\tunnel\profiles"
$serverJs = "D:\Project\6pro-agent\server.js"
$electronExe = "C:\Users\13914\AppData\Local\Programs\Codex Web GPT\Codex Web GPT.exe"

foreach ($required in @($bunExe, $cliJs, $tunnelBin, $serverJs, $electronExe, 'D:\tools\nodejs\node.exe')) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少启动文件: $required" }
}
$sourceRoot = 'D:\Project\codex-chatgpt-web\src'
$newestSource = Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if ($newestSource.LastWriteTimeUtc -gt (Get-Item -LiteralPath $cliJs).LastWriteTimeUtc) {
    throw '网关源码比构建产物新。为避免新旧协议混用，尚未停止现有服务。请先在 D:\Project\codex-chatgpt-web 执行 bun run build，再点击启动。'
}
Write-Host "正在停止旧的 6pro 服务..." -ForegroundColor Yellow
& "$PSScriptRoot\stop-all.ps1" -NoPause
foreach ($servicePort in @(17841, 17888)) {
    if (Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $servicePort 仍被占用；未关闭不属于 6pro 的进程。"
    }
}

# 1. 检查 Codex Web GPT 桌面端 (持有 ChatGPT 登录态)
Write-Host "`n[1/4] 检查 Codex Web GPT 桌面端..." -ForegroundColor Yellow
$electronProc = Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue
if ($electronProc) {
    Write-Host "  -> [OK] Codex Web GPT 客户端已在运行 (PID: $($electronProc[0].Id))" -ForegroundColor Green
} else {
    Write-Host "  -> [启动] 正在启动 Codex Web GPT 桌面客户端..." -ForegroundColor Magenta
    Start-Process -FilePath $electronExe -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host "  -> [OK] Codex Web GPT 客户端启动成功" -ForegroundColor Green
}

# 2. 检查 17841 端口 (codex-chatgpt-web serve 守护进程)
Write-Host "`n[2/4] 检查 17841 隧道调度服务..." -ForegroundColor Yellow
$port17841 = Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue
if ($port17841) {
    Write-Host "  -> [OK] 17841 调度服务已在运行 (PID: $($port17841[0].OwningProcess))" -ForegroundColor Green
} else {
    Write-Host "  -> [启动] 正在后台启动 17841 调度服务..." -ForegroundColor Magenta
    Start-Process -FilePath $bunExe -ArgumentList "`"$cliJs`"", "serve" -WindowStyle Hidden
    
    $ready = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        $port17841 = Get-NetTCPConnection -LocalPort 17841 -State Listen -ErrorAction SilentlyContinue
        if ($port17841) { $ready = $true; break }
    }
    if ($ready) {
        Write-Host "  -> [OK] 17841 调度服务启动成功 (PID: $($port17841[0].OwningProcess))" -ForegroundColor Green
    } else {
        throw "17841 调度服务启动失败，请检查日志"
    }
}

# 3. 检查 OpenAI MCP 隧道网关 (tunnel-client)
Write-Host "`n[3/4] 检查 OpenAI MCP 隧道网关..." -ForegroundColor Yellow
$tunnelProc = Get-Process -Name "tunnel-client" -ErrorAction SilentlyContinue
if ($tunnelProc) {
    Write-Host "  -> [OK] MCP 隧道网关已在运行 (PID: $($tunnelProc[0].Id))" -ForegroundColor Green
} else {
    Write-Host "  -> [启动] 正在后台启动 OpenAI MCP 隧道网关..." -ForegroundColor Magenta
    Start-Process -FilePath $tunnelBin -ArgumentList "run", "--profile-dir", "`"$tunnelProfiles`"", "--profile", "codex-chatgpt-web" -WindowStyle Hidden
    Start-Sleep -Seconds 1
    $tunnelProc = Get-Process -Name "tunnel-client" -ErrorAction SilentlyContinue
    if ($tunnelProc) {
        Write-Host "  -> [OK] MCP 隧道网关启动成功 (PID: $($tunnelProc[0].Id))" -ForegroundColor Green
    } else {
        throw "MCP 隧道启动失败，请检查日志"
    }
}

# 4. 检查 17888 端口 (6pro-agent 控制台)
Write-Host "`n[4/4] 检查 17888 6pro 控制台服务..." -ForegroundColor Yellow
$port17888 = Get-NetTCPConnection -LocalPort 17888 -State Listen -ErrorAction SilentlyContinue
if ($port17888) {
    Write-Host "  -> [OK] 17888 控制台已在运行 (PID: $($port17888[0].OwningProcess))" -ForegroundColor Green
} else {
    Write-Host "  -> [启动] 正在后台启动 6pro 控制台服务..." -ForegroundColor Magenta
    Start-Process -FilePath "D:\tools\nodejs\node.exe" -ArgumentList "`"$serverJs`"" -WorkingDirectory "D:\Project\6pro-agent" -WindowStyle Hidden
    
    $ready = $false
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        $port17888 = Get-NetTCPConnection -LocalPort 17888 -State Listen -ErrorAction SilentlyContinue
        if ($port17888) { $ready = $true; break }
    }
    if ($ready) {
        Write-Host "  -> [OK] 17888 控制台启动成功 (PID: $($port17888[0].OwningProcess))" -ForegroundColor Green
    } else {
        throw "17888 控制台启动失败，请检查日志"
    }
}

Write-Host "`n====================================================" -ForegroundColor Cyan
Write-Host "        所有服务已就绪！正在打开 6pro 控制台...        " -ForegroundColor Green
Write-Host "        访问地址: http://127.0.0.1:17888             " -ForegroundColor White
Write-Host "====================================================" -ForegroundColor Cyan

Start-Process "http://127.0.0.1:17888"

Write-Host "`n提示：所有后台服务已保持常驻运行，可安全关闭本窗口。" -ForegroundColor Gray
} catch {
    Write-Host "启动失败: $($_.Exception.Message)" -ForegroundColor Red
    [void](Read-Host '按回车关闭窗口')
    exit 1
} finally {
    if ($restartOwned) { $restartMutex.ReleaseMutex() }
    $restartMutex.Dispose()
}
