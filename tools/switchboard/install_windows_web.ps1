# Install once: a hidden tray app starts native Zellij web and the local relay.
param(
    [string]$Config = '',
    [string]$Binary = '',
    [string]$ReleaseDirectory = '',
    [ValidateRange(0,65535)][int]$RelayPort = 0,
    [switch]$Tray
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force
if (!$Config -or !$ReleaseDirectory -or !$RelayPort) {
    # Reinstalling (by hand, from a bundle or by the updater) keeps the running
    # tray's settings, including in the logon shortcut.
    $running = Get-SwitchboardTrayArguments @(Get-CimInstance Win32_Process) (Join-Path $HOME '.config/switchboard/switchboard-tray.ps1')
    if (!$Config) { $Config = $running.config }
    if (!$ReleaseDirectory) { $ReleaseDirectory = $running.releaseDirectory }
    if (!$RelayPort) { $RelayPort = $running.relayPort }
}
if (!$RelayPort) { $RelayPort = 8090 }
$relayUrl = "http://switchboard.localhost:$RelayPort"
if (!$ReleaseDirectory) { $ReleaseDirectory = Get-SwitchboardReleaseDirectory }
if (Test-Path -LiteralPath (Join-Path $ReleaseDirectory 'current.json')) {
    $Binary = Get-SwitchboardCurrentBinary $ReleaseDirectory
} elseif (!$Binary) { $Binary = (Get-Command zellij -ErrorAction Stop).Source }
Invoke-SwitchboardProbe $Binary @('serve','--help') | Out-Null
$prefix = @()
if ($Config) { $Config = (Resolve-Path -LiteralPath $Config).Path; $prefix = @('--config', $Config) }
$directory = Join-Path $HOME '.config/switchboard'
[IO.Directory]::CreateDirectory($directory) | Out-Null
$log = Join-Path $directory 'web.log'
$relayConfig = Join-Path $directory 'hosts.json'
$installed = Join-Path $directory 'switchboard-tray.ps1'
$powerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$trayArguments = @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$installed,'-Tray','-ReleaseDirectory',$ReleaseDirectory,'-RelayPort',$RelayPort)
if ($Config) { $trayArguments += @('-Config',$Config) }
$arguments = ($trayArguments | ForEach-Object { ConvertTo-SwitchboardArgument $_ }) -join ' '
if (!$Tray) {
    New-SwitchboardHostConfig $Binary $prefix $relayConfig
    $Binary = Initialize-SwitchboardReleaseStore -Binary $Binary -Directory $ReleaseDirectory
    $source = Split-Path $PSCommandPath
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne $installed) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installed -Force
    }
    foreach ($file in @('install_windows_web.ps1','windows_releases.psm1','update_windows.ps1','windows_cli.ps1','update_services_windows.ps1')) {
        $from = Join-Path $source $file
        $to = Join-Path $directory $file
        if ([IO.Path]::GetFullPath($from) -ne [IO.Path]::GetFullPath($to)) {
            Copy-Item -LiteralPath $from -Destination $to -Force
        }
    }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Switchboard.lnk'))
    $shortcut.TargetPath = $powerShell
    $shortcut.Arguments = $arguments
    $shortcut.WindowStyle = 7
    $shortcut.Save()
    $started = Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden -PassThru
    # A tray that cannot take the single-instance lock exits; report it.
    if ($started.WaitForExit(8000)) { throw "The tray app exited during startup (exit $($started.ExitCode)); see $log" }
    Write-Output "Switchboard tray app installed: $relayUrl"
    return
}
try { $mutex = Enter-SwitchboardMutex }
catch { Add-Content -LiteralPath $log -Value ('Tray app not started: ' + $_.Exception.Message); exit 1 }
# Every server and pane inherits this environment. Agent and CI shells set
# NO_COLOR, TERM=dumb and PAGER=cat; keep only values set for the account.
function Clear-InheritedShellEnvironment {
    $account = @([Environment]::GetEnvironmentVariables('Machine').Keys) + @([Environment]::GetEnvironmentVariables('User').Keys)
    Get-ChildItem Env: | Where-Object {
        $_.Name -match '^(NO_COLOR|FORCE_COLOR|TERM|COLORTERM|PAGER|GIT_PAGER|GH_PAGER|CLAUDECODE|CLAUDE_CODE_.+|CODEX_.+)$' -and $_.Name -notin $account
    } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
}
Clear-InheritedShellEnvironment
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$icon = New-Object Windows.Forms.NotifyIcon
$icon.Icon = [Drawing.SystemIcons]::Application
$icon.Text = 'Switchboard'
$menu = New-Object Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Switchboard')
$status = $menu.Items.Add('Starting Switchboard...')
$status.Enabled = $false
$start = $menu.Items.Add('Start servers')
$logs = $menu.Items.Add('Open logs')
$quit = $menu.Items.Add('Quit tray app (keep terminals running)')
$icon.ContextMenuStrip = $menu
$icon.Visible = $true
$open.Add_Click({ Start-Process $relayUrl })
$icon.Add_DoubleClick({ Start-Process $relayUrl })
$logs.Add_Click({ Start-Process explorer.exe $directory })
$quit.Add_Click({ [Windows.Forms.Application]::ExitThread() })
$script:relay = $null
$script:selectedHash = $null
$script:nextUpdate = [DateTime]::MinValue
$script:updater = $null
function Check-ForUpdates {
    try {
        if ($script:updater) {
            if (!$script:updater.HasExited) { return }
            Add-Content -LiteralPath $log -Value ("$([DateTime]::UtcNow.ToString('o')) Automatic update exited: $($script:updater.ExitCode)")
            $script:updater.Dispose()
            $script:updater = $null
        }
        if ([DateTime]::UtcNow -lt $script:nextUpdate) { return }
        $handoff = Join-Path $HOME '.local/share/switchboard/automatic-updates/handoff.json'
        if (Test-Path -LiteralPath $handoff) {
            $owner = Get-Content -LiteralPath $handoff -Raw | ConvertFrom-Json
            if (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) { return }
        }
        $script:nextUpdate = [DateTime]::UtcNow.AddMinutes(15)
        # The selected release runs the updater; it never replaces its own file.
        $updateArguments = @('switchboard','update','--release-directory',$ReleaseDirectory,'--port',$RelayPort)
        if ($Config) { $updateArguments += @('--config',$Config) }
        $script:updater = Start-Process -FilePath (Get-SwitchboardCurrentBinary $ReleaseDirectory) -WindowStyle Hidden -PassThru `
            -ArgumentList (($updateArguments | ForEach-Object { ConvertTo-SwitchboardArgument $_ }) -join ' ') `
            -RedirectStandardOutput (Join-Path $directory 'update.log') -RedirectStandardError (Join-Path $directory 'update-error.log')
        # Start-Process returns an object identified only by PID. Keep a handle
        # to this process before it exits: otherwise HasExited can open an
        # unrelated process that reused the PID during the 15-minute interval.
        $null = $script:updater.Handle
        Add-Content -LiteralPath $log -Value ("$([DateTime]::UtcNow.ToString('o')) Automatic update started: $($script:updater.Id)")
    } catch {
        if ($script:updater) { $script:updater.Dispose(); $script:updater = $null }
        Add-Content -LiteralPath $log -Value ("$([DateTime]::UtcNow.ToString('o')) Automatic update: " + $_.Exception.Message)
    }
}
function Start-Servers {
    try {
        $handoff = Join-Path $HOME '.local/share/switchboard/automatic-updates/handoff.json'
        if (Test-Path -LiteralPath $handoff) {
            $owner = Get-Content -LiteralPath $handoff -Raw | ConvertFrom-Json
            if (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) { $status.Text = 'Updating Switchboard...'; return }
        }
        # Resolve a new selection for future service starts. Healthy loaded
        # services keep running; updating this pointer never restarts them.
        $release = Get-SwitchboardReleaseState $ReleaseDirectory
        if ($script:selectedHash -cne $release.sha256) {
            $script:selectedBinary = Get-SwitchboardCurrentBinary $ReleaseDirectory
            $script:selectedHash = $release.sha256
        }
        $Binary = $script:selectedBinary
        # Native stderr on a failed status check must not prevent the fallback.
        $probe = Invoke-SwitchboardProbe $Binary ($prefix + @('web','--status','--timeout','2')) 5 -AllowFailure
        $online = $probe.Code -eq 0
        if (!$online) {
            $started = Invoke-SwitchboardProbe $Binary ($prefix + @('web','--daemonize'))
            Add-Content -LiteralPath $log -Value ($started.Output + $started.Error)
            $ready = Invoke-SwitchboardProbe $Binary ($prefix + @('web','--status','--timeout','2')) 5 -AllowFailure
            if ($ready.Code -ne 0) { throw 'Zellij web started but is not ready (see logs)' }
        }
        try {
            $response = Invoke-WebRequest "http://127.0.0.1:$RelayPort/api/health" -Headers @{Host="switchboard.localhost:$RelayPort"} -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).relay -eq 'rust') { $status.Text = 'Switchboard running'; return }
        } catch {}
        if ($script:relay -and !$script:relay.HasExited) { $status.Text = 'Switchboard starting...'; return }
        $relayArgs = 'serve --port ' + $RelayPort + ' --host-config "' + $relayConfig + '"'
        $script:relay = Start-Process -FilePath $Binary -ArgumentList $relayArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'relay.log') -RedirectStandardError (Join-Path $directory 'relay-error.log')
        if ($script:relay.WaitForExit(200)) { throw 'Relay exited during startup (see relay-error.log)' }
        $status.Text = 'Switchboard starting...'
    } catch {
        $status.Text = 'Switchboard unavailable (see logs)'
        Add-Content -LiteralPath $log -Value $_.Exception.Message
    }
}
$start.Add_Click({ Start-Servers })
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 15000
$timer.Add_Tick({ Start-Servers; Check-ForUpdates })
try {
    Start-Servers
    Check-ForUpdates
    $timer.Start()
    [Windows.Forms.Application]::Run()
} finally {
    $timer.Stop(); $timer.Dispose(); $icon.Visible = $false; $icon.Dispose()
    if ($script:updater) { $script:updater.Dispose() }
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
