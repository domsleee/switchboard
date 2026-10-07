# Only connection services captured for this installation may be restarted.
param(
    [ValidateSet('Arguments','Snapshot','Stop','Start','Verify','StopTray')][string]$Action,
    [string]$Snapshot,
    [string]$ReleaseDirectory,
    [string]$HostConfig,
    [int]$RelayPort = 80,
    [string]$Binary = ''
)
$ErrorActionPreference = 'Stop'
$module = Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force -PassThru
function Save-Snapshot($State) {
    $temporary = $Snapshot + '.tmp'
    [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $State -Depth 12), (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $Snapshot) { [IO.File]::Replace($temporary,$Snapshot,[NullString]::Value) }
    else { [IO.File]::Move($temporary,$Snapshot) }
}
function Process-Identity($Process) {
    [pscustomobject]@{id=$Process.ProcessId; started=$Process.CreationDate.ToUniversalTime().ToString('o')}
}
function Test-InstallationBinary([string]$Path) {
    if (!$Path) { return $false }
    # Initial installs can still have their original executable loaded outside
    # the store. Accept it only when its checksum is already retained here.
    & $module {
        param($Exe,$Store)
        try {
            Get-SwitchboardReleaseBinary $Store (Get-SwitchboardHash $Exe) | Out-Null
            $true
        } catch { $false }
    } $Path $ReleaseDirectory
}
function Stop-Captured($Identity, [string]$Pattern) {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($Identity.id)"
    if (!$live) { return }
    if ($live.CreationDate.ToUniversalTime().ToString('o') -cne $Identity.started -or
        $live.CommandLine -notmatch $Pattern -or $live.CommandLine -match '(?:^|\s)--server(?:\s|=)') {
        throw 'Service identity changed; refusing to stop it'
    }
    # A service that exits between the identity check and the stop is fine.
    try { Stop-Process -Id $live.ProcessId -ErrorAction Stop }
    catch { if (Get-Process -Id $live.ProcessId -ErrorAction SilentlyContinue) { throw } }
    Wait-Process -Id $live.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
}
if ($Action -eq 'Arguments') {
    # The running tray's -Config/-ReleaseDirectory, for updates started without them.
    Get-SwitchboardTrayArguments @(Get-CimInstance Win32_Process) | ConvertTo-Json -Compress
    return
}
if ($Action -eq 'Snapshot') {
    $processes = @(Get-CimInstance Win32_Process)
    $relayPid = @(Get-NetTCPConnection -LocalPort $RelayPort -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($relayPid.Count -ne 1) { throw 'Expected one relay listener' }
    $relay = $processes | Where-Object { $_.ProcessId -eq $relayPid[0] }
    $hostPath = [regex]::Escape([IO.Path]::GetFullPath($HostConfig))
    if (!(Test-InstallationBinary $relay.ExecutablePath) -or
        $relay.CommandLine -notmatch '\bserve\s' -or $relay.CommandLine.Replace('/','\') -notmatch $hostPath) {
        throw 'Relay does not belong to this retained installation'
    }
    $web = @($processes | Where-Object { $_.Name -ieq 'zellij.exe' -and
        $_.CommandLine -match '\bweb\s+--start\b' -and (Test-InstallationBinary $_.ExecutablePath) })
    if ($web.Count -ne 1) { throw 'Expected one native web service for this installation' }
    $services = @($web[0], $relay) | ForEach-Object {
        if ($_.CommandLine -notmatch '^\s*(?:"[^"]+"|\S+)\s+(?<arguments>.+)$') { throw 'Cannot capture service arguments' }
        [pscustomobject]@{arguments=$Matches.arguments; binary=$_.ExecutablePath; identity=(Process-Identity $_)}
    }
    # The installed tray (SWITCHBOARD_TRAY_SCRIPT), not this helper's location:
    # updates may run from a downloaded bundle.
    $trays = @(Get-SwitchboardTrays $processes)
    $protected = @(& $module { param($Observed) Get-SwitchboardProtectedProcesses $Observed } $processes)
    $selected = Get-SwitchboardCurrentBinary $ReleaseDirectory
    $panes = @{}
    & $module { param($Exe) Get-SwitchboardLiveSessions $Exe @() 15 } $selected | ForEach-Object {
        $panes[$_] = & $module { param($Exe,$Session) Get-SwitchboardPaneSnapshot $Exe @() $Session 15 } $selected $_
    }
    Save-Snapshot ([ordered]@{services=@($services); running=@($services.identity); protected=$protected;
        panes=$panes; trays=@($trays | ForEach-Object { Process-Identity $_ })})
    return
}
$state = Get-Content -LiteralPath $Snapshot -Raw | ConvertFrom-Json
if ($Action -eq 'Stop') {
    foreach ($identity in $state.running) { Stop-Captured $identity '\b(?:serve|web\s+--start)\b' }
    $state.running = @()
    Save-Snapshot $state
} elseif ($Action -eq 'Start') {
    if ($state.running.Count) { throw 'Recorded services must be stopped before starting replacements' }
    foreach ($service in $state.services) {
        $child = Start-Process -FilePath $Binary -ArgumentList $service.arguments -WindowStyle Hidden -PassThru
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($child.Id)"
        if (!$process) { throw 'Replacement service exited during startup' }
        $state.running = @($state.running) + @(Process-Identity $process)
        Save-Snapshot $state
    }
} elseif ($Action -eq 'StopTray') {
    foreach ($identity in $state.trays) { Stop-Captured $identity 'switchboard-tray\.ps1.*\s"?-Tray\b' }
    # The replacement tray exits if the old one still holds the single-instance lock.
    if (@($state.trays).Count) { Wait-SwitchboardMutexRelease }
} elseif ($Action -eq 'Verify') {
    # Each replacement service must still be the process we started and listen.
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    foreach ($identity in $state.running) {
        do {
            $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.id)"
            if (!$live -or $live.CreationDate.ToUniversalTime().ToString('o') -cne $identity.started) { throw "Restarted service exited: $($identity.id)" }
            $listening = @(Get-NetTCPConnection -OwningProcess $identity.id -State Listen -ErrorAction SilentlyContinue).Count
            if (!$listening) { Start-Sleep -Milliseconds 500 }
        } while (!$listening -and [DateTime]::UtcNow -lt $deadline)
        if (!$listening) { throw "Restarted service is not listening: $($identity.id)" }
    }
    $health = Invoke-WebRequest "http://127.0.0.1:$RelayPort/api/health" -Headers @{Host='switchboard.localhost'} -UseBasicParsing -TimeoutSec 5
    if (($health.Content | ConvertFrom-Json).relay -ne 'rust') { throw 'Restarted relay is not answering' }
    & $module { param($Baseline) Assert-SwitchboardProcesses $Baseline } $state.protected
    $selected = Get-SwitchboardCurrentBinary $ReleaseDirectory
    foreach ($entry in $state.panes.PSObject.Properties) {
        $current = & $module { param($Exe,$Session) Get-SwitchboardPaneSnapshot $Exe @() $Session 15 } $selected $entry.Name
        if ($current -cne $entry.Value) { throw "Terminal pane identity changed: $($entry.Name)" }
    }
}
