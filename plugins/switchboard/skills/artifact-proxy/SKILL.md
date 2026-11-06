---
name: artifact-proxy
description: Serve an existing HTML or media artifact server through Switchboard, including private Tailscale access. Use when sharing a local artifact from a Switchboard session or replacing an unreachable LAN artifact URL. Preserve an explicitly chosen hosting service.
---

# Artifact proxy

Keep the artifact's existing server and give the user a stable URL reachable from
where they view Switchboard. Switchboard proxies GET/HEAD, streams media ranges,
and keeps each server on a separate browser origin. This is for read-only artifact
servers; applications needing POST, login cookies or WebSockets need another host.

## Register or reuse

Read `http://127.0.0.1:8090/api/artifact-proxies` on the computer the browser uses
as its Switchboard gateway. Reuse a matching registration. The gateway must be
able to reach the target; a target on another computer needs a reachable address,
not that computer's loopback address. Registration does not create a mesh tunnel.

For a new registration, POST JSON to that endpoint from the gateway's local CLI:

```json
{
  "id": "race-control",
  "target": "http://127.0.0.1:8767",
  "listen_port": 8443,
  "public_origin": "https://workstation.example.ts.net:8443"
}
```

Select an unused listener port and a public origin separate from the terminal
sidebar and every other artifact proxy. Inspect existing registrations and the
reverse proxy's configuration before choosing. The target must be an HTTP(S)
origin with no path. For a self-signed HTTPS server, supply `tls_fingerprint`, the
SHA-256 DER certificate fingerprint verified against the server's local certificate.
Keep real machine names and certificate pins in local configuration.

Registrations persist beside the host config in `*.artifact-proxies.json`. An
identical POST reuses the listener. A conflicting ID or occupied port fails without
replacing a server. The response contains `url` and `local_url`; it does not prove
that the public reverse proxy is configured. No relay restart is needed.

## Private Tailscale access

When the user views Switchboard through Tailscale, inspect `tailscale serve status`
and reuse that device's DNS name. Forward the chosen HTTPS port to `local_url`, e.g.:

```text
tailscale serve --bg --https=8443 http://127.0.0.1:8443
```

Configure this only for the artifact the user asked to share, on a port without
an existing Serve handler. Preserve the sidebar's port 443 handler and other
services. Use private Serve; public Funnel is a different sharing request. If
Tailscale requires account approval, report the exact setup requirement. Do not
claim that a LAN URL becomes remotely reachable merely because Switchboard is.

## Verify and deliver

Check both the local proxy and the HTTPS URL, plus a referenced script or data file.
For media, verify HEAD and a bounded byte range return the expected headers and
bytes. Confirm the page's controls in a browser when available. A local-only check
is not evidence of remote reachability; disclose what was actually tested.

Return the registered public URL and keep it stable on updates. Registered source
origins in terminal links are rewritten after reloading the terminal viewer's link
configuration. Use the public URL directly in replies so it also works outside
Switchboard. Keep the source server running; stopping it makes the proxy unavailable.
