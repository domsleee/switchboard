# Switchboard architecture

Switchboard keeps Zellij's native terminal engine and web client, adds a Rust
sidebar relay, and removes the WASM plugin runtime. The executable is still
named `zellij`; crate and protocol names also retain the upstream name.

## Processes and connections

Each live session has a native server process that owns its tabs, terminal
state and child processes. Terminal clients attach over local IPC. The native
web daemon attaches browser clients to those same sessions. The Switchboard
relay serves the sidebar and proxies authenticated HTTP and WebSocket traffic
to the configured hosts' web servers.

These are separate processes even though they use the same executable:

- Session engine: [zellij-server](../zellij-server/src/lib.rs).
- Web daemon, `zellij web --daemonize`:
  [web_client](../zellij-client/src/web_client/mod.rs).
- Sidebar relay, `zellij serve --host-config ...`:
  [switchboard_relay](../zellij-client/src/switchboard_relay.rs).

Disconnecting a viewer leaves its session running. Replacing the executable
affects new processes; existing sessions keep their running engine. See the
[update plan](SWITCHBOARD_UPDATES.md) for service and engine update boundaries.

## Native session workers

The session server routes instructions between workers using contextual
channels defined in [thread_bus.rs](../zellij-server/src/thread_bus.rs):

| Worker | Responsibility |
| --- | --- |
| [Screen](../zellij-server/src/screen.rs) | Owns tabs, client focus, geometry and rendering. Coordinates pane creation, closing and resizing. |
| [PTY](../zellij-server/src/pty.rs) | Starts terminal processes, manages their lifecycle and forwards terminal output to Screen. |
| [PTY writer](../zellij-server/src/pty_writer.rs) | Sends user input to terminal endpoints. |
| [Native layout](../zellij-server/src/native_layout.rs) | Prepares new tabs and layout changes, and routes layout dumps and client metadata requests to the PTY worker. |
| [Background jobs](../zellij-server/src/background_jobs.rs) | Handles session metadata, serialization and other background work. |

The native layout worker strips plugin panes from inherited layouts and
rejects explicit plugin commands. Some channel and instruction names still
contain `plugin` for compatibility, including `PluginInstruction` and the
`native_layout as plugins` alias. They do not imply a WASM runtime.

## Tabs, panes and terminal state

A [Tab](../zellij-server/src/tab/mod.rs) groups tiled and floating panes.
[TerminalPane](../zellij-server/src/panes/terminal_pane.rs) connects one terminal
endpoint to its [Grid](../zellij-server/src/panes/grid.rs). The Grid interprets
ANSI/VT output and maintains cells, cursor state, scrollback, wrapping,
scroll regions and the alternate screen.

[TerminalCharacter](../zellij-server/src/panes/terminal_character.rs) stores a
character, its width and styles. It derives `Clone`, not `Copy`. Terminal
attributes remain active across newlines and cursor movement until an escape
sequence changes or resets them; printed cells retain their own styles.

[Boundaries](../zellij-server/src/ui/boundaries.rs) combine Unicode border
symbols around panes. Pane geometry comes from the pane interface and shared
size types; boundaries are separate from the terminal's text buffer.

The platform implementation lives behind
[os_input_output](../zellij-server/src/os_input_output.rs). Unix uses PTYs;
Windows uses [ConPTY](../zellij-server/src/os_input_output_windows.rs) and pipes
for input and output. See [terminology](TERMINOLOGY.md).

## Browser viewport ownership

Screen tracks a size owner for each tab. A capable browser claims ownership
on focus or through **Use this window's size**. Other capable browsers pan
across the same terminal layout. Plain terminal clients and older browser
clients still constrain the layout to their available size. Ownership releases
when the owner changes tabs or disconnects.

The native web client's
[control messages](../zellij-client/src/web_client/control_message.rs) carry
viewport requests; the relay's
[browser bridge](../tools/switchboard/static/bridge.js) integrates focus and
sizing with the sidebar. This requires support in the running session engine.

## Relay and desktop helpers

The relay embeds [sidebar assets](../tools/switchboard/static), reads the host
configuration, keeps upstream authentication tokens and cookies locally, and
binds to loopback. It queries hosts independently and returns host errors
without stopping healthy session engines. Its control, attention and artifact
helpers live in [switchboard_relay](../zellij-client/src/switchboard_relay).

On macOS, [install_service.py](../tools/switchboard/install_service.py) installs
LaunchAgents for the background service and builds the
[Swift menu bar app](../tools/switchboard/menu_bar.swift). On Windows,
[install_windows_web.ps1](../tools/switchboard/install_windows_web.ps1) installs
a Startup shortcut and a PowerShell tray app that supervises the web daemon and
relay. Quitting either icon leaves terminal sessions running.

Use [setup and usage](../tools/switchboard/README.md) for host configuration,
authentication and installation steps.
