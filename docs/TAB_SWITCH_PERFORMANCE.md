# Terminal tab switching

The reported terminals were identified using read-only relay metadata on
4 October 2026: `mac/main`, native tab 0 (`switchboard | dom`) and native tab 6
(`online shopping`). That session uses `sharing_recovery: true`. No browser
automation attached to those terminals, and no input was sent to them.

## Cause and change

The sidebar highlights a clicked row immediately and sends `FocusPane` through
the existing control WebSocket. The recovery adapter attaches as a native
client, so the old engine does not push web `MobileState` updates. The adapter
queries tabs, panes and this client's current tab once per second. Although
the terminal redraws promptly, the bridge disables input until this metadata
confirms the requested pane. A click just after a poll therefore incurs almost
another second of waiting. The two-second attention poll is not on this path.

Focus commands now wake the recovery query worker after the command is sent.
Only one query batch may be pending. A focus burst queues one refresh, and
the exact current-tab response wakes that refresh immediately. Background
polling remains once per second; an engine that stops acknowledging queries
still stops the worker after five seconds. Native focus confirmation and the
existing rapid-switch input gate remain in place.

## Reproduce safely

```sh
cargo test -p zellij-client --features web_server_capability sharing_recovery --lib
PLAYWRIGHT_MODULE=/path/to/playwright node acceptance/switchboard/run.cjs switching /path/to/zellij
```

The browser check creates a private socket directory, two disposable Bash
terminals with web sharing Off, an authenticated recovery web service and a
loopback relay. It uses headless Chromium. It chooses each target just after
a background metadata response, measures six alternating switches, and
types immediately after confirmed focus. Distinct shell state and output
verify input reaches the chosen shell. It also checks a rapid A–B–A switch.
Cleanup closes only the private session and services and revokes its token.

Timing starts at the actual sidebar click. It records the selected row,
`FocusPane` send, the target shell's xterm redraw, matching native metadata,
and focused/enabled terminal input. Different frames use their absolute
performance clock. This is real shell/native IPC/WebSocket/xterm behavior
in a disposable local fixture, not simulated timing or a measurement of the
user's existing terminals.

Use `node tools/switchboard/tab_switch_native.test.cjs BINARY --measure` to
collect baseline timings without enforcing the regression budget.

## Recorded timings

On 4 October 2026, six switches on loopback in headless Chromium produced:

| Time after click | Before | After |
| --- | ---: | ---: |
| Selected sidebar row | 0.5–1.2 ms | 0.6–0.9 ms |
| Focus command sent | 108–164 ms | 96–222 ms |
| Target terminal redraw | 201–301 ms | 209–387 ms |
| Matching native metadata | 1,073–1,288 ms | 180–357 ms |
| Focused, enabled input | 1,108–1,319 ms | 208–386 ms |

Median input readiness fell from 1,233 ms to 275 ms. The native regression
requires selection within 100 ms and terminal redraw and input readiness
within 500 ms on a quiet loopback run. The old binary fails that input budget;
the changed binary passes, including actual shell input and rapid switching.
The recovery tests pass 10/10, the full web-client tests 75/75, and UI tests
62/62 including the optional headless checks.

The tested binary SHA-256 values were
`60c11973bb3aff13d662cd4fa3472cc57e2cc728d6e8e6cd5bbebfa018ba6dec` before and
`15d12943dc20eddf63fe3faf572b7e7e94744332e73bc4a024b70d8ff3f9e755` after.
The latter was built from base `64ff7c823` with this recovery change.

Run timing checks independently of other browser tests. An overlapping run
with the web-client suite delayed the browser's focus-command send by
417–895 ms in its first three samples and exceeded the absolute budgets;
the final three input samples were 232–295 ms. The standalone pass above
demonstrates removal of the polling wait, not a guarantee under arbitrary
browser or system load.

## Remaining live check

After installing the updated native web executable, verify the two reported
tabs in the user's ordinary browser without restarting their session engine.
Record click-to-redraw and click-to-input readiness on that actual engine;
the local fixture cannot establish performance under its real agent output,
browser workload or remote Windows network. This change requires the updated
web service to be running; changing static sidebar assets alone cannot fix
the recovery query wait.
