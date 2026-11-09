# Terminal host: replacing a session engine without losing its shells

Status: implemented and on by default for new sessions (`SWITCHBOARD_TERMINAL_HOST=0` turns it off). After a successful update the updater moves each hosted session whose engine differs. The hidden `zellij switchboard swap-engine <session>` moves one session by hand.

## Goal

An update replaces a running session engine while its shells, agents and builds keep
running. Pane IDs, tab order and names, scrollback and sharing stay the same. A viewer
sees a short reconnect at most. If the new engine fails, the old build takes over again
and the processes still survive.

Sessions started before this ships cannot be moved. A running engine owns its PTYs and has
no code to hand them over, so each needs one final, user-confirmed restart.

## Why the engine cannot be replaced today

`Pty` in `zellij-server/src/pty.rs` closes every pane in `Drop`. `UnixPtyBackend` keeps PTY
master fds in the engine, and closing them sends SIGHUP to the shells. `WindowsPtyBackend`
keeps the `HPCON` in the engine, and the ConPTY host exits with it. Every use goes through
`ServerOsApi` and `AsyncReader`, which is where the split goes.

## Shape

Each session gets one process, started by the first engine with the hidden command
`zellij terminal-host`. It owns the PTYs or ConPTYs, the child processes and a bounded
buffer of recent output per terminal. It knows nothing about VT parsing, layouts, tabs or
clients. Anything that may need fixing later stays in the engine, because the host cannot
be replaced without losing its shells. It must stay small and change rarely.

`HostedPtyBackend` is a second PTY backend beside the Unix and Windows ones, and
`ServerOsInputOutput` chooses between them when the first terminal starts. `AsyncReader` for
a hosted terminal reads a per-terminal queue fed by the host connection. Screen, Tab and Grid
do not change for ordinary output.

The host runs from the executable that started it. Retained release directories already
outlive sessions, and Windows locks loaded executables, so nothing overwrites it.

## Protocol

Length-prefixed frames over a pair of local connections, one for commands and one for
events, because a synchronous Windows pipe handle cannot read and write concurrently. Control
frames are JSON; output and typed input are raw binary. The host depends on no Zellij wire
types. The handshake carries `protocol`, the
token and the engine build. A new engine must speak every host protocol that may still be
running. Additions are capability-gated, and an unsupported host means "do not swap this
session", never a failure that touches it.

Requests: `Spawn` (terminal ID, command, args, cwd, env overrides, size), `Write` (replies
with bytes accepted, preserving partial-write backpressure), `Resize`, `Drain`, `Kill`,
`ForceKill`, `Interrupt`, `ForegroundProcessGroup`, `Close`, `Ack`, `PauseOutput`,
`ResumeOutput`, `BeginHandoff`, `CommitAdoption`, `AbortHandoff`, `Shutdown`.

Events: `Spawned` (PID and process start time, or command not found), `Output`
(terminal, first sequence number, bytes), `Exited` (terminal, status), `OutputPaused`
(end sequence per terminal, ordered after the last `Output`).

The engine sends per-pane environment overrides (`TERM`, `COLORTERM` and the current session
name). The host merges them over the environment it was born with, so a swap does not change
what new panes inherit.

Exactly one engine connection is active. Each connection takes a new, strictly higher
connection generation, and the previous connection's later requests are rejected. This is
separate from the handoff ID that names a snapshot, so a rollback reuses the handoff ID
with a new connection generation.

## Security

The host starts arbitrary commands as the user. Connections require a random 244-bit token
from a file only the user can read. The endpoint lives under
`~/.local/share/switchboard/terminal-hosts/<host id>/`, mode 0700 on Unix. The Windows
named pipe has a current-user DACL and rejects remote clients. The directory is keyed by a
stable host ID with a name pointer, so renaming a session is one pointer update and the
session socket directory, which `list-sessions` scans, stays free of extra entries.

## Lifetime

Destroying terminals is always an explicit request. A hosted engine's `Drop` paths detach:
`Pty::drop` and `SessionMetaData::drop` send no `Close` or `Kill`. Only a real session kill
sends `Shutdown`, and only a user or child-driven pane close sends `Close`.

Outside a handoff, losing the engine connection stops the terminals, matching what an
engine crash does today. After `BeginHandoff`, connection loss does not stop anything. The
host rejects `Close`, `Kill`, `ForceKill` and `Shutdown` until `CommitAdoption`, and stops
its terminals only if no commit or abort arrives within the one-hour handoff deadline.

