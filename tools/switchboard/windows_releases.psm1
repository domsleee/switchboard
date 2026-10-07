# Windows keeps loaded executables locked. Select retained releases instead of
# replacing them, and never restart a session engine or a connection service.
Set-StrictMode -Version 2

function Get-SwitchboardReleaseDirectory {
    Join-Path $HOME '.local/share/switchboard/windows-releases'
}

function Assert-SwitchboardRegularFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular file: $Path"
    }
}

function Get-SwitchboardHash([string]$Path) {
    Assert-SwitchboardRegularFile $Path
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Read-SwitchboardReleaseState([string]$Directory, [string]$Name = 'current.json') {
    $path = Join-Path $Directory $Name
    Assert-SwitchboardRegularFile $path
    # A tray reader must allow the updater to rename the pointer. Its open
    # handle keeps reading one complete old/new file during atomic replacement.
    $stream = [IO.File]::Open($path,'Open','Read',([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
    $reader = New-Object IO.StreamReader($stream)
    try { $state = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop }
    finally { $reader.Dispose() }
    if ($state.schema_version -ne 1 -or $state.sha256 -isnot [string] -or $state.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        ($null -ne $state.previous_sha256 -and ($state.previous_sha256 -isnot [string] -or $state.previous_sha256 -cnotmatch '^[a-f0-9]{64}$'))) {
        throw 'Invalid release pointer; retain the store for manual recovery.'
    }
    $state
}

function Get-SwitchboardReleaseState([string]$Directory) {
    Read-SwitchboardReleaseState $Directory
}

function Get-SwitchboardReleaseBinary([string]$Directory, [string]$Hash) {
    if ($Hash -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid release checksum' }
    $folder = Get-Item -LiteralPath (Join-Path $Directory $Hash) -ErrorAction Stop
    if (!$folder.PSIsContainer -or ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Expected a retained release directory'
    }
    $path = Join-Path $folder.FullName 'zellij.exe'
    if ((Get-SwitchboardHash $path) -cne $Hash) { throw "Retained executable checksum mismatch: $path" }
    $path
}

function Get-SwitchboardCurrentBinary([string]$Directory = (Get-SwitchboardReleaseDirectory)) {
    $state = Get-SwitchboardReleaseState $Directory
    Get-SwitchboardReleaseBinary $Directory $state.sha256
}

function Enter-SwitchboardUpdateLock([string]$Directory) {
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $folder = Get-Item -LiteralPath $Directory -ErrorAction Stop
    if ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release store must not be a link' }
    try { [IO.File]::Open((Join-Path $Directory 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another release operation is running or the store is not writable.' }
}

function Add-SwitchboardRelease([string]$Directory, [string]$Binary) {
    $hash = Get-SwitchboardHash $Binary
    $destination = Join-Path $Directory $hash
    if (!(Test-Path -LiteralPath $destination)) {
        $staging = Join-Path $Directory ('.stage-' + [Guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($staging) | Out-Null
        try {
            $copy = Join-Path $staging 'zellij.exe'
            Copy-Item -LiteralPath $Binary -Destination $copy -ErrorAction Stop
            if ((Get-SwitchboardHash $copy) -cne $hash) { throw 'Candidate changed during staging' }
            [IO.Directory]::Move($staging, $destination)
        } finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force } }
    }
    Get-SwitchboardReleaseBinary $Directory $hash | Out-Null
    $hash
}

function Set-SwitchboardReleaseState([string]$Directory, $State, [string]$Name = 'current.json') {
    $path = Join-Path $Directory $Name
    $temporary = Join-Path $Directory ('.pointer-' + [Guid]::NewGuid().ToString('N'))
    try {
        $json = ConvertTo-Json -InputObject $State -Compress
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $path) {
            Assert-SwitchboardRegularFile $path
            [IO.File]::Replace($temporary, $path, [NullString]::Value)
        } else { [IO.File]::Move($temporary, $path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Initialize-SwitchboardReleaseStore([string]$Binary, [string]$Directory = (Get-SwitchboardReleaseDirectory)) {
    $lock = Enter-SwitchboardUpdateLock $Directory
    try {
        if (!(Test-Path -LiteralPath (Join-Path $Directory 'current.json'))) {
            $hash = Add-SwitchboardRelease $Directory $Binary
            Set-SwitchboardReleaseState $Directory ([ordered]@{schema_version=1; sha256=$hash; previous_sha256=$null})
        }
        Get-SwitchboardCurrentBinary $Directory
    } finally { $lock.Dispose() }
}

# Quote arguments for the Windows native command line, including trailing
# backslashes and quotes. No shell or command interpolation is involved.
function ConvertTo-SwitchboardArgument([string]$Value) {
    '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-SwitchboardProbe([string]$Binary, [string[]]$Arguments, [int]$TimeoutSeconds = 15, [switch]$AllowFailure) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Binary
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-SwitchboardArgument $_ }) -join ' ')
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (!$process.Start()) { throw 'Could not start compatibility probe' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
            # Kill this read-only probe only, never a process tree or engine.
            try { $process.Kill() } catch {}
            throw "Compatibility probe exceeded $TimeoutSeconds seconds"
        }
        if (!$stdout.Wait(1000) -or !$stderr.Wait(1000)) { throw 'Compatibility probe output did not close' }
        $result = [pscustomobject]@{Code=$process.ExitCode; Output=$stdout.Result; Error=$stderr.Result}
        if (!$AllowFailure -and $result.Code -ne 0) { throw "Compatibility probe failed (exit $($result.Code))" }
        $result
    } finally { $process.Dispose() }
}

function Get-SwitchboardLiveSessions([string]$Binary, [string[]]$Prefix, [int]$TimeoutSeconds) {
    $result = Invoke-SwitchboardProbe $Binary ($Prefix + @('list-sessions','--no-formatting')) $TimeoutSeconds -AllowFailure
    if ($result.Code -ne 0) {
        if ($result.Error.Trim() -eq 'No active zellij sessions found.') { return }
        throw 'Could not list live sessions; no release was selected.'
    }
    foreach ($line in ($result.Output -split '\r?\n')) {
        if ($line) {
            if ($line -notmatch '^(?<name>.+) \[Created [^\]\r\n]+\](?: (?<state>\(current\)|\(EXITED - attach to resurrect\)))?\s*$') {
                throw 'Invalid session listing; no release was selected.'
            }
            if ($Matches['state'] -ne '(EXITED - attach to resurrect)') { $Matches['name'] }
        }
    }
}

function Test-SwitchboardIdentityNumber($Value) {
    ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) -and
        $Value -ge 0 -and $Value -lt [long]::MaxValue -and [Math]::Floor($Value) -eq $Value
}

function Get-SwitchboardPaneSnapshot([string]$Binary, [string[]]$Prefix, [string]$Session, [int]$TimeoutSeconds) {
    $result = Invoke-SwitchboardProbe $Binary ($Prefix + @('-s',$Session,'action','list-panes','--json','--all')) $TimeoutSeconds
    if ($result.Output.Trim() -notmatch '(?s)^\[.*\]$') { throw 'Expected a pane array' }
    # Windows PowerShell 5.1 emits a JSON array as one object; enumerate it.
    $rows = @($result.Output | ConvertFrom-Json -ErrorAction Stop | ForEach-Object { $_ })
    if ($rows.Count -eq 0) { throw 'Live session has no panes' }
    $seen = @{}
    $identities = foreach ($pane in $rows) {
        if ($pane.is_plugin -isnot [bool] -or !(Test-SwitchboardIdentityNumber $pane.id) -or
            !(Test-SwitchboardIdentityNumber $pane.tab_id) -or $pane.tab_name -isnot [string]) {
            throw 'Invalid pane identity or native tab name'
        }
        $key = "$($pane.is_plugin)/$($pane.id)"
        if ($seen.ContainsKey($key)) { throw 'Duplicate pane identity' }
        $seen[$key] = $true
        [pscustomobject]@{is_plugin=$pane.is_plugin; id=$pane.id; tab_id=$pane.tab_id; tab_name=$pane.tab_name}
    }
    ConvertTo-Json -InputObject @($identities | Sort-Object is_plugin,id,tab_id) -Compress
}

function Get-SwitchboardWindowsProcesses {
    @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
}

function ConvertTo-SwitchboardProcessTime($Value) {
    if ($Value -is [DateTime]) { $Value.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture) }
    else { $Value.ToString() }
}

function Get-SwitchboardProtectedProcesses($Processes) {
    # Only terminal engines must survive. Their shells, agents and builds may
    # exit on their own during an update; that is not an update failure.
    foreach ($engine in @($Processes | Where-Object { $_.Name -ieq 'zellij.exe' -and $_.CommandLine -match '(?:^|\s)--server(?:\s|=)' })) {
        if (!$engine.CreationDate) { throw 'Cannot establish engine process creation time' }
        [pscustomobject]@{id=$engine.ProcessId; started=(ConvertTo-SwitchboardProcessTime $engine.CreationDate)}
    }
}

function Assert-SwitchboardProcesses($Baseline) {
    $current = @{}
    foreach ($process in (Get-SwitchboardWindowsProcesses)) { $current[[string]$process.ProcessId] = $process }
    foreach ($process in $Baseline) {
        $live = $current[[string]$process.id]
        if (!$live -or !$live.CreationDate -or (ConvertTo-SwitchboardProcessTime $live.CreationDate) -cne $process.started) {
            throw "Terminal engine process changed: $($process.id)"
        }
    }
}

function Invoke-SwitchboardWindowsUpdate {
    [CmdletBinding()]
    param([string]$Candidate, [string]$Directory = (Get-SwitchboardReleaseDirectory),
        [string]$Config = '', [ValidateRange(1,300)][int]$TimeoutSeconds = 15, [switch]$Rollback)
    if (!$Rollback -and !$Candidate) { throw 'Supply a candidate executable or -Rollback' }
    $prefix = @()
    if ($Config) { $prefix = @('--config',(Resolve-Path -LiteralPath $Config -ErrorAction Stop).Path) }
    $lock = Enter-SwitchboardUpdateLock $Directory
    $switched = $false
    $journal = Join-Path $Directory 'pending.json'
    try {
        if (Test-Path -LiteralPath $journal) {
            # A crash after switching is recoverable without depending on a
            # download, an unlocked old executable, or service restarts.
            if (!$Rollback) { throw 'Interrupted update found; run -Rollback before another update.' }
            $before = Read-SwitchboardReleaseState $Directory 'pending.json'
            Get-SwitchboardReleaseBinary $Directory $before.sha256 | Out-Null
            Set-SwitchboardReleaseState $Directory $before
            Remove-Item -LiteralPath $journal -Force
            return [pscustomobject]@{sha256=$before.sha256; recovered_interrupted_update=$true; live_services_restarted=$false; browser_verified=$false}
        }
        $before = Get-SwitchboardReleaseState $Directory
        $oldBinary = Get-SwitchboardReleaseBinary $Directory $before.sha256
        $hash = if ($Rollback) {
            if (!$before.previous_sha256) { throw 'No previous release is retained' }
            Get-SwitchboardReleaseBinary $Directory $before.previous_sha256 | Out-Null
            $before.previous_sha256
        } else { Add-SwitchboardRelease $Directory $Candidate }
        if ($hash -ceq $before.sha256) {
            return [pscustomobject]@{sha256=$hash; previous_sha256=$before.previous_sha256; live_services_restarted=$false; browser_verified=$false}
        }
        $candidateBinary = Get-SwitchboardReleaseBinary $Directory $hash
        Invoke-SwitchboardProbe $candidateBinary @('--version') $TimeoutSeconds | Out-Null
        Invoke-SwitchboardProbe $candidateBinary @('serve','--help') $TimeoutSeconds | Out-Null
        $sessions = @(Get-SwitchboardLiveSessions $oldBinary $prefix $TimeoutSeconds)
        $webArguments = $prefix + @('web','--status','--timeout','2')
        $webOnline = (Invoke-SwitchboardProbe $oldBinary $webArguments $TimeoutSeconds -AllowFailure).Code -eq 0
        if ($webOnline -and (Invoke-SwitchboardProbe $candidateBinary $webArguments $TimeoutSeconds -AllowFailure).Code -ne 0) {
            throw 'Candidate cannot query the running native web daemon'
        }
        $observed = @(Get-SwitchboardWindowsProcesses)
        $protected = @(Get-SwitchboardProtectedProcesses $observed)
        if ($sessions.Count -and !$protected.Count) { throw 'Live sessions found without observable engine processes' }
        foreach ($session in $sessions) {
            $suffix = '(?:[\\/]|\s)' + [regex]::Escape($session) + '"?\s*$'
            if (!@($observed | Where-Object { $_.Name -ieq 'zellij.exe' -and $_.CommandLine -match '(?:^|\s)--server(?:\s|=)' -and $_.CommandLine -match $suffix }).Count) {
                throw "Cannot observe the engine process for live session: $session"
            }
        }
        $panes = @{}
        foreach ($session in $sessions) {
            $panes[$session] = Get-SwitchboardPaneSnapshot $oldBinary $prefix $session $TimeoutSeconds
            if ((Get-SwitchboardPaneSnapshot $candidateBinary $prefix $session $TimeoutSeconds) -cne $panes[$session]) {
                throw "Candidate cannot preserve pane identity and native tab names: $session"
            }
        }
        Assert-SwitchboardProcesses $protected
        Set-SwitchboardReleaseState $Directory $before 'pending.json'
        $switched = $true
        Set-SwitchboardReleaseState $Directory ([ordered]@{schema_version=1; sha256=$hash; previous_sha256=$before.sha256})
        $selectedBinary = Get-SwitchboardCurrentBinary $Directory
        foreach ($session in $sessions) {
            if ((Get-SwitchboardPaneSnapshot $selectedBinary $prefix $session $TimeoutSeconds) -cne $panes[$session]) {
                throw "Session panes or native tab names changed: $session"
            }
        }
        Assert-SwitchboardProcesses $protected
        if ($webOnline -and (Invoke-SwitchboardProbe $selectedBinary $webArguments $TimeoutSeconds -AllowFailure).Code -ne 0) {
            throw 'Running native web daemon became unavailable to the selected executable'
        }
        Remove-Item -LiteralPath $journal -Force -ErrorAction Stop
        [pscustomobject]@{sha256=$hash; previous_sha256=$before.sha256; live_services_restarted=$false; browser_verified=$false}
    } catch {
        $failure = $_
        if ($switched) {
            try {
                Get-SwitchboardReleaseBinary $Directory $before.sha256 | Out-Null
                Set-SwitchboardReleaseState $Directory $before
                Remove-Item -LiteralPath $journal -Force -ErrorAction Stop
            } catch {
                throw "Update failed ($($failure.Exception.Message)); automatic pointer restore failed ($($_.Exception.Message)). Retained previous release: $oldBinary. Keep pending.json for recovery."
            }
        }
        throw $failure
    } finally { $lock.Dispose() }
}

Export-ModuleMember -Function Get-SwitchboardReleaseDirectory,Get-SwitchboardReleaseState,Get-SwitchboardCurrentBinary,Initialize-SwitchboardReleaseStore,Invoke-SwitchboardWindowsUpdate,Invoke-SwitchboardProbe,ConvertTo-SwitchboardArgument
