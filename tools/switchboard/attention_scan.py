"""Read agent state from native pane snapshots; no input or focus changes."""
import base64
import hashlib
import json
import re
import subprocess
import sys
import time


def classify(pane, screen):
    # ponytail: UI markers, not a public status API; update with agent UI releases.
    tail = screen[-8000:]
    command, title = pane.get('pane_command') or '', pane.get('title') or ''
    codex = bool(re.search(r'\bcodex(?:\.(?:cmd|exe))?\b', command, re.I) or re.match(r'^codex\s*[-:]', title, re.I)
                 or re.search(r'GPT-[\w.-]+', tail, re.I) and re.search(r'for shortcuts|tab to queue message', tail, re.I))
    claude = bool(re.search(r'\bclaude(?:\.exe)?\b', command, re.I)
                  or re.search(r'(?:bypass permissions|accept edits) on|shift\+tab to cycle', tail, re.I))
    if not (codex or claude):
        return {'state': 'unknown'}
    agent = 'codex' if codex else 'claude'
    prompts = list(re.finditer(r'[›❯](?:[ \t\u00a0]|(?=\r?\n|$))', tail))
    prompt = prompts[-1] if prompts else None
    before, after = (tail[:prompt.start()], tail[prompt.end():]) if prompt else (tail, '')
    completion_pattern = r'(?:Worked for|[✻✽✶✳] [A-Za-z]+ for)\s+(?:\d+\s*[hms]\s*)+(?:[•·]\s*(?:done\s+)?\d{1,2}:\d{2}\s*(?:AM|PM)?)?'
    completions = list(re.finditer(completion_pattern, before, re.I))
    footer = (re.search(r'for shortcuts|enter to send|tab to queue message', after, re.I) if codex else
              re.search(r'(?:bypass permissions|accept edits) on|shift\+tab to cycle|for shortcuts', after, re.I))
    normal_composer = prompt and footer and not re.match(r'\s*\d+[.)]', after)
    # A normal bottom composer takes precedence over old approval text in scrollback.
    if not normal_composer:
        chooser = tail[-1800:]
        controls = re.search(r'(?:esc(?:ape)? to cancel|enter to (?:submit|select|confirm)|press enter to confirm)', chooser, re.I)
        options = re.search(r'(?:^|\s)[12][.)]\s+(?:Yes|No|Allow|Approve|Deny)', chooser, re.I)
        if controls and options:
            return {'state': 'approval', 'agent': agent, 'token': 'approval'}
        if controls and re.search(r'[❯›]\s*\d+[.)]', chooser):
            return {'state': 'input', 'agent': agent, 'token': 'question'}
    busy = list(re.finditer(r'(?:^|\n|[•✻✽✶✳])[^\n]{0,70}\([^\n]{0,160}esc(?:ape)? to interrupt[^\n]{0,60}\)', before, re.I))
    if re.match(r'^[⠁-⣿]', title) or re.search(r'tab to queue message', after, re.I) or (busy and (not completions or busy[-1].start() > completions[-1].start())):
        return {'state': 'working', 'agent': agent}
    if not normal_composer:
        return {'state': 'unknown', 'agent': agent}
    signature = re.sub(r'\s+', ' ', completions[-1].group() if completions else 'idle').strip()
    return {'state': 'ready', 'agent': agent, 'token': hashlib.sha256(signature.encode()).hexdigest()[:20]}


def run(binary, session, *action, timeout=5):
    result = subprocess.run([binary, '-s', session, 'action', *action], capture_output=True,
                            timeout=timeout, encoding='utf-8', errors='replace')
    if result.returncode:
        raise RuntimeError('Zellij snapshot unavailable')
    return result.stdout


def scan_sessions(names, binary='zellij', offset=0):
    records = []
    deadline=time.monotonic()+8
    for name in names:
        try:
            panes=json.loads(run(binary, name, 'list-panes', '--json', '--all'))
        except (RuntimeError, subprocess.TimeoutExpired, ValueError):
            continue
        ordered=panes[offset%len(panes):]+panes[:offset%len(panes)] if panes else []
        for pane in ordered:
            if pane.get('is_plugin') or not pane.get('is_selectable', True):
                continue
            status = {'state': 'unknown','deferred':time.monotonic()>=deadline}
            command,title=pane.get('pane_command') or '',pane.get('title') or ''
            shell = re.search(r'(?:^|[\\/])(?:nu|zsh|bash|fish|pwsh|powershell)(?:\.exe)?(?:\s|$)',command,re.I) and re.match(r'^(~|/|[A-Za-z]:[\\/])',title)
            if not shell and not pane.get('exited') and not pane.get('is_held') and time.monotonic()<deadline:
                try:
                    status = classify(pane, run(binary, name, 'dump-screen', '-p', str(pane['id']), timeout=max(.1,min(3,deadline-time.monotonic()))))
                except (RuntimeError, subprocess.TimeoutExpired):
                    status = {'state':'unknown','error':'Pane snapshot unavailable'}
            records.append({'session': name, 'pane_id': pane['id'], 'tab_id': pane['tab_id'], **status})
    return records


if __name__ == '__main__':
    print(json.dumps(scan_sessions(json.loads(base64.b64decode(sys.argv[1])), sys.argv[2] if len(sys.argv)>2 else 'zellij',int(sys.argv[3]) if len(sys.argv)>3 else 0)))
