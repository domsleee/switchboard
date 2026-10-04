# Switchboard terminology

## Session, tab, pane and client

A **session** is a named native terminal workspace with its own server process.
It can stay alive with no viewers attached. A **tab** belongs to one session
and groups tiled or floating **panes**. Each terminal pane has its own terminal
endpoint and usually starts a shell or command, which can spawn more processes.

A **client** is an attached terminal or browser viewer. Several clients can
view the same session. Tab and pane IDs identify native objects; tab positions
and sidebar order can change. The sidebar also groups sessions by configured
**host**, which is the machine's native web server connection.

**Archive** hides a tab in the browser sidebar without ending its processes.
**Close** ends the tab's panes and their processes.

## PTY and ConPTY

A Unix **PTY** (pseudoterminal) is a pair of terminal endpoints, not a pair of
processes. The primary endpoint is used by the terminal emulator to read output
and write input. The secondary endpoint gives the shell and its child programs
the terminal device interface. A shell can run many processes through one PTY.

Switchboard normally creates one terminal endpoint pair for each Unix terminal
pane. Windows uses **ConPTY**, the Windows pseudoconsole API, with pipes for
input and output rather than Unix PTY devices. Both feed terminal output into
the native Grid. The implementations are in
[os_input_output_unix.rs](../zellij-server/src/os_input_output_unix.rs) and
[os_input_output_windows.rs](../zellij-server/src/os_input_output_windows.rs).

## ANSI/VT

**ANSI/VT** describes terminal text and escape sequences that control character
styles, cursor movement, screen contents and other terminal behavior. For
example, this prints red text and then resets the styling:

```sh
printf '\033[31mHi there!\033[0m\n'
```

Styles persist across newlines and cursor movement until changed or reset.
The [Grid](../zellij-server/src/panes/grid.rs) interprets output sequences and
stores the resulting terminal state.

## CSI and OSC

**CSI** means Control Sequence Introducer. `ESC [` introduces sequences such
as `ESC [ 31 m` for a red foreground or cursor-positioning commands.

**OSC** means Operating System Command. `ESC ]` introduces sequences such as
terminal title changes and clipboard requests. Despite the name, these are
requests interpreted by the terminal emulator, not arbitrary operating system
commands. Support and permissions depend on the client.

## Viewport and owner

A terminal **viewport** is the visible region of the pane's Grid. Scrolling
through scrollback changes the viewed content without resizing the terminal.
A browser also has a viewport through which it can pan over a larger shared
tab layout.

A **viewport owner** is the capable browser client whose requested dimensions
size a particular tab. Focus or **Use this window's size** claims ownership;
leaving the tab or disconnecting releases it. Other capable browsers pan
without shrinking that layout. Plain terminals and older browsers still
constrain its size. See [architecture](ARCHITECTURE.md#browser-viewport-ownership).

## Web daemon and relay

The **web daemon** connects authenticated browser clients to native sessions.
The **relay** serves the Switchboard sidebar and proxies those connections for
configured hosts. Neither is the session engine. Losing a browser connection
or an unavailable relay host does not itself end the terminal processes.
