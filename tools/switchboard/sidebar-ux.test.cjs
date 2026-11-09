const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

test('tab hover only expands clipped titles; context and shortcuts stay in the click menu',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:760}}),errors=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    let name='Polish the sidebar';
    const tab=()=>({host:'mac',session:'main',id:1,position:0,name,panes:[{pane_id:1,is_plugin:false,tab_position:0}]});
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/attention'&&url.searchParams.has('after'))return;
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs:[tab()],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<style>body{background:#111318;color:#a3aec0;font:14px monospace;padding:24px}</style><p>~/projects/switchboard</p><p>Ready for your next step.</p><script>const pane={pane_id:1,is_plugin:false,tab_position:0};parent.postMessage({type:'zellij-state',payload:{session_name:'main',panes:[pane],active_pane:pane}},location.origin);</script>`});
      const file=path==='/'?'index.html':path.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file)});
    });
    await page.goto('https://switchboard.test/');
    const button=page.locator('.tab-select');
    await button.waitFor();await button.hover();
    assert.equal(await button.getAttribute('title'),null);
    assert.equal(await page.locator('#tabs').getAttribute('title'),null);
    await page.waitForFunction(()=>document.querySelector('#build-version').textContent.includes('abc123def'));
    assert.equal(await page.locator('#settings').getAttribute('title'),'Settings');
    for(const control of [page.getByRole('button',{name:'Settings',exact:true}),page.getByRole('link',{name:'Messages',exact:true})]){
      assert.equal(await control.innerText(),'');
      assert.equal(await control.locator('svg[aria-hidden="true"]').count(),1);
    }
    assert.match(await page.locator('#build-version').getAttribute('title'),/Commit abc123def/);
    name='Review terminal reconnection behavior';await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(title=>document.querySelector('.tab-select').title===title,name);
    await button.focus();assert.match(await button.getAttribute('aria-label'),/Review terminal reconnection behavior, Mac, main/);
    await page.evaluate(()=>setSidebarWidth(420));
    await page.waitForFunction(()=>!document.querySelector('.tab-select').hasAttribute('title'));
    await page.evaluate(()=>setSidebarWidth(180));
    await page.waitForFunction(title=>document.querySelector('.tab-select').title===title,name);
    const proof=process.env.SWITCHBOARD_HOVER_SCREENSHOTS;
    if(proof)await page.screenshot({path:proof+'/sidebar.png'});
    await button.press('Shift+F10');
    assert.equal(await page.locator('#tab-menu-target').textContent(),name);
    assert.equal(await page.locator('#tab-menu-target').getAttribute('title'),null);
    assert.match(await page.locator('#tab-menu-details').textContent(),/Mac · main · No pending attention/);
    assert.match(await page.locator('#tab-menu-help').textContent(),/Alt\+Shift\+H\/L to reorder/);
    assert.match(await page.locator('#tab-menu-help').textContent(),/Middle-click to close/);
    if(proof)await page.screenshot({path:proof+'/menu.png'});
    await page.keyboard.press('Escape');
    name='Short';await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>document.querySelector('.tab-name').textContent==='Short'&&!document.querySelector('.tab-select').hasAttribute('title'));
    await page.setViewportSize({width:390,height:740});
    await page.locator('#sidebar-toggle').click();await button.click({button:'right'});
    const bounds=await page.locator('#tab-menu').boundingBox();
    assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y+bounds.height<=740);
    if(proof)await page.screenshot({path:proof+'/mobile-menu.png'});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('touch screens open the tab menu with a long press',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:390,height:740},isMobile:true,hasTouch:true});
    const page=await context.newPage(),errors=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    const tabs=['Polish the sidebar','Online shopping research'].map((name,i)=>
      ({host:'mac',session:'main',id:i+1,position:i,name,panes:[{pane_id:i+1,is_plugin:false,tab_position:i}]}));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/attention'&&url.searchParams.has('after'))return;
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<script>const panes=${JSON.stringify(tabs.flatMap(t=>t.panes))};parent.postMessage({type:'zellij-state',payload:{session_name:'main',panes,active_pane:panes[0]}},location.origin);</script>`});
      const file=path==='/'?'index.html':path.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file)});
    });
    await page.goto('https://switchboard.test/');
    await page.locator('.tab-row.active').waitFor({state:'attached'});
    await page.locator('#sidebar-toggle').tap();
    const other=page.locator('.tab-row:not(.active) .tab-select'),menu=page.locator('#tab-menu');
    const selectedName=()=>page.locator('#tabs .selected .tab-name').textContent();
    assert.equal(await page.locator('.tab-actions').count(),0,'rows have no menu button');
    assert.equal(await other.locator('.tab-name').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    const cdp=await context.newCDPSession(page),box=await other.boundingBox();
    const at=(dx=0)=>[{x:box.x+box.width/2+dx,y:box.y+box.height/2}];
    const touch=(type,points)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points});
    // Holding a row opens its menu without selecting it, and lifting the finger leaves the menu open.
    await touch('touchStart',at());await page.waitForTimeout(650);
    assert.equal(await menu.isVisible(),true);
    assert.equal(await page.locator('#tab-menu-target').textContent(),'Online shopping research');
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/long-press.png'});
    await touch('touchEnd',[]);await page.waitForTimeout(100);
    assert.equal(await menu.isVisible(),true);assert.equal(await selectedName(),'Polish the sidebar');
    await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);
    // A finger that moves first is scrolling or dragging, not asking for the menu.
    await touch('touchStart',at());await touch('touchMove',at(30));await page.waitForTimeout(650);
    await touch('touchEnd',[]);assert.equal(await menu.isVisible(),false);
    // A tap right after a hold, which also dismisses the menu, still selects the tab.
    await touch('touchStart',at());await page.waitForTimeout(650);await touch('touchEnd',[]);
    assert.equal(await menu.isVisible(),true);
    await other.tap({position:{x:10,y:10}});await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent.startsWith('Online'));
    assert.equal(await menu.isVisible(),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// All HTTP and terminal state is local fixture data; never attach to user sessions.
test('sidebar actions, selection tools, stable status updates, resizing and mobile navigation',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:900},timezoneId:'Australia/Sydney',permissions:['clipboard-read','clipboard-write']});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);
    await page.clock.setFixedTime(new Date('2026-10-27T23:59:00+11:00'));
    page.on('pageerror',e=>errors.push(e.message));
    let unavailable=false,working=true,hostUnavailable=false;
    const names=['switchboard','Online shopping','ssb orchestrator'];
    const tabs=names.map((name,i)=>({host:i===2?'windows':'mac',session:'main',id:i+1,position:i===2?0:i,name,panes:[{pane_id:i+1,is_plugin:false,tab_position:i===2?0:i}]}));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      // This test drives attention changes explicitly. Keep the background watch
      // pending so its retry cannot render away a notification during dismissal.
      if(path==='/api/attention'&&url.searchParams.has('after'))return;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(path.startsWith('/api/hosts/'))return json({id:path.split('/').at(-1),name:path.endsWith('/mac')?'Mac':'Windows',
        ...(hostUnavailable&&path.endsWith('/windows')?{error:'Host unavailable'}:{sessions:[{name:'main',web_clients_allowed:true}]})});
      if(path==='/api/attention')return json({tabs,panes:working?[{host:'mac',session:'main',pane_id:1,state:'working'}]:[],errors:unavailable?[{host:'windows',session:'main'}]:[]});
      if(path.startsWith('/hosts/')){
        // The top machine's terminal answers last; the first tab must still be selected.
        if(path.split('/')[2]==='mac')await new Promise(resolve=>setTimeout(resolve,300));
        const panes=tabs.filter(t=>t.host===path.split('/')[2]).flatMap(t=>t.panes);
        return route.fulfill({contentType:'text/html',body:`<style>body{background:#0e1117;color:#d2dbeb;font:14px/1.7 monospace;padding:20px}input{margin-top:40px;background:#202633;color:inherit;border:1px solid #3d4b60;padding:14px;width:90%}</style><div id="terminal"><p>Switchboard terminal fixture</p><p>Working on the selected task…</p><input id="terminal-input" aria-label="Terminal input"></div><script>
          const panes=${JSON.stringify(panes)};let active=panes[0],selection='',selectionCallback;
          const input=document.querySelector('input');
          addEventListener('focus',()=>input.focus());
          window.term={element:document.querySelector('#terminal'),textarea:input,options:{},getSelection:()=>selection,clearSelection(){selection='';selectionCallback?.()},
            _core:{_selectionService:{shouldForceSelection:()=>false}},onSelectionChange(fn){selectionCallback=fn;return{dispose(){}}},parser:{registerOscHandler(){return{dispose(){}}}}};
          window.ClipboardAddon={ClipboardAddon:class{}};
          window.__zjSupportsTabViewport=true;
          window.state=(focus_id)=>parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes,active_pane:active,tab_viewport:{is_owner:true}}},location.origin);
          addEventListener('message',event=>{if(event.data.type==='zellij-focus'){active=panes.find(p=>p.pane_id===event.data.pane_id);window.lastFocusId=event.data.focus_id;input.focus();state(event.data.focus_id)}});
          window.selectFixture=text=>{selection=text;selectionCallback?.()};
        </script><script src="/clipboard.js"></script><script>new ClipboardAddon.ClipboardAddon().activate(term);state();</script>`});
      }
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css','clipboard.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2&&document.querySelector('#snoozed-toggle'));
    const order=()=>page.locator('#tabs .tab-name').allTextContents();
    const snoozed=page.locator('#snoozed-toggle');
    assert.deepEqual(await order(),names.slice(1));
    assert.equal(await snoozed.getAttribute('aria-expanded'),'false');
    assert.equal(await snoozed.locator('.count').textContent(),'1');
    assert.equal(await snoozed.getAttribute('title'),null,'the Working header has no tooltip');
    async function pinProof(name,target,label){
      if(!process.env.SWITCHBOARD_PIN_SCREENSHOTS)return;
      await target.evaluate(el=>el.style.outline='2px solid #ef4444');
      await page.evaluate(text=>{
        const note=document.createElement('div');note.id='pin-proof-note';note.textContent=text;
        note.style.cssText='position:absolute;top:360px;left:12px;width:210px;color:#ef4444;font:600 14px sans-serif;z-index:9999';
        document.querySelector('#sidebar').append(note);
      },label);
      await page.locator('#sidebar').screenshot({path:process.env.SWITCHBOARD_PIN_SCREENSHOTS+'/'+name+'.png'});
      await target.evaluate(el=>el.style.outline='');
      await page.locator('#pin-proof-note').evaluate(el=>el.remove());
    }
    // Keep a different tab selected: selected snoozed tabs intentionally stay visible.
    await page.locator('#tabs .tab-select').filter({has:page.locator('.tab-name',{hasText:'Online shopping'})}).click();
    await page.waitForFunction(()=>{const item=allTabs().find(item=>item.key===selected);return item?.tab.name==='Online shopping'&&activeTab(item.entry)?.id===item.tab.id&&!item.entry.needsFocus&&!item.entry.requestedPane&&!item.entry.focusPending;});
    await pinProof('before',snoozed,'Working tab moves to Snoozed');
    await snoozed.click();
    const workingTab=page.locator('#tabs .tab-select').filter({has:page.locator('.tab-name', {hasText:'switchboard'})});
    await workingTab.click({button:'right'});
    assert.equal(await page.locator('#pin-tab').textContent(),'Pin');
    await page.locator('#pin-tab').click();
    assert.deepEqual(await order(),names);
    assert.equal(await snoozed.count(),0);
    assert.ok(await page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('switchboard-pinned'))).length===1));
    assert.match(await workingTab.locator('.tab-where').textContent(),/Pinned/);
    assert.deepEqual(await workingTab.locator('.star.working').evaluate(el=>{const s=getComputedStyle(el);return [s.borderTopStyle,s.animationName]}),['dashed','none'],'The working ring is dashed and stays still');
    await pinProof('after',workingTab,'Pinned tab stays here while working');
    await workingTab.click({button:'right'});
    assert.equal(await page.locator('#pin-tab').textContent(),'Unpin');
    await page.locator('#pin-tab').click();
    assert.equal(await snoozed.count(),1);
    await snoozed.click();
    assert.deepEqual(await order(),names.slice(1));
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.locator('#sidebar').screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/snoozed.png'});
    const groupBounds=()=>page.evaluate(()=>[$('tabs'),$('snoozed-toggle'),$('hidden-toggle')].map(el=>el?.getBoundingClientRect().toJSON()));
    let [tabList,snoozedGroup]=await groupBounds();
    assert.ok(Math.abs(tabList.bottom-6-snoozedGroup.bottom)<1,'Snoozed sits at the bottom of a short list');
    await page.evaluate(()=>{setHidden(allTabs().find(item=>item.tab.name==='ssb orchestrator'),true);render();});
    let hiddenGroup;
    [tabList,snoozedGroup,hiddenGroup]=await groupBounds();
    assert.ok(Math.abs(tabList.bottom-6-hiddenGroup.bottom)<1,'Hidden stays at the bottom');
    assert.ok(Math.abs(hiddenGroup.top-snoozedGroup.bottom-3)<1,'Snoozed sits directly above Hidden');
    // With overflow, both headers remain visible without covering one another.
    await page.locator('#tabs .tab-row').evaluate(row=>row.style.minHeight='1000px');
    await page.evaluate(()=>{$('tabs').scrollTop=0;});
    [tabList,snoozedGroup,hiddenGroup]=await groupBounds();
    assert.ok(snoozedGroup.top>=tabList.top&&Math.abs(hiddenGroup.bottom-tabList.bottom)<1,'Both headers pin within the scrolling list');
    assert.ok(Math.abs(hiddenGroup.top-snoozedGroup.bottom-3)<1,'Pinned headers do not overlap');
    await page.locator('#tabs .tab-row').evaluate(row=>row.style.minHeight='');
    await page.evaluate(()=>{setHidden(allTabs().find(item=>item.hidden),false);render();});
    await page.evaluate(()=>openPanel('settings'));
    const moveWorking=page.locator('#move-working-to-snoozed');
    assert.equal(await moveWorking.getAttribute('aria-pressed'),'true');
    await moveWorking.click();
    assert.equal(await snoozed.count(),0);
    assert.deepEqual(await order(),names);
    await moveWorking.click();
    await page.evaluate(()=>activate(allTabs()[0]));
    assert.deepEqual(await order(),[...names.slice(1),names[0]]);
    await page.locator('#close-panel').click();
    assert.equal(await page.locator('#tab-count').textContent(),'3 tabs');
    await snoozed.click();
    assert.deepEqual(await order(),[...names.slice(1),names[0]]);
    assert.equal(await page.locator('#tabs .tab-status').last().textContent(),'Working');
    // A tab waiting on a background agent folds in with working tabs and keeps its own dot.
    const waitingKey=await page.evaluate(()=>{
      const key=attentionKey('mac','main',2);
      paneAttention.set(key,{...paneAttention.get(attentionKey('mac','main',1)),pane_id:2,key,state:'waiting'});render();
      return allTabs().find(item=>item.tab.name==='Online shopping').key;
    });
    assert.equal(await snoozed.locator('.count').textContent(),'2');
    const waitingTab=page.locator('#tabs .tab-select').filter({has:page.locator('.tab-name',{hasText:'Online shopping'})});
    assert.equal(await waitingTab.locator('.star').getAttribute('class'),'star waiting');
    assert.equal(await waitingTab.locator('.tab-status').textContent(),'Waiting');
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.locator('#sidebar').screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/waiting-folded.png'});
    await page.evaluate(key=>{paneAttention.delete(attentionKey('mac','main',2));snoozedPlacement.delete(key);render();},waitingKey);
    assert.deepEqual(await order(),[...names.slice(1),names[0]]);
    // Collapsing the section never stops or switches the selected terminal.
    await page.locator('#tabs .tab-select').last().click();
    const selectedBefore=await page.evaluate(()=>selected);
    await snoozed.click();
    assert.equal(await page.evaluate(()=>selected),selectedBefore);
    assert.deepEqual(await order(),[...names.slice(1),names[0]]);
    await page.evaluate(()=>stepTab(1));
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),names[1]);
    await page.evaluate(()=>{activate(allTabs()[0]);stepTab(-1);});
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),names[2]);
    await page.evaluate(()=>activate(allTabs()[0]));
    assert.equal(await page.evaluate(()=>localStorage.getItem('switchboard-snoozed-open:all')),'false');
    // activate() posts focus asynchronously. Let the fixture acknowledge that
    // request before fill(), otherwise its late input.focus() steals the search.
    await page.waitForFunction(()=>{
      const entry=allTabs().find(item=>item.key===selected)?.entry;
      return entry&&entry.frame.contentWindow.lastFocusId===entry.focusId&&document.activeElement===entry.frame;
    });
    await page.locator('#tab-search').fill('switchboard');
    assert.deepEqual(await order(),[names[0]]);
    assert.equal(await snoozed.getAttribute('aria-expanded'),'true');
    await page.locator('#tab-search').fill('');
    assert.deepEqual(await order(),[...names.slice(1),names[0]]);
    // Enter opens the first displayed search result, ahead of matching snoozed tabs.
    await page.locator('#tab-search').fill('Mac');
    assert.deepEqual(await order(),[names[1],names[0]]);
    await page.locator('#tab-search').press('Enter');
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),names[1]);
    // Enter hands focus to the terminal asynchronously. Finish that handoff before
    // filling search again, or the pane acknowledgement can steal the Delete key.
    await page.waitForFunction(()=>{const entry=allTabs().find(item=>item.key===selected)?.entry;return entry&&!entry.requestedPane&&!entry.focusPending&&document.activeElement===entry.frame;});
    await page.locator('#tab-search').fill('');
    assert.equal(await page.locator('#tab-search').inputValue(),'');
    await page.evaluate(()=>activate(allTabs()[0]));
    // Attention and status failures take precedence over automatic snoozing.
    for(const state of ['ready','approval','input']){
      await page.evaluate(state=>{Object.assign(paneAttention.get(attentionKey('mac','main',1)),{state,token:'new-review',seen:false});render();},state);
      assert.equal(await snoozed.count(),0);
      assert.deepEqual(await order(),names);
    }
    await page.evaluate(()=>{paneAttention.get(attentionKey('mac','main',1)).state='working';attentionErrors=[{host:'mac',session:'main'}];render();});
    assert.equal(await snoozed.count(),0);
    await page.evaluate(()=>{attentionErrors=[];setHidden(allTabs()[0],true);render();});
    assert.equal(await snoozed.count(),0);
    assert.equal(await page.locator('#hidden-toggle .count').textContent(),'1');
    await page.evaluate(()=>{setHidden(allTabs().find(item=>item.hidden),false);render();});
    assert.equal(await snoozed.count(),1);
    working=false;await page.evaluate(()=>refreshAttention());
    assert.equal(await snoozed.count(),1);
    await page.clock.setFixedTime(new Date('2026-10-27T23:59:03+11:00'));
    await page.evaluate(()=>render());
    await page.waitForFunction(()=>!document.querySelector('#snoozed-toggle'));
    assert.deepEqual(await order(),names);
    assert.equal(await page.locator('#sidebar-summary').isVisible(),true);
    assert.equal(await page.locator('#selection-tools').isVisible(),false);
    // xterm pauses drawing only when its element is off screen. Hidden sessions must be.
    const onScreen=title=>page.frameLocator(`iframe[title="${title}"]`).locator('body').evaluate(body=>new Promise(resolve=>
      new IntersectionObserver(([entry],observer)=>{observer.disconnect();resolve(entry.isIntersecting);}).observe(body)));
    await page.waitForSelector('iframe.active[title="Mac: main"]');
    assert.equal(await onScreen('Mac: main'),true);
    assert.equal(await onScreen('Windows: main'),false);
    // A tab opened with Run as administrator carries a shield.
    tabs[1].name='Administrator';await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select')[1]?.classList.contains('elevated'));
    assert.equal(await page.locator('#tabs .elevated').count(),1);
    assert.equal(await page.locator('#tabs .elevated .tab-name').evaluate(e=>getComputedStyle(e,'::before').content),'"\u{1F6E1}️"');
    // A tab an agent opened for its own checks is hidden, labelled, and never asks for attention,
    // even when flagged for review.
    tabs[1].name='* System';await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>allTabs(true).some(item=>item.tab.name==='* System'&&item.hidden));
    assert.equal(await page.evaluate(()=>allTabs(true).filter(item=>item.tab.name==='* System').map(isReady).join()),'false');
    assert.equal(await page.locator('#notifications').isVisible(),false);
    await page.evaluate(()=>{hiddenOpen=true;render();});
    assert.equal(await page.locator('#tabs .tab-select.system .tab-name').evaluate(e=>getComputedStyle(e,'::before').content),'"SYSTEM"');
    await page.evaluate(()=>{hiddenOpen=false;render();});
    tabs[1].name=names[1];await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>!document.querySelector('#tabs .elevated')&&!allTabs(true).some(item=>item.hidden));
    const action=page.locator('.tab-select').nth(1),openMenu=()=>action.click({button:'right'});
    await openMenu();
    assert.equal(await page.locator('#tab-menu-target').textContent(),'Online shopping');
    assert.match(await page.locator('#tab-menu-details').textContent(),/Mac · main/);
    assert.match(await page.locator('#hide-tab').textContent(),/^Hide/);
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/tab-menu.png'});
    await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-tab');
    await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>document.activeElement.id),'settle-tab');
    await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>document.activeElement.id),'snooze-tab');
    await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>document.activeElement.id),'hide-tab');
    await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>document.activeElement.id),'pin-tab');
    await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>document.activeElement.id),'select-text');
    await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),'ready');
    await page.keyboard.press('Escape');assert.equal(await action.evaluate(e=>document.activeElement===e),true);
    await openMenu();await page.locator('#copy-title').click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'Online shopping');
    assert.equal(await page.locator('#tab-menu').isVisible(),false);
    assert.equal(await action.evaluate(e=>document.activeElement===e),true);
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'switchboard');
    await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{
      throw new DOMException('Write permission denied.','NotAllowedError');
    }}));
    await openMenu();await page.locator('#copy-title').click();
    assert.match(await page.locator('#status').textContent(),/Could not copy the tab title: Write permission denied/);
    await page.evaluate(()=>delete navigator.clipboard.writeText);
    await openMenu();await page.locator('#ready').click();
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'switchboard');
    assert.equal(await page.locator('#tabs .tab-status').nth(1).textContent(),'Review');
    assert.deepEqual(await order(),names);
    // Hide moves the tab into the collapsed Hidden group at the bottom; it still needs review.
    const toggle=page.locator('#hidden-toggle');
    assert.equal(await toggle.count(),0,'no Hidden group until a tab is hidden');
    await openMenu();await page.locator('#hide-tab').click();
    assert.deepEqual(await order(),['switchboard','ssb orchestrator']);
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.equal(await toggle.locator('.count').textContent(),'1');
    assert.equal(await toggle.locator('.star').isVisible(),true,'a hidden tab that needs you marks the group');
    assert.match(await page.locator('#tab-count').textContent(),/^2 tabs/);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('switchboard-hidden'))[JSON.stringify(['mac','main','tab',2])]),1);
    // Search finds it while the group is collapsed.
    await page.locator('#tab-search').fill('shopping');
    assert.deepEqual(await order(),['Online shopping']);
    await page.locator('#tab-search').fill('');
    assert.deepEqual(await order(),['switchboard','ssb orchestrator']);
    await toggle.click();
    assert.deepEqual(await order(),['switchboard','ssb orchestrator','Online shopping']);
    assert.equal(await page.evaluate(()=>localStorage.getItem('switchboard-hidden-open:all')),'true');
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.locator('#sidebar').screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/hidden.png'});
    const hiddenRow=page.locator('.tab-row.hidden-tab');
    assert.equal(await toggle.getAttribute('title'),null,'the Hidden header has no tooltip');
    assert.equal(await hiddenRow.locator('.tab-select').evaluate(el=>getComputedStyle(el).opacity),'1','hidden rows are not dimmed, like Working rows');
    // Like Working, collapsing keeps the selected tab listed.
    await hiddenRow.locator('.tab-select').click();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
    assert.deepEqual(await order(),['switchboard','ssb orchestrator','Online shopping'],'the selected hidden tab stays listed');
    await page.locator('#tabs .tab-select').filter({has:page.locator('.tab-name',{hasText:'switchboard'})}).click();
    assert.deepEqual(await order(),['switchboard','ssb orchestrator'],'it folds away once another tab is selected');
    await toggle.click();
    await hiddenRow.locator('.tab-select').click({button:'right'});
    assert.match(await page.locator('#hide-tab').textContent(),/^Show in list/);
    await page.locator('#hide-tab').click();
    assert.deepEqual(await order(),names);
    assert.equal(await toggle.count(),0);
    // Copy toolbar works with the actual clipboard adapter, and Done clears it.
    await page.locator('.tab-row.active .tab-select').click({button:'right'});await page.locator('#select-text').click();
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
    // Daily dismissal survives recovery and reloads without hiding other errors.
    hostUnavailable=true;await page.evaluate(()=>refresh());
    const status=page.locator('#status'),dismiss=page.locator('#dismiss-status');
    assert.equal(await status.isVisible(),true);
    assert.match(await status.textContent(),/Windows: Host unavailable/);
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Windows: attention status unavailable'),null,{timeout:10000});
    if(process.env.SWITCHBOARD_DISMISS_SCREENSHOTS){
      await page.screenshot({path:process.env.SWITCHBOARD_DISMISS_SCREENSHOTS+'/warning.png'});
      fs.writeFileSync(process.env.SWITCHBOARD_DISMISS_SCREENSHOTS+'/warning.json',JSON.stringify({
        status:await status.boundingBox(),button:await dismiss.boundingBox(),viewport:page.viewportSize()
      }));
    }
    await dismiss.click();assert.equal(await status.isHidden(),true);
    assert.equal(await frame.locator('#terminal-input').evaluate(e=>document.activeElement===e),true);
    assert.equal(await page.locator('iframe.active').evaluate(e=>document.activeElement===e),true);
    await page.keyboard.type(' after dismiss');
    assert.equal(await frame.locator('#terminal-input').inputValue(),'keep typing after dismiss');
    await page.evaluate(async()=>{await refresh();await refreshAttention();});
    assert.equal(await status.isHidden(),true);
    assert.equal(await page.locator('#tabs .star.unavailable').count(),1);
    unavailable=false;await page.evaluate(()=>refreshAttention());
    assert.equal(await status.isHidden(),true);
    unavailable=true;await page.evaluate(()=>refreshAttention());
    assert.equal(await status.isHidden(),true,'A dismissed computer stays quiet when its attention warning returns');
    await page.evaluate(()=>setStatus('Fixture new error',true));
    assert.equal(await status.isVisible(),true);assert.match(await status.textContent(),/Fixture new error/);
    assert.doesNotMatch(await status.textContent(),/Host unavailable/);
    await dismiss.click();await page.evaluate(()=>render());
    assert.equal(await status.isHidden(),true);
    hostUnavailable=false;await page.evaluate(()=>refresh());
    hostUnavailable=true;await page.evaluate(()=>refresh());
    assert.equal(await status.isHidden(),true,'A brief recovery does not reset daily dismissal');
    await page.reload();await page.waitForFunction(()=>hosts.get('windows')?.error&&attentionErrors.length&&sessions.get(JSON.stringify(['mac','main']))?.state);
    assert.equal(await status.isHidden(),true,'Daily dismissal survives a page reload');
    await page.evaluate(()=>{hosts.get('mac').error='Host unavailable';render();});
    assert.equal(await status.isVisible(),true,'Dismissal does not hide another computer');
    assert.match(await status.textContent(),/Mac: Host unavailable/);
    assert.doesNotMatch(await status.textContent(),/Windows:/);
    await page.evaluate(()=>{delete hosts.get('mac').error;render();});
    await page.evaluate(()=>{hosts.get('windows').error='Connection timed out';render();});
    assert.equal(await status.isHidden(),true,'Dismissal follows the computer, not the error text');
    hostUnavailable=false;unavailable=false;await page.evaluate(async()=>{await refresh();await refreshAttention();});
    const windows=page.frameLocator('iframe[title="Windows: main"]').locator('#terminal-input');
    await windows.evaluate(()=>parent.postMessage({type:'zellij-disconnected'},location.origin));
    await page.waitForFunction(()=>sessions.get(JSON.stringify(['windows','main']))?.disconnected);
    assert.equal(await status.isHidden(),true,'A dismissed background terminal does not interrupt');
    await windows.evaluate(()=>state());
    await page.waitForFunction(()=>!sessions.get(JSON.stringify(['windows','main']))?.disconnected);
    await page.locator('#tabs .tab-select').nth(2).click();
    await page.waitForFunction(()=>{
      const entry=sessions.get(JSON.stringify(['windows','main']));
      return document.activeElement===entry.frame&&entry.frame.contentDocument.activeElement?.id==='terminal-input';
    });
    await windows.evaluate(()=>parent.postMessage({type:'zellij-disconnected'},location.origin));
    await page.waitForFunction(()=>document.querySelector('#status').classList.contains('has-error'));
    assert.match(await status.textContent(),/Windows: reconnecting/);
    assert.equal(await dismiss.getAttribute('aria-label'),'Dismiss notification');
    await page.evaluate(()=>render());assert.equal(await status.isVisible(),true,'An active disconnect stays visible through refreshes');
    await windows.evaluate(()=>state());
    await page.waitForFunction(()=>!sessions.get(JSON.stringify(['windows','main']))?.disconnected);
    await page.locator('#tabs .tab-select').first().click();
    assert.equal(await status.isHidden(),true,'Reconnection does not clear daily dismissal');
    hostUnavailable=true;unavailable=true;await page.evaluate(async()=>{await refresh();await refreshAttention();});
    await page.clock.setFixedTime(new Date('2026-10-28T00:01:00+11:00'));
    await page.evaluate(()=>refreshAttention());
    assert.equal(await status.isVisible(),true,'Dismissal expires at the viewer’s local midnight');
    assert.equal(await dismiss.textContent(),'Dismiss for today');
    await dismiss.focus();await page.keyboard.press('Enter');
    assert.equal(await status.isHidden(),true);
    await page.locator('#tab-search').fill('orchestrator');assert.equal(await page.locator('#tabs .tab-select').count(),1);
    await page.locator('#tab-search').fill('');assert.deepEqual(await order(),names);
    await page.locator('#sidebar-resize').focus();await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#sidebar-resize').getAttribute('aria-valuenow'),'222');
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/desktop.png'});
    await page.locator('#tabs .tab-select').nth(2).dragTo(page.locator('#tabs .tab-select').nth(0),{targetPosition:{x:20,y:5}});
    const reordered=['ssb orchestrator','switchboard','Online shopping'];
    assert.deepEqual(await order(),reordered);
    unavailable=false;hostUnavailable=false;await page.reload();await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===3);
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentDocument?.activeElement?.id==='terminal-input');
    assert.equal(await page.locator('#sidebar-resize').getAttribute('aria-valuenow'),'222');
    assert.deepEqual(await order(),reordered);
    // Dragging below the Hidden header hides a tab; dragging above it shows one again.
    const hiddenNames=()=>page.locator('#tabs .hidden-tab .tab-name').allTextContents();
    const tabNamed=name=>page.locator('#tabs .tab-select',{hasText:name});
    await page.evaluate(()=>{setHidden(allTabs().find(item=>tabTitle(item)==='Online shopping'),true);render();});
    assert.equal(await page.locator('#hidden-toggle').getAttribute('aria-expanded'),'true','the group stays as it was left');
    // A short list keeps the Hidden group at the bottom of the sidebar, not under the last tab.
    const [shortList,lastTab,group]=await page.evaluate(()=>[$('tabs'),$('hidden-toggle').previousElementSibling,$('tabs').lastElementChild].map(el=>el.getBoundingClientRect().toJSON()));
    assert.ok(shortList.bottom-group.bottom<16,`Hidden group at the list bottom: ${JSON.stringify({shortList,group})}`);
    assert.ok(group.top-lastTab.bottom>100,`Hidden group apart from the last tab: ${JSON.stringify({lastTab,group})}`);
    // A list taller than the sidebar keeps the Hidden header pinned in view at its bottom.
    const viewport=page.viewportSize();await page.setViewportSize({width:viewport.width,height:260});
    await page.evaluate(()=>{$('tabs').scrollTop=0;});
    const [list,pinned]=await page.evaluate(()=>[$('tabs'),$('hidden-toggle')].map(el=>el.getBoundingClientRect().toJSON()));
    assert.ok(pinned.top>=list.top&&Math.abs(pinned.bottom-list.bottom)<1,`Hidden header pinned to the list bottom: ${JSON.stringify({list,pinned})}`);
    await page.setViewportSize(viewport);
    const header=await page.locator('#hidden-toggle').boundingBox();
    await tabNamed('switchboard').dragTo(page.locator('#hidden-toggle'),{targetPosition:{x:20,y:header.height-3}});
    assert.deepEqual(await hiddenNames(),['switchboard','Online shopping']);
    await tabNamed('Online shopping').dragTo(page.locator('#hidden-toggle'),{targetPosition:{x:20,y:3}});
    assert.deepEqual(await order(),['ssb orchestrator','Online shopping','switchboard']);
    assert.deepEqual(await hiddenNames(),['switchboard']);
    await tabNamed('switchboard').dragTo(tabNamed('Online shopping'),{targetPosition:{x:20,y:5}});
    assert.deepEqual(await order(),reordered);assert.equal(await page.locator('#hidden-toggle').count(),0);
    // A late breakpoint change would close the sidebar Ctrl+K opens below.
    await page.evaluate(()=>{window.breakpointCrossed=new Promise(resolve=>mobileSidebar.addEventListener('change',resolve,{once:true}));});
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.breakpointCrossed);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#sidebar').isVisible(),false);
    await page.locator('#sidebar-toggle').focus();await page.keyboard.press(process.platform==='darwin'?'Meta+k':'Control+k');assert.equal(await page.locator('#sidebar').isVisible(),true);
    await page.locator('#sidebar-toggle').focus();await page.keyboard.press('Escape');
    assert.equal(await page.locator('#sidebar').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'sidebar-toggle');
    await page.locator('#sidebar-toggle').click();
    await page.clock.setFixedTime(new Date('2026-10-29T00:01:00+11:00'));
    hostUnavailable=true;unavailable=true;await page.evaluate(async()=>{await refresh();await refreshAttention();});
    const bounds=await status.boundingBox();
    assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390,'The warning and dismiss button fit on mobile');
    await dismiss.click();await page.evaluate(()=>refreshAttention());
    assert.equal(await status.isHidden(),true);
    hostUnavailable=false;unavailable=false;await page.evaluate(async()=>{await refresh();await refreshAttention();});
    if(process.env.SWITCHBOARD_UX_SCREENSHOTS)await page.screenshot({path:process.env.SWITCHBOARD_UX_SCREENSHOTS+'/mobile.png'});
    // A background tab changing attention must never insert a summary row,
    // move scrolled tab rows, resize the terminal, or steal keyboard focus.
    for(let i=4;i<=30;i++)tabs.push({host:'mac',session:'main',id:i,position:i,name:`Fixture ${i}`,panes:[{pane_id:i,is_plugin:false,tab_position:i}]});
    await page.evaluate(()=>{for(const key of Object.keys(ready))delete ready[key];});
    await page.evaluate(()=>refreshAttention());
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
      // Each size crosses the mobile breakpoint, whose change event closes the sidebar.
      // It can land after two frames, so wait for it before opening the sidebar by hand.
      await page.evaluate(()=>{window.breakpointCrossed=new Promise(resolve=>mobileSidebar.addEventListener('change',resolve,{once:true}));});
      await page.setViewportSize(viewport);
      await page.evaluate(()=>window.breakpointCrossed);
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
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
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
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
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

test('Hidden and Snoozed remember independent expansion in All, Work and Home across reloads',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage(),errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    const tabs=['home','work'].flatMap((host,i)=>['Shell','Working','Hidden'].map((name,position)=>({
      host,session:'main',id:i*3+position+1,position,name:`${host} ${name}`,
      panes:[{pane_id:i*3+position+1,is_plugin:false,tab_position:position}]})));
    await context.addInitScript(()=>{
      window.setInterval=()=>0;
      localStorage.setItem('switchboard-groups',JSON.stringify({home:'home',work:'work'}));
      localStorage.setItem('switchboard-hidden',JSON.stringify({
        '["home","main","tab",3]':1,'["work","main","tab",6]':1}));
    });
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/hosts')return json(['home','work'].map(id=>({id,name:id})));
      if(path.startsWith('/api/hosts/'))return json({id:path.split('/').at(-1),sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:tabs.filter(tab=>tab.position===1).map(tab=>({
        host:tab.host,session:'main',pane_id:tab.panes[0].pane_id,state:'working'})),errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/')){
        const panes=tabs.filter(tab=>tab.host===path.split('/')[2]).flatMap(tab=>tab.panes);
        return route.fulfill({contentType:'text/html',body:`<script>
          const panes=${JSON.stringify(panes)};
          function state(focus_id,pane=panes[0]){parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes,active_pane:pane,tab_viewport:{is_owner:true}}},location.origin);}
          addEventListener('message',event=>{if(event.data.type==='zellij-focus')state(event.data.focus_id,panes.find(pane=>pane.pane_id===event.data.pane_id))});state();
        </script>`});
      }
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    async function check(hidden,snoozed){
      await page.waitForFunction(()=>hostsLoaded&&!loading&&sessions.size===2&&[...sessions.values()].every(entry=>entry.state));
      await page.evaluate(()=>refreshAttention());
      assert.equal(await page.locator('#hidden-toggle').getAttribute('aria-expanded'),String(hidden));
      assert.equal(await page.locator('#snoozed-toggle').getAttribute('aria-expanded'),String(snoozed));
      assert.equal(await page.locator('.hidden-tab').count(),hidden?(new URL(page.url()).searchParams.has('group')?1:2):0);
    }
    const go=group=>page.locator(`#filters [data-filter="${group}"]`).click();
    await page.goto('https://switchboard.test/');await check(false,false);
    await page.locator('#hidden-toggle').click();await page.locator('#snoozed-toggle').click();
    await go('work');await check(false,false);
    await page.locator('#hidden-toggle').click();await check(true,false);
    await go('home');await check(false,false);
    await page.locator('#snoozed-toggle').click();await check(false,true);
    for(const [group,hidden,snoozed] of [['all',true,true],['work',true,false],['home',false,true]]){
      await go(group);await check(hidden,snoozed);await page.reload();await check(hidden,snoozed);
    }
    // Search expands matching sections temporarily without changing the saved choices.
    await page.locator('#tab-search').fill('home');await check(true,true);
    await page.locator('#tab-search').fill('');await check(false,true);
    // Existing browser-wide preferences seed views until each view is changed.
    await page.evaluate(()=>{
      for(const group of ['all','work','home'])for(const section of ['hidden','snoozed'])localStorage.removeItem(`switchboard-${section}-open:${group}`);
      for(const section of ['hidden','snoozed'])localStorage.setItem(`switchboard-${section}-open`,'true');
    });
    await page.reload();await check(true,true);
    await page.locator('#hidden-toggle').click();await page.locator('#snoozed-toggle').click();
    await go('all');await check(true,true);
    await go('work');await check(true,true);
    await go('home');await check(false,false);await page.reload();await check(false,false);
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
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
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

