"""An unchanged live service must never be stopped while reinstalling."""
import importlib.util
import json
from pathlib import Path
import plistlib
import subprocess
import socket
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install_service.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

with tempfile.TemporaryDirectory() as directory:
    installer.AGENTS = Path(directory)
    config = {'ProgramArguments': ['/bin/true'], 'KeepAlive': True}
    (installer.AGENTS / 'test.job.plist').write_bytes(plistlib.dumps(dict(config, Label='test.job', RunAtLoad=True)))
    calls = []
    def run(command, **kwargs):
        calls.append(command[1])
        return subprocess.CompletedProcess(command, 0)
    with patch.object(installer.subprocess, 'run', side_effect=run):
        installer.install_job('test.job', config)
    assert calls == ['print', 'kickstart'], calls
print('Live service reinstall keeps the running relay online.')

with tempfile.TemporaryDirectory(prefix='sbi-') as directory:
    home = Path(directory)
    policy_file = home / '.local/share/switchboard/native-web-recovery.json'
    policy_file.parent.mkdir(parents=True)
    endpoint = home / 'main'
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(endpoint))
        metadata = endpoint.lstat()
        identity = f'{metadata.st_dev}:{metadata.st_ino}:{metadata.st_ctime_ns // 1_000_000_000}:{metadata.st_ctime_ns % 1_000_000_000}'
        policy = {'session': 'main', 'socket_path': str(endpoint), 'socket_identity': identity}
        policy_file.write_text(json.dumps(policy))
        with patch.object(installer.Path, 'home', return_value=home):
            command = installer.web_start_command('/bin/zellij')
            assert 'SWITCHBOARD_RECOVER_UNSHARED_SESSION=main' in command
            assert command.endswith(' || /bin/zellij web --daemonize')
            policy['socket_identity'] = 'stale'
            policy_file.write_text(json.dumps(policy))
            assert installer.web_start_command('/bin/zellij') == '/bin/zellij web --daemonize'
print('Web recovery is retained only for the original socket identity.')
