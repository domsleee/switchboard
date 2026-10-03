import json
import unittest
from unittest.mock import AsyncMock

from aiohttp import web
from close import close_target
from control import EscapeControl


class CloseTests(unittest.IsolatedAsyncioTestCase):
    async def test_closes_stable_tab_for_clicked_pane_without_focus_and_rejects_missing_targets(self):
        class Response:
            status = 200
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def json(self): return {"sessions": [{"name": "main", "web_clients_allowed": True}]}
        host = type("Host", (), {"config": {"url": "http://localhost:8082"},
                                "request": AsyncMock(return_value=Response())})()
        control = EscapeControl(host)
        panes = [{"id": 7, "is_plugin": True, "tab_id": 90},
                 {"id": 7, "is_plugin": False, "tab_id": 42}]
        control._run_local = AsyncMock(side_effect=[json.dumps(panes), b""])
        await close_target(control, "main", 7, False)
        self.assertEqual(control._run_local.call_args_list[1].args,
                         ("main", "close-tab", "--tab-id", "42"))
        control._run_local = AsyncMock(return_value="[]")
        with self.assertRaises(web.HTTPConflict): await close_target(control, "main", 7, False)
        self.assertEqual(control._run_local.await_count, 1)
        with self.assertRaises(web.HTTPBadRequest): await close_target(control, "main", 7, 0)
        with self.assertRaises(web.HTTPNotFound): await close_target(control, "missing", 7, False)

        # Windows resolves the same pane type and closes its stable tab ID in one command.
        control.transport = "windows"
        control.terminal = control.control = type("Socket", (), {"closed": False})()
        control._command = AsyncMock()
        await close_target(control, "main", 7, False)
        script = control._command.call_args.args[0]
        self.assertIn("$_.id -eq 7 -and $_.is_plugin -eq $false", script)
        self.assertIn("close-tab --tab-id $found[0].tab_id", script)
        self.assertNotIn("go-to-tab", script)


if __name__ == "__main__": unittest.main()
