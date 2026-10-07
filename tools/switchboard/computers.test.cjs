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
    const responses = new Map([['/api/mesh/defaults', {computer_name:'Mac',address:'https://192.0.2.1:8082',name:'My computers',addresses:['https://192.0.2.1:8082'],requires_choice:false}]]);
    await page.addInitScript(() => { window.setInterval = () => 0; });
    await context.route('**/*', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.startsWith('/api/mesh')) {
        const body = request.postDataJSON(); calls.push({path, body});
        if (path === '/api/mesh' && responses.has('/api/mesh-error')) return route.fulfill({status:503,body:responses.get('/api/mesh-error')});
        return route.fulfill({contentType: 'application/json', body: JSON.stringify(path === '/api/mesh' ? state : responses.get(path) || {})});
      }
      if (path === '/api/hosts') {
        const query = new URL(request.url()).search; calls.push({path,query});
        return route.fulfill({contentType: 'application/json', body: JSON.stringify(responses.get(path + query) || responses.get(path) || [])});
      }
      if (path === '/api/health' && responses.has(path)) return route.fulfill({contentType: 'application/json', body: JSON.stringify(responses.get(path))});
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
    responses.set('/api/mesh/preview', {mesh: 'Home', computer: 'Mac', address: 'https://192.0.2.1:8091', expires: 9999999999});
    await page.goto('https://switchboard.test/computers.html#isolated-invitation-fragment');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.locator('#join-link').inputValue(), 'switchboard://join#isolated-invitation-fragment');
    assert.equal(calls.some(call => ['/api/mesh/join','/api/mesh/invitations'].includes(call.path)), false);
    responses.set('/api/mesh/preview', {mesh: 'Home', computer: 'Mac', address: 'https://192.0.2.1:8091', expires: 9999999999});
    await page.waitForFunction(() => !document.querySelector('#preview-card').hidden);
    assert.equal(calls.some(call => call.path === '/api/mesh/join'), false);
    assert.match(await page.locator('#preview-description').textContent(), /Mac.*Home/);
    await page.locator('#computer-name').fill('Windows');
    await page.locator('#advanced summary').click();
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
    await page.waitForFunction(() => document.querySelector('#address').value);
    assert.equal(await page.locator('#computer-name').inputValue(), 'Mac');
    assert.equal(await page.locator('#advanced').getAttribute('open'), null);
    await page.locator('#create-form button[type=submit]').click();
    await page.waitForFunction(() => !document.querySelector('#invitation').hidden);
    assert.equal(await page.locator('#invitation-link').inputValue(), 'switchboard://join#one-time-secret');
    assert.deepEqual(calls.find(call => call.path === '/api/mesh/invitations').body, {name:'My computers',computer_name:'Mac',address:'https://192.0.2.1:8082'});
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


test('multiple networks require one choice, without typing an address', async () => {
  await fixture(async ({page,calls,responses}) => {
    responses.set('/api/mesh/defaults',{computer_name:'work (fast)',name:'My computers',address:null,requires_choice:true,addresses:['https://172.20.10.10:8082','https://100.64.1.2:8082']});
    responses.set('/api/mesh/invitations',{id:'one',link:'switchboard://join#one',expires:9999999999});
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(()=>!document.querySelector('#network-choice').hidden);
    await page.locator('#create-form button').click();
    assert.equal(calls.some(call=>call.path==='/api/mesh/invitations'),false);
    await page.locator('#network').selectOption('https://172.20.10.10:8082');
    await page.locator('#create-form button').click();
    await page.waitForFunction(()=>!document.querySelector('#invitation').hidden);
    assert.equal(calls.find(call=>call.path==='/api/mesh/invitations').body.address,'https://172.20.10.10:8082');
  });
});

test('missing network opens Advanced and never submits an empty gateway', async () => {
  await fixture(async ({page,calls,responses}) => {
    responses.set('/api/mesh/defaults',{computer_name:'Offline Mac',name:'My computers',address:null,addresses:[],requires_choice:false});
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(()=>document.querySelector('#advanced').open);
    await page.locator('#create-form button').click();
    assert.equal(calls.some(call=>call.path==='/api/mesh/invitations'),false);
  });
});

