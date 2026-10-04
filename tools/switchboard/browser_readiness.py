"""Read-only browser prerequisites check, not a terminal input/output acceptance test."""
import argparse
import json
from pathlib import Path
import subprocess
import time
from urllib.parse import quote

from recover_local import run_cli


class NotReady(RuntimeError):
    pass


def pane_identities(panes):
    if not isinstance(panes, list) or not panes:
        raise NotReady('Session has no panes')
    identities = set()
    for pane in panes:
        if not isinstance(pane, dict) or type(pane.get('id')) is not int or \
                type(pane.get('tab_id')) is not int or type(pane.get('is_plugin')) is not bool:
            raise NotReady('Session returned malformed pane identities')
        identity = (pane['id'], pane['is_plugin'], pane['tab_id'])
        if identity in identities:
            raise NotReady('Session returned duplicate pane identities')
        identities.add(identity)
    return identities


def check_catalog(catalog, session):
    if not isinstance(catalog, dict) or catalog.get('error'):
        raise NotReady('Relay cannot query the native session catalog')
    sessions = catalog.get('sessions')
    if not isinstance(sessions, list):
        raise NotReady('Relay returned a malformed session catalog')
    matches = [row for row in sessions if isinstance(row, dict) and row.get('name') == session]
    if len(matches) != 1:
        raise NotReady('Existing session is missing from the browser catalog')
    if matches[0].get('web_clients_allowed') is not True:
        raise NotReady('Existing session has web sharing disabled')


def read_catalog(base_url, host, timeout):
    # curl uses the machine's certificate trust store on macOS. Python's bundled
    # OpenSSL store does not necessarily trust Portless's locally installed CA.
    # Keep TLS verification enabled and do not expose any host tokens.
    url = base_url.rstrip('/') + '/api/hosts/' + quote(host, safe='')
    response = subprocess.run(['curl', '--silent', '--show-error', '--fail',
                               '--max-time', str(timeout), '--', url],
                              capture_output=True, text=True, timeout=timeout + 1, check=True)
    return json.loads(response.stdout)


def wait_for_browser_prerequisites(binary, session, base_url, host, wait=30, baseline=None):
    """Never attach, create, restart, send input, or modify sharing settings."""
    expected = pane_identities(baseline) if baseline is not None else None
    deadline = time.monotonic() + wait
    last_error = 'No probe completed'
    while True:
        try:
            remaining = max(.1, deadline - time.monotonic())
            check_catalog(read_catalog(base_url, host, min(5, remaining)), session)
            panes = json.loads(run_cli(binary, session, 'list-panes', '--json', '--all'))
            identities = pane_identities(panes)
            if expected is not None and identities != expected:
                raise NotReady('Existing pane or tab identities changed')
            terminals = [pane for pane in panes if not pane['is_plugin']]
            if not terminals or any(pane.get('exited') is not False for pane in terminals):
                raise NotReady('Existing terminal panes are missing, exited, or invalid')
            return {'status': 'browser_prerequisites_ready', 'session': session,
                    'terminal_panes': len(terminals), 'browser_input_output_verified': False,
                    'pane_identity_preservation_verified': expected is not None,
                    'process_preservation_verified': False}
        except (OSError, ValueError, subprocess.SubprocessError, NotReady) as error:
            last_error = str(error)
        if time.monotonic() >= deadline:
            raise NotReady('Browser recovery incomplete: ' + last_error)
        time.sleep(min(.5, max(0, deadline - time.monotonic())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=Path.home() / '.cargo/bin/zellij')
    parser.add_argument('--session', default='main')
    parser.add_argument('--url', default='https://switchboard.localhost')
    parser.add_argument('--host', default='mac')
    parser.add_argument('--wait', type=float, default=30)
    parser.add_argument('--baseline', type=Path, help='Pre-update list-panes JSON to compare identities')
    args = parser.parse_args()
    if args.wait <= 0 or not args.session or args.session.startswith('-') or \
            any(ord(c) < 32 for c in args.session):
        parser.error('Use a positive wait and a nonempty session name without control characters.')
    try:
        baseline = json.loads(args.baseline.read_text()) if args.baseline else None
        print(json.dumps(wait_for_browser_prerequisites(
            args.binary, args.session, args.url, args.host, args.wait, baseline)))
    except (OSError, ValueError, NotReady) as error:
        raise SystemExit(str(error)) from error


if __name__ == '__main__':
    main()
