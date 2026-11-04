---
name: sudo
description: Run a command as root inside a Switchboard terminal. Use when a command needs sudo, or sudo failed with "a terminal is required".
---

# sudo in Switchboard

Run `sudo -A <command>`. `SUDO_ASKPASS` points at Switchboard's helper, so the
user types the password in the Switchboard sidebar and sudo reads it from there.
The password never passes through you.

1. Give the Bash call a timeout of at least 150000 ms. The request waits up to
   2 minutes for the user.
2. Tell the user, in one line, that sudo is waiting for their password in Switchboard.
3. Read the result:
   - Success: carry on. sudo remembers the password for its usual few minutes.
   - `Cancelled in Switchboard`: the user declined. Report it and wait for them;
     they decide whether to retry.
   - `Nobody answered in Switchboard within 2 minutes`: report it and wait.
   - `Switchboard asks for passwords only inside a Switchboard terminal`, or
     `SUDO_ASKPASS` is empty: the terminal predates this feature. Use
     `SUDO_ASKPASS=~/.local/share/switchboard/sudo-askpass sudo -A <command>`; when
     that script is missing, the user runs the command themselves.

Passwords go to the sidebar dialog only. Ask for one there, never in chat.
