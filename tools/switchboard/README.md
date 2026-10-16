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
pane. Starting a chat or submitting a prompt also saves the terminal layout.
After the terminal session is restored, these chats reopen automatically with
`codex resume ID`, `claude --resume ID` or `copilot --resume ID`. Original prompts
are not submitted again. Models and permission flags from the launch command
are kept. Other terminal commands still wait for confirmation.

Recovery never chooses the latest chat in a folder. Missing or unverified chat
identities leave the original command suspended. Remote agent servers that do
not inherit the terminal's Switchboard environment cannot be bound to a pane.
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
5. On the computer you're adding, the other computer's request appears under
   **Connection requests**. Check the code and choose **Codes match, allow**.

The new computer's tabs now appear on every computer, and the rest of your
computers learn about it automatically. If connecting fails, check that the
address hasn't changed and that port 8082 is allowed through the firewall.

You can also connect with a link: choose **Create invitation** on one computer,
send the link, and paste it under **Have an invitation?** on the other. Choose
**Join computer**, then approve on the first computer when the codes match.

## If something is wrong

- **In Switchboard:** **Settings → Logs** shows recent errors from every computer.
- **Mac:** `~/Library/Logs/zellij-switchboard.log` and `~/Library/Logs/switchboard-update.log`.
- **Windows:** the `web.log` and `update*.log` files in `~/.config/switchboard/`.

How Switchboard works, its shortcuts and its diagnostics are in
[Switchboard internals](../../docs/SWITCHBOARD_INTERNALS.md).
