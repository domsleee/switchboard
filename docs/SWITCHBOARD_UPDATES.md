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
server IDs and pane identities afterward and restores the previous executable
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

Verify on both platforms that an update and a failed-update rollback preserve
session and child-process IDs, ongoing output, terminal input, scrollback, and
saved user state. Existing sessions must remain reachable, and new sessions
must start with the new engine. Also test mixed versions, interrupted downloads,
updates while the browser is disconnected, repeated upgrades of a long-lived
session, and a machine catching up after several missed releases.
