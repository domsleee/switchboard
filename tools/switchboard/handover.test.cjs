const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const sandbox={TextEncoder,URLSearchParams,fetch};vm.runInNewContext(fs.readFileSync(__dirname+'/static/handover.js','utf8'),sandbox);
const {select,load,prompt}=sandbox.SwitchboardHandover;
const plain=value=>JSON.parse(JSON.stringify(value));

test('short handovers retain complete text, attribution and order while excluding setup and truncated previews',()=>{
 const entries=[{cursor:0,role:'user',text:'# AGENTS.md instructions for /repo\nSetup'},
  {cursor:1,role:'user',text:'Original request\nUse this constraint'},
  {cursor:2,role:'assistant',text:'Complete answer '+ 'x'.repeat(6000)},
  {cursor:3,role:'assistant',phase:'commentary',text:'Unfinished work'},
  {cursor:4,role:'assistant',text:'Clipped',truncated:true},
  {cursor:5,role:'assistant',phase:'commentary',kind:'tool',text:'Ran cargo test'}];
 const result=plain(select({chat_id:'source'},entries,6));
 assert.deepEqual(result.messages,entries.slice(1,4));
 assert.equal(result.coverage.omitted_messages,3);assert.equal(result.coverage.included_messages,3);
});

test('long unicode handovers stay within 64 KB, favor original and recent messages, and never shorten included text',()=>{
 const entries=Array.from({length:300},(_,cursor)=>({cursor,role:cursor%2?'assistant':'user',text:cursor===0?'Original task':`Message ${cursor}: ${'🚀'.repeat(300)}`}));
 const result=plain(select({chat_id:'source'},entries,300,true));
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=64000);assert.equal(result.messages[0].cursor,0);assert.equal(result.messages.at(-1).cursor,299);
 for(const message of result.messages)assert.equal(message.text,entries[message.cursor].text);
 assert.ok(result.coverage.omitted_messages>0);assert.equal(result.coverage.partial_history,true);
 assert.deepEqual(result.messages.map(m=>m.cursor),result.messages.map(m=>m.cursor).sort((a,b)=>a-b));
});

test('loader fetches original and recent history on its owning computer with bounded pagination',async()=>{
 const calls=[],history=Array.from({length:10000},(_,cursor)=>({role:cursor%2?'assistant':'user',text:'preview',truncated:true,context_text:`Message ${cursor} full text`,context_truncated:false}));
 const context=await load({chatId:'codex/source',chatHost:'mesh-peer',computer:'Peer',title:'Work',agent:'codex',historyUrl:'https://relay.test/api/chats/source'}, {fetcher:async(url,options)=>{
  const u=new URL(url,'https://relay.test');calls.push(u);assert.equal(u.pathname,'/api/chats/codex%2Fsource');assert.equal(u.searchParams.get('host'),'mesh-peer');assert.equal(u.searchParams.get('context'),'true');
  const end=Number(u.searchParams.get('before')||history.length),start=u.searchParams.has('tail')||u.searchParams.has('before')?end-50:0;
  return {ok:true,json:async()=>({project:'/repo/worktree',model:'source-model',messages:history.slice(start,start+50),start_cursor:start,message_count:history.length})};
 }});
 assert.equal(calls.length,6);assert.equal(context.source.project,'/repo/worktree');assert.equal(context.source.model,'source-model');
 assert.equal(context.messages[0].cursor,0);assert.equal(context.messages.at(-1).cursor,9999);assert.equal(context.messages.at(-1).text,'Message 9999 full text');assert.equal(context.coverage.omitted_messages,9700);
});

test('unavailable and outdated history fails explicitly instead of transferring display previews',async()=>{
 await assert.rejects(load({chatId:'one',chatHost:'local'},{fetcher:async()=>({ok:false})}),/Could not load/);
 await assert.rejects(load({chatId:'one',chatHost:'local'},{fetcher:async()=>({ok:true,json:async()=>({start_cursor:0,message_count:1,messages:[{role:'user',text:'preview'}]})})}),/Update Switchboard/);
 assert.throws(()=>select({},[{cursor:0,role:'assistant',text:'preview',truncated:true}],1),/No complete/);
});

