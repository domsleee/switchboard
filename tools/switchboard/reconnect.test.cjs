// In-place socket recovery. No real relay or user terminals are accessed.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const read = name => fs.readFileSync(__dirname + '/../../zellij-client/assets/' + name, 'utf8');
const source = name => read(name).replace(/^import[\s\S]*?from ["'][^"']+["'];\s*/gm, '').replace(/^export /gm, '');

function fixture() {
  let now = 1000, serial = 0, signalSerial = 0;
  const timers = new Map(), sockets = [], nodes = [], requests = [], failures = [];
  const listeners = new Map();
  const term = { rows: 24, cols: 80, options: {}, writes: [], resize(cols, rows) { this.cols = cols; this.rows = rows; }, write(data) { this.writes.push(data); } };
  term._core = { coreService: { triggerDataEvent(data, user = false) {
    if (!term.options.disableStdin) client.sendAnsiKey(data);
  } } };
  const fit = { proposeDimensions: () => ({ rows: 24, cols: 80 }) };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    message(data) { this.onmessage?.({ data }); }
    send(data) { assert.equal(this.readyState, 1); this.sent.push(data); }
    close() { this.readyState = 3; }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  const ctx = {
    Date: { now: () => now }, performance: { now: () => now }, AbortSignal: { timeout: () => ({ id: ++signalSerial }) }, URLSearchParams, console, crypto: require('node:crypto').webcrypto, CustomEvent,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    WebSocket: Socket, location: { pathname: '/hosts/mac/main' },
    window: { innerHeight: 800, innerWidth: 1000, addEventListener(name, fn) { listeners.set(name, fn); }, dispatchEvent(event) { if(event.type==='zellij-terminal-failed')failures.push(event.detail); } },
    document: {
      documentElement: { style: { setProperty() {} } },
      createElement() { return { style: {}, setAttribute() {}, remove() { nodes.splice(nodes.indexOf(this), 1); } }; },
      body: { appendChild(node) { nodes.push(node); } },
    },
    addEventListener() {}, requestAnimationFrame(fn) { fn(); },
    getBaseUrl: () => '/hosts/mac', getWebSocketBaseUrl: () => 'ws://fixture/hosts/mac',
    fineScrolling: () => false, isCurrentLocation: () => true,
    setSoftKeyboard() {}, terminalConfigOptions: () => ({}), applyTerminalBackground() {},
    showErrorModal: async (title) => {
      if (title === 'Terminal closed') { ctx.closedPaneNotices = (ctx.closedPaneNotices || 0) + 1; await new Promise(resolve => { ctx.acknowledgePane = resolve; }); }
      else ctx.disconnected = true;
    },
    getSecurityToken: async () => { ctx.prompts++; return { token: "replacement", remember: false }; },
    prompts: 0,
    activePane: { pane_id: 1, is_plugin: false },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (ctx.offline) throw new TypeError('offline');
      if (url.endsWith('/command/login')) { ctx.authExpired = false; return { ok: true, status: 200 }; }
      if (ctx.authExpired && (!ctx.expiredPath || url.includes(ctx.expiredPath))) return { ok: false, status: 401 };
      if (ctx.httpError) return { ok: false, status: ctx.httpError };
      if (url.endsWith('/session-list')) return { ok: true, json: async () => ({ sessions: ctx.sessions }) };
      return { ok: true, json: async () => ({ web_client_id: 'client-' + requests.length, session_name: decodeURIComponent(ctx.location.pathname.split('/').pop()) }) };
    },
    sessions: [{ name: 'main', web_clients_allowed: true }],
  };
  vm.createContext(ctx);
  ctx.hasRoom = size => size.cols > 2 && size.rows > 1;
  vm.runInContext(source('connection.js') + '\n' + source('auth.js') + '\n' + source('websockets.js') + '\nObject.assign(globalThis, {initWebSockets,initConnectionHandlers,getReconnectionDelay});', ctx);
  ctx.initConnectionHandlers();
  const client = ctx.initWebSockets({ web_client_id: 'initial', session_name: 'main' }, term, fit);
  const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; now = timer.at; timers.delete(id); timer.fn(); await flush();
    }
    now = target; await flush();
  }
  async function attach() {
    const [terminal, control] = sockets.slice(-2);
    terminal.open(); control.open(); control.message(JSON.stringify({type:'MobileState',payload:{active_pane:ctx.activePane}})); terminal.message('screen'); await flush();
  }
  return { ctx, sockets, client, term, nodes, requests, failures, listeners, advance, attach, flush };
}

