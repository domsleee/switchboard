"""Opt-in native Codex queue check: private PTY, home, and fake Responses server.

SWITCHBOARD_TEST_CODEX=/path/to/codex python3 tools/switchboard/codex-message-wake.test.py
No real model, credentials, terminal sessions or installed configuration are used.
"""
import json
import os
import pathlib
import select
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@unittest.skipUnless(os.name == "posix" and os.environ.get("SWITCHBOARD_TEST_CODEX"),
                     "Set SWITCHBOARD_TEST_CODEX on a Unix host for the private PTY check")
class CodexWake(unittest.TestCase):
    def test_queue_wakes_an_idle_session_without_daemon(self):
        import fcntl
        import pty
        import struct
        import termios

        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if self.headers.get("Content-Encoding") == "zstd":
                    # The installed CLI can compress requests; use the system tool.
                    body = subprocess.run(["zstd", "-d", "-q", "-c"], input=body,
                                          capture_output=True, check=True).stdout
                requests.append(json.loads(body))
                number = len(requests)
                message = {"id": f"msg_{number}", "type": "message", "role": "assistant",
                           "status": "completed", "content": [{"type": "output_text",
                           "text": f"Fixture reply {number}", "annotations": []}]}
                response = {"id": f"resp_{number}", "object": "response", "status": "completed",
                            "model": "fixture", "output": [message],
                            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}}
                events = [
                    {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                    {"type": "response.output_item.added", "output_index": 0,
                     "item": {**message, "status": "in_progress", "content": []}},
                    {"type": "response.output_text.delta", "item_id": message["id"],
                     "output_index": 0, "content_index": 0, "delta": f"Fixture reply {number}"},
                    {"type": "response.output_item.done", "output_index": 0, "item": message},
                    {"type": "response.completed", "response": response},
                ]
                data = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        with tempfile.TemporaryDirectory(prefix="switchboard-codex-wake-") as directory:
            root = pathlib.Path(directory)
            codex_home = root / "codex"
            codex_home.mkdir()
            capture = root / "capture.py"
            capture.write_text("import json, pathlib, sys\ne=json.load(sys.stdin)\n"
                               f"pathlib.Path({str(root / 'session.json')!r}).write_text(json.dumps(e))\n")
            (codex_home / "hooks.json").write_text(json.dumps({"hooks": {"SessionStart": [{"hooks": [{
                "type": "command", "command": f"{shutil.which('python3')} {capture}"}]}]}}))
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            environment = {**os.environ, "CODEX_HOME": str(codex_home),
                           "SWITCHBOARD_FIXTURE_KEY": "local-fixture-only", "TERM": "xterm-256color"}
            for key in ("OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_THREAD_ID"):
                environment.pop(key, None)
            binary = os.environ["SWITCHBOARD_TEST_CODEX"]
            command = [binary, "--no-daemon", "--no-alt-screen", "--dangerously-bypass-hook-trust",
                       "-c", 'model_provider="fixture"', "-c", 'model="fixture"',
                       "-c", 'model_providers.fixture.name="Fixture"',
                       "-c", f'model_providers.fixture.base_url="http://127.0.0.1:{server.server_port}/v1"',
                       "-c", 'model_providers.fixture.wire_api="responses"',
                       "-c", 'model_providers.fixture.env_key="SWITCHBOARD_FIXTURE_KEY"',
                       "-c", 'model_providers.fixture.requires_openai_auth=false',
                       "-c", 'model_providers.fixture.supports_websockets=false',
                       "-c", 'check_for_update_on_startup=false',
                       "-c", 'tui.screen_reader_detection_done=true',
                       "-c", f'projects."{root}".trust_level="trusted"',
                       "Fixture initial prompt"]
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            process = subprocess.Popen(command, cwd=root, env=environment,
                                       stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            terminal = bytearray()

            def wait_for(predicate, description):
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    if predicate():
                        return
                    if process.poll() is not None:
                        self.fail(f"Codex exited waiting for {description}: {terminal.decode(errors='replace')[-5000:]}")
                    if select.select([master], [], [], .1)[0]:
                        try:
                            data = os.read(master, 65536)
                            terminal.extend(data)
                            # Answer terminal capability probes without a visible terminal.
                            if b"\x1b[6n" in data:
                                os.write(master, b"\x1b[1;1R")
                            if b"\x1b[c" in data:
                                os.write(master, b"\x1b[?1;2c")
                        except OSError:
                            pass
                self.fail(f"Timed out waiting for {description}: {terminal.decode(errors='replace')[-5000:]}")

            try:
                wait_for(lambda: requests and b"Fixture reply 1" in terminal, "first completed reply")
                session = json.loads((root / "session.json").read_text())["session_id"]
                # Let the CLI enter idle before sending a separate process's message.
                time.sleep(.5)
                queued = subprocess.run([binary, "queue", "--thread", session, "--message", "SWITCHBOARD_WAKE_FIXTURE"],
                                        cwd=root, env=environment, capture_output=True, timeout=10)
                self.assertEqual(queued.returncode, 0, queued.stderr.decode())
                wait_for(lambda: any("SWITCHBOARD_WAKE_FIXTURE" in json.dumps(r.get("input", [])) for r in requests),
                         "queued message to wake idle Codex")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                os.close(master)
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
