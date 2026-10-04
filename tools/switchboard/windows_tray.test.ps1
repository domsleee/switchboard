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
    $old = Join-Path $root 'old.exe'; [IO.File]::WriteAllText($old,'old')
    $ReleaseDirectory = Join-Path $root 'releases'
    $oldPath = Initialize-SwitchboardReleaseStore $old $ReleaseDirectory
    $directory = $root; $log = Join-Path $root 'web.log'; $relayConfig = Join-Path $root 'hosts.json'
    $prefix = @('--config',(Join-Path $root 'private config.kdl'))
    $status = [pscustomobject]@{Text='initial'}
    $script:selectedHash = $null
    $script:relay = $null
    $script:probeCalls = @(); $script:starts = @()
    $script:killCalls = 0
    $script:webOnline = $true; $script:webWillStart = $true
    $script:health = 'rust'; $script:relayExits = $false
    function Invoke-SwitchboardProbe([string]$Binary, [string[]]$Arguments, [int]$TimeoutSeconds = 15, [switch]$AllowFailure) {
        $script:probeCalls += [pscustomobject]@{Binary=$Binary; Arguments=$Arguments; Timeout=$TimeoutSeconds}
        if ($Arguments -contains '--daemonize') { $script:webOnline = $script:webWillStart }
        [pscustomobject]@{Code=$(if ($Arguments -contains '--status' -and !$script:webOnline) { 1 } else { 0 }); Output=''; Error=''}
    }
    function Invoke-WebRequest {
        if ($script:health -eq 'offline') { throw 'Private HTTP fixture offline' }
        [pscustomobject]@{StatusCode=200; Content=('{"relay":"' + $script:health + '"}')}
    }
    function Start-Process([string]$FilePath, [string]$ArgumentList, [string]$WindowStyle, [switch]$PassThru,
        [string]$RedirectStandardOutput,[string]$RedirectStandardError) {
        $script:starts += [pscustomobject]@{Binary=$FilePath; Arguments=$ArgumentList}
        $child = [pscustomobject]@{HasExited=$script:relayExits}
        $child | Add-Member ScriptMethod WaitForExit { param($milliseconds) $this.HasExited }
        $child
    }
    function Stop-Process {
        $script:killCalls++
        throw 'Tray fixture may not stop any process'
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
    Assert ($script:starts[0].Arguments -eq ('serve --port 80 --host-config "' + $relayConfig + '"')) 'Tray launch changed relay routing arguments'
    Start-Servers
    Assert ($script:starts.Count -eq 1) 'A starting owned relay was duplicated'

    $script:relay.HasExited = $true; $script:relayExits = $true; $script:health = 'other-service'
    Start-Servers
    Assert ($status.Text -eq 'Switchboard unavailable (see logs)') 'Foreign HTTP 200/occupied port was reported as healthy'
    Assert ($script:starts.Count -eq 2) 'Exited private relay was not retried'
    Assert ((Get-Content $log -Raw) -match 'Relay exited during startup') 'Failed relay startup was not logged'
    [IO.File]::WriteAllText((Join-Path $ReleaseDirectory 'current.json'),'{"schema_version":99,"sha256":"bad","previous_sha256":null}')
    Start-Servers
    Assert ($status.Text -eq 'Switchboard unavailable (see logs)' -and $script:starts.Count -eq 2) 'Corrupt release selection launched or claimed a service'
    Assert ($script:killCalls -eq 0) 'Tray tried to stop a process during recovery or release selection'
    Write-Output "PASS: $checks tray supervision checks; actual tray function/release files, simulated services. No startup configuration was changed."
} finally {
    Remove-Module $module -Force
    Remove-Item -LiteralPath $root -Recurse -Force
}
