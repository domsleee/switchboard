"""Install Switchboard's macOS menu bar app and supervised background relay."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parent
LABEL = 'dev.zellij.switchboard'
DOMAIN = f'gui/{os.getuid()}'
AGENTS = Path.home() / 'Library/LaunchAgents'
LOGS = Path.home() / 'Library/Logs'


def web_start_command(zellij):
    normal = shlex.join([zellij, 'web', '--daemonize'])
    recovery_file = Path.home() / '.local/share/switchboard/native-web-recovery.json'
    try:
        policy = json.loads(recovery_file.read_text())
        metadata = Path(policy['socket_path']).lstat()
        identity = f'{metadata.st_dev}:{metadata.st_ino}:{metadata.st_ctime_ns // 1_000_000_000}:{metadata.st_ctime_ns % 1_000_000_000}'
        if identity == policy['socket_identity']:
            recovered = shlex.join(['env', 'SWITCHBOARD_RECOVER_UNSHARED_SESSION=' + policy['session'],
                                   'SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY=' + identity,
                                   zellij, 'web', '--daemonize'])
            return recovered + ' || ' + normal
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return normal


def install_job(label, config):
    target = AGENTS / (label + '.plist')
    data = plistlib.dumps(dict(config, Label=label, RunAtLoad=True))
    previous = target.read_bytes() if target.exists() else None
    loaded = subprocess.run(['launchctl', 'print', DOMAIN + '/' + label], capture_output=True).returncode == 0
    target.write_bytes(data)
    if loaded and previous == data:
        subprocess.run(['launchctl', 'kickstart', DOMAIN + '/' + label], check=True)
        return
    if loaded:
        subprocess.run(['launchctl', 'bootout', DOMAIN + '/' + label], check=True)
    # launchd can report EIO while the old job finishes removing its resources.
    for attempt in range(60):
        result = subprocess.run(['launchctl', 'bootstrap', DOMAIN, str(target)], capture_output=True)
        if result.returncode != 5:
            break
        time.sleep(.5)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace').strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--menu-only', action='store_true', help='Install the icon without changing the relay')
    args = parser.parse_args()
    AGENTS.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    zellij = shutil.which('zellij')
    if not zellij:
        raise SystemExit('The Switchboard zellij executable must be installed')
    subprocess.run([zellij, 'serve', '--help'], check=True, stdout=subprocess.DEVNULL)
    app = Path.home() / 'Applications/Switchboard.app'
    contents = app / 'Contents'
    executable = contents / 'MacOS/Switchboard'
    executable.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['swiftc', str(ROOT / 'menu_bar.swift'), '-o', str(executable)], check=True)
    (contents / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': 'dev.switchboard.menu', 'CFBundleName': 'Switchboard',
        'CFBundleExecutable': 'Switchboard', 'CFBundlePackageType': 'APPL',
        'CFBundleVersion': '1', 'LSUIElement': True, 'SwitchboardZellij': zellij,
    }))
    if not args.menu_only:
        startup = shlex.join([zellij, 'web', '--status', '--timeout', '2']) + ' >/dev/null 2>&1 || { ' + web_start_command(zellij) + '; }'
        relay = shlex.join([zellij, 'serve', '--host-config', str(Path.home() / '.config/zellij/switchboard-hosts.json'), '--port', '8090'])
        install_job(LABEL, {
            'ProgramArguments': ['/bin/sh', '-c', startup + '; exec ' + relay],
            'WorkingDirectory': str(ROOT), 'KeepAlive': True,
            'StandardOutPath': str(LOGS / 'zellij-switchboard.log'),
            'StandardErrorPath': str(LOGS / 'zellij-switchboard.log'),
            'EnvironmentVariables': {'PATH': f'{Path.home()}/.local/bin:{Path.home()}/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
        })
    install_job('dev.switchboard.menu', {
        'ProgramArguments': [str(executable)], 'KeepAlive': False,
        'StandardOutPath': str(LOGS / 'switchboard-menu.log'),
        'StandardErrorPath': str(LOGS / 'switchboard-menu.log'),
    })
    print('Switchboard menu bar app installed: https://switchboard.localhost')


if __name__ == '__main__':
    main()
