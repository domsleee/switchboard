"""Retired: run `zellij switchboard install`. Update bundles still list this file."""
import shutil
import subprocess
import sys

zellij = shutil.which('zellij') or sys.exit('Install the Switchboard zellij executable first')
sys.exit(subprocess.call([zellij, 'switchboard', 'install', *sys.argv[1:]]))
