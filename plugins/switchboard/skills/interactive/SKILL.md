---
name: interactive
description: Run a command that needs a terminal inside a Switchboard terminal. Use when a command prompts for a password or other input (ssh, gio mount, gh auth login, passwd), or failed because stdin is not a terminal.
---

# Interactive commands in Switchboard

Your shell has no terminal, so a command that prompts fails or quits. Switchboard
runs it in a floating pane beside yours; the user types into that pane, and the
command's output and exit status come back to you when the pane closes.

For sudo, use the `sudo` skill instead: `sudo -A` asks in the sidebar.

1. Run `~/.local/share/switchboard/run-interactive '<command line>'` with a Bash
   timeout of 600000 ms. It waits up to 9 minutes for the user. Several arguments
   run as one program and its arguments; a single argument runs as an `sh` command line.
2. Tell the user, in one line, that the command is waiting for them in a pane on
   this tab.
3. Read the result. Its output is what the pane showed, minus anything typed with
   echo off, and its exit status is the command's own.
   - `Nobody finished the command within 9 minutes`, or `The pane was closed
     before the command finished`: report it and wait; the user decides whether
     to retry.
   - `only inside a Switchboard terminal`, or the script is missing: ask the
     user to run the command in a terminal themselves.

The user types secrets into the pane. Ask for them there, never in chat.
