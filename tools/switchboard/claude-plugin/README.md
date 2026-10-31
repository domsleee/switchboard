# Switchboard plugin for Claude Code

One skill, `switchboard-artifact`, that teaches Claude Code to publish a file with
`zellij switchboard artifact` and hand back a link that opens on every paired computer.
The command needs a Switchboard build with artifact support.

## Install

From GitHub, on any computer, once this folder is on `main`:

```sh
claude plugin install switchboard --marketplace domsleee/switchboard
```

From a checkout of this repository:

```sh
claude plugin marketplace add /path/to/switchboard
claude plugin install switchboard@switchboard
```

For one session without installing: `claude --plugin-dir tools/switchboard/claude-plugin`.
Claude picks the skill on its own; `/switchboard:switchboard-artifact` invokes it by hand.

Codex reads the same skill through `.codex-plugin/plugin.json` and the repository's
`.agents/plugins/marketplace.json`:

```sh
codex plugin marketplace add domsleee/switchboard
codex plugin add switchboard@switchboard
```

Codex keeps a snapshot, so pick up skill changes with `codex plugin marketplace upgrade switchboard`
followed by the `add` again.

## Evals

`evals/` holds five cases for `claude plugin eval`: three that should publish and two that
should leave the skill alone.

| Case | Checks |
|---|---|
| `screenshot-on-laptop` | Skill fires; runs `zellij switchboard artifact … sidebar-bug.png` |
| `benchmark-video-on-windows` | Skill fires; publishes the `.mp4`; starts no ad hoc HTTP server |
| `share-plan-doc` | Skill fires; publishes `PLAN.md` together with the image it links |
| `unrelated-cli-flag` | Skill does not fire on a coding task; the flag gets added |
| `resize-screenshot` | Skill does not fire when an image is edited but not viewed |

Run from this folder:

```sh
claude plugin eval . --scaffold --allow-tools Bash Write Edit --trust-plugin -j 4
```

`--scaffold` runs each case's `fixture.sh` to create its files. Each run has a temporary
home and Bash runs in Claude Code's sandbox, so nothing reaches the real
`~/.switchboard/artifacts`, and the publish command itself fails there. The cases grade the
command Claude runs, not the link it prints. Every case also runs once without the plugin;
the `W/OUT` column is that baseline, and the `skill-fired` checks are reported as an
indicator rather than scored.
