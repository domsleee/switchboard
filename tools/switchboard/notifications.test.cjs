const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = name => fs.readFileSync(__dirname + '/static/' + name, 'utf8');

function harness({ enabled = true, permission = 'granted' } = {}) {
  const store = new Map();
  if (enabled) store.set('switchboard-notifications-enabled', 'true');
  const shown = [], badges = [], vibrations = [];
  const button = {
    dataset: {}, attrs: {},
    classList: { toggle(name, on) { this[name] = on; } },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, fn) { this.onclick = fn; },
  };
  const help = { textContent: '' };
  class FakeNotification {
    constructor(title, options) { this.title = title; this.options = options; shown.push(this); }
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = async () => { FakeNotification.permission = 'granted'; return 'granted'; };
  const context = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    document: {
      readyState: 'complete', hidden: true,
      hasFocus: () => false,
      getElementById: id => (id === 'attention-notifications' ? button : id === 'attention-notifications-help' ? help : null),
      addEventListener() {},
    },
    navigator: {
      setAppBadge: count => { badges.push(count); return Promise.resolve(); },
      clearAppBadge: () => { badges.push(0); return Promise.resolve(); },
      vibrate: ms => vibrations.push(ms),
    },
    Notification: FakeNotification,
    window: { addEventListener() {}, focus() {} },
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source('notifications.js'), context);
  return { context, shown, badges, vibrations, button, store };
}

const item = (sig, extra = {}) => ({ key: 'tab-1', sig, title: 'Fix the build', machine: 'Mac', label: 'Ready to review', ...extra });

test('alerts once per attention change, again on a new token, and updates the badge', () => {
  const { context, shown, badges, vibrations } = harness();
  assert.equal(context.SwitchboardNotifications.check([item('ready:1')]), 1);
  assert.equal(context.SwitchboardNotifications.check([item('ready:1')]), 0);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Fix the build');
  assert.match(shown[0].options.body, /Ready to review/);
  assert.equal(context.SwitchboardNotifications.check([item('ready:2')]), 1);
  assert.equal(context.SwitchboardNotifications.check([]), 0);
  assert.deepEqual(badges, [1, 1, 1, 0]);
  assert.deepEqual(vibrations, [120, 120]);
});

test('does not alert when disabled, but still clears stale dedup state', () => {
  const { context, shown } = harness({ enabled: false });
  assert.equal(context.SwitchboardNotifications.check([item('ready:1')]), 0);
  assert.equal(shown.length, 0);
});

test('does not alert for the tab already in focus, and does not re-alert on blur', () => {
  const { context, shown } = harness();
  context.document.hidden = false;
  context.document.hasFocus = () => true;
  assert.equal(context.SwitchboardNotifications.check([item('approval:1', { active: true })]), 0);
  context.document.hidden = true;
  assert.equal(context.SwitchboardNotifications.check([item('approval:1', { active: true })]), 0);
  assert.equal(shown.length, 0);
});

test('PWA files are linked, valid, and served by the relay', () => {
  const manifest = JSON.parse(source('manifest.webmanifest'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
  for (const icon of manifest.icons) assert.ok(fs.existsSync(__dirname + '/static' + icon.src), icon.src);
  const sw = source('sw.js');
  assert.match(sw, /addEventListener\('push'/);
  assert.match(sw, /addEventListener\('notificationclick'/);
  assert.match(sw, /addEventListener\('fetch'/);
  const index = source('index.html');
  assert.match(index, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(index, /viewport-fit=cover/);
  assert.match(index, /src="\/notifications\.js"/);
  assert.match(index, /id="attention-notifications"/);
  const relay = fs.readFileSync(__dirname + '/../../zellij-client/src/switchboard_relay.rs', 'utf8');
  for (const name of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'notifications.js', 'sw.js']) {
    assert.ok(relay.includes(`"${name}"`), `relay serves ${name}`);
  }
});

test('mobile shell uses phone touch targets, 16px inputs and safe areas', () => {
  const css = source('style.css');
  const mobile = css.slice(css.indexOf('@media(max-width:700px)'));
  assert.match(mobile, /#sidebar-toggle[^}]*width:44px;height:44px/);
  assert.match(mobile, /#tab-search\{font-size:16px/);
  assert.match(mobile, /env\(safe-area-inset-bottom/);
  assert.match(source('messages.css'), /@media\(max-width:680px\)[^}]*button\{min-height:44px\}/s);
  assert.match(source('computers.html'), /@media\(max-width:600px\)/);
});
