# Switchboard acceptance

These checks record what you asked for in the 3–4 October 2026 Switchboard chats.
A criterion passes when the behavior below works for the user. Automated tests
cover parts of that behavior; the remaining checks are called out explicitly.
Nothing here is a claim that the current build has passed every criterion.

## Run the tests

From the repository root:

```sh
node acceptance/switchboard/run.cjs ui
node acceptance/switchboard/run.cjs relay
node acceptance/switchboard/run.cjs colours
```

| Suite | What it checks |
| --- | --- |
| `ui` | Existing sidebar, keyboard, clipboard, link, close and size behavior tests. No live sessions or visible windows. |
| `relay` | Rust transport, attention tracking, tab controls and artifact handling. |
| `colours` | Windows pane environment rules, runnable on any build platform. Real Windows rendering still needs checking. |

The acceptance runner reuses the existing tests. It does not maintain a second
copy. Set `PLAYWRIGHT_MODULE` to include the optional headless hyperlink and
terminal focus tests.

## Tabs and everyday use

### SB-01 · Put the tabs on the left

With many open tabs, I can find and select them in a searchable, resizable left
sidebar. Native top and bottom bars do not use terminal space.

**Tests:** `ui` checks search, filters, bar removal, fullscreen and mobile changes.
**Still to check:** many-tab navigation and sidebar resizing in the browser.

### SB-02 · Archive or close the tab I chose

Right-clicking a tab offers Archive and Close. Archiving hides it without losing
its processes or identity, and I can restore it. Closing asks for confirmation
and closes that exact tab, even if it is inactive or focus changes meanwhile.

**Tests:** `ui` checks archive identity and captured close targets; `relay` checks
close targets and conflicts; `windows` exercises inactive and last-tab close.
**Still to check:** the context menu and archive process continuity in a browser.

### SB-04 · Keep my tab order

After I arrange tabs, viewing a result, marking it ready, filtering the sidebar
or reconnecting Windows keeps that order. A delayed Windows connection must not
move its tabs to the bottom.

**Tests:** `ui` checks each case, reloads, stable tab identity and old preferences.

### SB-10 · Make a new tab ready to type into

When I create a tab, that actual tab becomes selected and highlighted, its URL
updates, and I can type without another click. This works whichever arrives
first: the focus update or the refreshed tab list.

The sidebar immediately shows creation in progress. As soon as the native
terminal confirms creation, its row and input are ready without waiting for
attention polling. Slow or failed status scans do not hide it. A second new
tab can be created while those scans are still catching up.

**Tests:** `ui` checks both arrival orders, input gating and delayed tab lists;
`browser` creates a real tab, types into its shell and refreshes.
The headless `new-tab.test.cjs` holds discovery stale, creates two tabs, checks
focus and input, refreshes the new terminal's URL, and verifies promotion to
native tab IDs without duplicate rows or lost preferences. Close waits for a
verified native tab ID; a temporary pane ID must never close an unrelated tab.
**Still to check:** Create through a browser connected to Windows. The `windows`
suite checks native creation only.

### SB-11 · Make the popup and actions straightforward

Clicking outside New tab closes the popup. Clicking or dragging inside it keeps
it open. Sidebar actions have clear labels and are easy to reach.

**Test:** browser review of backdrop behavior, labels and action placement.
There is no automated visual or usability pass for this criterion.

### SB-12 · Refresh the terminal I was using

After selecting a terminal, its URL identifies the machine, session and native
tab. Reloading that URL returns to the same terminal, even if its host is slow
to connect.

**Tests:** `ui` checks URL round trips and delayed hosts; `browser` refreshes an
actual shell and checks the selected tab.

### SB-27 · Close without a confusing delay

After I confirm Close, the sidebar responds immediately and stale tab lists do
not bring the closing tab back. If closing fails, the tab returns with a visible
error. I can see what happened without repeatedly clicking Close.

**Tests:** `ui` checks immediate removal, stale updates and rollback on failure
in `close.test.cjs`. The Rust `browser` suite closes a real session watched by
two viewers and verifies it stays closed; native WebSocket tests distinguish
intentional exit from retryable disconnection. Older Windows web daemons fail
the final-session check until updated.
**Still to check:** perceived close delay on both machines; record time from
confirmation to removal and to native close completion.

## Agent status and notifications

### SB-03 · Show when an agent needs me

While Codex or Claude runs in a background tab, I can distinguish working,
finished and waiting for approval. An unrecognized screen stays unknown.
Opening a finished result acknowledges it without dismissing an approval.

**Tests:** `relay` checks scanner states and background tabs; `ui` checks
acknowledgment; `windows` runs terminal fixtures through the remote scanner.
**Still to check:** real Codex and Claude turns. A fixture is not a real agent
run; changed agent screens need updated fixtures.

### SB-05 · Remember which results I have seen

After I view a completed result, refreshing the browser or restarting the relay
does not notify me about that result again. A later working-to-finished turn
creates a new notification.

**Tests:** `ui` checks viewed and changed results; `relay` checks saved attention
state and new-turn transitions.
**Still to check:** the whole browser-to-relay flow across a real agent turn.