test('pasting reviews automatically but never joins without consent', async () => {
  await fixture(async ({page,calls,responses}) => {
    responses.set('/api/mesh/preview',{mesh:'My computers',computer:'Mac',expires:9999999999});
    await page.goto('https://switchboard.test/computers.html');
    await page.locator('#join-link').fill('switchboard://join#pasted');
    await page.waitForFunction(()=>!document.querySelector('#preview-card').hidden);
    assert.equal(calls.some(call=>call.path==='/api/mesh/join'),false);
    await page.locator('#join-link').fill('');
    assert.equal(await page.locator('#preview-card').isVisible(),false);
  });
});

test('Add computer sends an address without copying an invitation', async()=>{
  await fixture(async({page,calls,responses})=>{
    responses.set('/api/mesh/add',{computer:'work (fast)',code:'AAAA-BBBB-CCCC'});
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(()=>document.querySelector('#address').value);
    await page.locator('#target-address').fill('172.20.10.10');
    await page.locator('#add-form button').click();
    await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Request sent'));
    assert.deepEqual(calls.find(c=>c.path==='/api/mesh/add').body,{target:'172.20.10.10',name:'My computers',computer_name:'Mac',address:'https://192.0.2.1:8082'});
    assert.equal(calls.some(c=>c.path==='/api/mesh/invitations'),false);
    assert.equal(await page.locator('#invitation').isVisible(),false);
  });
});

test('Incoming address request needs explicit local approval of the displayed code',async()=>{
  const incoming=[{invitation:'direct-one',computer:'Mac',address:'https://192.0.2.1:8082',code:'AAAA-BBBB-CCCC'}];
  await fixture(async({page,calls,responses,setState})=>{
    responses.set('/api/mesh/answer',{state:'awaiting_approval'});
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(()=>document.querySelector('#incoming button'));
    assert.equal(calls.some(c=>c.path==='/api/mesh/answer'),false);
    assert.match(await page.locator('#incoming').textContent(),/Mac wants to connect/);
    setState({incoming:[],joining:{computer:'Mac',mesh:'My computers',code:'AAAA-BBBB-CCCC'}});
    await page.locator('#incoming button').first().click();
    await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('Allowed'));
    assert.deepEqual(calls.find(c=>c.path==='/api/mesh/answer').body,{invitation:'direct-one',code:'AAAA-BBBB-CCCC',allow:true});
  },{configured:true,computer:{name:'Work',address:'https://192.0.2.2:8082'},incoming});
});

test('Pairing notification leaves focused terminal and layout untouched',async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/api/mesh',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({incoming:[{computer:'Mac'}],requests:[]})}));
    await page.route('https://switchboard.test/',route=>route.fulfill({contentType:'text/html',body:'<a id="pairing-notice" href="/computers.html" hidden style="position:fixed;right:16px;bottom:32px">Review</a><iframe id="terminal" srcdoc="<input id=terminal-input>"></iframe>'}));
    await page.goto('https://switchboard.test/');
    await page.frameLocator('#terminal').locator('input').focus();
    const box=await page.locator('#terminal').boundingBox();
    await page.addScriptTag({path:__dirname+'/static/pairing-notice.js'});
    await page.waitForFunction(()=>!document.querySelector('#pairing-notice').hidden);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'terminal');
    assert.equal(await page.frameLocator('#terminal').locator('input').evaluate(e=>e===document.activeElement),true);
    assert.deepEqual(await page.locator('#terminal').boundingBox(),box);
  } finally { await browser.close(); }
});

const pairedState = {
  configured: true, mesh: 'My computers', administrator: false,
  computer: {name:'Mac', address:'https://192.0.2.2:8082'},
  administrator_computer: {id:'owner', name:'Windows <admin>', address:'https://192.0.2.1:8082'},
  members: [
    {id:'owner', name:'Windows <admin>', address:'https://192.0.2.1:8082', local:false, state:'paired'},
    {id:'local', name:'Mac', address:'https://192.0.2.2:8082', local:true, state:'paired'}
  ]
};

