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

Opening Switchboard shows existing sessions. Closing the last tab leaves the
workspace empty until you use **+ New tab**. Reloading an old terminal viewer or
reconnecting after an update cannot recreate an ended session.

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
hidden tabs start fresh.

To cut a computer off, for example a lost laptop, choose **Remove** on its row in
**Settings → Computers**. The removal is signed and syncs to every computer, each of
which drops its membership and credentials and revokes its terminal token. It is
permanent for that identity: a stale peer cannot bring it back, and the computer can
pair again only with a fresh identity (new `identity.json`). Its name becomes free at
once. A computer cannot remove itself. The removed computer is not told; it keeps
its copy of the group and its syncs start failing.

Removal is refused while a reachable computer answers that it does not understand
it (`GET /mesh/removal`), because a membership with a removal does not verify on
older builds: they would stop merging group changes until they update. A computer
that does not answer is not waited for, so an old offline computer simply cannot
sync with the group until its updater runs, while its terminal credentials stay valid.

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
zellij switchboard install
```

This builds `~/Applications/Switchboard.app`, adds a terminal icon to the menu
bar, installs login LaunchAgents, and starts native Zellij web daemon mode if
needed. The icon opens Switchboard, shows status, starts servers, and opens logs.
Logs are in `~/Library/Logs/zellij-switchboard.log`. Quitting the menu bar app
leaves the relay and terminal sessions running. Swift's compiler and this fork's
`zellij` executable must be installed, plus `jq`. Switchboard then updates itself.

## Windows installer

On Windows, `zellij switchboard install` creates `~/.config/switchboard/hosts.json`
(with `escape_transport` set to `local`) and its token on first install, writes the
PowerShell helpers into `~/.config/switchboard`, and runs `install_windows_web.ps1`.
For a host-specific configuration, run the installed script directly:

```powershell
powershell -ExecutionPolicy Bypass -File ~/.config/switchboard/install_windows_web.ps1 -Config C:/path/to/host.kdl
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

