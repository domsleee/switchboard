import json
import unittest
from unittest.mock import AsyncMock

from aiohttp import web
from close import close_target
from control import EscapeControl


class CloseTests(unittest.IsolatedAsyncioTestCase):
    async def test_closes_confirmed_tab_even_after_its_pane_moves_elsewhere(self):
        class Response:
            status = 200
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def json(self): return {"sessions": [{"name": "main", "web_clients_allowed": True}]}
        host = type("Host", (), {"config": {"url": "http://localhost:8082"},
                                "request": AsyncMock(return_value=Response())})()
        control = EscapeControl(host)
        # Pane 7 moved from the confirmed tab 42 into tab 90 while its dialog
        # was open. Another pane keeps the original tab alive.
        panes = [{"id": 7, "is_plugin": False, "tab_id": 90},
                 {"id": 8, "is_plugin": False, "tab_id": 42}]
        control._run_local = AsyncMock(side_effect=[json.dumps(panes), b""])
        await close_target(control, "main", 42)
        self.assertEqual(control._run_local.call_args_list[1].args,
                         ("main", "close-tab", "--tab-id", "42"))
        # If that original tab disappeared, do not follow its old pane to 90.
        control._run_local = AsyncMock(return_value=json.dumps(panes[:1]))
        with self.assertRaises(web.HTTPConflict): await close_target(control, "main", 42)
        self.assertEqual(control._run_local.await_count, 1)
        for invalid in (True, False, -1, 2**32, "42", None):
            with self.subTest(tab_id=invalid):
                with self.assertRaises(web.HTTPBadRequest): await close_target(control, "main", invalid)
        with self.assertRaises(web.HTTPNotFound): await close_target(control, "missing", 42)

        # Windows must also keep the confirmed ID instead of resolving a pane.
        control.transport = "windows"
        control.terminal = control.control = type("Socket", (), {"closed": False})()
        control._command = AsyncMock()
        await close_target(control, "main", 42)
        script = control._command.call_args.args[0]
        self.assertIn("$_.tab_id -eq 42", script)
        self.assertIn("close-tab --tab-id 42", script)
        self.assertNotIn("$found[0].tab_id", script)
        self.assertNotIn("go-to-tab", script)


if __name__ == "__main__": unittest.main()
