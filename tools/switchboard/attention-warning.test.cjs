const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('attention warnings wait for a continuous outage in Conversation and Terminal',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
 try{for(const mode of ['conversation','terminal']){
  const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[];let outages=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-11-09T00:00:00Z')});
  await page.clock.pauseAt(new Date('2026-11-09T00:00:01Z'));
  await page.addInitScript(mode=>{localStorage.setItem('switchboard-view-mode',mode);window.setInterval=()=>0;},mode);
  await page.route('http://warning-fixture.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=v=>route.fulfill({json:v});
   if(p==='/api/health')return json({});
   if(p==='/api/hosts')return json([{id:'fixture',name:'Fixture desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   const pane={pane_id:1,is_plugin:false,tab_id:1,tab_position:0,is_focused:true};
   if(p==='/api/attention'){
    if(url.searchParams.has('after'))return;
    return json({tabs:[{host:'fixture',session:'main',id:1,position:0,name:'Fixture conversation',panes:[pane]}],panes:[{host:'fixture',session:'main',pane_id:1,agent:'codex',state:'ready',chat_id:'chat-1'}],errors:outages});
   }
   if(p.startsWith('/api/chats/'))return json({id:'chat-1',messages:[{role:'assistant',text:'Conversation remains available.'}],start_cursor:0,next_cursor:null});
   if(p.startsWith('/api/'))return json({});
   if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input aria-label="Terminal input"><script>parent.postMessage({type:'zellij-state',payload:{session_name:'main',panes:[${JSON.stringify(pane)}],active_pane:${JSON.stringify(pane)}}},location.origin);</script>`});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file)||fs.statSync(file).isDirectory())return route.fulfill({status:404,body:''});
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'text/html'});
  });
  await page.goto('http://warning-fixture.test/?host=fixture&session=main&tab=1');
  await page.locator('#tabs .tab-select').waitFor();
  if(mode==='conversation')await page.getByText('Conversation remains available.',{exact:true}).waitFor();
  else await page.waitForFunction(()=>[...sessions.values()][0]?.state);
  const status=page.locator('#status'),poll=()=>page.evaluate(()=>refreshAttention(true));
  assert.equal(await status.isVisible(),false);
  outages=[{host:'fixture',session:'main'}];await poll();
  assert.equal(await status.isVisible(),false,'One failed check stays quiet');
  assert.equal(await page.locator('#tabs .tab-select').getAttribute('data-agent-state'),'Status unavailable');
  for(let i=0;i<5;i++)await page.evaluate(()=>render());
  await page.clock.runFor(4999);assert.equal(await status.isVisible(),false,'Redraws do not accelerate the grace period');
  outages=[];await poll();await page.clock.runFor(5001);
  assert.equal(await status.isVisible(),false,'Recovery cancels the warning timer');
  outages=[{host:'fixture',session:'main'}];await poll();
  await page.clock.runFor(4999);assert.equal(await status.isVisible(),false,'A new outage gets a fresh grace period');
  await page.clock.runFor(1);assert.equal(await status.isVisible(),true,'A persistent outage warns without another snapshot');
  assert.equal(await page.locator('#status-message').innerText(),'Fixture desktop: attention status unavailable');
  if(process.env.SWITCHBOARD_WARNING_SCREENSHOTS)await page.screenshot({path:path.join(process.env.SWITCHBOARD_WARNING_SCREENSHOTS,mode+'-persistent.png')});
  await page.getByRole('button',{name:'Dismiss offline warnings for today'}).click();
  await page.evaluate(()=>render());assert.equal(await status.isVisible(),false,'Dismissal survives redraws');
  outages=[];await poll();
  outages=[{host:'other',session:'main',pending:true}];await poll();await page.clock.runFor(6000);
  assert.equal(await status.isVisible(),false,'Pending scans do not raise warnings');
  outages=[{host:'other',session:'main'}];await poll();await page.clock.runFor(4999);
  assert.equal(await status.isVisible(),false,'Another computer gets its own grace period');
  if(process.env.SWITCHBOARD_WARNING_SCREENSHOTS)await page.screenshot({path:path.join(process.env.SWITCHBOARD_WARNING_SCREENSHOTS,mode+'-transient.png')});
  await page.evaluate(()=>setStatus('Could not send the message.',true));
  assert.equal(await status.isVisible(),true,'An action failure remains immediate');
  assert.equal(await page.locator('#status-message').innerText(),'Could not send the message.');
  assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
});
