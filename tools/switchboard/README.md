# Switchboard

One searchable sidebar across existing Zellij web servers. Reuses each host's stock
terminal client, including its input handling and mobile controls. No remote
Zellij changes are required.

This fork runs terminals and web connections in Rust without the WASM plugin
runtime. Existing layouts keep their terminal panes and lose plugin bars;
background plugins are ignored and explicit plugin commands return an error.
Native tab creation, layout changes, saved sessions and web sharing remain available.
The sidebar relay, UI and terminal engine are bundled in the Rust executable.
Updating the executable changes new sessions;
running sessions keep their existing engine until they end naturally.

Opening Switchboard automatically starts a shell on each connected machine that
has no sessions. Existing sessions are reused. Closing the last tab leaves the
workspace empty until you use **+ New tab** or open Switchboard again.

Run on the Mac:

```sh
zellij serve --host-config ~/.config/zellij/switchboard-hosts.json
```

Open https://switchboard.localhost (Portless), or http://127.0.0.1:8090. Use **Settings → Machines** to assign work/home groups or refresh sessions.

## Connecting another computer

Pair it: on one computer open **Settings → Computers → Create invitation**, paste
the invitation on the other and choose **Join**, then compare the codes and
approve. Pairing exchanges terminal tokens and certificate pins and adds the
computer throughout the group. Every paired computer can invite another computer.
Group membership and encrypted terminal credentials sync in the background,
including when an offline computer reconnects. Keep Switchboard updated and
running on each computer.

Do not run `zellij web --create-token`, copy token files or add the computer to
`switchboard-hosts.json` by hand. The host list only holds this computer's own
entry.

Remote entries left in the host list are ignored (the relay logs a warning for
each) and appear in **Computers** with **Pair this computer**. Pair them, then
delete the entry. A paired computer gets a new id, so its browser tab order and
archive state start fresh.

The invitation records the computer's current LAN address. If DHCP gives it a
new address, pair again, or reserve its address in the router.

On macOS, install the menu bar app and keep the relay running independently of a terminal:

```sh
python3 tools/switchboard/install_service.py
```

