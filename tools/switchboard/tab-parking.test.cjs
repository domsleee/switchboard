const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

test('hover snooze and settle preserve the selected view, review state and keyboard navigation',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  const panes=[1,2,3].map(id=>({pane_id:id,is_plugin:false,tab_id:id,tab_position:id-1,title:['Fix volume performance','Review the sidebar','Plan the next release'][id-1],cwd:'/home/developer/git/sample'}));
  const tabs=panes.map(pane=>({host:'desktop',session:'main',id:pane.tab_id,position:pane.tab_position,name:pane.title,panes:[pane]}));
  async function fixture(mode){
    const page=await browser.newPage({viewport:{width:1100,height:760},timezoneId:'Australia/Sydney'}),errors=[],writes=[];
    await page.clock.setFixedTime(new Date('2026-11-08T07:11:00Z'));
    page.setDefaultTimeout(5000);page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(mode=>{localStorage.setItem('switchboard-view-mode',mode);window.setInterval=()=>0;},mode);
    await page.route('https://parking.test/**',route=>{
      const url=new URL(route.request().url()),p=url.pathname,json=value=>route.fulfill({json:value});
      if(p==='/api/attention'&&url.searchParams.has('after'))return;
      if(route.request().method()==='POST')writes.push(p);
      if(p==='/api/health')return json({commit:'abc123def',commit_date:'2026-11-08'});
      if(p==='/api/hosts')return json([{id:'desktop',name:'Desktop',local:true}]);
      if(p==='/api/hosts/desktop')return json({id:'desktop',name:'Desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
      if(p==='/api/attention')return json({version:1,tabs,panes:panes.map(pane=>({host:'desktop',session:'main',pane_id:pane.pane_id,agent:'codex',state:'ready',chat_id:'chat-'+pane.pane_id,token:'result-'+pane.pane_id,seen:false,since:1794096000})),errors:[]});
      if(p.startsWith('/api/chats/'))return json({id:p.split('/').at(-1),session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'The change is ready for review.'}],start_cursor:0,next_cursor:null});
      if(p.endsWith('/codex/reply'))return json({status:'queued'});
      if(p.startsWith('/api/'))return json({});
      if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<input aria-label="Terminal input"><script>let active=${JSON.stringify(panes[0])};const state=id=>parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',panes:${JSON.stringify(panes)},active_pane:active}},location.origin);addEventListener('message',e=>{if(e.data.type==='zellij-focus'){active=${JSON.stringify(panes)}.find(p=>p.pane_id===e.data.pane_id)||active;state(e.data.focus_id)}});state();</script>`});
      const file=p==='/'?'index.html':p.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      const body=fs.readFileSync(__dirname+'/static/'+file);
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body});
    });
    await page.goto('https://parking.test/');await page.locator('.tab-select').first().waitFor();
    return {page,errors,writes};
  }
  try{
    for(const mode of ['terminal','conversation']){
      const {page,errors,writes}=await fixture(mode);
      const first=page.locator('.tab-row').filter({has:page.locator('.tab-name',{hasText:'Fix volume performance'})});
      const second=page.locator('.tab-select').filter({has:page.locator('.tab-name',{hasText:'Review the sidebar'})});
      await page.waitForFunction(()=>allTabs().length===3);
      const selected=await page.evaluate(()=>selected),order=await page.evaluate(()=>allTabs().map(t=>t.key));
      const settle=first.getByRole('button',{name:'Settle thread',exact:true});
      await page.mouse.move(1000,700);
      assert.equal(await settle.isVisible(),false);
      await first.locator('.tab-select').focus();assert.equal(await settle.isVisible(),true,'keyboard focus exposes the actions');
      await first.hover();
      if(mode==='terminal'&&process.env.SWITCHBOARD_PARKING_SCREENSHOTS){await page.evaluate(()=>document.activeElement.blur());await page.locator('#sidebar').screenshot({path:process.env.SWITCHBOARD_PARKING_SCREENSHOTS+'/after.png'});}
      await settle.click();
      assert.equal(await page.evaluate(()=>selected),selected,'settle does not switch conversations');
      assert.equal(await page.locator('#manual-settled-toggle .count').textContent(),'1');
      assert.equal(await page.evaluate(()=>globalThis.SwitchboardConversation.isOpen()),mode==='conversation');
      assert.deepEqual(await page.evaluate(()=>allTabs().map(t=>t.key)),order);
      assert.equal(writes.some(p=>/close-tab|restart-agent/.test(p)),false);
      await page.reload();await page.locator('#manual-settled-toggle').waitFor();
      await first.hover();await first.getByRole('button',{name:'Un-settle thread'}).click();
      assert.equal(await page.locator('#manual-settled-toggle').count(),0);
      await first.hover();await first.getByRole('button',{name:'Snooze thread',exact:true}).click();
      assert.deepEqual(await page.locator('#snooze-menu button>span:first-child').allTextContents(),['In 1 hour','In 3 hours','Tomorrow']);
      const expected=await page.evaluate(()=>{const time=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});return ['2026-11-08T08:11:00Z','2026-11-08T10:11:00Z','2026-11-08T22:00:00Z'].map(date=>time.format(new Date(date)));});
      assert.deepEqual(await page.locator('#snooze-menu .snooze-time').allTextContents(),expected);
      await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'snooze-custom');
      await page.keyboard.press('Home');assert.equal(await page.locator('#snooze-menu button').first().evaluate(el=>el===document.activeElement),true);
      await page.locator('#snooze-menu button[data-minutes="60"]').click();
      assert.equal(await page.locator('#manual-snoozed-toggle .count').textContent(),'1');
      const parking=await page.evaluate(()=>Object.values(parkedTabs)[0]);
      assert.equal(parking.until,await page.evaluate(()=>Date.now()+3600000));
      await second.click();assert.equal(await first.count(),0,'collapsed snoozed shelf hides unselected tabs');
      await page.keyboard.press('Alt+1');assert.equal(await page.evaluate(()=>allTabs().find(t=>t.key===selected).tab.id),2,'number shortcuts skip collapsed shelves');
      await page.locator('#tab-search').fill('volume');await first.waitFor();
      await first.locator('.tab-select').click({button:'right'});await page.locator('#settle-tab').click();
      assert.equal(await page.locator('#manual-snoozed-toggle').count(),0,'context menu wakes the tab without selecting it');
      await page.locator('#tab-search').fill('');await first.hover();await first.getByRole('button',{name:'Snooze thread',exact:true}).click();
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>Object.keys(parkedTabs).length),0);
      assert.equal(await first.getByRole('button',{name:'Snooze thread',exact:true}).evaluate(el=>document.activeElement===el),true);
      await first.getByRole('button',{name:'Snooze thread',exact:true}).click();
      await page.locator('#snooze-custom').click();
      await page.locator('#snooze-until').fill('2020-01-01T12:00');await page.locator('#snooze-form button[type=submit]').click();
      assert.match(await page.locator('#snooze-error').textContent(),/future/);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>paneAttention.get(attentionKey('desktop','main',3)).seen),false,'parking leaves other results unreviewed');
      await first.locator('.tab-select').click();
      for(const [selector,expected] of [['[data-minutes="180"]','2026-11-08T10:11:00Z'],['#snooze-tomorrow','2026-11-08T22:00:00Z']]){
        await first.hover();await first.getByRole('button',{name:'Snooze thread',exact:true}).click();
        await page.locator('#snooze-menu').locator(selector).click();
        assert.equal(await page.evaluate(()=>Object.values(parkedTabs)[0].until),Date.parse(expected));
        await first.hover();await first.getByRole('button',{name:'Wake thread',exact:true}).click();
      }
      await first.hover();await first.getByRole('button',{name:'Snooze thread',exact:true}).click();
      await page.locator('#snooze-custom').click();await page.locator('#snooze-until').fill('2026-11-10T10:45');
      await page.locator('#snooze-form button[type=submit]').click();
      assert.equal(await page.evaluate(()=>Object.values(parkedTabs)[0].until),Date.parse('2026-11-09T23:45:00Z'));
      await first.hover();await first.getByRole('button',{name:'Wake thread',exact:true}).click();
      if(mode==='conversation'){
        await first.locator('.tab-select').click();await first.hover();
        await first.getByRole('button',{name:'Snooze thread',exact:true}).click();
        await page.locator('#snooze-menu button[data-minutes="60"]').click();
        await page.getByLabel('Reply draft').fill('Continue the task');
        await page.getByLabel('Reply draft').press('Enter');
        await page.waitForFunction(()=>Object.keys(parkedTabs).length===0);
        assert.equal(await page.locator('#manual-snoozed-toggle').count(),0,'sending wakes a snoozed conversation');
      }
      const third=page.locator('.tab-row').filter({has:page.locator('.tab-name',{hasText:'Plan the next release'})});
      await third.hover();await third.getByRole('button',{name:'Settle thread',exact:true}).click();
      await page.evaluate(()=>{const state=paneAttention.get(attentionKey('desktop','main',3));Object.assign(state,{state:'approval',token:'approval',since:state.since+1});render();});
      await third.waitFor();assert.equal(await third.locator('.tab-select').evaluate(el=>el.classList.contains('needs-attention')),true,'a settled tab with a new approval returns with its badge');
      assert.equal(await page.evaluate(()=>allTabs().filter(item=>item.tab.id===3).some(item=>!!parkedTab(item))),false);
      await page.setViewportSize({width:390,height:740});await page.locator('#sidebar-toggle').click();
      await first.locator('.tab-select').click({button:'right'});await page.locator('#snooze-tab').click();
      const bounds=await page.locator('#snooze-menu').boundingBox();
      assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=740);
      await page.keyboard.press('Escape');assert.equal(await page.locator('#snooze-menu').isHidden(),true);
      assert.equal(await page.evaluate(()=>sidebarOpen),true,'Escape closes the snooze menu before the mobile drawer');
      assert.deepEqual(errors,[]);await page.close();
    }
  }finally{await browser.close();}
});
