# Updating Switchboard without stopping terminals

Windows and macOS installers enable automatic connection-service updates.
The manual guarded updaters remain available for release selection and recovery.

## Automatic updates

Each push to `main` builds Windows, Apple Silicon and Intel Mac bundles: the
native executable, platform helpers and `bundle.json` (commit, run number,
platform and SHA-256 of every file), written by `zellij switchboard package`.
When all checks pass, `native-binaries.yml` replaces the assets of one rolling
prerelease, `latest-main`, as `switchboard-<platform>-<file>`, each manifest
last. The release is created once and never recreated, so followers are not
notified per build; the tag follows the build's commit. Only this repository's
`main` publishes. Each bundle is also kept as a 30-day Actions artifact for
updaters installed before this change.

The executable is the updater: `zellij switchboard update` (`--check` downloads
and verifies only). The macOS LaunchAgent `dev.switchboard.update` and the
Windows tray run it every 15 minutes; neither needs Python or the GitHub CLI.
macOS also needs `jq` for `update_local.sh`. Windows checks stop when its tray
exits; the Mac updater runs independently of the menu app. The updater reads
the manifest over HTTPS first and installs only a run number newer than the last
one it tried. Assets whose checksum does not match (normally a newer upload in
progress) are skipped and retried on the next run.

On macOS the bundled `update_local.sh` does the handoff: compatibility probes,
atomic install, `zellij web --stop`, then `launchctl kickstart -k` of
`dev.zellij.switchboard`. Services restart only through launchd; the updater
never starts a relay itself. On Windows the bundled PowerShell helpers select
the release and restart the captured relay and web service. Both then wait for
the expected build and the previously visible sessions, and only then install
the new helpers and reload the tray or menu. The tray is found by its installed
path (beside the installed helpers), not by where the helper runs; the updater
waits for the old tray's single-instance lock before starting the new one, and a
tray that cannot get the lock logs the failure and exits non-zero. An update or
reinstall started without `--config`/`-Config` reuses the running tray's
settings, including in the logon shortcut.

Healthy existing sessions retain their engines, shells and agents, including new
tabs created inside those sessions. A browser reconnect is expected. New sessions
use the selected release when started through the updated services/launcher.
On Windows a separate old `zellij.exe` on PATH is not overwritten; use the
installed `windows_cli.ps1` launcher to follow the selected release.

A failed handoff restores the retained executable and helpers and restarts
services on it. Rollback is local: the previous executable and helpers are kept
in `automatic-updates/rollback-*`. A failed build is recorded and not retried; a
newer build remains eligible. Download failures leave running services untouched.

An interrupted handoff leaves `pending` in `state.json`. The next run settles it
before checking for builds:

- Relay answers `/api/health` as `rust` and the journal's sessions are listed:
  the journal is stale (the update completed, never started, or was superseded).
  It is dropped with a notice, and the normal check continues.
- Relay healthy on a build that is neither side of the journal (updated by other
  means): also dropped. Recovery would downgrade it.
- Otherwise (relay unreachable or sessions missing): recover. The previous
  executable is reinstalled using the helpers retained beside it, run from the
  rollback directory; installed helpers are never overwritten with older ones.
- A failed recovery is recorded in `error` and the journal is dropped, leaving
  services as they are. It never blocks a later build. `--check` refuses only
  while recovery is needed.

The retired `auto_update.py` is now a shim that forwards to
`zellij switchboard update`, so computers still scheduling the Python updater
migrate through one normal update. Reinstall (`install_service.py` or
`install_windows_web.ps1`) to schedule the executable directly.

Settings, host credentials and attention data are not bundled or replaced. A
published build updates each online, configured machine on its own schedule, not
all machines at the same instant.

Inspect `~/.local/share/switchboard/automatic-updates/state.json` for the selected
commit or failure. Windows logs are `~/.config/switchboard/update*.log`; Mac logs
are `~/Library/Logs/switchboard-update.log`. For a download-and-verify check without
service changes, run `zellij switchboard update --check`.