## Output retention

Each terminal has a monotonic byte sequence and a bounded buffer. Nothing unacknowledged is
ever discarded. When a terminal reaches the 4 MiB unacknowledged limit, the host stops
reading that PTY, so the child blocks as it would today when the reader is slow. Credits
limit each terminal separately, so one busy pane cannot stall another.

A further 1 MiB of acknowledged output is kept so a snapshot can start at an unfinished
sequence. `retain_from`, sent with `BeginHandoff`, pins output from each terminal's
snapshot sequence until `CommitAdoption`, and the 4 MiB limit includes the pinned bytes.

The host keeps reading while no engine is connected, up to those limits. A child that exits
stays recorded, with its status and output, until an engine sends `Close`.

## Handoff

The updater serializes this per computer under the existing updater lock, and journals
each session's phase, handoff ID, previous and candidate executables and connection
generations in `state.json`. `resolve_pending` settles any unfinished session journal,
committing it or rolling it back, before it may discard the updater journal.

1. Old engine receives `PrepareHandoff` and freezes: no new spawns or clients, and no
   client action that changes tabs, panes or focus. Capable clients receive
   `HandoffPrepare`, stop sending input, keep it in their journal and reply. The engine
   waits two seconds for replies. Exit events from the host are held, unprocessed, until
   detach.
2. The writer queue drains with output still flowing. If input cannot drain within five
   seconds, the handoff aborts and the session continues unchanged.
3. Capture the verification baseline from this frozen state: host PID and start time, child
   PID and start time per terminal, tabs and pane IDs.
4. `PauseOutput`. Each `TerminalBytes` records its delivered sequence after `send_to_screen`
   returns. When all readers reach their `OutputPaused` end, the engine sends
   `HandoffSnapshot` to Screen, which is ordered after every delivered byte.
5. Screen settles each pane: buffered tab instructions (`Tab::pending_instructions`) applied,
   scrolling cleared and `Tab::pending_vte_events` drained, `TerminalPane::pending_pty_input`
   empty and no forwarded terminal query outstanding. The writer queue then drains again, so
   query replies produced while settling reach the host. If any of this takes more than three
   seconds, the handoff aborts with `ResumeOutput`.
6. Screen writes `handoff/<handoff id>.json` atomically (see Manifest) and the engine sends
   `BeginHandoff` with each terminal's snapshot sequence.
7. Clients get a handoff exit if capable, otherwise `Disconnect`. The engine releases its
   session socket and exits. Its exit stops nothing.
8. Updater starts the new engine with the handoff ID. It binds the same socket and takes a
   new connection generation.
9. The new engine creates panes through the existing layout path. A new
   `Run::Adopt(AdoptedTerminal)` returns an `AsyncReader` that yields the snapshot, then
   host output from the snapshot sequence. Each reader sends `SnapshotApplied` through Screen
   when the snapshot bytes have been handled. Until every pane has done so, attaches wait and
   resizes are not applied. After that the engine accepts pane queries and is in the
   Verifying phase, in which attaches still wait and pane-changing actions are refused.
10. Updater verifies, then sends `CommitAdoption`, which admits clients and releases the
    deferred exit events. On failure it stops the candidate, starts the previous executable
    with the same handoff ID and a new connection generation, and verifies again.

Verification requires tabs and pane IDs to match the frozen baseline and the session to
answer pane queries. The children need no separate check: the new engine can only attach to
the host that holds them, using its token, and an exit during the swap is not a failure.
Acceptance tests also check that a marker command's output reaches a viewer; production never
types into user panes.

A journal in the host directory, written before the session is touched, lets the next run
hand a session back to its previous executable if the updater dies with it between engines.

## Manifest

The existing layout export is deliberately lossy for resurrection, so it is not the handoff
format. The handoff builds its manifest from the same Screen metadata collection with
rewrites turned off: literal tab names rather than `restored_tab_name`, suppressed panes kept
as they are, and pane relationships intact. It adds terminal IDs, tab IDs, next tab and
terminal IDs, sharing, and per terminal the snapshot sequence and bytes.

`AdoptedTerminal` holds `terminal_id` and the pane's run state. A held pane has no running
child, so it carries the original `RunCommand`, exit status and first-run flag from
`TerminalPane::is_held`, and a `hold_on_start` pane adopts only its reserved ID.

## Snapshot

