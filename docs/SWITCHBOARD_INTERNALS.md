# Switchboard internals

For maintainers and agents. Setting up a computer is in the
[setup guide](../tools/switchboard/README.md).

## How it runs

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

## Running the relay by hand

Run on the Mac:

```sh
zellij serve --host-config ~/.config/zellij/switchboard-hosts.json
```

Open https://switchboard.localhost (Portless), or http://127.0.0.1:8090. Use **Settings → Machines** to assign work/home groups or refresh sessions.

## Pairing details

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

Pairing remembers the computer's LAN address. If that address stops working,
Switchboard also resolves `<computer-name>.local` and checks the paired computer's
certificate before connecting. The paired name must match its network hostname;
for example, `1WN9PD4` uses `1WN9PD4.local`. Names containing spaces cannot supply
this fallback. The network must support DNS or Bonjour/mDNS name resolution.

The local gateway can recover on its current network address without replacing
its pairing identity or terminal sessions. Other computers need this update to
find a moved peer by hostname. A reserved router address remains useful on
networks that do not resolve computer names.

## macOS service

On macOS, install the menu bar app and keep the relay running independently of a terminal:

```sh
python3 tools/switchboard/install_service.py
```

This builds `~/Applications/Switchboard.app`, adds a terminal icon to the menu
bar, installs login LaunchAgents, and starts native Zellij web daemon mode if
needed. The icon opens Switchboard, shows status, starts servers, and opens logs.
Logs are in `~/Library/Logs/zellij-switchboard.log`. Quitting the menu bar app
leaves the relay and terminal sessions running. Swift's compiler and this fork's
`zellij` executable must be installed, plus `jq`. Switchboard then updates itself.

## Windows installer

