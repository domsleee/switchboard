"""Retired: automatic updates run in the Switchboard executable.

Schedulers installed before `zellij switchboard update` still start this file
(and the retired updater requires it in each bundle). It forwards their
arguments unchanged. Reinstall the tray or LaunchAgent to call the executable
directly; then this shim can be removed from bundles.
"""
import json
from pathlib import Path
import subprocess
import sys

args = sys.argv[1:]


def option(name, default):
    return Path(args[args.index(name) + 1]) if name in args[:-1] else default


if sys.platform == 'win32':
    store = option('--release-directory', Path.home() / '.local/share/switchboard/windows-releases')
    selected = json.loads((store / 'current.json').read_text(encoding='utf-8-sig'))['sha256']
    binary = store / selected / 'zellij.exe'
else:
    binary = option('--binary', Path.home() / '.cargo/bin/zellij')
sys.exit(subprocess.call([str(binary), 'switchboard', 'update', *args]))
