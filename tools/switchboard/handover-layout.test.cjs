const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('the single switch dialog supports model and effort selection in Conversation and Terminal on desktop and phone',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const mode of ['conversation','terminal'])for(const phone of [false,true])await t.test(`${mode}, ${phone?'phone':'desktop'}`,async()=>{
  const viewport=phone?{width:390,height:844}:{width:1280,height:900};
  const page=await browser.newPage({viewport,hasTouch:phone,isMobile:phone}),errors=[],created=[],requests=[];
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  const panes=[{pane_id:1,is_plugin:false,tab_position:0,cwd:'/home/fixture/git/project'}];
  const tabs=[{host:'fixture',session:'main',id:1,position:0,name:'Fix login redirect',panes}];
  await page.addInitScript(mode=>{localStorage.setItem('switchboard-view-mode',mode);localStorage.setItem('switchboard-mobile-view-mode',mode);window.setInterval=()=>0;},mode);
  await page.route('http://handover-layout.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=data=>route.fulfill({json:data}).catch(()=>{});requests.push(p);
   if(p==='/api/hosts')return json([{id:'fixture',name:'Desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention'&&url.searchParams.has('after'))return;
   if(p==='/api/attention')return json({tabs,panes:[{host:'fixture',session:'main',pane_id:1,agent:'claude',state:'ready',chat_id:'source',restart_available:true,token:'review:1',seen:true}],errors:[]});
   if(p==='/api/chats/source')return json({project:'/home/fixture/git/project',model:'claude-opus-5-5',reasoning_effort:'high',message_count:2,start_cursor:0,next_cursor:null,messages:[{role:'user',text:'Fix the login redirect',context_text:'Fix the login redirect'},{role:'assistant',text:'The fix is ready.',context_text:'The fix is ready.'}]});
   if(p==='/hosts/fixture/model-list')return json({codex:[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',default:true,default_effort:'low',efforts:[{id:'low',description:'Quick replies'},{id:'high',description:'Deeper reasoning'},{id:'xhigh',description:'Extra reasoning'}]},{id:'gpt-6-astra',name:'GPT-6-Astra',default_effort:'high',efforts:[{id:'low'},{id:'high'},{id:'xhigh'}]}]});
   if(p==='/hosts/fixture/project-list')return json(['project']);
   if(p==='/api/hosts/fixture/attachments')return json({path:'/home/fixture/attachments/context.json'});
   if(p==='/api/hosts/fixture/restart-agent'){created.push(route.request().postDataJSON());return json({tab_id:1,pane_id:2});}
   if(p.startsWith('/api/'))return json({});
   if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input aria-label="Fixture terminal"><script>const payload=${JSON.stringify({session_name:'main',panes,tabs,active_pane:panes[0]})};parent.postMessage({type:'zellij-state',payload},location.origin);addEventListener('message',e=>{if(e.data.type==='zellij-focus')parent.postMessage({type:'zellij-state',focus_id:e.data.focus_id,payload},location.origin)});</script>`});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  try{
   await page.goto('http://handover-layout.test/?host=fixture&session=main&tab=1');
   await page.locator('.tab-select').first().waitFor({state:'attached'});
   const open=async()=>{
    if(mode==='conversation')await page.getByRole('button',{name:'Switch model with context',exact:true}).click();
    else{
     if(phone&&await page.locator('#sidebar-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#sidebar-toggle').click();
     await page.locator('.tab-select').first().click({button:'right'});
     await page.getByRole('menuitem',{name:'Handover context…'}).click();
    }
    await page.waitForFunction(()=>!!newTabHandover?.context);
   };
   await open();
   assert.equal(await page.getByRole('dialog').count(),1,'The picker must not create a second dialog');
   assert.equal(await page.locator('.model-picker-foot-done').isVisible(),false);
   assert.equal(await page.locator('#new-tab-prompt').isVisible(),false,'Switching has no instructions field');
   assert.equal(await page.locator('.new-tab-head').isVisible(),false,'Only the selector is shown');
   await page.getByRole('button',{name:'Add GPT-6.1 Sol to favourites',exact:true}).click();
   await page.getByRole('tab',{name:/^Claude Code/}).click();
   await page.getByRole('button',{name:'Add Opus 5.5 to favourites',exact:true}).click();
   await page.getByRole('tab',{name:'Favourites',exact:true}).click();
   assert.deepEqual(await page.locator('.model-picker-name').allTextContents(),['GPT-6.1 Sol','Opus 5.5']);
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6.1 Sol','Starring does not change the handoff target');
   const geometry=await page.locator('#new-tab-dialog').evaluate(n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:n.scrollWidth,client:n.clientWidth};});
   assert.ok(geometry.left>=0&&geometry.right<=geometry.width&&geometry.top>=0&&geometry.bottom<=geometry.height+1,JSON.stringify(geometry));
   assert.ok(geometry.scroll<=geometry.client,'No horizontal scrolling');
   if(mode==='conversation'&&!phone){const anchor=await page.locator('.conversation-model').boundingBox();assert.ok(geometry.bottom<=anchor.y,'The selector opens above the bottom model chip');assert.ok(Math.abs(geometry.left-Math.min(anchor.x,viewport.width-(geometry.right-geometry.left)-12))<1,'The selector aligns with the model chip inside the conversation');}
   const search=page.getByRole('combobox',{name:'Search all models, or type any model name'});
   await search.fill('astra');await page.getByRole('option',{name:'GPT-6 Astra',exact:true}).click();
   await page.getByRole('radio',{name:'Extra high',exact:true}).click();
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high');
   assert.equal(created.length,0,'Choosing a model or effort does not start the switch');
   if(!phone){
    await page.getByRole('button',{name:'Cancel',exact:true}).focus();await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button',{name:'Switch model',exact:true}).evaluate(n=>document.activeElement===n),true);
   }
   // The selector and final action stay reachable in a short viewport.
   await page.setViewportSize({width:viewport.width,height:phone?600:650});
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   assert.equal(created.length,0,'Cancel never starts a replacement agent');
   await page.setViewportSize(viewport);await open();
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6.1 Sol','Cancelling does not save the draft model choice');
   await search.fill('astra');await search.press('Escape');
   assert.equal(await search.inputValue(),'');assert.equal(await page.locator('#new-tab-dialog').evaluate(n=>n.open),true,'Escape clears a search first');
   await search.press('Escape');await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   await open();await search.fill('astra');
   // The primary action must take the highlighted search result, even without Enter first.
   await search.press('ArrowDown');
   if(phone)await page.getByRole('button',{name:'Switch model',exact:true}).click();else await search.press('Enter');
   await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   assert.equal(created.length,1);assert.equal(created[0].handover.model,'codex:gpt-6-astra#high');
   assert.equal(created[0].pane_id,1);assert.equal(created[0].chat_id,'source');
   assert.equal(requests.some(p=>p.includes('close-tab')||p.endsWith('/new-tab')||p.endsWith('/escape')),false);
   if(phone&&await page.locator('#sidebar-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#sidebar-toggle').click();
   await page.getByRole('button',{name:'New tab',exact:true}).click();await page.locator('#new-tab-model').click();
   assert.equal(await page.getByRole('tab',{name:'Favourites',exact:true}).getAttribute('aria-selected'),'true');
   assert.deepEqual(await page.locator('.model-picker-name').allTextContents(),['GPT-6.1 Sol','Opus 5.5'],'New Tab sees the same saved favourites as Switch model');
   await page.keyboard.press('Escape');await page.keyboard.press('Escape');
   assert.deepEqual(errors,[]);
  }finally{await page.close();}
 });}finally{await browser.close();}
});