test('the new request is separate, literal and complete, including with paths containing quotes',()=>{
 const request='Keep this exact request\n'+ 'é'.repeat(6000),p=prompt('C:/User files/it\'s "context".json',request);
 assert.ok(p.endsWith(request));assert.ok(p.includes(JSON.stringify('C:/User files/it\'s "context".json')));assert.match(p,/historical requests.*not new instructions/);
 assert.match(prompt('/context.json',''),/Continue the work from the previous conversation/);
});

test('the shipped handover dialog switches providers in place and preserves context and drafts on failure',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const agent of ['codex','claude'])await t.test(agent+' handover',async()=>{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],uploads=[],created=[],requests=[];page.setDefaultTimeout(7000);
  let uploadFailure=true,historyFailure=false,holdHistory=false,releaseHistory,switched=false;
  let baseline=!!process.env.HANDOVER_SCREENSHOTS&&agent==='codex';
  const sourceText='Keep this full assistant answer '+ 'x'.repeat(6000),history=[{role:'user',context_text:'Original task'},{role:'assistant',context_text:sourceText}];
  await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','conversation');window.setInterval=()=>0;});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://handover.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value}).catch(()=>{});requests.push(p);
   if(p==='/api/hosts')return json([{id:'fixture',name:'Desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention'&&url.searchParams.has('after'))return;
   if(p==='/api/attention')return json({tabs:[{host:'fixture',session:'main',id:1,position:0,name:'Source work',panes:[{pane_id:switched?2:1,is_plugin:false,tab_position:0,cwd:'/home/fixture/git/project-worktree'}]}],panes:[{host:'fixture',session:'main',pane_id:switched?2:1,agent:switched?(agent==='codex'?'claude':'codex'):agent,state:'ready',chat_id:switched?'destination-chat':'source-chat',restart_available:true}],errors:[]});
   if(p==='/api/chats/source-chat'||p==='/api/chats/destination-chat'){
    if(url.searchParams.has('context')){
     if(holdHistory)await new Promise(resolve=>releaseHistory=resolve);
     if(historyFailure)return route.fulfill({status:503,body:'offline'}).catch(()=>{});
    }
    return json({project:'/home/fixture/git/project-worktree',message_count:2,start_cursor:0,next_cursor:null,messages:history.map(m=>({...m,text:m.context_text.slice(0,4000),context_truncated:false}))});
   }
   if(p==='/hosts/fixture/project-list')return json(['switchboard','project-worktree']);
   if(p==='/api/hosts/fixture/attachments'){
    uploads.push(JSON.parse(route.request().postData()));
    return uploadFailure?route.fulfill({status:503,body:'offline'}):json({path:'/home/fixture/attachments/context handover.json'});
   }
   if(p==='/api/hosts/fixture/restart-agent'){created.push(route.request().postDataJSON());switched=true;return json({pane_id:2,tab_id:1});}
   if(p.startsWith('/api/'))return json({});
   if(p.startsWith('/hosts/'))return route.fulfill({status:500,body:'A handover must not attach a terminal viewer'});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   if(baseline&&p==='/conversation.js')return route.fulfill({contentType:'text/javascript',body:require('node:child_process').execFileSync('git',['show','HEAD:tools/switchboard/static/conversation.js'],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'})});
   return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  try{
   await page.goto('http://handover.test/?host=fixture&session=main&tab=1');
   if(baseline){
    await page.getByLabel('Reply draft').waitFor();
    await composerScreenshot('before','Model display','#fa7171');baseline=false;await page.reload();
    await page.getByRole('button',{name:'Switch model with context'}).waitFor();await composerScreenshot('after','Switch provider','#7ce3a1');
   }
   async function composerScreenshot(name,label,color){
    const clip=await page.locator('.conversation-compose').boundingBox();
    await page.locator('.conversation-model').evaluate((node,{label,color})=>{node.style.outline='2px solid '+color;const rect=node.getBoundingClientRect(),note=document.createElement('span');note.id='screenshot-note';note.textContent=label;Object.assign(note.style,{position:'fixed',left:rect.left+'px',top:(rect.top-24)+'px',color,background:'#12151b',font:'12px system-ui',padding:'2px 4px',zIndex:2000});document.body.append(note);},{label,color});
    fs.mkdirSync(process.env.HANDOVER_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.HANDOVER_SCREENSHOTS,'handover-'+name+'.png'),clip:{x:clip.x-4,y:clip.y-30,width:clip.width+8,height:clip.height+34}});
    await page.evaluate(()=>{document.getElementById('screenshot-note').remove();document.querySelector('.conversation-model').style.outline='';});
   }
   await page.getByLabel('Reply draft').fill('Unsent source draft');
   const open=async()=>{await page.getByRole('button',{name:'Switch model with context',exact:true}).click();};
   historyFailure=true;await open();await page.getByRole('button',{name:'Retry loading context'}).waitFor();assert.equal(await page.getByRole('button',{name:'Switch model',exact:true}).isEnabled(),false);
   historyFailure=false;await page.getByRole('button',{name:'Retry loading context'}).click();await page.waitForFunction(()=>!!newTabHandover?.context);
   assert.equal(await page.locator('#new-tab-project').inputValue(),'/home/fixture/git/project-worktree');assert.equal(await page.locator('#new-tab-project').isVisible(),false);assert.equal(await page.locator('#new-tab-prompt').isVisible(),false);
   if(process.env.HANDOVER_SCREENSHOTS&&agent==='codex')await page.locator('#new-tab-dialog').screenshot({path:path.join(process.env.HANDOVER_SCREENSHOTS,'handover-dialog.png')});
   await page.evaluate(model=>setNewTabModel(model),agent==='codex'?'claude:claude-opus-5-5#max':'codex:gpt-6.1-sol#xhigh');
   await page.getByRole('button',{name:'Switch model',exact:true}).click();await page.getByText('Could not transfer context to the destination computer. Try again.').waitFor();assert.equal(created.length,0);
   uploadFailure=false;await page.getByRole('button',{name:'Switch model',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   assert.equal(created.length,1);assert.equal(created[0].handover.model,agent==='codex'?'claude:claude-opus-5-5#max':'codex:gpt-6.1-sol#xhigh');assert.equal(created[0].pane_id,1);assert.equal(created[0].tab_id,1);assert.equal(created[0].chat_id,'source-chat');assert.equal(created[0].handover.source_messages,2);
   assert.ok(created[0].handover.prompt.endsWith('Continue the work from the previous conversation.'));assert.ok(!created[0].handover.prompt.includes('Unsent source draft'));assert.ok(created[0].handover.prompt.includes('context handover.json'));
   assert.equal(uploads.at(-1).messages[1].text,sourceText);assert.deepEqual(uploads.at(-1).messages.map(m=>m.role),['user','assistant']);
   assert.equal(requests.some(p=>p.includes('close-tab')||p.includes('/new-tab')||p.includes('/reply')),false);
   // Cancelling a slow load must not repopulate the next ordinary new-tab dialog.
   await page.getByLabel('Reply draft').waitFor();assert.equal(await page.getByLabel('Reply draft').inputValue(),'Unsent source draft');
   holdHistory=true;await open();await page.waitForFunction(()=>document.querySelector('#handover-summary').textContent.includes('Loading conversation'));
   while(!releaseHistory)await new Promise(resolve=>setTimeout(resolve,10));
   await page.keyboard.press('Escape');await page.getByRole('button',{name:'New tab',exact:true}).click();holdHistory=false;releaseHistory();
   assert.equal(await page.locator('#handover-preview').isVisible(),false);assert.equal(await page.locator('#new-tab-title').textContent(),'New tab');assert.equal(await page.getByRole('button',{name:'Create tab',exact:true}).isEnabled(),true);assert.equal(await page.getByLabel('Prompt',{exact:true}).textContent(),'');
   await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.deepEqual(errors,[]);
  }catch(error){error.message+='\nPage errors: '+JSON.stringify(errors)+'\nRequests: '+JSON.stringify(requests)+'\nPage: '+(await page.locator('body').innerText()).slice(-5000);throw error;}
  finally{releaseHistory?.();await page.close();}
 });}finally{await browser.close();}
});

// One Claude tab on a fixture relay, with its agent state, restart support and history under test control.
async function busySwitch(browser,{phone=false}={}){
 const page=await browser.newPage({viewport:phone?{width:390,height:844}:{width:1280,height:900},hasTouch:phone,isMobile:phone});page.setDefaultTimeout(7000);
 const f={page,state:'ready',restartable:true,switched:false,hold:null,holdUpload:{},errors:[],uploads:[],created:[],requests:[],history:[{role:'user',text:'Original task'},{role:'assistant',text:'First answer'}]};
 await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','conversation');localStorage.setItem('switchboard-mobile-view-mode','conversation');window.setInterval=()=>0;});
 page.on('pageerror',error=>f.errors.push(error.message));
 await page.route('http://busy-switch.test/**',async route=>{
  const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value}).catch(()=>{});f.requests.push(p);
  if(p==='/api/hosts')return json([{id:'fixture',name:'Desktop',local:true}]);
  if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
  // Like the relay: a restartable agent reports it only while ready or working.
  if(p==='/api/attention'&&url.searchParams.has('after'))return;
   if(p==='/api/attention')return json({tabs:[{host:'fixture',session:'main',id:1,position:0,name:'Source work',panes:[{pane_id:f.switched?2:1,is_plugin:false,tab_position:0,cwd:'/home/fixture/git/project'}]},{host:'fixture',session:'main',id:3,position:1,name:'Other work',panes:[{pane_id:3,is_plugin:false,tab_position:1,cwd:'/home/fixture'}]}],panes:[{host:'fixture',session:'main',pane_id:f.switched?2:1,agent:f.switched?'codex':'claude',state:f.switched?'ready':f.state,chat_id:f.switched?'destination-chat':'source-chat',restart_available:f.switched||f.restartable&&['ready','working'].includes(f.state)}],errors:[]});
  // Pages like the relay: tail and before end a page, cursor starts one, next_cursor continues it.
  if(p==='/api/chats/source-chat'||p==='/api/chats/destination-chat'){
   const q=url.searchParams,limit=Number(q.get('limit')||10),end=q.has('before')?Math.min(Number(q.get('before')),f.history.length):f.history.length,start=q.get('tail')==='true'||q.has('before')?Math.max(0,end-limit):Math.min(Number(q.get('cursor')||0),end),page=f.history.slice(start,Math.min(end,start+limit));
   return json({project:'/home/fixture/git/project',model:'claude-opus-5-5',message_count:f.history.length,start_cursor:start,next_cursor:start+page.length<end?start+page.length:null,messages:page.map(m=>({...m,context_text:m.text,context_truncated:false}))});
  }
  if(p==='/api/hosts/fixture/attachments'){
   const name=url.searchParams.get('name');if(name==='switchboard-context-handover.json')f.uploads.push(JSON.parse(route.request().postData()));await f.holdUpload[name];
   return json({path:'/home/fixture/attachments/'+name});
  }
  if(p==='/api/hosts/fixture/restart-agent'){
   const body=route.request().postDataJSON();await f.hold;
   // Like the relay: a context count that is not the source's current one is stale.
   if(body.handover.source_messages!==f.history.length)return route.fulfill({status:409,body:'The conversation changed. Reload context.'}).catch(()=>{});
   f.created.push(body);f.switched=true;return json({pane_id:2,tab_id:1});
  }
  if(p.startsWith('/api/'))return json({});
  if(p.startsWith('/hosts/'))return route.fulfill({status:500,body:'A model switch must not attach a terminal viewer'});
  const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
  return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
 });
 Object.assign(f,{
  chip:page.getByRole('button',{name:'Switch model with context',exact:true}),cancel:page.getByRole('button',{name:'Cancel model switch'}),draft:page.getByLabel('Reply draft'),model:page.locator('.conversation-model'),
  attention:async next=>{f.state=next;await page.evaluate(()=>refreshAttention(true));},
  visit:name=>page.evaluate(name=>activate(allTabs().find(item=>item.tab.name===name)),name),
  send:async text=>{await f.draft.fill(text);await page.getByRole('button',{name:'Send',exact:true}).click();await page.locator('.conversation-outgoing').getByText(text).waitFor();},
  attach:async name=>{const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Attach files'}).click()]);await chooser.setFiles({name,mimeType:'text/plain',buffer:Buffer.from(name)});await page.locator('.conversation-attachment',{hasText:name}).getByText('Ready',{exact:true}).waitFor();},
  open:async()=>{await f.chip.click();await page.waitForFunction(()=>!!newTabHandover?.context);await page.evaluate(()=>setNewTabModel('claude:claude-sonnet-5-5'));},
  confirm:async()=>{await page.getByRole('button',{name:'Switch model',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);},
 });
 await page.goto('http://busy-switch.test/?host=fixture&session=main&tab=1');await page.getByText('First answer').waitFor();
 return f;
}

test('the model switch stays available while the agent works and waits for its turn to end',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const scenario=(name,run)=>t.test(name,async()=>{
  const f=await busySwitch(browser);
  try{await run(f);assert.equal(f.requests.some(p=>p.endsWith('/escape')||p.endsWith('/conversation/answer')),false);assert.deepEqual(f.errors,[]);}
  catch(error){error.message+='\nPage errors: '+JSON.stringify(f.errors)+'\nRequests: '+JSON.stringify(f.requests)+'\nPage: '+(await f.page.locator('body').innerText()).slice(-3000);throw error;}
  finally{await f.page.close();}
 });
 try{
  await scenario('queues while busy, cancels, survives tab visits and runs once the reply lands',async f=>{
   const {page,chip,cancel,draft,model}=f;
   // A reply the agent has not yet shown in its transcript stays queued, and the chip stays a control.
   await f.send('Please continue');assert.equal(await chip.isEnabled(),true);
   await f.attention('working');assert.equal(await page.locator('.conversation-activity').textContent(),'Working…');assert.equal(await chip.isEnabled(),true);
   // An attachment waiting in the composer does not block the switch; it stays unsent.
   await f.attach('notes.txt');assert.equal(await chip.isEnabled(),true);
   await draft.fill('Then tidy up');
   const choose=async()=>{
    await f.open();
    assert.equal(await page.locator('#new-tab-prompt').isVisible(),false);
    assert.equal(await draft.inputValue(),'Then tidy up');
    await f.confirm();
   };
   await choose();
   assert.equal(await model.textContent(),'Opus 5.5 → Sonnet 5.5 · after this turn');assert.equal(await chip.isEnabled(),true);assert.equal(await cancel.isVisible(),true);
   assert.equal(await draft.inputValue(),'Then tidy up','Unsent text stays in the composer while the model switch is queued');assert.equal(f.created.length,0,'A busy agent is not interrupted');
   // Cancelling restores the instructions to the composer.
   await cancel.click();assert.equal(await model.textContent(),'Opus 5.5');assert.equal(await cancel.isVisible(),false);assert.equal(await draft.inputValue(),'Then tidy up');
   await choose();await model.filter({hasText:'→ Sonnet 5.5'}).waitFor();
   // The queued switch belongs to its tab and survives visiting another one.
   await f.visit('Other work');await page.waitForFunction(()=>!document.querySelector('.conversation-model').textContent.includes('→'));
   await f.visit('Source work');await model.filter({hasText:'Opus 5.5 → Sonnet 5.5 · after this turn'}).waitFor();
   // Approval stays with the person; a ready agent still waits for the queued reply to reach its transcript.
   await f.attention('approval');await f.attention('ready');assert.equal(f.created.length,0);assert.match(await model.textContent(),/after this turn/);
   f.history.push({role:'user',text:'Please continue'},{role:'assistant',text:'Finished this turn'});
   await page.evaluate(()=>dispatchEvent(new Event('focus')));
   await page.waitForFunction(()=>!document.querySelector('.conversation-model')?.classList.contains('pending'));
   assert.equal(f.created.length,1);assert.equal(f.created[0].pane_id,1);assert.equal(f.created[0].chat_id,'source-chat');assert.equal(f.created[0].handover.model,'claude:claude-sonnet-5-5');
   assert.ok(f.created[0].handover.prompt.endsWith('Continue the work from the previous conversation.'));assert.ok(!f.created[0].handover.prompt.includes('notes.txt'));
   assert.equal(f.uploads.length,1,'Context loads when the switch runs');assert.equal(f.uploads.at(-1).messages.at(-1).text,'Finished this turn');
   assert.equal(await page.locator('.conversation-attachment').count(),1,'Unsent attachments stay in the composer');assert.equal(await draft.inputValue(),'Then tidy up');
  });
  await scenario('an automatic cancellation puts the queued instructions back in the composer',async f=>{
   await f.attention('working');await f.draft.fill('Keep these instructions');await f.open();await f.confirm();
   assert.equal(await f.draft.inputValue(),'Keep these instructions');
   f.restartable=false;await f.attention('ready');
   await f.page.waitForFunction(()=>!document.querySelector('.conversation-model').classList.contains('pending'));
   assert.equal(await f.draft.inputValue(),'Keep these instructions');assert.equal(f.created.length,0);
  });
  await scenario('a queued switch on a tab not on screen runs once its reply reaches the transcript',async f=>{
   await f.send('Please continue');await f.attention('working');await f.open();await f.confirm();
   await f.visit('Other work');
   // The agent writes more than a page after taking the reply.
   f.history.push({role:'user',text:'Please continue'},...Array.from({length:60},(_,i)=>({role:'assistant',text:'Step '+i})));await f.attention('ready');
   await f.page.waitForFunction(()=>!pendingSwitches.size);
   assert.equal(f.created.length,1);assert.equal(f.created[0].handover.source_messages,63);
  });
  await scenario('files added while the switch runs stay in the composer instead of vanishing',async f=>{
   await f.attention('working');await f.attach('notes.txt');await f.open();await f.confirm();
   let release;f.hold=new Promise(resolve=>release=resolve);await f.attention('ready');
   await f.model.filter({hasText:'switching…'}).waitFor();
   await f.attach('later.txt');release();
   await f.page.waitForFunction(()=>!pendingSwitches.size);
   assert.ok(!f.created[0].handover.prompt.includes('notes.txt'));
   await f.page.locator('.conversation-attachment',{hasText:'later.txt'}).waitFor();assert.equal(await f.page.locator('.conversation-attachment').count(),2);
  });
  await scenario('a selection still uploading when the switch completes moves to the new agent whole',async f=>{
   await f.attention('working');await f.open();await f.confirm();
   let release,releaseUpload;f.hold=new Promise(resolve=>release=resolve);f.holdUpload['first.txt']=new Promise(resolve=>releaseUpload=resolve);await f.attention('ready');
   await f.model.filter({hasText:'switching…'}).waitFor();
   const [chooser]=await Promise.all([f.page.waitForEvent('filechooser'),f.page.getByRole('button',{name:'Attach files'}).click()]);
   await chooser.setFiles(['first.txt','second.txt'].map(name=>({name,mimeType:'text/plain',buffer:Buffer.from(name)})));
   await f.page.locator('.conversation-attachment',{hasText:'first.txt'}).waitFor();release();
   await f.page.waitForFunction(()=>!pendingSwitches.size);await f.page.locator('.conversation-attachment',{hasText:'first.txt'}).waitFor();releaseUpload();
   for(const name of ['first.txt','second.txt'])await f.page.locator('.conversation-attachment',{hasText:name}).getByText('Ready',{exact:true}).waitFor();
   assert.equal(await f.page.locator('.conversation-attachment').count(),2);
  });
  await scenario('a dialog opened while busy switches with the turn that finished meanwhile',async f=>{
   await f.attention('working');await f.open();
   f.history.push({role:'user',text:'More please'},{role:'assistant',text:'Turn done'});await f.attention('ready');
   await f.confirm();
   assert.equal(f.created.length,1);assert.equal(f.created[0].handover.source_messages,4);assert.equal(f.uploads.at(-1).messages.at(-1).text,'Turn done');
  });
 }finally{await browser.close();}
});

