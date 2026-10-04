# New native sessions use the selected release; old sessions keep their engine.
param(
    [string]$ReleaseDirectory = '',
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$CliArguments
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'windows_releases.psm1') -Force
if (!$ReleaseDirectory) { $ReleaseDirectory = Get-SwitchboardReleaseDirectory }
$binary = Get-SwitchboardCurrentBinary $ReleaseDirectory
& $binary @CliArguments
exit $LASTEXITCODE
