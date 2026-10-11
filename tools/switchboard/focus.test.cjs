const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
const key=(host,id)=>JSON.stringify([host,'main','tab',id]);
const tab=(host,id,session='main')=>({host,session,id,position:0,name:host+' terminal',panes:[{pane_id:id,is_plugin:false,tab_position:0}]});

function monitorContext(){
  const windows={host:'windows',name:'main',catalog:[tab('windows',42)]};
  const other={host:'windows',name:'other',catalog:[tab('windows',90,'other')]};
  const mac={host:'mac',name:'main',catalog:[tab('mac',1)]};
  const context={attentionErrors:[],attentionLoading:false,attentionRefreshPending:false,paneAttention:new Map(),
    tabCatalog:[...windows.catalog,...other.catalog,...mac.catalog],sessions:new Map([['windows',windows],['other',other],['mac',mac]]),
    selected:key('windows',42),allTabs:()=>[],render(){},focus(){assert.fail('Background scanning must not request focus');},
    attentionKey:(host,session,pane)=>JSON.stringify([host,session,pane]),
    updateCreatedTabs(){},setCatalog(entry,tabs){entry.catalog=tabs;}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function catalogUnavailable('),source.indexOf('function updateTabUrl(')),context);
  vm.runInContext(source.slice(source.indexOf('async function refreshAttention('),source.indexOf('refreshAttention();setInterval')),context);
  context.poll=async data=>{context.fetch=async()=>({ok:true,json:async()=>data});await context.refreshAttention();};
  return {context,windows,other,mac};
}

test('failed attention scans preserve known catalogs, scoped to the failed host or session',async()=>{
  const {context,windows,other,mac}=monitorContext();
  await context.poll({tabs:[tab('mac',2)],errors:[{host:'windows',message:'Private helper unavailable'}]});
  assert.equal(windows.catalog[0].id,42);assert.equal(other.catalog[0].id,90);assert.equal(mac.catalog[0].id,2);
  assert.deepEqual(Array.from(context.tabCatalog,t=>t.id),[2,42,90]);
  await context.poll({tabs:[tab('windows',91,'other'),tab('mac',2)],errors:[{host:'windows',session:'main'}]});
  assert.equal(windows.catalog[0].id,42);assert.equal(other.catalog[0].id,91);
  assert.equal(context.selected,key('windows',42));
  // An HTTP failure also leaves known terminals alone.
  context.fetch=async()=>({ok:false});await context.refreshAttention();
  assert.equal(windows.catalog[0].id,42);assert.equal(context.selected,key('windows',42));
  // Successful empty scans are authoritative, so a truly closed tab disappears.
  await context.poll({tabs:[tab('mac',2)],errors:[]});
  assert.equal(windows.catalog.length,0);assert.equal(other.catalog.length,0);
  assert.deepEqual(Array.from(context.tabCatalog,t=>t.id),[2]);
});

test('a fresh page uses the relay catalog when a host scan is unavailable',async()=>{
  const {context,windows,other,mac}=monitorContext();
  context.tabCatalog=[];windows.catalog=[];other.catalog=[];mac.catalog=[];
  const retained=tab('windows',42);
  await context.poll({tabs:[tab('mac',1),retained],errors:[{host:'windows',message:'Private helper unavailable'}]});
  assert.equal(windows.catalog[0].id,42);
  assert.equal(mac.catalog[0].id,1);
  assert.deepEqual(Array.from(context.tabCatalog,t=>t.id),[1,42]);
  // Repeated retained catalogs never duplicate a tab already known to the page.
  await context.poll({tabs:[retained],errors:[{host:'windows'}]});
  assert.deepEqual(Array.from(context.tabCatalog,t=>t.id),[42]);
  await context.poll({tabs:[],errors:[]});
  assert.equal(windows.catalog.length,0);
});

test('native panes recover a cold catalog and reconcile pane keys with stable tab IDs',async()=>{
  const {context,windows,other,mac}=monitorContext();
  Object.assign(context,{ready:{},archived:{},tabOrder:[],saveReady(){},localStorage:{setItem(){}}});
  vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  context.tabCatalog=[];windows.catalog=[];other.catalog=[];mac.catalog=[];
  windows.state={session_name:'main',tabs:[{position:0,name:'First'},{position:1,name:'Second'}],
    panes:[{pane_id:7,is_plugin:false,tab_position:0,title:'First shell'},{pane_id:8,is_plugin:false,tab_position:0},{pane_id:9,is_plugin:false,tab_position:1,title:'Second shell'}],
    active_pane:{pane_id:7,is_plugin:false,tab_position:0}};
  await context.poll({tabs:[],errors:[{host:'windows'}]});
  assert.deepEqual(Array.from(windows.provisionalTabs,t=>[t.id,t.name,t.pending,t.fallback]),[[7,'First',true,true],[9,'Second',true,true]]);
  assert.equal(context.selected,key('windows',42),'A requested stable tab stays selected until its identity returns');
  context.selected=JSON.stringify(['windows','main','pane',8]);windows.provisionalTabs=[];
  await context.poll({tabs:[],errors:[{host:'windows'}]});
  assert.deepEqual(Array.from(windows.provisionalTabs,t=>t.id),[8,9],'A requested second pane does not duplicate its native tab');
  context.selected=JSON.stringify(['windows','main','pane',9]);
  context.tabOrder=[context.selected,JSON.stringify(['windows','main','pane',8])];
  await context.poll({tabs:[],errors:[{host:'windows'}]});
  assert.equal(windows.provisionalTabs.length,2,'Repeated failures do not duplicate native tabs');
  await context.poll({tabs:[{...tab('windows',42),panes:windows.state.panes.slice(0,2)},
    {...tab('windows',90),position:1,panes:[windows.state.panes[2]]}],errors:[]});
  assert.equal(windows.provisionalTabs.length,0);
  assert.equal(context.selected,key('windows',90));
  assert.deepEqual(Array.from(context.tabOrder),[key('windows',90),key('windows',42)]);
  await context.poll({tabs:[],errors:[]});
  assert.equal(windows.catalog.length,0);assert.equal(windows.provisionalTabs.length,0);
});

test('transient discovery and attention failures retain the selected URL until authoritative closure',()=>{
  const location={href:'https://switchboard.test/?host=windows&session=main&tab=42',search:'?host=windows&session=main&tab=42'};
  const saved=[];
  const context={location,URL,URLSearchParams,history:{replaceState:(_,title,url)=>saved.push(String(url))},
    hosts:new Map([['mac',{sessions:[{name:'main'}]}],['windows',{error:'Offline'}]]),
    sessions:new Map(),selected:key('windows',42),restoringTab:true,loading:false,attentionErrors:[],hostsLoaded:true};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function requestedTab('),source.indexOf('function tabKey(')),context);
  assert.equal(context.waitingForRequestedTab(),true);context.updateTabUrl(null);assert.deepEqual(saved,[]);
  context.hosts.set('windows',{sessions:[{name:'main'}]});context.attentionErrors=[{host:'windows'}];
  assert.equal(context.waitingForRequestedTab(),true);
  context.restoringTab=false;assert.equal(context.waitingForRequestedTab(),true);
  context.updateTabUrl(null);assert.deepEqual(saved,[]);
  context.hosts.set('windows',{sessions:[]});
  assert.equal(context.waitingForRequestedTab(),false,'Successful discovery can confirm the selected session closed');
  context.updateTabUrl(null);assert.equal(new URL(saved[0]).searchParams.get('tab'),null);
});

test('restore waits for the first clean scan covering the session, then abandons a proven-closed tab',()=>{
  const location={href:'https://switchboard.test/?host=windows&session=main&tab=42',search:'?host=windows&session=main&tab=42'};
  const entry={host:'windows',name:'main',state:{panes:[{pane_id:7,is_plugin:false}]},catalog:[{id:90}],catalogPolls:0};
  const context={location,URL,URLSearchParams,history:{replaceState(){}},
    hosts:new Map([['windows',{sessions:[{name:'main'}]}]]),
    sessions:new Map([[JSON.stringify(['windows','main']),entry]]),
    selected:key('windows',42),restoringTab:true,loading:false,attentionErrors:[],hostsLoaded:true};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function requestedTab('),source.indexOf('function tabKey(')),context);
  assert.equal(context.waitingForRequestedTab(),true,'A seeded catalog waits for its first clean scan');
  entry.catalogPolls=1;
  assert.equal(context.waitingForRequestedTab(),false,'A clean covered scan without the tab proves it closed');
});

test('every attention poll marks the sessions it covered',async()=>{
  const {context,windows}=monitorContext();
  await context.poll({tabs:[],errors:[]});
  assert.equal(windows.catalogPolls,1);
  await context.poll({tabs:[],errors:[]});
  assert.equal(windows.catalogPolls,2);
});

test('reconnect metadata restores the chosen tab instead of following another native active pane',()=>{
  const original=tab('windows',42),other={...tab('windows',90),position:1,panes:[{pane_id:90,is_plugin:false,tab_position:1}]};
  const frame={classList:{contains:()=>true},contentWindow:{postMessage(){}}};
  const entry={host:'windows',name:'main',frame,catalog:[original,other],state:{session_name:'main',panes:original.panes,active_pane:original.panes[0]},needsFocus:true,disconnected:true};
  let handler,focused;
  const context={window:{addEventListener:(_,fn)=>handler=fn},location:{origin:'https://switchboard.test'},
    sessions:new Map([[JSON.stringify(['windows','main']),entry]]),selected:key('windows',42),ready:{},nativeTabs:false,
    allTabs:()=>entry.catalog.map(tab=>({entry,tab,key:key('windows',tab.id)})),saveReady(){},render(){},acknowledgeAttention(){},
    focus(item){focused=item.key;entry.needsFocus=false;}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function sessionKey('),source.indexOf('function attentionKey(')),context);
  const start=source.indexOf("window.addEventListener('message'");
  vm.runInContext(source.slice(start,source.indexOf("}else if(event.data?.type==='zellij-focus-failed')",start))+'}});',context);
  const state=()=>handler({origin:context.location.origin,source:frame.contentWindow,data:{type:'zellij-state',payload:{session_name:'main',panes:[...original.panes,...other.panes],active_pane:other.panes[0]}}});
  state();assert.equal(entry.disconnected,false);assert.equal(context.selected,key('windows',42));assert.equal(focused,key('windows',42));
  // A later intentional native switch keeps the existing follow behavior.
  entry.state.active_pane=original.panes[0];state();assert.equal(context.selected,key('windows',90));
});

// Uses only synthetic hosts and an input fixture, never a live terminal.
test('headless browser keeps iframe, selection, URL and input focus through failure and recovery',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser focus check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    let discoveryError=false,attentionError=false,httpError=false,closed=false;
    const page=await context.newPage(),pageErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(pathname==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(pathname==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:closed||discoveryError?[]:[{name:'main',web_clients_allowed:true}],...(discoveryError?{error:'Offline'}:{})});
      if(pathname==='/api/attention'){
        if(httpError)return route.fulfill({status:503,body:'Monitor offline'});
        return json({tabs:[tab('mac',1),...(!attentionError&&!closed?[tab('windows',42)]:[])],panes:[],errors:attentionError?[{host:'windows',message:'Private helper unavailable'}]:[]});
      }
      if(pathname.startsWith('/hosts/')){
        const host=pathname.split('/')[2],id=host==='mac'?1:42;
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
          window.focusRequests=0;
          const input=document.querySelector('input');
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;window.__zjSendControl=()=>{};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){focusRequests++;input.focus();},blur(){input.blur();},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          window.sendState=()=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:true,cols:100,rows:40}}})}));
          window.disconnect=()=>socket.dispatchEvent(new Event('close'));
          sendState();
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!['index.html','app.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const requested='https://switchboard.test/?host=windows&session=main&tab=42';
    await page.goto(requested);
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.title==='Windows: main'&&document.activeElement===document.querySelector('iframe.active'));
    await page.evaluate(()=>{window.originalFrame=document.querySelector('iframe.active');});
    const input=page.frameLocator('iframe[title="Windows: main"]').locator('#terminal-input');
    await input.fill('typed before failure');
    async function unchanged(){
      assert.equal(page.url(),requested);
      assert.deepEqual(await page.evaluate(()=>({same:originalFrame===document.querySelector('iframe.active'),focused:document.activeElement===originalFrame&&originalFrame.contentDocument.activeElement.id==='terminal-input',selection:document.querySelector('#tabs .selected')?._item.key,value:originalFrame.contentDocument.querySelector('input').value})),
        {same:true,focused:true,selection:key('windows',42),value:'typed before failure'});
    }
    // A disconnected native control socket has no latest pane. Sending another
    // focus command there makes the real bridge blur xterm and disable its input.
    await input.evaluate(()=>window.disconnect());
    await page.waitForFunction(()=>sessions.get(JSON.stringify(['windows','main'])).needsFocus);
    const focusRequests=await input.evaluate(()=>window.focusRequests);
    attentionError=true;await page.evaluate(()=>refreshAttention());await unchanged();
    assert.equal(await input.evaluate(()=>window.focusRequests),focusRequests);
    assert.match(await page.locator('#status').textContent(),/Windows: attention status unavailable/);
    discoveryError=true;await page.evaluate(()=>refresh());await unchanged();
    httpError=true;await page.evaluate(()=>refreshAttention());await unchanged();
    discoveryError=false;attentionError=false;httpError=false;
    await input.evaluate(()=>window.sendState());
    await page.evaluate(async()=>{await refresh();await refreshAttention();});await unchanged();
    // Older browsers lack state-preserving DOM moves. Their fallback must also
    // keep focus when the bridge removes and restores the viewport wrapper.
    await input.evaluate(()=>{Element.prototype.moveBefore=undefined;window.disconnect();});
    await page.waitForFunction(()=>sessions.get(JSON.stringify(['windows','main'])).needsFocus);
    await unchanged();await input.evaluate(()=>window.sendState());
    await page.waitForFunction(()=>!sessions.get(JSON.stringify(['windows','main'])).disconnected);
    await unchanged();
    // Recovery must also respect a dialog the user deliberately opened.
    await page.locator('#settings').click();
    await input.evaluate(()=>window.disconnect());
    await page.waitForFunction(()=>sessions.get(JSON.stringify(['windows','main'])).needsFocus);
    await input.evaluate(()=>window.sendState());
    await page.evaluate(()=>refreshAttention());
    assert.equal(await page.evaluate(()=>document.activeElement.id),'panel-tab-settings');
    assert.equal(page.url(),requested);
    await page.locator('#close-panel').click();await input.click();
    await input.evaluate(element=>element.setSelectionRange(element.value.length,element.value.length));
    await page.keyboard.type(' still typing');assert.equal(await input.inputValue(),'typed before failure still typing');
    // A requested unavailable terminal does not automatically select a healthy Mac tab on reload.
    discoveryError=true;attentionError=true;await page.reload();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('attention status unavailable')&&document.querySelector('#tabs .tab-select'));
    assert.equal(page.url(),requested);
    assert.equal(await page.locator('iframe.active').count(),0);
    assert.equal(await page.locator('#tabs .selected').count(),0);
    assert.equal(await page.frameLocator('iframe[title="Mac: main"]').locator('#terminal-input').evaluate(()=>window.focusRequests),0);
    discoveryError=false;attentionError=false;
    await page.evaluate(async()=>{await refresh();await refreshAttention();});
    await page.waitForFunction(()=>document.activeElement===document.querySelector('iframe[title="Windows: main"]'));
    assert.equal(page.url(),requested);
    // A cold relay cache can still show usable native panes. A stable-tab deep
    // link waits for its identity instead of selecting an unrelated pane key.
    attentionError=true;await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    assert.equal(page.url(),requested);assert.equal(await page.locator('#tabs .selected').count(),0);
    const fallback=page.locator('#tabs .tab-select[title*=" · Windows · main"]');
    assert.equal(await fallback.evaluate(e=>e._item.tab.pending),true);
    await fallback.click();
    await page.waitForFunction(()=>document.activeElement===document.querySelector('iframe[title="Windows: main"]'));
    assert.equal(new URL(page.url()).searchParams.get('pane'),'42');
    await fallback.evaluate(e=>e.nextSibling.click());assert.equal(await page.locator('#close-tab').isDisabled(),true);
    await page.keyboard.press('Escape');
    attentionError=false;await page.evaluate(()=>refreshAttention());
    assert.equal(page.url(),requested);assert.equal(await page.locator('#tabs .tab-select').count(),2);
    // Successful empty discovery must still remove a genuinely closed session.
    closed=true;await page.evaluate(()=>refresh());
    assert.equal(await page.locator('iframe[title="Windows: main"]').count(),0);
    assert.equal(new URL(page.url()).searchParams.get('host'),'mac');
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});

// The stock client reloads its iframe after a dropped socket, which destroys the
// focused xterm textarea. Uses synthetic hosts only, never a live terminal.
test('headless browser returns focus to the same terminal after a reconnect reload, and only there',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser focus check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    let outage=false;
    const page=await context.newPage(),pageErrors=[];
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.addInitScript(()=>{if(window===top)window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts')return outage?route.fulfill({status:503,body:''}):json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(pathname.startsWith('/api/hosts/')){
        const id=pathname.split('/')[3];
        return json({id,name:id==='mac'?'Mac':'Windows',...(outage?{error:'Host unavailable'}:{sessions:[{name:'main',web_clients_allowed:true}]})});
      }
      // A restarted relay reports hosts it has not scanned yet as unavailable.
      if(pathname==='/api/attention')return json(outage?{tabs:[],panes:[],errors:[{host:'Switchboard',message:'Status starting'}]}:{tabs:[tab('mac',1),tab('windows',42)],panes:[],errors:[]});
      if(pathname.startsWith('/hosts/')){
        const id=pathname.split('/')[2]==='mac'?1:42;
        // Like the stock client: focus is managed by Switchboard, and a dropped
        // socket reloads the whole page once the server answers again.
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
          window.focusRequests=0;
          const input=document.querySelector('input');
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSendControl=()=>{};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){focusRequests++;input.focus();},blur(){input.blur();},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          const sendState=()=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane}})}));
          window.drop=()=>socket.dispatchEvent(new Event('close'));
          window.reconnect=()=>location.reload();
          sendState();
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!['index.html','app.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=windows&session=main&tab=42');
    const windows=page.frameLocator('iframe[title="Windows: main"]').locator('#terminal-input');
    const mac=page.frameLocator('iframe[title="Mac: main"]').locator('#terminal-input');
    const inWindowsTerminal=()=>page.evaluate(()=>{const frame=document.querySelector('iframe[title="Windows: main"]');
      return document.activeElement===frame&&frame.classList.contains('active')&&frame.contentDocument.activeElement?.id==='terminal-input';});
    await page.waitForFunction(()=>document.activeElement===document.querySelector('iframe.active')&&document.querySelector('iframe.active').title==='Windows: main');
    await windows.click();assert.equal(await inWindowsTerminal(),true);
    await page.evaluate(()=>{window.windowsFrame=document.querySelector('iframe[title="Windows: main"]');});
    async function reconnect(locator){
      await locator.evaluate(()=>window.drop());
      outage=true;await page.evaluate(async()=>{await refresh();await refreshAttention();});
      return async()=>{
        outage=false;
        const loaded=page.waitForEvent('framenavigated');await locator.evaluate(()=>window.reconnect());await loaded;
        await page.evaluate(async()=>{await refresh();await refreshAttention();});
      };
    }
    // 1. Typing in a terminal through a relay restart: focus returns to it.
    const restore=await reconnect(windows);
    assert.equal(await page.evaluate(()=>document.querySelector('iframe.active')===windowsFrame),true,'An outage keeps the selected terminal frame');
    await restore();
    await page.waitForFunction(()=>windowsFrame.contentDocument.activeElement?.id==='terminal-input',null,{timeout:3000}).catch(()=>{});
    assert.equal(await inWindowsTerminal(),true,'Focus returns to the reconnected terminal');
    assert.equal(await page.evaluate(()=>document.querySelector('iframe.active')===windowsFrame),true,'The same iframe stays mounted');
    await page.keyboard.type('after');assert.equal(await windows.inputValue(),'after');
    // 2. A background terminal reconnecting never takes focus.
    await (await reconnect(mac))();
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await mac.evaluate(()=>window.focusRequests),0);
    assert.equal(await inWindowsTerminal(),true);
    // 3. Moving to the search box during the outage keeps focus there.
    const later=await reconnect(windows);
    await page.locator('#tab-search').focus();
    await later();await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    assert.equal(await windows.evaluate(()=>window.focusRequests),0);
    // Escape back from search lands in the terminal, not the reloaded page body.
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>windowsFrame.contentDocument.activeElement?.id==='terminal-input',null,{timeout:3000}).catch(()=>{});
    assert.equal(await inWindowsTerminal(),true);
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});

