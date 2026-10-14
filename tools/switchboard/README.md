# Set up Switchboard

Switchboard shows the terminal tabs from all your computers in one browser
window. Set it up once on each computer, then pair them. After that it runs in
the background and updates itself.

## What you need

- This repository checked out on the computer.
- Rust, to build the `zellij` executable.
- On Mac: Xcode command line tools (for `swiftc`) and `jq`.

## Mac

1. Build and install the executable:

   ```sh
   cargo install --path .
   ```

2. Create a login token and save it to a file:

   ```sh
   zellij web --create-token
   ```

   It prints `token_1: <token>`. Put just the token in `~/.config/zellij/mac-token`.

3. Create `~/.config/zellij/switchboard-hosts.json` for this computer:

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

4. Install the menu bar app and background service:

   ```sh
   python3 tools/switchboard/install_service.py
   ```

5. Open http://127.0.0.1:8090 (or https://switchboard.localhost if you use
   Portless).

The menu bar icon opens Switchboard and shows its status. Quitting it leaves
your terminals running.

## Windows

1. Build `zellij.exe` with `cargo install --path .`, or download
   `switchboard-windows-zellij.exe` from the
   [latest-main release](https://github.com/domsleee/switchboard/releases/tag/latest-main)
   and put it on your PATH as `zellij.exe`.
2. Create a login token with `zellij web --create-token` and save just the token
   to a file, for example `~/.config/switchboard/windows-token`.
3. Create `~/.config/switchboard/hosts.json` like the Mac example above, with
   your own id, name and token file, and add `"escape_transport": "local"` to
   the entry.
4. In PowerShell, from the repository:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1
   ```

5. Open http://switchboard.localhost:8090.

A tray icon starts with Windows. Quitting it leaves your terminals running.

## Pair another computer

1. On a computer that's already set up, open **Settings → Computers → Create invitation**.
2. Paste the invitation on the new computer and choose **Join**.
3. Check the codes match on both screens, then approve.

Every paired computer can invite the next one. Don't copy tokens or add other
computers to the hosts file by hand.

## If something is wrong

- **In Switchboard:** **Settings → Logs** shows recent errors from every computer.
- **Mac:** `~/Library/Logs/zellij-switchboard.log` (service) and `~/Library/Logs/switchboard-update.log` (updates).
- **Windows:** `~/.config/switchboard/` (`web.log` and `update*.log`).

How Switchboard works, its shortcuts and its diagnostics are in
[Switchboard internals](../../docs/SWITCHBOARD_INTERNALS.md).
