# Switchboard memory and executable consolidation

## Rust relay comparison

Matched local trials on 4 October 2026 used the same private native web server,
five idle Bash tabs, authentication and three-second polling interval. No user
sessions were attached or restarted. Measurements exclude browser, engine, web
server and tray memory. Python includes its `uv` supervisor.

| Relay | Processes | Charged footprint, MiB | Mean RSS, MiB | Warm catalog latency p50 / p95, ms |
| --- | ---: | ---: | ---: | ---: |
| Python + uv | 2 | 36.05–36.35 | 41.18–54.78 | 1.53 / 1.82 |
| Rust | 1 | 4.25–4.49 | 10.86–11.06 | 1.29 / 1.54 |

The local relay saves about 32 MiB charged footprint in this workload. One Rust
trial had a 4.42 ms p95; latency is not uniformly better. Time to the first
complete native tab catalog was 131–134 ms for Rust, 307 ms for warm Python and
3.33 seconds for the first Python trial. These are local catalog checks, not
browser-to-usable-terminal timings or Windows measurements. Initial metadata
publication and polling can affect startup samples.

Raw measurements: `/tmp/switchboard-rust-relay-benchmark.json`; candidate SHA-256
`25a406292ae8205200281b662dc2b557d07cb50ebc19cbee2bffeffadc99f2a5`.
That candidate included HTTP pooling, native tab/attention scanning and control
handlers. Legacy Windows snapshot transfer was still under verification;
final-build and remote-host performance need their own measurements.

The Rust relay reuses up to eight idle HTTP connections per host. Artifact
responses stream on a separate origin; ordinary terminal HTTP responses remain
bounded buffers. Local scans still launch CLI probes, and old remote Windows
hosts still need a private PowerShell control shell.

Audited 2026-10-04 on `remove-wasm-runtime`, baseline `9c1016c68`.
Installed plugin-free release: `/Users/dom/.cargo/bin/zellij`, 18.70 MiB,
SHA-256 `76876246f63053a1341962e53662648f9902bd2e22b3119352b61899417c4808`.
No live sessions were attached, resized, killed or restarted by this audit.
Only disposable sessions in private temporary socket/cache directories were created
and removed. No browser was opened. Following the audit, this agent implemented
bounded scrollback extraction and its focused regression test; the parent agent
is implementing shared keybinding snapshots separately.

## Measured baseline

Detached 50×50 terminals, one idle `bash --noprofile --norc` per tab, no plugins,
default keybindings and 10,000-line scrollback limit. Session serialization and
metadata were disabled. Six RSS samples after four seconds idle, repeated twice.
RSS and macOS physical footprint are different measures; do not mix their totals.
Footprint is charged memory; RSS includes resident shared mappings.

| Tabs / panes | Engine RSS, MiB | Engine footprint, MiB | Child-shell RSS, MiB |
|---|---:|---:|---:|
| 1 / 1 | 15.20–15.61 | 9.88–10.30 | 2.08–2.34 |
| 5 / 5 | 19.48–20.41 | 14.67–15.61 | 12.31–12.89 |
| 20 / 20 | 36.17–36.52 | 32.35–32.78 | 50.53–50.89 |

These measure one pane per tab, not twenty panes sharing one tab. They exclude
output-heavy scrollback, interactive applications, and browser memory. Historical
plugin-enabled comparisons in `/tmp/switchboard-with-wasm-ram.json` were about
96/284 MiB RSS for one/eight tabs versus 18–19/24–26 MiB without plugins in
`/tmp/switchboard-no-wasm-ram.json`; these are separate older samples.

Current application snapshot, with the fresh native engine and five live panes:

| Process | PID | RSS, MiB | Footprint, MiB |
|---|---:|---:|---:|
| Session engine | 58900 | 27.63 | 19.67 |
| Native web server | 58926 | 8.52 | 4.86 |
| Swift/AppKit tray | 59057 | 43.72 | 12.55 |
| Relay `uv` supervisor | 59216 | 17.58 | 8.41 |
| Python/aiohttp relay | 59218 | 49.41 | 39.44 |

The relay pair accounts for 66.98 MiB RSS / 47.85 MiB footprint. This snapshot
excludes child applications, browsers and shared front-door infrastructure. It
is an observed working session, not an idle comparison with the table above.

## Confirmed keybinding allocation opportunity

An otherwise identical disposable session with `keybinds clear-defaults=true {}`
dramatically reduces idle tab growth. A subsequent default-keybinding control
confirms the result; no live configuration was changed.

| Diagnostic configuration | Tabs | Engine RSS | Engine footprint | Shell RSS | Shell footprint |
|---|---:|---:|---:|---:|---:|
| Keybindings cleared | 1 | 12.58 | 8.83 | 2.17 | 1.53 |
| Keybindings cleared | 20 | 15.06 | 11.31 | 50.70 | 38.27 |
| Default keybindings, matched control | 20 | 36.72 | 32.85 | 49.33 | 36.78 |

All values are MiB; shell values sum the separate child processes. The twenty-tab
engine difference is **21.66 MiB RSS / 21.53 MiB footprint**. This diagnostic
removes shortcuts and is not a proposed user setting. Actual savings from a
behavior-preserving implementation still require measurement.

`ModeInfo.keybinds` is an owned nested `Vec` (`zellij-utils/src/data.rs:1775`).
`Screen::new_tab` clones the default `ModeInfo`, and `Tab::new` clones it again
into tiled and floating managers (`zellij-server/src/tab/mod.rs:928`, `:943`).
Client mode maps add further copies. Share immutable keybinding data with
`Rc`/`Arc` and copy on update, preserving serialization, per-client modes and
live reconfiguration. Do not simply drop the data when plugins are disabled;
native controls also use it. The exact allocation attribution needs profiling.

