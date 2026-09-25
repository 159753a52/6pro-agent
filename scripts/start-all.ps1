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

$gatewayRoot = "D:\Project\codex-chatgpt-web"
$distRuntime = "$gatewayRoot\dist\runtime"
$stagingRuntime = "$gatewayRoot\dist\runtime-next"
$bunExe = "$distRuntime\runtime\bun.exe"
$cliJs = "$distRuntime\app\cli.js"
$tunnelBin = "C:\Users\13914\.codex-chatgpt-web\bin\tunnel-client.exe"
$tunnelProfiles = "C:\Users\13914\.codex-chatgpt-web\tunnel\profiles"
$serverJs = "D:\Project\6pro-agent\server.js"
$electronExe = "C:\Users\13914\AppData\Local\Programs\Codex Web GPT\Codex Web GPT.exe"
$launcherDescriptor = "C:\Users\13914\.codex-chatgpt-web\runtime\launcher-browser.json"
$launcherFatalLog = "C:\Users\13914\AppData\Roaming\Codex Web GPT\logs\launcher-fatal.log"

foreach ($required in @($tunnelBin, $serverJs, $electronExe, 'D:\tools\nodejs\node.exe')) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "缺少启动文件: $required" }
}

# The desktop app loads resources\runtime and installs a copy under versions\ for the MCP tunnel. It
# accepts a runtime only when its manifest names the app's version and every file matches that
# manifest, so whole bundles are deployed: a file copied in on its own makes the app exit at startup.
$launcherVersion = ((Get-Item -LiteralPath $electronExe).VersionInfo.ProductVersion -split '\.')[0..2] -join '.'
$launcherRuntime = "C:\Users\13914\AppData\Local\Programs\Codex Web GPT\resources\runtime"
$installedRuntime = "C:\Users\13914\.codex-chatgpt-web\versions\$launcherVersion-win32-x64"

function Read-RuntimeManifest($root) {
    $file = Join-Path $root 'manifest.json'
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { return $null }
    $text = [IO.File]::ReadAllText($file)
    $manifest = @{ appVersion = ''; bundleId = ''; entries = @{} }
    if ($text -match '"appVersion":\s*"([^"]+)"') { $manifest.appVersion = $Matches[1] }
    if ($text -match '"bundleId":\s*"([0-9a-f]{64})"') { $manifest.bundleId = $Matches[1] }
    foreach ($entry in @('app/cli.js', 'app/browser-helper.cjs')) {
        if ($text -match ('"path":\s*"' + [regex]::Escape($entry) + '",\s*"size":\s*\d+,\s*"sha256":\s*"([0-9a-f]{64})"')) {
            $manifest.entries[$entry] = $Matches[1]
        }
    }
    return $manifest
}

# Current means the same bundle manifest and unmodified entry points (the files patched by hand before).
function Test-RuntimeCurrent($root, $bundle) {
    $installed = Read-RuntimeManifest $root
    if (!$installed -or $installed.bundleId -ne $bundle.bundleId) { return $false }
    foreach ($entry in $bundle.entries.Keys) {
        $path = Join-Path $root $entry
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $bundle.entries[$entry]) { return $false }
    }
    return $true
}

# The console and the MCP gateway must run the same queue protocol implementation.
$storeTexts = @('D:\Project\6pro-agent\lib\task-store.cjs', "$gatewayRoot\src\adapters\chatgpt-web\task-store.cjs") |
    ForEach-Object { [IO.File]::ReadAllText($_) -replace "`r`n", "`n" }
if ($storeTexts[0] -cne $storeTexts[1]) {
    throw '6pro-agent 与网关的 task-store.cjs 不一致，两份必须相同。请先同步这两个文件；现有服务未停止。'
}

# A stale gateway is rebuilt into a staging directory while the current services keep running.
$newestInput = @("$gatewayRoot\src", "$gatewayRoot\package.json", "$gatewayRoot\bun.lock", "$gatewayRoot\scripts\build-runtime-bundle.ts") |
    ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Container) { Get-ChildItem -LiteralPath $_ -Recurse -File } else { Get-Item -LiteralPath $_ } } |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$bundleSource = $distRuntime
