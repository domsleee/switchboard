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
