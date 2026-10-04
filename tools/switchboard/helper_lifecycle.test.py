"""Windows native regression: helpers exit on disconnect; user sessions survive.

Run: uv run --with aiohttp python tools/switchboard/helper_lifecycle.test.py BINARY
Uses a private socket directory, unique token, and hidden test server.
"""
import asyncio
import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import uuid

import aiohttp


async def wait_for(check, message):
    for _ in range(150):
        result = check()
        if result:
            return result
        await asyncio.sleep(0.1)
    raise AssertionError(message)


async def main():
    assert os.name == "nt", "This regression exercises Windows session processes"
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    binary = str(Path(sys.argv[1]).resolve())
    handles = []
    with tempfile.TemporaryDirectory(prefix="switchboard-helpers-") as directory:
        root = Path(directory)
        config = root / "config.kdl"
        config.write_text('web_sharing "on"\nweb_server false\n'
                          'default_shell "powershell.exe"\n'
                          'session_serialization false\nshow_startup_tips false\n')
        env = {key: value for key, value in os.environ.items()
               if not key.startswith("ZELLIJ")}
        env.update(ZELLIJ_SOCKET_DIR=str(root / "sockets"),
                   ZELLIJ_CONFIG_FILE=str(config))
        def cli(*args):
            return subprocess.check_output([binary, "--config", str(config), *args],
                                           env=env, timeout=15, text=True,
                                           creationflags=subprocess.CREATE_NO_WINDOW)
        token_line = next(line for line in cli("web", "--create-token").splitlines() if ": " in line)
        token_name, token = token_line.split(": ", 1)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        server = subprocess.Popen([binary, "--config", str(config), "web", "--start",
                                   "--ip", "127.0.0.1", "--port", str(port)],
                                  env=env, startupinfo=startup,
                                  creationflags=subprocess.CREATE_NEW_CONSOLE)
        base = f"http://127.0.0.1:{port}"
        try:
            async with aiohttp.ClientSession(cookie_jar=aiohttp.CookieJar(unsafe=True)) as client:
                for attempt in range(100):
                    try:
                        async with client.post(base + "/command/login", json={
                            "auth_token": token, "remember_me": False
                        }) as response:
                            assert response.status == 200
                        break
                    except aiohttp.ClientConnectorError:
                        if attempt == 99:
                            raise
                        await asyncio.sleep(0.1)

                async def attach(name):
                    async with client.post(base + "/session", params={
                        "session": name, "welcome": "false"
                    }) as response:
                        boot = await response.json()
                    ws = await client.ws_connect(base + f"/ws/terminal/{name}", params={
                        "web_client_id": boot["web_client_id"], "rows": 24, "cols": 80
                    })
                    return ws

                async def process(name):
                    marker = root / "sockets" / "contract_version_1" / name
                    await wait_for(marker.exists, "Session process did not start")
                    pid = int(marker.read_text())
                    handle = kernel.OpenProcess(0x100001, False, pid)  # wait + terminate
                    assert handle, "Cannot track test session process"
                    handles.append(handle)
                    return handle

                for abrupt in (False, True):
                    name = "__switchboard_control_" + uuid.uuid4().hex
                    ws = await attach(name)
                    handle = await process(name)
                    # No control socket or ready-pane handshake: exercise failed startup.
                    if abrupt:
                        ws._response.connection.transport.abort()
                    else:
                        await ws.close()
                    await wait_for(lambda: kernel.WaitForSingleObject(handle, 0) == 0,
                                   f"Helper survived {'abrupt' if abrupt else 'normal'} disconnect")
                    print("PASS helper exits after", "abrupt disconnect" if abrupt else "failed startup")

                name = "__switchboard_control_" + uuid.uuid4().hex
                first = await attach(name)
                handle = await process(name)
                await asyncio.wait_for(first.receive(), 10)
                second = await attach(name)
                await asyncio.wait_for(second.receive(), 10)
                await first.close()
                await asyncio.sleep(0.3)
                assert kernel.WaitForSingleObject(handle, 0) == 258, "Helper still has an attached client"
                await second.close()
                await wait_for(lambda: kernel.WaitForSingleObject(handle, 0) == 0,
                               "Helper survived its last client")
                print("PASS helper waits for its last client to disconnect")

                # Existing acceptance fixtures share the prefix but are persistent sessions.
                name = "__switchboard_control_fixture_" + uuid.uuid4().hex
                ws = await attach(name)
                handle = await process(name)
                await ws.close()
                await asyncio.sleep(1)
                assert kernel.WaitForSingleObject(handle, 0) == 258, "User session was terminated"
                print("PASS ordinary session survives disconnect")

                # Reproduce a CLI killed between connecting the input/reply pipes.
                pipe = kernel.CreateFileW("\\\\.\\pipe\\" + str(root / "sockets" / "contract_version_1" / name),
                                          0xC0000000, 0, None, 3, 0, None)
                assert pipe != wintypes.HANDLE(-1).value, "Cannot open test input pipe"
                await asyncio.sleep(0.2)
                kernel.CloseHandle(pipe)
                await asyncio.sleep(5.5)
                ws = await attach(name)
                message = await asyncio.wait_for(ws.receive(), 10)
                assert message.type in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY), message
                await ws.close()
                assert kernel.WaitForSingleObject(handle, 0) == 258
                print("PASS incomplete IPC connection does not strand the user session")

                helper = "__switchboard_control_" + uuid.uuid4().hex
                ws = await attach(helper)
                helper_handle = await process(helper)
                await asyncio.wait_for(ws.receive(), 10)
                server.terminate()
                server.wait(timeout=10)
                await wait_for(lambda: kernel.WaitForSingleObject(helper_handle, 0) == 0,
                               "Helper survived web server termination")
                assert kernel.WaitForSingleObject(handle, 0) == 258
                print("PASS web server termination reaps helpers and preserves user sessions")
        finally:
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=10)
            for handle in handles:
                if kernel.WaitForSingleObject(handle, 0) == 258:
                    kernel.TerminateProcess(handle, 1)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)
            cli("web", "--revoke-token", token_name)


asyncio.run(main())
