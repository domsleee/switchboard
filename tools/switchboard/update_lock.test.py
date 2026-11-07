"""Exercise installer locking with private executables and no real services."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


@unittest.skipUnless(os.name == 'posix', 'Unix installer')
class InstallLock(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='switchboard-lock-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.installed = self.root / 'zellij'
        self.candidate = self.root / 'candidate'
        self.script = Path(__file__).with_name('update_local.sh')
        binary = '''#!/bin/bash
case "$*" in
  --version)
    if [[ -f "$TEST_STALL" ]]; then touch "$TEST_ENTERED"; sleep 2; fi
    if [[ -n ${TEST_DAEMON_PID:-} ]]; then
      sleep 20 >/dev/null 2>&1 & echo $! >> "$TEST_DAEMON_PID"
    fi
    echo 'zellij fixture' ;;
  'web --list-tokens') echo fixture-token ;;
  'list-sessions --no-formatting') echo 'No active zellij sessions found.' >&2; exit 1 ;;
esac
'''
        for file in (self.installed, self.candidate):
            file.write_text(binary)
            file.chmod(0o755)
        self.candidate.write_text(binary + '# candidate\n')
        fakebin = self.root / 'bin'
        fakebin.mkdir()
        (fakebin / 'ps').write_text('#!/bin/sh\nexit 0\n')
        (fakebin / 'ps').chmod(0o755)
        self.env = dict(os.environ, HOME=str(self.root),
                        PATH=str(fakebin) + ':' + os.environ['PATH'],
                        TEST_STALL=str(self.root / 'stall'),
                        TEST_ENTERED=str(self.root / 'entered'))
        self.env.pop('SWITCHBOARD_INSTALL_LOCK_HELD', None)
        self.args = ['bash', str(self.script), '--binary-only',
                     str(self.candidate), str(self.installed)]

    def run_update(self):
        return subprocess.run(self.args, env=self.env, capture_output=True,
                              text=True, timeout=15)

    def stalled_update(self):
        (self.root / 'stall').touch()
        process = subprocess.Popen(self.args, env=self.env,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        deadline = time.monotonic() + 5
        while not (self.root / 'entered').exists():
            self.assertIsNone(process.poll(), 'installer exited before its probe')
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.02)
        return process

    def test_success_can_be_repeated(self):
        for _ in range(2):
            result = self.run_update()
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed.read_bytes(), self.candidate.read_bytes())
        self.assertFalse(list(self.root.glob('zellij.update-work.*')))

    def test_live_owner_blocks_concurrent_install_and_sigkill_releases_lock(self):
        process = self.stalled_update()
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Another installation is running', result.stderr)
        process.kill()
        process.wait(timeout=5)
        (self.root / 'stall').unlink()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_term_allows_cleanup(self):
        process = self.stalled_update()
        process.send_signal(signal.SIGTERM)
        self.assertNotEqual(process.wait(timeout=5), 0)
        self.assertFalse(list(self.root.glob('zellij.update-work.*')))
        (self.root / 'stall').unlink()
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_ownerless_legacy_directory_is_preserved(self):
        legacy = self.root / 'zellij.update-lock'
        legacy.mkdir()
        (legacy / 'recovery').write_text('retain me')
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('needs inspection', result.stderr)
        self.assertEqual((legacy / 'recovery').read_text(), 'retain me')

    def test_probe_descendants_do_not_retain_installation_lock(self):
        pid_file = self.root / 'daemon-pids'
        self.env['TEST_DAEMON_PID'] = str(pid_file)
        def stop_daemons():
            for pid in pid_file.read_text().splitlines() if pid_file.exists() else []:
                try:
                    os.kill(int(pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass
        self.addCleanup(stop_daemons)
        for _ in range(2):
            result = self.run_update()
            self.assertEqual(result.returncode, 0, result.stderr)
        for pid in pid_file.read_text().splitlines():
            os.kill(int(pid), 0)  # Still alive, but no longer owning the install lock.


if __name__ == '__main__':
    unittest.main()