test('quick retry schedule backs off after ten seconds', () => {
  const f = fixture();
  for (let n = 1; n <= 40; n++) assert.equal(f.ctx.getReconnectionDelay(n), 0.25);
  assert.deepEqual([41,42,43,44,45,46].map(f.ctx.getReconnectionDelay), [1,2,4,8,16,16]);
});

test('reconnect replaces both sockets and keeps the terminal and input closure', async () => {
  const f = fixture(); await f.attach();
  const send = f.client.sendAnsiKey;
  send('before');
  const old = f.sockets.slice();
  old[0].drop();
  assert.equal(f.ctx.window.__zjLastMobileState, undefined, 'old pane metadata cannot signal that the replacement connection is ready');
  assert.equal(old[1].readyState, 3);
  await f.advance(250);
  assert.equal(f.sockets.length, 4);
  assert.notEqual(f.client.getOwnWebClientId(), 'initial');
  await f.attach();
  send('after');
  assert.deepEqual(old[0].sent, ['before']);
  assert.deepEqual(f.sockets[2].sent, ['after']);
  assert.deepEqual(f.term.writes, ['screen', 'screen']);
  assert.equal(f.nodes.length, 0);
});

test('control loss also reconnects the pair; input waits for both sockets', async () => {
  const f = fixture(); await f.attach();
  f.sockets[1].drop(); await f.advance(250);
  f.sockets[2].open();
  f.client.sendAnsiKey('not-sent');
  assert.equal(f.nodes.length, 1, 'typing during outage explains paused input');
  assert.deepEqual(f.sockets[2].sent, []);
  await f.attach();
  assert.equal(f.nodes.length, 0);
  f.client.sendAnsiKey('once');
  assert.deepEqual(f.sockets[2].sent, ['once'], 'input from the outage is never replayed');
});

test('reconnect holds typing until the previous pane is confirmed, while protocol replies flow', async () => {
  const f = fixture(); await f.attach();
  f.sockets[0].drop(); await f.advance(250);
  const [terminal, control] = f.sockets.slice(-2);
  terminal.open(); control.open();
  f.client.sendAnsiKey('before-metadata');
  f.term._core.coreService.triggerDataEvent('\x1b[1;1R');
  assert.deepEqual(terminal.sent, ['\x1b[1;1R']);
  control.message(JSON.stringify({type:'MobileState',payload:{active_pane:{pane_id:0,is_plugin:false}}}));
  assert.equal(JSON.parse(control.sent.at(-1)).payload.pane_id, 1);
  f.client.sendAnsiKey('wrong-pane');
  assert.deepEqual(terminal.sent, ['\x1b[1;1R']);
  control.message(JSON.stringify({type:'MobileState',payload:{active_pane:f.ctx.activePane}}));
  await f.flush();
  f.client.sendAnsiKey('correct-pane');
  assert.deepEqual(terminal.sent, ['\x1b[1;1R','correct-pane']);
  assert.equal(f.nodes.length, 0);
});

test('a newer tab selection supersedes the pane being restored', async () => {
  const f = fixture(); await f.attach();
  f.sockets[1].drop(); await f.advance(250);
  const [terminal, control] = f.sockets.slice(-2);
  terminal.open(); control.open();
  f.ctx.window.__zjSendControl({type:'FocusPane',pane_id:9,is_plugin:false});
  control.message(JSON.stringify({type:'MobileState',payload:{active_pane:f.ctx.activePane}}));
  f.client.sendAnsiKey('stale-ack');
  assert.deepEqual(terminal.sent, []);
  control.message(JSON.stringify({type:'MobileState',payload:{active_pane:{pane_id:9,is_plugin:false}}}));
  f.client.sendAnsiKey('new-target');
  assert.deepEqual(terminal.sent, ['new-target']);
});

