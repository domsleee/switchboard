# Keeps the sidebar preview (dev-preview.cjs) running on this Windows computer and on the
# newest main, so changes can be tried about a minute after they land.
#
#   pwsh tools/switchboard/preview_service_windows.ps1 -Install
#
# -Install creates the preview worktree, a secret token and a logon task, starts the
# service and prints the link to open on other devices. The task runs this script from the
# preview worktree, so the service updates itself with main.
#
# To preview an unmerged change, write its worktree path into ~/.config/switchboard/preview/target.
# The preview returns to main by itself once that branch's PR is merged, or when the file
# is deleted. Never edit files in the preview worktree: the service discards local changes.
param(
    [switch]$Install,
    [string]$Worktree = (Join-Path $HOME 'git/switchboard-preview'),
    [ValidateRange(1,65535)][int]$Port = 8199,
    [string]$Repo = 'domsleee/switchboard'
)
$ErrorActionPreference = 'Continue'
$state = Join-Path $HOME '.config/switchboard/preview'
[IO.Directory]::CreateDirectory($state) | Out-Null
$tokenFile = Join-Path $state 'token'
$targetFile = Join-Path $state 'target'
$logFile = Join-Path $state 'preview.log'
$env:GIT_TERMINAL_PROMPT = '0'; $env:GIT_PAGER = 'cat'; $env:GH_PROMPT_DISABLED = '1'
$taskName = 'Switchboard preview'

function Log([string]$message) {
    try {
        if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -gt 1MB) {
            $tail = Get-Content -LiteralPath $logFile -Tail 2000; Set-Content -LiteralPath $logFile -Value $tail
        }
        "$(Get-Date -Format s) $message" | Add-Content -LiteralPath $logFile
    } catch {}
}
# Fetches give up on a stalled network instead of holding the loop.
function Invoke-Git([string]$Directory) { & git.exe -C $Directory -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 @args 2>$null }
function Find-Node {
    if ($env:SWITCHBOARD_NODE -and (Test-Path -LiteralPath $env:SWITCHBOARD_NODE)) { return $env:SWITCHBOARD_NODE }
    $roots = @($env:FNM_DIR, (Join-Path $HOME 'scoop/persist/fnm'), (Join-Path $env:APPDATA 'fnm'), (Join-Path $env:LOCALAPPDATA 'fnm')) | Where-Object { $_ }
    $installed = foreach ($root in $roots) { Get-ChildItem -Path (Join-Path $root 'node-versions/v*/installation/node.exe') -ErrorAction SilentlyContinue }
    $newest = $installed | Sort-Object { [version]($_.FullName -replace '.*node-versions[\\/]v([\d.]+).*', '$1') } -Descending | Select-Object -First 1
    if ($newest) { return $newest.FullName }
    $onPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    throw 'Node.js not found. Install it, or set SWITCHBOARD_NODE to node.exe.'
}
function Get-Link {
    $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.PrefixOrigin -in 'Dhcp','Manual' -and $_.IPAddress -notmatch '^(127|169\.254)\.' } | ForEach-Object IPAddress
    @($env:COMPUTERNAME.ToLower()) + @($addresses) | ForEach-Object { "http://${_}:$Port/?token=$token" }
}

