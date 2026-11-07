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
    assert.deepEqual(await hiddenSent('windows'),[true],'A background viewer leaves sizing');
    await page.evaluate(()=>activate(allTabs().find(t=>t.entry.host==='windows')));
    await page.waitForFunction(()=>(window.controls||[]).some(c=>c.host==='mac'&&c.hidden===true));
    assert.deepEqual(await hiddenSent('windows'),[true,false],'A shown viewer rejoins sizing');
    await page.evaluate(()=>activate(allTabs().find(t=>t.entry.host==='mac')));
    await page.waitForFunction(()=>(window.controls||[]).filter(c=>c.host==='mac'&&c.type==='SetViewerHidden').length===2);
    await page.getByRole('button',{name:'Conversation',exact:true}).click();
    await page.waitForFunction(()=>(window.controls||[]).filter(c=>c.host==='mac'&&c.type==='SetViewerHidden').length===3);
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
