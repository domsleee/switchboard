# Switchboard

All your terminal tabs, on all your computers, in one browser window.

- **One sidebar for every computer.** Pair your Mac and Windows machines, then search and switch between all their tabs.
- **Know when an agent needs you.** Codex and Claude tabs show a badge when they finish or ask a question. Reading it on one computer clears it on all of them.
- **Tidy up from the sidebar.** Right-click a tab to archive or close it. Tabs stay where you put them.
- **Runs quietly.** A menu bar icon on Mac and a tray icon on Windows. Updates install themselves without closing your terminals.

## Get started

[Set up Switchboard](tools/switchboard/README.md) on each computer, then pair them.

## More

- [All docs](docs/README.md): Switchboard guides and inherited Zellij references.
- [Zellij documentation](https://zellij.dev/documentation/) · [License](LICENSE.md)

## Under the hood

Switchboard is a fork of [Zellij](https://github.com/zellij-org/zellij) 0.45.1. The terminal engine, web server and sidebar relay are native Rust in a single executable. Zellij's WASM plugin runtime and bundled plugins are removed; older layouts still open, without their plugin bars.
