"""An unchanged live service must never be stopped while reinstalling."""
import importlib.util
from pathlib import Path
import plistlib
import subprocess
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
