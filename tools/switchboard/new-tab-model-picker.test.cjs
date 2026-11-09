const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('New Tab shares the model and effort picker and launches and remembers the selected pair',
 {skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const mode of ['conversation','terminal'])for(const phone of [false,true])await t.test(`${mode}, ${phone?'phone':'desktop'}`,async()=>{
  const viewport=phone?{width:390,height:844}:{width:1280,height:900};
  const page=await browser.newPage({viewport,hasTouch:phone,isMobile:phone}),errors=[],launches=[];
  let modelGate=Promise.resolve(),releaseModels,modelsFail=false;
  let modelCatalog=[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',default:true,efforts:[{id:'low'},{id:'high'}]},{id:'gpt-6-astra',name:'GPT-6-Astra',efforts:[{id:'low'},{id:'high'},{id:'xhigh'}]}];
  let claudeCatalog=[{id:'claude-opus-5-5',name:'Opus 5.5',efforts:[{id:'low'},{id:'high'},{id:'xhigh'},{id:'max'}]}];
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
   if(p==='/hosts/fixture/model-list'){
    await modelGate;
    return modelsFail?route.fulfill({status:503,body:'Unavailable'}):json({codex:modelCatalog,claude:claudeCatalog});
   }
   if(p==='/hosts/fixture/project-list')return json(['switchboard','project']);
   if(p==='/hosts/fixture/new-tab'){
    launches.push(route.request().postDataJSON());
    const id=panes.length+1,pane={pane_id:id,is_plugin:false,tab_position:id-1},tab={host:'fixture',session:'main',id,position:id-1,name:'New task',panes:[pane]};panes.push(pane);tabs.push(tab);
    const frame=page.frames().find(f=>f.url().includes('/hosts/fixture/'));
    if(frame)await frame.evaluate(payload=>{window.payload=payload;window.report();},{session_name:'main',panes,tabs,active_pane:pane});
    return json({pane_id:id});
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
   await page.getByRole('button',{name:'Add GPT-6 Astra to favourites',exact:true}).click();
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high','Starring leaves the effort alone');
   await page.getByRole('tab',{name:/^Claude Code/}).click();
   assert.equal(await page.getByRole('option',{name:'Fable 5.1',exact:true}).count(),0,'Claude uses the computer catalog rather than a fixed list');
   await page.getByRole('button',{name:'Add Opus 5.5 to favourites',exact:true}).click();
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra','Starring does not choose a different model');
   await page.getByRole('tab',{name:'Favourites',exact:true}).click();
   assert.deepEqual(await page.locator('.model-picker-name').allTextContents(),['GPT-6 Astra','Opus 5.5']);
   await page.getByRole('option',{name:'Opus 5.5',exact:true}).click();
   await page.getByRole('radio',{name:'Max',exact:true}).click();
   await page.getByRole('option',{name:'GPT-6 Astra',exact:true}).click();
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'','A favourite saves the model, not an effort preset');
   await page.getByRole('radio',{name:'Extra high',exact:true}).click();
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high','A touch still selects the intended effort when its warning disappears');
   await page.getByRole('button',{name:'Remove Opus 5.5 from favourites',exact:true}).click();
   assert.deepEqual(await page.locator('.model-picker-name').allTextContents(),['GPT-6 Astra']);
   assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('switchboard-model-favorites'))),['codex:gpt-6-astra']);
   await page.getByRole('radio',{name:'Extra high',exact:true}).press('Enter');
   assert.equal(await prompt.evaluate(node=>node.value),'Run the regression tests.','Choosing a model preserves the prompt');
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
   assert.equal(await prompt.evaluate(node=>node.value),'Run the regression tests.');
   await page.getByRole('button',{name:'Create tab',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open&&document.querySelector('#tabs .selected .tab-name')?.textContent==='New task');
   assert.equal(launches.length,1);assert.equal(launches[0].command,'codex:gpt-6-astra#xhigh');assert.equal(launches[0].prompt,'Run the regression tests.');
   modelCatalog=[modelCatalog[1],{id:'gpt-6.1-terra',name:'GPT-6.1 Terra',efforts:[{id:'high'},{id:'ultra'}]}];
   claudeCatalog=[...claudeCatalog,{id:'claude-fixture-next',name:'New Claude fixture',efforts:[{id:'high'}]}];
   modelGate=new Promise(resolve=>{releaseModels=resolve;});
   const refreshing=page.waitForRequest(request=>new URL(request.url()).pathname==='/hosts/fixture/model-list');
   await open();await refreshing;
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra','The next tab remembers the model');
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high','The next tab remembers the effort');
   await page.locator('#new-tab-model').click();
   assert.equal(await page.getByRole('tab',{name:'Favourites',exact:true}).getAttribute('aria-selected'),'true','Saved favourites are the initial view');
   assert.deepEqual(await page.locator('.model-picker-name').allTextContents(),['GPT-6 Astra']);
   if(phone)await page.getByRole('button',{name:'Remove GPT-6 Astra from favourites',exact:true}).click();
   else{
    await search.press('ArrowLeft');await page.keyboard.press('Tab');await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button',{name:'Remove GPT-6 Astra from favourites',exact:true}).evaluate(n=>document.activeElement===n),true,'Stars are reachable with the keyboard');
    await page.keyboard.press('Enter');
   }
   await page.getByText('No favourites yet.',{exact:false}).waitFor();
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra','Removing the last favourite leaves the launch choice intact');
   await page.getByRole('tab',{name:/^Codex/}).click();
   await page.getByRole('option',{name:/GPT-6.1 Sol/}).waitFor();
   assert.equal(await page.getByRole('option',{name:/GPT-6.1 Terra/}).count(),0,'The last good list stays usable while refreshing');
   await search.fill('terra');
   releaseModels();
   await page.getByRole('option',{name:'GPT-6.1 Terra',exact:true}).waitFor();
   assert.equal(await search.inputValue(),'terra','A refresh preserves the search');
   if(!phone)assert.equal(await search.evaluate(n=>document.activeElement===n),true,'A refresh keeps keyboard focus');
   assert.equal(await page.locator('#new-tab-model-name').textContent(),'GPT-6 Astra','Refreshing does not choose a newly listed model');
   assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high');
   await search.fill('');
   assert.equal(await page.getByRole('option',{name:/GPT-6.1 Sol/}).count(),0,'Removed models leave the list');
   await page.getByRole('option',{name:'GPT-6.1 Terra',exact:true}).click();
   await page.getByRole('radio',{name:'Ultra',exact:true}).click();
   await page.keyboard.press('Escape');
   await page.locator('#new-tab-close').click();
   // A failed refresh keeps the last successful catalog and the next chat tries again.
   modelsFail=true;
   const failing=page.waitForResponse(response=>new URL(response.url()).pathname==='/hosts/fixture/model-list');
   await open();await failing;
   await page.locator('#new-tab-model').click();
   await page.getByRole('option',{name:'GPT-6.1 Terra',exact:true}).waitFor();
   await page.keyboard.press('Escape');await page.locator('#new-tab-close').click();
   modelsFail=false;modelCatalog=[...modelCatalog,{id:'fixture-next',name:'New fixture model',efforts:[]}];
   const recovering=page.waitForResponse(response=>new URL(response.url()).pathname==='/hosts/fixture/model-list');
   await open();await recovering;await page.locator('#new-tab-model').click();
   await page.getByRole('option',{name:'New fixture model',exact:true}).waitFor();
   await page.getByRole('tab',{name:/^Claude Code/}).click();
   await page.getByRole('option',{name:'New Claude fixture',exact:true}).click();
   assert.equal(await page.getByRole('radio',{name:'Max',exact:true}).count(),0,'Claude efforts come from the chosen model');
   await page.getByRole('radio',{name:'High',exact:true}).click();
   await page.getByRole('radio',{name:'High',exact:true}).press('Enter');
   await prompt.fill('Use the newly available Claude model.');
   const launched=page.waitForResponse(response=>new URL(response.url()).pathname==='/hosts/fixture/new-tab');
   await page.getByRole('button',{name:'Create tab',exact:true}).click();
   await launched;
   await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   assert.equal(launches.length,2);assert.equal(launches[1].command,'claude:claude-fixture-next#high');
   assert.deepEqual(errors,[]);
  }catch(error){error.message+='\nPicker: '+await page.locator('#new-tab-model-menu').innerText()+'\nErrors: '+JSON.stringify(errors);throw error;}
  finally{await page.close();}
 });}finally{await browser.close();}
});
