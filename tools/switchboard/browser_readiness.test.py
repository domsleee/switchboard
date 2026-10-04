import unittest
from unittest.mock import patch
from urllib.error import HTTPError

import browser_readiness as readiness


SHARED = {'sessions': [{'name': 'main', 'web_clients_allowed': True}]}
PANES = [{'id': 7, 'is_plugin': False, 'tab_id': 42, 'exited': False}]


class BrowserReadinessTests(unittest.TestCase):
    def probe(self, catalog=SHARED, panes=PANES, baseline=None):
        import json
        with patch.object(readiness, 'read_catalog', return_value=catalog), \
                patch.object(readiness, 'run_cli', return_value=json.dumps(panes)), \
                patch.object(readiness.time, 'monotonic', side_effect=[0, 0, 2]):
            return readiness.wait_for_browser_prerequisites('/bin/zellij', 'main',
                                                           'https://switchboard.localhost', 'mac',
                                                           wait=1, baseline=baseline)

    def test_http_success_is_not_browser_recovery(self):
        for catalog in ({'error': 'Unavailable'}, {'sessions': []},
                        {'sessions': [{'name': 'main', 'web_clients_allowed': False}]},
                        {'sessions': [{'name': 'main', 'web_clients_allowed': 1}]}):
            with self.subTest(catalog=catalog), self.assertRaisesRegex(readiness.NotReady, 'incomplete'):
                self.probe(catalog)

    def test_running_terminals_required(self):
        for panes in ([], [{**PANES[0], 'exited': True}], [{**PANES[0], 'is_plugin': True}],
                      [{**PANES[0], 'tab_id': None}], [PANES[0], PANES[0]]):
            with self.subTest(panes=panes), self.assertRaises(readiness.NotReady):
                self.probe(panes=panes)

    def test_changed_identity_is_partial_recovery(self):
        with self.assertRaisesRegex(readiness.NotReady, 'identities changed'):
            self.probe(panes=[{**PANES[0], 'id': 8}], baseline=PANES)

    def test_tab_position_is_not_identity(self):
        result = self.probe(panes=[{**PANES[0], 'tab_position': 2}], baseline=PANES)
        self.assertTrue(result['pane_identity_preservation_verified'])
        self.assertFalse(result['process_preservation_verified'])
        self.assertFalse(result['browser_input_output_verified'])
        self.assertEqual(result['status'], 'browser_prerequisites_ready')

    def test_transient_gateway_error_retries_without_attaching(self):
        import json
        with patch.object(readiness, 'read_catalog', side_effect=[
                HTTPError('https://switchboard.localhost', 502, 'starting', {}, None), SHARED]), \
                patch.object(readiness, 'run_cli', return_value=json.dumps(PANES)) as cli, \
                patch.object(readiness.time, 'sleep') as sleep:
            result = readiness.wait_for_browser_prerequisites('/bin/zellij', 'main',
                                                             'https://switchboard.localhost', 'mac')
        self.assertEqual(result['terminal_panes'], 1)
        self.assertFalse(result['pane_identity_preservation_verified'])
        cli.assert_called_once_with('/bin/zellij', 'main', 'list-panes', '--json', '--all')
        sleep.assert_called_once()


if __name__ == '__main__':
    unittest.main()
