param([switch]$WaitForMessages)

# Codex supplies the hook event on stdin. Preserve Unicode when piping to zellij.
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$payload = [Console]::In.ReadToEnd()
$launcher = Join-Path $env:USERPROFILE '.local/share/switchboard/codex-agent-hook.cmd'
if ($WaitForMessages) {
    $payload | & $launcher --wait
} else {
    $payload | & $launcher
}
# Switchboard being unavailable must not block normal Codex work.
exit 0
