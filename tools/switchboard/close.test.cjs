const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('Close (menu or Ctrl+D) closes the clicked tab immediately and restores it on failure',async()=>{
  const elements=new Map(),calls=[];
  const $=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,hidden:false,open:false});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[{tab_position:2,pane_id:17,is_plugin:false}]}};
  const item={entry,tab:{id:42,position:2,name:'Clicked tab'},key:'clicked'};
  const context={$,contextItem:item,hosts:new Map([['win',{name:'Windows'}]]),statuses:[],
    tabTitle:item=>item.tab.name,closeTabMenu(){context.contextItem=null;},
    setStatus(message){context.statuses.push(message);},ready:{clicked:1},archived:{clicked:1},saveReady(){},localStorage:{setItem(){}},render(){},activate(next){context.selected=next.key;},
    fetch:async(url,options)=>{calls.push([url,JSON.parse(options.body)]);return {ok:true};}};
  context.selected='clicked';context.allTabs=()=>[item];
  context.document={querySelector:()=>null};
  $('artifact-preview').hidden=true;
  let clicked;$('close-tab').click=()=>{clicked=$('close-tab').onclick();};
  context.AbortSignal=AbortSignal;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const start=source.indexOf('function closeSelectedTab(){');
  vm.runInContext(source.slice(start,source.indexOf("window.addEventListener('keydown'",start)),context);
  entry.focusPending=true;entry.followActiveTab=true;entry.requestedPane={pane_id:99,is_plugin:false};
  context.closeSelectedTab();await clicked;
  assert.deepEqual(calls[0],['/api/hosts/win/close-tab',{session:'main',tab_id:42}],'no confirmation step');
  assert.equal(context.ready.clicked,undefined);assert.equal(context.archived.clicked,undefined);
  context.contextItem=item;
  context.fetch=async()=>({ok:false,text:async()=>'That tab is no longer available'});
  await $('close-tab').onclick();
  assert.match(context.statuses.at(-1),/no longer available/);
  assert.equal(entry.closingTabs.has('clicked'),false);
});

test('close removes the selected tab before the request finishes, keeps stale catalogs hidden, and rolls back errors',async()=>{
  const elements=new Map(),$=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,open:false});
    return elements.get(id);
  };
  const entry={host:'win',name:'main',state:{panes:[]},catalog:[{id:42,name:'A',panes:[]},{id:90,name:'B',panes:[]}]};
  let finish,requests=0;
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const context={$,sessions:new Map([['main',entry]]),hosts:new Map(),SwitchboardTitles:{tabTitle:(_,tab)=>tab.name},selected:null,tabOrder:[],filter:'all',groups:{},archived:{},ready:{},
    saveReady(){},localStorage:{setItem(){}},tabTitle:item=>item.tab.name,closeTabMenu(){context.contextItem=null;},render(){},
    activate(item){context.selected=item.key;},setStatus(message){context.status=message;},
    fetch:()=>{requests++;return new Promise(resolve=>finish=resolve);}};
  context.AbortSignal=AbortSignal;
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  const original=entry.catalog.slice();context.selected=context.tabKey(entry,original[0]);context.contextItem=context.allTabs()[0];
  const pending=$('close-tab').onclick();
  assert.equal(requests,1);assert.equal(context.allTabs().length,1);
  assert.equal(context.selected,context.tabKey(entry,original[1]));
  context.setCatalog(entry,[]);context.setCatalog(entry,original);
  assert.equal(context.allTabs().length,1,'in-flight snapshots cannot undo a confirmed close');
  finish({ok:false,text:async()=>'Unavailable'});await pending;
  assert.equal(context.allTabs().length,2);assert.equal(context.selected,context.tabKey(entry,original[1]),'late failure must not select or focus the restored tab');assert.match(context.status,/Unavailable/);
  context.contextItem=context.allTabs()[0];const success=$('close-tab').onclick();
  finish({ok:true});await success;
  context.setCatalog(entry,original);assert.equal(context.allTabs().length,1,'stale snapshots after acknowledgment stay hidden');
  context.setCatalog(entry,original.slice(1));assert.equal(entry.closingTabs.size,0,'fresh snapshots clear the close marker');
});

