# Switchboard

A fork of [Zellij](https://github.com/zellij-org/zellij), based on version **0.45.1**.

One place for your terminal tabs across Mac and Windows, with a searchable sidebar,
attention badges for Codex and Claude, and right-click actions to archive or close tabs.
Tabs stay where you put them.

Switchboard runs in the background, with a menu bar icon on Mac and a tray icon on Windows.

The terminal engine and web server are native Rust. This fork removes Zellij's
WASM plugin runtime and bundled plugins. Older layouts still open their terminal
panes, with plugin bars removed. The sidebar relay currently uses Python.

[Setup and usage](tools/switchboard/README.md) · [Zellij documentation](https://zellij.dev/documentation/) · [License](LICENSE.md)

[Update plan](docs/SWITCHBOARD_UPDATES.md): automatic updates that keep running terminals alive.
