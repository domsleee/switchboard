# Install once: a hidden tray app starts native Zellij web and the local relay.
param(
    [string]$Config = '',
    [string]$Binary = '',
    [switch]$Tray
)
$ErrorActionPreference = 'Stop'
if (!$Binary) { $Binary = (Get-Command zellij -ErrorAction Stop).Source }
if (!(Test-Path -LiteralPath $Binary -PathType Leaf)) { throw 'Zellij executable does not exist' }
& $Binary serve --help *> $null
if ($LASTEXITCODE -ne 0) { throw 'Install a Switchboard build with the Rust relay (zellij serve)' }
$prefix = @()
if ($Config) { $Config = (Resolve-Path -LiteralPath $Config).Path; $prefix = @('--config', $Config) }
$directory = Join-Path $HOME '.config/switchboard'
[IO.Directory]::CreateDirectory($directory) | Out-Null
$log = Join-Path $directory 'web.log'
$relayConfig = Join-Path $directory 'hosts.json'
$installed = Join-Path $directory 'switchboard-tray.ps1'
$powerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installed + '" -Tray -Binary "' + $Binary + '"'
if ($Config) { $arguments += ' -Config "' + $Config + '"' }
if (!$Tray) {
    if (!(Test-Path -LiteralPath $relayConfig)) { throw "Configure $relayConfig with your authenticated local host first (see README)." }
    $source = Split-Path $PSCommandPath
    if ([IO.Path]::GetFullPath($PSCommandPath) -ne $installed) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $installed -Force
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
function Start-Servers {
    try {
        # Native stderr on a failed status check must not prevent the fallback.
        $ErrorActionPreference = 'Continue'
        & $Binary @prefix web --status --timeout 2 *> $log
        $online = $LASTEXITCODE -eq 0
        $ErrorActionPreference = 'Stop'
        if (!$online) {
            & $Binary @prefix web --daemonize *>> $log
            if ($LASTEXITCODE -ne 0) { throw 'Zellij web failed to start' }
        }
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1/api/health' -Headers @{Host='switchboard.localhost'} -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).relay -eq 'rust') { $status.Text = 'Switchboard running'; return }
        } catch {}
        if ($script:relay -and !$script:relay.HasExited) { $status.Text = 'Switchboard starting...'; return }
        $relayArgs = 'serve --port 80 --host-config "' + $relayConfig + '"'
        $script:relay = Start-Process -FilePath $Binary -ArgumentList $relayArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $directory 'relay.log') -RedirectStandardError (Join-Path $directory 'relay-error.log')
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