## Copy, links and keyboard

### SB-06 · Copy the selected text

Selecting terminal text and copying puts that text on the viewing computer's
clipboard. Cmd+C, selected Ctrl+C and Ctrl+Shift+C work; unselected Ctrl+C still
interrupts the terminal. Redraws preserve the selection. If clipboard access is
denied, I get a usable way to copy manually.

**Tests:** `ui` covers selection, redraws, Unicode, terminal clipboard requests
and permission failures.
**Still to check:** actual clipboard permissions in macOS and Windows browsers.

### SB-07 · Ctrl+D, then Enter, closes the chosen tab

In a focused terminal, Ctrl+D opens one confirmation. Enter closes the tab that
was captured when I asked; Cancel keeps it. Other modifiers and open dialogs do
not accidentally close anything. The confirmation text has no em dash.

**Tests:** `ui` checks shortcut routing and confirmation; `windows` exercises
the close endpoint.
**Still to check:** the physical key sequence and displayed wording on Windows.

### SB-08 · Alt+arrows move through words

Alt+Left and Alt+Right reach the terminal as previous-word and next-word input.
They do not switch tabs or panes. The dedicated H/L shortcuts navigate tabs.

**Tests:** `ui` checks Alt-arrow and H/L routing.
**Still to check:** word movement in the actual shell and agent input, whose
bindings determine the final behavior.

### SB-09 · Use the intended New tab shortcut

Ctrl+Alt+T and Cmd+Alt+T open New tab once, while respecting text fields and open
dialogs. Plain Ctrl+T must not open Zellij's native Tab mode.

**Tests:** `ui` checks shortcuts in the sidebar and terminal, including repeats.
Browser-reserved shortcuts remain subject to the browser's own handling.

### SB-15 · Shift-click a link into a new browser tab

Shift-clicking a terminal link requests an ordinary new tab at the correct
remote URL, without an embedded viewer or access back to its opener. Plain
clicks and dragging a text selection do not open it.

**Tests:** `ui` checks modifiers and drag guards; with `PLAYWRIGHT_MODULE`, it
also follows a real hyperlink in a headless browser.
**Still to check:** preferred browser settings, which ultimately determine tab
versus window placement.

### SB-24 · Paste images into a remote agent

Pasting an image sends a supported attachment to the selected remote host. It
must not give that agent a path that exists only on my viewing computer.

**Status: not implemented.** Paste currently sends text. Uploading an image,
creating a host-local attachment and attaching it in Codex/Claude have no tests
yet. When implemented, verify the remote agent can actually read the image.

## Terminal size and colours

### SB-13 · Let the last focused window set the size

Focusing a browser makes its physical window size control that tab's terminal.
A smaller background window or incoming metadata cannot shrink it or take
control back. Focusing another viewer transfers control. “Use this window's
size” also works.

**Tests:** `ui` checks ownership claims and physical versus virtual size;
`browser` checks two viewers, focus changes and background resizing.
**Still to check:** older engines and plain native clients, which may still
impose a minimum size; report those compatibility limits.

### SB-14 · Keep the prompt reachable and scaling correct

A smaller viewer can pan the existing terminal layout, initially near the
bottom where the prompt is. Back to bottom returns there. Changing display
scale recovers the drawing without repeated resizing.

**Tests:** `ui` checks backing-scale recovery and native viewport handling.
**Still to check:** bottom panning and Windows displays with different scaling.

### SB-23 · Show colours in Windows Codex

A newly created Windows terminal advertises colour support even when the daemon
inherited a missing or `dumb` TERM. Codex still receives terminal input/output,
and its styled output reaches the browser. An explicit NO_COLOR is respected.

**Tests:** `colours` checks defaults, inherited preferences, case-insensitive
Windows environment keys, pane IDs and opt-outs.
**Still to check:** a Windows build creating new panes, real Codex colours and
browser rendering. A disposable Windows PowerShell pane confirmed missing TERM
and COLORTERM with terminal input/output; that identifies the environment gap,
not a completed fix. Existing processes retain their original environment.

## Background operation, connections and updates

### SB-46 · Status errors never take my terminal focus

When “Windows: attention status unavailable” appears, my current terminal keeps
its keyboard focus, selected tab, URL and iframe. Attention polling and machine
discovery errors must never switch terminals, focus the sidebar, or disable input
by retrying focus before the terminal reconnects. Known tabs stay visible during
failed scans. Recovery keeps my selection and resumes input without another
click. Refreshing an unavailable terminal waits for it instead of choosing a tab
on another machine. A successful scan can still remove a genuinely closed tab.

**Tests:** `ui` checks failed-host/session catalog retention and URL restoration.
With `PLAYWRIGHT_MODULE`, it also checks actual iframe/input focus, uninterrupted
typing, disconnects, HTTP failures, automatic recovery, viewport DOM moves and
confirmed closes in an isolated headless browser using the actual terminal
bridge. The fixture never connects to live sessions.
**Still to check:** the installed Windows engine and browser reconnecting under
real network failures. These tests do not fix the remote attention scanner's
private-helper startup error.

