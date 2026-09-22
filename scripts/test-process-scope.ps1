$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\stop-all.ps1", [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'stop-all.ps1 parse failed' }
$predicate = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-SixProProcess' }, $true)
# Load only the predicate; never execute the process-stopping body.
Invoke-Expression $predicate.Extent.Text
$cases = @(
    @{ Name='bun.exe'; ExecutablePath='D:\tools\bun.exe'; CommandLine='bun D:\other\cli.js serve'; Expected=$false },
    @{ Name='node.exe'; ExecutablePath='D:\tools\node.exe'; CommandLine='node D:\other\server.js'; Expected=$false },
    @{ Name='node.exe'; ExecutablePath='D:\tools\node.exe'; CommandLine='node D:\Project\6pro-agent\server.js.bak'; Expected=$false },
    @{ Name='bun.exe'; ExecutablePath='D:\tools\bun.exe'; CommandLine='bun D:\Project\codex-chatgpt-web\dist\runtime\app\cli.js build'; Expected=$false },
    @{ Name='node.exe'; ExecutablePath='D:\tools\node.exe'; CommandLine='node "D:\Project\6pro-agent\server.js"'; Expected=$true },
    @{ Name='bun.exe'; ExecutablePath='D:\tools\bun.exe'; CommandLine='bun D:\Project\codex-chatgpt-web\dist\runtime\app\cli.js serve'; Expected=$true },
    @{ Name='bun.exe'; ExecutablePath='D:\tools\bun.exe'; CommandLine='bun C:\Users\13914\.codex-chatgpt-web\versions\5.0.8-win32-x64\app\cli.js mcp --contract native'; Expected=$true },
    @{ Name='tunnel-client.exe'; ExecutablePath='C:\Users\13914\.codex-chatgpt-web\bin\tunnel-client.exe'; CommandLine='tunnel-client run --profile other'; Expected=$false }
)
foreach ($case in $cases) {
    if ((Test-SixProProcess ([pscustomobject]$case)) -ne $case.Expected) { throw "Incorrect process match: $($case.CommandLine)" }
}
$null = [System.Management.Automation.Language.Parser]::ParseFile("$PSScriptRoot\start-all.ps1", [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'start-all.ps1 parse failed' }
Write-Host "PASS: $($cases.Count) process-scope cases and both launcher scripts parse successfully."
