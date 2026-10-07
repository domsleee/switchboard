# Windows acceptance for the Rust relay

Run against the PR build before replacing a working Windows installation.
Keep the current executable, host config, token files and tray startup shortcut.
The native-binaries workflow now checks Windows marker liveness, pane colour
environment and Rust relay transport before uploading the executable.

The existing older Windows web daemon failed final-session closure: it sent a
retryable close and viewers recreated the session. Remote tab names, ready
state, exact Escape byte delivery and inactive-tab closure passed. Full Windows
acceptance requires the new web daemon as well as the relay. Restarting only
that daemon preserves the old session engines and their shells; verify PID,
creation date, names and browser usability after reconnecting. The new colour
environment applies to new panes created by updated engines.
Never restart the existing session engine to test a relay upgrade.

## 1. Build and isolated startup

On a Windows x64 machine, build the web-enabled executable with the existing
release workflow or `cargo build --release`. Run:

```powershell
cargo test -p zellij-client --features web_server_capability switchboard_relay
.\target\release\zellij.exe serve --help
.\target\release\zellij.exe serve --host-config C:\path\to\test-hosts.json --port 8093
```

Use a copy of the host configuration with an authenticated native server.
Keep the working relay on its original port. Use headless Playwright, no new
visible windows. Record `Get-CimInstance Win32_Process` PID, parent PID and
creation date for the existing engine, shells, agents, web daemon and relay.
Do not include credentials in logs.

## 2. Actual tabs and controls

Create a uniquely named disposable session with two named tabs. Record native
tab/pane IDs, shell PID and a shell variable in each tab. Confirm:

- The sidebar shows both actual names and native order. Clicking each tab focuses
  its intended pane and accepts input. Refresh preserves the selected URL/tab.
- The last focused browser owns dimensions. Resize an unfocused smaller viewer;
  it must not shrink the focused viewer. Plain/older native clients can still
  constrain size; report that separately.
- Codex/Claude fixtures produce working, ready, approval and unknown states in
  background tabs. A viewed ready result stays viewed after relay restart;
  another working-to-ready transition raises a new badge without reordering.
- Escape reaches only the chosen pane. Confirmed close uses the captured native
  tab ID even if focus changes or a pane moves. A missing tab/pane returns a
  conflict and does not close another tab. Test Ctrl+D then Enter too.
- New tab is focused and ready for input. Shift-click an artifact link requests
  a new tab, routes to the intended machine and has no opener access.

Exercise both the Windows relay's own engine and a paired Mac relay reaching
Windows through its gateway. Neither path may need Python installed or on PATH.

## 3. Transport, isolation and failure recovery

- Correct TLS certificate pin succeeds; a changed pin fails closed. Host tokens
  and upstream login cookies never reach browser responses or artifact requests.
- Reject foreign Host/Origin, cross-site requests and attempts to log in through
  the terminal proxy. Reject unauthenticated/read-only mutation attempts.
- Transfer text and binary terminal frames, encoded session names/query strings,
  and an artifact larger than 16 MiB. Abort a transfer midstream; it must fail as
  a truncated download, never append a second HTTP response or report completion.
- Disconnect one host. Other hosts remain usable; unavailable tabs/badges are
  cleared and an error is shown. A single vanished session must not discard the
  other sessions on that host.
- A control timeout never retries an uncertain write. Test stalled native CLI probes; the child CLI is killed, the user engine stays
  alive, and subsequent polling recovers.

## 4. Relay update and tray installation

First run the isolated update transaction and tray supervision fixtures:

```powershell
node acceptance/switchboard/run.cjs windows-update
```

These execute real PowerShell/file transactions and the actual tray supervision
function with simulated Windows processes, Zellij responses and services. They
do not establish browser, ConPTY, WinForms or login behavior. On Mac PowerShell 7,
54 release checks and 20 tray checks pass; Windows PowerShell/NTFS results remain
to be recorded. The native-binaries workflow now runs these scripts with Windows
PowerShell and packages the installer, release module, updater and launcher with
the executable.

For real Windows update/reconnection evidence with two distinct compatible builds
and headless Playwright installed:

```powershell
node acceptance/switchboard/run.cjs windows-browser C:\build\old-zellij.exe C:\build\new-zellij.exe
```

The runner owns private sockets, unused ports, two named disposable PowerShell
terminals and an agent fixture. It verifies browser input/output and both
WebSockets before/after release selection, private web/relay replacement, a
controlled relay failure, manual rollback and refresh. It checks engine/shell/
agent-fixture PIDs with creation times, independent shell variables, ongoing
output, a scrollback marker, native/sidebar names, IDs, sharing and selected URL.
It starts a new session using the selected executable. It uses/revokes only a new
fixture token and never starts a tray or changes startup configuration. This
runner has only been syntax checked on Mac; record actual Windows output here.
An agent fixture does not establish actual Codex/Claude turn preservation.

Keep disposable shells busy printing numbered output. Restart only the relay
with the new executable. The same headless browser must reconnect automatically,
retain names/IDs/selected URL/viewed badges, and read/write the existing shells.
Match engine/shell/agent PID and creation dates, variable values and output
continuity. HTTP 200 or a tray status label alone does not count as success.

Then test the Startup/tray installer under a standard user account:

```powershell
powershell -ExecutionPolicy Bypass -File tools\switchboard\install_windows_web.ps1 -Binary C:\path\to\zellij.exe
```

Verify port 80 is free first. Test login startup, tray status, logs, duplicate-tray
prevention, offline-web startup and quitting the icon while terminals keep
running. Confirm no `uv` or Python relay process is started. An occupied port
must report failure without killing the process that owns it.

## 5. Measurements and rollback

Run matched Python/Rust trials with the same hosts, tabs and polling workload.
Record idle/private working-set memory, CPU, startup-to-usable-terminal time,
reconnect time and p50/p95 catalog/control latency. Separate relay, CLI
and terminal engine costs. Do not infer Windows memory from Mac measurements.

If any usable-tab or process-preservation check fails, stop only the new relay
and restore the old relay/tray startup command. Confirm the original browser
reconnects and shells still respond. Preserve logs and label partial recovery
as failure. The manual Windows updater now selects retained executables and
supports guarded rollback; it never restarts loaded services or engines. A
complete production service handoff and automatic Windows updates remain absent.
