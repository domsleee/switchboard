# Exercise the actual tray supervision function without WinForms, startup
# shortcuts, windows, live servers, or changes to the user's configuration.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$module = Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force -PassThru
$root = Join-Path ([IO.Path]::GetTempPath()) ('switchboard-tray-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$checks = 0
function Assert($Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
    $script:checks++
}
try {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'install_windows_web.ps1'),[ref]$tokens,[ref]$errors)
    Assert (!$errors.Count) 'Installer has PowerShell syntax errors'
    $startFunction = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-Servers'},$true)
    Invoke-Expression $startFunction.Extent.Text
    $updateFunction = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Check-ForUpdates'},$true)
    Invoke-Expression $updateFunction.Extent.Text
    $stopFunction = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-StaleRelay'},$true)
    Invoke-Expression $stopFunction.Extent.Text
    $old = Join-Path $root 'old.exe'; [IO.File]::WriteAllText($old,'old')
    $ReleaseDirectory = Join-Path $root 'releases'
    $oldPath = Initialize-SwitchboardReleaseStore $old $ReleaseDirectory
    $directory = $root; $log = Join-Path $root 'web.log'; $relayConfig = Join-Path $root 'hosts.json'
    $RelayPort = 8123
    $prefix = @('--config',(Join-Path $root 'private config.kdl'))
    $status = [pscustomobject]@{Text='initial'}
    $script:selectedHash = $null
    $script:relay = $null
    $script:updater = $null
    $script:probeCalls = @(); $script:starts = @()
    $script:killCalls = 0
    $script:webOnline = $true; $script:webWillStart = $true
    $script:health = 'rust'; $script:relayExits = $false
    $script:realUpdater = $false
    function Invoke-SwitchboardProbe([string]$Binary, [string[]]$Arguments, [int]$TimeoutSeconds = 15, [switch]$AllowFailure) {
        $script:probeCalls += [pscustomobject]@{Binary=$Binary; Arguments=$Arguments; Timeout=$TimeoutSeconds}
        if ($Arguments -contains '--daemonize') { $script:webOnline = $script:webWillStart }
        [pscustomobject]@{Code=$(if ($Arguments -contains '--status' -and !$script:webOnline) { 1 } else { 0 }); Output=''; Error=''}
    }
    function Invoke-WebRequest([string]$Uri, $Headers) {
        Assert ($Uri -eq "http://127.0.0.1:$RelayPort/api/health") 'Tray health checked the wrong relay port'
        Assert ($Headers.Host -eq "switchboard.localhost:$RelayPort") 'Tray health used the wrong Host authority'
        if ($script:health -eq 'offline') { throw 'Private HTTP fixture offline' }
        [pscustomobject]@{StatusCode=200; Content=('{"relay":"' + $script:health + '"}')}
    }
    function Start-Process([string]$FilePath, [string]$ArgumentList, [string]$WindowStyle, [switch]$PassThru,
        [string]$RedirectStandardOutput,[string]$RedirectStandardError) {
        $script:starts += [pscustomobject]@{Binary=$FilePath; Arguments=$ArgumentList}
        if ($script:realUpdater -and $ArgumentList -match '"switchboard" "update"') {
            # A private child that exits quickly, never an installed updater.
            return Microsoft.PowerShell.Management\Start-Process -FilePath (Get-Process -Id $PID).Path `
                -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 750; exit 7"' `
                -WindowStyle Hidden -PassThru -RedirectStandardOutput $RedirectStandardOutput -RedirectStandardError $RedirectStandardError
        }
        $child = [pscustomobject]@{HasExited=$script:relayExits; Id=9000 + $script:starts.Count}
        $child | Add-Member ScriptMethod WaitForExit { param($milliseconds) $this.HasExited }
        $child
    }
    $script:stopped = @(); $script:listeners = @(); $script:processes = @()
    function Stop-Process([int]$Id, [switch]$Force, $ErrorAction) {
        $script:killCalls++
        $script:stopped += $Id
    }
    function Wait-Process { }
    function Get-NetTCPConnection([int]$LocalPort, [string]$State, $ErrorAction) {
        Assert ($LocalPort -eq $RelayPort) 'Tray looked for the relay on the wrong port'
        $script:listeners | ForEach-Object { [pscustomobject]@{OwningProcess=$_} }
    }
    function Get-CimInstance([string]$ClassName, [string]$Filter) {
        if ($Filter -match '^ProcessId=(\d+)$') { $script:processes | Where-Object { $_.ProcessId -eq [int]$Matches[1] } }
        elseif ($Filter -match '^ParentProcessId=(\d+)$') { $script:processes | Where-Object { $_.ParentProcessId -eq [int]$Matches[1] } }
    }
    Start-Servers
    Assert ($status.Text -eq 'Switchboard running') 'Healthy services were not identified'
    Assert (!$script:starts.Count) 'Healthy relay was restarted'
    Assert (@($script:probeCalls | Where-Object { $_.Arguments -contains '--daemonize' }).Count -eq 0) 'Healthy web daemon was restarted'
    Assert ($script:probeCalls[0].Binary -eq $oldPath -and $script:probeCalls[0].Timeout -eq 5) 'Tray did not use retained release with a bounded status probe'

    # A pointer update while healthy services are loaded must not restart either.
    $new = Join-Path $root 'new.exe'; [IO.File]::WriteAllText($new,'new')
    & $module {
        param($Store,$Candidate)
        $state = Get-SwitchboardReleaseState $Store
        $hash = Add-SwitchboardRelease $Store $Candidate
        Set-SwitchboardReleaseState $Store ([ordered]@{schema_version=1; sha256=$hash; previous_sha256=$state.sha256})
    } $ReleaseDirectory $new
    $newPath = Get-SwitchboardCurrentBinary $ReleaseDirectory
    Start-Servers
    Assert (!$script:starts.Count) 'Selecting a release restarted a healthy relay'
    Assert ($script:probeCalls[-1].Binary -eq $newPath) 'Tray did not resolve changed release pointer'

    $script:webOnline = $false
    Start-Servers
    Assert ($script:webOnline -and $status.Text -eq 'Switchboard running') 'Offline native web did not recover'
    Assert (@($script:probeCalls | Where-Object { $_.Arguments -contains '--daemonize' }).Count -eq 1) 'Offline web fallback did not launch exactly once'
    Assert (!$script:starts.Count) 'Web recovery restarted a healthy relay'
    $script:webOnline = $false; $script:webWillStart = $false
    Start-Servers
    Assert ($status.Text -eq 'Switchboard unavailable (see logs)') 'HTTP 200 hid an unavailable native web daemon'
    Assert (!$script:starts.Count) 'Failed web startup also started a relay'

    $script:webOnline = $true; $script:health = 'offline'
    Start-Servers
    Assert ($script:starts.Count -eq 1 -and $script:starts[0].Binary -eq $newPath) 'Offline relay did not start the selected retained release'
    Assert ($script:starts[0].Arguments -eq ('serve --port 8123 --host-config "' + $relayConfig + '"')) 'Tray did not launch on the configured relay port'
    Start-Servers
    Assert ($script:starts.Count -eq 1) 'A starting owned relay was duplicated'

    $script:relay.HasExited = $true; $script:relayExits = $true; $script:health = 'other-service'
    Start-Servers
    Assert ($status.Text -eq 'Switchboard unavailable (see logs)') 'Foreign HTTP 200/occupied port was reported as healthy'
    Assert ($script:starts.Count -eq 2) 'Exited private relay was not retried'
    Assert ((Get-Content $log -Raw) -match 'Relay exited during startup') 'Failed relay startup was not logged'
    if ([Environment]::OSVersion.Platform -eq 'Win32NT') {
        $script:realUpdater = $true
        $script:updater = $null; $script:nextUpdate = [DateTime]::MinValue
        $Config = $prefix[1]
        $startsBefore = $script:starts.Count
        Check-ForUpdates
        Assert ($script:updater -and $script:starts.Count -eq $startsBefore + 1) 'Due check did not launch its private updater'
        Assert ($script:starts[-1].Arguments -match '"--port" "8123"') 'Scheduled update lost the relay port'
        $child = $script:updater
        # Inspect without opening the handle ourselves, which would hide the
        # original PID-reuse bug in Start-Process's returned Process object.
        $handleField = $child.GetType().GetFields([Reflection.BindingFlags]'Instance,NonPublic') | Where-Object { $_.Name -match '^_?haveProcessHandle$' }
        Assert ($handleField -and $handleField.GetValue($child)) 'Updater was tracked by a reusable PID instead of its native process handle'
        $script:nextUpdate = [DateTime]::MinValue
        Check-ForUpdates
        Assert ($script:starts.Count -eq $startsBefore + 1) 'Running updater was duplicated'
        Assert ($child.WaitForExit(5000)) 'Private updater did not exit'
        $script:nextUpdate = [DateTime]::UtcNow.AddHours(1)
        Check-ForUpdates
        Assert (!$script:updater -and $script:starts.Count -eq $startsBefore + 1) 'Exited updater was retained until the next check or relaunched early'
        Assert ((Get-Content $log -Raw) -match 'Automatic update exited: 7') 'Updater completion was not recorded'
        $script:realUpdater = $false
    }
    $startsBeforeCorrupt = $script:starts.Count
    [IO.File]::WriteAllText((Join-Path $ReleaseDirectory 'current.json'),'{"schema_version":99,"sha256":"bad","previous_sha256":null}')
    Start-Servers
    Assert ($status.Text -eq 'Switchboard unavailable (see logs)' -and $script:starts.Count -eq $startsBeforeCorrupt) 'Corrupt release selection launched or claimed a service'
    Assert ($script:killCalls -eq 0) 'Tray tried to stop a process during recovery or release selection'

    # A hung relay this installation started elsewhere (e.g. by an update) keeps
    # the port; after four failed checks the tray stops it and its subscriber.
    $ReleaseDirectory = Join-Path $root 'releases2'; $null = Initialize-SwitchboardReleaseStore $old $ReleaseDirectory
    $script:selectedHash = $null; $script:relayFailures = 0; $script:relay = $null
    $script:health = 'offline'; $script:relayExits = $true
    $script:listeners = @(4242, 5151)
    $script:processes = @(
        [pscustomobject]@{ProcessId=4242; ParentProcessId=1; Name='zellij.exe'; CommandLine=('"C:\r\zellij.exe" serve --port 8123 --host-config "' + $relayConfig + '"')},
        [pscustomobject]@{ProcessId=4343; ParentProcessId=4242; Name='zellij.exe'; CommandLine='"C:\r\zellij.exe" -s main subscribe --format json'},
        [pscustomobject]@{ProcessId=5151; ParentProcessId=1; Name='other.exe'; CommandLine=('other.exe serve --host-config "' + $relayConfig + '"')})
    1..3 | ForEach-Object { Start-Servers }
    Assert ($script:killCalls -eq 0) 'Relay was stopped before it had been unhealthy for four checks'
    Start-Servers
    Assert (($script:stopped -join ',') -eq '4242,4343') 'Hung relay and its subscriber were not stopped, or another program was'
    Assert ((Get-Content $log -Raw) -match 'Stopping unresponsive relay: 4242') 'Stopping the relay was not logged'
    $stoppedCount = $script:killCalls; $script:health = 'rust'
    1..5 | ForEach-Object { Start-Servers }
    Assert ($script:killCalls -eq $stoppedCount -and $status.Text -eq 'Switchboard running') 'A healthy relay was stopped'
    Write-Output "PASS: $checks tray supervision checks; actual tray function/release files, simulated services. No startup configuration was changed."
} finally {
    if ($script:updater) {
        # Finish only the private fixture child, including when an assertion
        # fails, before removing its redirected output files.
        $null = $script:updater.WaitForExit(5000)
        $script:updater.Dispose()
    }
    Remove-Module $module -Force
    Remove-Item -LiteralPath $root -Recurse -Force
}