The parent agent has now implemented `Arc<KeybindsVec>` in `ModeInfo`, replacing
the snapshot on configuration updates and preserving the serialized array shape
through Serde's `rc` support. The legacy Protobuf conversion uses
`Arc::unwrap_or_clone`. Independent source review found no new shared-mutation
or wire-shape issue: keybinding consumers read the snapshot, and reconfiguration
replaces per-client snapshots before cloning them into tabs. The existing tab
fallback refresh behavior is unchanged. Clone-sharing, wire-format and snapshot
replacement tests were added by the parent. Release validation now shows
twenty-tab engine RSS of 16.38–16.69 MiB and footprint of 11.94–12.39 MiB,
compared with the original 36.17–36.52 MiB RSS and 32.35–32.78 MiB footprint.
This saves about 20 MiB per twenty-tab idle engine under the measured conditions.
One/five-tab RSS is 14.14–14.69 / 15.23–15.41 MiB. Shell memory remains separate;
no live engine was restarted to obtain these measurements.

The original twenty-tab `vmmap` shows 24.9 MiB allocated heap and 6.7 MiB allocator
fragmentation, including 21.3 MiB dirty tiny allocations. This is consistent
with many copied small vectors; it is not allocation-stack attribution. Its
82.2 MiB reserved stack space has only 1.16 MiB resident. Large virtual address
space totals are not evidence of equivalent RAM consumption.

## Prioritized implementation work

1. **Replace Python plus `uv` with a Rust relay mode.** This targets the largest
   measured auxiliary cost, 47.85 MiB footprint. Reuse existing Tokio/Axum, TLS
   and WebSocket infrastructure. Measure the replacement before claiming net
   savings: current footprint is an upper bound on removable cost, not a forecast.
2. **Share keybinding storage.** The twenty-tab diagnostic difference exceeds
   the native web server and tray footprint combined. Verify default shortcuts,
   multiple clients, configuration reload and IPC compatibility, then repeat
   the baseline. This is the clearest engine optimization found.
3. **Limit scrollback extraction before allocation (implemented).** Both
   `pane_contents` and `pane_contents_with_ansi` previously converted every
   scrollback row into a `String`, then discarded all but the requested tail.
   A shared row-range helper now selects final rows before conversion, reducing
   allocation peaks and scanning work for bounded snapshots. `None` and `Some(0)`
   still return all rows. Focused regression tests cover plain/ANSI content,
   row order, viewport, rows below, selection and cursor; all twelve focused
   snapshot tests passed.
4. **Stream ordinary HTTP proxy responses.** `tools/switchboard/server.py:197`
   buffers request and response bodies fully. The Rust relay should stream
   binary artifacts and ordinary responses with backpressure, buffering only
   bounded HTML requiring injection. Bound WebSocket messages and queued bytes.
5. **Profile output-heavy sessions before changing terminal storage.**
   `Grid::new` starts with empty scrollback; the 10,000-line limit is not a
   preallocation, so reducing it will not fix idle tab growth. Rows store a
   `VecDeque<TerminalCharacter>` with shared styles. Compact immutable scrollback
   or a configurable byte budget may help, but must preserve reflow, Unicode
   width, styling, search, selection and graphics.
6. **Audit remaining queues and runtime costs afterward.** PTY input already uses
   a bounded 50-message screen channel and 64 KiB read buffers. Other screen,
   control and writer queues are unbounded; host-query pauses can retain pending
   pane input. Consider byte budgets and coalescing while avoiding blocking
   cycles. The shared engine Tokio runtime already specifies four workers.
   Stack reservation and binary stripping are lower priorities; release LTO and
   stripping are already enabled.

## One executable, durable session processes

Ship one `switchboard` executable with engine, relay, web and tray modes. Keep
session servers as independent processes launched from that executable. Tray
exit and relay replacement must not terminate terminals. Embed sidebar assets,
retain a compatibility `zellij` entry point, and preserve authentication, TLS
fingerprints, same-origin restrictions, explicit pane/tab targeting, attention
detection and service supervision.

A Rust tray still uses platform frameworks; the current 43.72 MiB tray RSS is
only 12.55 MiB charged footprint, so removing Swift does not promise a 44 MiB
physical-memory saving. Reusing existing HTTP/TLS dependencies avoids another
network stack, but one file alone does not reduce working memory. Existing
dependencies include Tokio, Axum, tokio-tungstenite, Rustls and isahc/curl;
cleanup should follow call-site and loaded-page measurement.

Install updates atomically into versioned executable paths and leave existing
session processes running their old version. Retain compatible IPC or route
clients to each session's matching executable; retain old versions while their
processes run. This also accommodates Windows executable locking. Replacing a
file does not upgrade an existing process. Live engine upgrades that preserve
applications need a stable PTY/ConPTY host plus explicit ownership and state
handoff; a single executable does not provide that feature.

## Evidence

- `/tmp/switchboard-memory-audit-20261004.json`: original two-run idle measurements.
- `/tmp/switchboard-memory-keybinds-20261004.json`: cleared-keybinding diagnostic.
- `/tmp/switchboard-memory-control-20261004.json`: subsequent default control.
- `/tmp/switchboard-memory-shared-keybinds-20261004.json`: two-run release
  measurements after sharing keybinding snapshots.
- `/tmp/switchboard-current-process-memory.json`: current auxiliary snapshot.
- `/tmp/sb-mem-c2apr9t0/run1-20tabs-vmmap.txt`: original allocation summary.
- Temporary `sb-mem-*` directories retain per-process footprint reports.

No Ponytail skill was available in the current catalog, filesystem or orchestrator
context supplied to this audit; this report does not claim a Ponytail audit ran.
