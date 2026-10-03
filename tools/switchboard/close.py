"""Close the clicked tab by its stable native ID, without changing focus."""
import json

from aiohttp import web
from control import _ps_literal, validate_target


async def close_target(control, session, tab_id):
    validate_target(session, 0)
    if type(tab_id) is not int or not 0 <= tab_id <= 0xFFFFFFFF:
        raise web.HTTPBadRequest(text="Invalid native tab ID")
    async with control.lock:
        if control.closed:
            raise web.HTTPServiceUnavailable(text="Tab control is shutting down")
        async with await control.host.request("GET", "/session-list") as response:
            if response.status != 200:
                raise web.HTTPBadGateway(text="Cannot validate tab session")
            sessions = (await response.json())["sessions"]
        if not any(s["name"] == session and s.get("web_clients_allowed") for s in sessions):
            raise web.HTTPNotFound(text="Tab session is unavailable")
        if control.transport == "local":
            try:
                panes = json.loads(await control._run_local(session, "list-panes", "--json", "--all"))
                available = any(p["tab_id"] == tab_id for p in panes)
            except (ValueError, KeyError, TypeError):
                raise web.HTTPBadGateway(text="Cannot identify target tab") from None
            if not available:
                raise web.HTTPConflict(text="That tab is no longer available")
            await control._run_local(session, "close-tab", "--tab-id", str(tab_id))
        elif control.transport == "windows":
            try:
                if (not control.terminal or control.terminal.closed or not control.control
                        or control.control.closed or any(task.done() for task in control.tasks)):
                    await control._discard()
                    await control._open()
                target = f"& zellij -s {_ps_literal(session)} action "
                await control._command(
                    "$panes = " + target + "list-panes --json --all; "
                    "if ($LASTEXITCODE -ne 0) { throw 'Cannot list target panes' }; "
                    "$panes = ($panes -join [Environment]::NewLine) | ConvertFrom-Json; "
                    f"$found = @($panes | Where-Object {{ $_.tab_id -eq {tab_id} }}); "
                    "if ($found.Count -eq 0) { $code = 4 } else { "
                    + target + f"close-tab --tab-id {tab_id}; "
                    "$code = $LASTEXITCODE; if ($null -eq $code) { $code = 1 } }"
                )
            except BaseException:
                await control._discard()
                raise
        else:
            raise web.HTTPNotImplemented(text="Unsupported tab control transport")


async def close_tab(request):
    host = request.app["hosts"].get(request.match_info["host"])
    if host is None:
        raise web.HTTPNotFound()
    try:
        payload = await request.json()
    except (ValueError, UnicodeDecodeError):
        raise web.HTTPBadRequest(text="Close requires JSON session and tab_id") from None
    if not isinstance(payload, dict) or set(payload) != {"session", "tab_id"}:
        raise web.HTTPBadRequest(text="Close requires only session and tab_id")
    await close_target(host.escape_control, **payload)
    return web.json_response({"ok": True})
