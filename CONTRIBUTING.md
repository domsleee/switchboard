# Contributing to Switchboard

Switchboard is a Zellij fork with a native Rust terminal engine, web daemon
and sidebar relay. The executable and most crates retain the `zellij` name.
The WASM plugin runtime and bundled plugins have been removed.

Read the [Code of Conduct](CODE_OF_CONDUCT.md),
[setup guide](tools/switchboard/README.md) and
[architecture](docs/ARCHITECTURE.md) before changing the relevant component.
File issues and pull requests in this repository rather than upstream Zellij.

## Building and checking

Use the Rust toolchain pinned in [rust-toolchain.toml](rust-toolchain.toml),
including its `rustfmt` and `clippy` components. Install `protoc` for the xtask
protobuf generation step. Protocol definitions still support native IPC, web
control, nested sessions and inherited compatibility types; they do not imply
a plugin runtime. Native dependencies vary by platform; CI installs NASM for
the Windows build.

From the repository root:

```sh
cargo xtask --help
cargo xtask build                  # target/dev-opt/zellij
cargo xtask build --release        # target/release/zellij
cargo xtask format --check
cargo xtask test
cargo test -p zellij-client --features web_server_capability switchboard_relay --lib
cargo xtask assets --check
```

Windows executables have the `.exe` suffix. The default build includes web
support and the relay. `cargo xtask build --no-web` and
`cargo xtask test --no-web` exercise the native engine without web support.
`cargo x` is an alias for `cargo xtask`.

The checked-in web frontend bundle is verified by `cargo xtask assets --check`.
After editing the native web client's frontend source, run `cargo xtask assets`
to regenerate it. Sidebar assets in `tools/switchboard/static` are embedded
directly in the relay at compile time.

[.cargo/config.toml](.cargo/config.toml) sets the default build output directory
to `target`. A custom `CARGO_TARGET_DIR` is supported by xtask. Builds do not
require a WASM target or plugin artifacts.

## Tests and live sessions

Run `cargo xtask integration-test` for native whole-application tests. It uses
`cargo-nextest` when available and otherwise falls back to serial `cargo test`.
Plugin-dependent UI suites remain in
`zellij-integration-tests/tests/legacy_plugin_ui` as migration fixtures and
are not active tests.

See [Switchboard acceptance](acceptance/switchboard/README.md) for sidebar,
sharing, browser recovery and updater checks. The
[setup guide](tools/switchboard/README.md) also lists small JavaScript and
Python checks. Python tooling here covers installers and reference checks;
the shipped sidebar relay runs in Rust.

Create isolated test sessions for browser or recovery tests. Attached clients
can change shared terminal geometry. Preserve existing shells and services
when developing; an executable update does not migrate a running session to
the new engine. Run checks appropriate to the change and state what was
verified in the pull request.

## Debugging and errors

Use `log` for native diagnostics. Log paths are defined in
[consts.rs](zellij-utils/src/consts.rs), and rotation is configured in
[logging.rs](zellij-utils/src/logging.rs). Desktop helper logs are described in
the setup guide. `--debug` can capture terminal bytes per pane; use an isolated
reproduction and review captured contents before sharing them.

Return `Result` with meaningful context where callers can recover. Use typed
`ZellijError` variants for distinct recovery paths. `.non_fatal()` logs and
discards a result; `.fatal()` panics, so use it only at a boundary that cannot
continue safely. Follow [error handling](docs/ERROR_HANDLING.md), particularly
its guidance on keeping relay failures separate from healthy sessions.

## Issues and pull requests

For a bug, include the platform, executable version, expected behavior and
minimal reproduction. Say whether it affects the terminal engine, browser,
relay or desktop helper. Include relevant logs with secrets removed.

For an enhancement, describe the user problem and desired behavior. Plugins
are not a supported extension mechanism in this fork.

Keep pull requests focused, use a clear title, and describe the resulting
behavior. Format Rust changes and run the relevant checks before submitting.
