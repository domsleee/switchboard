# Switchboard docs

Start with [setup and usage](../tools/switchboard/README.md),
[updates](SWITCHBOARD_UPDATES.md) and the
[acceptance criteria](../acceptance/switchboard/README.md).

## What still applies

Reviewed against the plugin-free Switchboard branch. Removing WASM does not
remove the native terminal engine, so some inherited Zellij developer docs
remain useful.

| Document | Assessment | Next change |
| --- | --- | --- |
| [Update plan](SWITCHBOARD_UPDATES.md) | Current Switchboard guidance. Separates implemented updates from future delivery plans. | Keep; update as platform acceptance and automation land. |
| [Windows test plan](SWITCHBOARD_WINDOWS_TEST_PLAN.md) | Current acceptance checklist, including known gaps. | Keep; record real Windows results before calling the platform verified. |
| [Architecture](ARCHITECTURE.md) | Native screen, pane, grid and boundary concepts still apply. Several implementation details are stale. | Rewrite around the current session engine, native layout worker, web daemon, Rust relay and tray helpers. |
| [Terminology](TERMINOLOGY.md) | ANSI/VT, CSI, OSC and PTYs remain relevant. | Correct the PTY description and add Windows ConPTY, sessions, tabs, panes and browser viewport ownership. |
| [Error handling](ERROR_HANDLING.md) | `anyhow`, error context, `ZellijError`, `.fatal()` and `.non_fatal()` still exist. The contribution campaign and examples are inherited. | Keep the useful developer guidance; remove upstream campaign links and plugin examples, and explain failure isolation for live sessions. |

## Specific stale details

- The architecture guide describes `Scroll` and `PtyBus` as current components;
  the current code uses `Grid` and the PTY worker. `TerminalCharacter` derives
  `Clone`, not `Copy`. Its explanation of style resetting on a newline is also
  incorrect: terminal attributes persist until changed or reset.
- A PTY is a pair of terminal endpoints, not a pair of processes. Windows uses
  ConPTY, so the Unix device description does not cover both platforms.
- Error-handling examples involving plugin asset directories no longer describe
  the runtime. An unavailable relay host should not be treated as a reason to
  stop healthy session engines.
- The old release guide's registry modifications and force-push cleanup are not
  part of Switchboard's build or update process.

Removed the upstream release and third-party installation guides. The former
described publishing Zellij crates, and the latter installed upstream packages
without Switchboard. Use Switchboard's setup and delivery plan instead.
The other inherited guides have not yet been fully rewritten.

Outside this folder, `CONTRIBUTING.md` and the plugin issue templates also need
cleanup: they still describe building and developing WASM plugins.
