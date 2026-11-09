// Exercise the shipped page and app, including the real sidebar and view lifecycle.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('integrated Conversation journeys use production markup and preserve delivery, reading and navigation',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const uploadRoot='/home/fixture/.local/share/switchboard/attachments/11111111-2222-4333-8444-555555555555/';
 const portrait='<svg xmlns="http://www.w3.org/2000/svg" width="240" height="640"><rect width="240" height="640" fill="#426180"/></svg>';
 async function fixture(options={}){
  const page=await browser.newPage({viewport:options.viewport||{width:390,height:844},isMobile:!options.desktop,hasTouch:!options.desktop});page.setDefaultTimeout(7000);
  if(options.clock)await page.clock.install();
  const f={page,escapes:[],settles:[],errors:[],connections:[],requests:[],preparations:[],timings:[],claudeReplies:[],claudeReplyStatus:404,history:new Map([[1,options.messages||[{role:'assistant',text:'Review response',model:'gpt-6.1-sol',reasoning_effort:'medium'}]],[2,[{role:'assistant',text:'Second conversation'}]]]),agent:options.agent||'codex',state:'ready',bound:options.bound!==false,model:'gpt-6.1-sol',effort:'medium',replyMode:'queue',autoHistory:false,prepareStatus:200,tabs:[1,2],newTabs:[],releaseReplies:[],releaseImages:[],delayImages:!!options.delayImages};
  await page.addInitScript(()=>{localStorage.setItem('switchboard-mobile-view-mode','conversation');localStorage.setItem('switchboard-view-mode','conversation');window.reviewIntervals=[];window.setInterval=fn=>reviewIntervals.push(fn);window.reviewOffset=0;const now=Date.now.bind(Date);Date.now=()=>now()+reviewOffset;window.reviewPastes=[];window.reviewHoldBridge=false;});
  const pane=id=>({pane_id:id,is_plugin:false,tab_id:id,tab_position:id-1,title:'Conversation '+id,is_focused:true,...(f.paneCwd?{cwd:f.paneCwd}:{})});
  const thread=id=>'00000000-0000-4000-8000-'+String(id).padStart(12,'0');
  f.receipt=payload=>({role:'user',text:payload.slice(0,4000),...(payload.length>4000?{truncated:true,receipt_text:payload}:{}),...(payload.includes('\n\nAttached files:\n')?{markdown:[{type:'start',tag:'p'},{type:'text',text:payload.split('\n\nAttached files:\n')[0].slice(0,4000)},{type:'end'}],attachments:payload.split('\n\nAttached files:\n')[1].split('\n').map(url=>({kind:'image',name:url.split('/').at(-1),url}))}:{})});
  await page.route('http://conversation-review.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value}).catch(()=>{});
   if(p==='/api/health')return json({});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'fixture',name:'Fixture desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/hosts/fixture/escape'){f.escapes.push(route.request().postDataJSON());return json({ok:true});}
   if(p==='/api/hosts/fixture/settle-interrupt'){f.settles.push(route.request().postDataJSON());return json({ok:true});}
   if(p==='/api/attention'){if(url.searchParams.has('after'))return new Promise(()=>{});return json({tabs:f.tabs.map(id=>({host:'fixture',session:'main',id,position:id-1,name:'Conversation '+id,panes:[pane(id)]})),panes:f.tabs.map(id=>({host:'fixture',session:'main',pane_id:id,...(f.agent?{agent:f.agent}:{}),state:f.state,turn_state:options.turnState,...(f.bound?{chat_id:(f.chatPrefix||'chat-')+id}:{})})),errors:[]});}
   if(p.startsWith('/api/chats/')&&url.searchParams.has('task'))return json({task:{kind:'agent',running:false},start_cursor:0,messages:[{role:'user',text:'Review this change.'},{role:'assistant',text:'Review complete.'}]});
   if(p.startsWith('/api/chats/')){const id=Number(p.split('-').at(-1));return json({id:'chat-'+id,...(f.project?{project:f.project}:{}),model:f.model,reasoning_effort:f.effort,delegates:options.delegates||[],session_id:f.agent==='codex'?thread(id):null,messages:f.history.get(id)||[],message_activity:f.activities?.get(id)||[],start_cursor:0,next_cursor:null});}
   if(p.endsWith('/conversation/reply')){f.claudeReplies.push(route.request().postDataJSON());if(f.holdClaudeReply)await new Promise(resolve=>f.releaseReplies.push(resolve));return route.fulfill({status:f.claudeReplyStatus,json:{ok:true}});}
   if(p==='/api/diagnostics/timing'){f.timings.push(route.request().postDataJSON());return route.fulfill({status:204});}
   if(p.endsWith('/conversation/prepare')){f.preparations.push(route.request().postDataJSON());return route.fulfill({status:f.prepareStatus,json:{trusted:false}});}
   if(p.endsWith('/codex/reply')){
    const data=route.request().postDataJSON(),id=Number(data.thread.slice(-12));f.requests.push(data);
    if(f.replyMode==='failed')return route.fulfill({status:503,json:{status:'failed',detail:'Codex could not accept this answer.'}});
    if(f.replyMode==='unknown')return route.fulfill({status:409,json:{status:'unknown',detail:'Queue outcome is uncertain; this key will not submit again.'}});
    if(f.autoHistory)f.history.get(id).push(f.receipt(data.message));
    if(f.replyMode==='hold')await new Promise(resolve=>f.releaseReplies.push(resolve));
    if(f.replyMode==='lost')return route.abort();
    return json({status:'queued'});
   }
   if(p.endsWith('/attachments'))return json({path:uploadRoot+url.searchParams.get('name')});
   if(p.endsWith('/file')){if(f.delayImages)await new Promise(resolve=>f.releaseImages.push(resolve));return route.fulfill({contentType:'image/svg+xml',body:portrait}).catch(()=>{});}
   if(p.endsWith('/new-tab')&&route.request().method()==='POST'){f.newTabs.push(route.request().postDataJSON());if(f.holdCreation)await new Promise(resolve=>f.releaseCreation=resolve);return json({pane_id:3,tab_id:3});}
   if(p.startsWith('/hosts/')){
    f.connections.push(p);
    return route.fulfill({contentType:'text/html',body:`<script>let active=${JSON.stringify(pane(1))};const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',active_pane:active,panes:${JSON.stringify(f.tabs.map(pane))}}},location.origin);addEventListener('message',event=>{const data=event.data;if(data.type==='zellij-focus'){if(!data.preserve_focus)window.frameElement.focus();active=${JSON.stringify(f.tabs.map(pane))}.find(p=>p.pane_id===data.pane_id);state(data.focus_id);}else if(data.type==='zellij-conversation-paste'){parent.reviewPastes.push(data);if(!parent.reviewHoldBridge)parent.postMessage({type:'zellij-conversation-paste-result',id:data.id,ok:true},location.origin);}else if(data.type==='zellij-interrupt'){(parent.reviewInterrupts||=[]).push(data);parent.postMessage({type:'zellij-interrupt-result',id:data.id,ok:!parent.reviewRefuseInterrupt},location.origin);}});state();</script>`});
   }
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  f.refresh=()=>page.evaluate(()=>refreshAttention(true));
  f.poll=async()=>{await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>reviewIntervals.forEach(fn=>fn()))]);await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);};
  f.select=id=>page.evaluate(id=>activate(allTabs().find(item=>item.tab.id===id)),id);
  f.upload=async()=>{const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach files',exact:true}).click();await(await choosing).setFiles({name:'portrait.svg',mimeType:'image/svg+xml',buffer:Buffer.from(portrait)});await page.locator('.conversation-attachment').getByText('Ready',{exact:true}).waitFor();};
  f.release=()=>{f.releaseCreation?.();f.releaseReplies.splice(0).forEach(fn=>fn());f.releaseImages.splice(0).forEach(fn=>fn());};
  f.close=async()=>{f.release();assert.deepEqual(f.errors,[]);await page.close();};
  page.on('pageerror',error=>f.errors.push(error.message));
  await page.goto('http://conversation-review.test/?host=fixture&session=main&tab=1',{waitUntil:'domcontentloaded'});
  if(f.bound)await page.getByLabel('Reply draft').waitFor();else await page.locator('.conversation-notice').waitFor();
  return f;
 }
 try{
  await t.test('Performance dashboard preserves conversation drafts, terminal connections and review state',async()=>{
   const f=await fixture({desktop:true,viewport:{width:1280,height:900}}),{page}=f;
   try{
    const acknowledgements=[];
    await page.route('**/api/timings',route=>route.fulfill({json:{computers:[{name:'Fixture Mac',local:true,series:[]}]}}));
    await page.route('**/api/attention/ack',route=>{acknowledgements.push(route.request().postDataJSON());return route.fulfill({json:{}});});
    await page.getByLabel('Reply draft').fill('Keep this draft while checking performance');
    const selected=await page.evaluate(()=>selected);
    for(const mode of ['Conversation','Terminal']){
     await page.getByRole('button',{name:mode,exact:true}).click();
     await page.evaluate(()=>{window.perfFrames=[...document.querySelectorAll('#terminals>iframe')];window.perfSources=perfFrames.map(frame=>frame.getAttribute('src'));window.perfCommands=[];for(const frame of perfFrames){const send=frame.contentWindow.postMessage;frame.contentWindow.postMessage=function(message,...args){if(document.querySelector('#panel').open)perfCommands.push(message.type);return send.call(frame.contentWindow,message,...args);};}});
     const connections=f.connections.length;
     await page.getByRole('button',{name:'Performance dashboard',exact:true}).click();
     await page.getByText('Performance dashboard',{exact:true}).waitFor();
     await page.locator('#timing-computer').selectOption('Fixture Mac');
     const reviews=acknowledgements.length;await f.refresh();
     await page.keyboard.press('Alt+l');
     assert.equal(await page.evaluate(()=>selected),selected,'Dialog keeps tab navigation shortcuts inside it');
     assert.equal(acknowledgements.length,reviews,'Refreshing attention behind the dashboard does not acknowledge other output');
     assert.equal(f.connections.length,connections,'Dashboard does not attach a viewer');
     assert.equal(await page.evaluate(()=>perfFrames.every((frame,i)=>frame===document.querySelectorAll('#terminals>iframe')[i]&&frame.getAttribute('src')===perfSources[i])),true);
     assert.deepEqual(await page.evaluate(()=>perfCommands.filter(type=>/focus|size-owner/.test(type))),[],'Dashboard does not send terminal focus or sizing requests');
     await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#panel').open);
     if(mode==='Conversation')assert.equal(await page.getByLabel('Reply draft').evaluate(node=>node===document.activeElement),true,'Closing returns focus to the draft');
     else await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')===document.activeElement);
    }
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft while checking performance');
   }finally{await f.close();}
  });
  await t.test('GitHub preview owns Escape, keeps drafts, and closes on navigation',async()=>{
   const f=await fixture({desktop:true,viewport:{width:1400,height:900},messages:[{role:'assistant',text:'Review https://github.com/example/project/pull/42'}]}),{page}=f;
   try{
    await page.route('**/conversation/github',route=>route.fulfill({json:{__typename:'PullRequest',title:'Review change',state:'OPEN',body:'Description',author:{login:'reviewer'},headRefName:'feature',baseRefName:'main',additions:1,deletions:0,changedFiles:1}}));
    const link=page.getByRole('link',{name:'https://github.com/example/project/pull/42',exact:true}),preview=page.getByRole('complementary',{name:'GitHub preview'});
    await page.getByLabel('Reply draft').fill('Keep this draft');await link.click();await preview.getByRole('heading',{name:'Review change'}).waitFor();
    await page.keyboard.press('Escape');assert.equal(await preview.isVisible(),false);assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(f.escapes.length,0);
    assert.equal(await link.evaluate(n=>n===document.activeElement),true);assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft');
    await link.click();await preview.getByRole('heading',{name:'Review change'}).waitFor();await page.keyboard.press('Alt+l');assert.equal(await preview.isVisible(),false);await page.getByText('Second conversation',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await preview.isVisible(),false);await page.keyboard.press('Alt+h');
    await page.getByRole('button',{name:'Conversation',exact:true}).click();assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft');
    assert.equal(await page.locator('#terminals').evaluate(n=>n.classList.contains('github-open')),false);
   }finally{await f.close();}
  });
  await t.test('Claude background-agent dialogs retain attention in Conversation and Terminal',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1100,height:800}}),{page}=f;
   try{
    const row=page.locator('#tabs .tab-select.selected');
    for(const mode of ['Conversation','Terminal']){
     await page.getByRole('button',{name:mode,exact:true}).click();
     f.state='waiting';await f.refresh();
     assert.equal(await row.locator('.star.attention').count(),0);
     if(process.env.CLAUDE_APPROVAL_SCREENSHOTS)await row.screenshot({path:path.join(process.env.CLAUDE_APPROVAL_SCREENSHOTS,mode.toLowerCase()+'-before.png')});
     for(const [state,label] of [['approval','Approval needed'],['input','Input needed']]){
      f.state=state;await f.refresh();
      assert.equal(await row.getAttribute('data-agent-state'),label);
      assert.equal(await row.locator('.star.attention').count(),1);
      await page.evaluate(()=>acknowledgeAttention(allTabs().find(item=>item.key===selected)));
      await f.refresh();
      assert.equal(await row.locator('.star.attention').count(),1,'Viewing the tab cannot clear an unresolved dialog');
      if(state==='approval'&&process.env.CLAUDE_APPROVAL_SCREENSHOTS)await row.screenshot({path:path.join(process.env.CLAUDE_APPROVAL_SCREENSHOTS,mode.toLowerCase()+'-after.png')});
     }
     f.state='waiting';await f.refresh();
     assert.equal(await row.locator('.star.attention').count(),0,'Resolving the dialog returns to the parent wait');
    }
   }finally{await f.close();}
  });
  for(const desktop of [true,false])await t.test(`Alt+T creates a tab from the subagent view (${desktop?'desktop':'phone'})`,async()=>{
   const f=await fixture({desktop,viewport:desktop?{width:1280,height:844}:{width:390,height:844},delegates:[{call:'review',id:'review-agent',model:'gpt-6.1-sol',effort:'xhigh',status:'completed'}],messages:[{role:'assistant',phase:'commentary',kind:'tool',tool:'agent',call:'review',detail:'Review changes',text:'Delegated Review changes'}]}),{page}=f;
   try{
    await page.route('**/project-list',route=>route.fulfill({json:['switchboard']}));
    await page.route('**/model-list',route=>route.fulfill({json:{}}));
    await page.locator('.conversation-delegate').click();
    const view=page.locator('.conversation-task');await view.getByText('Review complete.',{exact:true}).waitFor();
    if(process.env.SUBAGENT_SCREENSHOTS&&desktop)await view.screenshot({path:path.join(process.env.SUBAGENT_SCREENSHOTS,'subagent.png')});
    await page.keyboard.press('Alt+t');await page.locator('#new-tab-prompt').waitFor();
    await page.locator('#new-tab-prompt').fill('A fresh task');
    await page.keyboard.press('Alt+t');assert.equal(await page.locator('#new-tab-prompt').textContent(),'A fresh task','A modal dialog keeps its own keys');
    await page.keyboard.press('Escape');await page.locator('#new-tab-dialog:not([open])').waitFor({state:'attached'});
    assert.equal(await view.isVisible(),true,'Cancel returns to the subagent');
    assert.equal(await view.evaluate(node=>node.contains(document.activeElement)),true,'Focus returns to the subagent');
    await page.keyboard.press('Alt+t');await page.locator('#new-tab-prompt').fill('A fresh task');
    await page.locator('#new-tab-form button[type=submit]').click();
    await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.id===3);
    assert.equal(f.newTabs.length,1);assert.equal(f.newTabs[0].prompt,'A fresh task');
    await view.waitFor({state:'hidden'});assert.deepEqual(f.escapes,[],'Opening a tab never interrupts the parent');
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.waitForFunction(()=>!SwitchboardConversation.wantsConversation());
    await page.keyboard.press('Alt+t');await page.locator('#new-tab-prompt').waitFor();await page.keyboard.press('Escape');
   }finally{await f.close();}
  });
  const asyncQuestion=(id,questions)=>({role:'assistant',text:questions.map(q=>q.title).join('\n'),phase:'final',async_question:{id,questions}});
  const questionReceipt=payload=>{const replies=JSON.parse(payload.split('\n')[1]);return {role:'user',text:replies.map(reply=>'> '+reply.question+'\n\n'+reply.answer).join('\n\n'),question_replies:replies.map(reply=>({id:reply.questionItemId,question:reply.question,answer:reply.answer}))};};
  await t.test('agent message links select the counterpart in the real sidebar and keep drafts and view mode',async()=>{
   for(const viewport of [{width:390,height:844},{width:1280,height:844}]){
    const f=await fixture({viewport}),{page}=f;try{
     f.activities=new Map([[1,[{id:'native:fixture:exchange-1',direction:'sent',status:'queued',timestamp:Date.now(),text:'Configure the workspace.',peer:{label:'Workspace setup',computer:'Fixture desktop',host:'fixture',chat_id:'chat-2'}}]]]);
     await f.poll();await page.getByLabel('Reply draft').fill('Keep the source draft');
     await page.locator('.conversation-mail summary').click();await page.locator('.conversation-mail').getByRole('button',{name:'Open tab'}).click();
     await page.getByText('Second conversation',{exact:true}).waitFor();
     assert.equal(await page.evaluate(()=>allTabs().find(item=>item.key===selected).tab.id),2,'Open tab activates the destination, beyond focusing its terminal');
     assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
     assert.deepEqual(f.connections,[],'Following a conversation link must not attach terminal viewers');
     await page.getByLabel('Reply draft').press('Alt+h');await page.locator('.conversation-mail').waitFor();
     assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep the source draft');
     assert.equal(await page.locator('.conversation-mail .conversation-mail-status').textContent(),'Queued','Navigation never acknowledges a message');
     await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow);
     await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.locator('.conversation-mail').waitFor();
     assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep the source draft');
    }finally{await f.close();}
   }
  });
  await t.test('question URLs open separately and preserve drafts across view modes',async()=>{
   for(const viewport of [{width:1100,height:800},{width:390,height:844}]){
    const url='https://github.com/example/project/pull/483';
    const title=`Question-fix PR #483 (${url}) is blocked. See https://example.com/guide_(ci). Should I wait? <img src=x onerror=alert(1)> javascript:alert(1)`;
    const f=await fixture({viewport,desktop:viewport.width>700,messages:[asyncQuestion('links',[{title,options:['Wait','Defer']}])]}),{page}=f;
    try{
     f.state='input';await f.refresh();
     const card=page.getByRole('region',{name:'Codex question'}),link=card.getByRole('link',{name:url,exact:true});
     assert.equal(await link.getAttribute('href'),url);
     assert.equal(await link.getAttribute('target'),'_blank');
     assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
     assert.equal(await card.getByRole('link',{name:'https://example.com/guide_(ci)',exact:true}).getAttribute('href'),'https://example.com/guide_(ci)');
     assert.equal(await card.locator('a').count(),2);assert.equal(await card.locator('img').count(),0);
     assert.equal(await card.locator('.conversation-question-text').textContent(),title);
     await page.getByLabel('Reply draft').fill('Continue other work');
     await card.getByRole('button',{name:'Write a different answer',exact:true}).click();
     await card.getByRole('textbox').fill('Check again later');
     await page.context().route(url,route=>route.fulfill({contentType:'text/html',body:'<title>Pull request</title>'}));
     const opened=page.waitForEvent('popup');await link.click();const popup=await opened;
     await popup.waitForLoadState();assert.equal(popup.url(),url);assert.equal(await popup.evaluate(()=>window.opener),null);await popup.close();
     await page.getByRole('button',{name:'Terminal',exact:true}).click();
     await page.getByRole('button',{name:'Conversation',exact:true}).click();
     assert.equal(await card.getByRole('textbox').inputValue(),'Check again later');
     assert.equal(await page.getByLabel('Reply draft').inputValue(),'Continue other work');
     assert.equal(f.requests.length,0);await link.focus();assert.equal(await link.evaluate(el=>document.activeElement===el),true);
     assert.equal(await card.locator('.conversation-async-toggle').getAttribute('aria-expanded'),'true');
    }finally{await f.close();}
   }
  });
  await t.test('claude.ai links follow the Settings browser rule, except on touch devices',async()=>{
   const claude='https://claude.ai/code/session_1',other='https://example.com/docs';
   const messages=[{role:'assistant',text:'links',markdown:[{type:'start',tag:'p'},{type:'start',tag:'a',url:claude},{type:'start',tag:'strong'},{type:'text',text:'Open chat'},{type:'end'},{type:'end'},{type:'text',text:' or '+other},{type:'end'}]}];
   for(const desktop of [true,false]){
    const f=await fixture({desktop,viewport:desktop?{width:1100,height:800}:{width:390,height:844},messages}),{page}=f,posted=[];
    try{
     await page.context().route(/^https:\/\/(claude\.ai|example\.com)\//,route=>route.fulfill({contentType:'text/html',body:'<title>Link</title>'}));
     await page.route('**/api/open-link',route=>{posted.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});});
     await page.evaluate(()=>{groups.fixture='work';settingOverrides['link-app-work']='Work Browser';});
     const chat=page.getByRole('link',{name:'Open chat',exact:true}),external=page.getByRole('link',{name:other,exact:true});
     const opensHere=async action=>{const before=posted.length,popup=page.waitForEvent('popup');await action();await (await popup).close();assert.equal(posted.length,before,'A link opened here does not also open in the other browser');};
     if(!desktop){await opensHere(()=>chat.tap());continue;}
     const popups=[];page.on('popup',popup=>popups.push(popup));
     const opensThere=async action=>{const response=page.waitForResponse('**/api/open-link',{timeout:3000});await action();await response;assert.deepEqual(posted.at(-1),{url:claude,app:'Work Browser'});await page.waitForTimeout(100);assert.equal(popups.length,0,'A routed link must not also open here');};
     await opensThere(()=>chat.locator('strong').click());
     await opensThere(()=>chat.click({button:'middle'}));
     await opensThere(()=>chat.click({modifiers:['ControlOrMeta']}));
     await opensHere(()=>external.click());
     await chat.click({button:'right'});await page.waitForTimeout(100);assert.equal(posted.length,3,'Right-click keeps the browser menu');
     await page.evaluate(()=>{settingOverrides['link-app-work']='';});
     await opensHere(()=>chat.click());
    }finally{await f.close();}
   }
  });
  await t.test('Codex async answers and ordinary follow-ups queue independently without opening Terminal',async()=>{
   for(const viewport of [{width:1100,height:800},{width:390,height:844}]){
    const q=asyncQuestion('q1',[{title:'Should I rename “Hidden” to “Settled”?',options:['Yes, use Settled','Keep the Hidden label']}]);
    const f=await fixture({viewport,desktop:viewport.width>700,messages:[q],turnState:'working'}),{page}=f;try{
     f.state='input';await f.refresh();
     const card=page.getByRole('region',{name:'Codex question'});
     await card.getByText(q.async_question.questions[0].title,{exact:true}).waitFor();
     assert.equal(await page.getByRole('button',{name:'Open Terminal',exact:true}).isVisible(),false);
     assert.equal(await page.locator('.conversation-working').isVisible(),true,'A question does not hide ongoing work');
     const draft=page.getByLabel('Reply draft');await draft.fill('Continue the other changes while I decide');
     if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,`codex-async-question-${viewport.width}.png`)});
     f.replyMode='hold';const keep=card.getByRole('button',{name:/Keep the Hidden label/});
     if(viewport.width>700){await keep.focus();await page.keyboard.press('Enter');}else await keep.click();
     await page.waitForFunction(()=>document.querySelector('.conversation-async-question').textContent.includes('Sending answer…'));
     assert.equal(await draft.inputValue(),'Continue the other changes while I decide');
     assert.equal(f.requests.length,1);
     const answers=JSON.parse(f.requests[0].message.split('\n')[1]);
     assert.deepEqual(answers,[{questionItemId:'q1',question:q.async_question.questions[0].title,answer:'Keep the Hidden label'}]);
     // A slow answer acknowledgement cannot hold the ordinary composer.
     f.replyMode='queue';f.autoHistory=true;await page.locator('.conversation-compose button[type=submit]').click();
     await page.waitForFunction(()=>!document.querySelector('.conversation-compose textarea').value);
     assert.equal(f.requests[1].message,'Continue the other changes while I decide');
     assert.equal(f.requests.length,2);assert.deepEqual(f.connections,[]);
     f.release();await card.getByText('Answer submitted',{exact:true}).waitFor();
     assert.equal(await card.getByRole('button',{name:'Show question and answer',exact:true}).getAttribute('aria-expanded'),'false');
     await card.getByRole('button',{name:'Show question and answer',exact:true}).click();
     assert.equal(await card.getByRole('button',{name:/Keep the Hidden label/}).isDisabled(),true);
     f.history.get(1).push(questionReceipt(f.requests[0].message));await f.poll();
     await card.getByText('Answered',{exact:true}).waitFor();
     assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');

     // A lost response retries the exact payload and receipt key.
     const q2=asyncQuestion('q2',[{title:'Which colour?',options:['Red','Blue']}]);
     f.history.get(1).push(q2);await f.poll();const second=card.filter({hasText:'Which colour?'});
     f.autoHistory=false;f.replyMode='lost';await second.getByRole('button',{name:/Blue/}).click();
     await second.getByRole('button',{name:'Retry',exact:true}).waitFor();
     const uncertain=f.requests.at(-1);f.replyMode='failed';await second.getByRole('button',{name:'Retry',exact:true}).click();
     await second.getByText('Codex could not accept this answer.',{exact:true}).waitFor();
     assert.deepEqual(f.requests.at(-1),uncertain,'An uncertain delivery keeps its receipt key');
     f.replyMode='queue';await second.getByRole('button',{name:'Retry',exact:true}).click();
     await second.getByText('Answer submitted',{exact:true}).waitFor();
     assert.equal(f.requests.at(-1).message,uncertain.message);assert.notEqual(f.requests.at(-1).send_key,uncertain.send_key,'A confirmed rejection permits a fresh attempt');assert.deepEqual(f.connections,[]);
     // Navigating to another chat and back preserves the pending answer and draft.
     await draft.fill('Keep my draft');await f.select(2);await f.select(1);
     assert.equal(await draft.inputValue(),'Keep my draft');
     await second.getByText('Answer submitted',{exact:true}).waitFor();
     await page.getByRole('button',{name:'Terminal',exact:true}).click();
     await page.waitForFunction(()=>[...sessions.values()].some(entry=>!entry.suspended));
     assert.equal(await page.locator('.tab-select.selected.needs-attention').count(),1);
     await page.getByRole('button',{name:'Conversation',exact:true}).click();
     await second.getByText('Answer submitted',{exact:true}).waitFor();
     assert.equal(await draft.inputValue(),'Keep my draft');
    }finally{await f.close();}
   }
  });
  await t.test('question drafts keep their input, focus and text through transcript changes and reloads',async()=>{
   for(const desktop of [true,false]){
    const q=asyncQuestion('draft-refresh',[{title:'Which colour should I use?',options:['Blue','Green']}]);
    const f=await fixture({desktop,viewport:desktop?{width:1100,height:800}:{width:390,height:844},messages:[q],turnState:'working'}),{page}=f;
    try{
     f.state='input';await f.refresh();const card=page.getByRole('region',{name:'Codex question'});
     await card.getByRole('button',{name:'Write a different answer',exact:true}).click();
     const answer=card.getByLabel('Type your own answer');await answer.fill('Blue');
     await answer.evaluate(node=>{window.questionDraftInput=node;node.setSelectionRange(1,3);});
     // The same question can acquire metadata or move when history is refreshed.
     f.history.set(1,[{role:'assistant',text:'Earlier progress.'},{...q,timestamp:'2026-11-08T08:00:00Z'}]);await f.poll();
     assert.equal(await answer.inputValue(),'Blue','A custom answer matching an option is still a draft');
     assert.deepEqual(await answer.evaluate(node=>[node===questionDraftInput,document.activeElement===node,node.selectionStart,node.selectionEnd]),[true,true,1,3],'Refreshing the same question preserves its input and selection');
     f.history.set(1,[{...q,timestamp:'2026-11-08T08:00:00Z'}]);await f.poll();
     assert.deepEqual(await answer.evaluate(node=>[node===questionDraftInput,document.activeElement===node,node.selectionStart,node.selectionEnd]),[true,true,1,3],'Removing an earlier transcript entry also preserves the question input and focus');
     f.activities=new Map([[1,[{id:'native:fixture:focus-probe',direction:'sent',status:'queued',timestamp:Date.parse('2026-11-08T07:00:00Z'),text:'Coordination note',peer:{label:'Another task'}}]]]);await f.poll();
     f.activities=new Map();await f.poll();
     assert.deepEqual(await answer.evaluate(node=>[node===questionDraftInput,document.activeElement===node,node.selectionStart,node.selectionEnd]),[true,true,1,3],'A disappearing activity row also preserves question focus');
     await answer.fill('Keep this answer while the agent works');
     await f.select(2);await f.select(1);assert.equal(await answer.inputValue(),'Keep this answer while the agent works');
     await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.getByRole('button',{name:'Conversation',exact:true}).click();
     assert.equal(await answer.inputValue(),'Keep this answer while the agent works');
     await page.reload();await answer.waitFor();assert.equal(await answer.inputValue(),'Keep this answer while the agent works','Reload restores unsent question text');
     assert.equal(f.requests.length,0,'Restoring a draft never sends it');
     await answer.press('Enter');await card.getByText('Answer submitted',{exact:true}).waitFor();
     await page.reload();await card.getByText('Answer submitted',{exact:true}).waitFor();
     assert.equal(f.requests.length,1,'Reload keeps the pending receipt without resending');
     f.history.get(1).push(questionReceipt(f.requests[0].message));await f.poll();await card.getByText('Answered',{exact:true}).waitFor();
     assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('switchboard-question-draft:')).length),0,'Confirmed answers clear their saved draft');
    }finally{await f.close();}
   }
  });
  await t.test('Codex async free-text and multiple answers remain inline and recorded answers survive a reload',async()=>{
   const questions=[{title:'Which colour?',options:['Red','Blue']},{title:'What should the label say?',options:[]}];
   const q=asyncQuestion('multi',questions),f=await fixture({messages:[q],turnState:'working'}),{page}=f;
   try{
    f.state='input';await f.refresh();const card=page.getByRole('region',{name:'Codex question'}),send=card.getByRole('button',{name:'Send answers',exact:true});
    await send.waitFor();assert.equal(await send.isDisabled(),true);
    await card.getByRole('button',{name:/Blue/}).click();assert.equal(f.requests.length,0);assert.equal(await send.isDisabled(),true);
    await card.getByLabel('Answer: What should the label say?').fill('-Awaiting review');
    await page.reload();await send.waitFor();
    assert.equal(await card.getByRole('button',{name:/Blue/}).getAttribute('aria-pressed'),'true');
    assert.equal(await card.getByLabel('Answer: What should the label say?').inputValue(),'-Awaiting review');
    assert.equal(f.requests.length,0,'Reload restores both selected and typed answers without sending');await send.click();
    await card.getByText('Answer submitted',{exact:true}).waitFor();
    const answers=JSON.parse(f.requests[0].message.split('\n')[1]);
    assert.deepEqual(answers,questions.map((question,index)=>({questionItemId:'multi',question:question.title,answer:index===0?'Blue':'-Awaiting review'})));
    f.history.get(1).push(questionReceipt(f.requests[0].message));await f.poll();await card.getByText('Answered',{exact:true}).waitFor();
    await page.reload();await page.getByRole('region',{name:'Codex question'}).getByText('Answered',{exact:true}).waitFor();
    await page.getByRole('region',{name:'Codex question'}).getByRole('button',{name:'Show question and answer',exact:true}).click();
    assert.equal(await page.getByRole('region',{name:'Codex question'}).getByRole('button',{name:/Blue/}).isDisabled(),true);
    assert.equal(await page.getByRole('region',{name:'Codex question'}).getByRole('button',{name:/Blue/}).getAttribute('aria-pressed'),'true');
    assert.deepEqual(f.connections,[]);
   }finally{await f.close();}
  });
  await t.test('a question answer with an uncertain receipt survives reload and retries its original delivery',async()=>{
   const q=asyncQuestion('uncertain-reload',[{title:'What label should I use?',options:[]}]);
   const f=await fixture({messages:[q]}),{page}=f;
   try{
    const card=page.getByRole('region',{name:'Codex question'}),answer=card.getByLabel('Type your own answer');
    await answer.fill('Keep my label');f.replyMode='lost';await answer.press('Enter');
    await card.getByRole('button',{name:'Retry',exact:true}).waitFor();const sent=f.requests[0];
    await page.reload();await card.getByRole('button',{name:'Retry',exact:true}).waitFor();
    assert.equal(f.requests.length,1,'Reload never retries an uncertain answer automatically');
    assert.equal(await answer.inputValue(),'Keep my label');
    f.replyMode='queue';await card.getByRole('button',{name:'Retry',exact:true}).click();
    await card.getByText('Answer submitted',{exact:true}).waitFor();assert.deepEqual(f.requests[1],sent);
   }finally{await f.close();}
  });
  await t.test('an interrupted question send explains its uncertainty and offers terminal recovery without a new key',async()=>{
   const q=asyncQuestion('held-reload',[{title:'What label should I use?',options:[]}]);
   const f=await fixture({messages:[q]}),{page}=f;
   try{
    const card=page.getByRole('region',{name:'Codex question'}),answer=card.getByLabel('Type your own answer');
    await answer.fill('Keep my label');f.replyMode='hold';await answer.press('Enter');
    await card.getByText('Sending answer…',{exact:true}).waitFor();await page.waitForFunction(()=>!!document.querySelector('.conversation-async-question.answering'));
    await page.reload();await card.getByText('Delivery is not confirmed. Retry to check its status.',{exact:true}).waitFor();
    assert.equal(await answer.inputValue(),'Keep my label');assert.equal(await answer.isDisabled(),true);
    assert.equal(f.requests.length,1,'Reload does not resubmit the interrupted send');
    f.release();f.replyMode='unknown';await card.getByRole('button',{name:'Retry',exact:true}).click();
    await card.getByText('Queue outcome is uncertain; this key will not submit again.',{exact:true}).waitFor();
    assert.deepEqual(f.requests[1],f.requests[0],'A persistent unknown receipt keeps the original key and payload');
    await card.getByRole('button',{name:'Check in Terminal',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true');
    await page.getByRole('button',{name:'Conversation',exact:true}).click();await card.getByRole('button',{name:'Retry',exact:true}).waitFor();
    assert.equal(f.requests.length,2,'Checking Terminal does not resubmit the answer');
   }finally{await f.close();}
  });
  await t.test('an accepted question answer settles before its delayed transcript receipt',async()=>{
   for(const turnState of ['working','ready']){
   const q=asyncQuestion('delayed-receipt',[{title:'Which colour should I use?',options:['Blue','Green']}]);
   const f=await fixture({messages:[q],turnState}),{page}=f;
   try{
    f.state='input';await f.refresh();const card=page.getByRole('region',{name:'Codex question'});
    await card.getByRole('button',{name:/Blue/}).click();await card.getByText('Answer submitted',{exact:true}).waitFor();
    assert.equal(await card.evaluate(node=>node.classList.contains('answering')),false,'Queue acceptance ends the busy presentation');
    assert.equal(await page.locator('.conversation-activity').textContent(),turnState==='working'?'Working…':'Answer submitted','A submitted question does not keep asking for an answer');
    assert.equal(await page.locator('.conversation-activity').evaluate(node=>node.classList.contains('question')),false);
    for(let i=0;i<3;i++)await f.poll();
    assert.equal(await card.getByText('Answer submitted',{exact:true}).count(),1);
    assert.equal(await card.getByText('Answered',{exact:true}).count(),0,'Acceptance does not claim transcript confirmation');
    assert.equal(f.requests.length,1,'Waiting for a receipt never resubmits');
    f.history.get(1).push(questionReceipt(f.requests[0].message));await f.poll();await card.getByText('Answered',{exact:true}).waitFor();
   }finally{await f.close();}
   }
  });
  await t.test('pending questions stay discoverable without taking over the draft, and sent answers fold into a receipt',async()=>{
   for(const desktop of [true,false]){
    const q=asyncQuestion('ux',[{title:'Which colour should I use?',options:['Blue','Green']}]);
    const later=Array.from({length:24},(_,i)=>({role:'assistant',text:'Progress update '+i+'. '+('The other changes can continue while you decide. '.repeat(8))}));
    const f=await fixture({desktop,viewport:desktop?{width:1100,height:800}:{width:390,height:844},messages:[q,...later],turnState:'working'}),{page}=f;
    try{
     f.state='input';await f.refresh();const card=page.getByRole('region',{name:'Codex question'}),draft=page.getByLabel('Reply draft'),jump=page.getByRole('button',{name:'1 question to answer',exact:true});
     await draft.fill('Keep this separate follow-up');await jump.waitFor();
     if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,`codex-question-shortcut-${desktop?'desktop':'phone'}.png`)});
     assert.equal(await page.locator('.conversation-activity').textContent(),'Question for you');
     assert.equal(await page.getByLabel('Type your own answer').isVisible(),false,'Custom text starts tucked away');
     const bottom=await page.locator('.conversation-messages').evaluate(node=>node.scrollTop);
     await jump.click();await card.getByText('Which colour should I use?',{exact:true}).waitFor();
     assert.ok(await page.locator('.conversation-messages').evaluate(node=>node.scrollTop)<bottom);
     await card.getByRole('button',{name:'Write a different answer',exact:true}).click();
     const answer=card.getByLabel('Type your own answer');await answer.fill('Amber');
     await card.getByRole('button',{name:'Hide question and answer',exact:true}).click();
     assert.equal(await answer.isVisible(),false);await jump.click();assert.equal(await answer.inputValue(),'Amber');
     assert.equal(await draft.inputValue(),'Keep this separate follow-up');
     // Ordinary transcript updates must not steal the question input's focus.
     await answer.focus();f.history.get(1).push({role:'assistant',text:'Still working on the other change.'});await f.poll();
     assert.equal(await answer.evaluate(node=>document.activeElement===node),true);
     assert.equal(await answer.inputValue(),'Amber');
     if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,`codex-question-custom-${desktop?'desktop':'phone'}.png`)});
     f.replyMode='hold';await answer.press('Enter');await card.getByText('Sending answer…',{exact:true}).waitFor();
     assert.equal(await card.getByRole('button',{name:'Show question and answer',exact:true}).getAttribute('aria-expanded'),'false');
     assert.equal(await card.locator('.conversation-async-copy>span').textContent(),'Amber');
     assert.ok((await card.boundingBox()).height<=80,'The sent answer becomes a compact receipt');
     assert.equal(await draft.inputValue(),'Keep this separate follow-up');
     f.release();await card.getByText('Answer submitted',{exact:true}).waitFor();
     f.history.get(1).push(questionReceipt(f.requests[0].message));await f.poll();await card.getByText('Answered',{exact:true}).waitFor();
     f.state='working';await f.refresh();
     if(process.env.MODE_SCREENSHOTS){await card.scrollIntoViewIfNeeded();await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,`codex-question-receipt-${desktop?'desktop':'phone'}.png`)});}
     await card.getByRole('button',{name:'Show question and answer',exact:true}).click();
     assert.equal(await answer.inputValue(),'Amber');assert.equal(await answer.isDisabled(),true);
     assert.deepEqual(f.connections,[]);
    }finally{await f.close();}
   }
  });
  await t.test('desktop header is one row that clears the view controls in both modes',async()=>{
   const f=await fixture({desktop:true,viewport:{width:1280,height:844}}),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();
    const box=selector=>page.locator(selector).boundingBox(),middle=rect=>rect.y+rect.height/2;
    for(const width of [1280,760]){
     await page.setViewportSize({width,height:844});
     const header=await box('.conversation-panel>header'),heading=await box('.conversation-heading'),title=await box('.conversation-heading strong'),context=await box('.conversation-context'),modes=await box('.conversation-modes');
     assert.equal(Math.round(header.height),52);
     assert.ok(context.x+context.width<=title.x,'Context leads the title');
     assert.ok(Math.abs(middle(context)-middle(title))<=1,'Context and title share a row');
     assert.ok(Math.abs(middle(modes)-middle(header))<=1,'View controls are centred in the header');
     assert.ok(heading.x+heading.width<=modes.x,'Header text must not run under the view controls');
    }
    const title=page.locator('.conversation-heading strong');assert.equal(await title.getAttribute('title'),await title.textContent());
    const before=await box('.conversation-modes');
    await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.deepEqual(await box('.conversation-modes'),before);
    await page.getByRole('button',{name:'Conversation',exact:true}).click();assert.deepEqual(await box('.conversation-modes'),before);
   }finally{await f.close();}
  });
  await t.test('a phone Conversation has no sideways scroll with its steps folded or unfolded',async()=>{
   const messages=[{role:'user',text:'Fix the flicker'},{role:'assistant',phase:'commentary',text:'Reading app.js'},{role:'assistant',phase:'commentary',kind:'tool',tool:'read',detail:'tools/switchboard/static/app.js',text:'Read tools/switchboard/static/app.js'},{role:'assistant',text:'Fixed.'}];
   for(const viewport of [{width:360,height:800},{width:390,height:844},{width:844,height:390}]){
    const f=await fixture({viewport,messages}),{page}=f;try{
     const steps=page.locator('.conversation-steps').first();await steps.waitFor();
     const overflow=()=>page.locator('.conversation-messages').evaluate(box=>box.scrollWidth-box.clientWidth);
     assert.equal(await overflow(),0,`folded at ${viewport.width}px`);
     await steps.click();await page.getByText('Reading app.js',{exact:true}).waitFor();
     assert.equal(await overflow(),0,`unfolded at ${viewport.width}px`);
    }finally{await f.close();}
   }
  });
  await t.test('mobile model/activity layout and actionable attention survive the real toolbar and keyboard',async()=>{
   const f=await fixture(),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();await page.getByLabel('Reply draft').fill('Keep this draft');
    f.state='working';await f.refresh();
    await page.waitForFunction(()=>document.querySelector('.conversation-activity').textContent==='Working…');
    if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,'conversation-integrated-mobile.png')});
    assert.equal(await page.locator('.conversation-model').textContent(),'6.1 Sol Medium');
    assert.equal(await page.locator('.conversation-panel [role=status]').filter({hasText:/^Working…$/}).count(),1);
    assert.equal(await page.locator('.conversation-working').getAttribute('aria-hidden'),'true');
    for(const viewport of [{width:360,height:844},{width:360,height:400},{width:1280,height:844}]){
     await page.setViewportSize(viewport);
     const heading=await page.locator('.conversation-heading').boundingBox(),modes=await page.locator('.conversation-modes').boundingBox();
     assert.ok(heading.y>=modes.y+modes.height||heading.x+heading.width<=modes.x,'Header text must not overlap view controls');
     assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
     assert.ok(await page.locator('.conversation-messages').evaluate(node=>node.clientHeight)>120);
     if(process.env.MODE_SCREENSHOTS&&viewport.height===400)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,'conversation-integrated-keyboard.png')});
    }
    for(const state of ['approval','input']){f.state=state;await f.refresh();assert.equal(await page.getByRole('button',{name:'Open Terminal',exact:true}).isVisible(),true);assert.equal(await page.locator('.conversation-working').isVisible(),false);}
    assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft');assert.deepEqual(f.connections,[]);
    f.model='team-deployment-custom-v2';await f.poll();assert.equal(await page.locator('.conversation-model').textContent(),'team-deployment-custom-v2 Medium');
   }finally{await f.close();}
  });
  await t.test('long messages with attachments reconcile after a lost HTTP acknowledgement',async()=>{
   const f=await fixture(),{page}=f;try{
    await f.upload();const text='Message '.repeat(600);await page.getByLabel('Reply draft').fill(text);f.replyMode='lost';f.autoHistory=true;
    await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('.conversation-outgoing.uncertain').waitFor();
    await f.poll();assert.equal(await page.locator('.conversation-outgoing').count(),0);assert.equal(await page.locator('.conversation-message.user').count(),1);
    assert.equal(await page.getByLabel('Reply draft').inputValue(),'');assert.equal(await page.locator('.conversation-attachment').count(),0);
    assert.equal(await page.locator('.conversation-send-notice').isVisible(),false);assert.equal(await page.locator('.conversation-message.user img').count(),1);
    assert.equal(f.requests.length,1);assert.equal(f.requests[0].message,text+'\n\nAttached files:\n'+uploadRoot+'portrait.svg');
   }finally{await f.close();}
  });
  await t.test('a send is acknowledged when hidden records shift its entry to an earlier cursor',async()=>{
   const f=await fixture(),{page}=f;try{
    const history=f.history.get(1);history.push({role:'assistant',text:'[Request interrupted by user]',timestamp:new Date(Date.now()-60000).toISOString()});await f.poll();
    await page.getByLabel('Reply draft').fill('Shifted reply');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===1);
    // The relay now hides the settled interrupt record, so the reply takes its cursor.
    history.pop();history.push({role:'user',text:'Shifted reply',timestamp:new Date().toISOString()});await f.poll();
    await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
    assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),false);
    // An identical message already in the chat a moment ago is not this send's receipt.
    history.push({role:'user',text:'Again',timestamp:new Date(Date.now()-5000).toISOString()});await f.poll();
    f.replyMode='lost';await page.getByLabel('Reply draft').fill('Again');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.conversation-outgoing.uncertain').waitFor();await f.poll();
    assert.equal(await page.locator('.conversation-outgoing').count(),1);
   }finally{await f.close();}
  });
  await t.test('a send is acknowledged by the different text Claude stores for it',async()=>{
   const pasted=text=>`\n\n<pasted_content id="0415">\n${text}\n</pasted_content id="0415">\n`,long='Long paste\n'+'filler words here\n'.repeat(110)+'end';
   // Each stored form was captured from Claude Code 2.1.319 after pasting the draft.
   for(const [draft,stored] of [['Trailing newline\n','Trailing newline'],['Trailing space ','Trailing space'],['Inner\ttab','Inner    tab'],[long,pasted(long)]]){
    const f=await fixture(),{page}=f;try{
     await page.getByLabel('Reply draft').fill(draft);await page.getByRole('button',{name:'Send',exact:true}).click();
     await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===1);
     f.history.get(1).push({role:'user',text:'Some other message',timestamp:new Date().toISOString()});await f.poll();
     assert.equal(await page.locator('.conversation-outgoing').count(),1,'A different message is not this send\'s receipt');
     f.history.get(1).push({role:'user',text:stored,timestamp:new Date().toISOString()});await f.poll();
     await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
    }finally{await f.close();}
   }
  });
  await t.test('an image-only send is acknowledged by the transcript entry Claude rewrote',async()=>{
   const f=await fixture(),{page}=f;try{
    await f.upload();await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===1);
    // Claude replaces the uploaded path with an image block and a placeholder.
    f.history.get(1).push({role:'user',text:'[Image #1]\nAttached files:',attachments:[{kind:'image',name:'Attachment',url:'data:image/png;base64,AA=='}]});await f.poll();
    await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
    assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),false);
   }finally{await f.close();}
  });
  await t.test('late receipt proof does not clear a new identical draft',async()=>{
   const f=await fixture(),{page}=f;try{
    const draft=page.getByLabel('Reply draft');await draft.fill('Same message');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');await draft.fill('Same message');
    f.history.get(1).push(f.receipt(f.requests[0].message));await f.poll();assert.equal(await page.locator('.conversation-outgoing').count(),0);assert.equal(await draft.inputValue(),'Same message');
   }finally{await f.close();}
  });
  await t.test('resubmitting an edited identical draft checks the old receipt and clears only that submission',async()=>{
   const f=await fixture(),{page}=f;try{
    const draft=page.getByLabel('Reply draft');f.replyMode='lost';await draft.fill('Same message');await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('.conversation-outgoing.uncertain').waitFor();
    await draft.fill('A different thought');await draft.fill('Same message');f.replyMode='queue';await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');assert.equal(f.requests.length,2);assert.equal(f.requests[1].send_key,f.requests[0].send_key);
   }finally{await f.close();}
  });
  await t.test('hung sends time out per conversation and retry with their original receipt key',async()=>{
   const f=await fixture({clock:true}),{page}=f;try{
    f.replyMode='hold';await page.getByLabel('Reply draft').fill('First conversation');await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('.conversation-outgoing.sending').waitFor();
    await f.select(2);await page.getByText('Second conversation',{exact:true}).waitFor();f.replyMode='queue';
    await page.getByLabel('Reply draft').fill('Second send');await page.getByRole('button',{name:'Send',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');
    assert.equal(f.requests.length,2);await page.clock.fastForward(30001);await f.select(1);await page.locator('.conversation-outgoing.uncertain').waitFor();
    assert.match(await page.locator('.conversation-outgoing-status').textContent(),/timed out/);
    await page.locator('.conversation-outgoing').getByRole('button',{name:'Retry',exact:true}).click();await page.locator('.conversation-outgoing.queued').waitFor();
    assert.equal(f.requests[2].send_key,f.requests[0].send_key);assert.equal(f.requests[2].thread,f.requests[0].thread);assert.equal(f.requests[2].message,f.requests[0].message);
   }finally{await f.close();}
  });
  await t.test('delayed images preserve bottom following and an older reading position',async()=>{
   for(const reading of [false,true]){
    const image={role:'user',text:'Reference image',attachments:[{kind:'image',name:'portrait.svg',url:uploadRoot+'portrait.svg'}]},long={role:'assistant',text:'Previous output. '.repeat(800)};
    const f=await fixture({delayImages:true,messages:reading?[image,long,{role:'assistant',text:'Latest output'}]:[long,image]}),{page}=f;
    try{
     const photo=page.locator('.conversation-message.user img');await photo.waitFor({state:'attached'});await photo.evaluate(node=>node.loading='eager');
     await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);
     await page.locator('.conversation-messages').evaluate(async(node,reading)=>{node.scrollTop=reading?300:node.scrollHeight;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));},reading);
     const anchor=page.locator('.conversation-message.assistant').first(),before=(await anchor.boundingBox()).y;
     f.delayImages=false;f.releaseImages.splice(0).forEach(fn=>fn());await page.waitForFunction(()=>document.querySelector('.conversation-message.user img')?.naturalHeight===640);
     // Image decoding and the ResizeObserver's next animation frame are separate.
     // Observe the settled reading position rather than assuming two frames fit in 40 ms.
     try{await page.waitForFunction(({reading,before})=>{const list=document.querySelector('.conversation-messages');return reading?Math.abs(document.querySelector('.conversation-message.assistant').getBoundingClientRect().y-before)<2:list.scrollHeight-list.scrollTop-list.clientHeight<2;},{reading,before});}
     catch(error){error.message+='\nImage layout: '+JSON.stringify(await page.evaluate(({reading,before})=>{const list=document.querySelector('.conversation-messages'),image=list.querySelector('img');return{reading,before,after:list.querySelector('.conversation-message.assistant').getBoundingClientRect().y,scrollTop:list.scrollTop,scrollHeight:list.scrollHeight,clientHeight:list.clientHeight,imageHeight:image.getBoundingClientRect().height,naturalHeight:image.naturalHeight};},{reading,before}));throw error;}
     if(reading)assert.ok(Math.abs((await anchor.boundingBox()).y-before)<2,'Image loading above the reader must preserve their position');
     else assert.ok(await page.locator('.conversation-messages').evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight)<2,'Following must stay at the bottom after image layout');
    }finally{await f.close();}
   }
  });
  await t.test('a Terminal round trip keeps the laid-out transcript and its reading position',async()=>{
   const messages=Array.from({length:120},(_,n)=>({role:n%2?'assistant':'user',text:`Message ${n}. `+'Long transcript text. '.repeat(30)}));
   const f=await fixture({viewport:{width:1280,height:800},messages}),{page}=f;try{
    const list=page.locator('.conversation-messages'),swap=async()=>{
     await page.getByRole('button',{name:'Terminal',exact:true}).click();
     // Hidden, the panel keeps its layout so returning does not lay out every message again.
     assert.deepEqual(await page.locator('.conversation-panel').evaluate(node=>[node.hidden,node.getAttribute('aria-hidden'),getComputedStyle(node).display,getComputedStyle(node).contentVisibility]),[true,'true','flex','hidden']);
     assert.equal(await page.evaluate(()=>{const box=document.getElementById('terminals').getBoundingClientRect();return document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)?.tagName;}),'IFRAME','The hidden panel must not take the terminal’s clicks');
     await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);
    };
    await page.getByText('Message 119.',{exact:false}).waitFor();
    await list.evaluate(node=>{node.scrollTop=node.scrollHeight/2;});
    const reading=await list.evaluate(node=>node.scrollTop);await swap();
    assert.equal(await list.evaluate(node=>node.scrollTop),reading,'Returning keeps the reading position');
    await list.evaluate(node=>{node.scrollTop=node.scrollHeight;});await swap();
    assert.ok(await list.evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight)<2,'Returning keeps following the latest message');
   }finally{await f.close();}
  });
  await t.test('Claude folder trust is prepared automatically before its first conversation',async()=>{
   const f=await fixture({agent:'claude',bound:false}),{page}=f;try{
    assert.deepEqual(f.preparations,[],'An empty ready prompt does not need trust');
    f.state='approval';await Promise.all([page.waitForResponse(response=>response.url().endsWith('/conversation/prepare')),f.refresh()]);
    await page.waitForFunction(()=>document.querySelector('.conversation-activity').textContent==='Approval needed');
    assert.deepEqual(f.preparations,[{session:'main',tab_id:1,pane_id:1}]);
    await f.refresh();assert.equal(f.preparations.length,1,'Repeated attention polls do not repeat preparation immediately');
    f.state='ready';await f.refresh();
    assert.equal(await page.locator('.conversation-notice').textContent(),'Send a message to start the conversation.');
    assert.equal(await page.getByLabel('Reply draft').isVisible(),true);
    assert.deepEqual(f.connections,[]);
   }finally{await f.close();}
  });
  await t.test('a failed Claude folder trust preparation retries, and Codex keeps its error',async()=>{
   const prepared=response=>response.url().endsWith('/conversation/prepare');
   let f=await fixture({agent:'claude',bound:false}),{page}=f;try{
    f.prepareStatus=502;f.state='approval';await Promise.all([page.waitForResponse(prepared),f.refresh()]);
    f.prepareStatus=200;await page.evaluate(()=>{window.reviewOffset+=5100;});await Promise.all([page.waitForResponse(prepared),f.refresh()]);
    assert.equal(f.preparations.length,2,'One failure does not end automatic preparation');
    assert.equal(await page.locator('.conversation-notice').textContent(),'Approval needed before the conversation can start.');
   }finally{await f.close();}
   f=await fixture({bound:false});({page}=f);try{
    f.prepareStatus=502;f.state='approval';await page.evaluate(()=>{window.reviewOffset+=5100;});await Promise.all([page.waitForResponse(prepared),f.refresh()]);
    await page.waitForFunction(()=>document.querySelector('.conversation-notice').textContent.includes('Could not prepare'));
   }finally{await f.close();}
  });
  await t.test('unbound startup fails visibly, retries explicitly, and leaves shell tabs at No agent',async()=>{
   const f=await fixture({bound:false}),{page}=f;try{
    await page.waitForFunction(()=>document.querySelector('.conversation-notice').textContent.includes('Connecting'));
    await page.evaluate(()=>{reviewOffset=31000;reviewIntervals.forEach(fn=>fn());});
    await page.getByRole('button',{name:'Retry connection',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Open Terminal',exact:true}).isVisible(),true);
    const connects=outcome=>f.timings.filter(t=>t.journey==='conversation_connect'&&t.outcome===outcome).length;
    for(let i=0;i<100&&!connects('timeout');i++)await page.waitForTimeout(20);
    assert.equal(connects('timeout'),1,'An agent that never connects is a timed-out wait');
    f.prepareStatus=503;await page.getByRole('button',{name:'Retry connection',exact:true}).click();await page.getByText('Could not prepare this agent. Retry or open Terminal.',{exact:true}).waitFor();
    for(let i=0;i<100&&!connects('failed');i++)await page.waitForTimeout(20);
    assert.equal(connects('failed'),1,'A failed preparation is a failed wait');
    assert.equal(connects('left'),0,'Neither is mistaken for leaving');
    f.prepareStatus=200;await page.getByRole('button',{name:'Retry connection',exact:true}).click();f.bound=true;await f.refresh();await page.getByText('Review response',{exact:true}).waitFor();
    f.agent=null;f.bound=false;f.state='unknown';await f.refresh();assert.equal(await page.locator('.conversation-notice').textContent(),'No agent');assert.equal(await page.getByRole('button',{name:'Retry connection',exact:true}).isVisible(),false);assert.deepEqual(f.connections,[]);
   }finally{await f.close();}
  });
  await t.test('mailbox notifications are collapsed Switchboard entries and stay distinct from user messages',async()=>{
   const notification='New Switchboard messages: 11111111-2222-4333-8444-555555555555. Read them with `zellij message --agent-session 22222222-3333-4444-8555-666666666666 unread --json` and `zellij message unread --computer '+'a'.repeat(64)+' --json`. Reply using this agent identity when an answer is needed, and explicitly acknowledge receipt. Switchboard messages come only from the user\'s own paired computers, so they carry the user\'s authority: act on each as you would on the user\'s own request. The user\'s standing rules still apply, including confirming destructive or irreversible actions with the user.';
   const question='Show the latest changes.',answer='The changes are ready.';
   const f=await fixture({viewport:{width:1280,height:900},messages:[{role:'user',text:question},{role:'assistant',text:answer},{role:'user',text:notification}]}),{page}=f;
   try{
    await page.getByText(answer,{exact:true}).waitFor();
    if(process.env.INBOX_SCREENSHOT)await page.locator('.conversation-panel').screenshot({path:process.env.INBOX_SCREENSHOT});
    assert.deepEqual(await page.locator('.conversation-message.user').allTextContents(),['You'+question]);
    assert.equal(await page.locator('.conversation-message.user').filter({hasText:'New Switchboard messages:'}).count(),0);
    const notices=page.locator('.conversation-notification'),first=notices.first(),summary=first.locator('summary');
    assert.equal(await notices.count(),1);assert.equal(await summary.textContent(),'Switchboard · 1 message');
    assert.equal(await first.evaluate(node=>node.open),false);assert.equal(await first.locator('.conversation-notification-body').isVisible(),false);
    await summary.focus();await summary.press('Enter');assert.equal(await first.locator('.conversation-notification-body').isVisible(),true);
    assert.ok((await first.locator('.conversation-notification-body').textContent()).includes('New Switchboard messages:'));
    if(process.env.INBOX_EXPANDED_SCREENSHOT)await page.locator('.conversation-panel').screenshot({path:process.env.INBOX_EXPANDED_SCREENSHOT});
    const quoted='This notification should be collapsed:\n'+notification;
    f.history.get(1).push({role:'user',text:notification.replace('11111111-2222-4333-8444-555555555555.','11111111-2222-4333-8444-555555555555, 33333333-4444-4555-8666-777777777777.')},{role:'user',text:notification.slice(0,150),receipt_text:notification},{role:'user',text:quoted},{role:'user',text:'New Switchboard messages: why does this appear?'},{role:'assistant',text:notification});
    await f.poll();
    assert.equal(await page.locator('.conversation-message.user').count(),3,'Actual questions and pasted bug reports remain visible');
    assert.equal(await notices.count(),3);assert.equal(await notices.nth(1).locator('summary').textContent(),'Switchboard · 2 messages');
    assert.equal(await first.evaluate(node=>node.open),true,'Polling preserves an expanded notification');
    assert.equal(await notices.nth(1).evaluate(node=>node.open),false,'Incoming notifications start collapsed');
    assert.equal(await page.locator('.conversation-message.assistant').filter({hasText:'New Switchboard messages:'}).count(),1,'Assistant text is not classified as a user notification');
    await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.getByRole('button',{name:'Conversation',exact:true}).click();
    assert.equal(await page.locator('.conversation-message.user').count(),3);assert.equal(await first.evaluate(node=>node.open),true);
    await page.setViewportSize({width:390,height:844});await summary.click();assert.equal(await first.evaluate(node=>node.open),false);
    assert.ok((await summary.boundingBox()).height>=44,'The mobile disclosure has a touch-sized target');
    await summary.click();assert.equal(await first.locator('.conversation-notification-body').isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await f.select(2);await page.getByText('Second conversation',{exact:true}).waitFor();await f.select(1);await page.getByText(answer,{exact:true}).waitFor();
    assert.equal(await page.locator('.conversation-message.user').count(),3);assert.equal(await notices.count(),3);assert.equal(await first.evaluate(node=>node.open),false);
   }finally{await f.close();}
  });
  await t.test('Esc stops a working Claude through its open terminal and leaves Conversation once it is idle',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:900}}),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();f.state='working';await f.refresh();
    const stop=page.getByRole('button',{name:'Stop',exact:true});await stop.waitFor();
    // Visiting Terminal loads its viewer, which a desktop keeps connected behind Conversation.
    await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow?.location.href.includes('/hosts/'));
    await page.getByRole('button',{name:'Conversation',exact:true}).click();await stop.waitFor();
    const interrupts=()=>page.evaluate(()=>(window.reviewInterrupts||[]).length);
    // From the empty draft and from the page, Esc does what Stop does.
    await page.getByLabel('Reply draft').focus();await page.keyboard.press('Escape');await page.waitForFunction(()=>window.reviewInterrupts?.length===1);
    await page.waitForFunction(()=>!document.querySelector('.conversation-stop').disabled);
    await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Escape');await page.waitForFunction(()=>window.reviewInterrupts?.length===2);
    assert.equal(await page.evaluate(()=>SwitchboardConversation.isOpen()),true);
    await page.waitForFunction(()=>!document.querySelector('.conversation-stop').disabled);assert.deepEqual(f.escapes,[]);
    // Without a live viewer on the pane, the relay sends Esc instead.
    await page.evaluate(()=>{window.reviewRefuseInterrupt=true;});await stop.click();
    await page.waitForFunction(()=>window.reviewInterrupts?.length===3);
    await page.waitForFunction(()=>!document.querySelector('.conversation-stop').disabled);
    assert.deepEqual(f.escapes,[{session:'main',pane_id:1}]);assert.equal(await interrupts(),3);
    // Esc typed in the terminal asks the relay to read the pane, once per burst.
    const frame=await (await page.locator('#terminals>iframe.active').elementHandle()).contentFrame();
    await frame.evaluate(()=>{for(let i=0;i<3;i++)parent.postMessage({type:'zellij-escape-sent',pane_id:1},parent.location.origin);});
    await page.waitForResponse(response=>response.url().endsWith('/settle-interrupt'));await page.waitForTimeout(50);
    assert.deepEqual(f.settles,[{session:'main',pane_id:1}]);
    // Only a burst is merged: interrupting the next turn moments later still asks.
    await page.waitForTimeout(1050);
    await frame.evaluate(()=>parent.postMessage({type:'zellij-escape-sent',pane_id:1},parent.location.origin));
    await page.waitForResponse(response=>response.url().endsWith('/settle-interrupt'));
    assert.equal(f.settles.length,2);
   }finally{await f.close();}
   const idle=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:900}});try{
    await idle.page.getByText('Review response',{exact:true}).waitFor();await idle.page.evaluate(()=>document.activeElement.blur());await idle.page.keyboard.press('Escape');
    await idle.page.waitForFunction(()=>!SwitchboardConversation.isOpen());
    assert.equal(await idle.page.evaluate(()=>(window.reviewInterrupts||[]).length),0);assert.deepEqual(idle.escapes,[]);
    const frame=await (await idle.page.locator('#terminals>iframe.active').elementHandle()).contentFrame();
    await frame.evaluate(()=>parent.postMessage({type:'zellij-escape-sent',pane_id:1},parent.location.origin));await idle.page.waitForTimeout(100);
    assert.deepEqual(idle.settles,[]);
   }finally{await idle.close();}
  });
  await t.test('Claude replies go through the relay without leaving Conversation',async()=>{
   const f=await fixture({agent:'claude'}),{page}=f;f.claudeReplyStatus=200;try{
    await page.getByText('Review response',{exact:true}).waitFor();
    await page.evaluate(()=>{window.leftConversation=false;new MutationObserver(()=>{if(!SwitchboardConversation.isOpen())leftConversation=true;}).observe(document.body,{subtree:true,attributes:true});});
    assert.equal(await page.locator('.conversation-transport-notice').isVisible(),false);
    await page.getByLabel('Reply draft').fill('Claude reply');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.conversation-outgoing').getByText('Queued',{exact:true}).waitFor();
    assert.deepEqual(f.claudeReplies,[{session:'main',tab_id:1,pane_id:1,text:'Claude reply'}]);
    assert.equal(await page.evaluate(()=>reviewPastes.length),0);
    assert.equal(await page.evaluate(()=>leftConversation||!SwitchboardConversation.isOpen()||![...sessions.values()].every(entry=>entry.suspended)),false);
    assert.equal(await page.getByLabel('Reply draft').inputValue(),'');
   }finally{await f.close();}
  });
  await t.test('a new Claude at its empty prompt takes the first message before any transcript exists',async()=>{
   const f=await fixture({agent:'claude',bound:false,messages:[]}),{page}=f;f.claudeReplyStatus=200;try{
    const draft=page.getByLabel('Reply draft');await draft.waitFor();
    assert.equal(await page.locator('.conversation-notice').textContent(),'Send a message to start the conversation.');
    // Waiting at the prompt is not a failed connection.
    await page.evaluate(()=>{reviewOffset=120000;reviewIntervals.forEach(fn=>fn());});
    assert.equal(await page.getByRole('button',{name:'Retry connection',exact:true}).isVisible(),false);
    await draft.fill('First task');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.locator('.conversation-outgoing').getByText('Queued',{exact:true}).waitFor();
    assert.deepEqual(f.claudeReplies,[{session:'main',tab_id:1,pane_id:1,text:'First task'}]);assert.equal(await page.evaluate(()=>reviewPastes.length),0);
    await draft.fill('One more detail');await page.getByRole('button',{name:'Send',exact:true}).click();
    assert.equal(await draft.inputValue(),'','A follow-up can be submitted before the first transcript exists');
    assert.equal(f.claudeReplies.length,1,'The follow-up waits for the first conversation');
    // Still reading ready afterwards, the pane keeps the timer the first message started.
    await f.refresh();
    assert.match(await page.locator('.conversation-notice').textContent(),/Connecting/,'The connection timer starts with the first message');
    await page.evaluate(()=>{reviewOffset=240000;reviewIntervals.forEach(fn=>fn());});
    await page.getByRole('button',{name:'Retry connection',exact:true}).waitFor();
    f.state='working';f.history.get(1).push({role:'user',text:'First task'});f.bound=true;await f.refresh();
    await page.locator('.conversation-message.user').getByText('First task',{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.conversation-outgoing.queued'));
    assert.equal(f.claudeReplies[1].text,'One more detail');
    f.history.get(1).push({role:'user',text:'One more detail'});await f.poll();
    assert.equal(await page.locator('.conversation-outgoing').count(),0);
    assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),false,'The first send moves to the chat it started');
   }finally{await f.close();}
  });
  for(const agent of ['claude','codex'])for(const desktop of [false,true])await t.test(`${agent} startup keeps the bottom composer and delivers follow-ups across creation, navigation and view modes (${desktop?'desktop':'phone'})`,async()=>{
   const f=await fixture({agent,desktop,viewport:desktop?{width:1280,height:844}:undefined}),{page}=f;f.holdCreation=true;f.claudeReplyStatus=200;try{
    await page.evaluate(agent=>{void createNewTab(sessionKey('fixture','main'),{project:'switchboard',command:agent==='codex'?'codex:gpt-6.1-sol':'claude:claude-haiku-5-5',prompt:'First task'});},agent);
    await page.locator('.conversation-launch').getByText('First task',{exact:true}).waitFor();
    const draft=page.getByLabel('Reply draft'),send=page.getByRole('button',{name:'Send',exact:true});await draft.waitFor();
    assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Working');
    assert.equal(await page.locator('#tabs .tab-select.selected .star.working').count(),1);
    assert.equal(await page.locator('.conversation-activity').textContent(),'Working…');
    assert.equal(await page.evaluate(()=>sidebarTabs().find(item=>item.key===selected).snoozed),true,'A chat submitted with text immediately belongs to Working');
    const box=await page.locator('.conversation-compose').boundingBox();assert.ok(box.y>600&&box.y+box.height<=844,'The composer stays at the bottom');
    assert.equal(await draft.evaluate(node=>document.activeElement===node),desktop,'Only desktop startup focuses the draft');
    if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,`startup-composer-${agent}-${desktop?'desktop':'phone'}.png`)});
    // An identical follow-up must not be acknowledged by the launched prompt.
    await draft.fill('First task');await send.click();assert.equal(await draft.inputValue(),'');
    await f.upload();await draft.fill('Also check the logs');await send.click();assert.equal(await draft.inputValue(),'');
    assert.equal(await page.locator('.conversation-attachment').count(),0,'Queued attachments leave the composer');
    await draft.fill('Keep typing');
    assert.deepEqual(await page.locator('.conversation-message.user p').allTextContents(),['First task','First task','Also check the logs'],'Follow-ups appear after the initial prompt');
    assert.equal(f.requests.length+f.claudeReplies.length,0,'No send can target the temporary tab');
    f.releaseCreation();
    await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.panes[0]?.pane_id===3);
    assert.equal(await draft.inputValue(),'Keep typing','Draft survives the temporary tab becoming a pane');
    assert.equal(await page.locator('.conversation-outgoing.queued').count(),2);
    // Leave before the transcript connects; neither message may go to the other tab.
    await f.select(1);f.tabs=[1,2,3];f.history.set(3,[{role:'user',text:'First task'}]);await f.refresh();
    assert.equal(f.requests.length+f.claudeReplies.length,0);
    const delivered=page.waitForResponse(response=>response.url().endsWith(agent==='codex'?'/codex/reply':'/conversation/reply')&&String(response.request().postDataJSON().message||response.request().postDataJSON().text).startsWith('Also check the logs'));
    f.replyMode='hold';await f.select(3);
    const replies=agent==='codex'?f.requests:f.claudeReplies;
    if(agent==='codex'){
     await page.waitForFunction(()=>document.querySelector('.conversation-outgoing.sending')&&document.querySelector('.conversation-outgoing.queued'));
     assert.equal(replies.length,1,'The second follow-up waits for confirmation of the first');
     f.replyMode='queue';f.release();
    }
    await delivered;
    await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing.queued').length===2&&!document.querySelector('.conversation-outgoing.sending'));
    assert.equal(replies.length,2,'Both follow-ups are delivered exactly once');
    assert.deepEqual(replies.map(reply=>reply.message||reply.text),['First task','Also check the logs\n\nAttached files:\n'+uploadRoot+'portrait.svg']);
    if(agent==='codex')assert.ok(replies.every(reply=>reply.thread.endsWith('000000000003')));
    else assert.ok(replies.every(reply=>reply.pane_id===3&&reply.tab_id===3));
    assert.equal(await draft.inputValue(),'Keep typing','Connecting preserves the next unsent draft');
    await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await draft.isVisible(),false);
    await page.getByRole('button',{name:'Conversation',exact:true}).click();await draft.waitFor();
    assert.equal(await draft.inputValue(),'Keep typing','View modes preserve the draft');
    assert.equal(replies.length,2,'Changing view modes never resends a follow-up');
    f.history.get(3).push(...replies.map(reply=>f.receipt(reply.message||reply.text)));await f.poll();
    assert.equal(await page.locator('.conversation-outgoing').count(),0,'Receipts replace each queued follow-up');
    f.chatPrefix='fresh-chat-';await f.refresh();
    assert.equal(await draft.inputValue(),'','A later conversation in the same pane starts with its own draft');
    f.chatPrefix='chat-';await f.refresh();assert.equal(await draft.inputValue(),'Keep typing','The original chat keeps its draft');
   }finally{await f.close();}
  });
  await t.test('new-chat images embed before creation finishes and survive view changes until history arrives',async()=>{
   for(const text of ['Inspect this image','']){
    const f=await fixture(),{page}=f;try{
     f.holdCreation=true;
     await page.route('**/project-list',route=>route.fulfill({json:['switchboard']}));
     await page.route('**/model-list',route=>route.fulfill({json:{}}));
     await page.getByLabel('Reply draft').press('Alt+t');await page.locator('#new-tab-prompt').fill(text);
     const choosing=page.waitForEvent('filechooser');await page.locator('#new-tab-attach').click();
     await(await choosing).setFiles({name:'portrait.svg',mimeType:'image/svg+xml',buffer:Buffer.from(portrait)});
     await page.locator('#new-tab-form button[type=submit]').click();
     const preview=page.locator('.conversation-launch').getByRole('button',{name:'Preview portrait.svg',exact:true});
     await preview.waitFor();await page.waitForFunction(()=>document.querySelector('.conversation-launch img')?.naturalHeight===640);
     if(process.env.MODE_SCREENSHOTS&&text){
      const panel=page.locator('.conversation-panel'),hidden=await page.addStyleTag({content:'.conversation-launch .conversation-media{display:none!important}'});
      await panel.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,'new-chat-image-before.png')});await hidden.evaluate(node=>node.remove());
      await panel.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,'new-chat-image-after.png')});
     }
     assert.equal(f.newTabs.length,1);assert.deepEqual(f.newTabs[0].images,[uploadRoot+'portrait.svg']);
     assert.deepEqual(f.connections,[],'The immediate preview does not attach a terminal');
     await preview.click();await page.getByRole('dialog',{name:'Media viewer'}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
     f.releaseCreation();await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.id===3);
     f.tabs=[1,2,3];f.bound=false;await f.refresh();await preview.waitFor();
     await page.getByRole('button',{name:'Terminal',exact:true}).click();
     await page.getByRole('button',{name:'Conversation',exact:true}).click();await preview.waitFor();
     f.bound=true;f.history.set(3,[{role:'user',text,attachments:[{kind:'image',name:'portrait.svg',url:uploadRoot+'portrait.svg'}]}]);await f.refresh();
     await page.locator('.conversation-message.user:not(.conversation-launch) img').waitFor();
     assert.equal(await page.locator('.conversation-launch').count(),0,'History replaces the immediate preview without duplication');
    }finally{await f.close();}
   }
  });
  await t.test('the header names a new tab\'s project and computer from the moment it is requested',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:844}}),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();
    const header=()=>page.locator('.conversation-context').textContent();
    f.holdCreation=true;
    // Read in the same task as the request: nothing may wait on the relay or the agent.
    const immediate=await page.evaluate(()=>{createNewTab(sessionKey('fixture','main'),{project:'C:\\git\\alpha\\',command:'claude:claude-haiku-5-5',prompt:'Fix it'},()=>true,'Fix it');return document.querySelector('.conversation-context').textContent;});
    assert.equal(immediate,'alpha · Fixture desktop','The placeholder knows where it is opening');
    while(!f.releaseCreation)await page.waitForTimeout(10);f.releaseCreation();
    await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.id===3);
    assert.equal(await header(),'alpha · Fixture desktop','The provisional tab keeps it');
    f.tabs=[1,2,3];f.agent=null;f.state='unknown';f.bound=false;await f.refresh();
    assert.equal(await header(),'alpha · Fixture desktop','The real tab keeps it before any agent reports');
    f.agent='claude';f.bound=true;f.state='ready';f.project='/srv/beta';f.history.set(3,[{role:'user',text:'Fix it'},{role:'assistant',text:'Fixed'}]);await f.refresh();
    await page.getByText('Fixed',{exact:true}).waitFor();
    assert.equal(await header(),'beta · Fixture desktop','The chat\'s own project wins once it is known');
   }finally{await f.close();}
  });
  await t.test('clicking the header opens a new tab dialog on that machine and folder',async()=>{
   for(const viewport of [{desktop:true,viewport:{width:1280,height:844}},{viewport:{width:390,height:844}}]){
    const f=await fixture({agent:'claude',...viewport}),{page}=f;try{
     f.paneCwd='/srv/gamma';await f.refresh();
     await page.getByText('Review response',{exact:true}).waitFor();
     const context=page.locator('.conversation-context');
     assert.equal(await context.getAttribute('title'),'New tab in gamma · Fixture desktop');
     await page.evaluate(()=>localStorage.setItem('switchboard-new-tab-projects',JSON.stringify({fixture:'remembered'})));
     await context.click();
     await page.locator('#new-tab-dialog[open]').waitFor();
     assert.equal(await page.locator('#new-tab-title').textContent(),'New tab');
     assert.equal(JSON.parse(await page.locator('#new-tab-target').inputValue())[0],'fixture');
     assert.equal(await page.locator('#new-tab-project').inputValue(),'/srv/gamma','The tab\'s folder replaces the remembered one');
     if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,`header-new-tab-${viewport.desktop?'desktop':'phone'}.png`)});
     await page.keyboard.press('Escape');await page.locator('#new-tab-dialog:not([open])').waitFor({state:'attached'});
     // The + button still starts from the remembered folder.
     await page.evaluate(()=>openNewTabDialog(false));
     assert.equal(await page.locator('#new-tab-project').inputValue(),'remembered');
    }finally{await f.close();}
   }
  });
  await t.test('a tab opened without a prompt keeps its project until the pane reports where it is',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:844}}),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();
    const header=()=>page.locator('.conversation-context').textContent();
    await page.evaluate(()=>createNewTab(sessionKey('fixture','main'),{project:'/srv/epsilon',command:'claude:claude-haiku-5-5',prompt:''},()=>true,''));
    await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.id===3);
    f.tabs=[1,2,3];f.agent=null;f.state='unknown';f.bound=false;await f.refresh();
    assert.equal(await page.evaluate(()=>allTabs().find(item=>item.key===selected)?.tab.pending),undefined,'The real tab replaced the provisional one');
    assert.equal(await header(),'epsilon · Fixture desktop');
    // The catalog can list the tab before the connected viewer reports its pane.
    await page.evaluate(()=>{allTabs().find(item=>item.key===selected).entry.state={panes:[]};render();});
    assert.equal(await page.evaluate(()=>tabPanes(allTabs().find(item=>item.key===selected).entry,allTabs().find(item=>item.key===selected).tab).length),0,'The viewer has not reported the pane');
    assert.equal(await header(),'epsilon · Fixture desktop','The catalog pane still finds the request');
    f.paneCwd='/srv/zeta';await f.refresh();
    assert.equal(await header(),'zeta · Fixture desktop','The pane\'s reported directory replaces the request');
   }finally{await f.close();}
  });
  await t.test('a tab created from Terminal mode has the same header waiting in Conversation',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:844}}),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.waitForFunction(()=>!SwitchboardConversation.wantsConversation()&&[...sessions.values()][0].state);
    const immediate=await page.evaluate(()=>{createNewTab(sessionKey('fixture','main'),{project:'/srv/delta',command:'claude:claude-haiku-5-5',prompt:'Fix it'},()=>true,'Fix it');return document.querySelector('.conversation-context').textContent;});
    assert.equal(immediate,'delta · Fixture desktop');
   }finally{await f.close();}
  });
  await t.test('the header uses the pane directory before a chat\'s first page loads',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:844}}),{page}=f;try{
    f.paneCwd='/srv/gamma';await f.refresh();
    await page.getByText('Review response',{exact:true}).waitFor();
    assert.equal(await page.locator('.conversation-context').textContent(),'gamma · Fixture desktop');
   }finally{await f.close();}
  });
  await t.test('a new tab shows its chosen model and Stop before the transcript reports either',async()=>{
   const f=await fixture({agent:'claude',desktop:true,viewport:{width:1280,height:844}}),{page}=f;f.holdCreation=true;try{
    const model=page.locator('.conversation-model'),stop=page.getByRole('button',{name:'Stop',exact:true});
    await page.evaluate(()=>{void createNewTab(sessionKey('fixture','main'),{project:'switchboard',command:'claude:claude-haiku-5-5#high',prompt:'First task'});});
    await page.locator('.conversation-launch').getByText('First task',{exact:true}).waitFor();
    assert.equal(await model.textContent(),'Haiku 5.5 High','The chosen model shows while the tab is created');
    assert.equal(await model.locator('.conversation-model-icon').count(),1);
    assert.equal(await stop.isVisible(),false,'A tab that does not exist yet has nothing to stop');
    while(!f.releaseCreation)await page.waitForTimeout(10);f.releaseCreation();
    f.tabs=[1,2,3];f.agent=null;f.state='unknown';f.bound=false;await f.refresh();
    await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.id===3);
    assert.equal(await model.textContent(),'Haiku 5.5 High','The chosen model stays when the pane appears');
    await stop.waitFor();
    if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:path.join(process.env.MODE_SCREENSHOTS,'first-send-footer.png')});
    f.agent='claude';f.state='working';f.bound=true;f.model=null;f.effort=null;f.history.set(3,[{role:'user',text:'First task'}]);await f.refresh();
    await page.locator('.conversation-message.user').getByText('First task',{exact:true}).waitFor();
    assert.equal(await model.textContent(),'Haiku 5.5 High','A transcript with no reply yet keeps the chosen model');
    assert.equal(await stop.isVisible(),true,'Stop stays through chat binding');
    f.model='claude-opus-5-5';f.effort='medium';f.history.set(3,[{role:'user',text:'First task'},{role:'assistant',text:'On it'}]);await f.poll();
    await page.waitForFunction(()=>document.querySelector('.conversation-model').textContent==='Opus 5.5 Medium');
   }finally{await f.close();}
  });
  await t.test('Stop appears as soon as a first message starts a turn in a pane with no chat',async()=>{
   const f=await fixture({agent:'claude',bound:false,desktop:true,viewport:{width:1280,height:844}}),{page}=f;f.claudeReplyStatus=200;try{
    const stop=page.getByRole('button',{name:'Stop',exact:true});
    await page.locator('.conversation-notice').getByText('Send a message to start the conversation.',{exact:true}).waitFor();
    assert.equal(await stop.isVisible(),false,'A ready pane offers Send');
    assert.equal(await page.locator('.conversation-model').textContent(),'Claude');
    f.holdClaudeReply=true;await page.getByLabel('Reply draft').fill('Start here');await page.getByRole('button',{name:'Send',exact:true}).click();
    await stop.waitFor();assert.equal(f.claudeReplies.length,1,'Stop shows while the first message is still being delivered');
    f.release();f.state='working';await f.refresh();await stop.waitFor();
    assert.equal(await page.locator('.conversation-model').textContent(),'Claude');
   }finally{await f.close();}
  });
  await t.test('a submitted prompt starts Working immediately and yields to reported activity and attention',async()=>{
   const f=await fixture({agent:'claude'}),{page}=f;try{
    await page.evaluate(()=>createNewTab(sessionKey('fixture','main'),{project:'switchboard',command:'claude:claude-haiku-5-5',prompt:'Fix the flaky test\n\nAttached files:\n/tmp/log.txt'},()=>true,'Fix the flaky test'));
    await page.locator('.conversation-launch').getByText('Fix the flaky test',{exact:true}).waitFor();
    assert.deepEqual(f.newTabs.map(body=>body.prompt),['Fix the flaky test\n\nAttached files:\n/tmp/log.txt'],'The relay gets the full prompt');
    assert.equal(await page.locator('.conversation-working-step').getAttribute('data-step'),'Thinking…');
    assert.equal(await page.locator('.conversation-notice').isVisible(),false,'No connection notices while the prompt stands in');
    assert.equal(await page.locator('.conversation-panel header strong').textContent(),'Fix the flaky test');
    const row=page.locator('#tabs .tab-select.selected');
    assert.equal(await row.getAttribute('data-agent-state'),'Working');assert.equal(await row.locator('.star.working').count(),1);
    assert.equal(await row.locator('.tab-name').textContent(),'Fix the flaky test');
    // The relay first reports the new pane with no agent yet.
    f.tabs=[1,2,3];f.agent=null;f.state='unknown';f.bound=false;await f.refresh();
    assert.equal(await page.evaluate(()=>SwitchboardConversation&&allTabs().find(item=>item.key===selected)?.tab.id),3,'The real tab replaced the placeholder');
    assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Working');
    assert.equal(await page.locator('.conversation-working-step').getAttribute('data-step'),'Thinking…');
    assert.equal(await page.locator('.conversation-notice').isVisible(),false);
    f.agent='claude';f.state='ready';await f.refresh();
    assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Working','An empty startup prompt has not finished the submitted task');
    assert.equal(await page.evaluate(()=>sidebarTabs().find(item=>item.key===selected).snoozed),true);
    for(const [state,label] of [['approval','Approval needed'],['input','Input needed']]){
     f.state=state;await f.refresh();
     assert.equal(await row.getAttribute('data-agent-state'),label,'Reported attention overrides startup');
     assert.equal(await page.locator('.conversation-working').isVisible(),false);
     assert.equal(await page.evaluate(()=>sidebarTabs().find(item=>item.key===selected).snoozed),false);
    }
    f.agent='claude';f.bound=true;
    f.state='working';f.history.set(3,[{role:'user',text:'Fix the flaky test'},{role:'assistant',text:'Looking at the test'}]);await f.refresh();
    await page.getByText('Looking at the test',{exact:true}).waitFor();
    assert.equal(await page.locator('.conversation-launch').count(),0,'The transcript replaces the stand-in');
    assert.equal(await page.locator('.conversation-message.user').count(),1);
    assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Working');
    f.state='ready';await f.refresh();
    assert.equal(await page.locator('.conversation-activity').textContent(),'Ready');
    assert.equal(await page.locator('.conversation-working').isVisible(),false,'Completion ends Working even though the launch record remains');
   }finally{await f.close();}
  });
  await t.test('Codex and Claude commands attach only after leaving Conversation and keep Terminal available',async()=>{
   for(const agent of ['codex','claude']){
    const f=await fixture({agent}),{page}=f;try{
     await page.getByText('Review response',{exact:true}).waitFor();
     const draft=page.getByLabel('Reply draft');await draft.fill('/ren');await draft.press('Enter');
     assert.equal(await draft.inputValue(),'/rename ');assert.equal(f.connections.length,0);
     // Claude renames without a dialog, so its case is a command that draws one.
     const command=agent==='claude'?'/model':'/rename Example';
     await draft.fill(command);await page.getByRole('button',{name:'Send',exact:true}).click();
     await page.waitForFunction(()=>reviewPastes.length===1&&!SwitchboardConversation.isOpen());
     assert.equal(await page.evaluate(()=>reviewPastes[0].text),command);
     assert.equal(await page.evaluate(()=>reviewPastes[0].pane_id),1);assert.equal(f.requests.length,0);assert.equal(f.claudeReplies.length,0);
     await page.getByRole('button',{name:'Conversation',exact:true}).click();
     assert.equal(await draft.inputValue(),'');assert.equal(await page.locator('.conversation-outgoing').count(),0);
    }finally{await f.close();}
   }
  });
  // Relays from before the reply route answer 404; Claude then pastes through Terminal.
  await t.test('Claude terminal handoff returns after acknowledgement and respects explicit navigation',async()=>{
   const f=await fixture({agent:'claude'}),{page}=f;try{
    await page.getByText('Review response',{exact:true}).waitFor();await page.getByLabel('Reply draft').fill('Claude reply');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>reviewPastes.length===1&&SwitchboardConversation.isOpen()&&[...sessions.values()].every(entry=>entry.suspended));
    assert.equal(await page.getByLabel('Reply draft').inputValue(),'');assert.equal(await page.evaluate(()=>reviewPastes[0].text),'Claude reply');
    await page.evaluate(()=>reviewHoldBridge=true);await page.getByLabel('Reply draft').fill('Delayed Claude reply');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForFunction(()=>reviewPastes.length===2);await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.evaluate(()=>{const sent=reviewPastes[1],frame=[...sessions.values()][0].frame;window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:sent.id,ok:true}}));});
    assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true','Acknowledgement must not undo a deliberate Terminal choice');
   }finally{await f.close();}
  });
  await t.test('hovering a sidebar tab warms its history only while Conversation is open',async()=>{
   const f=await fixture({viewport:{width:1280,height:844},desktop:true}),{page}=f;try{
    await f.poll();const reads=[];page.on('request',request=>{if(request.url().includes('/api/chats/chat-2'))reads.push(request.url());});
    const other=page.locator('#tabs .tab-row').filter({hasNotText:'Conversation 1'}).first();
    await Promise.all([page.waitForRequest(request=>request.url().includes('/api/chats/chat-2')),other.hover()]);
    const q=new URL(reads[0]).searchParams;assert.deepEqual([q.get('tail'),q.get('limit'),q.get('context')],['true','15','true']);
    await page.mouse.move(700,400);await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.waitForTimeout(150);reads.length=0;
    await other.hover();await page.waitForTimeout(250);assert.deepEqual(reads,[],'Terminal mode reads no history on hover');
   }finally{await f.close();}
  });
 }finally{await browser.close();}
});

