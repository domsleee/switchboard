const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const enabled = !!process.env.PLAYWRIGHT_MODULE;

test('phone sidebar, actions, Settings, Computers and Messages fit without horizontal overflow', {skip:!enabled}, async () => {
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
  const panes = [1,2,3].map((id, position) => ({pane_id:id,is_plugin:false,tab_position:position,title:['Fix mobile layout','Build finished','Review the pull request'][position]}));
  const tabs = panes.map((pane, i) => ({host:'mac',session:'main',id:i+10,position:i,name:pane.title,panes:[pane]}));
  const errors = [];
  const server = http.createServer((req,res) => {
    const url = new URL(req.url,'http://localhost'), name=url.pathname;
    const json = data => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
    if (name==='/api/hosts') return json([{id:'mac',name:'Mac',local:true}]);
    if (name==='/api/hosts/mac') return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
    if (name==='/api/attention') return json({tabs,panes:[{host:'mac',session:'main',pane_id:2,state:'ready',token:'result:1',seen:false}],errors:[]});
    if (name==='/api/mesh') return json({configured:false,members:[],incoming:[],sent:[],requests:[]});
    if (name==='/api/mesh/defaults') return json({computer_name:'Mac',name:'My computers',address:'https://192.0.2.1:8082',addresses:['https://192.0.2.1:8082'],requires_choice:false});
    if (name.startsWith('/api/')) return json({});
    if (name==='/hosts/mac/project-list') return json(['switchboard']);
    if (name.startsWith('/hosts/')) {
      res.setHeader('Content-Type','text/html');
      return res.end(`<body style="background:#111318;color:#b5bfd0;font:14px monospace"><pre>Fixture terminal\n\n❯ Ready for your next task</pre><script>
      const panes=${JSON.stringify(panes)},tabs=${JSON.stringify(tabs)};let active=panes[0];
      function state(focus_id){parent.postMessage({type:'zellij-state',focus_id,payload:{session_name:'main',panes,tabs,active_pane:active}},location.origin);}
      addEventListener('message',event=>{if(event.data.type==='zellij-focus'){active=panes.find(p=>p.pane_id===event.data.pane_id)||active;state(event.data.focus_id);}});state();</script>`);
    }
    const file=path.join(__dirname,'static',name==='/'?'index.html':path.basename(name));
    if (!fs.existsSync(file)) {res.statusCode=404;return res.end();}
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.webmanifest')?'application/manifest+json':'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true});
  try {
    for (const viewport of [{width:360,height:800},{width:390,height:844},{width:844,height:390},{width:1280,height:900}]) {
      const context=await browser.newContext({viewport,hasTouch:viewport.width<1000,isMobile:viewport.width<1000,permissions:['notifications']});
      const page=await context.newPage();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin);
      await page.locator('.tab-select').first().waitFor({state:'attached'});
      await page.evaluate(()=>navigator.serviceWorker.ready.then(r=>!!r.active));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      if (viewport.width<=1000) await page.locator('#sidebar-toggle').click();
      const controls=['#new-tab','#new-admin-tab','#sidebar-toggle'];
      for (const selector of controls) {
        const box=await page.locator(selector).boundingBox();
        assert.ok(box.width>=(viewport.width<1000?44:28) && box.height>=(viewport.width<1000?44:28),`${selector}: ${JSON.stringify(box)}`);
        assert.ok(box.x>=0 && box.x+box.width<=viewport.width);
      }
      const newTab=await page.locator('#new-tab').boundingBox(),admin=await page.locator('#new-admin-tab').boundingBox(),toggle=await page.locator('#sidebar-toggle').boundingBox();
      assert.ok(newTab.x+newTab.width<=admin.x && admin.x+admin.width<=toggle.x,'top actions must not overlap');
      if (viewport.width<=1000) assert.equal(await page.locator('#tab-search').evaluate(el=>getComputedStyle(el).fontSize),'16px');
      await page.waitForFunction(()=>[...sessions.values()].some(entry=>entry.state));
      await page.locator('#new-tab').click();
      await page.locator('#new-tab-dialog').waitFor({state:'visible'});
      if (viewport.width<1000) {
        for (const selector of ['#new-tab-target','#new-tab-project','#new-tab-command']) {
          const input=page.locator(selector),box=await input.boundingBox();
          assert.ok(box.height>=44,`${selector} must fit a touch target`);
          assert.equal(await input.evaluate(el=>getComputedStyle(el).fontSize),'16px');
        }
        for (const selector of ['#new-tab-project-lookup','#new-tab-lookup']) {
          const button=page.locator(selector),box=await button.boundingBox();
          assert.ok(box.width>=44&&box.height>=44,`${selector} must fit a touch target`);
          assert.equal(await button.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.bottom-1)===el;}),true,`${selector} must not overlap another control`);
        }
        const project=await page.locator('#new-tab-project-lookup').boundingBox(),command=await page.locator('#new-tab-command').boundingBox();
        assert.ok(project.y+project.height<=command.y,'project dropdown must stay above the command field');
      }
      await page.keyboard.press('Escape');
      await page.locator('.tab-actions').first().click();
      await page.locator('#tab-menu').waitFor({state:'visible'});
      const menu=await page.locator('#tab-menu').boundingBox();assert.ok(menu.x>=0&&menu.x+menu.width<=viewport.width);
      await page.keyboard.press('Escape');
      if (viewport.width===390) await page.screenshot({path:'/tmp/switchboard-mobile-phone.png'});
      await page.locator('#settings').click();
      await page.locator('#panel').waitFor({state:'visible'});
      assert.equal(await page.locator('#panel').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
      if (viewport.width<=1000) {
        const box=await page.locator('#panel').boundingBox();assert.equal(box.width,viewport.width);
        assert.ok(await page.locator('#close-panel').isVisible());
      }
      await page.locator('#attention-notifications').scrollIntoViewIfNeeded();
      assert.match(await page.locator('#attention-notifications-help').textContent(),/device only|blocked/);
      if (viewport.width===390) await page.screenshot({path:'/tmp/switchboard-mobile-settings.png'});
      for (const [section,frame] of [['Computers','#computers-frame'],['Messages','#messages-frame']]) {
        await page.getByRole('tab',{name:section,exact:true}).click();
        await page.frameLocator(frame).locator('body').waitFor();
        assert.equal(await page.frameLocator(frame).locator('html').evaluate(el=>el.scrollWidth<=innerWidth),true,section);
      }
      await context.close();
    }
    const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    await context.addInitScript(()=>{
      localStorage.setItem('switchboard-focus-group','work');
      localStorage.setItem('switchboard-groups',JSON.stringify({mac:'home'}));
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    // Push links must open their pane even when this device normally shows another group.
    await page.goto(origin+'/?group=all&host=mac&session=main&pane=2');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='Build finished');
    assert.equal(await page.evaluate(()=>filter),'all');
    assert.equal(await page.evaluate(()=>localStorage.getItem('switchboard-focus-group')),'work');
    await context.close();
    assert.deepEqual(errors,[]);
  } finally {await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
