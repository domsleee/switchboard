// In-place socket recovery. No real relay or user terminals are accessed.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const read = name => fs.readFileSync(__dirname + '/../../zellij-client/assets/' + name, 'utf8');
const source = name => read(name).replace(/^import[\s\S]*?from ["'][^"']+["'];\s*/gm, '').replace(/^export /gm, '');

function fixture() {
  let now = 1000, serial = 0;
  const timers = new Map(), sockets = [], nodes = [], requests = [];
  const listeners = new Map();
  const term = { rows: 24, cols: 80, options: {}, writes: [], resize(cols, rows) { this.cols = cols; this.rows = rows; }, write(data) { this.writes.push(data); } };
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
    Date: { now: () => now }, AbortSignal, URLSearchParams, console,
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    WebSocket: Socket, location: { pathname: '/hosts/mac/main' },
    window: { innerHeight: 800, innerWidth: 1000, addEventListener(name, fn) { listeners.set(name, fn); } },
    document: {
      documentElement: { style: { setProperty() {} } },
      createElement() { return { style: {}, setAttribute() {}, remove() { nodes.splice(nodes.indexOf(this), 1); } }; },
      body: { appendChild(node) { nodes.push(node); } },
    },
    addEventListener() {}, requestAnimationFrame(fn) { fn(); },
    getBaseUrl: () => '/hosts/mac', getWebSocketBaseUrl: () => 'ws://fixture/hosts/mac',
    fineScrolling: () => false, isCurrentLocation: () => true,
    setSoftKeyboard() {}, terminalConfigOptions: () => ({}), applyTerminalBackground() {},
    showErrorModal: async () => { ctx.disconnected = true; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (ctx.offline) throw Error('offline');
      if (url.endsWith('/session-list')) return { ok: true, json: async () => ({ sessions: ctx.sessions }) };
      return { ok: true, json: async () => ({ web_client_id: 'client-' + requests.length, session_name: decodeURIComponent(ctx.location.pathname.split('/').pop()) }) };
    },
    sessions: [{ name: 'main', web_clients_allowed: true }],
  };
  vm.createContext(ctx);
  vm.runInContext(source('connection.js') + '\n' + source('websockets.js') + '\nObject.assign(globalThis, {initWebSockets,initConnectionHandlers,getReconnectionDelay});', ctx);
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
    terminal.open(); control.open(); terminal.message('screen'); await flush();
  }
  return { ctx, sockets, client, term, nodes, requests, listeners, advance, attach, flush };
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

test('input resumes when both sockets open, without waiting for a redraw', async () => {
  const f = fixture(); await f.attach();
  f.sockets[0].drop(); await f.advance(250);
  f.sockets[2].open(); f.sockets[3].open(); await f.flush();
  f.client.sendAnsiKey('immediate');
  assert.deepEqual(f.sockets[2].sent, ['immediate']);
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
