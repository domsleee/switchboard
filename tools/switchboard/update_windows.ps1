# Manual, process-preserving Windows executable selection. No release polling.
param(
    [string]$Candidate = '',
    [string]$ReleaseDirectory = '',
    [string]$Config = '',
    [ValidateRange(1,300)][int]$TimeoutSeconds = 15,
    [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This updater supports Windows only.' }
Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force
if (!$ReleaseDirectory) { $ReleaseDirectory = Get-SwitchboardReleaseDirectory }
$result = Invoke-SwitchboardWindowsUpdate -Candidate $Candidate -Directory $ReleaseDirectory -Config $Config -TimeoutSeconds $TimeoutSeconds -Rollback:$Rollback
Write-Output "Selected release $($result.sha256) for new processes. Previous binaries are retained in $ReleaseDirectory."
Write-Output 'Running services, engines, shells and agents remain running on their loaded releases.'
Write-Output 'This is executable selection only. Browser reconnection and a connection-service upgrade have not been verified.'
