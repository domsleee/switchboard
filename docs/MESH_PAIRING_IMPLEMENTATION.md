# Invitation pairing implementation

The first implementation provides administrator-approved bilateral pairing,
recipient-encrypted credentials, peer routes on the native web server, and a Computers page.
It has isolated state-machine, real loopback TLS/gateway and headless UI evidence.
It has **not** enrolled a live Mac or Windows computer or transferred live credentials.
SB-36–44 remain open until actual cross-computer acceptance is recorded.

## Protocol and trust

The shared `switchboard://join#…` link carries a 32-byte random invitation secret,
its 10-minute expiry, mesh identity, and the intended administrator's public
identity, gateway address and certificate SHA-256 fingerprint. The fragment keeps
the secret out of HTTP request paths. There is no public landing page. Local
preview only parses the link; the peer gateway has no GET enrollment route.
Only an explicit signed POST requests pairing, and only the administrator's
loopback control API can approve it. The shareable secret is hashed in inviter
storage and redacted from ordinary status/error responses and logs.

The gateway uses TLS 1.3 with certificate pinning and normal TLS handshake
signature verification through [rustls](https://docs.rs/rustls/0.23.27/rustls/client/danger/trait.ServerCertVerifier.html).
Persistent machine identities use Ed25519 signatures from `ring`. The verification
code binds the invitation ID, administrator identity and the exact signed joining
machine/request. Administrators must compare the visible code on both computers.
The invitation channel is the user's trusted chat; substitution of an entire link
by that channel is outside the trust it supplies.

Credential envelopes use [RFC 9180 HPKE](https://www.rfc-editor.org/rfc/rfc9180.html)
Auth mode through [rust-hpke 0.13](https://docs.rs/hpke/0.13.0/hpke/):
DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and ChaCha20-Poly1305.
Issuer, recipient, purpose and monotonically increasing credential version are
authenticated associated data. Encryption public keys are bound to the signed
membership and machine identity. The recipient verifies the administrator-signed
membership before accepting its issuer, rejects wrong recipients or modified
envelopes, and rejects older/conflicting credential versions. Re-delivery of the
same current credential is harmless. This is an established encryption protocol;
the surrounding application state machine has not received an independent
security audit.

## Operation and persistence

Open Settings → Computers and choose Create invitation. The computer name and
network address are filled automatically. Advanced settings allow corrections;
when multiple networks are available, choose the connection to use. Paste the
invitation on Windows, review it and choose Join. Compare the codes and approve
on Mac. The joining page retries the same persisted request after approval or a
network interruption.

Pairing and terminals share the native web server's port 8082. An existing HTTPS
listener retains its certificate. When the native listener is private HTTP on
loopback, that same native process also serves TLS peer routes on the selected
LAN address at 8082. The recovery listener remains private. Requests reach the
loopback relay through an authenticated internal route; setup opens no additional
public port. Pairing never restarts terminal engines. Each host issues a separate native terminal token and random gateway
capability for the peer. HPKE exchanges them without browser-visible plaintext.
HTTP and WebSocket terminal requests require that capability, the intended Host
header, a pinned HTTPS server identity, and absence of browser Origin. The
gateway authenticates its own loopback upstream using the peer's dedicated native
token. Gateway-native snapshots and fixed close/escape actions avoid copying
Windows helper assumptions to Mac peers. HTTP is reauthorized per request and before returning a response;
in-flight HTTP/control work is cancelled and open WebSockets are closed within one polling interval after their gateway
authorization disappears. This does not implement distributed member removal.

Identity and state live in a private `mesh/` directory beside the relay host JSON
(normally `~/.switchboard/mesh/`), outside `artifacts/`. Unix directories/files are
0700/0600. Windows replaces the DACL with a protected current-user grant, including
existing explicit ACEs; the Windows path is source-reviewed but not runtime-tested.
A process lock prevents competing writers. Credentials are staged privately and
the complete manifest is replaced atomically before in-memory membership changes.
The generated host catalog uses local credential paths, stable mesh IDs, remote
HTTPS endpoints and certificate pins. Manual hosts remain intact. The catalog
reloads in memory without restarting the relay or any terminal process.

The page marks unreachable paired hosts explicitly. Its Connected status requires
a successful authenticated native terminal catalog request, not just enrollment
or membership-service reachability. Actual terminal input/output on both target
computers remains an acceptance requirement.

## Verified checks

- Nine mesh Rust tests use only temporary directories, injected token issuers,
  fake native terminals, and disposable loopback TLS listeners. They cover
  bilateral credential/config persistence, approval/denial, wrong verification
  code, expiry, cancellation, concurrent redemption, exact approved-request
  retries, administrator authority, duplicate names, modified membership,
  HPKE recipient/issuer/tampering/version checks, private Unix permissions,
  failed manifest commits, failed first gateway setup, certificate pins, HTTP/WebSocket authorization,
  gateway Host/Origin checks, and active HTTP/socket authorization cutoff.
- The full isolated Rust relay suite passes 22 tests.
- Six headless Playwright tests cover explicit app-fragment/paste onboarding,
  preview without enrollment, invitation cancellation/clearing, approval of the
  visible code, safe display of computer names, and authenticated health state.

Run with:

```sh
cargo test -p zellij-client --features web_server_capability switchboard_relay --lib
PLAYWRIGHT_MODULE=/path/to/playwright node --test tools/switchboard/computers.test.cjs
```

## Remaining work

OS registration/launching of the `switchboard://` app link is not implemented;
the paste-link fallback and local page-fragment entry are available. Five-member
membership refresh, credential distribution between non-administrator peers,
name/address changes, rotation, distributed removal/revocation and offline
reconciliation are unfinished. The current bilateral flow can cache credentials
across restart, but actual administrator-outage and Mac↔Windows terminal behavior
must still be proven. The shared-port implementation is deployed on the Mac:
headless browser checks created and cancelled an invitation using port 8082,
verified Mac terminal rendering and Windows tab visibility, and confirmed that
engine/shell PIDs and Mac pane identities survived the connection-service update.
The Windows installation still needs this updated build for the same onboarding.
