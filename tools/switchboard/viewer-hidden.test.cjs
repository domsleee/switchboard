const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// Synthetic hosts only. "mac" runs an engine that confirms hidden viewers; "windows" is older.
test('hidden viewers leave terminal sizing, and Conversation disconnects only where the engine cannot',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the hidden viewer check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],loads=[];
    page.on('pageerror',error=>errors.push(error.message));
    const tab=(host,id)=>({host,session:'main',id,position:0,name:host,panes:[{pane_id:id,is_plugin:false,tab_position:0}]});
    await page.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname,json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(pathname.startsWith('/api/hosts/')){const id=pathname.split('/')[3];return json({id,name:id==='mac'?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});}
      if(pathname==='/api/attention')return json({tabs:[tab('mac',1),tab('windows',42)],panes:[],errors:[]});
      if(pathname.startsWith('/api/chats/'))return json({id:'chat',agent:'codex',messages:[{role:'assistant',text:'Ready for a reply'}],start_cursor:0,next_cursor:null});
      if(pathname.startsWith('/hosts/')){
        const host=pathname.split('/')[2],id=host==='mac'?1:42;loads.push(host);
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"></div><script>
          let hidden=false;
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;
          window.__zjSendControl=message=>{(parent.controls??=[]).push({host:'${host}',...message});
            if(message.type==='SetViewerHidden'&&${host==='mac'}){hidden=message.hidden;setTimeout(()=>sendState());}};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){},blur(){},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          window.sendState=()=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:false,cols:100,rows:40,hidden}}})}));
          sendState();
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const hiddenSent=host=>page.evaluate(host=>(window.controls||[]).filter(c=>c.host===host&&c.type==='SetViewerHidden').map(c=>c.hidden),host);
    const frameSrc=title=>page.locator(`iframe[title="${title}: main"]`).getAttribute('src');
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=1');
    await page.waitForFunction(()=>[...sessions.values()].length===2&&[...sessions.values()].every(e=>e.state));
    assert.deepEqual(await hiddenSent('mac'),[],'The selected viewer stays in sizing');
    const attachHidden=title=>page.locator(`iframe[title="${title}: main"]`).evaluate(frame=>frame.contentWindow.__zjViewerHidden());
    assert.deepEqual([await attachHidden('Mac'),await attachHidden('Windows')],[false,true],'The web client attaches a background viewer hidden');
    assert.deepEqual(await hiddenSent('windows'),[true],'A background viewer leaves sizing');
    await page.evaluate(()=>activate(allTabs().find(t=>t.entry.host==='windows')));
    await page.waitForFunction(()=>(window.controls||[]).some(c=>c.host==='mac'&&c.hidden===true));
    assert.deepEqual(await hiddenSent('windows'),[true,false],'A shown viewer rejoins sizing');
    await page.evaluate(()=>activate(allTabs().find(t=>t.entry.host==='mac')));
    await page.waitForFunction(()=>(window.controls||[]).filter(c=>c.host==='mac'&&c.type==='SetViewerHidden').length===2);
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    await page.waitForFunction(()=>(window.controls||[]).filter(c=>c.host==='mac'&&c.type==='SetViewerHidden').length===3);
    assert.equal(await attachHidden('Mac'),true,'A viewer that reconnects behind Conversation attaches hidden');
    await page.waitForTimeout(2300);
    assert.equal(await frameSrc('Mac'),'/hosts/mac/main','A confirmed hidden viewer stays connected through Conversation');
    await page.evaluate(()=>activate(allTabs().find(t=>t.entry.host==='windows')));
    await page.waitForFunction(()=>document.querySelector('iframe[title="Windows: main"]').getAttribute('src')==='about:blank');
    assert.equal(await frameSrc('Mac'),'/hosts/mac/main');
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.waitForFunction(()=>[...sessions.values()].every(e=>e.state));
    assert.deepEqual(loads,['mac','windows','windows'],'Only the unconfirmed viewer reloads');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a background viewer whose engine cannot confirm hidden disconnects, and reattaches when selected',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the hidden viewer check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],loads=[],acks=[];
    page.on('pageerror',error=>errors.push(error.message));
    const tab=(host,id)=>({host,session:'main',id,position:0,name:host,panes:[{pane_id:id,is_plugin:false,tab_position:0}]});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),pathname=url.pathname,json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      // A real relay holds an unchanged attention watch open.
      if(pathname==='/api/attention'&&url.searchParams.has('after'))return;
      if(pathname==='/api/attention/ack'){acks.push(route.request().postDataJSON());return json({});}
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(pathname.startsWith('/api/hosts/')){const id=pathname.split('/')[3];return json({id,name:id==='mac'?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});}
      if(pathname==='/api/attention')return json({version:1,tabs:[tab('mac',1),tab('windows',42)],panes:[{host:'windows',session:'main',pane_id:42,agent:'codex',state:'ready',token:'review-1',chat_id:'chat'}],errors:[]});
      if(pathname.startsWith('/api/chats/'))return json({id:'chat',agent:'codex',messages:[{role:'assistant',text:'Ready for a reply'}],start_cursor:0,next_cursor:null});
      if(pathname.startsWith('/hosts/')){
        const host=pathname.split('/')[2],id=host==='mac'?1:42;loads.push(host);
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
          let hidden=false;const input=document.querySelector('input');
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;
          window.__zjSendControl=message=>{(parent.controls??=[]).push({host:'${host}',...message});
            if(message.type==='SetViewerHidden'&&${host==='mac'}){hidden=message.hidden;setTimeout(()=>sendState());}};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus();},blur(){input.blur();},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          window.sendState=()=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:false,cols:100,rows:40,hidden}}})}));
          sendState();
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const frameSrc=title=>page.locator(`iframe[title="${title}: main"]`).getAttribute('src');
    const disconnected=()=>page.waitForFunction(()=>document.querySelector('iframe[title="Windows: main"]').getAttribute('src')==='about:blank',null,{timeout:6000});
    const attached=()=>page.waitForFunction(()=>{const entry=[...sessions.values()].find(e=>e.host==='windows');return entry.state&&entry.frame.getAttribute('src')==='/hosts/windows/main';},null,{timeout:6000});
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=1');
    await page.waitForFunction(()=>[...sessions.values()].length===2&&[...sessions.values()].every(e=>e.state));
    await page.frames().find(frame=>frame.url().includes('/hosts/mac/')).locator('#terminal-input').focus();

    // Terminal: the viewer behind another sidebar tab leaves once its engine has not confirmed hidden.
    await disconnected();
    assert.equal(await frameSrc('Mac'),'/hosts/mac/main','A viewer the engine confirmed is left connected');
    assert.equal(await page.evaluate(()=>allTabs().length),2,'The disconnected computer keeps its tab in the sidebar');

    // A sidebar shortcut reattaches it, gives it the keyboard and clears its review.
    await page.keyboard.press('Alt+Digit2');
    await attached();
    await page.waitForFunction(()=>document.activeElement?.title==='Windows: main');
    await page.waitForFunction(()=>!isReady(allTabs().find(t=>t.entry.host==='windows')));
    assert.deepEqual(acks.map(ack=>ack.token),['review-1'],'Selecting the reattached tab records the review');
    assert.deepEqual(loads,['mac','windows','windows']);

    // Moving away disconnects it again, and returning reattaches it again.
    await page.keyboard.press('Alt+Digit1');
    await disconnected();
    await page.keyboard.press('Alt+Digit2');
    await attached();
    await page.keyboard.press('Alt+Digit1');
    await disconnected();
    assert.deepEqual(loads,['mac','windows','windows','windows']);

    // Conversation: selecting it does not attach this engine, and Terminal then does.
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    await page.keyboard.press('Alt+Digit2');
    await page.waitForFunction(()=>allTabs().find(t=>t.key===selected)?.entry.host==='windows');
    assert.equal(await frameSrc('Windows'),'about:blank');
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await attached();
    assert.deepEqual(loads,['mac','windows','windows','windows','windows'],'Mac never reloads');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

