const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const tab=(host,id)=>({host,session:'main',id,position:0,name:host+' terminal',panes:[{pane_id:id,is_plugin:false,tab_position:0}]});
const statics=['index.html','app.js','bridge.js','close.js','titles.js','pairing-notice.js','style.css','messages.html','messages.js','messages.css','computers.html','computers.js'];

// Synthetic hosts and fixture terminals only; never a live relay.
test('Messages and Computers open over live terminals and return focus on close',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser overlay check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),pageErrors=[];let navigations=0;
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(pathname.startsWith('/api/hosts/'))return json({id:pathname.split('/')[3],name:pathname.endsWith('mac')?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(pathname==='/api/attention')return json({tabs:[tab('mac',1),tab('windows',42)],panes:[],errors:[]});
      if(pathname==='/api/mesh')return json({configured:true,computer:{name:'Mac'},mesh:{name:'My computers'},administrator:true,requests:[],members:[{name:'Mac',address:'https://192.0.2.1:8082'},{name:'Windows',address:'https://192.0.2.2:8082'}]});
      if(pathname.startsWith('/api/mesh/'))return json({});
      if(pathname.endsWith('/inboxes'))return json({machine_id:'mac',machines:[{id:'mac',name:'Mac',unread_count:1,participants:[]},{id:'windows',name:'Windows',unread_count:0,participants:[]}]});
      if(pathname.startsWith('/api/message-board/'))return json({items:[],next_cursor:null});
      if(pathname.startsWith('/hosts/')){
        const id=pathname.split('/')[2]==='mac'?1:42;
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
          const input=document.querySelector('input');
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;window.__zjSendControl=()=>{};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus();},blur(){input.blur();},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:true,cols:100,rows:40}}})}));
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!statics.includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const requested='https://switchboard.test/?host=windows&session=main&tab=42';
    await page.goto(requested);
    await page.waitForFunction(()=>document.querySelectorAll('#terminals>iframe').length===2&&document.activeElement===document.querySelector('iframe[title="Windows: main"]'));
    await page.evaluate(()=>{window.terminalFrames=[...document.querySelectorAll('#terminals>iframe')];for(const frame of terminalFrames)frame.contentWindow.stillLoaded=true;});
    const overlay=page.frameLocator('#page-frame');
    async function terminalsIntact(){
      await page.waitForFunction(()=>!document.querySelector('dialog[open]')&&document.querySelector('#page-frame').getAttribute('src')==='about:blank');
      assert.equal(page.url(),requested);assert.equal(navigations,1);
      assert.deepEqual(await page.evaluate(()=>{
        const frames=[...document.querySelectorAll('#terminals>iframe')],active=document.querySelector('iframe[title="Windows: main"]');
        return {same:frames.length===terminalFrames.length&&frames.every((frame,i)=>frame===terminalFrames[i]),
          loaded:frames.every(frame=>frame.contentWindow.stillLoaded),
          focused:document.activeElement===active&&active.contentDocument.activeElement.id==='terminal-input',
          open:!!document.querySelector('dialog[open]'),blank:document.querySelector('#page-frame').getAttribute('src')};
      }),{same:true,loaded:true,focused:true,open:false,blank:'about:blank'});
    }

    // Sidebar Messages: keeps its href for new-tab use, opens in place, Esc closes.
    const messages=page.locator('#sidebar-utilities a[href="/messages.html"]');
    assert.equal(await messages.getAttribute('href'),'/messages.html');
    await messages.click();
    assert.equal(await page.locator('#page-dialog').evaluate(d=>d.open),true);
    assert.equal(await page.locator('#page-heading').textContent(),'Messages');
    assert.equal(await page.locator('#page-frame').getAttribute('title'),'Messages');
    await overlay.locator('button[data-key="computer:windows"]').waitFor();
    assert.equal(page.url(),requested);
    await page.keyboard.press('Escape');
    await terminalsIntact();

    // Esc pressed inside the embedded page also closes it.
    await messages.click();
    await overlay.locator('button[data-key="computer:windows"]').click();
    await page.keyboard.press('Escape');
    await terminalsIntact();

    // Settings > Computers replaces Settings; the page's own back link closes it.
    await page.locator('#settings').click();
    await page.locator('#settings-dialog a[href="/computers.html"]').click();
    assert.equal(await page.locator('#settings-dialog').evaluate(d=>d.open),false);
    assert.equal(await page.locator('#page-heading').textContent(),'Computers');
    await overlay.locator('text=Windows').first().waitFor();
    await overlay.locator('a[href="/"]').click();
    await terminalsIntact();

    // Close button, and a full-screen overlay at phone width.
    await page.setViewportSize({width:390,height:800});
    await page.evaluate(()=>document.querySelector('#sidebar-utilities a[href="/messages.html"]').click());
    const box=await page.locator('#page-dialog').boundingBox();
    assert.deepEqual([box.x,box.y,box.width,box.height],[0,0,390,800]);
    await page.locator('#close-page').click();
    await terminalsIntact();
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});