// Real DOM focus and keyboard events, with synthetic native metadata and control
// acknowledgements. Stable tab IDs deliberately differ from pane IDs.
async function browserFocusFixture({mismatch=null,acknowledge=true}={}){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const page=await context.newPage(),pageErrors=[],closes=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(()=>{if(window===top)window.setInterval=()=>0;});
  await context.route('**/*',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
    if(pathname==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
    if(pathname==='/api/attention')return json({tabs:[41,42].map((id,position)=>({host:'mac',session:'main',id,position,name:'Terminal '+id,
      panes:[{pane_id:id===mismatch?9:position+7,is_plugin:false,tab_position:position}]})),panes:[],errors:[]});
    if(pathname==='/api/hosts/mac/close-tab'){
      closes.push(route.request().postDataJSON());
      return json({ok:true});
    }
    if(pathname.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
      const input=document.querySelector('input');
      window.controlMessages=[];window.acknowledge=${JSON.stringify(acknowledge)};
      window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
      window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus();},blur(){input.blur();},
        _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
    </script><script src="/bridge.js"></script><script>
      const socket=new WebSocket('wss://switchboard.test/ws/control');
      const panes=[7,8].map((pane_id,tab_position)=>({pane_id,is_plugin:false,tab_position}));
      window.sendState=paneId=>socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes.find(p=>p.pane_id===paneId)}})}));
      window.__zjSendControl=message=>{controlMessages.push(message);if(acknowledge&&message.type==='FocusPane')queueMicrotask(()=>sendState(message.pane_id));};
      sendState(7);
    </script>`});
    const file=pathname==='/'?'index.html':pathname.slice(1);
    if(!['index.html','app.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
  });
  await page.goto('https://switchboard.test/?host=mac&session=main&tab=41');
  await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentDocument.activeElement.id==='terminal-input');
  const input=page.frameLocator('iframe[title="Mac: main"]').locator('#terminal-input');
  return {browser,page,input,pageErrors,closes,setMismatch(id){mismatch=id;},
    button(id){return page.locator('#tabs .tab-select').filter({hasText:'Terminal '+id});}};
}

test('headless browser completes a sidebar switch after catalog metadata catches up without taking search or dialog focus',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser focus check'},async()=>{
  const {browser,page,input,pageErrors,setMismatch,button}=await browserFocusFixture({mismatch:42});
  try{
    await button(42).click();
    await page.waitForFunction(()=>selected===JSON.stringify(['mac','main','tab',42])&&sessions.get(JSON.stringify(['mac','main'])).needsFocus);
    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#tabs .selected')),true,'The clicked button owns focus while native metadata is stale');
    assert.deepEqual(await input.evaluate(()=>controlMessages),[],'A missing pane cannot receive a focus command');
    setMismatch(null);await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>document.activeElement===document.querySelector('iframe.active')&&document.querySelector('iframe.active').contentDocument.activeElement.id==='terminal-input',null,{timeout:3000});
    assert.equal(new URL(page.url()).searchParams.get('tab'),'42');
    assert.equal(await page.evaluate(()=>sessions.get(JSON.stringify(['mac','main'])).state.active_pane.pane_id),8);
    await page.keyboard.type('switched');assert.equal(await input.inputValue(),'switched');

    // A deliberate move away during the same metadata wait must remain respected.
    setMismatch(41);await page.evaluate(()=>refreshAttention());await button(41).click();
    await page.waitForFunction(()=>sessions.get(JSON.stringify(['mac','main'])).needsFocus);
    await page.locator('#tab-search').focus();
    setMismatch(null);await page.evaluate(()=>refreshAttention());
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    assert.equal(await page.evaluate(()=>sessions.get(JSON.stringify(['mac','main'])).needsFocus),true);
    await page.locator('#settings').click();await page.evaluate(()=>refreshAttention());
    assert.equal(await page.evaluate(()=>document.activeElement.id),'panel-tab-settings');
    await page.locator('#close-panel').click();await button(41).click();
    await page.waitForFunction(()=>document.querySelector('iframe.active').contentDocument.activeElement.id==='terminal-input');
    assert.equal(await page.evaluate(()=>sessions.get(JSON.stringify(['mac','main'])).state.active_pane.pane_id),7);
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});

test('headless browser Ctrl+D closes the selected stable tab exactly once while switching has blurred terminal input',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser focus check'},async()=>{
  const {browser,page,input,pageErrors,closes}=await browserFocusFixture({acknowledge:false});
  try{
    await page.keyboard.press('Control+Digit2');
    await page.waitForFunction(()=>{const frame=document.querySelector('iframe.active'),entry=sessions.get(JSON.stringify(['mac','main']));
      return selected===JSON.stringify(['mac','main','tab',42])&&entry.requestedPane?.pane_id===8&&document.activeElement===frame&&frame.contentDocument.activeElement===frame.contentDocument.body&&frame.contentWindow.term.options.disableStdin;});
    assert.equal(await page.evaluate(()=>sessions.get(JSON.stringify(['mac','main'])).state.active_pane.pane_id),7,'Native focus still belongs to the previous tab');
    await page.keyboard.down('Control');await page.keyboard.down('KeyD');await page.keyboard.down('KeyD');
    await page.keyboard.up('KeyD');await page.keyboard.up('Control');
    await page.waitForFunction(()=>!document.querySelector('#tabs .tab-select[aria-label^="Terminal 42,"]'),null,{timeout:3000});
    await page.evaluate(()=>refreshAttention());
    assert.deepEqual(closes,[{session:'main',tab_id:42}],'Held Ctrl+D closes the selected tab, never the previous active pane or next tab');
    assert.equal(await page.locator('#tabs .tab-select').count(),1,'A stale catalog cannot bring a confirmed close back');
    await page.locator('#tab-search').focus();await page.keyboard.press('Control+d');
    await page.locator('#settings').click();await page.keyboard.press('Control+d');
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(closes.length,1,'Search and dialog keys do not close terminals');
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});
