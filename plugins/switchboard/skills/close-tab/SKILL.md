---
name: close-tab
description: Close the current Switchboard terminal tab when the user asks, including "if successful, close the tab". For conditional requests, close only after the requested work succeeds.
---

# Close the Switchboard tab

Treat "if successful, close the tab" as permission to close this agent's tab
once the requested work and its required checks have succeeded. Keep it open
if work fails, remains incomplete, or needs the user's input. Discussing or
editing this skill is not a request to close a tab.

Closing the tab stops every process in it, including you. Finish the work and
report the result, with any useful links, before making the close call as your
last action.

1. Set `switchboard_session="${ZELLIJ_SESSION_NAME:-main}"`. Switchboard uses
   `main` when the shell does not expose a session name; use this default without
   asking the user. Read `ZELLIJ_PANE_ID` from the shell environment. If it is
   missing, leave the tab open and explain that you cannot identify your pane.
2. Run `zellij -s "$switchboard_session" action list-panes --json --tab`.
   Find the entry with `is_plugin: false` and `id` equal to your numeric
   `ZELLIJ_PANE_ID`. Use that entry's `tab_id`, which is a stable ID;
   `tab_position`, `tab_name` and `is_focused` do not identify your tab.
   If there is no unique match or no `tab_id`, leave it open and report why.
3. Close that explicit tab, replacing `<tab_id>` with the ID you just found:

   ```sh
   zellij -s "$switchboard_session" action close-tab --tab-id <tab_id>
   ```

Always supply the session and tab ID: the user may have focused another tab.
If delivery fails or is uncertain and you are still running, read the pane
list again before any retry; stop if your original pane is gone.
