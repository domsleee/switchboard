const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Conversation shows the model, animates real work and keeps delivery receipts separate',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 let model='gpt-6.1-sol',effort='medium',background=[];
 const taskReads=[],taskPages={
  a1:{task:{id:'a1',kind:'agent',running:true},start_cursor:0,message_count:3,messages:[{role:'user',text:'Audit the relay carefully'},{role:'assistant',phase:'commentary',kind:'tool',tool:'run',text:'Ran cargo test'},{role:'assistant',text:'Found one bug so far'}]},
  bshell:{task:{id:'bshell',kind:'shell',running:true,command:'cargo test --lib',events:[]},output:'test result: <b>ok</b>\n'},
  bwatch:{task:{id:'bwatch',kind:'monitor',running:true,command:'tail -F log',events:['first event','second event']},output:null},
  old:{model:null,messages:[]},
 };
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://activity.test/**',route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.endsWith('/codex/reply'))return route.fulfill({json:{status:'queued'}});
   if(p.endsWith('/codex/receipt'))return route.fulfill({json:{status:'queued'}});
   if(p.startsWith('/api/chats/')&&url.searchParams.get('task')){taskReads.push(Object.fromEntries(url.searchParams));return route.fulfill({json:taskPages[url.searchParams.get('task')]});}
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{model,reasoning_effort:effort,background_agents:background,session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'Earlier answer',model:'gpt-6.1-sol',reasoning_effort:'low'},{role:'user',text:'Go on'},{role:'assistant',text:'Newer answer',model:'gpt-6.1-sol',reasoning_effort:'medium'}],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,title:'Switchboard',agent:'codex',state:'ready',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://activity.test/');await page.getByText('Earlier answer',{exact:true}).waitFor();
  const activity=page.locator('.conversation-activity'),working=page.locator('.conversation-working');
  assert.equal(await activity.textContent(),'Ready');assert.equal(await page.locator('.conversation-model').textContent(),'6.1 Sol Medium');assert.equal(await page.locator('.conversation-model .conversation-effort').textContent(),'Medium','The effort is a separate, dimmer word');
  const labels=page.locator('.conversation-message.assistant .conversation-label');
  assert.equal(await labels.first().textContent(),'Codex');
  assert.equal(await labels.last().textContent(),'Codex');assert.equal(await page.locator('.conversation-compose .conversation-model').count(),1,'The model shows once, in the composer');
  // Speaker labels stay for screen readers; layout shows who is speaking.
  for(const label of await page.locator('.conversation-label').all()){const box=await label.boundingBox();assert.ok(!box||box.width<=1&&box.height<=1,'Speaker labels are visually hidden, even after a user message');}
  assert.equal(await page.locator('.conversation-compose .conversation-model .conversation-model-icon svg').count(),1,'The model button shows the provider icon');
  assert.equal(await working.isVisible(),false);
  await page.getByLabel('Reply draft').fill('Please continue');await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.locator('.conversation-outgoing').getByText('Queued',{exact:true}).waitFor();
  assert.equal(await working.isVisible(),false,'Queue acknowledgement must not pretend the agent is working');
  await page.evaluate(()=>{current.state='working';SwitchboardConversation.update();});
  assert.equal(await activity.textContent(),'Working…');assert.equal(await page.locator('.conversation-model').textContent(),'6.1 Sol Medium');
  assert.equal(await working.isVisible(),true);
  assert.equal(await working.evaluate(node=>getComputedStyle(node.firstElementChild).animationName),'conversation-sweep');
  assert.equal(await activity.evaluate(node=>getComputedStyle(node,'::before').animationName),'conversation-pulse');
  assert.equal(await page.getByText('Waiting for agent…',{exact:true}).count(),0);
  assert.equal(await page.locator('.conversation-messages').evaluate(node=>[...node.children].filter(child=>!child.hidden).pop().className),'conversation-working');
  if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation-working.png'});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await working.evaluate(node=>getComputedStyle(node.firstElementChild).animationName),'conversation-sweep','The Thinking sweep ignores reduced motion');
  await page.emulateMedia({reducedMotion:'no-preference'});
  model='gpt-6-astra';effort='high';
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);
  await page.waitForFunction(()=>document.querySelector('.conversation-model').textContent==='6 Astra High');assert.equal(await activity.textContent(),'Working…');
  assert.equal(await labels.first().textContent(),'Codex');
  for(const state of ['ready','approval','input']){
   await page.evaluate(state=>{current.state=state;SwitchboardConversation.update();},state);
   assert.equal(await working.isVisible(),false,state+' must stop the animation');
   assert.equal(await activity.evaluate(node=>getComputedStyle(node,'::before').animationName),'none');
  }
  // A background agent outliving the reply keeps the live row while the transcript cannot name it.
  await page.evaluate(()=>{current.state='waiting';SwitchboardConversation.update();});
  assert.equal(await working.isVisible(),true,'A running background agent shows in the transcript');
  assert.equal(await page.locator('.conversation-working-step').getAttribute('data-step'),'Waiting on a background task');
  assert.equal(await working.evaluate(node=>getComputedStyle(node.firstElementChild).animationName),'none','Only Thinking sweeps');
  assert.equal(await activity.evaluate(node=>getComputedStyle(node,'::before').animationName),'none');
  const refreshPage=()=>Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);
  const agents=page.locator('.conversation-agent'),rows=()=>agents.evaluateAll(nodes=>nodes.map(node=>[...node.children].map(child=>child.textContent||child.className)));
  // Named agents get a row each, with the Claude mark, the task, its model and time since launch.
  background=[{id:'a1',kind:'agent',description:'Review the diff',model:'claude-opus-5-5',started:new Date(Date.now()-125000).toISOString()},{id:'a2',kind:'agent',description:'Run the e2e suite',model:'claude-sonnet-5-5',started:new Date(Date.now()-3000).toISOString()}];await refreshPage();
  await agents.nth(1).waitFor();
  assert.equal(await working.isVisible(),false,'Named rows replace the generic row');
  const [first,second]=await rows();
  assert.deepEqual(first.slice(0,3),['conversation-agent-avatar','Review the diff','Opus 5.5']);assert.match(first[3],/^2m \d+s$/,'Each row counts from its own launch');
  assert.deepEqual(second.slice(0,3),['conversation-agent-avatar','Run the e2e suite','Sonnet 5.5']);assert.match(second[3],/^\d+s$/);
  assert.equal(await agents.first().locator('svg').count(),1);
  assert.equal(await agents.first().locator('.conversation-agent-avatar').evaluate(node=>getComputedStyle(node,'::after').animationName),'conversation-spin');
  assert.equal(await page.locator('.conversation-messages').evaluate(node=>[...node.children].filter(child=>!child.hidden).pop().className),'conversation-background');
  if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation-background-agents.png'});
  await page.evaluate(()=>{current.state='ready';SwitchboardConversation.update();});
  assert.equal(await page.locator('.conversation-background').isVisible(),false,'The rows leave once the agents finish');
  assert.equal(await working.isVisible(),false);
  // A row opens what its task is doing: an agent's steps, a shell's command and output.
  const dialog=page.locator('.conversation-task'),body=page.locator('.conversation-task-body');
  await page.evaluate(()=>{current.state='waiting';SwitchboardConversation.update();});
  await agents.first().click();await body.getByText('Ran cargo test',{exact:true}).waitFor();
  assert.equal(await page.locator('.conversation-task h3').textContent(),'Review the diff');
  assert.match(await page.locator('.conversation-task-status').textContent(),/^Opus 5\.5 · Working for 2m \d+s$/);
  await body.getByText('Found one bug so far',{exact:true}).waitFor();
  assert.match(await body.locator('.conversation-task-prompt summary').textContent(),/Audit the relay carefully$/);
  assert.equal(await body.getByText('Audit the relay carefully').count(),1,'The prompt shows once');
  assert.equal(taskReads.at(-1).host,'fixture');assert.equal(taskReads.at(-1).tail,'true');
  if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation-background-detail.png'});
  await page.locator('.conversation-task-parent').click();assert.equal(await dialog.isVisible(),false);
  await page.evaluate(()=>{current.state='waiting';SwitchboardConversation.update();});
  background=[{id:'bshell',kind:'shell',description:'Run the relay tests',model:null,started:new Date(Date.now()-5000).toISOString()},{id:'bwatch',kind:'monitor',description:'Watch the log',model:null,started:new Date(Date.now()-5000).toISOString()},{description:'Unaddressable',model:null,started:new Date(Date.now()-5000).toISOString()}];await refreshPage();
  await agents.nth(2).waitFor();
  const [shellRow,monitorRow]=await rows();
  assert.deepEqual(shellRow.slice(1,3),['Run the relay tests','Shell'],'A shell is named as one');assert.deepEqual(monitorRow.slice(1,3),['Watch the log','Monitor']);
  assert.equal(await agents.nth(2).evaluate(node=>node.tagName),'DIV','A row from an older computer has nothing to open');
  await agents.first().click();await body.locator('.conversation-task-output').nth(1).waitFor();
  assert.equal(await body.locator('.conversation-task-output.command').textContent(),'cargo test --lib');
  assert.equal(await body.locator('.conversation-task-output').nth(1).textContent(),'test result: <b>ok</b>\n','Output is text, never markup');
  // A shell that ends with the dialog open still shows how it ended.
  taskPages.bshell={task:{id:'bshell',kind:'shell',running:false,command:'cargo test --lib',events:[]},output:'all done\n'};
  await body.getByText('all done',{exact:false}).waitFor({timeout:6000});
  assert.equal(await page.locator('.conversation-task-status').textContent(),'Shell · Finished');
  await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),false);
  await agents.nth(1).click();await body.getByText('second event',{exact:false}).waitFor();await page.keyboard.press('Escape');
  // A council: one Claude agent and one Codex run started from a shell.
  background=[{id:'a1',kind:'agent',description:'Council review (Opus)',model:'claude-opus-5-5',started:new Date(Date.now()-40000).toISOString()},{id:'bsol',kind:'shell',agent:'codex',description:'Run the GPT Sol review',model:'gpt-6.1-sol',started:new Date(Date.now()-39000).toISOString()}];await refreshPage();
  await agents.filter({hasText:'GPT Sol review'}).waitFor();
  const council=await rows();
  assert.deepEqual(council.map(row=>row.slice(1,3)),[['Council review (Opus)','Opus 5.5'],['Run the GPT Sol review','6.1 Sol']],'Each delegate names its own model');
  assert.deepEqual(await agents.locator('.conversation-agent-avatar svg').evaluateAll(icons=>icons.map(icon=>getComputedStyle(icon).fill)),['rgb(217, 119, 87)','rgb(201, 209, 220)'],'Each delegate shows its own provider');
  assert.match(await agents.nth(1).getAttribute('aria-label'),/background agent: Run the GPT Sol review, 6\.1 Sol/);
  if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation-council.png'});
  background=[{id:'old',description:'Computer without the task read',model:null,started:new Date().toISOString()}];await refreshPage();
  await page.waitForFunction(()=>document.querySelector('.conversation-agent-title')?.textContent==='Computer without the task read');
  await agents.first().click();await page.getByText('This computer needs an update to show this task.').waitFor();await page.keyboard.press('Escape');
  background=[];await refreshPage();
  await page.evaluate(()=>{current.state='waiting';SwitchboardConversation.update();});
  assert.equal(await page.locator('.conversation-working-step').getAttribute('data-step'),'Waiting on a background task','Without a launch record the row stays generic');
  model=null;effort=null;
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);
  await page.waitForFunction(()=>document.querySelector('.conversation-model').textContent==='Codex');assert.equal(await activity.textContent(),'Waiting on an agent');
  await page.evaluate(()=>{current={...current,key:'shell',agent:null,chatId:null,state:'unknown'};SwitchboardConversation.update();});
  assert.equal(await page.locator('.conversation-notice').textContent(),'No agent');assert.equal(await working.isVisible(),false);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
