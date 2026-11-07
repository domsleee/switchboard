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
   if(p.startsWith('/hosts/')){
    connections.push(p);
    return route.fulfill({contentType:'text/html',body:`<script>
      let active=${JSON.stringify(pane(1))};
      const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',active_pane:active,panes:${JSON.stringify([pane(1),pane(2),pane(3)])}}},location.origin);
      addEventListener('message',event=>{if(event.data.type==='zellij-focus'){active=${JSON.stringify([pane(1),pane(2),pane(3)])}.find(p=>p.pane_id===event.data.pane_id);state(event.data.focus_id);}else if(event.data.type==='zellij-new-tab'){window.newTab=event.data;}else if(event.data.type==='zellij-conversation-paste'){window.sent=event.data;parent.postMessage({type:'zellij-conversation-paste-result',id:event.data.id,ok:true},location.origin);}});window.selectThird=()=>{active=${JSON.stringify(pane(3))};state();};state();
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
  await page.waitForFunction(()=>document.querySelector('.conversation-outgoing.queued')?.textContent.includes('Waiting for agent…'));
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
  await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByText('Waiting for agent…',{exact:true}).waitFor();
  assert.equal(replies.at(-1).thread,thread.slice(0,-1)+'3','Suspension must preserve the second pane in a split tab');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.waitForFunction(()=>[...sessions.values()][0].state?.active_pane?.pane_id===3);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.setViewportSize({width:1200,height:900});await page.evaluate(()=>localStorage.setItem('switchboard-view-mode','conversation'));await page.reload();
  await page.getByText('Ready for a reply',{exact:true}).waitFor();
  assert.equal(connections.length,2,'Saved Conversation also avoids attaching at desktop widths');
  native=false;await page.reload();await page.getByText('Ready for a reply',{exact:true}).waitFor();
  await page.getByLabel('Reply draft').fill('Fallback reply');await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.waitForFunction(()=>[...sessions.values()].some(e=>e.frame.contentWindow.sent?.text==='Fallback reply'));
  assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>[...sessions.values()][0].frame.contentWindow.sent.pane_id),2);
  assert.equal(connections.length,3,'Fallback sending attaches only after switching to Terminal');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.locator('#new-tab').click();await page.locator('#new-tab-dialog').waitFor({state:'visible'});
  await page.keyboard.press('Escape');assert.equal(creations.length,0);
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
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