test('working tabs show their age in blue, and long titles run under the status to the agent icon',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:600}}),errors=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    const now=Date.now()/1000;
    const names=['Terminal swapping spec review and cleanup','Fresh task'];
    // The first tab's shell pane changed state more recently; that must not count as working time.
    const tabs=names.map((name,i)=>({host:'mac',session:'main',id:i+1,position:i,name,panes:[{pane_id:i+1,is_plugin:false,tab_position:i},...(i?[]:[{pane_id:9,is_plugin:false,tab_position:i}])]}));
    const panes=[now-372,now-20].map((since,i)=>({host:'mac',session:'main',pane_id:i+1,tab_id:i+1,state:'working',since,agent:'claude'}));
    panes.push({host:'mac',session:'main',pane_id:9,tab_id:1,state:'unknown',since:now-120});
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/attention'&&url.searchParams.has('after'))return;
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes,errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:'<body style="background:#111318"></body>'});
      const file=path==='/'?'index.html':path.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file)});
    });
    await page.goto('https://switchboard.test/');
    await page.locator('#snoozed-toggle').click();
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    const card=name=>page.locator('#tabs .tab-select').filter({has:page.locator('.tab-name',{hasText:name})});
    const old=card(names[0]);
    assert.equal(await old.locator('.tab-status').textContent(),'Working 6m');
    assert.equal(await old.locator('.tab-status').getAttribute('data-tone'),'working');
    assert.equal(await card(names[1]).locator('.tab-status').textContent(),'Working');
    const box=selector=>old.locator(selector).boundingBox();
    const [name,status,agent]=[await box('.tab-name'),await box('.tab-status'),await box('.tab-agent')];
    assert.ok(name.x+name.width>status.x+20,'the title extends under the status');
    assert.ok(Math.abs(agent.x-10-(name.x+name.width))<1,'the title stops 10px before the agent icon');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('a relay restart keeps every tab status instead of flashing Unavailable',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:600}}),errors=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    const tabs=[{host:'mac',session:'main',id:1,position:0,name:'Build',panes:[{pane_id:1,is_plugin:false,tab_position:0}]}];
    const panes=[{host:'mac',session:'main',pane_id:1,tab_id:1,state:'working',since:Date.now()/1000-30,agent:'claude'}];
    let down=false;
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(down&&path.startsWith('/api/'))return route.abort('connectionrefused');
      if(path==='/api/attention'&&url.searchParams.has('after'))return;
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes,errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:'<body style="background:#111318"></body>'});
      const file=path==='/'?'index.html':path.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file)});
    });
    await page.goto('https://switchboard.test/');
    await page.locator('#snoozed-toggle').click();
    const status=page.locator('#tabs .tab-select .tab-status');
    await page.waitForFunction(()=>document.querySelector('#tabs .tab-select .tab-status')?.textContent.startsWith('Working'));
    // The relay goes down for an update: status and tabs stay, and no error shows.
    down=true;
    await page.evaluate(async()=>{await refreshAttention();await refresh();});
    assert.match(await status.textContent(),/^Working/);
    assert.equal(await page.locator('#tabs .tab-select').count(),1);
    assert.doesNotMatch(await page.locator('#status').textContent(),/unavailable|Cannot reach/);
    // Down for longer than a restart: report it as before.
    await page.evaluate(async()=>{relayLostAt=Date.now()-RELAY_RESTART_GRACE_MS;await refreshAttention();});
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('attention status unavailable'),null,{timeout:10000});
    assert.doesNotMatch(await status.textContent(),/^Working/);
    down=false;
    await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>document.querySelector('#tabs .tab-select .tab-status')?.textContent.startsWith('Working'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