test('every paired computer can create invitations and add computers', async () => {
  await fixture(async ({page, calls, responses}) => {
    responses.set('/api/mesh/invitations', {id:'new', link:'switchboard://join#new', expires:9999999999});
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#computer-name').readOnly);
    assert.equal(await page.locator('#direct-section').isVisible(), true);
    assert.equal(await page.locator('#join-section').isVisible(), false);
    assert.doesNotMatch(await page.locator('body').textContent(), /administrator/i);
    await page.locator('#create-form button').click();
    await page.waitForFunction(() => !document.querySelector('#invitation').hidden);
    assert.equal(calls.some(c => c.path === '/api/mesh/invitations'), true);
  }, pairedState);
});

test('configured Windows appears before pairing and pairs using its existing gateway address', async () => {
  await fixture(async ({page,calls,responses}) => {
    responses.set('/api/hosts', [{id:'windows',name:'Windows <work>',address:'http://172.20.10.69:8091',pairing_address:'https://172.20.10.69:8082',configured:true,local:false}]);
    responses.set('/api/mesh/add', {computer:'Windows',code:'AAAA-BBBB-CCCC'});
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#address').value);
    assert.equal(await page.locator('#catalog').isVisible(),true);
    assert.equal(calls.find(call => call.path === '/api/hosts').query, '?summary=1&candidates=1');
    assert.match(await page.locator('#members').textContent(), /Windows <work>.*pair this computer to use its terminals/s);
    assert.equal(await page.locator('#members work').count(),0);
    assert.equal(calls.some(call => call.path === '/api/mesh/add'),false);
    await page.locator('#members button').click();
    await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Request sent'));
    assert.deepEqual(calls.find(call => call.path === '/api/mesh/add').body, {target:'https://172.20.10.69:8082',name:'My computers',computer_name:'Mac',address:'https://192.0.2.1:8082'});
    assert.equal(calls.some(call => call.path === '/api/mesh/approve'),false);
  });
});

test('configured connections dedupe paired endpoints and local identity without hiding distinct gateway ports', async () => {
  await fixture(async ({page,responses}) => {
    responses.set('/api/hosts', [
      {id:'local',name:'Local legacy',address:'http://127.0.0.1:8082',pairing_address:'https://127.0.0.1:8082',configured:true,local:true},
      {id:'legacy',name:'Duplicate legacy',address:'http://192.0.2.1:8091',pairing_address:'https://192.0.2.1:8082/',configured:true,local:false},
      {id:'mesh-owner',name:'Windows',sessions:[],configured:false},
      {id:'different-port',name:'Other gateway',address:'https://192.0.2.1:9092',pairing_address:'https://192.0.2.1:9092',configured:true,local:false}
    ]);
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#members').textContent.includes('Other gateway'));
    assert.equal(await page.locator('#members .card').count(),3);
    assert.doesNotMatch(await page.locator('#members').textContent(), /Local legacy|Duplicate legacy/);
    assert.match(await page.locator('#members').textContent(), /Connected/);
    assert.equal(await page.locator('#members button').textContent(),'Pair this computer');
  }, pairedState);
});

test('message board host selection is explicit and only offered for initial setup', async () => {
  const board = {state:'unconfigured',host_id:null,host_name:null,can_select:true,candidates:[{id:'windows',name:'Windows <work>'},{id:'mac',name:'Mac'}]};
  await fixture(async ({page,calls,responses,setState}) => {
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => !document.querySelector('#board-form').hidden);
    assert.equal(await page.locator('#board-host').inputValue(),'');
    assert.equal(calls.some(call => call.path === '/api/mesh/board-host'),false);
    assert.equal(await page.locator('#board-host work').count(),0);
    await page.locator('#board-host').selectOption('windows');
    const selected = {...board,state:'selected',host_id:'windows',host_name:'Windows <work>',can_select:false};
    responses.set('/api/mesh/board-host',selected);setState({board_host:selected});
    await page.locator('#board-form button').click();
    await page.waitForFunction(() => document.querySelector('#board-form').hidden);
    assert.deepEqual(calls.find(call => call.path === '/api/mesh/board-host').body,{host_id:'windows'});
    assert.match(await page.locator('#board-description').textContent(), /Message board: Windows <work>/);
    assert.equal(await page.locator('#board-description work').count(),0);
  }, {...pairedState,board_host:board});
});