test('the badge from early typing clears when the initial connection succeeds', async () => {
  const f = fixture();
  f.client.sendAnsiKey('early'); assert.equal(f.nodes.length, 1);
  await f.attach();
  assert.equal(f.nodes.length, 0);
  f.client.sendAnsiKey('ready');
  assert.deepEqual(f.sockets[0].sent, ['ready']);
});

for (const expiredPath of ['/session-list', '/session?']) test(`expired authentication at ${expiredPath} prompts and resumes in place`, async () => {
  const f = fixture(); await f.attach();
  f.ctx.authExpired = true; f.ctx.expiredPath = expiredPath;
  f.sockets[0].drop(); await f.advance(250); await f.flush();
  assert.equal(f.ctx.prompts, 1);
  const attempts = f.requests.filter(r=>r.url.includes(expiredPath));
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].options.signal, attempts[1].options.signal, 'login does not reuse an expired request deadline');
  await f.attach();
  f.client.sendAnsiKey('after-login');
  assert.deepEqual(f.sockets[2].sent, ['after-login']);
});

test('temporary HTTP errors retry quietly without asking for credentials', async () => {
  const f = fixture(); await f.attach(); f.ctx.httpError = 503;
  f.sockets[0].drop(); await f.advance(1000);
  assert.equal(f.ctx.prompts, 0); assert.equal(f.ctx.disconnected, undefined);
  f.ctx.httpError = null; await f.advance(250); await f.attach();
  f.client.sendAnsiKey('recovered');
  assert.deepEqual(f.sockets[2].sent, ['recovered']);
});

for (const status of [502,503,504]) test(`initial loading waits through gateway ${status} without a dialog`, async () => {
  const f = fixture(); f.ctx.httpError = status;
  f.ctx.getSecurityToken = async () => { f.ctx.prompts++; throw Error('Unexpected token dialog'); };
  const result = f.ctx.fetchSession('main');
  await f.flush();
  assert.equal(f.ctx.prompts, 0);
  assert.equal(f.ctx.disconnected, undefined);
  assert.ok(f.requests.at(-1).options.signal, 'each request has a deadline');
  f.ctx.httpError = null; await f.advance(1000);
  assert.equal((await result).session_name, 'main');
});

test('initial loading recovers a connection reset to an existing session', async () => {
  const f = fixture(); f.ctx.offline = true;
  const result = f.ctx.fetchSession('main');
  await f.flush();
  assert.equal(f.ctx.prompts, 0);
  assert.equal(f.ctx.disconnected, undefined);
  f.ctx.offline = false; await f.advance(1000);
  assert.equal((await result).session_name, 'main');
});

test('initial loading stops after a minute of gateway failure', async () => {
  const f = fixture(); await f.attach(); f.ctx.httpError = 502;
  const rejected = assert.rejects(f.ctx.fetchSession('main'), /Terminal attachment is unavailable/);
  await f.flush(); await f.advance(60000); await rejected;
  const count = f.requests.length; await f.advance(10000);
  assert.equal(f.requests.length, count);
  assert.equal(f.ctx.disconnected, undefined);
});

test('initial loading does not retry a forbidden session or an uncertain welcome creation', async () => {
  const f = fixture(); f.ctx.httpError = 403;
  await assert.rejects(f.ctx.fetchSession('main'), /Terminal attachment is unavailable/);
  assert.equal(f.requests.length, 1);
  const g = fixture(); g.ctx.offline = true;
  await assert.rejects(g.ctx.fetchSession(''), /offline/);
  assert.equal(g.requests.length, 1);
  const h = fixture(); h.ctx.httpError = 502;
  await assert.rejects(h.ctx.fetchSession(''), /Terminal attachment is unavailable/);
  assert.equal(h.requests.length, 1);
});

test('a managed terminal retries rejected authentication through its relay without a token dialog', async () => {
  const f = fixture(); await f.attach();
  f.ctx.window.__switchboardManagedFocus = true; f.ctx.authExpired = true;
  f.sockets[0].drop(); await f.advance(1000);
  assert.equal(f.ctx.prompts, 0);
  assert.equal(f.ctx.disconnected, undefined);
  f.ctx.authExpired = false; await f.advance(250); await f.attach();
  f.client.sendAnsiKey('recovered');
  assert.deepEqual(f.sockets[2].sent, ['recovered']);
});

