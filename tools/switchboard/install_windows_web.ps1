# Install once: a hidden tray app starts native Zellij web and the local relay.
param(
    [string]$Config = '',
    [string]$Binary = '',
    [string]$ReleaseDirectory = '',
    [switch]$Tray
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force
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
$trayArguments = @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$installed,'-Tray','-ReleaseDirectory',$ReleaseDirectory)
if ($Config) { $trayArguments += @('-Config',$Config) }
$arguments = ($trayArguments | ForEach-Object { ConvertTo-SwitchboardArgument $_ }) -join ' '
if (!$Tray) {
    if (!(Test-Path -LiteralPath $relayConfig)) { throw "Configure $relayConfig with your authenticated local host first (see README)." }
    $Binary = Initialize-SwitchboardReleaseStore -Binary $Binary -Directory $ReleaseDirectory
    $source = Split-Path $PSCommandPath
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne $installed) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installed -Force
    }
    foreach ($file in @('windows_releases.psm1','update_windows.ps1','windows_cli.ps1')) {
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
    Start-Process -FilePath $powerShell -ArgumentList $arguments -WindowStyle Hidden | Out-Null
    Write-Output 'Switchboard tray app installed: http://switchboard.localhost'
    return
}
$ownsMutex = $false
$mutex = New-Object Threading.Mutex($true, 'Local\SwitchboardTray', [ref]$ownsMutex)
if (!$ownsMutex) { $mutex.Dispose(); return }
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
$open.Add_Click({ Start-Process 'http://switchboard.localhost/' })
$icon.Add_DoubleClick({ Start-Process 'http://switchboard.localhost/' })
$logs.Add_Click({ Start-Process explorer.exe $directory })
$quit.Add_Click({ [Windows.Forms.Application]::ExitThread() })
$script:relay = $null
$script:selectedHash = $null
function Start-Servers {
    try {
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
            $response = Invoke-WebRequest 'http://127.0.0.1/api/health' -Headers @{Host='switchboard.localhost'} -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).relay -eq 'rust') { $status.Text = 'Switchboard running'; return }
        } catch {}
        if ($script:relay -and !$script:relay.HasExited) { $status.Text = 'Switchboard starting...'; return }
        $relayArgs = 'serve --port 80 --host-config "' + $relayConfig + '"'
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
$timer.Add_Tick({ Start-Servers })
try {
    Start-Servers
    $timer.Start()
    [Windows.Forms.Application]::Run()
} finally {
    $timer.Stop(); $timer.Dispose(); $icon.Visible = $false; $icon.Dispose()
    $mutex.ReleaseMutex(); $mutex.Dispose()
}
