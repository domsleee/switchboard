# Set up Switchboard

Switchboard shows the terminal tabs from all your computers in one browser
window. Install it on each computer, then connect them in Settings. After that
it runs in the background and updates itself.

After a computer restarts, start its terminal from **+** and Switchboard restores
the saved tabs and their displayed titles. Commands in restored tabs stay
suspended until you start them, because a restart ends the original shells and
agents. Tabs are saved every five seconds and replaced atomically. Tabs that
close while the computer shuts down do not replace the last save: a smaller set
of tabs is saved only after it has lasted a minute. A saved layout that cannot
load is kept beside it as `session-layout.unreadable-<time>.kdl`.

To check this on Windows with private test sessions:
`node tools/switchboard/restart_windows.test.cjs path\to\zellij.exe`.

## Switch between Claude and Codex

When the agent is ready, click its model name in Conversation, or choose
**Handover context…** from the tab's actions. Choose a model, add the next
request, and press **Switch model**.
The agent changes in the same tab and working directory. Switchboard checks
the destination alias or program before replacing the original process.

## Models

The model chip in New tab and handover lists the dotfiles shortcuts (`csol`,
`castra`, `c`) first, then every Claude model, then the models the chosen
computer's Codex reports (`codex app-server` `model/list`, served at
`/hosts/<host>/model-list`). Type on the chip to search, or to name any
model. A model other than a shortcut starts the agent directly, with the
shortcuts' bypass flags: `claude --dangerously-skip-permissions --model <model>`
or `codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m <model>`.
When a computer's Claude Code does not answer, the picker falls back to
`CLAUDE_MODELS` in `static/model-picker.js`.

The handover carries attributed user and assistant messages, including the
original request and recent exchanges, within 64 KB. Included messages keep
their complete text. The dialog reports omitted history; the context file
links back to the saved source conversation. Attachments, tool state and
private reasoning are excluded. Finish or stop a running turn before switching.

## Install on a Mac

You need Rust, the Xcode command line tools and `jq`. From this repository:

```sh
cargo install --path .
zellij switchboard install
```

Then open http://127.0.0.1:8090. A menu bar icon opens Switchboard and shows
its status. Quitting it leaves your terminals running.

## Install on Windows

