# Switchboard

A fork of Zellij that shows every paired computer's terminal tabs in one browser sidebar. The
Rust relay (`zellij-client/src/switchboard_relay*`) serves the sidebar (`tools/switchboard/static`)
and talks to the other computers.

## Inspecting the running system

Read the live relay before guessing. It answers on `http://127.0.0.1:8090`:

- `/api/hosts`: machines, their build commit, sessions and session age.
- `/api/attention`: each pane's state (working, ready, approval, input), review token and `seen`.
- `/api/logs`: recent failures from every computer, grouped by the computer that logged them.
- `/api/mesh`: paired members; `local: true` marks this computer's mesh name and id.

To capture what an agent pane shows (for detection rules and their tests):
`zellij -s main action dump-screen -p <pane id>`.

Logs on Mac: `~/Library/Logs/zellij-switchboard.log` (relay), `~/Library/Logs/switchboard-update.log`
(updater), `$TMPDIR/zellij-$(id -u)/zellij-log/zellij.log` (engine). Services are launchd jobs
`dev.zellij.switchboard`, `dev.switchboard.update` and `dev.switchboard.menu`; inspect with
`launchctl print gui/$(id -u)/<label>`. Windows logs are in `~/.config/switchboard/`.

Test UI changes against local fixtures, never the live sidebar at `switchboard.localhost:8090`:
a focused browser viewer claims the terminal size of the user's real sessions.

## Changing code

- Branch from `origin/main` in a separate worktree. The main checkout often holds unrelated
  uncommitted work.
- Every merge to `main` ships to every paired computer within about 15 minutes and restarts its
  services. Merge deliberately and keep running terminals safe across a restart.
- `gh` defaults to the upstream `zellij-org/zellij`. Pass `--repo domsleee/switchboard` to every
  `gh pr` command.
- Relay tests: `cargo test -p zellij-client --features web_server_capability switchboard_ --lib`.
  Sidebar tests: `node tools/switchboard/<name>.test.cjs` (some need Playwright).
- After editing `zellij-client/assets/`, run `cargo xtask assets`. CI rejects a stale bundle.
- After changing `zellij switchboard artifact` or artifact serving, update the `switchboard-artifact`
  skill in `tools/switchboard/claude-plugin/` to match and rerun its eval (see that plugin's README).
  Claude Code and Codex both load this skill.
- Agent state comes from reading pane screens and titles. When Claude Code or Codex changes its
  UI, capture the new screen with `dump-screen` and add it as a `classify` test before changing
  the rule.
