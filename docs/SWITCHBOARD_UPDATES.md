# Updating Switchboard without stopping terminals

Status: a manual macOS binary updater is available. Automatic updates and
Windows updates are not implemented yet.

Updating Switchboard must preserve running shells, Codex, Claude, builds, and
other terminal processes. A short browser reconnect is acceptable. Automatically
closing or recreating sessions is not.

Switchboard is intended for long-term use across multiple machines. Sessions
may live through many releases, and machines may return after weeks offline.
Updates must support both without losing processes or requiring a fresh install.

## Update this Mac now

After building or downloading a trusted macOS executable, install `jq` if needed
(`brew install jq`), then run:

```sh
bash tools/switchboard/update_local.sh target/release/zellij
```

Running services, browser connections, and terminal processes stay running.
The updater checks that the candidate can query every live
session, retains both binaries under `~/.local/share/switchboard/releases`,
and replaces `~/.cargo/bin/zellij` with an atomic rename. It verifies session
server and direct terminal-child IDs/start times and pane identities afterward and restores the previous executable
if a check fails. Staging and rollback verify the executable checksum before
renaming. If rollback cannot copy the retained executable, it leaves the complete
installed executable in place and reports the retained path for manual recovery.
Each read-only CLI probe has a 15-second timeout. Pane JSON is validated and
compared by stable identity; changing a tab's position does not fail verification.

The optional second argument selects a different installed binary. This is a
local executable updater, not a complete bundle updater. It does not download
releases, restart web services, update relay or tray files, or migrate settings.
The probes establish CLI query compatibility, not browser protocol compatibility.
Keep both retained releases until older sessions finish; no cleanup is automatic.
An engine update takes effect in new sessions. Panes added to an existing
session continue using that session's original engine.

The isolated `node tools/switchboard/update_local.test.cjs OLD_BINARY NEW_BINARY` test
checks rejection of incompatible, malformed, and stalled candidates; installation
and rollback (including a failed rollback copy); surviving server and PTY child
IDs; continuing terminal output; and creation of new native sessions. It does
not test terminal input or browser reconnection. Tests use a private socket and
release directory (`SWITCHBOARD_RELEASES_DIR`).

The separate headless `node tools/switchboard/update_browser.test.cjs OLD_BINARY
NEW_BINARY` acceptance test requires Playwright (or `PLAYWRIGHT_MODULE` pointing
to its module). It creates a unique private session and connection services on
unused loopback ports. Without mocking the catalog or terminal, it verifies
real browser input/output before and after a failed-update rollback, installing the binary and restarting
only the web daemon and relay. It checks automatic reconnection, preserved shell
variables, server and terminal process IDs/start times, stable tab/pane IDs,
selected terminal URL, and sharing. Both terminal and control WebSockets must
actually be open before input is tested. This covers connection-service restarts,
not a session-engine restart, automatic deployment, or Windows behavior.

## Recovering an existing unshared session

New engines support `zellij -s main action set-web-sharing on` and `off`
without plugins. These commands cannot enable sharing when the session was
created with sharing disabled. They do not restart shells.

An already running engine without this action cannot be upgraded in place.
For an explicitly authorized, known unshared local session, the web service
supports `SWITCHBOARD_RECOVER_UNSHARED_SESSION=main`. This temporary adapter
requires loopback binding, writable authentication and the exact existing
Unix socket. It neither creates a session nor changes its engine sharing policy.
The catalog identifies it with `sharing_recovery: true`.

Recovered viewers count as native clients. The adapter cannot distinguish the
old engine's session-specific Off policy from Disabled, so only use it for a
session whose original settings are known and authorized. Read-only tokens
cannot use it. Restart the web service without the variable to revoke recovery;
the old engine's stop-sharing control cannot revoke these adapted viewers.
Socket replacement invalidates recovery rather than exposing a new same-name
session. Verify real terminal rendering and input/output, not just the catalog.

For service restarts, persist the original socket identity in
`SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY` (`device:inode:ctime-seconds:ctime-nanoseconds`).
The Mac tray and installer can read `~/.local/share/switchboard/native-web-recovery.json`
with `session`, `socket_path` and `socket_identity` fields. They retain recovery
only for that socket; a replacement session requires its own native sharing.
Temporary recovery reconstructs tab metadata from the existing engine's queries.
It lacks native viewport ownership and exact focus for multi-pane tabs. Normal
new shared engines retain those features.

## Rust consolidation preview

The executable now includes an opt-in Rust relay:

```sh
zellij serve --host-config ~/.config/zellij/switchboard-hosts.json --port 8093
```

This embeds the current UI and supports host catalogs, terminal HTTP/WebSockets,
token authentication and certificate pinning. It uses the same executable as the
session engine, and leaves the production relay alone. Attention, Escape,
close-tab and artifact proxying still require the production Python relay;
the preview reports unsupported endpoints explicitly. Do not switch the
production service until those features pass parity checks. The current sidebar
also obtains its stable tab catalog from the attention endpoint, so the preview
is a transport implementation rather than a usable replacement dashboard yet.

## Long-term priorities

- Keep protocol compatibility explicit, with version negotiation and tested
  upgrade paths. Do not assume every machine or session upgrades together.