test('close resolves a provisional tab by its live pane, without closing a tab whose ID matches the pane ID',async()=>{
  const elements=new Map(),$=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',disabled:false,open:false});
    return elements.get(id);
  };
  const pane={pane_id:17,is_plugin:false,tab_position:0};
  const other={id:17,position:1,name:'Other',panes:[{pane_id:90,is_plugin:false}]};
  const provisional={id:17,position:0,name:'Connecting',pending:true,panes:[pane]};
  const entry={host:'win',name:'main',state:{panes:[pane]},catalog:[other],provisionalTabs:[provisional]};
  let finish;
  const calls=[],source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const context={$,sessions:new Map([['main',entry]]),hosts:new Map(),selected:null,tabOrder:[],filter:'all',groups:{},archived:{},ready:{},
    saveReady(){},localStorage:{setItem(){}},closeTabMenu(){context.contextItem=null;},render(){},
    activate(item){context.selected=item.key;},setStatus(message){context.status=message;},
    fetch:(url,options)=>{calls.push([url,JSON.parse(options.body)]);return new Promise(resolve=>finish=resolve);},AbortSignal};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function tabKey('),source.indexOf('function moveSelected(')),context);
  vm.runInContext(fs.readFileSync(__dirname+'/static/close.js','utf8'),context);
  context.selected=context.tabKey(entry,provisional);
  context.contextItem=context.allTabs().find(item=>item.tab.pending);
  const pending=$('close-tab').onclick();
  const provisionalKey=context.tabKey(entry,provisional),resolvedKey=JSON.stringify(['win','main','tab',42]);
  context.ready[provisionalKey]=1;context.archived[provisionalKey]=1;
  assert.deepEqual(calls,[['/api/hosts/win/close-tab',{session:'main',pane_id:17}]]);
  assert.deepEqual(Array.from(context.allTabs(),item=>item.tab.name),['Other'],'Pane IDs and tab IDs are separate identities');
  const resolved={id:42,position:0,name:'Resolved',panes:[pane]};
  context.setCatalog(entry,[resolved,other]);
  assert.deepEqual(Array.from(context.allTabs(),item=>item.tab.name),['Other'],'Resolving a tab ID cannot undo its pending close');
  assert.equal(context.ready[resolvedKey],1);
  finish({ok:true});await pending;
  assert.equal(context.ready[resolvedKey],undefined);assert.equal(context.archived[resolvedKey],undefined);
  context.setCatalog(entry,[resolved,other]);
  assert.equal(context.allTabs().length,1,'Stale catalogs cannot restore a confirmed close');
  context.setCatalog(entry,[other]);
  assert.equal(entry.closingTabs.size,0);

  entry.catalog=[];entry.provisionalTabs=[provisional];
  context.contextItem=context.allTabs()[0];
  const failure=$('close-tab').onclick();
  finish({ok:false,text:async()=>'Cannot identify target'});await failure;
  assert.equal(context.allTabs().length,1,'A failed close restores the provisional tab');
  assert.match(context.status,/Cannot identify target/);
  entry.state.panes=[];
  context.contextItem=context.allTabs()[0];
  await $('close-tab').onclick();
  assert.equal(calls.length,2,'A pane that is no longer live must not be submitted');
  assert.match(context.status,/still connecting/);
});

test('unavailable status does not disable menu Close or Ctrl+D for live provisional tabs',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage(),calls=[],errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path.endsWith('/close-tab')){calls.push(route.request().postDataJSON());return json({ok:true});}
      if(path==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
      if(path==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[{host:'windows',session:'main',message:'Session snapshots unavailable'}]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input><script>
        const panes=[{pane_id:17,is_plugin:false,tab_position:0,title:'First'},{pane_id:23,is_plugin:false,tab_position:1,title:'Second'}];
        let active=panes[0];
        function state(focus_id){parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes,tabs:[{position:0,name:'First'},{position:1,name:'Second'}],active_pane:active}},location.origin);}
        addEventListener('message',event=>{
          if(event.data.type==='zellij-focus'){active=panes.find(pane=>pane.pane_id===event.data.pane_id);document.querySelector('input').focus();state(event.data.focus_id);}
        });state();
      </script>`});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=windows&session=main&pane=17');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2&&[...document.querySelectorAll('#tabs .tab-select')].every(button=>button.dataset.agentState==='Status unavailable'));
    await page.locator('#tabs .tab-select').filter({hasText:'Second'}).click({button:'right'});
    assert.equal(await page.locator('#close-tab').isEnabled(),true);
    await page.locator('#close-tab').click();
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===1);
    assert.deepEqual(calls,[{session:'main',pane_id:23}]);
    await page.evaluate(()=>refreshAttention());
    assert.equal(await page.locator('#tabs .tab-select').count(),1,'A failed status poll must not bring the closed tab back');
    await page.locator('#tabs .tab-select').focus();
    await page.keyboard.press('Control+d');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===0);
    assert.deepEqual(calls,[{session:'main',pane_id:23},{session:'main',pane_id:17}]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('middle-click closes the clicked sidebar tab without selecting it, preserving guards and other mouse actions',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),calls=[],errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    const tabs=[['mac',41,7,'First'],['mac',42,8,'Second'],['mac',43,9,'Third'],['windows',90,10,'Remote']]
      .map(([host,id,pane_id,name],position)=>({host,id,name,session:'main',position,panes:[{pane_id,is_plugin:false,tab_position:position}]}));
    let fail=false;
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path.endsWith('/close-tab')){
        calls.push({host:path.split('/')[3],...route.request().postDataJSON()});
        return route.fulfill({status:fail?503:200,body:fail?'Fixture close failed':''});
      }
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(path.startsWith('/api/hosts/'))return json({id:path.split('/').at(-1),name:path.endsWith('/mac')?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/')){
        const panes=tabs.filter(tab=>tab.host===path.split('/')[2]).flatMap(tab=>tab.panes);
        return route.fulfill({contentType:'text/html',body:`<input id="terminal-input"><script>
          const panes=${JSON.stringify(panes)};let active=panes[0];
          window.focusRequests=[];
          function state(focus_id){parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes,active_pane:active}},location.origin);}
          addEventListener('message',event=>{
            if(event.data.type==='zellij-focus'){
              focusRequests.push(event.data.pane_id);active=panes.find(pane=>pane.pane_id===event.data.pane_id);
              document.querySelector('input').focus();state(event.data.focus_id);
            }
          });state();
        </script>`});
      }
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=41');
    const button=name=>page.locator('#tabs .tab-select').filter({hasText:name});
    const selected=()=>page.locator('#tabs .selected .tab-name').textContent();
    const input=page.frameLocator('iframe[title="Mac: main"]').locator('#terminal-input');
    const middle=async target=>{
      const response=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/close-tab'));
      await target.click({button:'middle'});await response;
    };
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===4&&document.activeElement===document.querySelector('iframe.active'));
    await button('Third').click();assert.equal(await selected(),'Third');
    await button('Second').click({button:'right'});
    assert.equal(await page.locator('#tab-menu').isVisible(),true);assert.equal(await selected(),'Third');
    assert.equal(calls.length,0);await page.keyboard.press('Escape');
    await button('First').click();
    await page.waitForFunction(()=>sessions.get(JSON.stringify(['mac','main']))?.state.active_pane.pane_id===7&&document.activeElement===document.querySelector('iframe.active'));
    await input.evaluate(()=>{focusRequests.length=0;});
    await middle(button('Remote').locator('.tab-name'));
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===3);
    assert.deepEqual(calls,[{host:'windows',session:'main',tab_id:90}]);
    assert.equal(await selected(),'First');assert.equal(await input.evaluate(input=>document.activeElement===input),true);
    assert.deepEqual(await input.evaluate(()=>focusRequests),[],'Closing a background tab must not switch the native terminal');

    fail=true;await middle(button('Second'));
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Fixture close failed'));
    assert.equal(await button('Second').count(),1);assert.equal(await selected(),'First');
    assert.deepEqual(calls[1],{host:'mac',session:'main',tab_id:42});
    fail=false;await middle(button('First'));
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='Second');
    assert.deepEqual(calls[2],{host:'mac',session:'main',tab_id:41});
    const third=page.locator('#tabs .tab-row').filter({hasText:'Third'});
    await third.hover();await middle(third.locator('.tab-actions'));
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===1);
    assert.deepEqual(calls[3],{host:'mac',session:'main',tab_id:43});assert.equal(await selected(),'Second');

    await page.evaluate(()=>{sessions.get(JSON.stringify(['mac','main'])).cached=true;});
    await button('Second').click({button:'middle'});
    assert.match(await page.locator('#status').textContent(),/still connecting/);
    assert.equal(calls.length,4);
    await page.evaluate(()=>{sessions.get(JSON.stringify(['mac','main'])).cached=false;});
    await page.locator('#settings').click();
    const guarded=await button('Second').evaluate(button=>{
      const event=new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1});button.dispatchEvent(event);return event.defaultPrevented;
    });
    assert.equal(guarded,true);assert.equal(calls.length,4);
    await page.locator('#close-panel').click();
    await button('Second').evaluate(button=>{
      dragging=true;button.dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1}));dragging=false;
      suppressTabClickUntil=Date.now()+1000;button.dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:1}));suppressTabClickUntil=0;
    });
    assert.equal(calls.length,4);assert.equal(await selected(),'Second');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
