"""Poll native pane snapshots on each authenticated host, including background tabs."""
import asyncio
import base64
import json
from pathlib import Path
import re
import uuid
import time

from aiohttp import web
from attention_scan import scan_sessions
from control import CONTROL_SESSION_PREFIX, _ANSI, _ps_literal


async def scan_host(host):
    async with await host.request('GET', '/session-list') as response:
        if response.status != 200:
            raise RuntimeError('Cannot list attention sessions')
        names = [s['name'] for s in (await response.json())['sessions']
                 if s.get('web_clients_allowed') and not s['name'].startswith(CONTROL_SESSION_PREFIX)]
    control = host.escape_control
    offset=getattr(host,'attention_offset',0);host.attention_offset=offset+1
    if control.transport == 'local':
        return await asyncio.to_thread(scan_sessions, names, control.binary,offset)
    if control.transport != 'windows':
        raise RuntimeError('Unsupported attention transport')
    async with control.lock:
        if (not control.terminal or control.terminal.closed or not control.control
                or control.control.closed or any(task.done() for task in control.tasks)):
            await control._discard()
            await control._open()
            control.attention_installed = False
        try:
            install = ''
            if not getattr(control, 'attention_installed', False):
                source = base64.b64encode(Path(__file__).with_name('attention_scan.py').read_bytes()).decode()
                install = ("$dir=Join-Path $HOME '.config/zellij'; [IO.Directory]::CreateDirectory($dir) | Out-Null; "
                           "$scanner=Join-Path $dir 'switchboard-attention-scan.py'; "
                           f"[IO.File]::WriteAllBytes($scanner,[Convert]::FromBase64String('{source}')); ")
            marker = '__SB_DATA_' + uuid.uuid4().hex
            args = _ps_literal(base64.b64encode(json.dumps(names).encode()).decode())
            script = install + ("$scanner=Join-Path $HOME '.config/zellij/switchboard-attention-scan.py'; "
                                f"$json=(& python $scanner {args} zellij {offset} | Out-String); "
                                "if($LASTEXITCODE -ne 0){throw 'Attention scanner failed'}; "
                                f"[Console]::WriteLine('{marker}:'+ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) + ':DATAEND'); $code=0")
            await control._command(script)
            match = re.search(re.escape(marker) + r':([A-Za-z0-9+/=\s]+):DATAEND', _ANSI.sub('', control.output))
            if not match:
                raise RuntimeError('Attention response missing')
            control.attention_installed = True
            return json.loads(base64.b64decode(match[1]))
        except BaseException:
            await control._discard()
            raise


async def lifecycle(app):
    app['attention'] = {'panes': [], 'tabs': [], 'errors': []}
    cache,observed = {},{}
    state_file = app.get('attention_state_file')
    if state_file:
        state_file = Path(state_file).expanduser()
        try:
            stored = json.loads(state_file.read_text())
            for key, row in (stored.items() if isinstance(stored, dict) else []):
                identity = tuple(json.loads(key))
                if len(identity) == 3 and isinstance(row, dict) and type(row.get('generation')) is int:
                    observed[identity] = row
        except (OSError, ValueError, TypeError):
            pass
    def remember():
        if not state_file:
            return
        state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = state_file.with_suffix(state_file.suffix + '.tmp')
        temporary.write_text(json.dumps({json.dumps(key): {field: row[field] for field in ('state', 'generation', 'token') if field in row}
                                         for key, row in observed.items()}))
        temporary.replace(state_file)
    async def poll(host):
        host_id = host.config['id']
        while True:
            try:
                snapshot = await scan_host(host)
                rows = snapshot['panes']
                changed = False
                for row in rows:
                    key=(host_id,row['session'],row['pane_id'])
                    previous=observed.get(key,{})
                    if row.pop('deferred',False) and time.monotonic()-previous.get('scanned_at',0)<30:
                        row.update({k:v for k,v in previous.items() if k not in {'generation','scanned_at'}})
                    else:row['scanned_at']=time.monotonic()
                    generation=previous.get('generation',0)
                    if row['state']=='ready' and previous.get('state')=='working':generation+=1
                    if row['state']!='unknown':
                        changed |= any(previous.get(field) != row.get(field) for field in ('state', 'token')) or previous.get('generation') != generation
                        observed[key]={**row,'generation':generation,'scanned_at':row.get('scanned_at',previous.get('scanned_at',0))}
                    row.pop('scanned_at',None)
                    if row['state']=='ready':row['token']=f"{row['token']}:{generation}"
                if changed:
                    try:
                        remember()
                    except OSError:
                        pass
                cache[host_id] = {'panes': [dict(row, host=host_id) for row in rows],
                                  'tabs': [dict(tab, host=host_id) for tab in snapshot['tabs']], 'errors': []}
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # Disconnected hosts must not retain a stale ready state.
                cache[host_id] = {'panes': [], 'tabs': [], 'errors': [{'host': host_id, 'message': str(error)}]}
            app['attention'] = {key: [row for data in cache.values() for row in data[key]] for key in ('panes', 'tabs', 'errors')}
            await asyncio.sleep(3)
    tasks = [asyncio.create_task(poll(host)) for host in app['hosts'].values()]
    yield
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def attention(request):
    return web.json_response(request.app['attention'])
