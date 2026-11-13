const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('explicit first-tab creation precedes terminal attachment in both views on desktop and phone',
 {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  for(const mobile of [false,true])for(const mode of ['terminal','conversation']){
   const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
   const page=await context.newPage(),errors=[],requests=[];let started=false,attachments=0,releaseCreation,fail=true;
   page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(mode=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode',mode);localStorage.setItem('switchboard-mobile-view-mode',mode);},mode);
   const pane={pane_id:9,is_plugin:false,tab_position:0,title:'~'};
   const tab={host:'fixture',session:'main',id:90,position:0,name:'First task',panes:[pane]};
   await context.route('**/*',async route=>{
    const url=new URL(route.request().url()),p=url.pathname,json=data=>route.fulfill({json:data});
    if(p==='/api/health')return json({commit:'fixture',commit_date:'2026-11-01'});
    if(p==='/api/hosts')return json([{id:'fixture',name:'Windows PC'}]);
    if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Windows PC',sessions:started?[{name:'main',web_clients_allowed:true}]:[]});
    if(p==='/api/attention'){
     const version=started?2:1;if(url.searchParams.get('after')===String(version))return;
     return json({version,tabs:started?[tab]:[],panes:[],errors:[]});
    }
    if(p.endsWith('/project-list'))return json([]);
    if(p.endsWith('/model-list'))return json({codex:[]});
    if(p==='/hosts/fixture/new-tab'){
     requests.push(route.request().postDataJSON());
     await new Promise(resolve=>releaseCreation=resolve);
     if(fail)return route.fulfill({status:503,body:'Fixture could not start the session'});
     started=true;return json({pane_id:9,tab_id:90});
    }
    if(p==='/hosts/fixture/main'){
     attachments++;
     if(!started)return route.fulfill({status:410,body:'Terminal session has ended'});
     return route.fulfill({contentType:'text/html',body:`<input aria-label="Terminal input"><script>
      const input=document.querySelector('input'),pane=${JSON.stringify(pane)};
      function state(id){parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',panes:[pane],active_pane:pane,tabs:[{position:0,name:'First task',active:true}]}},location.origin);}
      addEventListener('message',event=>{if(event.data.type==='zellij-focus'){if(!event.data.preserve_focus)input.focus();state(event.data.focus_id);}if(event.data.type==='zellij-restore-focus')input.focus();});state();
     </script>`});
    }
    if(p.startsWith('/api/')||p.includes('/conversation/'))return json({});
    const file=path.join(__dirname,'static',p==='/'?'index.html':p.slice(1));
    return fs.existsSync(file)?route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
   });
   await page.goto('https://first-session.test/');
   await page.waitForFunction(()=>document.querySelector('#tab-empty-text')?.textContent==='No terminals yet');
   await page.reload();await page.waitForFunction(()=>document.querySelector('#tab-empty-text')?.textContent==='No terminals yet');
   assert.equal(attachments,0);assert.equal(requests.length,0,'Reloading an empty computer starts nothing');
   async function submit(){
    await page.evaluate(()=>document.querySelector('#new-tab').click());
    await page.locator('#new-tab-prompt').fill('First task');
    const request=page.waitForRequest('**/hosts/fixture/new-tab');
    await page.locator('#new-tab-submit').click();await request;
   }
   await submit();assert.equal(attachments,0);releaseCreation();
   await page.getByText('Fixture could not start the session',{exact:true}).waitFor();
   assert.equal(attachments,0,'A failed creation never opens a stale viewer');
   assert.equal(requests.length,1,'A failure does not automatically repeat the creation');
   fail=false;await submit();assert.equal(attachments,0);releaseCreation();
   await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='First task');
   assert.equal(requests.length,2);assert.equal(requests[1].session,'main');assert.equal(requests[1].prompt,'First task');
   assert.equal(await page.getByRole('button',{name:mode==='terminal'?'Terminal':'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
   if(mode==='conversation')await page.getByRole('button',{name:'Terminal',exact:true}).click();
   const input=page.frameLocator('iframe[title="Windows PC: main"]').getByLabel('Terminal input');
   await input.waitFor();await input.focus();await page.keyboard.type('first command');
   assert.equal(await input.inputValue(),'first command');assert.equal(attachments,1);
   assert.deepEqual(errors,[]);await context.close();
  }
 }finally{await browser.close();}
});
