"""Stage the executable and updater helpers as a checksummed CI artifact."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys


def package(binary, platform, destination):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parent
    names = ['auto_update.py']
    if platform == 'windows':
        names += ['install_windows_web.ps1', 'windows_releases.psm1',
                  'update_windows.ps1', 'windows_cli.ps1', 'update_services_windows.ps1']
    else:
        names += ['install_service.py', 'update_local.sh', 'menu_bar.swift']
    files = {}
    for source in [Path(binary), *(root / name for name in names)]:
        target = destination / source.name
        shutil.copy2(source, target)
        files[target.name] = hashlib.sha256(target.read_bytes()).hexdigest()
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    (destination / 'bundle.json').write_text(json.dumps({
        'schema': 1, 'commit': commit, 'platform': platform, 'files': files,
    }), encoding='utf-8')


if __name__ == '__main__':
    package(*sys.argv[1:])
