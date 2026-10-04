# Actual PowerShell transactions in a disposable directory. Windows process and
# Zellij protocol responses are simulated; this is not ConPTY/browser acceptance.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$module = Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force -PassThru
$root = Join-Path ([IO.Path]::GetTempPath()) ('switchboard-windows-update-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$checks = 0
function Assert($Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
    $script:checks++
}
function Reject([scriptblock]$Action, [string]$Pattern) {
    $message = ''
    try { & $Action | Out-Null } catch { $message = $_.Exception.Message }
    Assert ($message -match $Pattern) "Expected rejection matching '$Pattern', got '$message'"
}
try {
    # Exercise the real .NET subprocess implementation before injecting fixtures.
    $powershell = (Get-Process -Id $PID).Path
    $argumentScript = Join-Path $root 'argument fixture.ps1'
    [IO.File]::WriteAllText($argumentScript, 'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Values); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); [Console]::WriteLine((ConvertTo-Json -InputObject @($Values) -Compress))')
    $values = @('space and Unicode 日本語', 'C:\path with spaces\', 'embedded "quotes"', '$(& no shell)', '')
    $probe = Invoke-SwitchboardProbe $powershell (@('-NoLogo','-NoProfile','-File',$argumentScript) + $values) 10
    $received = @($probe.Output | ConvertFrom-Json)
    Assert (($received | ConvertTo-Json -Compress) -ceq ($values | ConvertTo-Json -Compress)) 'Native argument quoting changed values'
    $probe = Invoke-SwitchboardProbe $powershell @('-NoProfile','-Command',"[Console]::Write(('x' * 200000))") 10
    Assert ($probe.Output.Length -eq 200000) 'Large probe output deadlocked or truncated'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Reject { Invoke-SwitchboardProbe $powershell @('-NoProfile','-Command','Start-Sleep -Seconds 30') 1 } 'exceeded 1 seconds'
    Assert ($watch.Elapsed.TotalSeconds -lt 5) 'Read-only probe timeout was not bounded'
    $probe = Invoke-SwitchboardProbe $powershell @('-NoProfile','-Command','exit 7') 10 -AllowFailure
    Assert ($probe.Code -eq 7) 'Failed native status must remain observable for offline-web fallback'

    $fixture = @{Directory=''; Mode='normal'; ProcessReads=0; Calls=@(); OldHash=''; NewHash=''; Restoring=$false}
    & $module {
        param($Fixture)
        $script:fixture = $Fixture
        $script:realSetState = (Get-Command Set-SwitchboardReleaseState).ScriptBlock
        function script:Set-SwitchboardReleaseState([string]$Directory, $State, [string]$Name = 'current.json') {
            if ($script:fixture.Mode -eq 'restore-failure' -and $Name -eq 'current.json') {
                if ($State.sha256 -eq $script:fixture.NewHash) { $script:fixture.Restoring = $true }
                elseif ($script:fixture.Restoring) { throw 'Simulated restore write failure' }
            }
            & $script:realSetState $Directory $State $Name
        }
        function script:Get-SwitchboardWindowsProcesses {
            $script:fixture.ProcessReads++
            $shellStarted = [DateTime]::Parse('2026-10-04T12:00:00.001Z').ToUniversalTime()
            if ($script:fixture.Mode -eq 'pid-reuse' -and $script:fixture.ProcessReads -ge 3) { $shellStarted = $shellStarted.AddMilliseconds(1) }
            @(
                [pscustomobject]@{ProcessId=10; ParentProcessId=1; Name='zellij.exe'; CreationDate='engine-start'; CommandLine=$(if ($script:fixture.Mode -eq 'mismatched-engine') { 'zellij.exe --server C:\private\other' } else { '"C:\old\zellij.exe" --server "C:\private\work session"' })},
                [pscustomobject]@{ProcessId=20; ParentProcessId=10; Name='powershell.exe'; CreationDate=$shellStarted; CommandLine='powershell.exe'},
                [pscustomobject]@{ProcessId=30; ParentProcessId=20; Name='node.exe'; CreationDate='agent-start'; CommandLine='node C:\tools\codex\bin\codex.js'},
                [pscustomobject]@{ProcessId=99; ParentProcessId=1; Name='unrelated.exe'; CreationDate='other-start'; CommandLine='unrelated.exe'}
            ) | Where-Object { !($script:fixture.Mode -eq 'agent-exit' -and $script:fixture.ProcessReads -ge 3 -and $_.ProcessId -eq 30) -and !($script:fixture.Mode -eq 'no-engines' -and $_.ProcessId -eq 10) }
        }
        function script:Invoke-SwitchboardProbe([string]$Binary, [string[]]$Arguments, [int]$TimeoutSeconds = 15, [switch]$AllowFailure) {
            $script:fixture.Calls += ,@($Arguments)
            $kind = Get-Content -LiteralPath $Binary -Raw
            $output = 'fixture version'
            if ($Arguments -contains '--status' -and $kind -eq 'web-incompatible') {
                return [pscustomobject]@{Code=1; Output=''; Error='Incompatible web status fixture'}
            }
            if ($Arguments -contains 'list-sessions') {
                if ($script:fixture.Mode -eq 'no-sessions') {
                    return [pscustomobject]@{Code=1; Output=''; Error='No active zellij sessions found.'}
                }
                $output = "work session [Created 1h ago] `nold session [Created 2h ago] (EXITED - attach to resurrect)`n"
            } elseif ($Arguments -contains 'list-panes') {
                if ($kind -eq 'incompatible') { throw 'Incompatible candidate fixture' }
                if ($kind -eq 'malformed') { $output = '{"id":1}' }
                elseif ($kind -eq 'empty') { $output = '[]' }
                elseif ($kind -eq 'duplicate') { $output = '[{"is_plugin":false,"id":1,"tab_id":2,"tab_name":"A"},{"is_plugin":false,"id":1,"tab_id":2,"tab_name":"A"}]' }
                else {
                    $name = if ($kind -eq 'renamed') { 'Lost name' } else { 'Agent work' }
                    if ($kind -eq 'post-failure' -or $script:fixture.Mode -eq 'restore-failure') {
                        $state = Get-SwitchboardReleaseState $script:fixture.Directory
                        if ($state.sha256 -eq $script:fixture.NewHash) { $name = 'Lost name' }
                    }
                    $a = [ordered]@{is_plugin=$false; id=5; tab_id=7; tab_name=$name; tab_position=0}
                    $b = [ordered]@{is_plugin=$false; id=8; tab_id=9; tab_name='Shell'; tab_position=1}
                    $rows = if ($kind -eq 'reordered') { @($b,$a) } else { @($a,$b) }
                    $output = ConvertTo-Json -InputObject $rows -Compress
                }
            }
            [pscustomobject]@{Code=0; Output=$output; Error=''}
        }
    } $fixture
    function New-Fixture([string]$Kind = 'new', [string]$Mode = 'normal') {
        $fixture.Directory = Join-Path $root ([Guid]::NewGuid().ToString('N'))
        $fixture.Mode = $Mode; $fixture.ProcessReads = 0; $fixture.Calls = @(); $fixture.Restoring = $false
        $old = Join-Path $root 'old.exe'
        $new = Join-Path $root 'new.exe'
        [IO.File]::WriteAllText($old,'old'); [IO.File]::WriteAllText($new,$Kind)
        Initialize-SwitchboardReleaseStore $old $fixture.Directory | Out-Null
        $fixture.OldHash = (Get-SwitchboardReleaseState $fixture.Directory).sha256
        $fixture.NewHash = (Get-FileHash $new -Algorithm SHA256).Hash.ToLowerInvariant()
        $new
    }
    foreach ($kind in @('incompatible','malformed','empty','duplicate','renamed')) {
        $candidate = New-Fixture $kind
        Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'Incompatible|pane|identity|name'
        Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.OldHash) "$kind candidate changed the pointer"
        Assert (!(Test-Path (Join-Path $fixture.Directory 'pending.json'))) "$kind candidate left a journal"
    }
    $candidate = New-Fixture 'web-incompatible'
    Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'running native web daemon'
    Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.OldHash) 'Incompatible web-status candidate changed the pointer'
    $candidate = New-Fixture 'new' 'no-engines'
    Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'observable engine processes'
    Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.OldHash) 'Unobservable live engine was accepted'
    $candidate = New-Fixture 'new' 'mismatched-engine'
    Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'Cannot observe the engine process'
    Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.OldHash) 'An unrelated observable engine satisfied live-session verification'
    $candidate = New-Fixture 'reordered'
    $result = Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory
    Assert ($result.sha256 -ceq $fixture.NewHash) 'Reordering rows must not change stable identity'
    Assert (!$result.live_services_restarted -and !$result.browser_verified) 'Executable selection must not claim service/browser acceptance'
    Assert (Test-Path (Join-Path $fixture.Directory ($fixture.OldHash + '/zellij.exe'))) 'Old executable was not retained'
    Assert (Test-Path (Join-Path $fixture.Directory ($fixture.NewHash + '/zellij.exe'))) 'Candidate executable was not retained'
    Assert (@($fixture.Calls | Where-Object { $_ -contains 'kill-session' -or $_ -contains 'attach' -or $_ -contains '--daemonize' -or $_ -contains '--stop' }).Count -eq 0) 'Updater attempted a session/service mutation'
    $result = Invoke-SwitchboardWindowsUpdate -Directory $fixture.Directory -Rollback
    Assert ($result.sha256 -ceq $fixture.OldHash) 'Manual rollback did not select the old binary'
    Assert ($result.previous_sha256 -ceq $fixture.NewHash) 'Rollback lost the newer retained release'
    $result = Invoke-SwitchboardWindowsUpdate -Directory $fixture.Directory -Rollback
    Assert ($result.sha256 -ceq $fixture.NewHash) 'Repeated rollback did not toggle retained releases'
    $same = Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory
    Assert ((Get-SwitchboardReleaseState $fixture.Directory).previous_sha256 -ceq $fixture.OldHash) 'Reinstalling the selected release must retain rollback history'

    foreach ($mode in @('normal','pid-reuse','agent-exit')) {
        $candidate = New-Fixture $(if ($mode -eq 'normal') { 'post-failure' } else { 'new' }) $mode
        Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'changed'
        Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.OldHash) "$mode failure did not restore the pointer"
        Assert (!(Test-Path (Join-Path $fixture.Directory 'pending.json'))) 'Completed rollback left an interruption journal'
    }
    $candidate = New-Fixture 'new' 'restore-failure'
    Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'automatic pointer restore failed'
    Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.NewHash) 'Failed restore must leave a complete selected release'
    Assert (Test-Path (Join-Path $fixture.Directory 'pending.json')) 'Failed restore lost recovery journal'
    [IO.File]::WriteAllText((Join-Path $fixture.Directory ($fixture.NewHash + '/zellij.exe')),'corrupted new executable')
    $fixture.Mode = 'normal'
    Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'Interrupted update'
    $result = Invoke-SwitchboardWindowsUpdate -Directory $fixture.Directory -Rollback
    Assert ($result.recovered_interrupted_update -and $result.sha256 -ceq $fixture.OldHash) 'Interrupted update recovery failed'
    Assert (!(Test-Path (Join-Path $fixture.Directory 'pending.json'))) 'Recovered interruption left a journal'

    $candidate = New-Fixture
    $lock = [IO.File]::Open((Join-Path $fixture.Directory 'update.lock'),'OpenOrCreate','ReadWrite','None')
    try { Reject { Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory } 'Another release operation' }
    finally { $lock.Dispose() }
    $config = Join-Path $root 'config with spaces.kdl'; [IO.File]::WriteAllText($config,'web_sharing "on"')
    Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory -Config $config | Out-Null
    Assert (@($fixture.Calls | Where-Object { $_ -contains 'list-panes' -and $_[0] -eq '--config' -and $_[1] -eq $config -and $_ -contains 'work session' }).Count -ge 3) 'Configured private session probes lost literal paths/session names'
    $retained = Get-SwitchboardCurrentBinary $fixture.Directory
    [IO.File]::WriteAllText($retained,'corrupted')
    Reject { Get-SwitchboardCurrentBinary $fixture.Directory } 'checksum mismatch'
    $candidate = New-Fixture 'new' 'no-sessions'
    Invoke-SwitchboardWindowsUpdate -Candidate $candidate -Directory $fixture.Directory | Out-Null
    Assert ((Get-SwitchboardReleaseState $fixture.Directory).sha256 -ceq $fixture.NewHash) 'No-session installation failed'
    Write-Output "PASS: $checks Windows release checks; actual PowerShell/files/subprocesses, simulated Windows process and Zellij responses."
} finally {
    Remove-Module $module -Force
    Remove-Item -LiteralPath $root -Recurse -Force
}
