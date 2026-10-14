# Set up Switchboard

Switchboard shows the terminal tabs from all your computers in one browser
window. Install it on each computer, then connect them in Settings. After that
it runs in the background and updates itself.

## Install on a Mac

You need this repository, Rust, the Xcode command line tools and `jq`.

```sh
cargo install --path .
python3 tools/switchboard/install_service.py
```

Then open http://127.0.0.1:8090. A menu bar icon opens Switchboard and shows
its status. Quitting it leaves your terminals running.

## Install on Windows

1. Get `zellij.exe`: download `switchboard-windows-zellij.exe` from the
   [latest-main release](https://github.com/domsleee/switchboard/releases/tag/latest-main),
   rename it to `zellij.exe` and put it on your PATH. Or build it with
   `cargo install --path .`.
2. In PowerShell, from this repository:

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools/switchboard/install_windows_web.ps1
   ```

Then open http://switchboard.localhost:8090. A tray icon starts with Windows.
Quitting it leaves your terminals running.

The first install sets up this computer's login on its own. Running an
installer again keeps your settings.

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
