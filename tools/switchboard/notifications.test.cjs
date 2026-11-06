const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = name => fs.readFileSync(__dirname + '/static/' + name, 'utf8');

function harness({ enabled = false, permission = 'default', secure = true, fail = '' } = {}) {
  const store = new Map(), calls = [], badges = [];
  if (enabled) store.set('switchboard-notifications-enabled', 'true');
  const elements = new Map();
  for (const id of ['attention-notifications','attention-notifications-help','test-notification','install-help','install-switchboard']) {
    elements.set(id, { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, v) { this[k] = v; } });
  }
  let subscription = null;
  const registration = {
    pushManager: {
      async getSubscription() { return subscription; },
      async subscribe(options) {
        calls.push('browser-subscribe');
        subscription = { endpoint: 'https://fcm.googleapis.com/push/device', options,
          toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/push/device', keys: {} }),
          async unsubscribe() { calls.push('browser-unsubscribe'); subscription = null; return true; } };
        return subscription;
      },
    },
    async getNotifications() { return []; },
  };
  const context = {
    isSecureContext: secure, PushManager: function() {}, AbortSignal,
    atob: key => Buffer.from(key, 'base64').toString('binary'), Uint8Array,
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v) },
    document: { readyState: 'complete', getElementById: id => elements.get(id) },
    Notification: { permission, async requestPermission() { calls.push('permission'); return this.permission = 'granted'; } },
    navigator: {
      serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) },
      setAppBadge: n => { badges.push(n); return Promise.resolve(); }, clearAppBadge: () => { badges.push(0); return Promise.resolve(); },
    },
    matchMedia: () => ({matches:false}), addEventListener() {},
    fetch: async (url, options) => {
      const action = url.split('/').at(-1); calls.push(action);
      return {ok: action !== fail, json: async () => action === 'config' ? {publicKey: Buffer.alloc(65,1).toString('base64url')} : {ok:true} };
    },
  };
  context.window = context; context.globalThis = context;
  vm.createContext(context); vm.runInContext(source('notifications.js'), context);
  return { api: context.SwitchboardNotifications, context, calls, elements, store, badges, registration };
}

test('permission is requested only by opting in; relay registration precedes On', async () => {
  const h = harness(); assert.deepEqual(h.calls, []);
  assert.equal(await h.api.setEnabled(true), true);
  assert.deepEqual(h.calls, ['permission','config','browser-subscribe','subscribe']);
  assert.equal(h.elements.get('attention-notifications').attrs['aria-pressed'], 'true');
  assert.equal(h.store.get('switchboard-notifications-enabled'), 'true');
  await h.api.setEnabled(false);
  assert.deepEqual(h.calls.slice(-2), ['unsubscribe','browser-unsubscribe']);
  assert.equal(h.api.enabled, false);
});
test('failed relay registration stays Off and explains the failure', async () => {
  const h = harness({fail:'subscribe'});
  assert.equal(await h.api.setEnabled(true), false);
  assert.match(h.elements.get('attention-notifications-help').textContent, /could not save/);
});
test('offline disable remains On so the user can retry removal', async () => {
  const h = harness({fail:'unsubscribe'});
  await h.api.setEnabled(true); await h.api.setEnabled(false);
  assert.equal(h.api.enabled, true); assert.ok(!h.calls.includes('browser-unsubscribe'));
});
test('denied permission and insecure phone URLs cannot claim notifications are enabled', async () => {
  for (const options of [{permission:'denied'}, {secure:false}]) {
    const h = harness(options); assert.equal(await h.api.setEnabled(true), false);
    assert.deepEqual(h.calls, []);
    assert.match(h.elements.get('attention-notifications-help').textContent, options.secure === false ? /HTTPS/ : /blocked/);
  }
});
test('attention polling updates badges without creating duplicate foreground notifications', () => {
  const h = harness(); h.api.check([{},{}]); h.api.check([]);
  assert.deepEqual(h.badges,[2,0]); assert.deepEqual(h.calls,[]);
});

function workerHarness() {
  const events = {}, shown = [], actions = [], waits = [];
  const clients = [
    {url:'https://switchboard.test/hosts/mac/main',frameType:'nested',focus:async()=>actions.push('iframe-focus')},
    {url:'https://switchboard.test/',frameType:'top-level',navigate:async url=>actions.push(['navigate',url]),focus:async()=>actions.push('focus')},
  ];
  const self = {location:{origin:'https://switchboard.test'}, addEventListener:(key,fn)=>events[key]=fn,
    registration:{showNotification:async (...args)=>shown.push(args)},
    clients:{matchAll:async()=>clients,openWindow:async url=>actions.push(['open',url])}};
  vm.runInNewContext(source('sw.js'),{self,URL});
  const send = async (name, data) => { events[name]({...data,waitUntil:promise=>waits.push(promise)}); await Promise.all(waits.splice(0)); };
  return {send,shown,actions,clients};
}
test('background push displays a notification and clicking opens its terminal, never an iframe', async () => {
  const h = workerHarness(), url='https://switchboard.test/?host=mac&session=main&pane=7';
  await h.send('push',{data:{json:()=>({title:'Build finished',body:'Ready to review',url,tag:'pane7'})}});
  assert.equal(h.shown[0][0],'Build finished'); assert.equal(h.shown[0][1].data.url,url);
  await h.send('notificationclick',{notification:{data:{url},close(){}}});
  assert.deepEqual(h.actions,[['navigate',url],'focus']);
  h.clients.length=0; h.actions.length=0;
  await h.send('notificationclick',{notification:{data:{url:'https://evil.test/'},close(){}}});
  assert.deepEqual(h.actions,[['open','https://switchboard.test/']]);
});
test('PWA manifest names real PNG icons of the advertised dimensions', () => {
  const manifest = JSON.parse(source('manifest.webmanifest'));
  assert.equal(manifest.display,'standalone');
  for (const icon of manifest.icons) {
    const png=fs.readFileSync(__dirname+'/static'+icon.src), size=Number(icon.sizes.split('x')[0]);
    assert.equal(png.readUInt32BE(16),size); assert.equal(png.readUInt32BE(20),size);
  }
});