if (!(Test-Path -LiteralPath "$distRuntime\manifest.json" -PathType Leaf) -or
    $newestInput.LastWriteTimeUtc -gt (Get-Item -LiteralPath "$distRuntime\manifest.json").LastWriteTimeUtc) {
    $buildBun = @($bunExe, "$installedRuntime\runtime\bun.exe", "$launcherRuntime\runtime\bun.exe") |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (!$buildBun) { throw '找不到用于构建网关的 bun.exe；现有服务未停止。' }
    Write-Host "`n网关源码有更新，正在重新构建（约 1 分钟，现有服务继续运行）..." -ForegroundColor Yellow
    $ErrorActionPreference = 'Continue'
    $buildOutput = & $buildBun "$gatewayRoot\scripts\build-runtime-bundle.ts" $stagingRuntime 2>&1
    $buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($buildExitCode -ne 0) {
        throw "网关构建失败，现有服务未停止：`n$(($buildOutput | Select-Object -Last 15 | ForEach-Object { "$_" }) -join "`n")"
    }
    $bundleSource = $stagingRuntime
}
$bundle = Read-RuntimeManifest $bundleSource
if (!$bundle -or !$bundle.bundleId -or $bundle.entries.Count -ne 2 -or !(Test-RuntimeCurrent $bundleSource $bundle)) {
    throw "网关运行时构建不完整: $bundleSource；现有服务未停止。"
}
if ($bundle.appVersion -ne $launcherVersion) {
    throw "网关构建版本 $($bundle.appVersion) 与 Codex Web GPT 桌面端 $launcherVersion 不一致，桌面端会拒绝加载；现有服务未停止。"
}
$staleRuntimes = @(@($distRuntime, $launcherRuntime, $installedRuntime) | Where-Object { $_ -ne $bundleSource -and !(Test-RuntimeCurrent $_ $bundle) })

Write-Host "正在停止旧的 6pro 服务..." -ForegroundColor Yellow
& "$PSScriptRoot\stop-all.ps1" -NoPause
foreach ($servicePort in @(17841, 17888)) {
    if (Get-NetTCPConnection -LocalPort $servicePort -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $servicePort 仍被占用；未关闭不属于 6pro 的进程。"
    }
}

# Every copy gets the same bundle; /IS /IT also replaces files that only look unchanged.
foreach ($runtime in $staleRuntimes) {
    Write-Host "  -> 部署网关运行时 $($bundle.bundleId.Substring(0, 12)): $runtime" -ForegroundColor Magenta
    $null = robocopy $bundleSource $runtime /MIR /IS /IT /MT:16 /R:3 /W:1 /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "部署网关运行时失败 (robocopy $LASTEXITCODE): $runtime" }
    if (!(Test-RuntimeCurrent $runtime $bundle)) { throw "部署后的运行时仍与清单不一致: $runtime" }
}
if ($bundleSource -eq $stagingRuntime) { Remove-Item -LiteralPath $stagingRuntime -Recurse -Force }

# 1. 检查 Codex Web GPT 桌面端 (持有 ChatGPT 登录态)
Write-Host "`n[1/4] 检查 Codex Web GPT 桌面端..." -ForegroundColor Yellow
$launcherStartedAt = $null
$electronProc = Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue
if ($electronProc) {
    Write-Host "  -> [OK] Codex Web GPT 客户端已在运行 (PID: $($electronProc[0].Id))" -ForegroundColor Green
} else {
    Write-Host "  -> [启动] 正在启动 Codex Web GPT 桌面客户端..." -ForegroundColor Magenta
    $launcherStartedAt = Get-Date
    Start-Process -FilePath $electronExe -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host "  -> [OK] Codex Web GPT 客户端已拉起，稍后确认它通过运行时校验" -ForegroundColor Green
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

# The desktop app publishes its browser host only after its runtime check passes; it exits otherwise.
if ($launcherStartedAt) {
    # It hashes every runtime file; on this machine that took about 2.5 minutes right after a deployment.
    Write-Host "`n[检查] 等待 Codex Web GPT 完成运行时校验（刚部署过会慢一些，最多 6 分钟）..." -ForegroundColor Yellow
    $launcherPid = $null
    while (!$launcherPid -and (Get-Date) -lt $launcherStartedAt.AddMinutes(6)) {
        if ((Test-Path -LiteralPath $launcherDescriptor) -and (Get-Item -LiteralPath $launcherDescriptor).LastWriteTime -ge $launcherStartedAt) {
            $candidate = ([IO.File]::ReadAllText($launcherDescriptor) | ConvertFrom-Json).pid
            if ($candidate -and (Get-Process -Id $candidate -ErrorAction SilentlyContinue)) { $launcherPid = $candidate }
        }
        if (!$launcherPid) {
            if (!(Get-Process -Name "Codex Web GPT" -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 500
        }
    }
    if (!$launcherPid) {
        $fatal = '没有新的崩溃记录'
        if ((Test-Path -LiteralPath $launcherFatalLog) -and (Get-Item -LiteralPath $launcherFatalLog).LastWriteTime -ge $launcherStartedAt) {
            $fatal = (Get-Content -LiteralPath $launcherFatalLog -Tail 3) -join "`n"
        }
        throw "Codex Web GPT 桌面端没有正常启动：`n$fatal"
    }
    Write-Host "  -> [OK] 桌面端运行时校验通过 (PID: $launcherPid)" -ForegroundColor Green
}
$info = Invoke-RestMethod -Uri "http://127.0.0.1:17888/api/info" -UseBasicParsing -TimeoutSec 10
Write-Host "  -> 任务协议 $($info.runtime.taskProtocol)，网关运行时 $($bundle.bundleId.Substring(0, 12))" -ForegroundColor Green

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
