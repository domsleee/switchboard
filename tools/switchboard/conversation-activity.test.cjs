const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Conversation shows the model, animates real work and keeps delivery receipts separate',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 let model='gpt-6.1-sol',effort='medium';
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://activity.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/codex/reply'))return route.fulfill({json:{status:'queued'}});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{model,reasoning_effort:effort,session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'Earlier answer',model:'gpt-6.1-sol',reasoning_effort:'low'},{role:'assistant',text:'Newer answer',model:'gpt-6.1-sol',reasoning_effort:'medium'}],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,title:'Switchboard',agent:'codex',state:'ready',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://activity.test/');await page.getByText('Earlier answer',{exact:true}).waitFor();
  const activity=page.locator('.conversation-activity'),working=page.locator('.conversation-working');
  assert.equal(await activity.textContent(),'Ready');assert.equal(await page.locator('.conversation-model').textContent(),'6.1 Sol · medium');
  const labels=page.locator('.conversation-message.assistant .conversation-label');
  assert.equal(await labels.first().textContent(),'6.1 Sol · low');
  assert.equal(await labels.last().textContent(),'6.1 Sol · medium');
  assert.equal(await labels.last().isVisible(),true,'A changed model or effort starts a visible label even after another assistant message');
  assert.equal(await working.isVisible(),false);
  await page.getByLabel('Reply draft').fill('Please continue');await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.locator('.conversation-outgoing').getByText('Queued',{exact:true}).waitFor();
  assert.equal(await working.isVisible(),false,'Queue acknowledgement must not pretend the agent is working');
  await page.evaluate(()=>{current.state='working';SwitchboardConversation.update();});
  assert.equal(await activity.textContent(),'Working…');assert.equal(await page.locator('.conversation-model').textContent(),'6.1 Sol · medium');
  assert.equal(await working.isVisible(),true);
  assert.equal(await working.evaluate(node=>getComputedStyle(node,'::before').animationName),'conversation-spin');
  assert.equal(await activity.evaluate(node=>getComputedStyle(node,'::before').animationName),'conversation-pulse');
  assert.equal(await page.getByText('Waiting for agent…',{exact:true}).count(),0);
  assert.equal(await page.locator('.conversation-messages').evaluate(node=>node.lastElementChild.className),'conversation-working');
  if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation-working.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await working.evaluate(node=>getComputedStyle(node,'::before').animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  model='gpt-6-astra';effort='high';
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);
  await page.waitForFunction(()=>document.querySelector('.conversation-model').textContent==='6 Astra · high');assert.equal(await activity.textContent(),'Working…');
  assert.equal(await labels.first().textContent(),'6.1 Sol · low','Historical messages keep the model and effort that produced them');
  for(const state of ['ready','approval','input','waiting']){
   await page.evaluate(state=>{current.state=state;SwitchboardConversation.update();},state);
   assert.equal(await working.isVisible(),false,state+' must stop the animation');
   assert.equal(await activity.evaluate(node=>getComputedStyle(node,'::before').animationName),'none');
  }
  model=null;effort=null;
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);
  await page.waitForFunction(()=>document.querySelector('.conversation-model').textContent==='Codex');assert.equal(await activity.textContent(),'Waiting on an agent');
  await page.evaluate(()=>{current={...current,key:'shell',agent:null,chatId:null,state:'unknown'};SwitchboardConversation.update();});
  assert.equal(await page.locator('.conversation-notice').textContent(),'No agent');assert.equal(await working.isVisible(),false);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
