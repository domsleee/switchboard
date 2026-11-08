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
#
# It also builds each new main on this computer and installs it through the automatic
# updater (`switchboard update --source`), about a minute after the merge instead of after
# the published build. The updater keeps a newer local build over an older published one.
# An empty file named no-local-builds next to the token turns this off; build.log and
# local-update.log there say what happened.
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
function Find-Cargo {
    $onPath = Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    $installed = Join-Path $HOME '.cargo/bin/cargo.exe'
    if (Test-Path -LiteralPath $installed) { return $installed }
    throw 'cargo not found; local builds need a Rust toolchain.'
}
# Release builds for one computer: no cross-crate optimisation pass and incremental
# compilation, so a typical merge rebuilds in well under a minute.
function Start-LocalBuild([string]$Commit) {
    $env:CARGO_PROFILE_RELEASE_LTO = 'false'
    $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = '16'
    $env:CARGO_PROFILE_RELEASE_INCREMENTAL = 'true'
    Log "building $($Commit.Substring(0, 8)) on this computer"
    Start-Process -FilePath (Find-Cargo) -WorkingDirectory $Worktree -PassThru -WindowStyle Hidden `
        -ArgumentList @('build', '--release', '--features', 'web_server_capability') `
        -RedirectStandardOutput (Join-Path $state 'build-output.log') -RedirectStandardError (Join-Path $state 'build.log')
}
# Packages the build like the release workflow, then hands it to the automatic updater,
# which applies the same checks, viewer wait, rollback and service handoff as a published
# build. Returns the updater process.
function Start-LocalInstall([string]$Commit) {
    $bundle = Join-Path $state 'local-build'
    Remove-Item -LiteralPath $bundle -Recurse -Force -ErrorAction SilentlyContinue
    $dist = Join-Path $bundle 'dist'; $source = Join-Path $bundle 'source'
    [IO.Directory]::CreateDirectory($source) | Out-Null
    $updates = Join-Path $HOME '.local/share/switchboard/automatic-updates/state.json'
    # One run number per commit, so retries do not run ahead of later published builds.
    # Take a new one only when another build has claimed it: a later run, or the same run
    # recorded for a different commit without failed attempts of ours.
    $updater = $null
    try { $updater = Get-Content -LiteralPath $updates -Raw | ConvertFrom-Json } catch {}
    $last = [int64]$updater.run_number
    $run = $script:localRuns[$Commit]
    if (-not $run -or $last -gt $run -or ($last -eq $run -and -not $updater.attempts -and $updater.commit -ne $Commit)) {
        $run = $last + 1
        $script:localRuns[$Commit] = $run
    }
    $exe = Join-Path $Worktree 'target/release/zellij.exe'
    & $exe switchboard package --platform windows --commit $Commit --run-number $run --helpers (Join-Path $Worktree 'tools/switchboard') --output $dist 2>&1 |
        ForEach-Object { Log "package: $_" }
    if ($LASTEXITCODE) { throw "Packaging $($Commit.Substring(0, 8)) failed" }
    Get-ChildItem -LiteralPath $dist -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $source "switchboard-windows-$($_.Name)") }
    # Run the updater exactly as the tray does, plus the local source.
    $tray = Get-TrayArguments
    $arguments = @('switchboard', 'update', '--release-directory', "`"$($tray.releaseDirectory)`"", '--port', $tray.relayPort, '--source', "`"$source`"")
    if ($tray.config) { $arguments += @('--config', "`"$($tray.config)`"") }
    $script:installRun = $run
    Start-Process -FilePath (Get-SwitchboardCurrentBinary $tray.releaseDirectory) -PassThru -WindowStyle Hidden -ArgumentList $arguments `
        -RedirectStandardOutput (Join-Path $state 'local-update.log') -RedirectStandardError (Join-Path $state 'local-update-error.log')
}
function Get-TrayArguments {
    Import-Module (Join-Path $Worktree 'tools/switchboard/windows_releases.psm1') -Force
    $tray = Get-SwitchboardTrayArguments @(Get-CimInstance Win32_Process) -HostConfig (Join-Path $HOME '.config/switchboard/hosts.json')
    if (-not $tray.releaseDirectory) { $tray.releaseDirectory = Get-SwitchboardReleaseDirectory }
    if (-not $tray.relayPort) { $tray.relayPort = 8090 }
    $tray
}
function Get-RunningCommit {
    try { (Invoke-RestMethod -Uri "http://127.0.0.1:$((Get-TrayArguments).relayPort)/api/health" -TimeoutSec 5).commit } catch { $null }
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
# $Install is the -Install switch (names ignore case), so the updater process has its own name.
$build = $null; $building = ''; $built = ''; $updateProcess = $null; $installing = ''
$failedInstalls = @{}; $localRuns = @{}; $nextInstall = [datetime]::MinValue
$noLocalBuilds = Join-Path $state 'no-local-builds'
Log "service started from $self"

while ($true) {
    try {
        # Stay on the newest main, discarding anything left in this dedicated worktree.
        # A running build keeps its sources until it finishes.
        if (-not $build) {
            Invoke-Git $Worktree fetch -q origin main
            $newest = Invoke-Git $Worktree rev-parse origin/main
            if ($newest -and ((Invoke-Git $Worktree rev-parse HEAD) -ne $newest -or (Invoke-Git $Worktree status --porcelain))) {
                Invoke-Git $Worktree checkout -q -f --detach origin/main; Invoke-Git $Worktree clean -q -fd
                Log "main is now $(Invoke-Git $Worktree log -1 --format='%h %s')"
            }
        }
        # A new version of this script takes over from this one, before it starts any build.
        if ((Get-FileHash -LiteralPath $self).Hash -ne $selfHash) {
            Log 'service script changed; restarting it'
            if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
            Start-Process -FilePath (Get-Process -Id $PID).Path -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$self`"",'-Worktree',"`"$Worktree`"",'-Port',$Port)
            $mutex.ReleaseMutex(); return
        }
        # Build each new main here and install it, retrying the install until this
        # computer runs it or main moves on.
        if (-not (Test-Path -LiteralPath $noLocalBuilds)) {
            if ($build -and $build.HasExited) {
                if ($build.ExitCode -eq 0) { $built = $building; Log "built $($building.Substring(0, 8))" }
                else { Log "build of $($building.Substring(0, 8)) failed (exit $($build.ExitCode)); see build.log"; $built = "failed:$building" }
                $build = $null
            }
            $head = Invoke-Git $Worktree rev-parse HEAD
            if (-not $build -and $head -and $built -ne $head -and $built -ne "failed:$head") {
                $running = Get-RunningCommit
                if ($running -and $head.StartsWith($running)) { $built = $head }
                else { $building = $head; $build = Start-LocalBuild $head; $null = $build.Handle }
            }
            if ($updateProcess -and $updateProcess.HasExited) {
                Log "local update of $($installing.Substring(0, 8)) exited $($updateProcess.ExitCode): $((Get-Content -LiteralPath (Join-Path $state 'local-update.log') -Tail 1 -ErrorAction SilentlyContinue))"
                # The updater records a failed handoff as an attempt; one that only waited
                # or found another update running records none. Three failures wait for
                # the next main.
                $attempts = $null
                try { $attempts = (Get-Content -LiteralPath (Join-Path $HOME '.local/share/switchboard/automatic-updates/state.json') -Raw | ConvertFrom-Json) } catch {}
                if ($attempts -and $attempts.run_number -eq $installRun -and $attempts.attempts -ge 1) {
                    $failedInstalls[$installing] = 1 + [int]$failedInstalls[$installing]
                    if ($failedInstalls[$installing] -ge 3) { Log "giving up on installing $($installing.Substring(0, 8))"; $built = "failed:$installing" }
                }
                $updateProcess = $null; $nextInstall = (Get-Date).AddMinutes(1)
            }
            if (-not $build -and -not $updateProcess -and $built -eq $head -and (Get-Date) -ge $nextInstall) {
                $running = Get-RunningCommit
                if ($running -and -not $head.StartsWith($running)) {
                    try { $installing = $head; $updateProcess = Start-LocalInstall $head; $null = $updateProcess.Handle }
                    catch { Log "local install: $($_.Exception.Message)"; $built = "failed:$head" }
                }
            }
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
            if ($root -eq $Worktree) { $arguments += @('--label', 'main') }
            $server = Start-Process -FilePath (Find-Node) -ArgumentList $arguments -PassThru -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $state 'server.log') -RedirectStandardError (Join-Path $state 'server-error.log')
            $serving = $key; $failures = 0
            Log "serving $root (pid $($server.Id))"
        }
    } catch { Log "error: $($_.Exception.Message)" }
    Start-Sleep -Seconds 15
}
