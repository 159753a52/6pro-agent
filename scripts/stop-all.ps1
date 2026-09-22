# Stop only processes owned by this 6pro installation.
[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$NoPause)
$ErrorActionPreference = 'Stop'

function Test-SixProProcess($Process) {
    $exe = $Process.ExecutablePath
    $command = $Process.CommandLine
    if ($exe -eq 'C:\Users\13914\AppData\Local\Programs\Codex Web GPT\Codex Web GPT.exe') { return $true }
    if ($exe -eq 'C:\Users\13914\.codex-chatgpt-web\bin\tunnel-client.exe') {
        return $command -match '--profile\s+"?codex-chatgpt-web"?(?:\s|$)'
    }
    if ($Process.Name -eq 'node.exe') {
        return $command -match '(?:^|[\s"])D:\\Project\\6pro-agent\\server\.js(?:"|\s|$)'
    }
    if ($Process.Name -eq 'bun.exe') {
        return $command -match '(?:^|[\s"])(?:D:\\Project\\codex-chatgpt-web\\dist\\runtime\\app|C:\\Users\\13914\\\.codex-chatgpt-web\\versions\\[^\\]+\\app)\\cli\.js"?\s+(?:serve|mcp)(?:\s|$)'
    }
    return $false
}

# Stop the app/tunnel first so they cannot respawn a worker we just stopped.
$targets = @(Get-CimInstance Win32_Process | Where-Object { Test-SixProProcess $_ } |
    Sort-Object @{ Expression = { if ($_.Name -eq 'Codex Web GPT.exe') { 0 } elseif ($_.Name -eq 'tunnel-client.exe') { 1 } else { 2 } } })
foreach ($target in $targets) {
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)"
    if (!$current -or $current.CreationDate -ne $target.CreationDate -or !(Test-SixProProcess $current)) { continue }
    if ($PSCmdlet.ShouldProcess("$($target.Name) PID $($target.ProcessId)", 'Stop 6pro process')) {
        $running = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
        if ($running) {
            $running.Kill()
            if (!$running.WaitForExit(10000)) { throw "Process $($target.ProcessId) did not stop" }
        }
    }
}
if (!$NoPause) { [void](Read-Host 'Press Enter to close') }
