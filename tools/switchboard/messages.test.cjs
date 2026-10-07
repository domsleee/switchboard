const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const agent = {id:'session-new',name:'Reviewer',project:'switchboard',active:true,terminal:{host:'windows',session:'main',tab_id:2},unread_count:1};
const directory = {machine_id:'mac',machines:[{id:'mac',name:'Mac',unread_count:1,participants:[]},{id:'windows',name:'Windows',unread_count:0,participants:[agent,{...agent,id:'session-old',active:false}]}]};
function message(id, overrides = {}) {return {id,thread_id:'thread-1',sender_name:'Builder',sender_machine_name:'Mac',project:'switchboard',created_at:1700000000000,body:'Hello\n<script>window.compromised=true</script>',deliveries:[{recipient:'session-new',name:'Reviewer',machine_name:'Windows',recipient_kind:'agent',acknowledged_at:null}],...overrides};}
async function fixture(run) {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage(), calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let handler = () => ({items:[],next_cursor:null});
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith('/api/message-board/') || url.pathname === '/api/mesh/board-host') {
        calls.push({method:request.method(),url});
        const value = await handler(url);
        return route.fulfill({status:value.status || 200,contentType:'application/json',body:JSON.stringify(value.body || value)});
      }
      const name = url.pathname.slice(1);
      if (!['messages.html','messages.js','messages.css'].includes(name)) return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+name,'utf8')});
    });
    await run({page,calls,respond(fn){handler=fn;}});
    assert.deepEqual(errors,[]);
    assert.ok(calls.every(call => call.method === 'GET'), 'Human views must never mutate or acknowledge messages');
  } finally { await browser.close(); }
}
test('computer and session inboxes preserve history, receipt status, literal text and thread pagination', async () => {
  await fixture(async ({page,calls,respond}) => {
    respond(url => {
      if (url.pathname.endsWith('/inboxes')) return directory;
      if (url.pathname.includes('/threads/')) return {items:[message('reply',{body:'Reply',deliveries:[{name:'Builder',machine_name:'Mac',recipient_kind:'computer',acknowledged_at:1700000001000}]})],next_cursor:null};
      return {items:[message(url.searchParams.has('after')?'second':'first')],next_cursor:url.searchParams.has('after')?null:25};
    });
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('button[data-key="agent:session-new"]').click();
    await page.waitForFunction(() => document.querySelectorAll('article').length === 1);
    assert.match(await page.locator('#location').textContent(), /windows \/ main \/ tab 2.*session-new/);
    assert.equal(await page.locator('#location a').count(),0);
    assert.match(await page.locator('button[data-key="agent:session-old"]').textContent(), /Retired/);
    assert.match(await page.locator('article').textContent(), /Awaiting acknowledgment/);
    assert.match(await page.locator('.body').textContent(), /<script>/);
    assert.equal(await page.evaluate(() => window.compromised),undefined);
    await page.locator('#more').click();
    await page.waitForFunction(() => document.querySelectorAll('article').length === 2);
    assert.equal(calls.at(-1).url.searchParams.get('after'),'25');
    await page.locator('article button').first().click();
    await page.waitForFunction(() => document.querySelector('.body')?.textContent === 'Reply');
    assert.match(await page.locator('article').textContent(), /\(computer\).*Acknowledged/);
    await page.locator('#back').click();
    await page.waitForFunction(() => document.querySelector('.body')?.textContent.startsWith('Hello'));
    await page.locator('button[data-key="computer:mac"]').click();
    await page.waitForFunction(() => document.querySelector('article'));
    assert.ok(calls.some(call => call.url.pathname.endsWith('/machines/mac/inbox')));
  });
});
test('project filters reach inbox counts and history and refresh resets pagination', async () => {
  await fixture(async ({page,calls,respond}) => {
    respond(url => url.pathname.endsWith('/inboxes') ? directory : {items:[message('one')],next_cursor:25});
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('button[data-key="computer:mac"]').click();
    await page.locator('#more').click();
    await page.waitForFunction(() => document.querySelectorAll('article').length === 2);
    await page.locator('#project').fill('switchboard');
    await page.locator('#filter button[type=submit]').click();
    await page.waitForFunction(() => document.querySelectorAll('article').length === 1);
    assert.ok(calls.some(call => call.url.pathname.endsWith('/inboxes') && call.url.searchParams.get('project') === 'switchboard'));
    assert.equal(calls.at(-1).url.searchParams.get('project'),'switchboard');
    assert.equal(calls.at(-1).url.searchParams.has('after'),false);
  });
});
test('setup and offline errors recover via Refresh', async () => {
  await fixture(async ({page,respond}) => {
    respond(() => ({status:503,body:{configured:false}}));
    await page.goto('https://switchboard.test/messages.html');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('not configured'));
    assert.equal(await page.locator('a[href="/computers.html"]').count(),1);
    respond(() => ({status:503,body:{error:'Shared board computer is offline'}}));
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('offline'));
    respond(url => url.pathname.endsWith('/inboxes') ? directory : {items:[],next_cursor:null});
    await page.locator('#refresh').click();
    await page.locator('button[data-key="computer:mac"]').click();
    await page.waitForFunction(() => document.querySelector('#history-status').textContent.includes('No messages'));
  });
});
test('late inbox response cannot overwrite a newly selected agent session', async () => {
  await fixture(async ({page,respond}) => {
    let release;
    respond(url => {
      if (url.pathname.endsWith('/inboxes')) return directory;
      if (url.pathname.includes('/machines/')) return new Promise(resolve => {release=()=>resolve({items:[message('old',{body:'Old inbox'})],next_cursor:null});});
      return {items:[message('new',{body:'New session'})],next_cursor:null};
    });
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('button[data-key="computer:mac"]').click();
    await page.locator('button[data-key="agent:session-new"]').click();
    await page.waitForFunction(() => document.querySelector('.body')?.textContent === 'New session');
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.body').textContent(),'New session');
  });
});
test('filter clears a hidden selected agent and ignores its late history response', async () => {
  await fixture(async ({page,respond}) => {
    let release;
    respond(url => {
      if (url.pathname.endsWith('/inboxes')) return url.searchParams.get('project') === 'other'
        ? {...directory,machines:directory.machines.map(machine=>({...machine,participants:[]}))} : directory;
      if (url.searchParams.get('project') === 'other') return new Promise(resolve => {release=()=>resolve({items:[message('stale')],next_cursor:25});});
      return {items:[message('one')],next_cursor:null};
    });
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('button[data-key="agent:session-new"]').click();
    await page.waitForFunction(() => document.querySelector('article'));
    await page.locator('#project').fill('other');
    await page.locator('#filter button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#heading').textContent === 'Choose an inbox');
    assert.equal(await page.locator('button[data-key="agent:session-new"]').count(),0);
    release();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('article').count(),0);
    assert.equal(await page.locator('#more').isVisible(),false);
    assert.equal(await page.locator('#history-status').textContent(),'');
  });
});
test('pagination failure keeps messages and retries the same cursor; filtered counts update', async () => {
  await fixture(async ({page,calls,respond}) => {
    let fail = true;
    respond(url => {
      if (url.pathname.endsWith('/inboxes')) return {...directory,machines:directory.machines.map(machine=>({...machine,unread_count:url.searchParams.has('project')?7:1}))};
      if (url.searchParams.has('after') && fail) return {status:503,body:{error:'Board temporarily offline'}};
      return {items:[message(url.searchParams.has('after')?'second':'first')],next_cursor:url.searchParams.has('after')?null:25};
    });
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('button[data-key="computer:mac"]').click();
    await page.locator('#more').click();
    await page.waitForFunction(() => document.querySelector('#history-status').textContent.includes('offline'));
    assert.equal(await page.locator('article').count(),1);
    fail=false;
    await page.locator('#more').click();
    await page.waitForFunction(() => document.querySelectorAll('article').length === 2);
    assert.deepEqual(calls.filter(call=>call.url.searchParams.has('after')).map(call=>call.url.searchParams.get('after')),['25','25']);
    await page.locator('#project').fill('switchboard');
    await page.locator('#filter button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('button[data-key="computer:mac"]').textContent.includes('7 awaiting'));
    assert.equal(await page.locator('#heading').textContent(),'Mac / Computer inbox');
    assert.equal(await page.locator('button[data-key="computer:mac"]').getAttribute('aria-current'),'true');
  });
});
test('narrow layout keeps inboxes and messages within the viewport', async () => {
  await fixture(async ({page,respond}) => {
    respond(url => url.pathname.endsWith('/inboxes') ? directory : {items:[message('long',{body:'word'.repeat(400)})],next_cursor:null});
    await page.setViewportSize({width:360,height:780});
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('button[data-key="agent:session-new"]').click();
    await page.waitForFunction(() => document.querySelector('article'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    const nav = await page.locator('#inboxes').boundingBox(), main = await page.locator('main').boundingBox();
    assert.ok(main.y >= nav.y + nav.height);
  });
});

test('server-selected cross-project recipient remains visible with its delivery history', async () => {
  await fixture(async ({page,respond}) => {
    respond(url => url.pathname.endsWith('/inboxes') ? directory : {items:[message('cross-project',{project:'other',body:'Cross-project handoff'})],next_cursor:null});
    await page.goto('https://switchboard.test/messages.html');
    await page.locator('#project').fill('other');
    await page.locator('#filter button[type=submit]').click();
    await page.locator('button[data-key="agent:session-new"]').click();
    await page.waitForFunction(() => document.querySelector('.body')?.textContent === 'Cross-project handoff');
    assert.match(await page.locator('button[data-key="agent:session-new"]').textContent(), /switchboard/);
    assert.match(await page.locator('article .meta').textContent(), /Project: other/);
  });
});

test('offline board names its selected computer and initial setup directs to Manage computers', async () => {
  await fixture(async ({page,respond}) => {
    respond(url => url.pathname === '/api/mesh/board-host' ? {state:'selected',host_name:'Windows <work>',host_id:'windows'} : {status:503,body:{error:'Shared board is unavailable'}});
    await page.goto('https://switchboard.test/messages.html');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('unavailable'));
    assert.equal(await page.locator('#board-host').textContent(),'Message board host: Windows <work>');
    assert.equal(await page.locator('#board-host work').count(),0);
    respond(url => url.pathname === '/api/mesh/board-host' ? {state:'unconfigured'} : {status:503,body:{configured:false}});
    await page.locator('#refresh').click();
    await page.waitForFunction(() => document.querySelector('#board-host').textContent.includes('Choose'));
    assert.match(await page.locator('#status').textContent(),/choose a message board host/);
  });
});

test('conflicts and existing board storage preserve the server error instead of offering initial setup', async () => {
  for (const state of ['conflict','legacy_database']) {
    await fixture(async ({page,respond}) => {
      const error = state === 'conflict' ? 'Computers disagree about the selected board host.' : 'Existing message history must be migrated before choosing a host.';
      respond(url => url.pathname === '/api/mesh/board-host' ? {state} : {status:503,body:{configured:false,board_host:{state},error}});
      await page.goto('https://switchboard.test/messages.html');
      await page.waitForFunction(expected => document.querySelector('#status').textContent === expected,error);
      assert.match(await page.locator('#board-host').textContent(),state === 'conflict' ? /host conflict/ : /needs migration/);
      assert.doesNotMatch(await page.locator('#status').textContent(),/not configured|pair your computers/);
      assert.equal(await page.locator('a[href="/computers.html"]').count(),1);
    });
  }
});
