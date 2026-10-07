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
function Stop-Process([int]$Id) { throw "Cannot find a process with the process identifier $Id." }
function Get-Process { $null }
$script:live.CommandLine = 'zellij.exe serve --port 80'
Stop-Captured $identity '\bserve\b'
function Get-Process { [pscustomobject]@{Id=123} }
$rejected = $false
try { Stop-Captured $identity '\bserve\b' } catch { $rejected = $true }
if (!$rejected) { throw 'A failed stop of a still-running service was ignored' }
Write-Output 'PASS: captured service stop rejects engines, unrelated processes and reused PIDs, and tolerates a service that already exited'


# Tray identity and settings come from the running tray, not the updater's location.
$module = Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force -PassThru
foreach ($value in @('C:\Users\user\git\dotfiles\zellij\hosts\Dom-PC.kdl', 'C:\dir with space\', 'a\"b')) {
    $line = 'powershell.exe ' + ((@('-File', 'C:\x\switchboard-tray.ps1', '-Tray', '-Config', $value) | ForEach-Object { ConvertTo-SwitchboardArgument $_ }) -join ' ')
    if ((Get-SwitchboardCommandLineValue $line '-Config') -cne $value) { throw "Quoted tray argument not recovered: $value" }
}
$installed = Join-Path ([IO.Path]::GetTempPath()) 'home/.config/switchboard/switchboard-tray.ps1'
$elsewhere = Join-Path ([IO.Path]::GetTempPath()) 'private-test/switchboard-tray.ps1'
$tray = '"powershell.exe" "-NoLogo" "-File" "{0}" "-Tray" "-ReleaseDirectory" "C:\store" "-Config" "C:\hosts\Dom-PC.kdl"'
$processes = @(
    [pscustomobject]@{Name='powershell.exe'; CommandLine=($tray -f $installed.Replace('\','/'))},
    [pscustomobject]@{Name='powershell.exe'; CommandLine=($tray -f $elsewhere)},
    [pscustomobject]@{Name='powershell.exe'; CommandLine='powershell.exe -File C:\Temp\switchboard-abc\install_windows_web.ps1'},
    [pscustomobject]@{Name='zellij.exe'; CommandLine='C:\store\abc\zellij.exe --config C:\hosts\web.kdl web --start'}
)
# Whichever helper copy runs (installed, bundle or test), the tray is the installed one.
$env:SWITCHBOARD_TRAY_SCRIPT = $installed
$found = @(Get-SwitchboardTrays $processes)
if ($found.Count -ne 1 -or $found[0] -ne $processes[0]) { throw 'The installed tray was not identified' }
$arguments = Get-SwitchboardTrayArguments $processes
if ($arguments.config -cne 'C:\hosts\Dom-PC.kdl' -or $arguments.releaseDirectory -cne 'C:\store') { throw "Tray settings not captured: $arguments" }
$arguments = Get-SwitchboardTrayArguments @($processes[2], $processes[3])
if ($arguments.config -cne 'C:\hosts\web.kdl' -or $arguments.releaseDirectory) { throw 'Web service --config was not used without a tray' }

# The replacement tray waits for the old tray's lock and fails loudly without it.
$name = 'Local\SwitchboardTrayTest' + [Guid]::NewGuid().ToString('N')
Wait-SwitchboardMutexRelease $name 1
$pwsh = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$holder = Start-Process -FilePath $pwsh -PassThru -ArgumentList @('-NoProfile', '-Command',
    "`$m = New-Object Threading.Mutex(`$true, '$name'); Start-Sleep 4")
Start-Sleep 2
$rejected = $false
try { Enter-SwitchboardMutex $name 1 | Out-Null } catch { $rejected = $_.Exception.Message -match 'still owns' }
if (!$rejected) { throw 'A second tray started while the first held the lock' }
$rejected = $false
try { Wait-SwitchboardMutexRelease $name 0 } catch { $rejected = $true }
if (!$rejected) { throw 'A held tray lock was reported as released' }
Wait-SwitchboardMutexRelease $name 10
$holder.WaitForExit()
$mutex = Enter-SwitchboardMutex $name 1
$mutex.ReleaseMutex(); $mutex.Dispose()
Write-Output 'PASS: the installed tray is found wherever the helper runs, its -Config/-ReleaseDirectory are kept, and the tray lock is awaited'
