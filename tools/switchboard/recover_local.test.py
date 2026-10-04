"""Recovery must attach an existing session and verify the client, without recreating shells."""
import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).with_name('recover_local.py'))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class RecoveryTests(unittest.TestCase):
    def test_opens_existing_session_and_waits_for_client(self):
        with patch.object(recovery, 'run_cli', return_value='[{"is_plugin":false,"exited":false}]'), \
                patch.object(recovery, 'clients', side_effect=[set(), set(), {'1'}]), \
                patch.object(recovery.time, 'sleep'), \
                patch.object(recovery.subprocess, 'run') as run:
            self.assertIn('Recovered', recovery.recover('/a path/zellij', 'main'))
        command = run.call_args.args[0]
        self.assertEqual(command[-1], "'/a path/zellij' attach --existing-only main")
        self.assertNotIn('--create', command[-1])
        self.assertNotIn('write text', command[-2])

    def test_already_connected_does_not_open_duplicate(self):
        with patch.object(recovery, 'run_cli', return_value='[{"is_plugin":false,"exited":false}]'), \
                patch.object(recovery, 'clients', return_value={'1'}), \
                patch.object(recovery.subprocess, 'run') as run:
            self.assertIn('already', recovery.recover('/bin/zellij', 'main'))
            run.assert_not_called()

    def test_handoff_restores_terminal_even_if_browser_is_connected(self):
        with patch.object(recovery, 'run_cli', return_value='[{"is_plugin":false,"exited":false}]'), \
                patch.object(recovery, 'clients', side_effect=[{'1'}, {'1'}, {'1', '2'}]), \
                patch.object(recovery.time, 'sleep') as sleep, \
                patch.object(recovery.subprocess, 'run') as run:
            self.assertIn('Recovered', recovery.recover('/bin/zellij', 'main', open_window=True))
            run.assert_called_once()
            sleep.assert_called_once()

    def test_missing_session_is_not_created(self):
        with patch.object(recovery, 'run_cli', side_effect=subprocess.CalledProcessError(1, 'zellij')), \
                patch.object(recovery.time, 'monotonic', side_effect=[0, 2]), \
                patch.object(recovery.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'no session was created'):
                recovery.recover('/bin/zellij', 'main', wait=1)
            run.assert_not_called()

    def test_open_window_without_client_is_failure(self):
        with patch.object(recovery, 'run_cli', return_value='[{"is_plugin":false,"exited":false}]'), \
                patch.object(recovery, 'clients', return_value=set()), \
                patch.object(recovery.time, 'monotonic', side_effect=[0, 2]), \
                patch.object(recovery.subprocess, 'run'):
            with self.assertRaisesRegex(RuntimeError, 'no attached client'):
                recovery.recover('/bin/zellij', 'main', wait=1)


if __name__ == '__main__':
    unittest.main()