`cargo test -p zellij-client --features web_server_capability switchboard_update --lib`
covers the pending decisions, bundle verification, state compatibility, download
retries, rollback and backoff with a fake relay and fake helpers; on macOS it
also runs the real `update_local.sh` against a fake `launchctl`, and the Windows
sequence runs its PowerShell helpers' fakes when `pwsh` is installed. The opt-in
Windows browser test also accepts `SWITCHBOARD_TEST_AUTO_UPDATE=1` and
`SWITCHBOARD_TEST_CANDIDATE_COMMIT=<full commit>` to exercise `zellij switchboard
update` and its automatic rollback with two real builds in private sessions. It
checks real browser input/output, session/shell/agent-fixture process continuity,
tab identity and sharing. Runtime health/catalog checks do not inject terminal
input into user sessions.

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

This is a full local update. Terminal processes stay running; browsers reconnect.

1. Preflight, before changing anything: the candidate must see the installed
   authentication tokens and query every live session with identical pane
   identities, and the launchd job `dev.zellij.switchboard` must be loaded and run
   this installation's `zellij serve`.
2. Retain both binaries under `~/.local/share/switchboard/releases` and replace
   `~/.cargo/bin/zellij` with a checksum-verified atomic rename.
3. Check that session server PIDs/start times and pane identities are unchanged.
4. Run `zellij web --stop`, wait for the old web server to exit, then
   `launchctl kickstart -k` the job, which starts `zellij web --daemonize` and
   `zellij serve` on the new binary. Session servers are separate processes.
5. Within 60 seconds, require that every previous web/relay process is gone, new
   ones run from the installed path, `zellij web --status` answers and the relay's
   `/api/health` answers (and matches `SWITCHBOARD_EXPECTED_COMMIT` when set).
   Halfway through, a plain `zellij web --daemonize` is started if web is still
   down: a job pinned to `SWITCHBOARD_RECOVER_UNSHARED_SESSION` for a replaced
   socket daemonizes and then exits, so its own fallback never runs.
6. Recheck session server PIDs and pane identities.

Shells and agents inside sessions may exit on their own; only session servers
must survive. Any failure after step 2 restores the previous executable and, if
services were already restarted, restarts and rechecks them on it. If rollback
cannot copy the retained executable, it leaves the complete installed executable
in place and reports the retained path. Each read-only CLI probe has a 15-second
timeout.

`--binary-only` skips steps 4–6 and the job preflight (the old behaviour), also
selected by `SWITCHBOARD_UPDATE_BINARY_ONLY=1`. The automatic updater uses the
full update, with `SWITCHBOARD_EXPECTED_COMMIT` set to the bundle's commit.
The optional second argument selects a different installed binary. `SWITCHBOARD_LAUNCHD_LABEL`, `SWITCHBOARD_RELAY_PORT` and
`SWITCHBOARD_UPDATE_SERVICE_TIMEOUT` exist for isolated tests. This does not
download releases, update tray files or migrate settings. The probes establish CLI
query compatibility, not browser protocol compatibility.
Keep both retained releases until older sessions finish; no cleanup is automatic.
An engine update takes effect in new sessions. Panes added to an existing
session continue using that session's original engine.

The isolated `node tools/switchboard/update_local.test.cjs OLD_BINARY NEW_BINARY` test
runs real web/relay services from a fake `launchctl` on private ports, HOME,
sockets and release directory. It checks the job preflight; rejection of
incompatible, malformed and stalled candidates; installation and rollback
(including a failed rollback copy); web and relay restarted onto the new build,
including a job pinned to stale recovery; a post-restart failure rolling back and
restarting services on the old build; `--binary-only`; surviving server and PTY
child IDs; continuing output; and new native sessions. It does not test real
launchd, terminal input or browser reconnection.

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

## Select a Windows release without stopping terminals

The Windows installer imports its executable into
`~/.local/share/switchboard/windows-releases/<sha256>/zellij.exe`. It installs the
release helper, manual updater and CLI launcher beside the tray script. Settings,
host credentials and logs remain outside the retained releases. Reinstalling the
tray keeps an existing release selection; use the updater to change it.