test('conflicting or existing board storage never offers a replacement host', async () => {
  for (const state of ['conflict','legacy_database']) {
    await fixture(async ({page,calls}) => {
      await page.goto('https://switchboard.test/computers.html');
      await page.waitForFunction(() => !document.querySelector('#board-section').hidden);
      assert.equal(await page.locator('#board-form').isVisible(),false);
      assert.match(await page.locator('#board-description').textContent(),state === 'conflict' ? /disagree/ : /migration/);
      assert.equal(calls.some(call => call.path === '/api/mesh/board-host'),false);
    }, {...pairedState,board_host:{state,can_select:false,candidates:[]}});
  }
});

test('configured hosts remain visible when pairing service is unavailable', async () => {
  await fixture(async ({page,calls,responses}) => {
    responses.set('/api/mesh-error','Pairing unavailable');
    responses.set('/api/hosts',[{id:'windows',name:'Windows',address:'http://172.20.10.69:8082',pairing_address:'https://172.20.10.69:8082',configured:true,local:false}]);
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#members').textContent.includes('Windows'));
    assert.equal(await page.locator('#catalog').isVisible(),true);
    assert.match(await page.locator('#message').textContent(),/Pairing is unavailable/);
    assert.equal(await page.locator('#members button').isDisabled(),true);
    assert.equal(calls.some(call => call.path === '/api/mesh/add'),false);
  });
});

test('each reachable computer shows its version and flags builds that differ from this one', async () => {
  const windows = {id:'windows',name:'Windows',address:'http://172.20.10.69:8082',pairing_address:'https://172.20.10.69:8082',configured:true,local:false};
  const old = {id:'old',name:'Old laptop',address:'https://172.20.10.70:8082',pairing_address:'https://172.20.10.70:8082',configured:true,local:false};
  const offline = {id:'offline',name:'Offline',address:'https://172.20.10.71:8082',pairing_address:'https://172.20.10.71:8082',configured:true,local:false};
  await fixture(async ({page,responses}) => {
    responses.set('/api/health', {commit:'abc1234',commit_date:'2026-10-07'});
    responses.set('/api/hosts?summary=1', [windows, old, offline]);
    responses.set('/api/hosts', [
      {id:'mesh-owner',name:'Owner',sessions:[],version:{commit:'abc1234',commit_date:'2026-10-07'}},
      {...windows,sessions:[],version:{commit:'def5678',commit_date:'2026-09-30'}},
      {...old,sessions:[],version:null},
      {...offline,error:'Host unavailable'}
    ]);
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#members').textContent.includes('Old laptop'));
    const cards = Object.fromEntries(await page.locator('#members .card').evaluateAll(cards => cards.map(card => [card.querySelector('strong').textContent, card.querySelector('small')?.textContent ?? null])));
    assert.deepEqual(cards, {
      'Windows <admin>': 'Version abc1234 · 2026-10-07',
      'Mac': 'Version abc1234 · 2026-10-07',
      'Windows': 'Version def5678 · 2026-09-30 · Different version from this computer',
      'Old laptop': 'Version unknown',
      'Offline': null
    });
  }, pairedState);
});

test('unpaired configured computers fill in versions after the fast summary renders', async () => {
  await fixture(async ({page,responses}) => {
    const windows = {id:'windows',name:'Windows',address:'http://172.20.10.69:8082',pairing_address:'https://172.20.10.69:8082',configured:true,local:false};
    responses.set('/api/health', {commit:'abc1234',commit_date:'2026-10-07'});
    responses.set('/api/hosts?summary=1', [windows]);
    responses.set('/api/hosts', [{...windows,sessions:[],version:{commit:'def5678',commit_date:'2026-09-30'}}]);
    await page.goto('https://switchboard.test/computers.html');
    await page.waitForFunction(() => document.querySelector('#members small.different'));
    assert.match(await page.locator('#members').textContent(), /Version def5678 · 2026-09-30 · Different version/);
  });
});
