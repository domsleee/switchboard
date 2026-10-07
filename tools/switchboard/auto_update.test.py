"""Update provenance and rollback checks; service mutations are simulated."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('updater', ROOT / 'auto_update.py')
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
spec = importlib.util.spec_from_file_location('packager', ROOT / 'package_update.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class Updates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='switchboard-update-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'bundle'
        binary = self.root / 'zellij.exe'
        binary.write_bytes(b'new executable')
        with patch.object(packager.subprocess, 'check_output', return_value='a' * 40):
            packager.package(binary, 'windows', self.bundle)
        self.manifest = updater.validate_bundle(self.bundle, 'a' * 40, 'windows')

    def test_bundle_checks_contents_platform_commit_and_paths(self):
        for commit, target in [('b' * 40, 'windows'), ('a' * 40, 'macos-arm64')]:
            with self.assertRaises(ValueError):
                updater.validate_bundle(self.bundle, commit, target)
        (self.bundle / 'zellij.exe').write_bytes(b'corrupted download')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            updater.validate_bundle(self.bundle, 'a' * 40, 'windows')
        self.manifest['files']['../outside'] = '0' * 64
        (self.bundle / 'bundle.json').write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            updater.validate_bundle(self.bundle, 'a' * 40, 'windows')

    def test_latest_build_ignores_branches_forks_and_failed_runs(self):
        base = {'run_number': 1, 'head_branch': 'main', 'conclusion': 'success',
                'head_repository': {'full_name': updater.REPO}, 'event': 'push'}
        builds = [base, dict(base, run_number=2), dict(base, run_number=3, head_branch='feature'),
                  dict(base, run_number=4, conclusion='failure'),
                  dict(base, run_number=5, head_repository={'full_name': 'someone/fork'}),
                  dict(base, run_number=6, event='pull_request')]
        with patch.object(updater, 'run', return_value=json.dumps({'workflow_runs': builds})):
            self.assertEqual(updater.latest_build()['run_number'], 2)

    def test_macos_bundles_and_process_identity_checks(self):
        binary = self.root / 'zellij'
        binary.write_bytes(b'mac executable')
        for target in ('macos-arm64', 'macos-x86_64'):
            bundle = self.root / target
            with patch.object(packager.subprocess, 'check_output', return_value='a' * 40):
                packager.package(binary, target, bundle)
            updater.validate_bundle(bundle, 'a' * 40, target)
        with patch.object(updater, 'mac_processes', return_value={'123': 'original'}):
            updater.verify_mac_processes({'123': 'original'})
            with self.assertRaises(RuntimeError):
                updater.verify_mac_processes({'123': 'reused pid'})

    def test_lock_released_on_exception(self):
        with self.assertRaisesRegex(RuntimeError, 'failed update'):
            with updater.update_lock(self.root):
                raise RuntimeError('failed update')
        with updater.update_lock(self.root):
            pass

    def test_candidate_must_see_existing_authentication_tokens(self):
        with patch.object(updater, 'run', side_effect=['existing token', 'other token']):
            with self.assertRaisesRegex(RuntimeError, 'authentication'):
                updater.verify_auth('old', 'new', '')
        with patch.object(updater, 'run', side_effect=['existing token', 'new token\nexisting token']):
            updater.verify_auth('old', 'new', '')

    def transaction(self, failure=False, rollback_failure=False, windows=True):
        installed = self.root / 'installed'
        installed.mkdir()
        old = self.root / 'old.exe'
        old.write_bytes(b'old executable')
        if not windows:
            binary = self.root / 'zellij'
            binary.write_bytes(b'new executable')
            self.bundle = self.root / 'mac-bundle'
            with patch.object(packager.subprocess, 'check_output', return_value='a' * 40):
                packager.package(binary, 'macos-arm64', self.bundle)
            self.manifest = updater.validate_bundle(self.bundle, 'a' * 40, 'macos-arm64')
        (installed / 'auto_update.py').write_text('previous updater')
        state_dir = self.root / 'state'
        state_dir.mkdir()
        args = SimpleNamespace(port=12345, state_directory=state_dir,
                               release_directory=self.root / 'releases', config='config.kdl', binary=old)
        state = {'run_number': 2}
        state_path = state_dir / 'state.json'
        calls = []

        def service(action, snapshot, *_):
            calls.append(action)
            if action == 'Snapshot':
                snapshot.write_text('{}')

        def install(candidate, *_):
            calls.append(('install', candidate.read_bytes()))

        def ready(port, commit, sessions):
            calls.append(('ready', commit))
            if (failure and commit == 'a' * 40) or (rollback_failure and commit == 'old'):
                raise RuntimeError('simulated readiness failure')

        with patch.multiple(updater, WINDOWS=windows, ROOT=installed), \
                patch.object(updater, 'catalog', return_value=[('windows', 'main', True)]), \
                patch.object(updater, 'health', return_value={'commit': 'old'}), \
                patch.object(updater, 'selected_binary', return_value=old), \
                patch.object(updater, 'windows_services', side_effect=service), \
                patch.object(updater, 'install_binary', side_effect=install), \
                patch.object(updater, 'wait_ready', side_effect=ready), \
                patch.object(updater, 'mac_processes', return_value={'123': 'original'}), \
                patch.object(updater, 'restart_mac', side_effect=lambda _: calls.append('restart_mac')), \
                patch.object(updater.os, 'getuid', return_value=501, create=True), \
                patch.object(updater, 'run', return_value=''), \
                patch.object(updater, 'powershell', return_value=''):
            if failure:
                with self.assertRaises(RuntimeError):
                    updater.apply_bundle(self.bundle, self.manifest, args, state, state_path)
            else:
                updater.apply_bundle(self.bundle, self.manifest, args, state, state_path)
        return state, calls, installed

    def test_success_verifies_services_before_replacing_helpers(self):
        state, calls, installed = self.transaction()
        self.assertEqual(state['commit'], 'a' * 40)
        self.assertNotIn('pending', state)
        self.assertLess(calls.index('Verify'), calls.index('StopTray'))
        self.assertEqual((installed / 'auto_update.py').read_bytes(), (self.bundle / 'auto_update.py').read_bytes())

    def test_failed_health_restores_executable_and_helpers(self):
        state, calls, installed = self.transaction(failure=True)
        self.assertNotIn('pending', state)
        self.assertIn(('install', b'old executable'), calls)
        self.assertIn(('ready', 'old'), calls)
        self.assertEqual((installed / 'auto_update.py').read_text(), 'previous updater')

    def test_failed_rollback_retains_recovery_journal(self):
        state, calls, _ = self.transaction(failure=True, rollback_failure=True)
        self.assertIn('pending', state)
        self.assertTrue(Path(state['pending']['backup']).is_dir())

    def test_macos_handoff_and_rollback(self):
        state, calls, installed = self.transaction(failure=True, windows=False)
        self.assertNotIn('pending', state)
        self.assertEqual(calls.count('restart_mac'), 2)
        self.assertIn(('install', b'old executable'), calls)
        self.assertEqual((installed / 'auto_update.py').read_text(), 'previous updater')


if __name__ == '__main__':
    unittest.main()