test('initial loading in a managed terminal leaves authentication to the relay', async () => {
  const f = fixture();
  f.ctx.window.__switchboardManagedFocus = true; f.ctx.authExpired = true;
  await assert.rejects(f.ctx.fetchSession('main'), /Switchboard could not authenticate/);
  assert.equal(f.ctx.prompts, 0);
});

test('long outages show a non-focusing status and recover without a page reload', async () => {
  const f = fixture(); await f.attach(); f.ctx.offline = true;
  f.sockets[0].drop();
  await f.advance(1499); assert.equal(f.nodes.length, 0);
  await f.advance(1); assert.equal(f.nodes.length, 1);
  await f.advance(10000);
  const requests = f.requests.length;
  assert.ok(requests <= 42, 'backoff bounds repeated requests');
  f.ctx.offline = false; await f.advance(5000); await f.attach();
  assert.equal(f.nodes.length, 0);
});

test('intentional close stops both sockets and never reconnects', async () => {
  const f = fixture(); await f.attach();
  f.sockets[0].drop(4001); await f.advance(60000);
  assert.equal(f.ctx.disconnected, true);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.requests.length, 0);
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].code, 'browser_failure');
  assert.match(f.failures[0].reference, /^[a-f0-9]{12}$/);
});

test('a deleted or unshared session is not recreated after a transport failure', async () => {
  const f = fixture(); await f.attach(); f.ctx.sessions = [];
  f.sockets[0].drop(); await f.advance(2000);
  assert.equal(f.sockets.length, 2);
  assert.ok(f.requests.every(r => r.url.endsWith('/session-list')));
});

test('session switching reconnects the current URL, not the original bootstrap', async () => {
  const f = fixture(); await f.attach();
  f.ctx.location.pathname = '/hosts/mac/other%20session';
  f.ctx.sessions = [{ name: 'other session', web_clients_allowed: true }];
  f.sockets[0].drop(); await f.advance(250);
  assert.ok(f.sockets[2].url.includes('/terminal/other%20session?'));
});

test('unloading stops retrying and an initial stalled socket pair can recover', async () => {
  const f = fixture(); await f.advance(5250);
  assert.equal(f.sockets.length, 4);
  await f.attach();
  f.sockets[0].onclose?.({ code: 1006 }); // obsolete sockets have no handlers
  assert.equal(f.sockets.length, 4);
  f.sockets[2].drop(); f.listeners.get('pagehide')();
  await f.advance(30000);
  assert.equal(f.sockets.length, 4);
});

for (const fallback of [false, true]) test(`a missing pane keeps healthy sockets and requires acknowledgement (automatic fallback: ${fallback})`, async () => {
  const f = fixture(); await f.attach();
  f.sockets[0].drop(); await f.advance(250);
  const [terminal, control] = f.sockets.slice(-2);
  terminal.open(); control.open();
  const active = {pane_id:2,is_plugin:false};
  control.message(JSON.stringify({type:'MobileState',payload:{active_pane:active,panes:[active]}}));
  await f.advance(16000);
  assert.equal(f.sockets.length,4);
  assert.equal(f.ctx.closedPaneNotices,1);
  f.client.sendAnsiKey('before-ack'); assert.deepEqual(terminal.sent,[]);
  f.ctx.window.__zjSendControl({type:'FocusPane',pane_id:fallback ? 2 : 1,is_plugin:false});
  if (fallback) control.message(JSON.stringify({type:'MobileState',payload:{active_pane:active,panes:[active]}}));
  f.client.sendAnsiKey('still-before-ack'); assert.deepEqual(terminal.sent,[]);
  f.ctx.acknowledgePane(); await f.flush();
  f.client.sendAnsiKey('after-ack'); assert.deepEqual(terminal.sent,['after-ack']);
  assert.equal(f.nodes.length,0);
});

test('custom input respects sidebar focus suspension while protocol replies continue', async () => {
  const f = fixture(); await f.attach();
  f.term.options.disableStdin = true;
  f.client.sendAnsiKey('custom-key');
  f.term._core.coreService.triggerDataEvent('\x1b[1;1R');
  assert.deepEqual(f.sockets[0].sent, ['\x1b[1;1R']);
});
