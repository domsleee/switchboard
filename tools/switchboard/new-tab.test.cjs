const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

for(const emptyMachine of [false,true])test(`${emptyMachine?'an empty machine starts its first terminal automatically; ':''}new terminals appear before attention discovery, remain focused, and acquire stable tab IDs without duplicates`,
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let created=0,catalog=0,failed=false,closes=0,frameBoots=0,connected=!emptyMachine,catalogReady=!emptyMachine;
    const nativeTabs=()=>Array.from({length:catalog+1},(_,i)=>({host:'windows',session:'main',id:i?89+i:42,position:i,name:i?'New shell '+i:'Original',panes:[{pane_id:i?8+i:7,is_plugin:false,tab_position:i}]}));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04',...(emptyMachine?{commit_timestamp:'2026-10-04T13:24:56+11:00'}:{})});
      if(path==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
      if(path==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:connected?[{name:'main',web_clients_allowed:true}]:[]});
      if(path==='/api/attention')return json({tabs:failed||!catalogReady?[]:nativeTabs(),panes:[],errors:failed?[{host:'windows',message:'Unavailable'}]:[]});
      if(path==='/api/hosts/windows/close-tab'){closes++;return json({ok:true});}
      if(path.startsWith('/hosts/')){connected=true;frameBoots++;return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        const input=document.querySelector('input');let count=${created},active=count;
        window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        window.__zjSendControl=message=>{if(message.type==='NewTab')window.creationRequested=true;};
      </script><script src="/bridge.js"></script><script>
        const socket=new WebSocket('wss://switchboard.test/ws/control');
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
    const commitTitle=`Commit abc123def · ${emptyMachine?'2026-10-04 13:24:56+11:00':'2026-10-04'}`;
    assert.equal(await page.locator('#settings').getAttribute('title'),commitTitle);
    assert.equal(await page.locator('#build-version').getAttribute('title'),commitTitle);
    const frame=page.frameLocator('iframe[title="Windows: main"]'),input=frame.locator('#terminal-input');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Original'));
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
      await page.locator('#new-tab').click();await page.locator('#new-tab-form button[type="submit"]').click();
      await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='Creating tab…');
      assert.equal(await page.locator('#tabs .tab-select').count(),number+1);
      // Repeated old scans must not treat the preceding provisional tab as this creation.
      await page.evaluate(()=>refreshAttention());
      assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'Creating tab…');
      await input.evaluate(()=>window.confirmCreation());created=number;
      await page.waitForFunction(n=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell '+n,number);
      assert.equal(new URL(page.url()).searchParams.get('pane'),String(8+number));
      assert.equal(await input.evaluate(i=>document.activeElement===i&&!window.term.options.disableStdin),true);
      await page.keyboard.type('draft '+number);
    }
    await create(1);
    await page.locator('#tabs .selected').click({button:'right'});
    await page.locator('#ready').click();
    await input.click();
    failed=true;await page.evaluate(()=>refreshAttention());
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'New shell 1');
    assert.equal(await input.inputValue(),'draft 1');
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    // Pending pane IDs must never be sent as native tab IDs to Close.
    await page.locator('#tabs .selected').click({button:'right'});
    assert.equal(await page.locator('#close-tab').isDisabled(),true);assert.equal(closes,0);
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
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
