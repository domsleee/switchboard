"""Reconnect an existing local Zellij session in iTerm after a planned restart."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import time


def run_cli(binary, session, *action):
    env = {key: value for key, value in os.environ.items()
           if key not in {'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_SOCKET_DIR'}}
    return subprocess.run([str(binary), '-s', session, 'action', *action],
                          env=env, capture_output=True, text=True, timeout=5, check=True).stdout


def clients(binary, session):
    return {line.split()[0] for line in run_cli(binary, session, 'list-clients').splitlines()
            if line.split() and line.split()[0].isdigit()}


def recover(binary, session, wait=60, open_window=False):
    deadline = time.monotonic() + wait
    while True:
        try:
            panes = json.loads(run_cli(binary, session, 'list-panes', '--json', '--all'))
            if not isinstance(panes, list) or not any(
                    not pane.get('is_plugin') and not pane.get('exited') for pane in panes):
                raise RuntimeError('Session has no running terminal panes')
            existing_clients = clients(binary, session)
            if existing_clients and not open_window:
                return 'Session already has an attached client.'
            break
        except (subprocess.SubprocessError, ValueError, RuntimeError) as error:
            if time.monotonic() >= deadline:
                raise RuntimeError('Existing session did not become available; no session was created.') from error
            time.sleep(.5)

    # Pass the command as an AppleScript argument, never as code or shell input
    # to an existing terminal. Attach only: never resurrect or create a session.
    command = shlex.join([str(binary), 'attach', '--existing-only', session])
    script = '''on run argv
        tell application "iTerm"
            create window with default profile command (item 1 of argv)
        end tell
    end run'''
    subprocess.run(['/usr/bin/osascript', '-e', script, command],
                   capture_output=True, text=True, timeout=15, check=True)
    while True:
        try:
            if clients(binary, session) - existing_clients:
                return 'Recovered the existing session in iTerm.'
        except subprocess.SubprocessError:
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('iTerm opened, but no attached client was confirmed.')
        time.sleep(.5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path.home() / '.cargo/bin/zellij')
    parser.add_argument('--session', default='main')
    parser.add_argument('--wait', type=float, default=60)
    parser.add_argument('--open-window', action='store_true',
                        help='Restore a foreground terminal even if browser clients already reconnected')
    args = parser.parse_args()
    if args.wait <= 0 or not args.session or args.session.startswith('-') or any(ord(c) < 32 for c in args.session):
        parser.error('Use a positive wait and a nonempty session name without control characters.')
    try:
        print(recover(args.binary.resolve(), args.session, args.wait, args.open_window))
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error)) from error


if __name__ == '__main__':
    main()
