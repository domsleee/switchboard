const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function fixture(fn, initial = {}) {
  const browser = await chromium.launch({headless: true});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let state = {configured: false, computer: null, mesh: null, administrator: false, requests: [], members: [], joining: null, ...initial};
    const responses = new Map();
    await page.addInitScript(() => { window.setInterval = () => 0; });
    await context.route('**/*', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.startsWith('/api/mesh')) {
        const body = request.postDataJSON(); calls.push({path, body});
        return route.fulfill({contentType: 'application/json', body: JSON.stringify(path === '/api/mesh' ? state : responses.get(path) || {})});
      }
      if (path === '/api/hosts') return route.fulfill({contentType: 'application/json', body: JSON.stringify(responses.get(path) || [])});
      const name = path.slice(1);
      if (!['computers.html', 'computers.js'].includes(name)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({contentType: name.endsWith('.js') ? 'text/javascript' : 'text/html', body: fs.readFileSync(__dirname + '/static/' + name, 'utf8')});
    });
    const controls = {page, calls, responses, setState(value) {state = {...state, ...value};}};
    await fn(controls);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

test('opening and reviewing an app link requires an explicit Join computer click', async () => {
  await fixture(async ({page, calls, responses}) => {
    await page.goto('https://switchboard.test/computers.html#isolated-invitation-fragment');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#join-link').inputValue(), 'switchboard://join#isolated-invitation-fragment');
    assert.equal(calls.filter(call => call.path !== '/api/mesh').length, 0);
    responses.set('/api/mesh/preview', {mesh: 'Home', computer: 'Mac', address: 'https://192.0.2.1:8091', expires: 9999999999});
    await page.locator('#preview').click();
    await page.waitForFunction(() => !document.querySelector('#preview-card').hidden);
    assert.equal(calls.some(call => call.path === '/api/mesh/join'), false);
    assert.match(await page.locator('#preview-description').textContent(), /Mac.*Home/);
    await page.locator('#computer-name').fill('Windows');
    await page.locator('#address').fill('https://192.0.2.2:8091');
    responses.set('/api/mesh/join', {state: 'awaiting_approval', code: 'ABCD-1234-5678'});
    await page.locator('#join-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#join-link').value === '');
    const joined = calls.find(call => call.path === '/api/mesh/join');
    assert.deepEqual(joined.body, {link: 'switchboard://join#isolated-invitation-fragment', computer_name: 'Windows', address: 'https://192.0.2.2:8091'});
  });
});

test('Create invitation shares only the one-time link and Cancel clears it', async () => {
  await fixture(async ({page, calls, responses}) => {
    await page.goto('https://switchboard.test/computers.html');
    responses.set('/api/mesh/invitations', {id: 'isolated-id', link: 'switchboard://join#one-time-secret', expires: 9999999999});
    await page.locator('#computer-name').fill('Mac');
    await page.locator('#address').fill('https://192.0.2.1:8091');
    await page.locator('#mesh-name').fill('Home');
    await page.locator('#create-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#invitation').hidden);
    assert.equal(await page.locator('#invitation-link').inputValue(), 'switchboard://join#one-time-secret');
    await page.locator('#cancel-invitation').click();
    await page.waitForFunction(() => document.querySelector('#invitation').hidden);
    assert.equal(await page.locator('#invitation-link').inputValue(), '');
    assert.deepEqual(calls.find(call => call.path === '/api/mesh/cancel').body, {invitation: 'isolated-id'});
  });
});

test('approval binds the visible verification code and health requires authenticated terminal success', async () => {
  const request = {invitation: 'invite', request: 'request', computer: '<script>Windows</script>', address: 'https://192.0.2.2:8091', code: 'ABCD-1234-5678'};
  await fixture(async ({page, calls, responses}) => {
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#requests button'));
    assert.equal(await page.locator('#requests script').count(), 0);
    assert.equal(await page.locator('#joining-code').textContent(), 'ABCD-1234-5678');
    assert.match(await page.locator('#members').textContent(), /Paired, connection unavailable/);
    assert.doesNotMatch(await page.locator('#members').textContent(), /Connected/);
    await page.locator('#requests button').first().click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Approved'));
    assert.deepEqual(calls.find(call => call.path === '/api/mesh/approve').body, {invitation: 'invite', request: 'request', code: 'ABCD-1234-5678', allow: true});
    await page.waitForFunction(() => !document.querySelector('#create-form button[type=submit]').disabled);
    responses.set('/api/hosts', [{id: 'mesh-peer', name: 'Windows', sessions: [{name: 'isolated'}]}]);
    await page.locator('#members button').click();
    await page.waitForFunction(() => document.querySelector('#members').textContent.includes('Connected'));
  }, {configured: true, computer: {name: 'Mac', address: 'https://192.0.2.1:8091'}, mesh: 'Home', administrator: true, requests: [request], members: [{id: 'peer', name: 'Windows', address: 'https://192.0.2.2:8091', local: false, state: 'paired'}], joining: {mesh: 'Home', computer: 'Mac', code: 'ABCD-1234-5678'}});
});