This builds `~/Applications/Switchboard.app`, adds a terminal icon to the menu
bar, installs login LaunchAgents, and starts native Zellij web daemon mode if
needed. The icon opens Switchboard, shows status, starts servers, and opens logs.
Logs are in `~/Library/Logs/zellij-switchboard.log`. Quitting the menu bar app
leaves the relay and terminal sessions running. Swift's compiler and this fork's
`zellij` executable must be installed. Automatic updates use Python 3 and an
authenticated GitHub CLI; macOS also needs `jq`. See
[automatic updates](../../docs/SWITCHBOARD_UPDATES.md#automatic-updates).

To update a Mac while keeping open terminals running (requires `jq`):

```sh
bash tools/switchboard/update_local.sh target/release/zellij
```

This replaces the executable, then restarts the web server and relay on it;
browsers reconnect. Session servers and their shells keep running on their
original engine; new sessions use the update. Failed checks restore the previous
executable and services. `--binary-only` skips the restart.
See [updating Switchboard](../../docs/SWITCHBOARD_UPDATES.md).

On Windows, install this fork's `zellij.exe`, then put your local authenticated host
configuration in `~/.config/switchboard/hosts.json` using the format below. Set
`escape_transport` to `local` and keep the token file on Windows. Run once in
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1
# With a host-specific configuration:
powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1 -Config C:/path/to/host.kdl
```

This installs a current-user **Switchboard** Startup shortcut and a tray icon,
starts the embedded Rust relay, and starts native daemon mode only
if the server is offline. The tray supervises the relay and web server and opens
the actual sidebar at **http://switchboard.localhost** on loopback port 80.
Logs are in `~/.config/switchboard`. Quitting the tray leaves terminals running.
The installer retains its executable in `~/.local/share/switchboard/windows-releases`.
Use `update_windows.ps1 -Candidate C:/build/zellij.exe` to select a new retained
release, or `update_windows.ps1 -Rollback` to select the previous one. Both then
restart the native web server and relay on the selection (add `-BinaryOnly` to
only select it); terminal engines keep running and browsers reconnect.
`~/.config/switchboard/windows_cli.ps1 attach SESSION` uses the selection for
native clients and new sessions. Existing sessions retain their old engine;
see the [Windows update checks](../../docs/SWITCHBOARD_UPDATES.md#select-a-windows-release-without-stopping-terminals).
Port 80 must be available; no administrator access or certificate installation
is required. Windows sees its own host and the computers it has paired with.
Remove the Startup shortcut to disable automatic startup. Other hosts can use
`zellij web --daemonize` to detach web from their terminal.
**Alt+H / Alt+L** move to the previous/next visible tab across machines, wrapping
at either end. They work from inside the terminal and follow the current group
filter. **Alt+Left / Alt+Right** move between words inside the terminal.
**Right-click a sidebar tab → Archive** hides it without closing its terminal.
**Right-click → Close…**, or **Ctrl+D then Enter**, confirms closing every pane in that
tab and stops its processes. It targets the tab by its native stable ID, even
when another tab is focused.
Use **Archive** to search archived tabs across machines and restore one. Archive
state is saved in this browser; archived ready tabs still count as notifications.
Tabs and controls live in one stable, resizable left sidebar, leaving the full
terminal height available. An amber dot marks tabs that
need attention; viewing a result clears the dot without moving the tab.

The last focused browser window sizes its current tab automatically. **Use this window’s size**
also claims the size explicitly. Smaller browser
viewers scroll over the same layout and start at the bottom, near the prompt. **Back to bottom**
returns after scrolling up. Background windows never reclaim the size from metadata updates.
Ownership transfers on focus and releases when the owner leaves the tab or disconnects.
Smaller plain terminals and older browsers still constrain the layout because they cannot pan.
Existing sessions need the updated native server; updating the web server alone does not update a running session.
See the [update plan](../../docs/SWITCHBOARD_UPDATES.md) for preserving running processes during future automatic updates.

Machine names stay beneath each tab, and work/home remain optional filters. Search names and
machines with **Cmd/Ctrl+K**, including from inside the terminal; Enter opens the
first result. Searching does not change the current terminal until you choose a
result. The **☰** button collapses the sidebar; on mobile it opens a drawer that closes
when you select a tab. Width and desktop collapse state persist in this browser.
Drag tabs across machines to rearrange them, or use **Alt+Shift+H / Alt+Shift+L** to move the
selected tab left/right. The order is saved in this browser, including across
work/home filters. Attention changes never reorder tabs. The URL follows the selected machine, session,
and native tab ID; refreshing reconnects to that terminal. Opening a link to an
archived tab restores it in this browser.
Tab labels and the browser window title follow live Codex/Claude pane titles,
including `/rename` updates. Agent spinner prefixes are stripped from labels.
Plain **Ctrl+T** is disabled inside the terminal so it cannot open Zellij's tab menu.
Use **+ New tab** or **Ctrl+Alt+T** (Windows) / **Cmd+Alt+T** (Mac) to open a shell in a chosen machine/session. The new tab is
selected automatically.
Shell directory titles retain explicitly named Zellij tabs. If an agent disables
terminal title updates, Switchboard cannot obtain the chat name through this
protocol; the agent must emit it as a terminal title.
The host list lives in `~/.config/zellij/switchboard-hosts.json` and holds this
computer's own entry: an ID, name, URL, and token file path. HTTPS hosts can
specify a SHA-256 DER certificate fingerprint using `tls_fingerprint`. Paired
computers are added separately (see [Connecting another computer](#connecting-another-computer)).

Example `~/.config/zellij/switchboard-hosts.json` (create the token file locally):

```json
{
  "hosts": [
    {
      "id": "mac",
      "name": "Mac",
      "url": "http://127.0.0.1:8082",
      "token_file": "~/.config/zellij/mac-token"
    }
  ]
}
```

Self-signed HTTPS requires the host's `tls_fingerprint` as 64 hexadecimal
characters. Keep tokens and machine-specific configuration outside this checkout.
The named URLs require an existing Portless proxy with aliases `switchboard` pointing
to port 8090 and `zellij-gallery` to port 8091; otherwise use the loopback URL.

Tokens and upstream cookies stay in the local relay. The relay binds only to
loopback and rejects cross-site requests. Each relay serves its own desktop; it does not listen on a network interface.

The relay automatically checks Codex/Claude panes on each host, including
background tabs, using native `list-panes` and `dump-screen`. It recognizes live
input and approval prompts and running status. Ready results get an attention badge until you view the tab; pending
approvals/questions retain their badge until resolved. A new observed working-to-ready transition raises a new notification. Notification
identities are saved beside the relay configuration as `.attention.json`, so a
relay restart preserves viewed results.
Archive preserves processes and does not erase attention state.

This works with already-running agents, without notification hooks or replacing
Zellij. Detection follows terminal UI markers; unrecognized screens report
unknown, and disconnected hosts lose stale ready status. Very short turns between
polls can be missed if their completion marker is unchanged. The Rust scanner
reads native pane snapshots locally; paired computers scan themselves and return
snapshots through their gateway. Only pane
identity/status/change markers reach the browser, not terminal transcripts.

**Mark ready** also stars a tab manually. Native tab names starting with `*` are
highlighted. Manual marks and acknowledgments are stored in this browser.
The sidebar and browser title show the total number of marked tabs across all
machines, including tabs outside the selected group.

The native tab row is hidden in the desktop combined view; **Settings → Native tab bar** shows
it again. This is client-side viewport clipping of an identified Zellij header,
not a remote layout change. Fullscreen views without that header and the stock
mobile interface are not clipped. The native status bar is also hidden. Bottom clipping does not resize the
terminal, preventing a redraw feedback loop. Routine connection status stays
in the notification tooltip; errors remain visible.
All live sessions are
attached so their tab metadata can be collected. Background frames keep their
viewport size; attaching clients can still affect Zellij's layout sizing.
Disconnected clients reconnect using Zellij's own behavior.

Shift-click opens terminal links in a new browser tab. Loopback links on paired
computers use that machine’s LAN address. This requires a reachable artifact
server or tunnel; rewriting a URL cannot reach a remote loopback-only server.

The Windows gallery on port 8765 uses the separate HTTPS origin
`https://zellij-gallery.localhost`, proxied through an anonymous HTTP listener
on 127.0.0.1:8091. It streams GET/HEAD responses from the configured
`artifact_proxy.target`. Its cookie jar and origin are separate from the
authenticated terminal relay. This supports the current gallery; WebSocket
artifacts or multiple artifact servers need a proper host tunnel when required.
Portless aliases `switchboard -> 8090` and `zellij-gallery -> 8091` persist; exact
`.local` would require changing the existing proxy/DNS setup. Each relay remains local to its own machine.

Click **Select text**, drag over terminal text, then use **Copy**, Cmd+C on Mac,
or Ctrl+Shift+C on Windows/Linux. You can also hold Option while dragging on Mac
or Shift on Windows/Linux without enabling selection mode. Releasing the drag also
copies, like Zellij's own and agent selections. The selected text is
retained through agent redraws and cleared when switching panes.
Ctrl+C without a local selection still interrupts the terminal process. Remote
OSC52 copies use this browser’s clipboard; denied permissions show a manual
copy panel instead of silently failing.

Bare Escape in stock web 0.45.1 drops its byte during parser finalization. The
relay bypasses it with a validated, pane-targeted `zellij action write ... 27`.
This computer uses the native CLI; paired computers run it behind their gateway.
Uncertain delivery is never automatically retried. Input waits for focus acknowledgement when switching
remote panes; Back to terminal preserves the focused pane. Dialogs and plugin
focus retain their native behavior.

Run the small checks with:

```sh
node --test tools/switchboard/*.test.cjs
python3 tools/switchboard/install_service.test.py
```

Run browser checks with headless Playwright against isolated testing sessions.
Keep automation clients out of live sessions: their viewport can shrink the
shared terminal, including when the iframe is hidden.

Run native terminal integration checks with `cargo xtask integration-test`.
Tests now check terminal output, input, geometry and CLI errors without plugin
bars. Older UI suites that require those bars are retained in
`zellij-integration-tests/tests/legacy_plugin_ui` as migration fixtures and are
not run. The server's terminal unit tests remain active.

## Computer and agent inboxes

Open **Messages** in the sidebar to inspect shared inboxes grouped by computer
and agent/window. Choose the initial board host explicitly in **Computers → Shared
messages** after pairing it. The selected computer stores the persistent board;
each local relay connects to it. This choice does not change group administration.
Computer inboxes persist when no agent is running. Agent inboxes use unique
session IDs, so a replacement agent never inherits messages addressed to a
previous occupant of the same terminal. Human reads do not acknowledge messages.

Agents use `zellij message inboxes`, `register`, `send --computer ID`,
`send --to AGENT_ID`, `unread`, `reply` and `ack` to coordinate. See the
[message board guide](../../docs/MESSAGE_BOARD_USAGE.md) for setup, commands,
terminal locations and checkpoint instructions. Automatic agent wake-up is
not provided.