On Windows, install this fork's `zellij.exe`, then put your local authenticated host
configuration in `~/.config/switchboard/hosts.json` using the format below. Set
`escape_transport` to `local` and keep the token file on Windows. Run once in
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1
# With a host-specific configuration:
powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1 -Config C:/path/to/host.kdl
```

This installs a current-user **Switchboard** Startup shortcut and a tray icon
(reinstalling without `-Config` keeps the running tray's `-Config`),
starts the embedded Rust relay, and starts native daemon mode only
if the server is offline. The tray supervises the relay and web server and opens
the actual sidebar at **http://switchboard.localhost:8090** on loopback port 8090.
Use `-RelayPort PORT` to choose another port. Reinstalls and updates preserve the
running tray's port, including older installations whose relay still uses port 80.
Logs are in `~/.config/switchboard`. Quitting the tray leaves terminals running.
The installer retains its executable in `~/.local/share/switchboard/windows-releases`.
Switchboard updates itself. `~/.config/switchboard/windows_cli.ps1 attach SESSION`
attaches a native client to a session.
The relay port must be available; no administrator access or certificate installation
is required. Port 8090 avoids Windows services that reserve port 80.
Windows sees its own host and the computers it has paired with.
Remove the Startup shortcut to disable automatic startup. Other hosts can use
`zellij web --daemonize` to detach web from their terminal.

## Host list

The host list lives in `~/.config/zellij/switchboard-hosts.json` and holds this
computer's own entry: an ID, name, URL, and token file path. HTTPS hosts can
specify a SHA-256 DER certificate fingerprint using `tls_fingerprint`. Paired
computers are added separately (see [Pair another computer](../tools/switchboard/README.md#pair-another-computer)).

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

## Keyboard shortcuts and sidebar

**Alt+H / Alt+L** move to the previous/next visible tab across machines, wrapping
at either end. They work from inside the terminal and follow the current group
filter. **Alt+Left / Alt+Right** move between words inside the terminal.
On Windows, **Alt+1…Alt+8** select the visible sidebar tab at that position and **Alt+9**
the last, following the current order, filter and search, also from inside the terminal.
**Ctrl+1…9** stay with the browser's own tab switching.
Mac and Linux use **Ctrl+1…Ctrl+8** and **Ctrl+9** for the same Switchboard navigation.
On Mac, **Cmd+1…9** stay with the browser's own tab switching.
**Right-click a sidebar tab → Archive** hides it without closing its terminal.
**Right-click → Close…**, or **Ctrl+D then Enter**, confirms closing every pane in that
tab and stops its processes. It targets the tab by its native stable ID, even
when another tab is focused.
Use **Archive** to search archived tabs across machines and restore one. Archive
state is saved in this browser; archived ready tabs still count as notifications.
Tabs and controls live in one stable, resizable left sidebar, leaving the full
terminal height available. An amber dot marks tabs that
need attention; viewing a result clears the dot without moving the tab.

Machine names stay beneath each tab, and work/home remain optional filters. Search names and
machines with **Cmd/Ctrl+K**, including from inside the terminal; Enter opens the
first result. Searching does not change the current terminal until you choose a
result. The **☰** button collapses the sidebar; on mobile it opens a drawer that closes
when you select a tab. Width and desktop collapse state persist in this browser.
Drag tabs across machines to rearrange them, or use **Alt+Shift+H / Alt+Shift+L** to move the
selected tab left/right. The order is saved in this browser, including across
work/home filters. Attention changes never reorder tabs. The URL follows the selected machine, session,
and native tab ID, plus `group=home` or `group=work` for the selected group.
Choosing All removes the group parameter. Refreshing restores the group and reconnects to that terminal. Opening a link to an
archived tab restores it in this browser.
Tab labels and the browser window title follow live Codex/Claude pane titles,
including `/rename` updates. Agent spinner prefixes are stripped from labels.
Plain **Ctrl+T** is disabled inside the terminal so it cannot open Zellij's tab menu.
Use **+ New tab** or **Ctrl+Alt+T** (Windows) / **Cmd+Alt+T** (Mac) to open a shell in a chosen machine/session. The new tab is
selected automatically.
**Ctrl+L** or **Ctrl+Alt+L** clears the focused terminal, and **Ctrl+Backspace** / **Alt+Backspace**
delete the word to the left. If your browser keeps **Ctrl+L** for its address bar,
use **Ctrl+Alt+L** or run `clear` at the shell prompt. These terminal shortcuts leave
dialogs and other text fields alone.
Shell directory titles retain explicitly named Zellij tabs. If an agent disables
terminal title updates, Switchboard cannot obtain the chat name through this
protocol; the agent must emit it as a terminal title.

## Tab size

The last focused browser window sizes its current tab automatically. **Use this window’s size**
also claims the size explicitly. Smaller browser
viewers scroll over the same layout and start at the bottom, near the prompt. **Back to bottom**
returns after scrolling up. Background windows never reclaim the size from metadata updates.
Ownership transfers on focus and releases when the owner leaves the tab or disconnects.
Smaller plain terminals and older browsers still constrain the layout because they cannot pan.

## Attention detection

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

## Native tab bar and connections

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

## Links and artifacts

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

## Copying text

Click **Select text**, drag over terminal text, then use **Copy**, Cmd+C on Mac,
or Ctrl+Shift+C on Windows/Linux. You can also hold Option while dragging on Mac
or Shift on Windows/Linux without enabling selection mode. Releasing the drag also
copies, like Zellij's own and agent selections. The selected text is
retained through agent redraws and cleared when switching panes.
Ctrl+C without a local selection still interrupts the terminal process. Remote
OSC52 copies use this browser’s clipboard; denied permissions show a manual
copy panel instead of silently failing.

## Escape key

Bare Escape in stock web 0.45.1 drops its byte during parser finalization. The
relay bypasses it with a validated, pane-targeted `zellij action write ... 27`.
This computer uses the native CLI; paired computers run it behind their gateway.
Uncertain delivery is never automatically retried. Input waits for focus acknowledgement when switching
remote panes; Back to terminal preserves the focused pane. Dialogs and plugin
focus retain their native behavior.

## Diagnostics

Settings → Logs includes terminal tab switches: focus acknowledgment,
first frame, parser/render/frame scheduling delay, output byte/frame counts,
resize counts, and viewport size changes. Each switch observes ten seconds after
acknowledgment, so a short quiet gap cannot hide a later output replay burst.
Scrolling reports count xterm buffer movement, line feeds and wheel events, and
record actual xterm size changes and cropped rows. Buffer movement without line
feeds can expose unwanted wrapping even when the browser viewport stays normal.
Control reports count native focus requests and cell pixel-size changes, including
changes that leave the terminal's row and column count unchanged. Terminal
transport reports summarize large upstream bursts and slow forwarding separately,
so browser parsing delays can be distinguished from screen updates arriving from
another computer.
Shift+Enter reports include browser modifier flags and Shift press/release timing.
These diagnostics contain no terminal contents or typed text. Slow native reflows
and ConPTY resizes also appear in `zellij.log`.

## Tests

Run the small checks with:

```sh
node --test tools/switchboard/*.test.cjs
python3 tools/switchboard/install_service.test.py
```

Run browser checks with headless Playwright against isolated testing sessions.
Keep automation clients out of live sessions: their viewport can shrink the
shared terminal, including when the iframe is hidden.

Measure keystroke echo latency in a private throwaway session (opt-in; never
types into live sessions) with
`PLAYWRIGHT_MODULE=/path/to/playwright node tools/switchboard/latency.test.cjs BINARY`.
`--hammer N` replays the attention scan's CLI calls in N parallel loops and
`--cpu-load N` adds busy processes; `--probe SESSION` only times the read-only
`list-panes`/`dump-screen` calls against an existing session.

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
[message board guide](MESSAGE_BOARD_USAGE.md) for setup, commands,
terminal locations and checkpoint instructions. Automatic agent wake-up is
not provided.
