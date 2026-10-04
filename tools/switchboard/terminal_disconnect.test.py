"""Hang up a disposable native client; its engine and terminal must survive.

Usage: python3 terminal_disconnect.test.py /path/to/zellij
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix='sb-disconnect-', dir='/tmp') as scratch:
    root = Path(scratch)
    config = root / 'config.kdl'
    config.write_text('default_shell "/bin/bash"\nshow_startup_tips false\n'
                      'session_serialization false\ndisable_session_metadata true\n')
    env = {k: v for k, v in os.environ.items()
           if k not in ('ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_CONFIG_FILE', 'ZELLIJ_CONFIG_DIR')}
    env.update(ZELLIJ_SOCKET_DIR=str(root / 'sockets'), TERM='xterm-256color')
    name = 'disconnect-test'

    def cli(*args):
        return subprocess.check_output([binary, '--config', str(config), *args],
                                       env=env, stderr=subprocess.PIPE, timeout=15)

    def identities():
        return sorted((p['id'], p['tab_id'], p['is_plugin'])
                      for p in json.loads(cli('-s', name, 'action', 'list-panes', '--json', '--all')))

    client = None
    master = slave = None
    try:
        cli('attach', '--create-background', name, '--', '/bin/bash', '--noprofile', '--norc')
        deadline = time.monotonic() + 10
        while not (before := identities()):
            assert time.monotonic() < deadline, 'Session did not create its terminal'
            time.sleep(0.1)
        marker = b'SWITCHBOARD_DISCONNECT_READY'
        cli('-s', name, 'action', 'write-chars', '-p', str(before[0][0]), "printf 'SWITCHBOARD_DISCONNECT_READY\\n'")
        cli('-s', name, 'action', 'write', '-p', str(before[0][0]), '13')
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        client = subprocess.Popen([binary, '--config', str(config), 'attach', '--existing-only', name],
                                  env=env, stdin=slave, stdout=slave, stderr=slave,
                                  preexec_fn=controlling_terminal)
        os.close(slave)
        slave = None
        # Terminal setup also writes bytes. Wait for the actual session render,
        # after the client has installed its signal handlers.
        output = b''
        deadline = time.monotonic() + 10
        while marker not in output:
            remaining = deadline - time.monotonic()
            assert remaining > 0 and select.select([master], [], [], remaining)[0], f'Client did not render: {output!r}'
            chunk = os.read(master, 65536)
            assert chunk, 'Client disconnected before rendering'
            output += chunk
        os.close(master)
        master = None
        result = client.wait(timeout=10)
        assert result >= 0, f'Client crashed with signal {-result}'
        assert identities() == before, 'Terminal identity changed after client hangup'
        print('PASS: native terminal hangup exits without a signal crash and preserves its session')
    finally:
        for fd in (master, slave):
            if fd is not None:
                os.close(fd)
        if client and client.poll() is None:
            client.kill()
            client.wait(timeout=5)
        # This socket directory contains only the session created by this test.
        subprocess.run([binary, '--config', str(config), 'kill-session', name],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