1. Get `zellij.exe`: download `switchboard-windows-zellij.exe` from the
   [latest-main release](https://github.com/domsleee/switchboard/releases/tag/latest-main),
   rename it to `zellij.exe` and put it on your PATH. Or build it with
   `cargo install --path .`.
2. Run:

   ```powershell
   zellij switchboard install
   ```

Then open http://switchboard.localhost:8090. A tray icon starts with Windows.
Quitting it leaves your terminals running.

The first install sets up this computer's login on its own. Running it again
keeps your settings.

## Open on an Android phone

Use an HTTPS address on your private network. With Tailscale installed and signed
in on this computer and your phone, [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
provides HTTPS for the computer's `*.ts.net` name. Keep the computer awake while
using its relay, including for background notifications.

1. Get the computer's DNS name from `tailscale status --json` → `Self.DNSName`
   (omit its trailing dot).
2. Add `"browser_origin": "https://YOUR-COMPUTER.YOUR-TAILNET.ts.net"` at the top
   level of the existing host configuration, keeping its other fields. On Mac it
   is `~/.config/zellij/switchboard-hosts.json`; on Windows it is
   `~/.config/switchboard/hosts.json`. Restart only the relay service so it reads
   the new setting; leave terminal session servers running.
3. Run `tailscale serve --bg http://127.0.0.1:8090`. Enable HTTPS in the Tailscale
   admin console if the command asks. Use the relay's actual port if different.
   This gives devices allowed by your tailnet access to your terminal controls;
   use Serve within your private tailnet.
4. Open the printed HTTPS URL in Chrome on Android. In **Settings → This
   device**, choose **Install Switchboard**, or use Chrome's **Add to Home screen
   → Install** menu. Turn on **Attention notifications**, allow Chrome's permission
   request, then press **Send test notification**.

The relay sends encrypted Web Push when an agent needs approval or input, or has
a new result to review. Alerts work with the page closed; tapping one opens the
matching terminal. Each device opts in separately. The relay needs internet
access to the browser's push service; the phone needs Tailscale when opening the
terminal. Switching a device off removes its subscription. Plain HTTP LAN/IP
addresses cannot enable notifications or installation.

Push keys, subscriptions and delivery receipts persist beside the host config in
its `.push.json` file, readable only by its owner on Unix. Preserve this file
across updates. Terminal screens and password requests are never sent through
the push service. Existing unread results do not alert when you first opt in.

To remove phone access, run `tailscale serve --https=443 off`, remove
`browser_origin`, and restart only the relay. Other configured Serve paths or
ports should be preserved.

## Exact agent status

Switchboard reads each tab's screen to tell whether an agent is working. Claude Code,
Copilot CLI and Codex can report their own turns instead, which is exact: Claude also
shows **Waiting on an agent** when it finished but a background agent, workflow or a
shell it started this turn is still running. Conversation lists each one; click a row
to see the agent's steps or the shell's output. A shell already running at the previous
turn's end, such as a dev server, does not count. Reported status survives a relay restart.

Open Settings → **Health**. Each computer lists its Switchboard build and the agents
installed on it, with when each last reported. Press **Set up** next to an agent that
needs it, on any computer. Setup does only this:

- **Claude Code and Copilot CLI:** adds the `domsleee/switchboard` marketplace,
  installs and enables the `switchboard@switchboard` plugin, and turns on its
  auto-update in the agent's `settings.json`. The plugin also adds a `message-board`
  skill, so the agent can read, reply to and send
  [message board](../../docs/MESSAGE_BOARD_USAGE.md) messages.
- **Codex:** Setup installs the `switchboard@switchboard` plugin with all four
  skills and its own Codex status and message hooks in `hooks/codex.json`.
  The shared Claude hook file is never loaded by Codex. The hooks run a launcher in
  `~/.local/share/switchboard/` that Switchboard keeps pointed at its current
  executable. Setup trusts the plugin hooks through `codex app-server`, as Codex's
  own **Trust all and continue** would, and leaves other hooks untrusted. If that
  fails, Codex asks at its next start. The relay also trusts them when it starts, so
  computers with the new plugin catch up after their next update. After Codex
  confirms every plugin hook is trusted, setup removes Switchboard's old entries
  from `~/.codex/hooks.json`, keeping other hooks and a backup. A failed trust check
  leaves those entries intact. Health requests setup for an older plugin and
  **Trust hooks** for an untrusted one. Changed plugin content needs trust again.
  Dotfiles' `csol` and `castra` shortcuts pass `--dangerously-bypass-hook-trust`,
  which runs enabled hooks for that invocation without saving trust; direct Codex
  launches still use the saved trust that setup verifies.
  If the plugin updates before the relay, finish setup with the updated relay before
  restarting Codex. Bypass shortcuts can run both hook sets until migration succeeds;
  per-session locks prevent duplicate message delivery and competing watchers.

Running sessions pick up the plugin or hooks after a restart. Copilot's hooks run
`zellij` from `PATH`, so this fork's `zellij` must be on it.

To set up Claude Code by hand instead:

```sh
claude plugin marketplace add domsleee/switchboard --sparse .claude-plugin plugins
claude plugin install switchboard@switchboard
```

If this computer has the earlier `switchboard-status` plugin, remove it first with
`claude plugin uninstall switchboard-status@switchboard`.

## Search agent chat history

Agents can search and read Claude Code, Codex, Muse Code, Copilot CLI and
OpenCode history across paired computers through the relay's HTTP endpoints.
See [Chat history API](../../docs/SWITCHBOARD_CHATS.md) for curl examples,
pagination and coverage limits.

## Resume agent chats after a restart

Run this once with the updated executable on each computer:

```sh
zellij agent-resume install
```

This adds session hooks for Codex, Claude Code and GitHub Copilot CLI. Existing
hooks and settings are kept, and the original files are backed up beside them.
Custom `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `COPILOT_HOME` directories are respected.
Restart an already open agent if it does not reload its hook settings.

The hooks record the exact chat ID, folder and launch options for each terminal
pane and save the terminal layout. Claude records at session start, including
clear, resume and compact; reinstalling removes its redundant per-prompt recovery
command. Settings → Health also detects and repairs that older command. Claude's
regular activity hooks call the relay over HTTP, avoiding a Windows process launch
on each prompt or tool call.
After the terminal session is restored, these chats reopen automatically with
`codex resume ID`, `claude --resume ID` or `copilot --resume ID`. Original prompts
are not submitted again. Models and permission flags from the launch command
are kept. Other terminal commands still wait for confirmation.

Recovery never chooses the latest chat in a folder. Missing or unverified chat
identities leave the original command suspended, even if it contains a resume
ID. After renaming a terminal session, restart its agents so their hooks use the
new session name; old-name records cannot resume automatically. Remote agent
servers that do not inherit the terminal's Switchboard environment cannot be
bound to a pane.
For Codex, use `codex --no-daemon` to keep hooks in the terminal process instead
of a shared background server. Approve the installed hooks in Codex when asked.
An agent that cannot reopen its saved chat stays visible with its error instead
of closing the tab.

Existing terminal engines keep their loaded version. Agent recovery requires
a session engine started with the updated executable; installing hooks does not
restart any running terminals.

## Connect your computers

Both computers need Switchboard installed and on the same network.

1. On the computer you're adding, open **Settings → Computers**. Check its name
   under **This computer**. If you see **Choose a connection**, pick the network
   your computers share.
2. Find the other computer's address: on that computer, open **Settings →
   Computers → This computer → Advanced connection settings** and copy
   **Computer address**.
3. Back on the computer you're adding, enter it under **Add computer → Other
   computer's address** and choose **Send request**.
4. On the other computer, under **Connection requests**, check the code matches
   and choose **Codes match, allow**. If it shows **Receive connection
   requests**, choose that first.
5. On the computer you're adding, the other computer's request appears below
   the computer list. Check the code and choose **Codes match, approve**.

The new computer's tabs now appear on every computer, and the rest of your
computers learn about it automatically. If connecting fails, check that the
address hasn't changed and that port 8082 is allowed through the firewall.

You can also connect with a link: choose **Create invitation** on one computer,
send the link, and paste it under **Have an invitation?** on the other. Choose
**Join computer**, then approve on the first computer when the codes match.

## Preview sidebar changes live

To see edits to `tools/switchboard/static` with your real tabs and chats before
they ship, run this from a checkout on a computer with a running relay:

```sh
node tools/switchboard/dev-preview.cjs
```

Open `http://127.0.0.1:8199/`. The page, styles and scripts come from the
checkout; everything else goes to the relay. Saving a stylesheet updates the
page in place, and saving any other file reloads it. Changes to the relay itself
still need a build.

To open it from another of your devices, add `--allow` with that device's
address, for example `--allow 192.168.1.20`, and open this computer's address
on port 8199. Allowed devices get full terminal control over plain HTTP, so
allow only your own devices on a network you trust. `--port`, `--relay` and
`--static` change the port, the relay port and the folder served.

## If something is wrong

- **In Switchboard:** **Settings → Logs** shows recent errors from every computer.
- **Mac:** `~/Library/Logs/zellij-switchboard.log` and `~/Library/Logs/switchboard-update.log`.
- **Windows:** the `web.log` and `update*.log` files in `~/.config/switchboard/`.

How Switchboard works, its shortcuts and its diagnostics are in
[Switchboard internals](../../docs/SWITCHBOARD_INTERNALS.md).

### Conversation view

Open **Conversation** above a terminal to read the chat reported by that pane's
agent hooks. Phones open Conversation by default. The selected chat preloads in
Terminal mode, and recently visited conversations render immediately from memory.
A live stream follows new transcript messages and updates without attaching a
terminal viewer. Long chats keep their latest messages available beyond the old
history limits; scroll up for earlier pages. The stream shows text when the agent
saves it, so providers that save only completed messages do not stream individual
tokens. Tool output remains in **Terminal**.

Use the composer to send replies and attach files. Codex uses its native message
queue; other agents use the guarded terminal connection. Drafts remain separate
per pane and survive failed sends. Conversation automatically chooses **Trust all
and continue** on Codex's exact startup hook-review menu. Other approval and input
prompts still require Terminal.

The conversation view renders Markdown headings, lists, tables, fenced code,
links, and media without executing transcript HTML. Image references open an
expandable gallery with zoom; video references use inline playback controls.
Local and relative paths are read from the selected chat's computer, with relative
paths based on the chat's recorded project directory. HTTP(S) media URLs load in
the viewing browser; loopback URLs are not treated as phone-local media.

Claude and Codex image/video content parts are preserved when their transcripts
retain a path or URL. Supported embedded PNG/JPEG/GIF/WebP images have a 2 MiB
encoded-data budget per chat and at most eight attachments per message. Missing,
unsupported, invalid, and oversized attachments show an unavailable state. This
is media viewing, not attachment uploading. Other providers still expose their
text messages and Markdown media references.

Reply drafts remain literal text, including `$skill-name` and `/commands`.
Switchboard does not translate command names between providers. Native command
and skill autocomplete is not implemented in this view.
