# Update tasks

Each computer's relay runs the update tasks listed in its own
`~/.config/switchboard/tasks.json` (`%USERPROFILE%\.config\switchboard\tasks.json` on
Windows) and reports the results to every paired computer. Switchboard does not know
what a task does. Whatever owns the tasks writes the file; for example, dotfiles
`install.nu`.

```json
{
  "env": { "PATH": "~/.cargo/bin:/opt/homebrew/bin:${PATH}" },
  "groups": [
    {
      "name": "dotfiles",
      "every": "6h",
      "tasks": [
        { "name": "pull + install", "run": ["nu", "~/git/dotfiles/nushell/auto-update-main.nu"], "timeout": "10m" },
        { "name": "agent plugins", "run": ["nu", "-c", "update-plugins"], "whenAgentsIdle": true, "after": "pull + install" }
      ]
    },
    {
      "name": "work tools",
      "every": "1d",
      "hosts": ["Work-PC"],
      "tasks": [{ "name": "mcp server", "run": ["bun", "install", "-g", "@example/mcp-server@latest"] }]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `every` | How often the group runs: `30s`, `10m`, `6h`, `1d` or combinations like `1h30m`; at least `1m`. A run missed while the machine slept runs once on wake, with no catch-up. |
| `run` | argv, no shell. A leading `~` is expanded in every argument. |
| `cwd` | Optional; defaults to the home directory. |
| `env` | At the top level, on a group or on a task; later ones override earlier ones. `${NAME}` takes the value set so far, then the relay's own variable. `~` is expanded at the start of each `:`/`;` list entry. Relays run under launchd, systemd or the tray without the login shell's environment, so set `PATH` here. |
| `timeout` | Default `30m`. Ends the task and everything it started, and marks it failed. |
| `after` | A task name or list of names in the same group. The task runs after them and is skipped unless they all succeeded. Other tasks still run. |
| `whenAgentsIdle` | Waits while any agent pane on this computer is working, checking every 30 s. |
| `hosts` | Runs the group only on computers whose Switchboard name or hostname matches, ignoring case. |
| `enabled` | `false` turns a group off without deleting it. |

Unknown fields and invalid values are errors. The relay rereads the file when it
changes. While the file is invalid, nothing runs and Settings → Health shows the
error.

## Running

- Groups run in parallel, but only one run of a group at a time. Tasks in a group run
  one at a time, in the order written, except where `after` moves a task later.
- Scheduled runs start 60 s after the relay starts, so a Switchboard update finishes
  its handoff first. **Run now** starts at once.
- Every merge to `main` restarts the relay, which ends running tasks. The next relay
  marks them `interrupted` and reruns the group once. A second interruption in a row
  waits for the normal interval.
- A task can print `changed: <summary>` on stdout. That separates "updated X" from
  "ran, nothing new".

## Results

- Results are saved in `~/.config/switchboard/tasks/state.json`. Each task's latest
  output goes to `~/.config/switchboard/tasks/<group>/<task>.log`, with names reduced
  to `[A-Za-z0-9._-]`.
- `GET /api/tasks` lists every computer's groups: status, summary, last and next run,
  and each task's exit code, duration, last three stderr lines (stdout if stderr was
  empty), and `changed` lines. Paired computers answer `/switchboard/tasks` through
  the pairing gateway.
- Settings → **Health** shows every group, with Run now, a per-task Run, Log, and
  Pause/Resume. A failure or a `changed:` line puts a row in the sidebar. **Clear**
  stores `seen` on the computer that owns the group, so the row clears on every
  computer.

## Security

`tasks.json` runs arbitrary commands, so only its owner writes it. Browsers and paired
computers can only run, pause, resume or clear groups the file already lists, and read
their logs. Paired computers can already reach this account's shells, so this gives
them no new access. Pause is saved in `state.json`, not the file.

## Not yet

- Switchboard's own self-update does not appear as a group yet. It keeps its own
  schedule and handoff ([SWITCHBOARD_UPDATES.md](SWITCHBOARD_UPDATES.md)).
- On Windows, tasks stop when the tray exits, like the self-update checks.

## Skill health

Health checks Codex user skills (`CODEX_HOME/skills` and `~/.agents/skills`) and
explicitly enabled plugins from local Codex marketplaces separately from status
hooks. It compares cached skill instructions and supporting files with the local
source, and names conflicting copies of a skill. Identical copies are ignored.
Use **Fix skills** on the affected computer to refresh stale or missing plugin
copies with `codex plugin add`, then recheck immediately. Progress and failures
appear in Health, with a retry button on failure. Conflicting user-written skills
and unavailable marketplace sources still need manual attention. Start a new
Codex conversation to load refreshed instructions.

Inspection runs in the background and results are cached for one minute. Missing
sources, unreadable files and inspection limits produce warnings. Remote
marketplaces and project skills are not checked; Health states this scope.