- Keep resource use low. Remove obsolete version directories only when no
  running session or rollback depends on them; retain extra services only when
  needed to support active sessions.
- Preserve user data through repeated upgrades and rollbacks. Version persistent
  formats and test migrations from supported older releases.
- Treat upgrading the engine underneath live terminals as a long-term design
  objective. The first updater's use of older session engines is a practical
  starting point, with a clearly stated limitation.

## Complete bundle updater design

Install each release into its own version directory. Keep settings, credentials,
and notification history outside those directories.

The updater can restart the tray app, relay, and web services while leaving
existing Zellij session servers running. The browser reconnects to those sessions.
New sessions use the new binary; existing sessions retain their original engine,
including any new panes created inside them.

Retain older binaries and required assets until their sessions finish. Check
client/server protocol compatibility before switching services. If a release
cannot connect to an older session, retain a compatible connection service for
that session rather than restarting it.

Show the installed version and update status for each machine. Identify sessions
still using an older engine, with an explanation that restarting the session
would stop its processes. Never trigger that restart automatically.

## Delivery and recovery

1. GitHub Actions builds and tests complete bundles for Windows and Mac.
   Publish a preview release after successful builds; promote tested releases
   to the stable channel. Give Switchboard its own version and record the
   upstream Zellij version separately.
2. Publish versioned bundles to GitHub Releases. Actions artifacts expire and
   should not be the installation source. Include the native binary, web UI,
   relay, tray app, and any matching plugin assets.
3. A small Rust updater checks at startup and periodically, downloads bundles,
   and verifies their signatures before installation. The tray provides
   **Check for updates**, **Update now**, and an automatic-update setting.
4. Stage the complete bundle, switch versions, and check service health. Keep
   the previous version and roll back if startup or reconnection fails.
   Persistent-data changes must remain compatible with rollback.

For the private repository, use repository-scoped, read-only release access.
Store credentials in macOS Keychain or Windows Credential Manager, outside the
browser and release bundles.

Implement release publishing first, then manual tray updates, then automatic
updates. Each machine downloads prebuilt packages rather than compiling locally.

GitHub documents [artifact expiry](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
and [read-only release asset permissions](https://docs.github.com/en/rest/releases/assets).

## Why the session engine cannot restart safely today

### Recovering after an explicitly requested engine restart on Mac

Creating `main` with `attach --create-background` restores the server only.
It does not reconnect the terminal client. After the replacement session is
ready, the restart handoff must run:

```sh
python3 tools/switchboard/recover_local.py --session main --open-window
```

This waits for running terminal panes, opens the existing session in a new iTerm
window, and confirms a new attached client before reporting
success. It never creates or resurrects a session, or sends commands to an
existing shell. Run it from outside the session being replaced. Omit
`--open-window` for manual recovery that skips opening another window when a
client is already attached.

For browser recovery, preserve the old session's sharing setting when creating
the replacement. A shared replacement needs `attach --create-background main
options --web-sharing on`. The default is off, so a healthy web daemon and relay
alone do not confirm that Switchboard can connect. Check `/api/hosts/mac` for
`web_clients_allowed: true`, and retry the public URL health check while services
start. Restore the terminal client before checking optional browser services, so
a temporary HTTP failure cannot skip terminal recovery.

The Zellij session server owns the terminals and their child processes.
Its [PTY cleanup](../zellij-server/src/pty.rs) closes panes when the server exits.
On Windows, it also owns the ConPTY handles. Replacing files on disk does not
upgrade a running session, and saved session layouts do not preserve live
processes.

Therefore the first updater preserves sessions by keeping their existing engine
running. Engine fixes take effect in new sessions.

## Possible later architecture

A persistent Rust terminal host could own PTYs on Mac and ConPTYs on Windows,
while a replaceable session engine handles layouts, rendering, and input.

Upgrading the engine would require a versioned handoff of terminal state,
scrollback, layouts, plugin state, and buffered input/output. The terminal host
would keep reading output during the handoff and remain alive if the replacement
engine fails. Updating the terminal host itself would still need a separate
strategy.

This is substantial work, especially across platforms. Consider it after the
first updater if applying engine fixes to long-running sessions becomes essential.

## Acceptance checks

An update is successful only when existing terminals are usable through
Switchboard. A healthy daemon, HTTP 200, attached iTerm client, or a retained
layout alone is insufficient. Verify shared-session discovery, actual terminal
and control WebSocket connections, and terminal input producing output through
the browser after automatic reconnection. Preserve shell/agent processes, tab
identity, selected terminal, and sharing preferences. Do not use engine restarts
or manual terminal attachment as routine recovery. If only the processes or HTTP
services recovered, report partial recovery and keep the previous compatible
connection service available rather than claiming success.

Verify on both platforms that an update and a failed-update rollback preserve
session and child-process IDs, ongoing output, terminal input, scrollback, and
saved user state. Existing sessions must remain reachable, and new sessions
must start with the new engine. Also test mixed versions, interrupted downloads,
updates while the browser is disconnected, repeated upgrades of a long-lived
session, and a machine catching up after several missed releases.
