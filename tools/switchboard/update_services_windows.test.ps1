$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'update_services_windows.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-Captured'
}, $true)
. ([scriptblock]::Create($function.Extent.Text))
$script:stopped = @()
function Get-CimInstance { $script:live }
function Stop-Process([int]$Id) { $script:stopped += $Id }
function Wait-Process {}
$started = [DateTime]::UtcNow
$identity = [pscustomobject]@{id=123; started=$started.ToString('o')}
$script:live = [pscustomobject]@{ProcessId=123; CreationDate=$started; CommandLine='zellij.exe serve --port 80'}
Stop-Captured $identity '\bserve\b'
if ($script:stopped.Count -ne 1) { throw 'Expected exactly one service stop' }
foreach ($command in @('zellij.exe --server main', 'zellij.exe serve --server main', 'unrelated.exe')) {
    $script:live.CommandLine = $command
    $rejected = $false
    try { Stop-Captured $identity '\bserve\b' } catch { $rejected = $true }
    if (!$rejected) { throw "Unexpected process allowed: $command" }
}
$script:live.CommandLine = 'zellij.exe serve --port 80'
$script:live.CreationDate = $started.AddSeconds(1)
$rejected = $false
try { Stop-Captured $identity '\bserve\b' } catch { $rejected = $true }
if (!$rejected -or $script:stopped.Count -ne 1) { throw 'Reused PID was stopped' }
$script:live.CreationDate = $started
$script:live.CommandLine = 'powershell.exe "-File" "C:\switchboard-tray.ps1" "-Tray"'
Stop-Captured $identity 'switchboard-tray\.ps1.*\s"?-Tray\b'
if ($script:stopped.Count -ne 2) { throw 'Quoted installed tray arguments were not recognized' }
Write-Output 'PASS: captured service stop rejects engines, unrelated processes and reused PIDs'
