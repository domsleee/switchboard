# Error handling

Handle failures at the boundary that can recover or report them. A failed
host request, disconnected browser or missing command should not stop healthy
sessions. A changed value alone is not evidence that the whole application
must terminate.

The native helpers live in [errors.rs](../zellij-utils/src/errors.rs):

```rust
use zellij_utils::errors::prelude::*;
```

The prelude re-exports `anyhow::Result`, `Context`, `anyhow!`, `bail!`,
`ZellijError`, `FatalError` and `LoggableError`, among other helpers.

## Propagating errors and attaching context

Return `Result<T>` and use `?` where the caller can decide how to handle an
error. Use `.context()` for a static description and `.with_context()` for
context calculated only on failure. Include the operation and useful session,
tab or pane identifiers, without logging tokens or terminal contents.

For example, [Screen::close_tab](../zellij-server/src/screen.rs) adds the client
ID to errors while looking up and closing the active tab. A small file-reading
example using the same API is:

```rust
use std::path::Path;
use zellij_utils::errors::prelude::*;

fn read_config(path: &Path) -> Result<String> {
    std::fs::read_to_string(path)
        .with_context(|| format!("failed to read configuration {}", path.display()))
}
```

Context should explain what the code was trying to do, rather than repeat the
underlying error. Preserve the original error chain when passing it upward.

## Reporting and recovery

`LoggableError::to_log()` logs an error and returns the original result, so the
caller can still propagate or inspect it. `.to_stderr()` and `.to_stdout()`
provide corresponding output helpers.

`FatalError::non_fatal()` logs an error with extra context and discards the
result, including any success value. Use it only when continuing without that
result is intentional. When recovery needs the value, match the result:

```rust
match read_config(path) {
    Ok(config) => apply_config(config),
    Err(error) => {
        Err::<(), _>(error).context("keeping the previous configuration").non_fatal();
    },
}
```

This illustrates a caller that already has `path` and an `apply_config`
function. Logging does not repair state or retry an operation; make recovery
explicit at the caller.

`.fatal()` returns the success value or panics on error. Reserve it for a
boundary that cannot continue safely, after adding context. It is not a
reconnection or fallback mechanism. Native worker entry points currently use
it, so introducing a fatal result there can stop the session. The panic hook
and `handle_panic` implementation in `errors.rs` report panic context; they do
not restore lost state.

## Concrete errors

[ZellijError](../zellij-utils/src/errors.rs) uses `thiserror` and includes
`CommandNotFound`, `NoEditorFound`, `NoMoreTerminalIds` and `FailedToStartPty`.
Use an existing variant or add a specific one when callers need a distinct
recovery path. An `anyhow::Error` retains its underlying type after context is
attached:

```rust
if let Some(ZellijError::CommandNotFound { terminal_id, command }) =
    error.downcast_ref::<ZellijError>()
{
    // Report this command failure for the affected terminal.
}
```

See [pty.rs](../zellij-server/src/pty.rs) for command-spawn error handling.
Avoid detecting typed errors by matching their display text.

## Relay and session isolation

The [Rust relay](../zellij-client/src/switchboard_relay.rs) queries hosts
independently. Session catalog requests have a timeout and return
`Host unavailable` for the affected host. Proxy connection failures return
HTTP 502 responses. These paths should remain local to the request or host,
with other hosts and existing session engines left running.

Invalid relay configuration or an occupied listener port can fail relay
startup. Report that failure without killing terminal sessions to retry it.
Similarly, a web daemon or browser connection failure is separate from a
native session engine failure. Changes to these boundaries should preserve
running shells and avoid retrying input whose delivery is uncertain.

Use isolated sessions for recovery tests. Current browser acceptance commands
are listed in [acceptance/switchboard](../acceptance/switchboard/README.md).
