const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

// Alt+digits select sidebar tabs on every platform. Ctrl/Cmd+digits stay with the browser.
for(const platform of ['MacIntel','Win32','Linux x86_64'])test(`${platform}: sidebar tab selection and browser digit passthrough`,
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const tabModifier='Alt';
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const names=['Alpha','Bravo','Charlie','Delta'],key=i=>JSON.stringify(['mac','main','tab',42+i]);
    await context.addInitScript(([platform,order])=>{
      Object.defineProperty(Navigator.prototype,'platform',{get:()=>platform});
      window.setInterval=()=>0;
      localStorage.setItem('switchboard-tab-order',order);
      // Runs before Switchboard's handlers in every frame; reads defaultPrevented once dispatch ends.
      window.ctrlDigits=[];
      window.altDigits=[];
      addEventListener('keydown',event=>{if(event.ctrlKey&&/^Digit/.test(event.code))setTimeout(()=>ctrlDigits.push(event.code+':'+event.defaultPrevented));},true);
      addEventListener('keydown',event=>{if(event.altKey&&/^Digit/.test(event.code))setTimeout(()=>altDigits.push(event.code+':'+event.defaultPrevented));},true);
    },[platform,JSON.stringify([3,1,0,2].map(key))]);
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs:names.map((name,i)=>({host:'mac',session:'main',id:42+i,position:i,name,panes:[{pane_id:7+i,is_plugin:false,tab_position:i}]})),panes:[],errors:[]});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        const input=document.querySelector('input');let active=0;window.sent=[];
        window.term={element:document.querySelector('#terminal'),textarea:input,options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},getSelection:()=>'',
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        window.__zjSendControl=message=>{if(message.type==='FocusPane'){active=message.pane_id-7;setTimeout(state);}};
      </script><script src="/bridge.js"></script><script src="/clipboard.js"></script><script type="module">
        // The real stock handler, attached where xterm would call it.
        import {installCustomKeyHandler} from '/assets/key-handler.js';
        installCustomKeyHandler({attachCustomKeyEventHandler:fn=>input.addEventListener('keydown',fn)},data=>sent.push(data));window.stockKeys=true;
      </script><script>
        const socket=new WebSocket('wss://switchboard.test/ws/control');
        function state(){const panes=${JSON.stringify(names)}.map((_,i)=>({pane_id:7+i,is_plugin:false,tab_position:i,title:'~'}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[active],tabs:panes.map((p,i)=>({position:i,name:${JSON.stringify(names)}[i],active:i===active}))}})}));}
        state();window.keys=[];addEventListener('keydown',event=>/^(Digit|Key)/.test(event.code)&&keys.push(event.code+':'+event.defaultPrevented));addEventListener('keydown',event=>{if(event.metaKey&&event.code==='KeyR')event.preventDefault();});
      </script>`});
      if(path.startsWith('/assets/'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(__dirname+'/../../zellij-client'+path,'utf8')});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','bridge.js','clipboard.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=42');
    const selectedName=()=>page.locator('#tabs .selected .tab-name').textContent();
    await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Alpha'));
    assert.deepEqual(await page.locator('#tabs .tab-name').allTextContents(),['Delta','Bravo','Alpha','Charlie']);
    const frame=page.frameLocator('iframe[title="Mac: main"]'),input=frame.locator('#terminal-input');
    await input.evaluate(()=>new Promise(resolve=>{const wait=()=>window.term.options.disableStdin||!window.stockKeys?setTimeout(wait,10):resolve();wait();}));
    await page.evaluate(()=>{window.keys=[];addEventListener('keydown',event=>/^(Digit|Key)/.test(event.code)&&keys.push(event.code+':'+event.defaultPrevented));});
    const settle=()=>page.waitForTimeout(100);

    // Parent page: sidebar focused.
    await page.locator('#tabs .selected').focus();
    for(const digit of [1,2,3,4,5,6,7,8,9])await page.keyboard.press('Meta+Digit'+digit);
    for(const digit of [1,2,3,4,5,6,7,8,9])await page.keyboard.press('Control+Digit'+digit);
    assert.equal(await selectedName(),'Alpha','Ctrl+digits never select a Switchboard tab');
    await page.keyboard.press(tabModifier+'+Digit2');await settle();
    assert.equal(await selectedName(),'Bravo');
    await page.keyboard.press(tabModifier+'+Digit9');await settle();assert.equal(await selectedName(),'Charlie','9 selects the last tab');
    await page.keyboard.press(tabModifier+'+Digit5');await settle();assert.equal(await selectedName(),'Charlie','beyond the last tab is ignored');
    // Search narrows the numbering to what is shown, even while typing in the search box.
    // From the terminal frame, Cmd+K reaches the page by postMessage; typing before
    // the search box takes focus would send the key to the terminal.
    await page.keyboard.press(platform==='MacIntel'?'Meta+k':'Control+k');await page.waitForFunction(()=>document.activeElement?.id==='tab-search');
    await page.keyboard.type('r');
    assert.deepEqual(await page.locator('#tabs .tab-row:not([hidden]) .tab-name').allTextContents(),['Bravo','Charlie']);
    await page.keyboard.press(tabModifier+'+Digit1');await settle();assert.equal(await selectedName(),'Bravo');
    await page.locator('#tab-search').fill('');await page.keyboard.press('Escape');
    const browserDigits=[1,2,3,4,5,6,7,8,9].map(d=>`Digit${d}:false`);
    assert.deepEqual(await page.evaluate(()=>keys),[...browserDigits,...browserDigits,'KeyR:false'],'browser digit shortcuts and typing reach the page bubble without preventDefault');
    // Selecting a tab focuses its terminal, so later presses land in whichever frame has focus.
    const ctrlDigits=(await Promise.all(page.frames().map(f=>f.evaluate(()=>window.ctrlDigits||[])))).flat();
    assert.deepEqual(ctrlDigits.sort(),browserDigits);
    const altDigits=(await Promise.all(page.frames().map(f=>f.evaluate(()=>window.altDigits||[])))).flat();
    assert.deepEqual(altDigits.sort(),['Digit1:true','Digit2:true','Digit5:true','Digit9:true'],'sidebar digits are prevented, even past the last tab');
    await Promise.all(page.frames().map(f=>f.evaluate(()=>{window.ctrlDigits=[];window.altDigits=[];})));

    // Terminal iframe: sidebar digits reach the parent; browser digits bypass xterm/Zellij.
    await page.evaluate(()=>{const item=allTabs().find(item=>item.tab.name==='Alpha');activate(item);});
    // Finish native selection before browser shortcuts can move focus again.
    await page.waitForFunction(()=>{const item=allTabs().find(item=>item.key===selected);return item?.tab.name==='Alpha'&&activeTab(item.entry)?.id===item.tab.id&&!item.entry.needsFocus&&!item.entry.requestedPane&&!item.entry.focusPending;});
    await input.evaluate(()=>new Promise(resolve=>{const wait=()=>window.term.options.disableStdin?setTimeout(wait,10):resolve();wait();}));
    await input.focus();await input.evaluate(()=>{window.keys=[];window.sent=[];window.ctrlDigits=[];window.altDigits=[];});
    for(const digit of [1,2,3,4,5,6,7,8,9])await page.keyboard.press('Meta+Digit'+digit);
    for(const digit of [1,2,3,4,5,6,7,8,9])await page.keyboard.press('Control+Digit'+digit);
    assert.equal(await selectedName(),'Alpha','Ctrl+digits never select a Switchboard tab from its terminal');
    // Browser tab shortcuts can move focus. Restore the terminal target before
    // checking its ordinary modifier handler, independently of digit passthrough.
    await input.focus();
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    await page.keyboard.press('Meta+KeyA');
    await page.keyboard.press('Meta+KeyR');await page.keyboard.press('Meta+Shift+KeyR');
    await page.keyboard.press(tabModifier+'+Digit1');await settle();
    const inner=await input.evaluate(()=>({keys,sent,ctrlDigits,altDigits}));
    assert.deepEqual(inner.keys,['KeyA:true','KeyR:false','KeyR:false'],'Cmd+R reload reaches the browser; digit shortcuts bypass the peer handler');
    assert.deepEqual(inner.sent,['\x1b[97;9u'],'sidebar and browser digits never reach xterm or Zellij');
    assert.deepEqual(inner.ctrlDigits,browserDigits);
    assert.deepEqual(inner.altDigits,['Digit1:true']);
    assert.equal(await selectedName(),'Delta');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Alt+H/L switch tabs from the Conversation draft and keep typing there',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const page=await browser.newPage(),errors=[],ids=[42,90,105];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');localStorage.setItem('switchboard-mobile-view-mode','conversation');});
    await page.route('https://switchboard.test/**',async route=>{
      const pathname=new URL(route.request().url()).pathname,json=value=>route.fulfill({json:value});
      if(pathname==='/api/hosts')return json([{id:'fixture',name:'Fixture desktop',local:true}]);
      if(pathname==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
      if(pathname==='/api/attention')return json({tabs:ids.map((id,position)=>({host:'fixture',session:'main',id,position,name:'Conversation '+id,panes:[{pane_id:id+1,tab_position:position,is_plugin:false}]})),panes:ids.map(id=>({host:'fixture',session:'main',pane_id:id+1,agent:'codex',state:'ready',chat_id:'chat-'+id})),errors:[]});
      if(pathname.startsWith('/api/chats/'))return json({messages:[{role:'assistant',text:pathname.split('/').at(-1)}],start_cursor:0,next_cursor:null});
      if(pathname.startsWith('/api/'))return json({});
      if(pathname.startsWith('/hosts/'))return route.fulfill({body:''});
      const file=__dirname+'/static/'+(pathname==='/'?'index.html':pathname.slice(1));
      return fs.existsSync(file)?route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
    });
    await page.goto('https://switchboard.test/?host=fixture&session=main&tab=42');
    const draft=page.getByLabel('Reply draft'),shows=text=>page.waitForFunction(text=>document.querySelector('.conversation-message')?.textContent.includes(text),text);
    await shows('chat-42');await draft.fill('Draft for 42');
    await page.keyboard.press('Alt+l');await shows('chat-90');
    assert.equal(await draft.evaluate(node=>document.activeElement===node),true,'The draft keeps focus after switching');
    assert.equal(await draft.inputValue(),'');
    await page.keyboard.press('Alt+h');await shows('chat-42');
    assert.equal(await draft.inputValue(),'Draft for 42','Alt+H must not type into the draft');
    await page.keyboard.press('Alt+h');await shows('chat-105');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