Existing `Grid::serialize` writes styled lines but no cursor, modes or alternate screen. A
new `Grid::handoff_snapshot` writes, in this order:

1. primary scrollback and viewport, with a restore-only sequence marking each wrapped row so
   canonical lines stay intact for later reflow;
2. primary cursor state, saved cursor, character sets and tab stops;
3. when active, `?1049h` and the alternate viewport;
4. scroll region and the modes that change input or rendering (application cursor keys,
   wrap, mouse modes, bracketed paste, focus reporting, synchronized output, Kitty keyboard
   flags), and the pane title;
5. the active cursor position and style last, because setting the scroll region moves the
   cursor home.

Snapshots are parsed only by the next engine and never reach a real terminal. Panes are
created at the sizes in the manifest. Kitty and Sixel images, selection, scroll position and
shell command markers (OSC 133) on existing output are not preserved.

A pause can land inside an escape sequence or UTF-8 character. vte acts on a sequence only
when it completes, so the old grid has not applied an unfinished one. A small scanner, tested
against vte on random input, finds where the unfinished sequence starts, and the snapshot
sequence is set to that offset so the new parser reads the whole sequence again. If that
offset is no longer retained, the handoff aborts.

## Viewers

An engine marks a handoff with `in-progress/<session>` under the terminal-hosts root before
it freezes, and the new engine clears the marker once adoption finishes. An attachment worker
stops sending input when it sees the marker. If its IPC connection then drops, it waits up to
60 seconds for the new engine and attaches with typing held in its journal. It restores its
hidden report and completes the existing confirmed-focus transaction for its exact pane
before it releases input, because `Screen::add_client` puts a new web client on the first
tab. Terminal identity is host ID plus terminal ID, so a resume cannot reach a different
terminal. The web server keeps listing a marked session while its socket is absent, because
the sidebar closes the terminal of any session it stops seeing.

Workers from builds without this capability fail visibly, as they do today, and the updater
defers for them the same bounded way it defers for legacy viewers. Native attached clients
reattach the same way when their connection drops while the session is marked. They land on
the session's active tab, and keys typed while they wait are lost.

## Update policy

Each engine records a fingerprint of its build inputs: the `zellij-server` and `zellij-utils`
source trees, root `Cargo.toml` and `Cargo.lock`. `zellij switchboard engine-fingerprint`
prints a build's own. The updater swaps a session only when the engine's recorded fingerprint
differs, so a sidebar-only merge causes no reconnect at all.

`Settings → Health` lists sessions without a host. They are never restarted automatically;
closing and reopening a session gives it a host, which stops the programs running in it.

## Platform notes

- Windows: start the host with `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` and
  `CREATE_BREAKAWAY_FROM_JOB`, and call `SetConsoleCtrlHandler(None, 0)` as the engine does.
  If the engine is in a job that refuses breakaway, the session runs without a host and
  Health reports it. One extra process per session, with no process spawn per action,
  respects the Defender constraint.
- Linux: the host stays in the engine's systemd scope, which outlives the engine while the
  host is alive.
- macOS: the host daemonizes the way the engine does and must survive
  `launchctl kickstart -k`.

## Not in this design

Recovering a session after an unexpected engine crash. The host makes it possible later, but
it needs its own reconstruction path and is not needed to update an engine.

## Delivery

Each step merges separately. The host stays off by default until step 4 passes.

1. Host process, protocol, `HostedOsApi`, on Windows and Unix, enabled by
   `SWITCHBOARD_TERMINAL_HOST=1`. A session using it must be indistinguishable from today's.
2. Freeze, settle, snapshot, manifest, `Run::Adopt`, restoration barrier and fencing.
3. Worker and native client reconnection.
4. Updater handoff, session journal, verification, rollback, Health. Default on for new
   sessions.

## Acceptance

Unit tests cover framing, credits, retention, pinning, fencing and the parser-boundary
scanner. Real-process tests run on Windows and Unix: a shell started through the host keeps
its PID and shell variable after the engine exits and a new one adopts it.

`node acceptance/switchboard/run.cjs engine-swap OLD NEW` runs in a private session with a
browser viewer, an agent fixture and a full-screen program, and checks PID/start-time
continuity, shell state, ongoing output across the gap, scrollback, tab and pane IDs,
sharing, typing held across the gap, a forced failure rolling back, an aborted handoff
resuming, and repeated swaps. Typing latency and output throughput must stay within 10% of a
direct session using the existing latency test.
