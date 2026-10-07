# Manual, process-preserving Windows update. No release polling.
# Selects the release, then restarts this installation's native web server and
# relay on it; -BinaryOnly only selects it for future service starts.
param(
    [string]$Candidate = '',
    [string]$ReleaseDirectory = '',
    [string]$Config = '',
    [ValidateRange(1,300)][int]$TimeoutSeconds = 15,
    [switch]$Rollback,
    [switch]$BinaryOnly,
    [string]$HostConfig = (Join-Path $HOME '.config/switchboard/hosts.json'),
    [int]$RelayPort = 80
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This updater supports Windows only.' }
Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force
if (!$ReleaseDirectory) { $ReleaseDirectory = Get-SwitchboardReleaseDirectory }
# auto_update.py restarts services itself and signals that through the environment.
if ($BinaryOnly -or $env:SWITCHBOARD_UPDATE_BINARY_ONLY -eq '1') {
    $result = Invoke-SwitchboardWindowsUpdate -Candidate $Candidate -Directory $ReleaseDirectory -Config $Config -TimeoutSeconds $TimeoutSeconds -Rollback:$Rollback
    Write-Output "Selected release $($result.sha256) for new processes. Previous binaries are retained in $ReleaseDirectory."
    Write-Output 'Running services, engines, shells and agents remain running on their loaded releases.'
    Write-Output 'This is executable selection only. Browser reconnection and a connection-service upgrade have not been verified.'
    return
}
$snapshot = Join-Path $ReleaseDirectory 'manual-services.json'
function Invoke-Services([string]$Action, [string]$Binary = '') {
    & (Join-Path $PSScriptRoot 'update_services_windows.ps1') -Action $Action -Snapshot $snapshot -ReleaseDirectory $ReleaseDirectory -HostConfig $HostConfig -RelayPort $RelayPort -Binary $Binary
}
function Restart-Services {
    Invoke-Services Stop
    Invoke-Services Start (Get-SwitchboardCurrentBinary $ReleaseDirectory)
    Invoke-Services Verify
}
# Capture before changing anything: identities of the web server, relay and engines.
try { Invoke-Services Snapshot }
catch { throw "Cannot capture this installation's web server and relay ($($_.Exception.Message)). Use -BinaryOnly to select without restarting." }
# The tray yields service supervision while handoff.json names a live process.
$handoff = Join-Path $HOME '.local/share/switchboard/automatic-updates/handoff.json'
if (Test-Path -LiteralPath $handoff) {
    $owner = Get-Content -LiteralPath $handoff -Raw | ConvertFrom-Json
    if (Get-Process -Id $owner.pid -ErrorAction SilentlyContinue) { throw 'Another Switchboard update is in progress.' }
}
[IO.Directory]::CreateDirectory((Split-Path $handoff)) | Out-Null
[IO.File]::WriteAllText($handoff, (ConvertTo-Json @{pid=$PID}))
try {
    $before = (Get-SwitchboardReleaseState $ReleaseDirectory).sha256
    $result = Invoke-SwitchboardWindowsUpdate -Candidate $Candidate -Directory $ReleaseDirectory -Config $Config -TimeoutSeconds $TimeoutSeconds -Rollback:$Rollback
    try { Restart-Services }
    catch {
        $failure = $_
        try {
            if ($result.sha256 -cne $before) {
                Invoke-SwitchboardWindowsUpdate -Directory $ReleaseDirectory -Config $Config -TimeoutSeconds $TimeoutSeconds -Rollback | Out-Null
            }
            Restart-Services
        } catch { throw "Service restart failed ($($failure.Exception.Message)); recovery on the previous release also failed ($($_.Exception.Message))." }
        throw "Service restart failed ($($failure.Exception.Message)); restored release $before and restarted services on it."
    }
} finally { Remove-Item -LiteralPath $handoff -Force -ErrorAction SilentlyContinue }
Write-Output "Selected release $($result.sha256) and restarted the native web server and relay on it."
Write-Output "Terminal engines are unchanged; browsers reconnect. Previous binaries are retained in $ReleaseDirectory."
