# Resumable viewer experiment

This is a first architecture experiment, **not seamless production updating**.
Normal builds exclude it. The updater still protects connected viewers. Existing
sessions and ordinary web clients do not acquire this capability after an update.

The experiment tests the difficult ambiguity: a bridge dies after the engine
accepted input but before the browser received its acknowledgment. A replacement
bridge must continue the same viewer without delivering the input twice. The same
requirement applies when returning to the previous bridge version.

## What survives

An experimental module inside a disposable session engine owns a native IPC
attachment to that engine. Its reader, writer, client identity and selected pane
survive both bridge processes. The module also owns the input sequence and a
bounded queue of rendered output. It is not another permanent gateway process.

The browser keeps its document, xterm instance, focus, unacknowledged input and
last-applied output position. A replacement bridge receives a new transport
generation; resume identities make a lost resume reply safe to retry; old-generation exchanges fail before they can write or acknowledge
output. Input retries must have the identical sequence and bytes. Gaps and
unknown viewers fail explicitly rather than reconstructing possibly lost state.
Output is acknowledged only after xterm's write callback. Exhausting replay space
fails explicitly; the experiment never drops queued output to claim recovery.

Acknowledgment means acceptance by the surviving engine process, **not that the
application has consumed the input**. The proof separately checks the bytes the
fixture application actually received. It does not survive an engine crash.

The fixture bridge uses authenticated loopback HTTP requests and an engine-owned
private TCP endpoint. This is deliberately a small test protocol, not a proposal
to replace production WebSockets with polling. Both bridge processes run the same
fixture code with distinct version labels and process IDs. This tests replacement
and rollback of stateless bridges, not compatibility between two product releases.

## Run the proof

```sh
cargo test -p zellij-server --features resumable_viewer_proof resumable_proof --lib
cargo test -p zellij-utils ipc_flush_failure --lib
cargo build --profile dev-opt --features resumable_viewer_proof
PLAYWRIGHT_MODULE=/path/to/playwright node tools/switchboard/resumable-viewer.test.cjs target/dev-opt/zellij
```

On Windows append `.exe` to the binary path. Python and headless Chromium are
required. CI runs the same test on Mac, Linux and Windows. The runner creates its
own socket directory and named session and kills only that session afterward.
It does not open the live sidebar or attach to user terminals.

The engine endpoint requires both the build feature and
`SWITCHBOARD_RESUME_PROOF_ENDPOINT`, pointing to a nonexistent file in the private
fixture directory. The file contains a random access capability and is created
with mode 0600 on Unix. The endpoint binds only to loopback. The fixture bridge
also requires a separate browser capability and checks the exact fixture origin.
Do not enable this endpoint in installed services. Evidence files contain only
synthetic fixture data, but the endpoint file should remain private.

The runner verifies:

- Numbered raw input reaches the application exactly once and in order through
  two injected failures after acceptance but before acknowledgment, plus a lost
  resume reply and an explicit duplicate retransmission.
- Split escape sequences and bracketed-paste bytes reach the raw-mode fixture.
- Numbered output is observed in xterm and retained once in engine scrollback;
  render sequence numbers remain contiguous across both replacements.
- Browser document, xterm, focus, dimensions, pane IDs, engine PID and fixture PID
  survive. The old bridge exits and the replacement actually serves requests.
- Input acceptance, application delivery and visible output delays stay below
  250 ms by default in this isolated proof. Shared CI runners use a 1,000 ms
  ceiling via `RESUME_PROOF_LATENCY_MS` to catch stalls without treating scheduler
  delays as protocol failures. CI is not evidence of the 250 ms local target.
  Results report the ceiling and measured maxima, not just counts.
- Stale generations, unknown resume tokens, altered retries, gaps and output
  replay overflow fail explicitly.

Each run leaves a `proof.json` and synthetic diagnostics in its printed temporary
directory. These measurements are a local experiment, not a fleet latency promise.

## Deliberate limits and next step

This viewer writes raw bytes to one fixed pane. It does not migrate the ordinary
web input parser, keybindings, mouse state, resizing, pane switching, sharing
revocation, or frontend modules. Its native attachment retains a fixed viewport.
The four-viewer cap and bounded replay queues last for this disposable engine's
lifetime; this is not production viewer lifecycle management.

Production integration needs those controls ordered with input, capability
negotiation with engines, lifecycle/revocation, and tests through paired-host paths
and simultaneous viewers. Only then can capable connections replace the blanket
update lock. Older engines must remain protected. Updating existing session
engines and replacing already-loaded browser JavaScript are separate problems;
this experiment does not pretend to solve either.

The proof also exposed IPC sends reporting success when the buffered stream's
flush failed. Client and server IPC senders now propagate that error; a focused
failure-injection test covers both directions. This error-propagation correction
is independent of the experimental build feature.
