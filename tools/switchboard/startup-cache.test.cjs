const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/startup-cache.js','utf8');
const tab=(host,id,name)=>({host,session:'main',id,position:0,name,panes:[{pane_id:id,is_plugin:false,tab_position:0,title:name}]});

test('startup holds missing tabs for five seconds, then clean snapshots become authoritative',()=>{
  let now=1000;
  const first=tab('mac',1,'First'),second=tab('win',2,'Second');
  const context={Date:{now:()=>now},localStorage:{getItem:()=>JSON.stringify({version:1,savedAt:now,hosts:[{id:'mac',name:'Mac'},{id:'win',name:'Windows'}],tabs:[first,second]})}};
  vm.createContext(context);vm.runInContext(source,context);
  const cache=context.SwitchboardStartup;
  assert.deepEqual(Array.from(cache.merge([first]),t=>t.id),[1,2]);
  now+=4999;
  assert.deepEqual(Array.from(cache.merge([]),t=>t.id),[1,2]);
  now++;
  assert.equal(cache.active(),false);
  assert.deepEqual(Array.from(cache.finish().tabs),[]);
  assert.deepEqual(Array.from(cache.merge([second]),t=>t.id),[2]);
});

test('broken or expired snapshots do not prevent loading',()=>{
  for(const value of ['{',JSON.stringify({version:1,savedAt:0,hosts:[],tabs:[]}),JSON.stringify({version:1,savedAt:86400001,hosts:[],tabs:[null]})]){
    const context={Date:{now:()=>86400001},localStorage:{getItem:()=>value}};
    vm.createContext(context);vm.runInContext(source,context);
    assert.equal(context.SwitchboardStartup.snapshot.tabs.length,0);
  }
});

test('reload shows cached rows before discovery, survives empty snapshots, and drops a closed session after five seconds',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();page.setDefaultTimeout(10000);
    const errors=[],connections=[];page.on('pageerror',error=>errors.push(error.message));
    const tabs=[tab('win',2,'Second'),tab('mac',1,'First')];
    let partial=false,holdDiscovery=false,holdState=true,releaseDiscovery;
    const discoveryReady=new Promise(resolve=>releaseDiscovery=resolve);
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/health')return json({});
      if(pathname==='/api/mesh')return json({members:[]});
      if(pathname==='/api/hosts'){
        if(holdDiscovery)await discoveryReady;
        return json([{id:'mac',name:'Mac'},{id:'win',name:'Windows'}]);
      }
      if(pathname.startsWith('/api/hosts/')){
        const id=pathname.split('/').at(-1);
        return json({id,name:id==='mac'?'Mac':'Windows',sessions:partial&&id==='win'?[{name:'private',web_clients_allowed:false}]:[{name:'main',web_clients_allowed:true}]});
      }
      if(pathname==='/api/attention')return json({tabs:partial?tabs.filter(tab=>tab.host==='mac'):tabs,panes:[],errors:[]});
      if(pathname.startsWith('/hosts/')){
        const host=pathname.split('/')[2];connections.push(host);
        const pane=tabs.find(tab=>tab.host===host).panes[0];
        return route.fulfill({contentType:'text/html',body:`<input id="terminal-input"><script>
          const pane=${JSON.stringify(pane)},input=document.querySelector('input');
          const state=focus_id=>parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes:[pane],active_pane:pane}},location.origin);
          addEventListener('message',event=>{if(event.data.type==='zellij-focus'){input.focus();state(event.data.focus_id)}});
          window.sendState=state;if(!${holdState})state();
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!['index.html','app.js','startup-cache.js','close.js','titles.js','style.css','pairing-notice.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=1');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2&&[...sessions.values()].every(entry=>typeof entry.frame.contentWindow.sendState==='function'));
    assert.deepEqual(await page.locator('#tabs .tab-name').allTextContents(),['First','Second']);
    assert.equal(await page.evaluate(()=>[...sessions.values()].every(entry=>!entry.state)),true,'Fresh catalogs appear before terminal sockets report metadata');
    await page.evaluate(()=>{for(const entry of sessions.values())entry.frame.contentWindow.sendState();});
    holdState=false;
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('switchboard-startup-tabs')||'null')?.tabs.length===2);
    partial=true;holdDiscovery=true;connections.length=0;
    await page.reload({waitUntil:'domcontentloaded'});
    const labels=()=>page.locator('#tabs .tab-name').allTextContents();
    assert.deepEqual(await labels(),['First','Second']);
    assert.deepEqual(connections,[],'Cached sessions never open a native terminal before discovery');
    await page.evaluate(()=>{window.originalRows=[...document.querySelectorAll('.tab-row')];});
    const input=page.frameLocator('iframe[title="Mac: main"]').locator('#terminal-input');
    releaseDiscovery();
    await input.waitFor();
    await page.evaluate(async()=>{await refresh();await refreshAttention();});
    assert.deepEqual(await labels(),['First','Second']);
    assert.deepEqual(connections,['mac'],'A closed cached session is never reopened');
    assert.equal(await page.evaluate(()=>originalRows.every((row,index)=>row===document.querySelectorAll('.tab-row')[index])),true);
    await page.waitForFunction(()=>!SwitchboardStartup.active());
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===1);
    assert.deepEqual(await labels(),['First']);
    assert.equal(await page.locator('.tab-row').evaluate(row=>row===originalRows[0]),true);
    assert.equal(await input.evaluate(el=>document.activeElement===el),true,'Expiry preserves terminal input focus');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