if ($Install) {
    $source = git -C $PSScriptRoot rev-parse --show-toplevel
    if (-not (Test-Path -LiteralPath (Join-Path $Worktree '.git'))) {
        git -C $source fetch -q origin main
        git -C $source worktree add -q --detach $Worktree origin/main
        if ($LASTEXITCODE) { throw "Could not create the preview worktree at $Worktree" }
    }
    if (-not (Test-Path -LiteralPath $tokenFile)) {
        $bytes = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        Set-Content -LiteralPath $tokenFile -Value ([Convert]::ToHexString($bytes).ToLower()) -NoNewline
    }
    $script = Join-Path $Worktree 'tools/switchboard/preview_service_windows.ps1'
    $pwsh = (Get-Command pwsh).Source
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" -Worktree `"$Worktree`" -Port $Port"
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) -Settings $settings -Force | Out-Null
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" | Where-Object { $_.CommandLine -like '*preview_service_windows.ps1*' -and $_.CommandLine -notlike '*-Install*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-ScheduledTask -TaskName $taskName
    Write-Output "Preview service installed. Open one of these on your other devices:"
    Get-Link
    return
}

# One service at a time. A newer copy of this script waits for the old one to hand over.
$mutex = [Threading.Mutex]::new($false, 'Local\SwitchboardPreviewService')
try { if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(90))) { return } } catch [Threading.AbandonedMutexException] {}
$self = $PSCommandPath
$selfHash = (Get-FileHash -LiteralPath $self).Hash
$server = $null; $serving = ''; $failures = 0; $lastMergeCheck = [datetime]::MinValue
Log "service started from $self"

while ($true) {
    try {
        # Stay on the newest main, discarding anything left in this dedicated worktree.
        Invoke-Git $Worktree fetch -q origin main
        $newest = Invoke-Git $Worktree rev-parse origin/main
        if ($newest -and ((Invoke-Git $Worktree rev-parse HEAD) -ne $newest -or (Invoke-Git $Worktree status --porcelain))) {
            Invoke-Git $Worktree checkout -q -f --detach origin/main; Invoke-Git $Worktree clean -q -fd
            Log "main is now $(Invoke-Git $Worktree log -1 --format='%h %s')"
        }
        # A new version of this script takes over from this one.
        if ((Get-FileHash -LiteralPath $self).Hash -ne $selfHash) {
            Log 'service script changed; restarting it'
            if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
            Start-Process -FilePath (Get-Process -Id $PID).Path -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$self`"",'-Worktree',"`"$Worktree`"",'-Port',$Port)
            $mutex.ReleaseMutex(); return
        }
        # Serve an unmerged change when asked, until its PR is merged.
        $root = $Worktree
        if (Test-Path -LiteralPath $targetFile) {
            $target = (Get-Content -LiteralPath $targetFile -Raw).Trim()
            if (-not $target -or -not (Test-Path -LiteralPath (Join-Path $target 'tools/switchboard/static'))) {
                Log "target '$target' has no sidebar; back to main"; Remove-Item -LiteralPath $targetFile -Force
            } else {
                $root = $target
                if ((Get-Date) - $lastMergeCheck -gt [TimeSpan]::FromMinutes(2)) {
                    $lastMergeCheck = Get-Date
                    $branch = Invoke-Git $target branch --show-current
                    if ($branch -and (gh pr list --repo $Repo --head $branch --state merged --json number --jq 'length' 2>$null) -gt 0) {
                        Log "$branch is merged; back to main"; Remove-Item -LiteralPath $targetFile -Force; $root = $Worktree
                    }
                }
            }
        }
        $script = Join-Path $Worktree 'tools/switchboard/dev-preview.cjs'
        $key = "$root|$((Get-FileHash -LiteralPath $script).Hash)"
        # Restart a server that exited, stopped answering, or serves the wrong files.
        $healthy = $false
        if ($server -and -not $server.HasExited) {
            try { $healthy = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/style.css" -Method Head -TimeoutSec 5 -UseBasicParsing).StatusCode -eq 200 } catch {}
            $failures = if ($healthy) { 0 } else { $failures + 1 }
        }
        if (-not $server -or $server.HasExited -or $failures -ge 3 -or $key -ne $serving) {
            if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force; $server.WaitForExit(5000) | Out-Null }
            # Free the port from a server this service lost track of.
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
                $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
                if ($owner.CommandLine -like '*dev-preview.cjs*') { Stop-Process -Id $owner.ProcessId -Force }
            }
            $arguments = @("`"$script`"", '--port', $Port, '--static', "`"$(Join-Path $root 'tools/switchboard/static')`"", '--token-file', "`"$tokenFile`"")
            $server = Start-Process -FilePath (Find-Node) -ArgumentList $arguments -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $state 'server.log') -RedirectStandardError (Join-Path $state 'server-error.log')
            $serving = $key; $failures = 0
            Log "serving $root (pid $($server.Id))"
        }
    } catch { Log "error: $($_.Exception.Message)" }
    Start-Sleep -Seconds 30
}
