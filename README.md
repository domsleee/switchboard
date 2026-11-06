# Switchboard

All your terminal tabs, on all your computers, in one browser window.

- **One sidebar for every computer.** Pair your Mac and Windows machines, then search and switch between all their tabs.
- **Know when an agent needs you.** Codex and Claude tabs show a badge when they finish or ask a question. Reading it on one computer clears it on all of them.
- **Tidy up from the sidebar.** Right-click a tab to archive or close it. Tabs stay where you put them.
- **Runs quietly.** A menu bar icon on Mac and a tray icon on Windows. Updates install themselves without closing your terminals.

## Get started

[Set up Switchboard](tools/switchboard/README.md) on each computer, then pair them.

## Working on Switchboard

Read [AGENTS.md](AGENTS.md) before changing code or investigating a running
computer. It covers isolated worktrees, diagnostics, tests and safe updates.

- **Understand the system:** [architecture](docs/ARCHITECTURE.md) and
  [terminology](docs/TERMINOLOGY.md).
- **Investigate pairing or sidebar behaviour:** [internals](docs/SWITCHBOARD_INTERNALS.md).
- **Change installation or updates:** [update lifecycle](docs/SWITCHBOARD_UPDATES.md).
- **Find earlier decisions across computers:** [chat history API](docs/SWITCHBOARD_CHATS.md).
- **Browse the guides:** [documentation index](docs/README.md).

## Under the hood

Switchboard is a fork of [Zellij](https://github.com/zellij-org/zellij) 0.45.1. The terminal engine, web server and sidebar relay are native Rust in a single executable. Zellij's WASM plugin runtime and bundled plugins are removed; older layouts still open, without their plugin bars.

The executable is still named `zellij`. The `zellij-client`, `zellij-server` and
`zellij-utils` crates are active parts of Switchboard; their names preserve the
fork's existing build and command interfaces. The sidebar and desktop helpers
live under `tools/switchboard`, while the relay lives in
`zellij-client/src/switchboard_relay*`.

[Zellij documentation](https://zellij.dev/documentation/) covers the inherited
terminal features. [LICENSE.md](LICENSE.md) retains the upstream license and attribution.
