// Exercise the shipped page and app, including the real sidebar and view lifecycle.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('integrated Conversation journeys use production markup and preserve delivery, reading and navigation',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const uploadRoot='/home/fixture/.local/share/switchboard/attachments/11111111-2222-4333-8444-555555555555/';
 const portrait='<svg xmlns="http://www.w3.org/2000/svg" width="240" height="640"><rect width="240" height="640" fill="#426180"/></svg>';
 async function fixture(options={}){
  const page=await browser.newPage({viewport:options.viewport||{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(7000);
  if(options.clock)await page.clock.install();
  const f={page,errors:[],connections:[],requests:[],preparations:[],claudeReplies:[],claudeReplyStatus:404,history:new Map([[1,options.messages||[{role:'assistant',text:'Review response',model:'gpt-6.1-sol',reasoning_effort:'medium'}]],[2,[{role:'assistant',text:'Second conversation'}]]]),agent:options.agent||'codex',state:'ready',bound:options.bound!==false,model:'gpt-6.1-sol',effort:'medium',replyMode:'queue',autoHistory:false,prepareStatus:200,tabs:[1,2],newTabs:[],releaseReplies:[],releaseImages:[],delayImages:!!options.delayImages};
  await page.addInitScript(()=>{localStorage.setItem('switchboard-mobile-view-mode','conversation');localStorage.setItem('switchboard-view-mode','conversation');window.reviewIntervals=[];window.setInterval=fn=>reviewIntervals.push(fn);window.reviewOffset=0;const now=Date.now.bind(Date);Date.now=()=>now()+reviewOffset;window.reviewPastes=[];window.reviewHoldBridge=false;});
  const pane=id=>({pane_id:id,is_plugin:false,tab_id:id,tab_position:id-1,title:'Conversation '+id,is_focused:true});
  const thread=id=>'00000000-0000-4000-8000-'+String(id).padStart(12,'0');
  f.receipt=payload=>({role:'user',text:payload.slice(0,4000),...(payload.length>4000?{truncated:true,receipt_text:payload}:{}),...(payload.includes('\n\nAttached files:\n')?{markdown:[{type:'start',tag:'p'},{type:'text',text:payload.split('\n\nAttached files:\n')[0].slice(0,4000)},{type:'end'}],attachments:payload.split('\n\nAttached files:\n')[1].split('\n').map(url=>({kind:'image',name:url.split('/').at(-1),url}))}:{})});
  await page.route('http://conversation-review.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value}).catch(()=>{});
   if(p==='/api/health')return json({});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'fixture',name:'Fixture desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention')return json({tabs:f.tabs.map(id=>({host:'fixture',session:'main',id,position:id-1,name:'Conversation '+id,panes:[pane(id)]})),panes:f.tabs.map(id=>({host:'fixture',session:'main',pane_id:id,...(f.agent?{agent:f.agent}:{}),state:f.state,...(f.bound?{chat_id:'chat-'+id}:{})})),errors:[]});
   if(p.startsWith('/api/chats/')){const id=Number(p.split('-').at(-1));return json({id:'chat-'+id,model:f.model,reasoning_effort:f.effort,session_id:f.agent==='codex'?thread(id):null,messages:f.history.get(id)||[],start_cursor:0,next_cursor:null});}
   if(p.endsWith('/conversation/reply')){f.claudeReplies.push(route.request().postDataJSON());return route.fulfill({status:f.claudeReplyStatus,json:{ok:true}});}
   if(p.endsWith('/conversation/prepare')){f.preparations.push(route.request().postDataJSON());return route.fulfill({status:f.prepareStatus,json:{trusted:false}});}
   if(p.endsWith('/codex/reply')){
    const data=route.request().postDataJSON(),id=Number(data.thread.slice(-12));f.requests.push(data);
    if(f.autoHistory)f.history.get(id).push(f.receipt(data.message));
    if(f.replyMode==='hold')await new Promise(resolve=>f.releaseReplies.push(resolve));
    if(f.replyMode==='lost')return route.abort();
    return json({status:'queued'});
   }
   if(p.endsWith('/attachments'))return json({path:uploadRoot+url.searchParams.get('name')});
   if(p.endsWith('/file')){if(f.delayImages)await new Promise(resolve=>f.releaseImages.push(resolve));return route.fulfill({contentType:'image/svg+xml',body:portrait}).catch(()=>{});}
   if(p.endsWith('/new-tab')&&route.request().method()==='POST'){f.newTabs.push(route.request().postDataJSON());return json({pane_id:3,tab_id:3});}
   if(p.startsWith('/hosts/')){
    f.connections.push(p);
    return route.fulfill({contentType:'text/html',body:`<script>let active=${JSON.stringify(pane(1))};const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',active_pane:active,panes:${JSON.stringify([pane(1),pane(2)])}}},location.origin);addEventListener('message',event=>{const data=event.data;if(data.type==='zellij-focus'){active=${JSON.stringify([pane(1),pane(2)])}.find(p=>p.pane_id===data.pane_id);state(data.focus_id);}else if(data.type==='zellij-conversation-paste'){parent.reviewPastes.push(data);if(!parent.reviewHoldBridge)parent.postMessage({type:'zellij-conversation-paste-result',id:data.id,ok:true},location.origin);}});state();</script>`});
   }
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  f.refresh=()=>page.evaluate(()=>refreshAttention(true));
  f.poll=async()=>{await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>reviewIntervals.forEach(fn=>fn()))]);await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);};
  f.select=id=>page.evaluate(id=>activate(allTabs().find(item=>item.tab.id===id)),id);
  f.upload=async()=>{const choosing=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach files',exact:true}).click();await(await choosing).setFiles({name:'portrait.svg',mimeType:'image/svg+xml',buffer:Buffer.from(portrait)});await page.locator('.conversation-attachment').getByText('Ready',{exact:true}).waitFor();};
  f.release=()=>{f.releaseReplies.splice(0).forEach(fn=>fn());f.releaseImages.splice(0).forEach(fn=>fn());};
  f.close=async()=>{f.release();assert.deepEqual(f.errors,[]);await page.close();};
  page.on('pageerror',error=>f.errors.push(error.message));
  await page.goto('http://conversation-review.test/?host=fixture&session=main&tab=1',{waitUntil:'domcontentloaded'});
  if(f.bound)await page.getByLabel('Reply draft').waitFor();else await page.locator('.conversation-notice').waitFor();
  return f;
 }
 try{
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
  await t.test('unbound startup fails visibly, retries explicitly, and leaves shell tabs at No agent',async()=>{
   const f=await fixture({bound:false}),{page}=f;try{
    await page.waitForFunction(()=>document.querySelector('.conversation-notice').textContent.includes('Connecting'));
    await page.evaluate(()=>{reviewOffset=31000;reviewIntervals.forEach(fn=>fn());});
    await page.getByRole('button',{name:'Retry connection',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Open Terminal',exact:true}).isVisible(),true);
    f.prepareStatus=503;await page.getByRole('button',{name:'Retry connection',exact:true}).click();await page.getByText('Could not prepare this agent. Retry or open Terminal.',{exact:true}).waitFor();
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
    // Still reading ready afterwards, the pane keeps the timer the first message started.
    await f.refresh();
    assert.match(await page.locator('.conversation-notice').textContent(),/Connecting/,'The connection timer starts with the first message');
    await page.evaluate(()=>{reviewOffset=240000;reviewIntervals.forEach(fn=>fn());});
    await page.getByRole('button',{name:'Retry connection',exact:true}).waitFor();
    f.state='working';f.history.get(1).push({role:'user',text:'First task'});f.bound=true;await f.refresh();
    await page.locator('.conversation-message.user').getByText('First task',{exact:true}).waitFor();assert.equal(await page.locator('.conversation-outgoing').count(),0);
    assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),false,'The first send moves to the chat it started');
   }finally{await f.close();}
  });
  await t.test('a tab started from New tab shows its prompt and a starting spinner until the transcript has it',async()=>{
   const f=await fixture({agent:'claude'}),{page}=f;try{
    await page.evaluate(()=>createNewTab(sessionKey('fixture','main'),{project:'switchboard',command:'claude:claude-haiku-5-5',prompt:'Fix the flaky test\n\nAttached files:\n/tmp/log.txt'},()=>true,'Fix the flaky test'));
    await page.locator('.conversation-launch').getByText('Fix the flaky test',{exact:true}).waitFor();
    assert.deepEqual(f.newTabs.map(body=>body.prompt),['Fix the flaky test\n\nAttached files:\n/tmp/log.txt'],'The relay gets the full prompt');
    assert.equal(await page.locator('.conversation-working-step').getAttribute('data-step'),'Starting Claude…');
    assert.equal(await page.locator('.conversation-notice').isVisible(),false,'No connection notices while the prompt stands in');
    assert.equal(await page.locator('.conversation-panel header strong').textContent(),'Fix the flaky test');
    const row=page.locator('#tabs .tab-select.selected');
    assert.equal(await row.getAttribute('data-agent-state'),'Starting');assert.equal(await row.locator('.star.starting').count(),1);
    assert.equal(await row.locator('.tab-name').textContent(),'Fix the flaky test');
    // The relay first reports the new pane with no agent yet.
    f.tabs=[1,2,3];f.agent=null;f.state='unknown';f.bound=false;await f.refresh();
    assert.equal(await page.evaluate(()=>SwitchboardConversation&&allTabs().find(item=>item.key===selected)?.tab.id),3,'The real tab replaced the placeholder');
    assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Starting');
    assert.equal(await page.locator('.conversation-working-step').getAttribute('data-step'),'Starting Claude…');
    assert.equal(await page.locator('.conversation-notice').isVisible(),false);
    f.agent='claude';f.bound=true;
    f.state='working';f.history.set(3,[{role:'user',text:'Fix the flaky test'},{role:'assistant',text:'Looking at the test'}]);await f.refresh();
    await page.getByText('Looking at the test',{exact:true}).waitFor();
    assert.equal(await page.locator('.conversation-launch').count(),0,'The transcript replaces the stand-in');
    assert.equal(await page.locator('.conversation-message.user').count(),1);
    assert.notEqual(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Starting');
   }finally{await f.close();}
  });
  await t.test('Codex and Claude commands attach only after leaving Conversation and keep Terminal available',async()=>{
   for(const agent of ['codex','claude']){
    const f=await fixture({agent}),{page}=f;try{
     await page.getByText('Review response',{exact:true}).waitFor();
     const draft=page.getByLabel('Reply draft');await draft.fill('/ren');await draft.press('Enter');
     assert.equal(await draft.inputValue(),'/rename ');assert.equal(f.connections.length,0);
     await draft.fill('/rename Example');await page.getByRole('button',{name:'Send',exact:true}).click();
     await page.waitForFunction(()=>reviewPastes.length===1&&!SwitchboardConversation.isOpen());
     assert.equal(await page.evaluate(()=>reviewPastes[0].text),'/rename Example');
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
 }finally{await browser.close();}
});
