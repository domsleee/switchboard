const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('New Tab shares the model and effort picker and launches and remembers the selected pair',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const mode of ['conversation','terminal'])for(const phone of [false,true])await t.test(`${mode}, ${phone?'phone':'desktop'}`,async()=>{
  const viewport=phone?{width:390,height:844}:{width:1280,height:900};
  const page=await browser.newPage({viewport,hasTouch:phone,isMobile:phone}),errors=[],launches=[];
  page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  const panes=[{pane_id:1,is_plugin:false,tab_position:0,cwd:'/home/fixture/git/project'}];
  const tabs=[{host:'fixture',session:'main',id:1,position:0,name:'Existing work',panes:[panes[0]]}];
  await page.addInitScript(mode=>{localStorage.setItem('switchboard-view-mode',mode);localStorage.setItem('switchboard-mobile-view-mode',mode);window.setInterval=()=>0;},mode);
  await page.route('http://new-tab-picker.test/**',async route=>{
   const url=new URL(route.request().url()),p=url.pathname,json=data=>route.fulfill({json:data}).catch(()=>{});
   if(p==='/api/hosts')return json([{id:'fixture',name:'Desktop',local:true}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention'&&url.searchParams.has('after'))return;
   if(p==='/api/attention')return json({tabs,panes:[],errors:[]});
   if(p==='/hosts/fixture/model-list')return json({codex:[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',default:true,efforts:[{id:'low'},{id:'high'}]},{id:'gpt-6-astra',name:'GPT-6-Astra',efforts:[{id:'low'},{id:'high'},{id:'xhigh'}]}]});
   if(p==='/hosts/fixture/project-list')return json(['switchboard','project']);
   if(p==='/hosts/fixture/new-tab'){
    launches.push(route.request().postDataJSON());
    const pane={pane_id:2,is_plugin:false,tab_position:1},tab={host:'fixture',session:'main',id:2,position:1,name:'New task',panes:[pane]};panes.push(pane);tabs.push(tab);
    const frame=page.frames().find(f=>f.url().includes('/hosts/fixture/'));
    if(frame)await frame.evaluate(payload=>{window.payload=payload;window.report();},{session_name:'main',panes,tabs,active_pane:pane});
    return json({pane_id:2});
   }
   if(p.startsWith('/api/'))return json({});
   if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input aria-label="Fixture terminal"><script>window.payload=${JSON.stringify({session_name:'main',panes,tabs,active_pane:panes[0]})};window.report=(focus_id)=>parent.postMessage({type:'zellij-state',focus_id,payload:window.payload},location.origin);report();addEventListener('message',e=>{if(e.data.type==='zellij-focus')report(e.data.focus_id);if(e.data.type==='zellij-new-tab')fetch('/hosts/fixture/new-tab',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:'main',project:e.data.project,command:e.data.command,prompt:e.data.prompt,images:e.data.images,elevated:e.data.elevated})})});</script>`});
   const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
   return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  try{
   await page.goto('http://new-tab-picker.test/?host=fixture&session=main&tab=1');
   await page.locator('.tab-select').first().waitFor({state:'attached'});
   const open=async()=>{
    if(phone&&await page.locator('#sidebar-toggle').getAttribute('aria-expanded')!=='true')await page.locator('#sidebar-toggle').click();
    await page.getByRole('button',{name:'New tab',exact:true}).click();
   };
   await open();
   const prompt=page.getByLabel('Prompt',{exact:true}),search=page.getByRole('combobox',{name:'Search all models, or type any model name'});
   await prompt.fill('Run the regression tests.');
   await page.locator('#new-tab-model').click();
   await page.getByRole('option',{name:/GPT-6 Astra/}).waitFor();
   assert.equal(await page.locator('#new-tab-model-menu').evaluate(n=>n.classList.contains('model-picker')),true);
   const geometry=await page.locator('#new-tab-model-menu').boundingBox();
   assert.ok(geometry.x>=0&&geometry.x+geometry.width<=viewport.width+1&&geometry.y>=0&&geometry.y+geometry.height<=viewport.height+1,JSON.stringify(geometry));
   await page.getByRole('option',{name:/GPT-6 Astra/}).click();
   await page.getByRole('radio',{name:'Extra high',exact:true}).click();
   await page.getByRole('radio',{name:'Extra high',exact:true}).press('Enter');
   assert.equal(await prompt.inputValue(),'Run the regression tests.','Choosing a model preserves the prompt');
   assert.equal(await prompt.evaluate(n=>document.activeElement===n),true,'Confirming returns to the prompt');
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra');
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high');
   assert.equal(launches.length,0,'Choosing an effort does not create a tab');
   // The same search spans both providers; cancelling restores the model and effort together.
   await page.locator('#new-tab-model').click();await search.fill('opus 5.5');
   await page.getByRole('option',{name:'Opus 5.5',exact:true}).click();
   await page.getByRole('radio',{name:'Max',exact:true}).click();
   await page.getByRole('radio',{name:'Max',exact:true}).press('Escape');
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra');
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high');
   assert.equal(await prompt.inputValue(),'Run the regression tests.');
   await page.getByRole('button',{name:'Create tab',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open&&document.querySelector('#tabs .selected .tab-name')?.textContent==='New task');
   assert.equal(launches.length,1);assert.equal(launches[0].command,'codex:gpt-6-astra#xhigh');assert.equal(launches[0].prompt,'Run the regression tests.');
   await open();
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra','The next tab remembers the model');
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high','The next tab remembers the effort');
   await page.keyboard.press('Escape');
   assert.deepEqual(errors,[]);
  }catch(error){error.message+='\nPicker: '+await page.locator('#new-tab-model-menu').innerText()+'\nErrors: '+JSON.stringify(errors);throw error;}
  finally{await page.close();}
 });}finally{await browser.close();}
});
