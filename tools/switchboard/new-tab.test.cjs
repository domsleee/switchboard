const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

for(const emptyMachine of [false,true])test(`${emptyMachine?'an empty machine starts nothing until + creates its first terminal; ':''}new terminals appear before attention discovery, remain focused, and acquire stable tab IDs without duplicates`,
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let created=0,catalog=0,failed=false,closes=0,frameBoots=0,connected=!emptyMachine,catalogReady=!emptyMachine;
    const diagnostics=[];
    const nativeTabs=()=>Array.from({length:catalog+1},(_,i)=>({host:'windows',session:'main',id:i?89+i:42,position:i,name:i?'New shell '+i:'Original',panes:[{pane_id:i?8+i:7,is_plugin:false,tab_position:i}]}));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04',...(emptyMachine?{commit_timestamp:'2026-10-04T13:24:56+11:00'}:{})});
      if(path==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
      if(path==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:connected?[{name:'main',web_clients_allowed:true}]:[]});
      if(path==='/api/attention')return json({tabs:failed||!catalogReady?[]:nativeTabs(),panes:[],errors:failed?[{host:'windows',message:'Unavailable'}]:[]});
      if(path==='/api/diagnostics/new-tab'){diagnostics.push(route.request().postDataJSON());return route.fulfill({status:204});}
      if(path==='/api/hosts/windows/close-tab'){closes++;return json({ok:true});}
      if(path.startsWith('/hosts/')){connected=true;frameBoots++;return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        const input=document.querySelector('input');let count=${created},active=count;
        window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        window.__zjSendControl=message=>{if(message.type==='NewTab'&&window.controlSocket.readyState===1)window.creationRequested=true;};
      </script><script src="/bridge.js"></script><script>
        const socket=window.controlSocket=new WebSocket('wss://switchboard.test/ws/control');
        function state(){const panes=Array.from({length:count+1},(_,i)=>({pane_id:i?8+i:7,is_plugin:false,tab_position:i,title:'~'}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[active],tabs:panes.map((p,i)=>({position:i,name:i?'New shell '+i:'Original',active:i===active}))}})}));}
        window.confirmCreation=()=>{count++;active=count;window.creationRequested=false;state()};state();
      </script>`});}
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/'+(emptyMachine?'':'?host=windows&session=main&tab=42'));
    await page.waitForFunction(()=>document.querySelector('#build-version').textContent==='abc123def · 2026-10-04');
    await page.locator('#settings').hover();
    // Exact times are shown in the viewer's locale with a relative age, e.g. "Sun, 4 Oct 2026, 1:24 pm (3 days ago)".
    const commitTitle=emptyMachine?/^Commit abc123def · \S+ .*2026.*\d:24.* \(.+\)$/:/^Commit abc123def · 2026-10-04$/;
    assert.match(await page.locator('#settings').getAttribute('title'),commitTitle);
    assert.match(await page.locator('#build-version').getAttribute('title'),commitTitle);
    if(emptyMachine){
      // Switchboard never starts a session on its own, not even on another page load.
      const idle=()=>page.waitForFunction(()=>document.querySelector('#tab-empty-text')?.textContent==='No terminals yet');
      await idle();await page.evaluate(()=>refresh());
      await page.reload();await idle();
      assert.equal(frameBoots,0);assert.equal(await page.locator('#terminals>iframe').count(),0);
      // The + dialog offers the empty machine and creates its session.
      await page.locator('#new-tab').click();assert.equal(await page.locator('#new-tab-target option').count(),1);
      await page.locator('#new-tab-form button[type="submit"]').click();
    }
    const frame=page.frameLocator('iframe[title="Windows: main"]'),input=frame.locator('#terminal-input');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Original'));
    await page.waitForFunction(()=>document.activeElement===document.querySelector('#terminals>iframe.active'));
    if(emptyMachine){
      assert.equal(frameBoots,1);
      assert.equal(new URL(page.url()).searchParams.get('pane'),'7');
      assert.equal(await input.evaluate(i=>document.activeElement===i&&!window.term.options.disableStdin),true);
      await page.keyboard.type('first shell');assert.equal(await input.inputValue(),'first shell');
      await input.fill('');
      await page.evaluate(()=>refresh());assert.equal(frameBoots,1);
      // Adding a second tab is already available before the first catalog scan.
      await page.locator('#new-tab').click();assert.equal(await page.locator('#new-tab-target option').count(),1);
      await page.locator('#cancel-new-tab').click();
      catalogReady=true;await page.evaluate(()=>refreshAttention());
      await page.waitForFunction(()=>new URL(location.href).searchParams.get('tab')==='42');
    }
    async function create(number){
      if(number===1)await input.evaluate(()=>{window.controlSocket.readyState=0;});
      await page.keyboard.press(number===1?'Control+Alt+KeyT':'Meta+Alt+KeyT');
      await page.waitForFunction(()=>document.querySelector('#new-tab-dialog').open);
      assert.equal(await page.locator('#new-tab-form button[type="submit"]').evaluate(button=>document.activeElement===button),true,'Create tab is focused so Enter confirms the default target');
      assert.equal(await page.locator('#new-tab-form button[type="submit"]').evaluate(button=>{
        const style=getComputedStyle(button);return style.outlineStyle==='solid'&&style.outlineWidth==='2px';
      }),true,'The default action is visibly highlighted');
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='Creating tab…');
      if(number===1){
        assert.equal(await input.evaluate(()=>!!window.creationRequested),false);
        await input.evaluate(()=>{window.controlSocket.readyState=1;window.controlSocket.dispatchEvent(new Event('open'));});
        await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested===true);
      }
      assert.equal(await page.locator('#tabs .tab-select').count(),number+1);
      // Repeated old scans must not treat the preceding provisional tab as this creation.
      await page.evaluate(()=>refreshAttention());
      assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'Creating tab…');
      await input.evaluate(()=>window.confirmCreation());created=number;
      await page.waitForFunction(n=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell '+n,number);
      assert.equal(new URL(page.url()).searchParams.get('pane'),String(8+number));
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#terminals>iframe.active')),true,'New terminal receives keyboard focus after shortcut and Enter');
      assert.equal(await input.evaluate(i=>document.activeElement===i&&!window.term.options.disableStdin),true);
      await page.keyboard.type('draft '+number);
      assert.ok((await input.inputValue()).endsWith('draft '+number),'Typing reaches the new terminal without an extra click');
    }
    await create(1);
    await page.locator('#tabs .selected').click({button:'right'});
    await page.locator('#ready').click();
    await input.click();
    failed=true;await page.evaluate(()=>refreshAttention());
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'New shell 1');
    assert.equal(await input.inputValue(),'draft 1');
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    // Pending panes can close through their own target, not a native tab ID.
    await page.locator('#tabs .selected').click({button:'right'});
    assert.equal(await page.locator('#close-tab').isDisabled(),false);assert.equal(closes,0);
    await page.keyboard.press('Escape');
    failed=false;await page.evaluate(()=>refreshAttention());
    await create(2);
    const pendingUrl=page.url();assert.equal(new URL(pendingUrl).searchParams.get('pane'),'10');
    // Reload can reconnect the confirmed pane even while attention still knows only the old tab.
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell 2');
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    catalog=2;await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('tab')==='91');
    assert.equal(new URL(page.url()).searchParams.has('pane'),false);
    assert.equal(await page.locator('#tabs .tab-select').count(),3);
    assert.deepEqual(await page.locator('#tabs .tab-name').allTextContents(),['Original','New shell 1','New shell 2']);
    assert.equal(await page.evaluate(()=>ready[JSON.stringify(['windows','main','tab',90])]!==undefined),true);
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    // A deliberate move to search while creation waits must still win.
    await page.locator('#new-tab').click();
    await page.locator('#new-tab-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested);
    await page.locator('#tab-search').click();
    await input.evaluate(()=>window.confirmCreation());
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell 3');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    await page.keyboard.type('keep searching');
    assert.equal(await page.locator('#tab-search').inputValue(),'keep searching');
    await page.locator('#tab-search').fill('');
    await page.locator('#new-tab').click();
    await page.locator('#new-tab-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested);
    const failureReport=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/diagnostics/new-tab'&&response.request().postDataJSON().outcome==='disconnected');
    await input.evaluate(()=>{window.controlSocket.readyState=3;window.controlSocket.dispatchEvent(new Event('close'));});
    await failureReport;
    await page.waitForFunction(()=>![...document.querySelectorAll('#tabs .tab-name')].some(name=>name.textContent.includes('Creating tab'))&&document.querySelector('#status').textContent.includes('connection change'));
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'New shell 3');
    assert.equal(await input.evaluate(()=>window.term.options.disableStdin),false);
    await page.waitForFunction(()=>document.querySelector('#status').classList.contains('has-error'));
    assert.ok(diagnostics.some(diagnostic=>diagnostic.outcome==='ready'&&diagnostic.pane_id===9&&diagnostic.sent_ms>=diagnostic.delivery_ms));
    assert.ok(diagnostics.some(diagnostic=>diagnostic.outcome==='disconnected'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