test('a phone can choose a model and effort in an existing conversation',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const state of ['ready','working'])await t.test(state,async()=>{
  const f=await busySwitch(browser,{phone:true});
  try{
   await f.attention(state);await f.draft.fill('Unsent draft');
   await f.chip.tap();await f.page.waitForFunction(()=>!!newTabHandover?.context);
   await f.page.getByRole('option',{name:'GPT-6.1 Sol',exact:true}).tap();
   await f.page.getByRole('radio',{name:'High',exact:true}).tap();
   await f.page.getByRole('button',{name:'Switch model',exact:true}).tap();
   await f.page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   if(state==='working'){
    assert.equal(f.created.length,0,'The running turn is left to finish');
    assert.match(await f.model.textContent(),/after this turn/);
    await f.attention('ready');await f.page.waitForFunction(()=>!pendingSwitches.size);
   }
   assert.equal(f.created.length,1);assert.equal(f.created[0].handover.model,'codex:gpt-6.1-sol#high');
   assert.equal(f.created[0].tab_id,1);assert.equal(f.created[0].pane_id,1);
   await f.page.waitForFunction(()=>document.querySelector('.conversation-compose textarea')?.value==='Unsent draft');
   assert.equal(f.requests.some(p=>p.startsWith('/hosts/fixture/main')),false,'Switching does not attach a terminal viewer');
   assert.deepEqual(f.errors,[]);
  }finally{await f.page.close();}
 });}finally{await browser.close();}
});
