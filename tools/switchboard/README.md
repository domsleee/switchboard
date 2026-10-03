# Switchboard

One searchable sidebar across existing Zellij web servers. Reuses each host's stock
terminal client, including its input handling and mobile controls. No remote
Zellij changes are required.

Run on the Mac:

```sh
uv run --script tools/switchboard/server.py
```

Open https://switchboard.localhost (Portless), or http://127.0.0.1:8090. Use **Settings → Machines** to assign work/home groups or refresh sessions.
On macOS, install the menu bar app and keep the relay running independently of a terminal:

```sh
python3 tools/switchboard/install_service.py
```

This builds `~/Applications/Switchboard.app`, adds a terminal icon to the menu
bar, installs login LaunchAgents, and starts native Zellij web daemon mode if
needed. The icon opens Switchboard, shows status, starts servers, and opens logs.
Logs are in `~/Library/Logs/zellij-switchboard.log`. Quitting the menu bar app
leaves the relay and terminal sessions running. Swift's compiler, `uv`, and
`zellij` must be installed.

On Windows, install `uv` and `zellij`, then put your local authenticated host
configuration in `~/.config/switchboard/hosts.json` using the format below. Set
`escape_transport` to `local` and keep the token file on Windows. Run once in
PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1
# With a host-specific configuration:
powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1 -Config C:/path/to/host.kdl
```

This installs a current-user **Switchboard** Startup shortcut and a tray icon,
copies the relay into `~/.config/switchboard`, and starts native daemon mode only
if the server is offline. The tray supervises the relay and web server and opens
the actual sidebar at **http://switchboard.localhost** on loopback port 80.
Logs are in `~/.config/switchboard`. Quitting the tray leaves terminals running.
Port 80 must be available; no administrator access or certificate installation
is required. Windows sees the hosts in its own configuration; the Mac's
loopback-only native server is not reachable from Windows.
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

Choose **Use this window’s size** to size the current tab to this browser. Smaller browser
viewers scroll over the same layout and start at the bottom, near the prompt. **Back to bottom**
returns after scrolling up. **Release this window’s size** restores sizing to fit all viewers.
Ownership transfers when another browser claims it, and releases when the owner leaves the tab or disconnects.
Smaller plain terminals and older browsers still constrain the layout because they cannot pan.
Existing sessions need the updated native server; updating the web server alone does not update a running session.

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
Use **+ New tab** or **Ctrl+Alt+T** (Windows) / **Cmd+Alt+T** (Mac) to open a shell in a chosen machine/session. The new tab is
selected automatically.
Shell directory titles retain explicitly named Zellij tabs. If an agent disables
terminal title updates, Switchboard cannot obtain the chat name through this
protocol; the agent must emit it as a terminal title.
The host list lives in `~/.config/zellij/switchboard-hosts.json`; each host has
an ID, name, URL, and token file path. HTTPS hosts can specify a SHA-256 DER
certificate fingerprint using `tls_fingerprint`.

Example `~/.config/zellij/switchboard-hosts.json` (replace the remote URL and
create the token files locally):

```json
{
  "hosts": [
    {
      "id": "mac",
      "name": "Mac",
      "url": "http://127.0.0.1:8082",
      "token_file": "~/.config/zellij/mac-token"
    },
    {
      "id": "windows",
      "name": "Windows",
      "url": "https://192.0.2.2:8082",
      "token_file": "~/.config/zellij/windows-token"
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
polls can be missed if their completion marker is unchanged. The Windows scanner
uses Python 3, installed as `~/.config/zellij/switchboard-attention-scan.py` and
run through the same private control shell used by Escape and Close. Only pane
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

Shift-click opens terminal links as a preview within Switchboard. **Back to
terminal** restores the terminal, and **Open in browser tab** handles sites that
block embedding. Loopback links on remote hosts use that machine’s LAN address
or its configured `artifact_urls` mapping. This requires a reachable artifact
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
or Shift on Windows/Linux without enabling selection mode. The selected text is
retained through agent redraws and cleared when switching panes.
Ctrl+C without a local selection still interrupts the terminal process. Remote
OSC52 copies use this browser’s clipboard; denied permissions show a manual
copy panel instead of silently failing.

Bare Escape in stock web 0.45.1 drops its byte during parser finalization. The
relay bypasses it with a validated, pane-targeted `zellij action write ... 27`.
Local hosts use the native CLI; remote Windows hosts use one private helper
shell, hidden from the shared tab list. Requests are serialized and uncertain delivery is never
automatically retried. Input waits for focus acknowledgement when switching
remote panes; Back to terminal preserves the focused pane. Dialogs and plugin
focus retain their native behavior.

Run the small checks with:

```sh
node --test tools/switchboard/*.test.cjs
uv run --with aiohttp python tools/switchboard/control.test.py
uv run --with aiohttp python tools/switchboard/attention.test.py
uv run --with aiohttp python tools/switchboard/close.test.py
python3 tools/switchboard/install_service.test.py
```

Run browser checks with headless Playwright against isolated testing sessions.
Keep automation clients out of live sessions: their viewport can shrink the
shared terminal, including when the iframe is hidden.
