const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

// Cmd+1–9 always stays with the browser. Mac Ctrl+1–9 selects the visible sidebar tab (9 = last)
// from the page or a terminal iframe; elsewhere Ctrl+digit is the browser's tab switch and passes through.
for(const platform of ['MacIntel','Win32'])test(`${platform}: Ctrl+digit sidebar selection and Cmd+digit browser passthrough`,
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const mac=platform==='MacIntel';
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
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
        state();window.keys=[];addEventListener('keydown',event=>/^(Digit|Key)/.test(event.code)&&keys.push(event.code+':'+event.defaultPrevented));
      </script>`});
      if(path.startsWith('/assets/'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(__dirname+'/../../zellij-client'+path,'utf8')});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','bridge.js','clipboard.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
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
    await page.keyboard.press('Control+Digit2');await settle();
    if(mac){
      assert.equal(await selectedName(),'Bravo');
      await page.keyboard.press('Control+Digit9');await settle();assert.equal(await selectedName(),'Charlie','Ctrl+9 selects the last tab');
      await page.keyboard.press('Control+Digit5');await settle();assert.equal(await selectedName(),'Charlie','beyond the last tab is ignored');
      // Search narrows the numbering to what is shown, even while typing in the search box.
      await page.keyboard.press('Meta+k');await page.keyboard.type('r');
      assert.deepEqual(await page.locator('#tabs .tab-row:not([hidden]) .tab-name').allTextContents(),['Bravo','Charlie']);
      await page.keyboard.press('Control+Digit1');await settle();assert.equal(await selectedName(),'Bravo');
      await page.locator('#tab-search').fill('');await page.keyboard.press('Escape');
      assert.deepEqual(await page.evaluate(()=>keys),[...[1,2,3,4,5,6,7,8,9].map(d=>`Digit${d}:false`),'KeyR:false'],'only Cmd+digit and typing reaches the page bubble, never prevented');
    }else{
      assert.equal(await selectedName(),'Alpha');
      assert.deepEqual(await page.evaluate(()=>keys),[...[1,2,3,4,5,6,7,8,9].map(d=>`Digit${d}:false`),'Digit2:false'],'Ctrl+digit stays with the browser');
    }

    // Terminal iframe focused: Ctrl+digit is forwarded to the parent; Cmd+digit reaches neither xterm nor zellij.
    await page.evaluate(()=>{const item=allTabs().find(item=>item.tab.name==='Alpha');activate(item);});
    await input.evaluate(()=>new Promise(resolve=>{const wait=()=>window.term.options.disableStdin?setTimeout(wait,10):resolve();wait();}));
    await input.focus();await input.evaluate(()=>{window.keys=[];window.sent=[];});
    for(const digit of [1,2,3,4,5,6,7,8,9])await page.keyboard.press('Meta+Digit'+digit);
    await page.keyboard.press('Meta+KeyA');
    await page.keyboard.press('Control+Digit1');await settle();
    const inner=await input.evaluate(()=>({keys,sent}));
    const metaDigits=[1,2,3,4,5,6,7,8,9].map(d=>`Digit${d}:false`);
    assert.deepEqual(inner.keys,[...metaDigits,'KeyA:true',...(mac?[]:['Digit1:false'])],'other Cmd shortcuts still go to the terminal');
    assert.deepEqual(inner.sent,['\x1b[97;9u']);
    assert.equal(await selectedName(),mac?'Delta':'Alpha');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
