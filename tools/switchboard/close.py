"""Close the clicked tab by its stable native ID, without changing focus."""
import json

from aiohttp import web
from control import EscapeControl, _ps_literal, validate_target


async def close_target(control, session, pane_id, is_plugin):
    validate_target(session, pane_id)
    if type(is_plugin) is not bool:
        raise web.HTTPBadRequest(text="Invalid pane type")
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
                matches = [p for p in panes if p["id"] == pane_id and p["is_plugin"] is is_plugin]
                tab_id = matches[0]["tab_id"] if len(matches) == 1 else None
            except (ValueError, KeyError, TypeError):
                raise web.HTTPBadGateway(text="Cannot identify target tab") from None
            if type(tab_id) is not int or tab_id < 0:
                raise web.HTTPConflict(text="That tab is no longer available")
            await control._run_local(session, "close-tab", "--tab-id", str(tab_id))
        elif control.transport == "windows":
            try:
                if (not control.terminal or control.terminal.closed or not control.control
                        or control.control.closed or any(task.done() for task in control.tasks)):
                    await control._discard()
                    await control._open()
                target = f"& zellij -s {_ps_literal(session)} action "
                plugin = "$true" if is_plugin else "$false"
                await control._command(
                    "$panes = " + target + "list-panes --json --all; "
                    "if ($LASTEXITCODE -ne 0) { throw 'Cannot list target panes' }; "
                    "$panes = ($panes -join [Environment]::NewLine) | ConvertFrom-Json; "
                    f"$found = @($panes | Where-Object {{ $_.id -eq {pane_id} -and $_.is_plugin -eq {plugin} }}); "
                    "if ($found.Count -ne 1 -or $null -eq $found[0].tab_id) { $code = 4 } else { "
                    + target + "close-tab --tab-id $found[0].tab_id; "
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
        raise web.HTTPBadRequest(text="Close requires JSON session, pane_id and is_plugin") from None
    if not isinstance(payload, dict) or set(payload) != {"session", "pane_id", "is_plugin"}:
        raise web.HTTPBadRequest(text="Close requires only session, pane_id and is_plugin")
    if not hasattr(host, "escape_control"):
        host.escape_control = EscapeControl(host)
    await close_target(host.escape_control, **payload)
    return web.json_response({"ok": True})
