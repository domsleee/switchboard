# Simple computer invitations

- Creating an invitation fills in this computer's name and network address. Advanced settings stay collapsed.
- Invitations and terminal connections use the existing native web server on port 8082. Setup never searches for another available port.
- An existing HTTPS listener keeps its certificate. A Mac with a private recovery listener keeps that listener private and serves authenticated peers through the native server on its LAN address, also on 8082.
- Pasting an invitation shows its details automatically. Joining and approving still require explicit clicks and matching codes.
- If several network addresses are available, the user chooses a connection. Setup does not guess or publish a broken invitation.
- Creating an invitation succeeds only after a pinned HTTPS request passes through the shared server to the pairing service.
- Updating connection services preserves shell and agent PIDs, sessions, pane identities and names.

Automated coverage: `tools/switchboard/computers.test.cjs`, the mesh tests in `zellij-client/src/switchboard_relay/mesh/tests.rs`, and the existing-listener test in `zellij-client/src/switchboard_relay/peer_bridge.rs`.

Windows acceptance: with its HTTPS server already listening on 8082, create an invitation, join from another computer, approve the matching code, and verify terminal output and input in both directions. No second public port or copied token should be required. This needs the updated build on both computers.

## Add a computer by address

- Enter an IP such as `172.20.10.10` in **Add computer** and send the request. An HTTPS URL with an explicit port also works.
- No invitation link or token needs to be copied. The receiving computer shows who wants to connect and the matching verification code.
- The receiving person explicitly allows the request; the initiating person confirms the same code. Neither discovering a TLS certificate nor delivering a request grants terminal access.
- The notification stays outside the terminal layout and never changes keyboard focus or opens a dialog automatically.
- Denied requests cannot be replayed. Pending requests expire after ten minutes and incoming storage is bounded.
- Switchboard starts receiving requests automatically when it can choose one local network address. With multiple networks, choose a connection in Computers and click **Receive connection requests**.
- A computer running an older build gets an explicit update message rather than a token prompt.
- Pairing finishes in the background after both approvals, even if the Computers page is closed. Existing invitation links still work.

Coverage: the real TLS address-pairing test exercises request delivery, both local approvals and bilateral credential installation. Browser tests exercise address entry, explicit approval, and notification focus/layout stability. Run the same flow on updated Mac and Windows builds before claiming Windows deployment verified.
