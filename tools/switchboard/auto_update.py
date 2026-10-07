"""Apply successful main-branch bundles without restarting terminal engines.

Uses Python's standard library and authenticated GitHub CLI artifact downloads.
Run once; the tray/LaunchAgent schedules checks every fifteen minutes.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = 'domsleee/switchboard'
ROOT = Path(__file__).resolve().parent
WINDOWS = sys.platform == 'win32'


def run(*args, timeout=60):
    environment = os.environ.copy()
    if WINDOWS and Path(str(args[0])).name.lower() == 'powershell.exe':
        # PowerShell 7's module path can shadow Windows PowerShell's core modules.
        environment = {key: value for key, value in environment.items() if key.lower() != 'psmodulepath'}
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=timeout,
                            env=environment,
                            creationflags=subprocess.CREATE_NO_WINDOW if WINDOWS else 0)
    if result.returncode:
        raise RuntimeError(f'{Path(str(args[0])).name} failed: {result.stderr.strip()[-2000:]}')
    return result.stdout.strip()


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    os.replace(temporary, path)


@contextlib.contextmanager
def update_lock(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'automatic.lock').open('a+b') as lock:
        if WINDOWS:
            import msvcrt
            lock.seek(0)
            if not lock.read(1):
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def target_platform():
    if WINDOWS:
        return 'windows'
    if sys.platform == 'darwin':
        return 'macos-arm64' if platform.machine() == 'arm64' else 'macos-x86_64'
    raise RuntimeError('Automatic updates currently support Windows and macOS')


def validate_bundle(directory, expected_commit, target):
    manifest = json.loads((directory / 'bundle.json').read_text(encoding='utf-8-sig'))
    if (manifest.get('schema') != 1 or manifest.get('commit') != expected_commit
            or not re.fullmatch(r'[a-f0-9]{40}', expected_commit)
            or manifest.get('platform') != target):
        raise ValueError('Bundle provenance or platform does not match the selected build')
    required = {'auto_update.py'}
    required |= ({'zellij.exe', 'install_windows_web.ps1', 'windows_releases.psm1',
                  'update_windows.ps1', 'windows_cli.ps1', 'update_services_windows.ps1'}
                 if target == 'windows' else
                 {'zellij', 'install_service.py', 'update_local.sh', 'menu_bar.swift'})
    if set(manifest.get('files', {})) != required:
        raise ValueError('Incomplete or unexpected update bundle')
    for name, digest in manifest['files'].items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError(f'Bundle checksum mismatch: {name}')
    return manifest


def latest_build():
    response = json.loads(run('gh', 'api',
        f'repos/{REPO}/actions/workflows/native-binaries.yml/runs?branch=main&status=success&per_page=20'))
    builds = [build for build in response['workflow_runs']
              if build['head_branch'] == 'main' and build['conclusion'] == 'success'
              and build['head_repository']['full_name'] == REPO
              and build['event'] in ('push', 'workflow_dispatch')]
    return max(builds, key=lambda build: build['run_number']) if builds else None


def catalog(port):
    # Tokens stay in the relay; only session identity/sharing crosses this boundary.
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api/hosts',
                                     headers={'Host': 'switchboard.localhost'})
    with urllib.request.urlopen(request, timeout=10) as response:
        hosts = json.load(response)
    return sorted((host['id'], session['name'], bool(session.get('web_clients_allowed')))
                  for host in hosts for session in host.get('sessions', []))


def health(port):
    request = urllib.request.Request(f'http://127.0.0.1:{port}/api/health',
                                     headers={'Host': 'switchboard.localhost'})
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)


def wait_ready(port, commit, sessions):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            current = health(port)
            if (current.get('relay') == 'rust' and commit.startswith(current.get('commit') or '!')
                    and set(sessions).issubset(set(catalog(port)))):
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError('Updated relay did not recover its build identity and existing session catalog')


def powershell(script, *args):
    exe = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    return run(exe, '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
               '-File', script, *args, timeout=180)


def windows_services(action, snapshot, args, binary=''):
    values = ['-Action', action, '-Snapshot', snapshot, '-ReleaseDirectory', args.release_directory,
              '-HostConfig', args.host_config, '-RelayPort', str(args.port)]
    if binary:
        values += ['-Binary', binary]
    return powershell(ROOT / 'update_services_windows.ps1', *values)


def selected_binary(args):
    if not WINDOWS:
        return Path(args.binary).resolve()
    state = json.loads((args.release_directory / 'current.json').read_text(encoding='utf-8-sig'))
    if not re.fullmatch(r'[a-f0-9]{64}', state['sha256']):
        raise ValueError('Invalid selected executable checksum')
    return args.release_directory / state['sha256'] / 'zellij.exe'


def install_binary(candidate, args):
    # This updater performs its own service handoff; the selectors must not.
    # An environment variable (not a flag) keeps older retained helpers working.
    os.environ['SWITCHBOARD_UPDATE_BINARY_ONLY'] = '1'
    if WINDOWS:
        values = ['-Candidate', candidate, '-ReleaseDirectory', args.release_directory]
        if args.config:
            values += ['-Config', args.config]
        powershell(ROOT / 'update_windows.ps1', *values)
    else:
        run('bash', ROOT / 'update_local.sh', candidate, args.binary, timeout=300)


def verify_auth(old, candidate, config):
    prefix = ['--config', config] if config else []
    before = set(run(old, *prefix, 'web', '--list-tokens', timeout=15).splitlines())
    after = set(run(candidate, *prefix, 'web', '--list-tokens', timeout=15).splitlines())
    if not before.issubset(after):
        raise RuntimeError('Candidate cannot see existing authentication tokens; services were not changed')


def restart_mac(args):
    # launchd owns only the relay. Native web --stop does not stop session engines.
    run(args.binary, 'web', '--stop')
    from install_service import web_start_command
    run('/bin/sh', '-c', web_start_command(str(args.binary)))
    run('launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/dev.zellij.switchboard')


def mac_processes():
    rows = []
    for line in run('ps', '-u', str(os.getuid()), '-o', 'pid=,ppid=,lstart=,command=').splitlines():
        match = re.match(r'\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)', line)
        if match:
            pid, parent, started, command = match.groups()
            rows.append((int(pid), int(parent), started, command))
    # Only session engines must survive; their shells/agents may exit on their own.
    return {str(pid): started for pid, _, started, command in rows if re.search(r'\bzellij\s+--server\s', command)}


def verify_mac_processes(baseline):
    current = mac_processes()
    if any(current.get(pid) != started for pid, started in baseline.items()):
        raise RuntimeError('A terminal engine changed during the update')


def apply_bundle(bundle, manifest, args, state, state_path):
    sessions = catalog(args.port)
    old_commit = health(args.port)['commit']
    old = selected_binary(args)
    candidate = bundle / ('zellij.exe' if WINDOWS else 'zellij')
    candidate.chmod(candidate.stat().st_mode | 0o111)
    verify_auth(old, candidate, args.config)
    backup = args.state_directory / ('rollback-' + str(time.time_ns()))
    backup.mkdir()
    previous = backup / ('zellij.exe' if WINDOWS else 'zellij')
    shutil.copy2(old, previous)
    for name in manifest['files']:
        if (ROOT / name).is_file() and name not in ('zellij', 'zellij.exe'):
            shutil.copy2(ROOT / name, backup / name)
    snapshot = backup / 'services.json'
    if WINDOWS:
        windows_services('Snapshot', snapshot, args)
    # Persist rollback information before the first mutation. The next check
    # recovers this journal if the updater or machine dies during the handoff.
    state['pending'] = {'backup': str(backup), 'commit': old_commit, 'sessions': sessions,
                        'processes': {} if WINDOWS else mac_processes()}
    save(state_path, state)
    try:
        install_binary(candidate, args)
        if WINDOWS:
            windows_services('Stop', snapshot, args)
            windows_services('Start', snapshot, args, selected_binary(args))
        else:
            restart_mac(args)
        wait_ready(args.port, manifest['commit'], sessions)
        if WINDOWS:
            windows_services('Verify', snapshot, args)
        else:
            verify_mac_processes(state['pending']['processes'])
        for name in manifest['files']:
            if name not in ('zellij', 'zellij.exe'):
                shutil.copy2(bundle / name, ROOT / name)
        # Reload the tray/menu only after the connection services recover.
        if WINDOWS:
            windows_services('StopTray', snapshot, args)
            values = ['-ReleaseDirectory', args.release_directory]
            if args.config:
                values += ['-Config', args.config]
            powershell(ROOT / 'install_windows_web.ps1', *values)
        else:
            run(sys.executable, ROOT / 'install_service.py', '--menu-only', '--binary', args.binary, timeout=180)
            run('launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/dev.switchboard.menu')
        state.pop('pending')
        state['commit'] = manifest['commit']
        save(state_path, state)
    except BaseException:
        recover(args, state, state_path)
        raise


def recover(args, state, state_path):
    pending = state['pending']
    backup = Path(pending['backup']).resolve()
    if backup.parent != args.state_directory.resolve() or not backup.name.startswith('rollback-'):
        raise ValueError('Invalid rollback directory')
    # Restore trusted previous helpers before using them to recover services.
    for path in backup.iterdir():
        if path.name not in ('zellij', 'zellij.exe', 'services.json') and path.is_file():
            shutil.copy2(path, ROOT / path.name)
    install_binary(backup / ('zellij.exe' if WINDOWS else 'zellij'), args)
    if WINDOWS:
        snapshot = backup / 'services.json'
        windows_services('Stop', snapshot, args)
        windows_services('Start', snapshot, args, selected_binary(args))
        windows_services('Verify', snapshot, args)
        values = ['-ReleaseDirectory', args.release_directory]
        if args.config:
            values += ['-Config', args.config]
        powershell(ROOT / 'install_windows_web.ps1', *values)
    else:
        restart_mac(args)
        verify_mac_processes(pending['processes'])
        run(sys.executable, ROOT / 'install_service.py', '--menu-only', '--binary', args.binary, timeout=180)
        run('launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/dev.switchboard.menu')
    if pending.get('commit'):
        wait_ready(args.port, pending['commit'], [tuple(row) for row in pending['sessions']])
    state.pop('pending')
    save(state_path, state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='')
    parser.add_argument('--host-config', type=Path, default=Path.home() / (
        '.config/switchboard/hosts.json' if WINDOWS else '.config/zellij/switchboard-hosts.json'))
    parser.add_argument('--port', type=int, default=80 if WINDOWS else 8090)
    parser.add_argument('--binary', type=Path, default=Path.home() / '.cargo/bin/zellij')
    parser.add_argument('--release-directory', type=Path, default=Path.home() / '.local/share/switchboard/windows-releases')
    parser.add_argument('--state-directory', type=Path, default=Path.home() / '.local/share/switchboard/automatic-updates')
    parser.add_argument('--check', action='store_true', help='Check/download/verify without changing services')
    args = parser.parse_args()
    with update_lock(args.state_directory):
        # The tray yields service supervision only while this updater is alive.
        handoff = args.state_directory / 'handoff.json'
        state_path = args.state_directory / 'state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if 'pending' in state:
            if args.check:
                raise RuntimeError('Interrupted update requires recovery before checking another build')
            save(handoff, {'pid': os.getpid()})
            try:
                recover(args, state, state_path)
            finally:
                handoff.unlink(missing_ok=True)
        build = latest_build()
        if not build or build['run_number'] <= state.get('run_number', 0):
            print('No newer successful main build.')
            return
        target = target_platform()
        with tempfile.TemporaryDirectory(prefix='download-', dir=args.state_directory) as temporary:
            bundle = Path(temporary)
            run('gh', 'run', 'download', str(build['id']), '--repo', REPO,
                '--name', 'switchboard-' + target, '--dir', bundle, timeout=300)
            if not (bundle / 'bundle.json').is_file():
                state['run_number'] = build['run_number']
                state['notice'] = 'Waiting for a newer main build with an automatic-update bundle.'
                save(state_path, state)
                print(state['notice'])
                return
            manifest = validate_bundle(bundle, build['head_sha'], target)
            if args.check:
                print('Verified update ' + manifest['commit'])
                return
            # Do not retry a broken build every fifteen minutes. A newer build
            # is still eligible; state.json records the failure for inspection.
            state['run_number'] = build['run_number']
            try:
                save(handoff, {'pid': os.getpid()})
                apply_bundle(bundle, manifest, args, state, state_path)
                state.pop('error', None)
                state.pop('notice', None)
                print('Updated connection services to ' + manifest['commit'])
            except Exception as error:
                state['error'] = str(error)
                raise
            finally:
                save(state_path, state)
                handoff.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
