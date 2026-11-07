const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
test('current conversation opens directly, stays pane-local, and follows a new chat in the same pane',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE);let queries=0,held=null,hold=false,answer='Final answer';
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  // Reloading the fixture can report its interrupted transcript request.
  if(url.pathname==='/api/diagnostics/conversation')return json({});
  if(url.pathname==='/api/chats/search'){queries++;return json({error:'Unexpected history search'});}
  if(url.pathname==='/api/chats/claude-two'){assert.equal(url.searchParams.get('host'),'peer');return json({title:'Remote Claude',messages:[{role:'assistant',text:'Remote Claude answer'}],next_cursor:null});}
  if(url.pathname==='/api/chats/codex-one'){if(hold){hold=false;held=()=>json({messages:[{role:'assistant',text:'Stale response'}],next_cursor:null});return;}assert.equal(url.searchParams.get('host'),'local');const cursor=Number(url.searchParams.get('cursor'));return json({title:'Actual chat',messages:[{role:'user',text:'<img src=x onerror="window.injected=true">'},{role:'user',text:'draft one'},{role:'assistant',phase:'commentary',text:'Working on it'},{role:'assistant',text:answer}],start_cursor:0,next_cursor:null});}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100vh}</style><main id="terminals"><iframe id="terminal" class="active"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>
  window.sent=[];window.returned=0;window.current={key:'pane1',host:'mac',chatHost:'local',pane:1,title:'Test agent',agent:'codex',state:'ready',chatId:'codex-one',frame:document.getElementById('terminal')};
  current.frame.contentWindow.postMessage=data=>sent.push(data);
  SwitchboardConversation.install({selection:()=>current,terminal:()=>returned++});
  </script>`);}
  const file=path.join(__dirname,'static',path.basename(url.pathname));res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:390,height:844}});await page.addInitScript(()=>{Object.defineProperty(crypto,'randomUUID',{value:undefined});window.intervals=[];window.setInterval=fn=>intervals.push(fn);});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 // Wait for the UI to finish consuming each response before requesting another poll.
 const poll=async()=>{await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/codex-one')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);};
 const terminalMode=page.getByRole('button',{name:'Terminal',exact:true}),conversationMode=page.getByRole('button',{name:'Conversation',exact:true});
 const checkModes=async()=>{const a=await terminalMode.boundingBox(),b=await conversationMode.boundingBox();assert.ok(a&&b);assert.equal(a.y,b.y);assert.ok(a.x<b.x);assert.ok(b.y<20&&b.x+b.width<=page.viewportSize().width&&b.x+b.width>=page.viewportSize().width-20);};
 await checkModes();assert.equal(await conversationMode.getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#terminal').isVisible(),false);
 await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.locator('.conversation-message').first().waitFor();assert.equal(queries,0);assert.equal(await page.getByRole('button',{name:'Search',exact:true}).count(),0);assert.equal(await page.locator('.conversation-message img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('details').count(),0);assert.equal(await page.getByText('Working on it',{exact:true}).isVisible(),true);
 await checkModes();assert.equal(await conversationMode.getAttribute('aria-pressed'),'true');
 if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation.png'});
 await page.getByLabel('Reply draft').focus();await page.evaluate(()=>intervals.forEach(fn=>fn()));await page.getByText('Final answer',{exact:true}).waitFor();assert.equal(await page.locator('.conversation-message').count(),4);
 await page.evaluate(()=>{window.originalMessage=document.querySelector('.conversation-message');});
 await poll();
 assert.equal(await page.evaluate(()=>originalMessage===document.querySelector('.conversation-message')),true);assert.equal(await page.evaluate(()=>originalMessage===document.querySelector('.conversation-message')),true);
 await page.locator('.conversation-panel').focus();
 await poll();
 // New history continues arriving while the composer has focus, preserving existing message nodes.
 answer='Updated answer';await page.getByLabel('Reply draft').fill('keep typing');
 await page.evaluate(()=>intervals.forEach(fn=>fn()));await page.getByText('Updated answer',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>originalMessage===document.querySelector('.conversation-message')),true);assert.equal(await page.getByLabel('Reply draft').inputValue(),'keep typing');
 await page.getByLabel('Reply draft').fill('draft one');await page.getByLabel('Reply draft').press('Shift+Enter');assert.equal(await page.evaluate(()=>sent.length),0);await page.getByLabel('Reply draft').fill('draft one');await page.getByLabel('Reply draft').press('Enter');assert.equal(await page.evaluate(()=>sent[0].pane_id),1);assert.equal(await page.evaluate(()=>sent[0].submit),true);
 await page.evaluate(()=>{const m=sent[0];window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:null,data:{type:'zellij-conversation-paste-result',id:m.id,ok:true}}));});assert.equal(await page.getByLabel('Reply draft').inputValue(),'draft one');
 // Only an acknowledgement from this terminal clears the sent draft.
 await page.evaluate(()=>{window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:sent[0].id,ok:true}}));});
 assert.equal(await page.getByLabel('Reply draft').inputValue(),'');assert.equal(await page.locator('.conversation-outgoing').count(),1);assert.equal(await page.getByText('draft one',{exact:true}).count(),2);
 if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation-send.png'});
 assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),true);
 assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isEnabled(),true);
 await page.getByLabel('Reply draft').fill('draft one');
 await page.evaluate(()=>{current.state='working';});await page.getByLabel('Reply draft').press('Enter');
 assert.equal(await page.evaluate(()=>sent.length),1);assert.match(await page.locator('.conversation-send-notice').textContent(),/Still connecting/);
 await poll();
 assert.equal(await page.locator('.conversation-send-notice').isVisible(),true);
 await page.evaluate(()=>{current.state='ready';});
 await page.evaluate(()=>{current={...current,key:'pane2',pane:2,chatId:null};SwitchboardConversation.update();});assert.equal(await page.getByLabel('Reply draft').inputValue(),'');assert.equal(await page.locator('.conversation-message').count(),0);assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),true,'A draft in another pane blocks automatic refresh');
 await page.evaluate(()=>{current={...current,key:'pane1',pane:1,chatId:'codex-one'};SwitchboardConversation.update();});assert.equal(await page.getByLabel('Reply draft').inputValue(),'draft one');await page.locator('.conversation-message').first().waitFor();
 // A new/unreported session in the same pane must not retain the old transcript or draft.
 await page.evaluate(()=>{current={...current,chatId:null};SwitchboardConversation.update();});
 assert.equal(await page.locator('.conversation-message').count(),0);
 assert.equal(await page.getByLabel('Reply draft').isVisible(),false);
 assert.match(await page.locator('.conversation-notice').textContent(),/Connecting/);
 // Shell-only tabs have a plain empty state; startup and an unreported agent
 // remain distinct even when the pane/chat identity has not changed.
 await page.evaluate(()=>{current={...current,agent:null};SwitchboardConversation.update();});
 assert.equal(await page.locator('.conversation-notice').textContent(),'No agent');
 assert.equal(await page.getByRole('button',{name:/Start (Sol|Astra|Claude)/}).count(),0);
 await page.evaluate(()=>{current={...current,starting:true};SwitchboardConversation.update();});
 assert.equal(await page.locator('.conversation-notice').textContent(),'Starting agent…');
 await page.evaluate(()=>{current={...current,starting:false,agent:'codex'};SwitchboardConversation.update();});
 assert.match(await page.locator('.conversation-notice').textContent(),/Connecting/);
 // A hook arriving later connects the open panel automatically.
 await page.evaluate(()=>{current={...current,chatId:'codex-one'};SwitchboardConversation.update();});
 await page.locator('.conversation-message').first().waitFor();assert.equal(queries,0);
 // A late response from the previous chat must not paint into the selected peer's chat.
 hold=true;
 await page.evaluate(()=>intervals.forEach(fn=>fn()));
 while(!held)await new Promise(r=>setTimeout(r,10));
 await page.evaluate(()=>{current={...current,key:'peer/main/1',host:'peer',chatHost:'peer',pane:1,agent:'claude',chatId:'claude-two'};SwitchboardConversation.update();});
 await page.getByText('Remote Claude answer',{exact:true}).waitFor();held();
 await page.waitForTimeout(50);
 assert.equal(await page.getByText('Stale response',{exact:true}).count(),0);
 assert.equal(await page.getByLabel('Reply draft').inputValue(),'');
 for(const viewport of [{width:360,height:800},{width:844,height:390}]){await page.setViewportSize(viewport);await checkModes();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await page.evaluate(()=>returned),1);assert.equal(await page.locator('#terminal').isVisible(),true);await checkModes();assert.equal(await terminalMode.getAttribute('aria-pressed'),'true');if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/terminal.png'});await page.reload();assert.equal(await terminalMode.getAttribute('aria-pressed'),'true');await conversationMode.click();await page.reload();assert.equal(await conversationMode.getAttribute('aria-pressed'),'true');assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('phone chat opens the latest page, hides setup, and preserves messages and reading position',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),requests=[],payloads=[];
 const history=Array.from({length:503},(_,i)=>({role:i%2?'assistant':'user',text:`Message ${i}: ${'Conversation content. '.repeat(12)}`}));
 history[480]={role:'user',text:'# AGENTS.md instructions for /example\nInternal setup'};
 history[481]={role:'user',text:'<environment_context>Internal environment</environment_context>'};
 history[502]={role:'assistant',phase:'commentary',text:'Checking the final result…'};
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://chat.test/**',route=>{
   const url=new URL(route.request().url());
   if(url.pathname.startsWith('/api/chats/')){
    requests.push(Object.fromEntries(url.searchParams));
    const limit=Number(url.searchParams.get('limit'));
    const end=url.searchParams.has('before')?Number(url.searchParams.get('before')):history.length;
    const start=url.searchParams.has('tail')||url.searchParams.has('before')?Math.max(0,end-limit):Number(url.searchParams.get('cursor'));
    const messages=history.slice(start,Math.min(start+limit,end)),next=start+messages.length;
    payloads.push(messages);
    return route.fulfill({json:{messages,start_cursor:start,previous_cursor:start||null,next_cursor:next<end?next:null}});
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal" class="active"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'local',pane:1,agent:'codex',state:'working',chatId:'codex-long',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
  });
  await page.goto('http://chat.test/');
  // The newest step of a working agent is shown in the live row.
  await page.locator('.conversation-working-step[data-step="Checking the final result…"]').waitFor();
  assert.equal(requests.length,1);assert.equal(requests[0].tail,'true');
  assert.equal(requests[0].limit,'15');
  assert.equal(await page.locator('.conversation-message').count(),15);
  assert.ok(JSON.stringify(payloads[0]).length<JSON.stringify(history.slice(-50)).length*.4,'Initial phone download is less than 40% of the old page');
  await page.evaluate(()=>intervals.forEach(fn=>fn()));
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);
  assert.equal(requests.at(-1).cursor,'502');assert.equal(payloads.at(-1).length,1);
  assert.equal(await page.getByText(/Session instructions|Internal setup|Internal environment|Enter to send/).count(),0);
  assert.equal(await page.locator('.conversation-working').isVisible(),true);
  assert.ok(await page.evaluate(()=>{const n=document.querySelector('.conversation-messages');return n.scrollHeight-n.scrollTop-n.clientHeight<3;}));
  await page.getByLabel('Reply draft').fill('A mobile draft');await page.getByLabel('Reply draft').press('Enter');
  assert.equal(await page.getByLabel('Reply draft').inputValue(),'A mobile draft\n');
  const bounds=await page.locator('.conversation-compose').boundingBox();assert.ok(bounds.height<130);
  await page.evaluate(()=>{window.savedMessage=[...document.querySelectorAll('.conversation-message')].at(-1);document.querySelector('.conversation-messages').scrollTop=100;window.savedTop=document.querySelector('.conversation-messages').scrollTop;});
  history.push({role:'assistant',text:'The result is ready.'});
  await page.evaluate(()=>intervals.forEach(fn=>fn()));await page.getByText('The result is ready.',{exact:true}).waitFor({state:'attached'});
  assert.equal(await page.evaluate(()=>savedMessage.isConnected),true);
  assert.equal(await page.evaluate(()=>document.querySelector('.conversation-messages').scrollTop),100);
  await page.evaluate(()=>{document.querySelector('.conversation-messages').scrollTop=0;window.anchor=document.querySelector('.conversation-message');window.anchorY=anchor.getBoundingClientRect().y;});
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-message').length===64);
  assert.equal(requests.at(-1).before,'488');
  history[503].text='The result is ready, with an update.';
  await page.evaluate(()=>intervals.forEach(fn=>fn()));
  await page.getByText('The result is ready, with an update.',{exact:true}).waitFor({state:'attached'});
  assert.equal(requests.at(-1).cursor,'503');assert.equal(payloads.at(-1).length,1);
  assert.ok(await page.evaluate(()=>Math.abs(anchor.getBoundingClientRect().y-anchorY)<3));
  await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();
  assert.ok(await page.evaluate(()=>{const n=document.querySelector('.conversation-messages');return n.scrollHeight-n.scrollTop-n.clientHeight<3;}));
  await page.evaluate(()=>{current.state='ready';SwitchboardConversation.update();});
  assert.equal(await page.locator('.conversation-activity').textContent(),'Ready');assert.equal(await page.locator('.conversation-model').textContent(),'Codex');
  assert.equal(await page.getByRole('button',{name:/Load.*messages/}).count(),0);
  // A burst larger than one page still catches up without skipping messages.
  const beforeBurst=requests.length;
  for(let i=0;i<60;i++)history.push({role:'assistant',text:'Burst reply '+i});
  await page.evaluate(()=>intervals.forEach(fn=>fn()));
  await page.getByText('Burst reply 59',{exact:true}).waitFor({state:'attached'});
  assert.equal(await page.getByText(/^Burst reply /).count(),60);
  assert.deepEqual(requests.slice(beforeBurst).map(r=>r.cursor),['503','553']);
  assert.equal(await page.getByText('Message 488:',{exact:false}).count(),1);
  if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/phone-chat.png'});
 }finally{await browser.close();}
});

test('Android keyboard layout, file picker, and working Codex replies preserve drafts on retries',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),requests=[],uploads=[];
 let confirmed=false;
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.addInitScript(()=>{window.keyboardHeight=844;Object.defineProperty(visualViewport,'height',{get:()=>keyboardHeight});});
  await page.route('http://chat.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/attachments')){uploads.push({host:url.pathname,name:url.searchParams.get('name'),bytes:route.request().postDataBuffer().toString()});return route.fulfill({json:{path:'/uploads/'+url.searchParams.get('name')}});}
   if(url.pathname.endsWith('/codex/reply')){requests.push({host:url.pathname,...route.request().postDataJSON()});return confirmed?route.fulfill({json:{status:'queued'}}):route.abort();}
   if(url.pathname.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',messages:[...Array.from({length:25},(_,i)=>({role:'assistant',text:'Reply '+i+'\n'+('Detailed explanation. '.repeat(10))})),...(confirmed&&requests.length?[{role:'user',text:requests.at(-1).message}]:[])],start_cursor:0,next_cursor:null}});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><div id="workspace"><iframe id="terminal" hidden></iframe><main id="terminals"><section id="artifact-preview" hidden></section></main></div><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'peer',pane:1,agent:'codex',state:'working',chatId:'codex-chat',frame:document.getElementById('terminal')};window.pastes=[];current.frame.contentWindow.postMessage=data=>pastes.push(data);SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
  });
  await page.goto('http://chat.test/');await page.locator('.conversation-message').last().waitFor();
  const draft=page.getByLabel('Reply draft'),form=page.locator('.conversation-compose');
  await draft.fill('Please also inspect this screenshot.');
  for(const height of [500,360,844,480]){
   await page.evaluate(height=>{keyboardHeight=height;visualViewport.dispatchEvent(new Event('resize'));},height);
   const bounds=await form.boundingBox();assert.ok(bounds.y+bounds.height<=height&&height-bounds.y-bounds.height<=8,JSON.stringify(bounds));
   assert.ok(bounds.height<105,'Short composer must not grow excessively');
   assert.equal(await draft.evaluate(n=>getComputedStyle(n).overflowY),'hidden');
   assert.equal(await page.getByRole('button',{name:'Scroll to bottom',exact:true}).isVisible(),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),true);
  }
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Attach files',exact:true}).click();
  await page.evaluate(()=>{window.originalTarget=current;current={...current,key:'pane2',host:'other',chatId:'codex-other'};SwitchboardConversation.update();});
  await (await chooser).setFiles([{name:'screenshot.png',mimeType:'image/png',buffer:Buffer.from('fixture image')},{name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('fixture notes')}]);
  assert.equal(await page.locator('.conversation-attachment').count(),0);
  await page.evaluate(()=>{current=originalTarget;SwitchboardConversation.update();});
  await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-attachment small')].every(n=>n.textContent==='Ready')&&document.querySelectorAll('.conversation-attachment').length===2);
  assert.equal(await page.getByRole('button',{name:'Scroll to bottom',exact:true}).isVisible(),false);
  assert.equal(uploads.length,2);assert.ok(uploads.every(u=>u.host==='/api/hosts/peer/attachments'));
  await page.getByRole('button',{name:'Remove notes.txt',exact:true}).click();assert.equal(await page.locator('.conversation-attachment').count(),1);
  await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('.conversation-send-notice').getByText('Could not confirm sending. Retry to check its status.',{exact:true}).waitFor();
  assert.equal(await page.locator('.conversation-outgoing').count(),1);assert.equal(await page.locator('.conversation-outgoing').textContent().then(t=>t.includes('Please also inspect this screenshot.')),true);
  assert.equal(await draft.inputValue(),'Please also inspect this screenshot.');assert.equal(await page.locator('.conversation-attachment').count(),1);
  confirmed=true;await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  assert.equal(requests.length,2);assert.equal(requests[0].send_key,requests[1].send_key);assert.equal(requests[0].thread,'00000000-0000-4000-8000-000000000001');
  assert.equal(requests[0].message,'Please also inspect this screenshot.\n\nAttached files:\n/uploads/screenshot.png');
  assert.equal(await draft.inputValue(),'');assert.equal(await page.locator('.conversation-attachment').count(),0);assert.equal(await page.evaluate(()=>pastes.length),0);
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);assert.equal(await page.getByText('Please also inspect this screenshot.',{exact:true}).count(),1);
  await draft.fill('line\n'.repeat(30));assert.equal(await draft.evaluate(n=>getComputedStyle(n).overflowY),'auto');
  await draft.fill('Short again');assert.equal(await draft.evaluate(n=>getComputedStyle(n).overflowY),'hidden');
 }finally{await browser.close();}
});
