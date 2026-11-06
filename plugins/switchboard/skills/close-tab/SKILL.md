---
name: close-tab
description: Close this Switchboard tab when requested, including "if successful, close the tab" after the requested work and checks succeed.
---

Finish the work and report its result before closing: this stops every process
in the tab, including you. Keep it open if work failed or remains incomplete.
Discussing this skill is not a request to close a tab.

Use the authenticated HTTPS API described in [terminal](../terminal/SKILL.md).
Find this computer's `local: true` host in `/api/hosts`. Use
`ZELLIJ_SESSION_NAME` (default `main`) and the numeric `ZELLIJ_PANE_ID`.
If the pane ID is unavailable, leave the tab open and explain why.

As your last action, POST to `/api/hosts/<local-host-id>/terminal`:

```json
{"action":"close","session":"main","pane_id":17}
```

Use your actual session and pane ID. The server closes that pane's tab even if
the user has focused another. After uncertain delivery, refresh the pane list
before any retry; stop if the original pane is gone.
