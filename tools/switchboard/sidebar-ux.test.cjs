const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// All HTTP and terminal state is local fixture data; never attach to user sessions.
test('sidebar actions, selection tools, stable status updates, resizing and mobile navigation',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    let unavailable=false,working=true;
    const names=['switchboard','Online shopping','ssb orchestrator'];
    const tabs=names.map((name,i)=>({host:i===2?'windows':'mac',session:'main',id:i+1,position:i===2?0:i,name,panes:[{pane_id:i+1,is_plugin:false,tab_position:i===2?0:i}]}));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(path.startsWith('/api/hosts/'))return json({id:path.split('/').at(-1),name:path.endsWith('/mac')?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:working?[{host:'mac',session:'main',pane_id:1,state:'working'}]:[],errors:unavailable?[{host:'windows',session:'main'}]:[]});
      if(path.startsWith('/hosts/')){
        // The top machine's terminal answers last; the first tab must still be selected.
        if(path.split('/')[2]==='mac')await new Promise(resolve=>setTimeout(resolve,300));
        const panes=tabs.filter(t=>t.host===path.split('/')[2]).flatMap(t=>t.panes);
        return route.fulfill({contentType:'text/html',body:`<style>body{background:#0e1117;color:#d2dbeb;font:14px/1.7 monospace;padding:20px}input{margin-top:40px;background:#202633;color:inherit;border:1px solid #3d4b60;padding:14px;width:90%}</style><div id="terminal"><p>Switchboard terminal fixture</p><p>Working on the selected task…</p><input id="terminal-input" aria-label="Terminal input"></div><script>
          const panes=${JSON.stringify(panes)};let active=panes[0],selection='',selectionCallback;
          const input=document.querySelector('input');
          window.term={element:document.querySelector('#terminal'),textarea:input,options:{},getSelection:()=>selection,clearSelection(){selection='';selectionCallback?.()},
            _core:{_selectionService:{shouldForceSelection:()=>false}},onSelectionChange(fn){selectionCallback=fn;return{dispose(){}}},parser:{registerOscHandler(){return{dispose(){}}}}};
          window.ClipboardAddon={ClipboardAddon:class{}};
          window.__zjSupportsTabViewport=true;
          window.state=(focus_id)=>parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes,active_pane:active,tab_viewport:{is_owner:true}}},location.origin);
          addEventListener('message',event=>{if(event.data.type==='zellij-focus'){active=panes.find(p=>p.pane_id===event.data.pane_id);input.focus();state(event.data.focus_id)}});
          window.selectFixture=text=>{selection=text;selectionCallback?.()};
        </script><script src="/clipboard.js"></script><script>new ClipboardAddon.ClipboardAddon().activate(term);state();</script>`});
      }
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css','clipboard.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===3);
    const order=()=>page.locator('#tabs .tab-name').allTextContents();
    assert.deepEqual(await order(),names);
    assert.equal(await page.locator('#sidebar-summary').isVisible(),true);
    assert.equal(await page.locator('#tab-count').textContent(),'3 tabs');
    assert.equal(await page.locator('#selection-tools').isVisible(),false);
    assert.equal(await page.locator('#tabs small').first().textContent(),'Mac · Working');
    // xterm pauses drawing only when its element is off screen. Hidden sessions must be.
    const onScreen=title=>page.frameLocator(`iframe[title="${title}"]`).locator('body').evaluate(body=>new Promise(resolve=>
      new IntersectionObserver(([entry],observer)=>{observer.disconnect();resolve(entry.isIntersecting);}).observe(body)));
    await page.waitForSelector('iframe.active[title="Mac: main"]');
    assert.equal(await onScreen('Mac: main'),true);
    assert.equal(await onScreen('Windows: main'),false);
    const action=page.locator('.tab-actions').nth(1);
    await page.locator('.tab-row').nth(1).hover();await action.click();
    assert.match(await page.locator('#tab-menu-target').textContent(),/Online shopping · Mac · main/);
    await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-tab');
    await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),'ready');
    await page.keyboard.press('Escape');assert.equal(await action.evaluate(e=>document.activeElement===e),true);
    await action.click();await page.locator('#ready').click();
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'switchboard');
    assert.match(await page.locator('#tabs small').nth(1).textContent(),/For review/);
    assert.deepEqual(await order(),names);
    await action.click();await page.locator('#archive-tab').click();
    assert.deepEqual(await order(),['switchboard','ssb orchestrator']);
    await page.locator('#archive').click();await page.getByRole('button',{name:'Restore Online shopping',exact:true}).click();
    assert.deepEqual(await order(),names);
    // Copy toolbar works with the actual clipboard adapter, and Done clears it.
    await page.locator('.tab-row.active .tab-actions').click();await page.locator('#select-text').click();
    await page.waitForFunction(()=>!document.querySelector('#selection-tools').hidden);
    assert.equal(await page.locator('#copy').isDisabled(),true);
    const frame=page.frameLocator('iframe[title="Mac: main"]');
    await frame.locator('#terminal-input').evaluate(()=>selectFixture('selected output'));
    await page.waitForFunction(()=>!document.querySelector('#copy').disabled);
    await page.locator('#copy').click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'selected output');
    await page.locator('#exit-selection').click();assert.equal(await page.locator('#selection-tools').isVisible(),false);
    // Native/modifier selection reveals controls without entering selection mode.
    await frame.locator('#terminal-input').evaluate(()=>selectFixture('native selection'));
    await page.waitForFunction(()=>!document.querySelector('#selection-tools').hidden);
    await page.locator('#exit-selection').click();
    await frame.locator('#terminal-input').fill('keep typing');
    unavailable=true;working=false;await page.evaluate(()=>refreshAttention());
    assert.deepEqual(await order(),names);
    assert.equal(await frame.locator('#terminal-input').evaluate(e=>document.activeElement===e),true);
    assert.equal(await frame.locator('#terminal-input').inputValue(),'keep typing');
    assert.match(await page.locator('#tabs .tab-select').nth(2).getAttribute('aria-label'),/Status unavailable/);
    assert.equal(await page.locator('#tabs .star.unavailable').count(),1);
    await page.locator('#tab-search').fill('orchestrator');assert.equal(await page.locator('#tabs .tab-select').count(),1);
    await page.locator('#tab-search').fill('');assert.deepEqual(await order(),names);
    await page.locator('#sidebar-resize').focus();await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#sidebar-resize').getAttribute('aria-valuenow'),'222');
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/desktop.png'});
    await page.locator('#tabs .tab-select').nth(2).dragTo(page.locator('#tabs .tab-select').nth(0),{targetPosition:{x:20,y:5}});
    const reordered=['ssb orchestrator','switchboard','Online shopping'];
    assert.deepEqual(await order(),reordered);
    unavailable=false;await page.reload();await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===3);
    assert.equal(await page.locator('#sidebar-resize').getAttribute('aria-valuenow'),'222');
    assert.deepEqual(await order(),reordered);
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#sidebar').isVisible(),false);
    await page.locator('#sidebar-toggle').focus();await page.keyboard.press('Control+k');assert.equal(await page.locator('#sidebar').isVisible(),true);
    await page.locator('#sidebar-toggle').focus();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sidebar').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sidebar-toggle');
    await page.locator('#sidebar-toggle').click();
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/mobile.png'});
    // A background tab changing attention must never insert a summary row,
    // move scrolled tab rows, resize the terminal, or steal keyboard focus.
    for(let i=4;i<=30;i++)tabs.push({host:'mac',session:'main',id:i,position:i,name:`Fixture ${i}`,panes:[{pane_id:i,is_plugin:false,tab_position:i}]});
    await page.evaluate(()=>{for(const key of Object.keys(ready))delete ready[key];});
    await page.evaluate(()=>refreshAttention());
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.evaluate(()=>{document.body.classList.remove('sidebar-collapsed');document.body.classList.add('sidebar-open');});
      const target=page.locator('#tabs .tab-select').nth(5);
      await target.focus();
      await page.locator('#tabs').evaluate(el=>{el.scrollTop=180;});
      const snapshot=()=>page.evaluate(()=>{
        const rect=el=>{const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height];};
        return {bounds:['sidebar-summary','tabs','terminals','tab-count'].map(id=>rect(document.getElementById(id))),
          rows:[...document.querySelectorAll('.tab-row')].map(rect),scroll:document.querySelector('#tabs').scrollTop,
          selected:document.querySelector('.tab-select.selected')?.getAttribute('aria-label'),focus:document.activeElement?.outerHTML};
      });
      const before=await snapshot();assert.ok(before.scroll>0);
      for(const attention of [true,false]){
        await page.evaluate(value=>{const item=allTabs().at(-1);if(value)ready[item.key]=1;else delete ready[item.key];render();},attention);
        assert.equal(await page.locator('#notifications').isVisible(),attention);
        assert.deepEqual(await snapshot(),before,`attention ${attention}, width ${viewport.width}`);
      }
      // Check terminal focus separately: the sidebar focus assertion above also
      // catches DOM replacement of a tab button during a background update.
      const input=page.frameLocator('iframe[title="Mac: main"]').locator('#terminal-input');
      await input.focus();
      for(const attention of [true,false]){
        await page.evaluate(value=>{const item=allTabs().at(-1);if(value)ready[item.key]=1;else delete ready[item.key];render();},attention);
        assert.equal(await input.evaluate(el=>document.activeElement===el),true);
        assert.equal(await page.locator('iframe[title="Mac: main"]').evaluate(el=>document.activeElement===el),true);
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('sidebar empty states say why the list is empty and offer the fixing action',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    let releaseHosts,hostError=true,sessions=[{name:'main',web_clients_allowed:true}],tabs=[];
    const hostsReady=new Promise(resolve=>releaseHosts=resolve);
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/hosts'){await hostsReady;return json([{id:'mac',name:'Mac'}]);}
      if(path==='/api/hosts/mac')return hostError?route.fulfill({status:500,body:''}):json({id:'mac',name:'Mac',sessions});
      if(path==='/api/attention')return json({tabs,panes:[],errors:[]});
      if(path==='/api/logs')return json({computers:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input id="terminal-input"><script>
        const panes=[{pane_id:1,is_plugin:false,tab_position:0}];window.term={element:document.body,textarea:document.querySelector('input'),options:{}};
        parent.postMessage({type:'zellij-state',payload:{session_name:'main',panes,active_pane:panes[0],tab_viewport:{is_owner:true}}},location.origin);</script>`});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const empty=page.locator('#tab-empty');
    async function shows(text,action){
      await page.waitForFunction(text=>document.querySelector('#tab-empty-text').textContent===text&&!document.querySelector('#tab-empty').hidden,text);
      const action_=page.locator('#tab-empty-action');
      assert.equal(await action_.isVisible(),!!action);
      if(action)assert.equal(await action_.textContent(),action);
      return action_;
    }
    await page.goto('https://switchboard.test/');
    assert.equal(await empty.getAttribute('role'),'status');assert.equal(await empty.getAttribute('aria-live'),'polite');
    // Still loading: a subtle connecting line, no action.
    await shows('Connecting to your machines…');
    assert.equal(await page.locator('#empty-text').textContent(),'Connecting…');
    assert.equal(await page.locator('#empty-action').isHidden(),true);
    assert.equal(await empty.getAttribute('data-state'),'loading');
    // Every machine unreachable: point to Logs in the panel.
    releaseHosts();
    const viewLogs=await shows('Can’t reach your machines','View logs');
    // The main area stays quiet: no repeated explanation, just the same action, centred.
    assert.deepEqual(await page.evaluate(()=>{const text=document.querySelector('#empty-text').getBoundingClientRect(),main=document.querySelector('#terminals').getBoundingClientRect();
      return [document.querySelector('#empty-text').textContent,document.querySelector('#empty-action').textContent,Math.abs(text.left+text.width/2-(main.left+main.width/2))<1,getComputedStyle(document.querySelector('#empty')).fontSize];}),
      ['No terminal selected','View logs',true,'12px']);
    await viewLogs.click();
    await page.waitForFunction(()=>document.querySelector('#panel').open&&!document.querySelector('#panel-logs').hidden);
    await page.keyboard.press('Escape');
    // A tab arrives; the empty state goes away.
    hostError=false;tabs=[{host:'mac',session:'main',id:1,position:0,name:'build',panes:[{pane_id:1,is_plugin:false,tab_position:0}]}];
    await page.evaluate(async()=>{await refresh();await refreshAttention();});
    await page.waitForFunction(()=>document.querySelector('#tabs .tab-name')?.textContent==='build');
    assert.equal(await empty.isHidden(),true);
    const nameLeft=await page.locator('#tabs .tab-name').evaluate(e=>e.getBoundingClientRect().left);
    // Search hides everything: name the query and offer to clear it.
    await page.locator('#tab-search').fill('zzz');
    await (await shows('No tabs match “zzz”','Clear search')).click();
    assert.equal(await page.locator('#tab-search').inputValue(),'');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    await page.waitForFunction(()=>document.querySelector('#tabs .tab-name'));
    // A group filter hides everything: offer All.
    await page.locator('#filters [data-filter="work"]').click();
    const showAll=await shows('No tabs in Work','Show all');
    // Compact and aligned with the tab names, in the muted colour.
    assert.deepEqual(await page.evaluate(()=>{const text=document.querySelector('#tab-empty-text'),box=document.querySelector('#tab-empty');
      return {left:text.getBoundingClientRect().left,size:getComputedStyle(box).fontSize,color:getComputedStyle(box).color,height:box.getBoundingClientRect().height<80};}),
      {left:nameLeft,size:'12px',color:'rgb(155, 167, 189)',height:true});
    await showAll.click();
    await page.waitForFunction(()=>document.querySelector('#filters .selected').dataset.filter==='all'&&document.querySelector('#tabs .tab-name'));
    // The last tab closed and its session ended: offer a new tab.
    sessions=[];tabs=[];
    await page.evaluate(async()=>{await refresh();await refreshAttention();});
    await shows('No terminals yet','New tab');
    assert.equal(await page.locator('#empty-action').textContent(),'New tab');
    await page.locator('#empty-action').click();
    assert.equal(await page.locator('#new-tab-dialog').evaluate(d=>d.open),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('group URLs restore All, Home and Work on reload, including an empty group',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    const tabs=[{host:'mac',session:'main',id:42,position:0,name:'Home shell',panes:[{pane_id:7,is_plugin:false,tab_position:0}]},
      {host:'windows',session:'main',id:90,position:0,name:'Work shell',panes:[{pane_id:8,is_plugin:false,tab_position:0}]}];
    await context.addInitScript(()=>{
      window.setInterval=()=>0;
      if(!localStorage.getItem('switchboard-groups'))localStorage.setItem('switchboard-groups',JSON.stringify({mac:'home',windows:'work'}));
    });
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(path.startsWith('/api/hosts/'))return json({id:path.split('/').at(-1),sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/')){
        const pane=tabs.find(tab=>tab.host===path.split('/')[2]).panes[0];
        return route.fulfill({contentType:'text/html',body:`<input id="terminal-input"><script>
          const pane=${JSON.stringify(pane)},input=document.querySelector('input');
          window.term={element:document.body,textarea:input,options:{}};
          function state(focus_id){parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{is_owner:true}}},location.origin);}
          addEventListener('message',event=>{if(event.data.type==='zellij-focus'){input.focus();state(event.data.focus_id)}});state();
        </script>`});
      }
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    async function shows(group,names){
      await page.waitForFunction(()=>hostsLoaded&&!loading&&sessions.size===2&&[...sessions.values()].every(entry=>entry.state));
      await page.evaluate(()=>refreshAttention());
      await page.waitForFunction(([group,names])=>document.querySelector('#filters .selected').dataset.filter===group&&
        JSON.stringify([...document.querySelectorAll('#tabs .tab-name')].map(node=>node.textContent))===JSON.stringify(names),[group,names]);
    }
    await page.goto('https://switchboard.test/?kept=yes#notes');
    await shows('all',['Home shell','Work shell']);
    for(const [group,names,host] of [['home',['Home shell'],'mac'],['work',['Work shell'],'windows'],['all',['Home shell','Work shell'],'windows']]){
      await page.locator(`#filters [data-filter="${group}"]`).click();await shows(group,names);
      const selectedUrl=new URL(page.url());
      assert.equal(selectedUrl.searchParams.get('group'),group==='all'?null:group);
      assert.equal(selectedUrl.searchParams.get('host'),host);
      assert.equal(selectedUrl.searchParams.get('kept'),'yes');assert.equal(selectedUrl.hash,'#notes');
      await page.reload();await shows(group,names);
      assert.equal(page.url(),selectedUrl.href,'reload preserves the group and terminal URL');
    }
    // An empty group must survive reload without falling back to All.
    await page.evaluate(()=>{groups.mac='work';localStorage.setItem('switchboard-groups',JSON.stringify(groups));});
    await page.locator('#filters [data-filter="home"]').click();await shows('home',[]);
    await page.reload();await shows('home',[]);
    assert.equal(new URL(page.url()).searchParams.get('group'),'home');
    assert.equal(await page.locator('#tab-empty-text').textContent(),'No tabs in Home');
    // Unrecognised values use All; unrelated query parameters and fragments survive.
    await page.goto('https://switchboard.test/?group=invalid&kept=yes#notes');await shows('all',['Home shell','Work shell']);
    assert.equal(new URL(page.url()).searchParams.has('group'),false);
    assert.equal(new URL(page.url()).searchParams.get('kept'),'yes');assert.equal(new URL(page.url()).hash,'#notes');
    // A terminal link outside the requested group must not reset that group.
    await page.evaluate(()=>{groups.mac='home';localStorage.setItem('switchboard-groups',JSON.stringify(groups));});
    await page.goto('https://switchboard.test/?group=home&host=windows&session=main&tab=90');await shows('home',['Home shell']);
    assert.equal(new URL(page.url()).searchParams.get('group'),'home');
    assert.equal(new URL(page.url()).searchParams.get('host'),'mac');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('settings pages never paint white while they load',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  // The full browser paints mismatched color schemes like Chrome does; the headless shell does not.
  const browser=await chromium.launch({headless:true,channel:'chromium'}).catch(()=>chromium.launch({headless:true}));
  try{
    const page=await browser.newPage({viewport:{width:1200,height:760}});page.setDefaultTimeout(5000);
    let slow=false;
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[]});
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path==='/computers.html'){
        if(slow)await new Promise(resolve=>setTimeout(resolve,1500));
        return route.fulfill({contentType:'text/html',body:'<!doctype html><style>:root{color-scheme:dark;background:#141414}</style><h2>Computers</h2>'});
      }
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.click('#settings');await page.click('#panel-tab-computers');
    await page.frameLocator('#computers-frame').locator('h2').waitFor();
    // Closing resets the page to a blank document; reopening loads it again.
    await page.keyboard.press('Escape');slow=true;
    await page.click('#settings');await page.click('#panel-tab-computers');
    const probe=await browser.newPage();let worst=0;
    for(let i=0;i<5;i++){
      await new Promise(resolve=>setTimeout(resolve,150));
      const shot=(await page.screenshot({clip:{x:240,y:100,width:900,height:600}})).toString('base64');
      worst=Math.max(worst,await probe.evaluate(async data=>{
        const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
        const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        const context=canvas.getContext('2d');context.drawImage(image,0,0);
        const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let white=0;
        for(let i=0;i<pixels.length;i+=4)if(pixels[i]>235&&pixels[i+1]>235&&pixels[i+2]>235)white++;
        return white/(pixels.length/4);
      },shot));
    }
    assert.ok(worst<0.01,`${(worst*100).toFixed(1)}% of the settings page painted white while loading`);
  }finally{await browser.close();}
});
