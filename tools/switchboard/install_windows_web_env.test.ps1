$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'install_windows_web.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$function = $ast.Find({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Clear-InheritedShellEnvironment'
}, $true)
. ([scriptblock]::Create($function.Extent.Text))
$env:NO_COLOR = '1'
$env:TERM = 'dumb'
$env:COLORTERM = ''
$env:PAGER = 'cat'
$env:CODEX_CI = '1'
$env:CLAUDE_CODE_SESSION_ID = 'test'
$env:SWITCHBOARD_KEEP = 'kept'
Clear-InheritedShellEnvironment
foreach ($name in 'NO_COLOR', 'TERM', 'PAGER', 'CODEX_CI', 'CLAUDE_CODE_SESSION_ID') {
    if (Test-Path -LiteralPath "Env:$name") { throw "$name was inherited by the tray" }
}
if ($env:SWITCHBOARD_KEEP -ne 'kept' -or !$env:PATH) { throw 'Unrelated variables were removed' }
Write-Output 'PASS: agent shell colour and pager settings are not inherited'