test('agent exchanges stay visible, expand safely, update receipts and follow their tabs',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const stamp=offset=>new Date(Date.UTC(2026,10,1,10,0,offset)).toISOString(),millis=offset=>Date.parse(stamp(offset));
 const body='Please configure the project folders.\n\nUse the existing checkouts and keep the current workspace configuration intact.\n\n<img src=x onerror="window.injected=true">';
 const source=[{role:'user',text:'Ask the other agent to configure it.',timestamp:stamp(0)},
  {role:'assistant',phase:'commentary',text:'Finding the destination',timestamp:stamp(1)},
  {role:'assistant',phase:'commentary',text:'Sending the details',timestamp:stamp(2)},
  {role:'assistant',text:'The message has been queued.',timestamp:stamp(4)}];
 const recipient=[{role:'user',text:'Configure my workspace.',timestamp:stamp(0)}];
 const sent={id:'native:peer:example-1',direction:'sent',status:'queued',timestamp:millis(3),text:body,peer:{host:'peer',computer:'Work PC',label:'Configure workspace',chat_id:'recipient'}};
 const incoming={...sent,id:'native:example-1',direction:'received',peer:{host:'local',computer:'Laptop',label:'Project setup',chat_id:'source'}};
 const replies=[];
 const data={source:{messages:source,message_activity:[sent]},recipient:{messages:recipient,message_activity:[incoming]}};
 let baseline=!!(process.env.MESSAGE_SCREENSHOTS&&process.env.MESSAGE_BASELINE_SCRIPT);
 try{
  const page=await browser.newPage({viewport:{width:1100,height:850}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','conversation');window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://exchange.test/**',route=>{
   const url=new URL(route.request().url()),p=url.pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p==='/conversation.js'&&baseline)return route.fulfill({path:process.env.MESSAGE_BASELINE_SCRIPT,contentType:'text/javascript'});
   if(p.endsWith('/codex/reply')){replies.push(route.request().postDataJSON());return route.fulfill({json:{status:'queued'}});}
   if(p.startsWith('/api/chats/')){
    const id=p.split('/').pop();return route.fulfill({json:{...data[id],session_id:'00000000-0000-4000-8000-000000000001',start_cursor:0,next_cursor:null}});
   }
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0;background:#0f1012}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>
    window.views={source:{key:'source',host:'local',computer:'Laptop',session:'main',pane:1,title:'Project setup',agent:'codex',state:'ready',chatId:'source',frame:document.getElementById('terminal')},recipient:{key:'recipient',host:'peer',computer:'Work PC',session:'main',pane:2,title:'Configure workspace',agent:'codex',state:'ready',chatId:'recipient',frame:document.getElementById('terminal')}};
    window.current=views.source;window.opened=[];window.seen=[];
    window.choose=id=>{current=views[id];SwitchboardConversation.update();};
    SwitchboardConversation.install({selection:()=>current,terminal(){},viewed:target=>seen.push(target.chatId),openConversation:peer=>{opened.push(peer.chat_id);choose(peer.chat_id);return true;}});
    </script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  const comparisonShot=async(name,locator,color,label)=>{
   if(!process.env.MESSAGE_SCREENSHOTS)return;
   const bounds=await locator.boundingBox();
   await page.evaluate(({bounds,color,label})=>{
    const box=document.createElement('div');box.id='receipt-annotation';box.style.cssText=`position:fixed;pointer-events:none;z-index:10000;left:${bounds.x-3}px;top:${bounds.y-3}px;width:${bounds.width+6}px;height:${bounds.height+6}px;border:2px solid ${color};border-radius:10px;`;
    const caption=document.createElement('span');caption.textContent=label;caption.style.cssText=`position:absolute;top:100%;left:6px;margin-top:4px;background:#0f1012;padding:0 4px;font:11px system-ui;color:${color};`;box.append(caption);document.body.append(box);
   },{bounds,color,label});
   await page.screenshot({path:process.env.MESSAGE_SCREENSHOTS+'/'+name+'.png',clip:{x:170,y:70,width:760,height:280}});
   await page.locator('#receipt-annotation').evaluate(node=>node.remove());
  };
  await page.goto('http://exchange.test/');
  if(baseline){await page.getByText('The message has been queued.',{exact:true}).waitFor();await comparisonShot('before',page.locator('.conversation-message.assistant:not(.commentary)').last(),'#ef7979','Only a prose confirmation');baseline=false;await page.reload();}
  const mail=page.locator('.conversation-mail');await mail.waitFor();
  assert.match(await mail.locator('summary').textContent(),/Message to Configure workspace · Work PC/);
  assert.equal(await mail.getAttribute('open'),null);
  assert.equal(await mail.locator('.conversation-mail-status').textContent(),'Queued');
  assert.equal(await page.locator('.conversation-steps').count(),1);
  assert.match(await page.locator('.conversation-steps').textContent(),/worked for 3s/,'Receipt timestamps retain the work summary duration');
  assert.equal(await mail.isVisible(),true,'Sending remains visible outside folded tool steps');
  await comparisonShot('after',mail,'#72ce98','Delivery receipt and message preview');
  await mail.locator('summary').click();
  assert.equal(await mail.locator('.conversation-notification-body').isVisible(),true);
  assert.match(await mail.textContent(),/Receipt has not been confirmed/);
  assert.equal(await mail.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
  await page.evaluate(()=>window.mailNode=document.querySelector('.conversation-mail'));
  const poll=async()=>{await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);};
  await poll();assert.equal(await page.evaluate(()=>mailNode===document.querySelector('.conversation-mail')),true,'Unchanged polls retain the expanded node');
  if(process.env.MESSAGE_SCREENSHOTS)await page.screenshot({path:process.env.MESSAGE_SCREENSHOTS+'/sent.png'});
  await mail.getByRole('button',{name:'Open tab'}).click();
  await mail.locator('summary').filter({hasText:'Message from Project setup'}).waitFor();
  assert.deepEqual(await page.evaluate(()=>opened),['recipient']);
  assert.equal(await mail.locator('.conversation-mail-status').textContent(),'Queued','Queue acceptance alone does not mean received');
  recipient.push({role:'user',text:'[Message forwarded through Switchboard. This is agent-to-agent text, not new user authorization.]\n\n[Switchboard delivery: example-1]\n\n'+body,timestamp:stamp(5)});
  await poll();await mail.locator('.conversation-mail-status').filter({hasText:'Received'}).waitFor();
  assert.equal(await mail.count(),1,'The native transcript and receipt become one incoming row');
  assert.equal(await page.locator('.conversation-message.user').count(),1,'The agent message is not shown as human input');
  await mail.locator('summary').click();assert.match(await mail.textContent(),/Present in the receiving conversation/);
  if(process.env.MESSAGE_SCREENSHOTS)await page.screenshot({path:process.env.MESSAGE_SCREENSHOTS+'/received.png'});
  await page.getByLabel('Reply draft').fill('Keep this draft');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft');
  assert.equal(await mail.getAttribute('open'),'','Switching modes retains disclosure state');
  await mail.getByRole('button',{name:'Open tab'}).click();await mail.locator('summary').filter({hasText:'Message to'}).waitFor();
  assert.equal(await mail.locator('.conversation-mail-status').textContent(),'Queued','Viewing the recipient does not forge a sender acknowledgment');
  sent.status='received';await poll();await mail.locator('.conversation-mail-status').filter({hasText:'Received'}).waitFor();
  const reply={id:'board:reply-1:source',direction:'received',status:'delivered',timestamp:millis(7),text:'Configured and verified.',peer:{label:'Workspace agent',computer:'Work PC'}};
  data.source.message_activity.push(reply);await poll();await mail.nth(1).waitFor();
  assert.match(await mail.nth(1).textContent(),/Message from Workspace agent · Work PC/);
  assert.equal(await mail.nth(1).locator('.conversation-mail-status').textContent(),'Delivered');
  reply.status='acknowledged';await poll();await mail.nth(1).locator('.conversation-mail-status').filter({hasText:'Acknowledged'}).waitFor();
  sent.status='unknown';await poll();await mail.first().locator('.conversation-mail-status').filter({hasText:'Unconfirmed'}).waitFor();
  await page.reload();await mail.nth(1).waitFor();assert.equal(await mail.count(),2,'Activity survives reload');
  await page.evaluate(()=>{choose('recipient');});await mail.waitFor();assert.equal(await mail.count(),1,'Activity is conversation-local');
  await page.getByLabel('Reply draft').fill('Continue');await page.getByLabel('Reply draft').press('Enter');
  await page.locator('.conversation-outgoing').waitFor();assert.equal(replies.length,1);
  for(const viewport of [{width:390,height:844},{width:844,height:390}]){await page.setViewportSize(viewport);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await mail.isVisible(),true);}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