The host list lives in `~/.config/zellij/switchboard-hosts.json` (Windows:
`~/.config/switchboard/hosts.json`). `zellij switchboard install` creates it on first
install with this computer's own entry: an ID, name, URL, and token file path. HTTPS hosts can
specify a SHA-256 DER certificate fingerprint using `tls_fingerprint`. Paired
computers are added separately (see [Connect your computers](../tools/switchboard/README.md#connect-your-computers)).

Example `~/.config/zellij/switchboard-hosts.json`:

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

The sidebar checks its relay build every 30 seconds and when browser visibility changes.
After a relay update, it automatically reloads in the background once every terminal
viewer has safely retired or closed. A nonblank iframe can hold queued input or an
unfinished paste, even after its browser input queue is empty, so it prevents page
refresh. Automatic service updates continue independently. The reload keeps the current
URL and selected terminal. An open dialog, unsent conversation draft (including drafts
in other panes), attachment, or pending send postpones the reload. Returning to the
browser before the reload cancels it until the page is in the background again.

**Alt+H / Alt+L** move to the previous/next visible tab across machines, wrapping
at either end. They work from inside the terminal and follow the current group
filter. **Alt+Left / Alt+Right** move between words inside the terminal.
On every platform, **Alt+1…Alt+8** select the visible sidebar tab at that position and **Alt+9**
the last, following the current order, filter and search, also from inside the terminal.
**Ctrl+1…9** and **Cmd+1…9** stay with the browser's own tab switching.
Sidebar shortcuts also work inside blank or failed terminal pages, even before
the terminal bridge loads. Native dialogs keep their shortcuts, and **Ctrl+D**
does not close a tab while a form input is focused.
Selecting an offline tab releases the previous terminal's keyboard focus, so
sidebar shortcuts still work while the selected tab reconnects.
**Right-click a sidebar tab → Hide** moves it to the **Hidden** group at the bottom
of the sidebar without closing its terminal; **Show in list** moves it back.
**Middle-click a sidebar tab**, **Right-click → Close**, or **Ctrl+D** immediately
closes every pane in that tab and stops its processes. Middle-click targets the
clicked tab without selecting it first. Close uses its native stable ID, even
when another tab is focused.
The Hidden group starts collapsed and remembers whether it was left open in this
browser. Dragging a tab below its header hides the tab; dragging it above shows it
again. Hidden tabs still count as notifications, and the header shows the amber dot
when one needs attention. Search finds hidden tabs while the group is collapsed;
Alt+H/L and Alt+1–9 skip them unless it is open. Paired computers share the hidden
tabs like the tab order (`/api/mesh/hidden-tabs`), and they follow a recreated
session to the new tab numbers the same way. Tabs archived in this browser before
Hidden existed become hidden tabs.
Tabs and controls live in one stable, resizable left sidebar, leaving the full
terminal height available. An amber dot marks tabs that
need attention; viewing a result clears the dot without moving the tab.

Hover or focus a tab to reveal **Snooze** (clock) and **Settle** (check).
Snooze opens a menu with 1 hour, 3 hours, tomorrow at 9 AM, or a custom local
date and time. Each preset shows its wake time. Snoozed tabs keep running and move to **Snoozed** until their wake
time. A new approval, question or password request brings them back early;
ordinary completion and background work leave the snooze in place. **Wake thread**
returns one early. Settle closes the tab and stops its processes to free memory,
like **Close**, without confirmation. Both actions also appear in the right-click
or long-press menu. Sending a Conversation message wakes a snoozed tab. Snoozes persist in this
browser, like pins, and do not stop terminal processes. They are separate from
the automatic **Working** shelf and the shared **Hidden** group. Snoozed tabs
are omitted from this browser's notification count; relay push alerts are unchanged.

Machine names stay beneath each tab, and work/home remain optional filters. Search names and
machines with **Cmd+K** (Mac) / **Ctrl+K** (Windows, Linux), including from inside the terminal; Enter opens the
first result. Searching does not change the current terminal until you choose a
result. The **☰** button collapses the sidebar; on mobile it opens a drawer that closes
when you select a tab. Width and desktop collapse state persist in this browser.
Drag tabs across machines to rearrange them, or use **Alt+Shift+H / Alt+Shift+L** to move the
selected tab left/right. Paired computers share the order, so every browser on every
computer lists tabs alike, including across work/home filters; new tabs go last everywhere.
A session recreated after a reboot or crash numbers its tabs from 0 again; the order keeps a
marker per session (its start time and tab IDs by position), so each saved position passes to
the new tab at the same session position instead of a different tab.
Without pairing, the order is saved in this browser. Attention changes never reorder tabs. The URL follows the selected machine, session,
and native tab ID, plus `group=home` or `group=work` for the selected group.
Choosing All removes the group parameter. Refreshing restores the group and reconnects to that terminal. A link to a
hidden tab opens it without showing it in the list.
Tab labels and the browser window title follow live Codex/Claude/Copilot pane titles,
including `/rename` updates. Agent spinner prefixes are stripped from labels.
Keys typed in the browser go to the program, not to Zellij's shortcuts, so Ctrl+T,
Ctrl+O, Ctrl+G and the other Zellij mode keys reach Claude as in a terminal window.
Use **+ New tab** or **Alt+T** on any platform to open a shell in a chosen machine/session.
**Create tab** is focused by default, so **Enter** creates a tab in the selected
machine/session. The new tab is selected automatically.

The project picker lists the folders in that computer's `~/git`. To list projects kept
elsewhere, write `~/.config/switchboard/projects.json` on that computer. Each entry is a
folder whose subfolders are projects; a final `*` makes every folder inside it such a
folder, for layouts like `C:\git\GitHub\{org}\{repo}`. A leading `~` is the home folder.

```json
{ "folders": ["C:\\git\\GitHub\\*"] }
```

The picker shows the folder name above its parent path, adding enough parent folders
to distinguish names such as `Glow/DotNet` and `Glow2/DotNet`. Selections still use
the full path. Overlapping roots and directory aliases list each folder once.
Linked Git worktrees, including their subfolders, are omitted from suggestions using
Git's common-directory metadata; separate clones and submodules remain available.
A worktree can still be opened by typing its full path. An unreadable or
invalid file is logged and ignored, and the picker still lists `~/git`. Changes apply
the next time the picker loads.

The 🛡️ button next to **+** opens an administrator tab: the default shell through `gsudo` on Windows (install it with
`winget install gerardog.gsudo`) or `sudo` elsewhere, so the UAC or password prompt appears on
that machine. Windows uses winget's install location `%ProgramFiles%\gsudo\Current` when it exists,
because services started before the install keep a PATH without gsudo. The tab is named "Administrator" and shows a shield in the sidebar.
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

Wheel and trackpad scrolling moves the text as far as the gesture did, 3 lines per
Zellij scroll. **Settings → Fine scrolling** (trial) scrolls 1 line per step instead:
the terminal socket passes `wheel_lines=1` and each wheel report carries that count to
Zellij. Native terminal clients keep 3 lines per wheel notch.

Smaller plain terminals and older browsers still constrain the layout because they cannot pan.

## Attention detection

The relay automatically checks Codex/Claude/Copilot panes on each host, including
background tabs, using native `list-panes` and `dump-screen`. It recognizes live
input and approval prompts and running status. Ready results get an attention badge until you view the tab; pending
approvals/questions retain their badge until resolved. A new observed working-to-ready transition raises a new notification, except a
Claude pane starting up: its `SessionStart` hook and a brief early screen flicker are not finished turns. Notification
identities are saved beside the relay configuration as `.attention.json`, so a
relay restart preserves viewed results. Saved state for a pane is dropped once a full
scan of this computer has not listed it and its status has not changed for 30 days.
Denying a Claude approval sends no hook, so the relay ends the approval when the pane
itself shows Claude's `Interrupted` marker.
Hiding a tab preserves processes and does not erase attention state.

Codex's asynchronous questions use an `enter submit · ctrl+] skip · shift+→ main prompt`
footer. An open question or approval takes priority over Codex's turn hooks, even
while it continues working or finishes its turn. Viewing the tab keeps the input
badge until the dialog is answered; its normal turn status then resumes. The
`[ ! ] Action Required` title also keeps it flagged when the user switches from
the question back to Codex's main prompt.
The snapshot keeps the hook's `turn_state` alongside that input badge, so
Conversation can show ongoing work and accept async answers without blocking
ordinary replies. It reads the question's native choices from the transcript.

Claude tabs use live spinners and active background-agent rows to indicate work.
A background-shell count alone does not keep a finished reply working: that shell
may be a persistent dev server. Finished-turn markers also recognize accented
verbs such as `Sautéed`, so an older spinner cannot override the latest completion.

Copilot tabs stay working while the footer beneath the current boxed input shows
`esc interrupt`. Its normal `/ commands · ? help` footer marks the tab ready.
Old interrupt hints in the transcript do not keep a tab working. Copilot has no
completion line, so a finish must be observed to raise a new notification.
Unrecognized Copilot dialogs report unknown.

Claude Code tabs with the `switchboard` plugin (`plugins/switchboard`)
report their own status: native HTTP hooks post `UserPromptSubmit`, tool, permission,
notification, `Stop` and `SessionEnd` events to `/api/agent-hook/claude`, carrying
`ZELLIJ_SESSION_NAME`, `ZELLIJ_PANE_ID`, `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
in headers. The relay returns message context in the HTTP response, sharing the
command hook's identity and delivery cursors. `SessionStart` and background
message watchers still run `zellij agent-hook --agent claude`, because Claude
does not support HTTP session-start hooks or HTTP `asyncRewake`. That status replaces
the screen reading for the pane while it still runs Claude, except that a visible
approval or question takes priority, including one raised by a background agent.
A `Stop` that lists a running background agent or workflow, or a shell started since
the previous `Stop`, is
`waiting`; Claude starts a new turn when the task ends. Stopping a shell from Claude's
task list starts no turn and fires no hook, so a shell wait also ends once Claude's idle
footer has counted no running task for 30 seconds. The relay saves the shells it has
seen across restarts, so a shell that was already running does not look new.
Conversation's Stop on a waiting Claude tab stops every task in Claude's Background
dialog, because Esc does nothing once the turn has ended. The relay reads the pane before
each key. On Windows, Claude ends the task's shell but can leave its child processes running.
Noninteractive agents started inside Claude are ignored using the entrypoint header.
The same CLI delivers message-board mail as hook context for Claude and Codex.
Their `SessionStart` and `Stop` hooks start one background `--wait` watcher per
conversation: Claude uses `asyncRewake` and Codex's watcher calls its native queue.
See [automatic delivery](MESSAGE_BOARD_USAGE.md#automatic-delivery) for identity,
duplicate suppression and explicit receipt behavior.

Copilot CLI loads the same plugin through its root `plugin.json`, whose command hooks
(`copilot-hooks.json`) run `zellij agent-hook --agent copilot`. That command posts the
event on stdin to `/api/agent-hook` with an `X-Agent` header, and skips agents started
by Claude in the same pane. Its PascalCase event names give Claude-shaped payloads, so
a `permission_prompt` notification marks the tab as needing approval. A hooked status
applies only while the pane's command still names that agent. A finished turn is
identified by Claude's `prompt_id`, Codex's `turn_id` or Copilot's `timestamp`; a Codex
`Interrupt` returns the pane to screen reading.

Settings → **Health** (`switchboard_relay/agent_setup.rs`, drawn by `static/tasks.js`)
shows whether each computer's agents are set up to report, as part of every computer's
`/api/tasks` answer (`switchboard` and `agents`). Each relay reads the agents' own files
rather than running them: Claude's `plugins/installed_plugins.json`, `settings.json` and
`plugins/known_marketplaces.json`; Copilot's `config.json` (comment lines first) and
`settings.json`; Codex's enabled Switchboard plugin, its `hooks/codex.json`, and the
`[hooks.state."switchboard@switchboard:hooks/codex.json:<event>:<group>:<hook>"]`
entries Codex writes to `config.toml` once the user trusts a plugin hook. A saved
`plugins/switchboard-hook-trust.json` proof binds Health to the plugin files and settings
that Codex actually verified. An agent counts as
installed when its program is on the relay's PATH, the PATH in `tasks.json` or a usual
install folder, and its settings folder exists. The time of each agent's last hook is
kept in `~/.config/switchboard/agent-reports.json`. `POST /api/tasks/setup`
(`{agent, host?}`; paired computers use `/switchboard/tasks/setup`) runs that agent's
fixed setup in the background; requests name an agent, never a command. Codex hooks
run `~/.local/share/switchboard/codex-agent-hook` (`.cmd` on Windows), which the relay
rewrites at startup to run its current executable, so the hook text Codex trusted stays
the same across updates even though Windows runs each release from its own folder.
Once Codex lists all nine plugin hooks as trusted, setup removes Switchboard's old
global `hooks.json` entries, preserving other hooks and a backup. A failed check keeps
the global hooks. The same section shows the relay's build and whether
its automatic update is on: the `switchboard-update.timer` user unit is enabled on Linux,
the `dev.switchboard.update` LaunchAgent is loaded on macOS, and on Windows the tray, which
runs the checks, holds its `Local\SwitchboardTray` mutex.

Screen reading works with already-running agents, without notification hooks or replacing
Zellij. Detection follows terminal UI markers; unrecognized screens report
unknown, and disconnected hosts lose stale ready status. Very short turns between
polls can be missed if their completion marker is unchanged. The Rust scanner
reads native pane snapshots locally; paired computers scan themselves and return
snapshots through their gateway. Each paired computer is asked separately and holds
the request until its status changes, and `/api/attention?after=<version>` likewise
answers the browser as soon as the snapshot changes. Only pane
identity/status/change markers reach the browser, not terminal transcripts.

**Mark ready** also stars a tab manually. Native tab names starting with `*` are
highlighted. Manual marks and acknowledgments are stored in this browser.
The sidebar and browser title show the total number of marked tabs across all
machines, including tabs outside the selected group.

## Native tab bar and connections

Fatal terminal failures appear in **Settings → Logs**, with the reference shown in
the disconnect dialog. Retained workers save a content-free report before replying;
the browser reports failures that were not saved at source, including those from
older workers. Reports live
in `~/.config/switchboard/terminal-failures.json`, independently of relay restarts.
The store keeps 200 failure groups, counts repeats, and retains the latest eight
references per group. **Failure details** includes the session, target pane, operation,
worker build and focus/query confirmation flags. An engine build that was not
reported stays unknown. Reports exclude error text, terminal contents and typed input.
Existing retained workers pick up source reporting when they exit naturally and a
new worker starts; updated browser clients provide reporting in the meantime.

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

Cmd/Ctrl/Shift-click on an absolute, `~/` or `C:\` file path (or a `file://`
link) opens it. A file on the browser's own computer opens in its default app.
A paired computer's file streams into the preview pane through
`/api/hosts/<id>/file`, which reaches that computer's `/switchboard/files` with
the same credential as its terminals. Choosing a chat or submitting a new one adds
one browser history entry, so Back (or a mouse's back button) returns to the last
chat and steps over chats that have closed. Selections the page makes itself, such
as following a closed tab to its neighbour, rewrite the current entry instead. Loaded
terminal and Settings frames are reinserted to change page, because assigning their
`src` would add entries that Back spends undoing.

The open preview holds one browser history
entry, so Back (or a mouse's back button) closes it; the new-chat dialog does the
same. A chat chosen while either is open takes over that entry. The frame's pages replace
each other rather than adding entries, and closing the preview any other way
drops its entry. Files that could run scripts, such as HTML
and SVG, are served with `Content-Security-Policy: sandbox`; Chrome will not
play media or render PDFs under it, so those are served without it.

Cmd/Ctrl-click on an HTML file opens it in a browser tab on port 8091, including
when the terminal runs on the viewing computer. The relay creates a random URL
valid for 24 hours, scoped to the HTML file's directory. Scripts, relative styles,
images and data work there; the terminal relay remains on a separate origin.
Assets are read live rather than copied, and symlinks/junctions cannot escape the
chosen directory. A paired gateway checks the same boundary on its own disk at
`/switchboard/html-file`. Reopen the terminal link after a relay restart or expiry.

Clicking an image thumbnail or Cmd/Ctrl/Shift-clicking its path opens an image
carousel. It includes images in the current terminal's recent scrollback, resolves
relative paths, and removes duplicates. Previous/Next, arrow keys and swipe move
between images; Escape closes it and returns focus to the terminal. Images on the
Messages page open the same carousel for that message's images. Open original
keeps a direct browser-tab link to the displayed image.

Browsers refuse to let web pages open their own pages, such as
`chrome://settings/system`. A modified click on a `chrome://`, `edge://` or
`brave://` link therefore goes to `/api/open-browser-page`, and the relay starts
that browser with the page. `chrome://` opens in whichever Chromium browser is
viewing. The relay accepts only a fixed list of pages (settings, flags, gpu and
the like, never crash or quit) written in characters that need no shell quoting.
If the browser cannot be started, the link is copied and the status bar says so.

With Settings → Media previews on (off by default, saved in this browser), image
and video paths use the same route for previews. Hovering one in a terminal
shows it in a popup, and a message on the Messages page shows it inline, read from
the sender's computer. A media path ends at its extension, so it may contain
spaces, and drive, UNC, `~/` and `/` roots all match; a space followed by another
root starts a new path. The file route refuses UNC and device paths, even for a
click, so text on screen cannot make Windows contact another host.

In a terminal, a relative media path without spaces, such as `out/shot.png`, also
previews and opens. The page cannot tell which pane printed it, so it asks
`/api/hosts/<id>/resolve-file?session=&path=`, which runs `list-panes --json --all`
on the computer that owns the session and returns the path under the first pane
directory that holds the file, focused panes first. Paired computers answer the
same question at `/switchboard/resolve-file`. A relative path that no pane holds
shows no preview. The Messages page shows only rooted paths, since a message
does not say which directory its sender ran in.

With Settings → Terminal thumbnails on (off by default, saved in this browser), a
terminal also shows each media path on screen as a thumbnail, with no hover
(`thumbnails.js`). The setting is separate from Media previews. Zellij owns every
row, so a thumbnail sits over blank cells to the right of its path, up to 8 rows
tall and sized to the image. Paths on
consecutive rows share one band, side by side. A path with no blank room beside
it, or a file that fails to load, shows no thumbnail. Clicking one opens it the
way a modified click on its path does.

The Claude plugin's `SessionStart` hook tells Claude, inside Switchboard, that
printing a full path is how to show the user an image.

The Windows gallery on port 8765 uses the separate HTTPS origin
`https://zellij-gallery.localhost`, proxied through an anonymous HTTP listener
on 127.0.0.1:8091. It streams GET/HEAD responses from the configured
`artifact_proxy.target`. Its cookie jar and origin are separate from the
authenticated terminal relay. This supports the current gallery; WebSocket
artifacts need a proper host tunnel when required. Multiple read-only servers can
use the named proxy API described below.
Portless aliases `switchboard -> 8090` and `zellij-gallery -> 8091` persist; exact
`.local` would require changing the existing proxy/DNS setup. Each relay remains local to its own machine.

`zellij switchboard artifact FILE` publishes a file to `~/.switchboard/artifacts/`
and prints `http://127.0.0.1:8091/artifacts/COMPUTER/ID/FILE`. The same URL works
on every paired computer: the 8091 listener serves this computer's files directly
and reads another computer's through its paired gateway. Video seeks with byte
ranges and Markdown renders as a page. Artifact pages run on the 8091 origin,
which the terminal relay rejects. See [ARTIFACT_SERVING_PLAN.md](ARTIFACT_SERVING_PLAN.md).

Existing HTTP artifact servers can be registered with `POST /api/artifact-proxies`
from a local CLI. Each gets a separate loopback listener and an explicit public
HTTPS origin, suitable for private Tailscale Serve. `GET /api/artifact-proxies`
lists them. The `artifact-proxy` skill covers registration and verification;
[the artifact plan](ARTIFACT_SERVING_PLAN.md#proxy-existing-servers) records the API
and limitations. Registration starts immediately and persists across relay restarts.

## Copying text

Drag over terminal text to select and copy to the viewing computer's clipboard,
including when a remote app would otherwise copy to its own desktop. Plain clicks
still reach the terminal app, as do scrolling and Ctrl-drag mouse gestures.
You can also click **Select text**, or hold Option on Mac or Shift on Windows/Linux,
then drag and use **Copy**, Cmd+C on Mac, or Ctrl+Shift+C on Windows/Linux. The selected text is
retained through agent redraws and cleared when switching panes.
Ctrl+C without a local selection still interrupts the terminal process. Remote
OSC52 copies use this browser’s clipboard; denied permissions show a manual
copy panel instead of silently failing.
Settings → Logs records `Terminal clipboard` diagnostics under the session computer:
completed drags (including zero browser-selected characters), OSC52 receipt, copy
attempts, browser permission failures and fallback results. Only counts and state
flags are recorded, never clipboard text. These also appear in `/api/logs`.
Physical Ctrl+C also works through the hidden touch-keyboard input on touchscreen
PCs. Copy shortcuts still copy a terminal selection instead of interrupting.
Sidebar selection restores that same input, so Ctrl+V works without another
terminal click. Input stays suspended until the selected pane is confirmed.

## Pasting images

Terminal apps read their own computer's clipboard, not the browser's. Alt+V, or
a browser paste holding only an image, uploads it to the tab's computer
(`POST /paste-image`, kept for a day in Zellij's cache) and pastes the saved
path, which Claude Code attaches as an image. Alt+V with no image still reaches
the terminal.

## sudo passwords

`sudo -A` in a Switchboard pane asks for its password in the sidebar, so sudo
works where no terminal can prompt: an agent's shell or Claude Code's `!`. The
relay writes `~/.local/share/switchboard/sudo-askpass` at startup, pointing at
its own executable, and new panes get `SUDO_ASKPASS` set to it unless one is
already set. Panes started before that keep their environment; run
`export SUDO_ASKPASS=~/.local/share/switchboard/sudo-askpass` there. Plain `sudo`
without `-A` still uses the terminal.

The script runs `zellij switchboard askpass`, which posts the pane, sudo's prompt
and the requesting command line (read from the process table) to
`POST /api/askpass` and waits up to 2 minutes. The request rides on the
`/api/attention` snapshot as `askpass`, never with a password: the tab shows
**Password needed**, and selecting it opens a dialog with the command. **Send**
posts `/api/askpass/answer`; the relay hands the password to that one waiting
helper and keeps no copy. Closing the dialog any other way cancels, and sudo
fails at once. Interrupting sudo withdraws the request.

Paired computers see the request too, so you can answer `sudo` on one computer
from another's sidebar. The relay adds its open requests (never a password) to the
`/switchboard/attention` snapshot it serves paired computers, and they show the tab
as **Password needed**. **Send** there posts `/api/askpass/answer` with the
request's `host`; that relay forwards `{id, password}` to
`/switchboard/askpass/answer` on the asking computer over the pinned, peer-authorised
pairing connection, the one that already carries keystrokes into its terminals.
Neither relay keeps a copy. A computer that has not updated yet neither shares its
requests nor accepts forwarded answers. Any program running as you can
reach the loopback relay, so this protects the password from web pages, not from
your own processes; sudo's terminal prompt has the same limit. The Claude plugin's
`sudo` skill tells Claude to use `sudo -A`.

## Interactive commands

Claude Code's `!` and Bash tool run commands with stdin from `/dev/null` and no
terminal, so anything that prompts (`gio mount`, `ssh`, `gh auth login`,
`passwd`) fails or quits. `zellij switchboard run -- <command>` runs it where the
user can answer. One argument is an `sh` command line; several are a program and
its arguments. The relay writes `~/.local/share/switchboard/run-interactive` at
startup, pointing at its own executable, so panes started before an update can
use it. The Claude plugin's `interactive` skill tells Claude to use it.

The helper opens a floating pane beside the caller's
(`zellij run --floating --close-on-exit --blocking --near-current-pane`, which
also works from a floating caller) in the caller's directory, named
`Input needed: <command>`. The pane runs the command under `script` with
`SHELL=/bin/sh`, because `script -c` uses `$SHELL` and that may be nu; the
command gets the caller's `$SHELL` back. The recording, the pane id and the exit
status go to a private `switchboard-run-*` temp directory. When the pane closes,
the helper prints the recording without colours, cursor moves or `script`'s
banners, deletes the directory, and exits with the command's status. `script`
records what the pane shows, not what is typed, so a password typed with echo off
stays out of the recording. A helper that is killed first (an interrupted Bash
call) leaves the pane running; the pane deletes the directory itself when the
command ends.

The helper gives up after 9 minutes (`--timeout-secs` or
`SWITCHBOARD_RUN_TIMEOUT_SECS`), under Claude Code's 10-minute Bash limit: it
closes the pane, prints what it recorded, and fails. A pane the user closes
early fails with `The pane was closed before the command finished`. Windows has
no `script`, so the command refuses to run there.

While the pane is open the helper holds `POST /api/interactive`
(`{session, pane_id}`) open. The relay marks that local pane `input` with token
`interactive` on top of its scanned state, without recording it in the pane's
turn history, so the tab reads **Input needed** on every paired computer's
sidebar. The mark goes when the connection closes, however the helper ends.
Requests carrying a browser `Origin` or `Sec-Fetch-Mode` are refused.

## Escape key

Escape travels like any other key: xterm sends byte 27 on the terminal socket,
in order with typing. The web server holds a bare ESC for 50 ms to tell it from
a key sequence, then sends it with the bytes it held, so a pane without the
Kitty protocol still receives byte 27. Escape pressed while the sidebar has
focus is typed into the selected terminal the same way. Dialogs keep their own
Escape.

`acceptance/switchboard/run.cjs keys BINARY` types a lone Escape, Escape then a
key, and a double Escape into a raw-mode program in a private session, and
checks it reads the same bytes in the same order, along with Zellij's mode keys.

## Windows terminal input

The shared PTY writer keeps a separate pending-input queue for each terminal.
Windows uses a nonblocking byte pipe on the writer side, while ConPTY keeps a
synchronous reader. A full pipe returns zero bytes so the writer can service
other terminals and retry later. Writes are limited to 4 KiB because Windows can
reject an oversized nonblocking write even when some pipe space is available.
Queued input keeps its original order; a disconnected pipe remains an error.

## Instant typing

Settings → Appearance → **Instant typing** (off by default, stored per browser) turns on
`static/predict.js`, which the relay injects into every terminal frame next to `bridge.js`.
It draws typed characters at the cursor before the computer echoes them, underlined, on an
overlay above xterm. It drops each guess when the screen agrees with it, or when the guess
expires. Only plain typing, Backspace and Ctrl+W are guessed. Guessing starts only when everything
right of the cursor, up to a pane border, is blank or placeholder text: dim text (Claude Code's
placeholder) or a grey history hint that starts at the cursor (nushell, fish, zsh-autosuggestions).
Any other key, a click or a paste pauses guessing until the screen should have settled and a frame
has arrived since. A guess the screen never confirms disappears after a few round trips, and
guessing pauses after it. When output above the prompt moves it to another row, as Claude Code's
streamed replies do, often in a frame drawn before the keys arrived, the guesses move with it. After
Enter or another unguessed key the input on the new row is new, so the guesses are dropped instead.

Ctrl+Backspace and Alt+Backspace send Ctrl+W. Programs delete different amounts for it: readline,
Claude Code and Copilot CLI delete back to a space, nushell (reedline) to a word boundary, and Codex
to punctuation. All of them delete a run of letters, digits and `_` that follows a space, along
with the spaces after it, so only that case is guessed. As with Backspace, a space already on
screen is erased only after a word character, since prompts end in a symbol before their space.
Ctrl+W after punctuation or a prompt pauses guessing instead.

Echoes arrive in the order keys were sent, so each frame is matched to the earliest state it could
show, counting "nothing echoed yet". A frame drawn before an echo can otherwise pass for a later
state (Backspace, then retyping the same letter), remove the guesses early and show the screen
replaying the edit. Guesses are dropped as soon as the cursor shows on another row, except after
Enter or another unguessed key: a shell's echo of the last letters can arrive with the new line,
and the typed row showing every guess then confirms them.

Each dropped guess is logged, at most once a second per frame, as `Terminal typing miss`
in Settings → Logs and `/api/logs`: `outcome` is `timeout`, `moved` (the input changed rows) or
`screen` (the program switched screens), with how many guesses were pending, the echo time, the
time since the last unguessed key and since the last frame when guessing began, and the row and
column the guess expected against where the cursor was. It never includes what was typed.

Guesses stop showing when echoes come back in under 20ms and show again above 30ms. They are
still made and checked while hidden, to keep measuring. On the same computer, bash, nushell and
Claude Code echo in about 15ms, so their guesses stay hidden there; Codex and Copilot CLI take
about 200ms. The guessing state machine is covered by `tools/switchboard/predict.test.cjs` against
the real xterm parser. Against a real engine and relay, `latency.test.cjs BINARY --predict` types
into bash, clears each line with Ctrl+Backspace, and fails if any guess goes unconfirmed.

## Diagnostics

Settings → Performance shows how long user-visible waits took, for each computer whose browser
measured them, split by build and by the computer being viewed. The browser runs the clock
(`static/timing.js`) and the relay keeps every sample as a histogram in `timings.json`, so builds
can be compared; the last 12 builds are retained, with the five slowest samples and their stages
for each. Journeys are `terminal_to_conversation` and `conversation_select` (a chat shown from
memory), `conversation_load` (a chat fetched before it appeared), `conversation_connect` (waiting for
a running agent to report its chat), `conversation_to_terminal` and `terminal_input_ready`
(waiting for a reconnected viewer to enable typing, split into metadata and focus stages).
A journey during which the page was hidden, or that the user abandoned,
is counted by outcome but left out of the percentiles; timeouts and failures stay in them. `/api/timings`
returns the same data. The same journeys appear on a Switchboard track in Chrome's Performance panel.
To add a journey, name it in `JOURNEYS` in `timings.rs` and call `SwitchboardTiming.begin`.

Settings → Logs records each new-tab request's time to reach the terminal iframe,
time to send on its control connection, and total time until the new pane becomes
active. Slow creations and failures stay visible; fast creations are folded under
performance samples. A request waits for a connecting control socket, but a sent
creation is never retried automatically, to avoid duplicate tabs.
The engine's `zellij.log` also records request receipt, tab allocation, shell
startup duration, and layout duration, with client and tab IDs to locate native
queue delays. These timings do not measure when a shell finishes loading its profile.

Settings → Logs includes terminal tab switches: focus acknowledgment,
first frame, parser/render/frame scheduling delay, output byte/frame counts,
resize counts, and viewport size changes. Each switch observes ten seconds after
acknowledgment, so a short quiet gap cannot hide a later output replay burst.
Scrolling reports count xterm buffer movement, line feeds and wheel events, and
record actual xterm size changes and cropped rows. Buffer movement without line
feeds can expose unwanted wrapping even when the browser viewport stays normal.
A switch that lands on a tab of a different size logs **Terminal resize on switch**: the
tab's size on arrival and after, the window size, and who sized the tab before (this window,
another window, or nobody, which leaves it at its smallest viewer). Agents redraw on every
resize, so these lines explain flicker on tab switches and are kept as long as slow switches.
The computer that runs the session logs every tab resize to `zellij.log` as `Tab N resized`,
with the reason and every viewer's size and kind.
Control reports count native focus requests and cell pixel-size changes, including
changes that leave the terminal's row and column count unchanged. Terminal
transport reports summarize large upstream bursts and slow forwarding separately,
so browser parsing delays can be distinguished from screen updates arriving from
another computer.
Shift+Enter reports include browser modifier flags and Shift press/release timing.
These diagnostics contain no terminal contents or typed text. Slow native reflows
and ConPTY resizes also appear in `zellij.log`.
Browser-return reports include page-wide long animation frames, rendering,
style/layout and script time, where supported.
The terminal probe samples again after its rendering cycle, separating that work
from the time its reply waits to reach the sidebar. Zero long JavaScript tasks
alone does not rule out expensive rendering. These samples do not measure GPU
presentation time.

Returning to a Chrome browser tab has its own `Browser tab` report. It records
time hidden, lifecycle freeze/discard recovery, discarded-page startup time,
visibility-event delay, the first animation callback in the page and selected
terminal iframe, long main-thread
tasks, queued terminal writes, and terminal/control WebSocket states (0 connecting,
1 open, 2 closing, 3 closed). `-` means the measurement was unavailable.
The five-second observation window is not a measured freeze. Slow returns stay
visible in Logs; fast samples are folded under performance samples. These reports
do not force a native focus, terminal resize, or repaint.

The matching `Browser tab ... stages id=...` line splits the terminal probe into
`delivery` (page to iframe message handler), `frame` (handler to its animation
callback), and `reply` (callback to the page receiving the reply). These use
`performance.timeOrigin + performance.now()` so different document time origins
do not distort the comparison. An immediate receipt message preserves delivery
and initial queue measurements even if the animation callback never runs.
`queue=writes/render_pending->writes/render_pending` samples the iframe at receipt
and at the callback; an empty final queue does not rule out earlier queued work.
`hidden` and `active` describe the iframe at receipt. `tasks=count/max/totalms` on
this line counts iframe long tasks overlapping the probe, including tasks that
began before receipt. The iframe keeps only numeric timings, with a ten-second
lookback and a 256-task limit. It does not retain task attribution, URLs, or contents.
These animation callbacks measure scheduling, not completed terminal painting.

For a real background-tab check, set `PLAYWRIGHT_MODULE` and
`SWITCHBOARD_HEADFUL_RESUME=1`, then run `node tools/switchboard/browser-resume.test.cjs`.
This uses isolated fixture terminals, disables Playwright's forced-focus
emulation, and verifies that Chrome actually hides the tab before returning.

## Tests

Run the small checks with:

```sh
node --test tools/switchboard/*.test.cjs
cargo test -p zellij-client --features web_server_capability switchboard_ --lib
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

For native Codex delivery across paired computers, use `zellij message queue`
or `POST /api/hosts/{host}/codex/queue`. The authenticated destination runs
`codex queue`, without resuming a session or sending terminal keystrokes. Delivery
receipts make same-key retries safe; `queued` does not mean read. This path is
independent of board hosting and registration. See the
[native queue guide](MESSAGE_BOARD_USAGE.md#native-codex-queue-across-computers).

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
