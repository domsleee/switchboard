const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('New tab accepts an empty project in Conversation and Terminal on desktop and phone',
 {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  for(const mobile of [false,true])for(const mode of ['terminal','conversation']){
   const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
   const page=await context.newPage(),errors=[],launches=[];let created=0;
   page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(mode=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode',mode);localStorage.setItem('switchboard-mobile-view-mode',mode);},mode);
   const tabs=()=>Array.from({length:created+1},(_,i)=>({host:'windows',session:'main',id:i?89+i:42,position:i,name:i?'New '+i:'Original',panes:[{pane_id:i?8+i:7,is_plugin:false,tab_position:i}]}));
   await context.route('**/*',async route=>{
    const p=new URL(route.request().url()).pathname,json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    if(p==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
    if(p==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
    if(p==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
    if(p==='/api/attention'){if(new URL(route.request().url()).searchParams.get('after')===String(created+1))return;return json({version:created+1,tabs:tabs(),panes:[],errors:[]});}
    if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
    if(p.endsWith('/conversation/skills'))return json({skills:[]});
    if(p==='/hosts/windows/project-list')return json(['switchboard']);
    if(p==='/hosts/windows/model-list')return json({codex:[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',default:true,efforts:[{id:'high'}]}]});
    if(p==='/hosts/windows/new-tab'){
     launches.push(route.request().postDataJSON());created++;const viewer=page.frames().find(frame=>frame.url().includes('/hosts/windows/'));
     await viewer?.evaluate(()=>window.confirmCreation()).catch(()=>{});
     return json({pane_id:8+created,tab_id:89+created}).catch(()=>{});
    }
    if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input></div><script>
     window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
     const input=document.querySelector('input');let count=${created},active=count;
     window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},_core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
     window.__zjSendControl=message=>{if(message.type==='FocusPane'){active=message.pane_id===7?0:message.pane_id-8;state();}};
     </script><script src="/bridge.js"></script><script>
     const socket=window.controlSocket=new WebSocket('wss://switchboard.test/ws/control');
     function state(){const panes=Array.from({length:count+1},(_,i)=>({pane_id:i?8+i:7,is_plugin:false,tab_position:i,title:'~'}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[active],tabs:panes.map((pane,i)=>({position:i,name:i?'New '+i:'Original',active:i===active}))}})}));}
     window.confirmCreation=()=>{count++;active=count;state();};state();
     </script>`});
    const file=p==='/'?'index.html':p.slice(1),local=path.join(__dirname,'static',path.basename(file));
    if(!fs.existsSync(local))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(local,'utf8')});
   });
   await page.goto('https://switchboard.test/?host=windows&session=main&tab=42');
   await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Original'));
   const open=()=>page.evaluate(()=>document.querySelector('#new-tab').click()).then(()=>page.waitForFunction(()=>document.querySelector('#new-tab-dialog').open));
   await page.waitForFunction(mode=>window.SwitchboardConversation.wantsConversation()===(mode==='conversation'),mode);
   await open();
   const prompt=page.locator('#new-tab-prompt'),dialog=page.locator('#new-tab-dialog');
   await page.locator('#new-tab-project-chip').click();
   await page.locator('#new-tab-project').fill('');await prompt.focus();
   await prompt.fill('Start without a project');
   if(!mobile&&mode==='terminal'&&process.env.EMPTY_PROJECT_SCREENSHOT)await dialog.screenshot({path:process.env.EMPTY_PROJECT_SCREENSHOT});
   if(mobile)await page.locator('#new-tab-submit').click();else await prompt.press('Enter');
   await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);
   await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('New 1'));
   assert.equal(launches.length,1);assert.equal(launches[0].project,'');assert.equal(launches[0].prompt,'Start without a project');
   assert.equal(await page.getByRole('button',{name:mode==='terminal'?'Terminal':'Conversation',exact:true}).getAttribute('aria-pressed'),'true');
   await open();assert.equal(await page.locator('#new-tab-project').inputValue(),'');
   assert.equal(await prompt.evaluate(node=>document.activeElement===node),true);
   await page.keyboard.press('Escape');
   assert.deepEqual(errors,[]);await context.close();
  }
 }finally{await browser.close();}
});