### SB-16 · Run in the background on both machines

After login, Switchboard serves the sidebar and native terminal web view without
an extra terminal running `zellij web`. Its tray/menu icon shows whether it is
working, opens `switchboard.localhost`, and can quit without killing my sessions.

**Tests:** `recovery` checks the Mac installer and recovery helpers.
**Still to check:** macOS menu behavior and Windows installation, startup,
status, relogin and quit. Follow the [Windows plan](../../docs/SWITCHBOARD_WINDOWS_TEST_PLAN.md).

### SB-17 · Connect quickly and keep healthy hosts usable

A slow or disconnected host does not hold up terminals on healthy hosts.
Connection and recovery improvements are measured until I can use a terminal.

**Tests:** `ui` checks early tab lists and delayed hosts; `relay` checks timeouts
and failure isolation.
**Still to check:** matched startup and reconnect timings. Record the workload
and before/after results; no numeric speed target has been agreed.

### SB-18 · Update without losing my work

During a routine binary or relay update, existing shells and agents keep running.
Afterward, the same browser reconnects automatically and I can type into the same
tabs. Engine, shell and agent PID/start time, tab/pane identity, names, sharing,
shell variables and output continuity are preserved. Rollback does the same.

**Tests:** `update` and `browser` exercise isolated updates, rollback, process
and state continuity, identity, names and real input/output; `sharing` checks
private sessions and watchers.
**Still to check:** Windows process-preserving update and browser reconnection.
A healthy service or HTTP 200 alone does not pass. Lost names, identities or
unusable tabs mean failed acceptance. Replacing a running engine still requires
a restart and cannot be described as a shell-preserving update.

### SB-19 · Keep the tab names after recovery

Recovery keeps displayed agent titles. If an engine must be recreated, its
pre-restart snapshot preserves those titles as native names. Generic replacement
names do not count as successful recovery.

**Tests:** `browser` compares native and sidebar names across a service restart.
**Still to check:** engine recreation and restored terminal titles against a
snapshot. Routine updates must avoid recreating the engine.

### SB-20 · Make updates repeatable across machines

I can install a release and roll back on each machine. An automatic updater must
preserve the running engines and verify that existing browser tabs are usable.

**Tests:** `update` exercises the guarded Mac updater; the Windows plan covers
startup and rollback.
**Status:** automatic GitHub release polling and installation are not implemented
or tested. Windows rollback still needs platform execution.

## Packaging and development

### SB-21 · Ship one native executable

One executable provides the terminal engine, web server and full Rust sidebar
relay, including attention, controls, remote hosts and artifact streaming. The
running service does not depend on Python.

**Tests:** `relay`, `browser` in Rust mode and `windows` exercise those paths.
**Still to check:** a full Windows tray installation and runtime/latency results.
One executable can run as separate processes to preserve shells. The macOS
installer may still use Python as a setup tool.

### SB-22 · Remove plugins and measure the savings

Native terminal operations and web support work without WASM plugins or a WASM
runtime. Compare memory and binary size under the same workload, while keeping
active shells usable.

**Tests:** native server/client suites plus `browser` and `sharing`; see the
[memory audit](../../tools/switchboard-memory-audit.md).
**Still to check:** full suite/benchmark results separately from this small
runner, and actual Windows memory measurements.

### SB-25 · Test without disrupting my workspace

Automation uses headless browsers and disposable sessions. It does not type
into, resize or restart my live terminals, open visible windows, or edit global
AGENTS instructions.

**Checks:** default runner suites are offline/read-only. Integration suites must
create their own sessions/socket directories and clean up only their fixtures.
Review that isolation before adding a test.

### SB-26 · Keep the fork easy to understand

The source lives in the public Switchboard fork. Its README plainly says that
it is a fork of Zellij and identifies the upstream version.

**Check:** repository visibility and README review; this does not need a prose
unit test.

## Run the isolated integration tests

Use release executables and headless Playwright. `--list` lists the suites; the
default is `ui`. Integration suites run only when explicitly selected.

```sh
node acceptance/switchboard/run.cjs recovery
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node acceptance/switchboard/run.cjs browser /absolute/path/to/old-zellij /absolute/path/to/new-zellij
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node acceptance/switchboard/run.cjs sharing /absolute/path/to/new-zellij
node acceptance/switchboard/run.cjs update /absolute/path/to/old-zellij /absolute/path/to/new-zellij
node acceptance/switchboard/run.cjs windows /absolute/path/to/new-zellij /absolute/path/to/test-hosts.json windows-host-id
```

`browser` and `update` require macOS; `sharing` requires Unix. `recovery` uses
Python for the existing Mac setup/recovery helpers. `windows` needs an
authenticated Windows test host and creates uniquely named disposable sessions;
existing remote sessions are queried read-only. Keep host configs and tokens
outside the repository and logs. Use different old/new binary hashes to prove
an actual upgrade.

Record each run's commit/build hashes, platform, command and pass/fail result,
including skipped checks. A listed test is coverage, not a recorded pass. Use the
[Windows plan](../../docs/SWITCHBOARD_WINDOWS_TEST_PLAN.md) for platform checks.