for(const late of [false,true])test(late?'a viewer reported hidden just after its first state rejoins sizing once shown':'a viewer that attached hidden rejoins sizing when Terminal is shown before its first state',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the hidden viewer check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname,json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(pathname==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true,hidden_attach:true}]});
      if(pathname==='/api/attention')return json({tabs:[{host:'mac',session:'main',id:1,position:0,name:'Mac',panes:[{pane_id:1,is_plugin:false,tab_position:0}]}],panes:[],errors:[]});
      if(pathname.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<div id="terminal"></div><script>
          // A newer engine kept the hidden report from before the attach. On an older one the web server sends it just after.
          let hidden=${!late};
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;
          window.__zjSendControl=message=>{(parent.controls??=[]).push(message);if(message.type==='SetViewerHidden'){hidden=message.hidden;setTimeout(()=>sendState());}};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){},blur(){},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:1,is_plugin:false,tab_position:0};
          window.sendState=()=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:false,cols:100,rows:40,hidden}}})}));
          sendState();
        </script>`});
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=1');
    await page.waitForFunction(()=>[...sessions.values()][0]?.state);
    if(late)await page.frames().find(frame=>frame.url().includes('/hosts/mac/')).evaluate('hidden=true;sendState()');
    await page.waitForFunction(()=>(window.controls||[]).some(c=>c.type==='SetViewerHidden'));
    assert.deepEqual(await page.evaluate(()=>controls.filter(c=>c.type==='SetViewerHidden').map(c=>c.hidden)),[false]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a terminal that loads behind Conversation attaches at a real size',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the hidden viewer check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}});
    await page.addInitScript(()=>{window.WebSocket=class{static OPEN=1;constructor(url){(window.socketUrls??=[]).push(url);this.readyState=0;}send(){}close(){}};});
    const assets=__dirname+'/../../zellij-client/assets/';
    await page.route('**/*',route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/')return route.fulfill({contentType:'text/html',body:'<iframe src="/main" style="display:none"></iframe>'});
      if(pathname==='/main')return route.fulfill({contentType:'text/html',body:fs.readFileSync(assets+'index.html')});
      if(pathname==='/session')return route.fulfill({contentType:'application/json',body:JSON.stringify({web_client_id:'viewer',session_name:'main',config:{}})});
      const file=assets+pathname.replace('/assets/','');
      if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
      route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream',body:fs.readFileSync(file)});
    });
    await page.goto('https://switchboard.test/');
    const frame=page.frames().find(f=>f.url().endsWith('/main'));
    await frame.waitForFunction(()=>window.socketUrls?.length);
    const url=new URL(await frame.evaluate(()=>window.socketUrls[0]));
    assert.deepEqual([url.searchParams.get('cols'),url.searchParams.get('rows')],['80','24']);
  }finally{await browser.close();}
});
