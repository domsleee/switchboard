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
    setCatalog(entry,tabs){entry.catalog=tabs;}};
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

test('transient discovery and attention failures retain the selected URL until authoritative closure',()=>{
  const location={href:'https://switchboard.test/?host=windows&session=main&tab=42',search:'?host=windows&session=main&tab=42'};
  const saved=[];
  const context={location,URL,URLSearchParams,history:{replaceState:(_,title,url)=>saved.push(String(url))},
    hosts:new Map([['mac',{sessions:[{name:'main'}]}],['windows',{error:'Offline'}]]),
    sessions:new Map(),selected:key('windows',42),restoringTab:true,loading:false,attentionErrors:[]};
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
    assert.equal(await page.evaluate(()=>document.activeElement.id),'close-settings');
    assert.equal(page.url(),requested);
    await page.locator('#close-settings').click();await input.click();
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
    // Successful empty discovery must still remove a genuinely closed session.
    closed=true;await page.evaluate(()=>refresh());
    assert.equal(await page.locator('iframe[title="Windows: main"]').count(),0);
    assert.equal(new URL(page.url()).searchParams.get('host'),'mac');
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});
