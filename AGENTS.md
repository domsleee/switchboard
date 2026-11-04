# Switchboard

A fork of Zellij that shows every paired computer's terminal tabs in one browser sidebar. The
Rust relay (`zellij-client/src/switchboard_relay*`) serves the sidebar (`tools/switchboard/static`)
and talks to the other computers.

Pairing, updates and Windows: read `docs/SWITCHBOARD_INTERNALS.md`, `docs/SWITCHBOARD_UPDATES.md`
or `docs/SWITCHBOARD_WINDOWS_TEST_PLAN.md` first. Pairing is an invitation made in Settings →
Computers; `zellij web --create-token` plays no part in it.

## Inspecting the running system

Read the live relay before guessing. It answers on `http://127.0.0.1:8090`:

- `/api/health`: the commit this relay is running.
- `/api/hosts`: machines, their build commit, sessions and session age.
- `/api/attention`: each pane's state (working, ready, approval, input), review token and `seen`.
- `/api/logs`: recent failures from every computer, grouped by the computer that logged them.
- `/api/mesh`: paired members; `local: true` marks this computer's mesh name and id.
- `/api/tasks`: each computer's update tasks from `tasks.json` and their last results
  (`docs/SWITCHBOARD_TASKS.md`).

To capture what an agent pane shows (for detection rules and their tests):
`zellij -s main action dump-screen -p <pane id>`.

Logs on Mac: `~/Library/Logs/zellij-switchboard.log` (relay), `~/Library/Logs/switchboard-update.log`
(updater), `$TMPDIR/zellij-$(id -u)/zellij-log/zellij.log` (engine). Services are launchd jobs
`dev.zellij.switchboard`, `dev.switchboard.update` and `dev.switchboard.menu`; inspect with
`launchctl print gui/$(id -u)/<label>`. Windows logs are in `~/.config/switchboard/`.

Another computer's agent knows its computer best. Ask it with `zellij message` before judging
what runs there, and before deleting or stopping anything on it.

Test UI changes against local fixtures, never the live sidebar at `switchboard.localhost:8090`:
a focused browser viewer claims the terminal size of the user's real sessions.

## Changing code

- Branch from `origin/main` in a separate worktree, and read code from `origin/main`. The main
  checkout often sits on an old branch with unrelated uncommitted work; compare it with
  `/api/health` before blaming the deployed build.
- Unfinished work may live on another computer's branch or in a PR. Check
  `gh pr list --repo domsleee/switchboard --state all` and `origin/*` before calling it missing.
- Every merge to `main` ships to every paired computer within about 10 minutes and restarts its
  services. Merge deliberately and keep running terminals safe across a restart.
- "Merge" from the user is the go-ahead: wait for `gh pr checks --watch`, then
  `gh pr merge --squash --delete-branch`. Rerun a flaky check once, and fix the flake in its own PR.
- `gh` defaults to the upstream `zellij-org/zellij`. Pass `--repo domsleee/switchboard` to every
  `gh pr` command.
- Relay tests: `cargo test -p zellij-client --features web_server_capability switchboard_ --lib`.
  Sidebar tests: `node tools/switchboard/<name>.test.cjs` (some need Playwright).
- After editing `zellij-client/assets/`, run `cargo xtask assets`. CI rejects a stale bundle.
- Agent state comes from reading pane screens and titles. When Claude Code or Codex changes its
  UI, capture the new screen with `dump-screen` and add it as a `classify` test before changing
  the rule.
