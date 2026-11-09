const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('Conversation never attaches a terminal, including initial mobile load and returning from Terminal',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(10000);
  let native=true;const errors=[],connections=[],replies=[],creations=[],reviews=[],tokens=new Map();page.on('pageerror',e=>errors.push(e.message));
  const pane=id=>({pane_id:id,is_plugin:false,tab_id:id===3?2:id,tab_position:id===3?2:id,tab_name:`Agent ${id}`,title:`Agent ${id}`,is_focused:true});
  const tabs=[1,2].map(id=>({host:'local',session:'main',id,position:id,name:`Agent ${id}`,panes:id===2?[pane(2),pane(3)]:[pane(id)]}));
  const thread='12345678-1234-1234-1234-123456789abc';
  let releaseHistory;const historyGate=new Promise(resolve=>releaseHistory=resolve);
  await page.route('http://conversation.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value});
   if(p==='/api/health')return json({});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'local',name:'Ubuntu',local:true}]);
   if(p==='/api/hosts/local')return json({id:'local',name:'Ubuntu',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention')return json({tabs,panes:tabs.flatMap(tab=>tab.panes).map(pane=>({host:'local',session:'main',pane_id:pane.pane_id,agent:'codex',state:'ready',token:tokens.get(pane.pane_id)||`result-${pane.pane_id}`,seen:false,chat_id:`chat-${pane.pane_id}`})),errors:[]});
   if(p==='/api/attention/ack'){reviews.push(route.request().postDataJSON());return json({ok:true});}
   if(p.startsWith('/api/chats/')){await historyGate;return json({id:p.split('/').at(-1),agent:'codex',session_id:native?(p.endsWith('chat-3')?thread.slice(0,-1)+'3':thread):null,messages:[{role:'assistant',text:'Ready for a reply'}],start_cursor:0,next_cursor:null});}
   if(p==='/api/hosts/local/codex/reply'){replies.push(route.request().postDataJSON());return json({status:'queued'});}
   if(p==='/api/hosts/local/attachments')return json({path:'/tmp/my uploaded shot.png'});
   if(p==='/hosts/local/new-tab'){
    creations.push(route.request().postDataJSON());const id=10+creations.length,tab_id=5+creations.length;
    tabs.push({host:'local',session:'main',id:tab_id,position:tabs.length,name:'New agent',panes:[{...pane(id),tab_id,tab_position:tabs.length}]});
    return json({pane_id:id,tab_id});
   }
   if(p==='/hosts/local/project-list')return json(['switchboard']);
   if(p==='/hosts/local/model-list')return json({codex:[]});
   if(p.startsWith('/hosts/')){
    connections.push(p);
    return route.fulfill({contentType:'text/html',body:`<script>
      let active=${JSON.stringify(pane(1))};
      const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',active_pane:active,panes:${JSON.stringify([pane(1),pane(2),pane(3)])}}},location.origin);
      addEventListener('message',event=>{if(event.data.type==='zellij-focus'){active=${JSON.stringify([pane(1),pane(2),pane(3)])}.find(p=>p.pane_id===event.data.pane_id);state(event.data.focus_id);}else if(event.data.type==='zellij-new-tab'){window.newTab=event.data;}else if(event.data.type==='zellij-conversation-paste'){(parent.bridgePastes??=[]).push(event.data);parent.postMessage({type:'zellij-conversation-paste-result',id:event.data.id,ok:true},location.origin);}});window.selectThird=()=>{active=${JSON.stringify(pane(3))};state();};state();
     </script>`});
   }
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://conversation.test/?host=local&session=main&tab=1');
  await page.getByText('Loading conversation…',{exact:true}).waitFor();
  assert.deepEqual(reviews,[],'Selecting a conversation does not review output before it loads');
  releaseHistory();
  await page.getByText('Ready for a reply',{exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.tab-select.selected')?.dataset.agentState==='Ready');
  assert.deepEqual(reviews,[{host:'local',session:'main',pane_id:1,token:'result-1'}],'Viewing the conversation reviews its result without a terminal focus acknowledgement');
  assert.equal(await page.locator('.tab-select:not(.selected)').getAttribute('data-agent-state'),'Ready to review','Unopened conversations remain unread');
  tokens.set(1,'result-1-new');
  await page.evaluate(()=>refreshAttention(true));
  await page.waitForFunction(()=>document.querySelector('.tab-select.selected')?.dataset.agentState==='Ready');
  assert.ok(reviews.some(review=>review.pane_id===1&&review.token==='result-1-new'),'A new result is reviewed while its conversation stays visible');
  assert.deepEqual(connections,[],'Mobile Conversation must not load a terminal page at all');
  assert.equal(await page.locator('iframe[title="Ubuntu: main"]').getAttribute('src'),'about:blank');
  await page.getByLabel('Reply draft').fill('Hello without resizing');await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.conversation-outgoing.queued')?.textContent.includes('Queued'));
  assert.equal(replies[0].message,'Hello without resizing');assert.deepEqual(connections,[]);
  await page.evaluate(()=>activate(allTabs().find(t=>t.tab.id===2)));
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('switchboard-attention-seen')||'{}')['["local","main",2]']==='result-2');
  assert.ok(reviews.some(review=>review.pane_id===2));
  assert.ok(!reviews.some(review=>review.pane_id===3),'A split pane whose conversation was not shown stays unread');
  await page.setViewportSize({width:844,height:390});
  assert.deepEqual(connections,[],'Switching tabs and rotating in Conversation must not attach');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.waitForFunction(()=>[...sessions.values()].some(e=>e.state?.active_pane?.pane_id===2));
  assert.equal(connections.length,1,'Terminal attaches and focuses the selected catalog pane');
  await page.evaluate(()=>[...sessions.values()][0].frame.contentWindow.selectThird());
  await page.waitForFunction(()=>[...sessions.values()][0].state?.active_pane?.pane_id===3);
  for(const outcome of ['cancel','refuse']){
   await page.evaluate(()=>{
    const w=[...sessions.values()][0].frame.contentWindow;
    w.__zjSuspendTerminal=()=>new Promise((resolve,reject)=>{w.finishRetirement=()=>resolve(false);w.refuseRetirement=()=>reject(new Error('incomplete sequence'));});
   });
   await page.getByRole('button',{name:'Conversation',exact:true}).click();
   await page.evaluate(()=>activate(allTabs().find(t=>t.tab.id===1)));
   await page.getByRole('button',{name:'Terminal',exact:true}).click();
   assert.equal(await page.evaluate(()=>[...sessions.values()][0].frame.inert),true);
   await page.evaluate(outcome=>{const w=[...sessions.values()][0].frame.contentWindow;w[outcome==='cancel'?'finishRetirement':'refuseRetirement']();},outcome);
   await page.waitForFunction(()=>![...sessions.values()][0].frame.inert);
   assert.equal(await page.evaluate(()=>allTabs().find(t=>t.key===selected).tab.id),2,'Selected tab must match the confirmed native pane before typing resumes');
   await page.evaluate(()=>{const e=[...sessions.values()][0];delete e.frame.contentWindow.__zjSuspendTerminal;activate(allTabs().find(t=>t.tab.id===2));e.frame.contentWindow.selectThird();});
   await page.waitForFunction(()=>[...sessions.values()][0].state?.active_pane?.pane_id===3);
  }
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.waitForFunction(()=>[...sessions.values()].every(e=>e.suspended&&e.frame.getAttribute('src')==='about:blank'&&!e.state));
  await page.getByLabel('Reply draft').fill('Reply to the focused split pane');
  await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByText('Queued',{exact:true}).waitFor();
  assert.equal(replies.at(-1).thread,thread.slice(0,-1)+'3','Suspension must preserve the second pane in a split tab');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.waitForFunction(()=>[...sessions.values()][0].state?.active_pane?.pane_id===3);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.setViewportSize({width:1200,height:900});await page.evaluate(()=>localStorage.setItem('switchboard-view-mode','conversation'));await page.reload();
  await page.getByText('Ready for a reply',{exact:true}).waitFor();
  assert.equal(connections.length,2,'Saved Conversation also avoids attaching at desktop widths');
  native=false;await page.reload();await page.getByText('Ready for a reply',{exact:true}).waitFor();
  await page.getByLabel('Reply draft').fill('Fallback reply');await page.getByRole('button',{name:'Send via Terminal',exact:true}).click();
  await page.waitForFunction(()=>window.bridgePastes?.some(sent=>sent.text==='Fallback reply'));
  await page.waitForFunction(()=>SwitchboardConversation.isOpen());
  assert.equal(await page.evaluate(()=>[...sessions.values()].every(e=>!e.suspended&&e.state)),true,'A desktop viewer stays connected after a Terminal fallback');
  assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>bridgePastes[0].pane_id),2);
  assert.equal(connections.length,3,'Fallback sending attaches only after switching to Terminal');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.locator('#new-tab').click();await page.locator('#new-tab-dialog').waitFor({state:'visible'});
  await page.keyboard.press('Escape');assert.equal(creations.length,0);
  await page.locator('#new-tab').click();await page.locator('#new-tab-prompt').fill('   ');
  await page.locator('#new-tab-form button[type="submit"]').click();
  await page.getByText('Type a prompt to start this chat.',{exact:true}).waitFor();
  assert.equal(await page.locator('#new-tab-dialog').evaluate(el=>el.open),true);assert.equal(creations.length,0);
  await page.keyboard.press('Escape');
  for(const command of ['Fix spaces and quotes: "hello"','Two lines\nsecond line','']){
   const count=creations.length+1;
   await page.locator('#new-tab').click();await page.locator('#new-tab-prompt').fill(command);
   await page.locator('#new-tab-picker').setInputFiles({name:'shot.png',mimeType:'image/png',buffer:Buffer.from('image')});
   await page.locator('#new-tab-form button[type="submit"]').click();
   await page.waitForFunction(id=>allTabs().find(t=>t.key===selected)?.tab.id===id,5+count);
   assert.equal(await page.locator('#new-tab-dialog').evaluate(el=>el.open),false);
   assert.equal(creations.at(-1).prompt,command);
   assert.deepEqual(creations.at(-1).images,['/tmp/my uploaded shot.png']);
   assert.equal(await page.evaluate(()=>allTabs().find(t=>t.key===selected).tab.panes[0].pane_id),10+creations.length);
   assert.equal(connections.length,3,'Creating a tab in Conversation must never attach a terminal');
   assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
  }
  assert.equal(creations.length,3);
  await page.locator('#new-tab').click();await page.locator('#new-tab-prompt').fill('/status');await page.locator('#new-tab-prompt').press('Escape');
  await page.locator('#new-tab-form button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('.conversation-panel')?.hidden);
  assert.equal(creations.at(-1).prompt,'/status');assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true','A command opens where its output appears');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Desktop keeps a connected terminal through Conversation so switching back is instant, and phone widths still disconnect it',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(10000);
  const errors=[],connections=[],timings=[];page.on('pageerror',e=>errors.push(e.message));
  // Hold the first transcript so the first switch to Conversation waits for it.
  let releaseChat;const chatGate=new Promise(resolve=>releaseChat=resolve);
  const pane={pane_id:1,is_plugin:false,tab_id:1,tab_position:1,tab_name:'Agent',title:'Agent',is_focused:true};
  const tabs=[{host:'local',session:'main',id:1,position:1,name:'Agent',panes:[pane]}];
  await page.route('http://conversation.test/**',async route=>{
   const p=new URL(route.request().url()).pathname,json=value=>route.fulfill({json:value});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'local',name:'Ubuntu',local:true}]);
   if(p==='/api/hosts/local')return json({id:'local',name:'Ubuntu',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention')return json({tabs,panes:[{host:'local',session:'main',pane_id:1,agent:'codex',state:'ready',token:'r',seen:true,chat_id:'chat-1'}],errors:[]});
   if(p.startsWith('/api/chats/')){await chatGate;}
   if(p.startsWith('/api/chats/'))return json({id:'chat-1',agent:'codex',session_id:null,messages:[{role:'assistant',text:'Ready for a reply'}],start_cursor:0,next_cursor:null});
   if(p.startsWith('/hosts/')){
    connections.push(p);
    return route.fulfill({contentType:'text/html',body:`<script>
      const state=()=>parent.postMessage({type:'zellij-state',payload:{session_name:'main',active_pane:${JSON.stringify(pane)},panes:${JSON.stringify([pane])}}},location.origin);
      addEventListener('message',event=>{
       if(event.data.type==='zellij-focus')state();
       if(event.data.type==='zellij-browser-resume'&&!parent.terminalStalled){const at=performance.timeOrigin+performance.now();parent.postMessage({type:'zellij-browser-resume-diagnostic',diagnostic:{id:event.data.id,phase:'animation',received_at:at,animation_at:at,render_cycle_ms:1}},location.origin);}
      });state();
      parent.postMessage({type:'zellij-load-diagnostic',diagnostic:{outcome:'ready',elapsed_ms:700,page_ms:100,socket_ms:200,frame_ms:300,render_ms:700,visible:true}},location.origin);
     </script>`});
   }
   if(p.startsWith('/api/diagnostics/')){timings.push({type:p.split('/').at(-1),...route.request().postDataJSON()});return route.fulfill({status:204});}
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://conversation.test/?host=local&session=main&tab=1');
  await page.waitForFunction(()=>[...sessions.values()][0]?.state);
  assert.equal(connections.length,1);
  for(let i=0;i<3;i++){
   await page.getByRole('button',{name:'Conversation',exact:true}).click();
   if(i===0){await page.waitForTimeout(200);releaseChat();}
   await page.getByText('Ready for a reply',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>{const e=[...sessions.values()][0];return !e.suspended&&!!e.state&&e.frame.getAttribute('src')!=='about:blank';}),true,'Conversation keeps the desktop viewer');
   await page.getByRole('button',{name:'Terminal',exact:true}).click();
   assert.equal(await page.evaluate(()=>{const e=[...sessions.values()][0];return !!e.state&&!e.frame.inert;}),true,'Terminal is ready without reconnecting');
  }
  assert.equal(connections.length,1,'Switching modes never reloads a connected desktop viewer');
  const until=async(check,message)=>{for(let i=0;i<100&&!check();i++)await page.waitForTimeout(20);assert.ok(check(),message);};
  const swaps=()=>timings.filter(t=>t.type==='browser-resume'&&t.reason==='conversation');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.waitForTimeout(300);
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  // The next switch ends the open timing, as hiding the browser or its 5 s sample would.
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await until(()=>swaps().length>=4,'Each switch back to a kept viewer is timed');
  assert.ok(swaps().every(t=>t.outcome==='superseded'&&t.terminal_probe===true&&Number.isInteger(t.elapsed_ms)&&Number.isInteger(t.hidden_ms)),'A kept viewer is probed for its first frame');
  assert.ok(swaps()[3].hidden_ms>=300,'The timing says how long Conversation was open');
  assert.deepEqual(timings.filter(t=>t.type==='terminal-load').map(t=>t.after),[undefined],'The first load did not follow Conversation');
  const shown=()=>timings.filter(t=>t.type==='conversation-shown');
  await until(()=>shown().length>=5,'Each switch to Conversation is timed');
  assert.deepEqual(shown().slice(0,4).map(t=>t.end),['history','cached','cached','cached'],'The first switch waits for its transcript; later ones show it from memory');
  assert.ok(shown()[0].elapsed_ms>=200&&shown()[0].paint_ms<shown()[0].elapsed_ms,'A fetched transcript is timed until it paints, not until the empty panel paints');
  assert.ok(shown().every(t=>Number.isInteger(t.elapsed_ms)&&(t.paint_ms===null||t.paint_ms<=t.elapsed_ms)),'Each timing has its wait and first paint');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.evaluate(()=>{const w=[...sessions.values()][0].frame.contentWindow;w.eval("parent.postMessage({type:'zellij-disconnected'},location.origin)");});
  await page.waitForFunction(()=>{const e=[...sessions.values()][0];return e.suspended&&e.frame.getAttribute('src')==='about:blank';});
  assert.equal(connections.length,1,'A viewer that drops during Conversation stays disconnected instead of reattaching hidden');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.waitForFunction(()=>[...sessions.values()][0].state);
  assert.equal(connections.length,2,'Terminal reconnects a dropped viewer when shown');
  await until(()=>timings.filter(t=>t.type==='terminal-load').length===2,'The reconnect reports its load');
  assert.deepEqual(timings.filter(t=>t.type==='terminal-load').map(t=>t.after),[undefined,'conversation'],'A viewer reloaded on leaving Conversation reports that load as the switch time');
  assert.equal(swaps().length,4,'A reconnect is timed by its load; probing the blank frame would have ended the open timing');
  const journeys=name=>timings.filter(t=>t.type==='timing'&&t.journey===name);
  await until(()=>journeys('conversation_to_terminal').at(-1)?.outcome==='ready','A reconnect ends its journey when the load reports');
  assert.equal(journeys('conversation_load')[0].outcome,'history','A fetched chat is timed as a load');
  assert.ok(journeys('conversation_load')[0].elapsed_ms>=200,'The journey covers the wait for the transcript');
  assert.equal(journeys('terminal_to_conversation')[0].outcome,'cached','A chat already in memory is timed apart from loads');
  const returns=journeys('conversation_to_terminal').length;
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.getByText('Ready for a reply',{exact:true}).waitFor();
  const leftWith=await page.evaluate(()=>[...sessions.values()][0].frame.getAttribute('src')!=='about:blank');
  assert.equal(leftWith,true,'The viewer stays connected behind Conversation');
  const started=Date.now();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await until(()=>journeys('conversation_to_terminal').length>returns,'A kept viewer reports its return');
  assert.ok(Date.now()-started<4000,'The journey ends at the first paint, not after the five-second sample');
  const kept=journeys('conversation_to_terminal').at(-1);
  assert.equal(kept.outcome,'ready');assert.equal(kept.hidden,false);
  assert.ok(kept.stages.some(([name])=>name==='terminal_message'),'The wait is split into stages');
  await page.evaluate(()=>{window.terminalStalled=true;});
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  const stalled=journeys('conversation_to_terminal').length;
  for(let i=0;i<350&&journeys('conversation_to_terminal').length===stalled;i++)await page.waitForTimeout(20);
  const never=journeys('conversation_to_terminal').at(-1);
  assert.equal(never.outcome,'timeout','A terminal that never paints is a stalled wait, not a fast one');
  assert.ok(never.elapsed_ms>=4900);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>[...sessions.values()].every(e=>e.suspended&&e.frame.getAttribute('src')==='about:blank'));
  assert.equal(connections.length,2,'A phone-width Conversation disconnects and never attaches');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Desktop Conversation follows a new tab while the connected viewer and catalog lag behind it',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const pane={pane_id:1,is_plugin:false,tab_id:1,tab_position:0,tab_name:'Agent',title:'Agent',is_focused:true};
  const created={pane_id:7,is_plugin:false,tab_id:4,tab_position:1,tab_name:'New agent',title:'New agent',is_focused:true};
  const tabs=[{host:'local',session:'main',id:1,position:0,name:'Agent',panes:[pane]}];
  let releaseCreation;const creationGate=new Promise(resolve=>releaseCreation=resolve);
  await page.route('http://conversation.test/**',async route=>{
   const p=new URL(route.request().url()).pathname,json=value=>route.fulfill({json:value});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'local',name:'Ubuntu',local:true}]);
   if(p==='/api/hosts/local')return json({id:'local',name:'Ubuntu',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention')return json({tabs,panes:tabs.flatMap(tab=>tab.panes).map(p=>({host:'local',session:'main',pane_id:p.pane_id,agent:'codex',state:'ready',token:'r',seen:true,chat_id:'chat-'+p.pane_id})),errors:[]});
   if(p.startsWith('/api/chats/'))return json({id:p.split('/').at(-1),agent:'codex',session_id:null,messages:[{role:'assistant',text:'Reply from '+p.split('/').at(-1)}],start_cursor:0,next_cursor:null});
   if(p==='/hosts/local/new-tab'){await creationGate;return json({pane_id:created.pane_id,tab_id:created.tab_id});}
   if(p==='/hosts/local/project-list')return json(['switchboard']);
   if(p==='/hosts/local/model-list')return json({codex:[]});
   if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<script>
      let panes=${JSON.stringify([pane])};
      const state=()=>parent.postMessage({type:'zellij-state',payload:{session_name:'main',active_pane:${JSON.stringify(pane)},panes,tabs:[{position:0,name:'Agent'},{position:1,name:'New agent'}]}},location.origin);
      window.addPane=pane=>{panes=[...panes,pane];state();};window.pushState=state;
      addEventListener('message',event=>{if(event.data.type==='zellij-focus')state();});state();
     </script>`});
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
  });
  await page.goto('http://conversation.test/?host=local&session=main&tab=1');
  await page.waitForFunction(()=>[...sessions.values()][0]?.state);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.getByText('Reply from chat-1',{exact:true}).waitFor();
  await page.locator('#new-tab').click();await page.locator('#new-tab-prompt').fill('Start');
  await page.locator('#new-tab-form button[type="submit"]').click();
  await page.waitForFunction(()=>allTabs().find(t=>t.key===selected)?.tab.id==='creating');
  // The connected viewer reports its unchanged focus while the request is in flight.
  await page.evaluate(()=>{[...sessions.values()][0].frame.contentWindow.pushState();return refreshAttention(true);});
  assert.equal(await page.evaluate(()=>allTabs().find(t=>t.key===selected)?.tab.id),'creating','Viewer focus on the old tab must not end creation');
  releaseCreation();
  await page.waitForFunction(id=>allTabs().find(t=>t.key===selected)?.tab.id===id,created.pane_id);
  // Neither the scanner nor the viewer has seen the new pane yet.
  await page.evaluate(()=>{[...sessions.values()][0].frame.contentWindow.pushState();return refreshAttention(true);});
  assert.equal(await page.evaluate(()=>allTabs().find(t=>t.key===selected)?.tab.panes[0]?.pane_id),created.pane_id,'The new tab stays selected before anything reports its pane');
  await page.evaluate(pane=>[...sessions.values()][0].frame.contentWindow.addPane(pane),created);
  assert.equal(await page.evaluate(()=>allTabs().find(t=>t.key===selected)?.tab.panes[0]?.pane_id),created.pane_id);
  tabs.push({host:'local',session:'main',id:created.tab_id,position:1,name:'New agent',panes:[created]});
  await page.evaluate(()=>refreshAttention(true));
  await page.waitForFunction(id=>allTabs().find(t=>t.key===selected)?.tab.id===id,created.tab_id);
  await page.getByText('Reply from chat-7',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Where viewers attach hidden, Conversation connects the selected terminal in the background so Terminal never reloads it',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(10000);
  const errors=[],connections=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{try{localStorage.setItem('switchboard-view-mode','conversation');}catch{}});
  const pane=(id,session)=>({pane_id:id,is_plugin:false,tab_id:id,tab_position:0,tab_name:session,title:session,is_focused:true});
  const tabs=['main','other'].map((session,i)=>({host:'local',session,id:i+1,position:0,name:session,panes:[pane(i+1,session)]}));
  await page.route('http://conversation.test/**',async route=>{
   const p=new URL(route.request().url()).pathname,json=value=>route.fulfill({json:value});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'local',name:'Ubuntu',local:true}]);
   if(p==='/api/hosts/local')return json({id:'local',name:'Ubuntu',local:true,sessions:['main','other'].map(name=>({name,web_clients_allowed:true,hidden_attach:true}))});
   if(p==='/api/attention')return json({tabs,panes:tabs.map(tab=>({host:'local',session:tab.session,pane_id:tab.panes[0].pane_id,agent:'codex',state:'ready',token:'r',seen:true,chat_id:'chat-'+tab.id})),errors:[]});
   if(p.startsWith('/api/chats/'))return json({id:p.split('/').at(-1),agent:'codex',session_id:null,messages:[{role:'assistant',text:'Reply in '+p.split('/').at(-1)}],start_cursor:0,next_cursor:null});
   if(p.startsWith('/hosts/')){
    const session=p.split('/').at(-1),own=pane(session==='main'?1:2,session);connections.push(session);
    return route.fulfill({contentType:'text/html',body:`<script>
      window.focusRequests=[];
      const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:${JSON.stringify(session)},active_pane:${JSON.stringify(own)},panes:${JSON.stringify([own])}}},location.origin);
      addEventListener('message',event=>{if(event.data.type==='zellij-focus'){focusRequests.push(event.data);state(event.data.focus_id);}});state(null);
     </script>`});
   }
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
  });
  const entry=session=>`[...sessions.values()].find(e=>e.name===${JSON.stringify(session)})`;
  const connected=session=>page.waitForFunction(`(()=>{const e=${entry(session)};return !!e&&!e.suspended&&!!e.state&&!e.needsFocus&&!e.focusPending;})()`);
  await page.goto('http://conversation.test/?host=local&session=main&tab=1');
  await page.getByText('Reply in chat-1',{exact:true}).waitFor();
  await connected('main');
  assert.deepEqual(connections,['main'],'A saved Conversation connects only the selected terminal');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.conversation-compose textarea')),true,'The background terminal leaves the composer focused');
  assert.equal(await page.evaluate(`${entry('main')}.frame.contentWindow.focusRequests.every(request=>request.preserve_focus)`),true);
  await page.evaluate(()=>activate(allTabs().find(item=>item.tab.id===2)));
  await page.getByText('Reply in chat-2',{exact:true}).waitFor();
  await connected('other');
  assert.deepEqual(connections,['main','other'],'Selecting another terminal in Conversation connects it in the background');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  assert.equal(await page.evaluate(`(()=>{const e=${entry('other')};return !!e.state&&!e.frame.inert&&!e.needsFocus;})()`),true,'Terminal is ready at once');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.evaluate(`${entry('other')}.frame.contentWindow.eval("parent.postMessage({type:'zellij-disconnected'},location.origin)")`);
  assert.equal(await page.evaluate(`(()=>{const e=${entry('other')};return !e.suspended&&e.frame.getAttribute('src')!=='about:blank';})()`),true,'A dropped viewer may reconnect hidden instead of reloading on Terminal');
  assert.deepEqual(connections,['main','other']);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('On a touch screen Conversation opens for reading, never focuses the draft until it is tapped, and the drawer closes the keyboard',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const pane=(id,session)=>({pane_id:id,is_plugin:false,tab_id:id,tab_position:0,tab_name:session,title:session,is_focused:true});
  const tabs=['main','other'].map((session,i)=>({host:'local',session,id:i+1,position:0,name:session,panes:[pane(i+1,session)]}));
  await page.route('http://conversation.test/**',async route=>{
   const p=new URL(route.request().url()).pathname,json=value=>route.fulfill({json:value});
   if(p==='/api/mesh')return json({members:[]});
   if(p==='/api/hosts')return json([{id:'local',name:'Ubuntu',local:true}]);
   if(p==='/api/hosts/local')return json({id:'local',name:'Ubuntu',local:true,sessions:['main','other'].map(name=>({name,web_clients_allowed:true,hidden_attach:true}))});
   if(p==='/api/attention')return json({tabs,panes:tabs.map(tab=>({host:'local',session:tab.session,pane_id:tab.panes[0].pane_id,agent:'codex',state:'ready',token:'r',seen:true,chat_id:'chat-'+tab.id})),errors:[]});
   if(p.startsWith('/api/chats/'))return json({id:p.split('/').at(-1),agent:'codex',session_id:null,messages:[{role:'assistant',text:'Reply in '+p.split('/').at(-1)}],start_cursor:0,next_cursor:null});
   if(p.startsWith('/hosts/')){
    const session=p.split('/').at(-1),own=pane(session==='main'?1:2,session);
    return route.fulfill({contentType:'text/html',body:`<textarea aria-label="Terminal input"></textarea><script>
      const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:${JSON.stringify(session)},active_pane:${JSON.stringify(own)},panes:${JSON.stringify([own])}}},location.origin);
      addEventListener('message',event=>{if(event.data.type==='zellij-focus')state(event.data.focus_id);});state(null);
     </script>`});
   }
   if(p.startsWith('/api/'))return json({});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'});
  });
  const draftFocused=()=>page.evaluate(()=>document.activeElement===document.querySelector('.conversation-compose textarea'));
  await page.goto('http://conversation.test/?host=local&session=main&tab=1');
  await page.getByText('Reply in chat-1',{exact:true}).waitFor();
  await page.getByLabel('Reply draft').waitFor();
  assert.equal(await draftFocused(),false,'Opening the page leaves the draft unfocused so no keyboard covers the reply');
  assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.conversation-panel')),true,'The conversation itself takes focus');
  await page.evaluate(()=>activate(allTabs().find(item=>item.tab.id===2)));
  await page.getByText('Reply in chat-2',{exact:true}).waitFor();
  assert.equal(await draftFocused(),false,'Switching tabs leaves the draft unfocused');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.getByText('Reply in chat-2',{exact:true}).waitFor();
  assert.equal(await draftFocused(),false,'Returning from Terminal leaves the draft unfocused');
  await page.getByLabel('Reply draft').tap();
  assert.equal(await draftFocused(),true,'Tapping the draft focuses it');
  await page.evaluate(()=>activate(allTabs().find(item=>item.tab.id===1)));
  await page.getByText('Reply in chat-1',{exact:true}).waitFor();
  assert.equal(await draftFocused(),false,'Changing conversation while the draft is focused moves focus off the draft');
  const nothingFocused=()=>page.evaluate(()=>!['TEXTAREA','INPUT','IFRAME'].includes(document.activeElement.tagName));
  await page.getByLabel('Reply draft').tap();
  await page.locator('#sidebar-toggle').tap();
  assert.equal(await nothingFocused(),true,'Opening the drawer takes focus off the draft, closing the keyboard');
  await page.locator('#sidebar-backdrop').click({position:{x:380,y:400}});
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  const terminalInput=page.frameLocator('iframe.active').getByLabel('Terminal input');
  await terminalInput.tap();
  assert.equal(await terminalInput.evaluate(input=>document.activeElement===input&&parent.document.activeElement.tagName==='IFRAME'),true);
  await page.locator('#sidebar-toggle').tap();
  assert.equal(await nothingFocused(),true,'Opening the drawer takes focus out of the terminal, closing the keyboard');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
