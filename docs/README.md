# Switchboard docs

Start with [setup and usage](../tools/switchboard/README.md) and the
[acceptance criteria](../acceptance/switchboard/README.md).

Local `cargo build --release` and `cargo install --path .` use ThinLTO.
Publishing workflows set `CARGO_PROFILE_RELEASE_LTO=fat` for full LTO.
Use `cargo build --release --timings` to write a build report to
`target/cargo-timings/cargo-timing.html`.

| Guide | Contents |
| --- | --- |
| [Shared message board](MESSAGE_BOARD_USAGE.md) | Computer and agent inboxes, paired-machine routing, CLI registration and acknowledgement. |
| [Architecture](ARCHITECTURE.md) | Native session workers, tabs, panes, Grid, browser sizing, web daemon, Rust relay and desktop helpers. |
| [Terminology](TERMINOLOGY.md) | Sessions, clients, PTYs, Windows ConPTY, ANSI/VT sequences and viewport ownership. |
| [Error handling](ERROR_HANDLING.md) | Current Rust error APIs, recovery boundaries and isolation of relay failures from healthy sessions. |
| [Update plan](SWITCHBOARD_UPDATES.md) | Implemented updates and future delivery plans that preserve running terminals. |
| [Windows test plan](SWITCHBOARD_WINDOWS_TEST_PLAN.md) | Platform acceptance checklist and known gaps. Record actual Windows results before calling the platform verified. |

Architecture, terminology and error handling have been refreshed against the
native Switchboard code. Crate, executable and some
compatibility protocol names still use `zellij` or `plugin`; Switchboard does
not build or run WASM plugins.

The upstream release and third-party installation guides were removed because
they described publishing Zellij crates and installing upstream packages.
Use Switchboard's setup guide and update plan for installation and delivery.

The inherited contribution guide has also been removed for now.