From PowerShell, after building or downloading a trusted executable (add
`-BinaryOnly` to only select the release):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/switchboard/update_windows.ps1 -Candidate C:\build\zellij.exe
# Use the installation's custom config/release directory when applicable:
powershell -NoProfile -ExecutionPolicy Bypass -File tools/switchboard/update_windows.ps1 -Candidate C:\build\zellij.exe -Config C:\config\host.kdl -ReleaseDirectory C:\Switchboard\releases
# Select the retained previous executable:
powershell -NoProfile -ExecutionPolicy Bypass -File tools/switchboard/update_windows.ps1 -Rollback
```

Windows locks loaded executable files. This updater copies each executable to a
retained version directory and atomically replaces `current.json`; it never
overwrites a loaded executable. Probes are bounded, read-only CLI calls. The
candidate must query live panes with matching stable IDs and native tab names,
and query an already running native web daemon when the installed CLI can do so.
The updater compares engine PIDs and full creation timestamps before and after
selection; shells and agents may exit on their own. A failed check restores the
old pointer. Both executables remain available locally.

By default it then performs the same service handoff as the automatic updater.
Before selecting, it captures this installation's relay (listening on
`-RelayPort`, default 80, with `-HostConfig`) and `web --start` process, engine
identities and pane snapshots; it refuses if they cannot be identified. While it
holds `handoff.json` the tray does not restart services. It stops only the
captured service PIDs (identity rechecked, never a `--server` engine), starts both
from the selected release, and requires both to stay up and listen, the relay to
answer `/api/health`, and engines and panes to be unchanged. On failure it
re-selects the previous release and restarts services on it.

An exclusive file handle prevents concurrent updates. The retained `update.lock`
file alone does not block future operations. If interruption or a failed pointer
restore leaves `pending.json`, another update is refused; `-Rollback` restores
the verified previous selection. A corrupt or missing retained executable fails
closed and requires manual recovery from a trusted copy. No release cleanup is
automatic.

Use `~/.config/switchboard/windows_cli.ps1 attach SESSION` to launch a native
client using the selected release. Existing sessions retain their original engine,
including new panes inside those sessions. With `-BinaryOnly`, the tray uses the
pointer only for future service starts and loaded services keep their old code.
Neither mode restarts the tray or session engines, or claims browser recovery.

`node acceptance/switchboard/run.cjs windows-update` runs actual PowerShell file
transactions and subprocess quoting/timeouts with simulated Windows process,
Zellij and service responses. It also executes the actual tray supervision function
without WinForms, startup shortcuts or live services. PowerShell 7 on this Mac
passes 54 release checks and 20 tray checks; Windows PowerShell 5.1/NTFS, login
startup and real ConPTY behavior still require Windows evidence.

`node acceptance/switchboard/run.cjs windows-browser OLD_BINARY NEW_BINARY`
requires Windows, two distinct compatible executable builds and headless
Playwright. It creates private sockets, unused loopback ports, two named disposable
shells and a long-lived agent **fixture**, then checks actual browser input/output,
both open WebSockets, automatic reconnection and manual rollback after a controlled
private service failure. It compares PID/creation times, shell variables, ongoing
output, a scrollback marker, native/sidebar names, IDs, selected URL and sharing,
and starts a new engine with the selected release. It creates and revokes only its
own authentication token. This runner drives the selector function directly and
restarts the private services itself; it does not exercise `update_windows.ps1`'s
service handoff. This runner has been syntax checked
on Mac, not executed on Windows. Actual Codex/Claude turns and Windows login/tray
lifecycle remain separate acceptance work.

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

## Rust relay

The executable includes the sidebar and Rust relay:

```sh
zellij serve --host-config ~/.config/zellij/switchboard-hosts.json --port 8090
```

This embeds the UI and supports host/tab catalogs, attention polling, targeted
Escape and tab closing, terminal HTTP/WebSockets, private token authentication,
certificate pinning and the separate artifact listener. Attention identities use
the same `.attention.json` file as the old relay. Each host polls independently;
an unavailable host loses stale badges without holding up other hosts.

The Mac and Windows installers start `zellij serve`; Python and `uv` are no
longer needed at runtime. Each relay queries its own engine with the installed
CLI and reaches paired computers through their gateways, which run the same CLI
locally. Neither path inputs commands into an existing user shell or changes
focus to close a tab.

One executable still runs as separate relay, web and session processes. Existing
engines keep their loaded release. Migrating the relay requires only a relay
service restart, followed by actual browser reconnection and usable-tab checks.
Do not restart session engines. Keep the old relay available for rollback until
Windows acceptance checks pass. See [Windows test plan](SWITCHBOARD_WINDOWS_TEST_PLAN.md).

The relay preserves WebSocket close codes. Updated web daemons send a
nonreconnecting close for intentional session exit; service/transport loss
still reconnects. Two browser viewers must not recreate the session after its
last tab closes. Older Windows web daemons fail this check and need a
web-service-only update. Their marker-only catalogs can also show dead engines;
new Windows catalogs check whether the marker PID is still running.

For isolated browser acceptance against the Rust relay:

```sh
node tools/switchboard/update_browser.test.cjs OLD_BINARY NEW_BINARY
```

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

### Plan after the WASM removal PR merges

Start this rollout after [PR #6](https://github.com/domsleee/switchboard/pull/6)
merges and the Mac and Windows acceptance checks pass. This is a delivery plan;
it does not enable automatic updates yet.

1. **Build often, publish releases occasionally.** Build and test Mac and Windows
   bundles on pushes to the default branch and on manual dispatch. Upload Actions
   artifacts for routine development builds without creating GitHub Releases.
   Keep release publishing separate and explicit. GitHub has no documented silent
   release option, and marking a release as a prerelease does not guarantee silence.
2. **Make each build identifiable.** Package the native executable with its
   embedded UI and Rust relay, the platform tray helper and installation files.
   Include a manifest with the commit, platform, architecture, checksums and
   compatibility information. Give Switchboard its own stable version and record
   the upstream Zellij version separately. No WASM plugin assets are needed.
3. **Try development builds manually first.** Download a specific successful run's
   artifact, verify it, and use the guarded updater. Record the selected run and
   commit so a machine cannot accidentally install an unrelated branch's build.
   Extend the binary-only updater to cover the complete bundle before offering
   tray updates. Verify real browser input/output and automatic reconnection on
   both platforms, including rollback, while preserving shells and tab identity.
4. **Keep development updates opt-in.** A later development channel may resolve
   the newest successful, compatible default-branch build. Actions artifacts
   require GitHub authentication to download and expire; show those failures
   clearly and retain the installed and previous bundles locally. Use a configured
   retention period, initially 30 days. Never depend on an expired artifact for
   rollback or for a machine returning after a long absence.
5. **Publish stable releases deliberately.** Promote a tested build into a durable,
   versioned GitHub Release with signed bundles and release notes. Stable installs
   and machines catching up after several releases use this channel. Publish for
   meaningful updates rather than every commit. Public release downloads should
   not require users to supply GitHub credentials.
6. **Add tray updates, then automation.** Implement **Check for updates** and
   **Update now** in Rust before adding an automatic-update setting. Stage and
   verify the complete bundle, replace connection services only, and require
   existing tabs to become usable in the browser before reporting success.
   Preserve session engines, shells, agents, names, selection, sharing settings
   and notification history. Roll back connection services on failure, and report
   partial recovery honestly. Keep credentials outside the browser and bundles,
   in macOS Keychain or Windows Credential Manager.

The current `native-binaries.yml` is a manually dispatched Windows build with
seven-day artifact retention. Extend it for the frequent Mac and Windows builds
above. The inherited `release.yml` creates draft releases; replace that flow with
an explicit stable promotion workflow rather than using it for routine builds.

GitHub documents [artifact authentication and expiry](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)
and [release creation notifications](https://docs.github.com/en/rest/releases/releases#create-a-release).

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

Names are also part of recovery. The sidebar often displays Codex/Claude pane
titles while native tabs still have generic names such as `Tab #2`. A layout
dump saves those generic native names, so it cannot recover the displayed labels
after those agent processes stop. Before any explicitly authorized engine
restart, save native pane metadata with `action list-panes --json --all` as well
as the layout, and carry the displayed agent titles into the replacement tab
names. Verify those labels in the actual browser. Browser/HTTP health, stable
IDs and a matching tab count alone do not establish a complete recovery.

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
