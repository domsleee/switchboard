const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

const step=(call,detail)=>({role:'assistant',phase:'commentary',kind:'tool',tool:'agent',call,detail,text:'Delegated '+detail,timestamp:'2026-11-09T10:00:00Z'});
const tool=detail=>({role:'assistant',phase:'commentary',kind:'tool',tool:'run',detail,text:'Ran '+detail,timestamp:'2026-11-09T10:00:00Z'});

test('Conversation draws delegated agents as cards that report and open their work',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const started=new Date(Date.now()-145000).toISOString();
 let delegates=[
  {call:'opus',id:'a1',model:'claude-opus-5-5',effort:'high',status:'running',started,ended:null},
  {call:'fore',id:null,model:'opus',effort:null,status:'running',started,ended:null},
  {call:'done',id:'a3',model:'claude-haiku-5-5',effort:null,status:'completed',started:'2026-11-09T10:00:00Z',ended:'2026-11-09T10:01:05Z'},
  {call:'sol',id:'bsol',provider:'codex',model:'gpt-6.1-sol',effort:'xhigh',status:'completed',started:'2026-11-09T10:00:00Z',ended:'2026-11-09T10:02:00Z'},
  {call:'bad',id:'a4',model:null,effort:null,status:'failed',started:'2026-11-09T10:00:00Z',ended:'2026-11-09T10:00:09Z'},
 ];
 const taskReads=[];let escapes=0;
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://delegates.test/**',route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.endsWith('/escape')){escapes++;return route.fulfill({json:{}});}
   if(p.startsWith('/api/chats/')&&url.searchParams.get('task')==='bsol'){taskReads.push('bsol');return route.fulfill({json:{task:{id:'bsol',kind:'shell',running:false,command:'codex exec -m gpt-6.1-sol "Review"',events:[]},output:'VERDICT: <b>APPROVE</b>\n'}});}
   if(p.startsWith('/api/chats/')&&url.searchParams.get('task')){taskReads.push(url.searchParams.get('task'));return route.fulfill({json:{task:{id:url.searchParams.get('task'),kind:'agent',running:false},start_cursor:0,message_count:1,messages:[{role:'user',text:'Act as the reviewer for this task.\nRead the relay closely.'},{role:'assistant',phase:'commentary',text:'I will read the relay first.'},tool('cargo test'),tool('rg poll'),tool('git log'),{role:'assistant',phase:'commentary',kind:'tool',tool:'read',detail:'a.rs',text:'Read a.rs'},{role:'assistant',text:'One bug found.'}]}});}
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{model:'claude-opus-5-5',background_agents:[],delegates,session_id:'00000000-0000-4000-8000-000000000001',
    messages:[{role:'user',text:'council',timestamp:'2026-11-09T09:59:00Z'},tool('cargo test'),step('done','Council: finished'),step('sol','Council: Sol'),step('bad','Council: failed'),step('fore','Council: foreground'),step('old','Council: forgotten'),step('opus','Council: Switchboard performance (Opus)')],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,title:'Switchboard',agent:'claude',state:'working',since:Date.now()/1000-200,chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://delegates.test/');
  const card=name=>page.locator('.conversation-delegate',{hasText:name}),meta=name=>card(name).locator('.conversation-delegate-meta').textContent(),time=name=>card(name).locator('.conversation-agent-time').textContent();
  await card('Switchboard performance').waitFor();

  assert.equal(await meta('Switchboard performance'),'Opus 5.5 · High · Running');
  assert.match(await time('Switchboard performance'),/^2m 2\ds$/);
  assert.equal(await card('Switchboard performance').evaluate(node=>node.classList.contains('running')),true);
  assert.equal(await meta('Council: finished'),'Haiku 5.5 · Finished');assert.equal(await time('Council: finished'),'1m 5s');
  assert.equal(await card('Council: finished').evaluate(node=>node.classList.contains('running')),false);
  assert.equal(await meta('failed'),'Failed');assert.equal(await card('failed').getAttribute('data-status'),'failed');
  assert.equal(await card('forgotten').isDisabled(),true,'A row the relay no longer lists cannot be opened');assert.equal(await meta('forgotten'),'Delegated');
  assert.equal(await card('foreground').isDisabled(),true,'A foreground agent has no id until it returns');

  const article=card('Switchboard performance').locator('xpath=ancestor::article');
  assert.equal(await article.evaluate(node=>getComputedStyle(node).display!=='none'&&!node.hidden),true,'The newest card is not absorbed into the live row');
  assert.equal(await card('Council: finished').isVisible(),true,'Cards stay visible when earlier steps fold');
  assert.equal(await page.getByText('cargo test',{exact:true}).isVisible(),false,'Ordinary steps still fold');
  if(process.env.DELEGATE_SCREENSHOT)await page.screenshot({path:process.env.DELEGATE_SCREENSHOT});

  await card('Council: finished').click();await page.locator('.conversation-task-prompt').waitFor();assert.deepEqual(taskReads.slice(0,1),['a3']);
  const view=page.locator('.conversation-task'),body=view.locator('.conversation-task-body'),bounds=selector=>page.locator(selector).evaluate(node=>{const r=node.getBoundingClientRect();return [r.left,r.top,r.width,r.height];});
  assert.deepEqual(await bounds('.conversation-task'),await bounds('.conversation-panel'),'The subagent fills the Conversation, not a pop-up');
  assert.match(await view.locator('.conversation-subagent-chip').textContent(),/^Subagent of· Switchboard$/);
  assert.match(await view.locator('.conversation-subagent-prompt summary').textContent(),/Act as the reviewer for this task\.$/);
  assert.equal(await body.getByText('Read the relay closely.').count(),0,'The prompt stays folded to its first line');
  assert.equal(await view.locator('.conversation-task-status').textContent(),'Haiku 5.5 · Worked for 1m 5s');
  await page.setViewportSize({width:1000,height:640});
  const lefts=await Promise.all(['.conversation-subagent-of','.conversation-task-status'].map(selector=>bounds(selector).then(box=>box[0])));assert.equal(lefts[0],lefts[1],'The status sits in the centred column');
  await page.setViewportSize({width:390,height:844});
  assert.equal(await view.locator('h3').textContent(),'Council: finished');
  await body.getByText('I will read the relay first.',{exact:true}).waitFor();await body.getByText('One bug found.',{exact:true}).waitFor();
  assert.equal(await view.locator('.conversation-subagent-steps summary').textContent(),'>_Ran 3 commands, read 1 file');
  assert.equal(await body.getByText('Ran rg poll',{exact:true}).isVisible(),false);
  await view.locator('.conversation-subagent-steps summary').click();assert.equal(await body.getByText('Ran rg poll',{exact:true}).isVisible(),true);
  if(process.env.DELEGATE_SCREENSHOT)await page.screenshot({path:process.env.DELEGATE_SCREENSHOT.replace(/\.png$/,'-open.png')});
  await page.keyboard.press('Escape');assert.equal(await view.isVisible(),false,'Escape leaves the subagent');assert.equal(escapes,0,'and does not interrupt the agent');

  assert.equal(await meta('Council: Sol'),'6.1 Sol · Extra High · Finished');
  await card('Council: Sol').click();await view.locator('.conversation-task-output').waitFor();
  assert.equal(await view.locator('.conversation-task-output').textContent(),'VERDICT: <b>APPROVE</b>\n','Output is text, never markup');
  assert.equal(await view.locator('.conversation-task-status').textContent(),'6.1 Sol · Extra High · Worked for 2m 0s');
  assert.match(await view.locator('.conversation-subagent-prompt summary').textContent(),/codex exec/);assert.equal(await view.locator('.conversation-subagent-chip').count(),1);
  await view.locator('.conversation-task-parent').click();

  delegates=delegates.map(item=>item.call==='opus'?{...item,status:'completed',ended:new Date(Date.parse(started)+61000).toISOString()}:item);
  await page.evaluate(()=>intervals.forEach(fn=>fn()));
  await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-delegate-meta')].some(node=>node.textContent==='Opus 5.5 · High · Finished'));
  assert.equal(await time('Switchboard performance'),'1m 1s');

  delegates=delegates.map(item=>item.call==='sol'?{...item,status:'running',ended:null}:item);
  await page.evaluate(()=>{current.state='ready';});await page.evaluate(()=>intervals.forEach(fn=>fn()));
  await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-delegate')].some(node=>node.textContent.includes('foreground')&&node.dataset.status==='ended'));
  assert.equal(await meta('Council: Sol'),'6.1 Sol · Extra High · Running','A background agent outlives its parent going idle');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
