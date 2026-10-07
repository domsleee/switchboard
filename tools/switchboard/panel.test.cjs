const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const tab=(host,id)=>({host,session:'main',id,position:0,name:host+' terminal',panes:[{pane_id:id,is_plugin:false,tab_position:0}]});
const statics=['index.html','app.js','bridge.js','close.js','titles.js','pairing-notice.js','style.css','messages.html','messages.js','messages.css','computers.html','computers.js'];

// Synthetic hosts and fixture terminals only; never a live relay.
test('One panel holds Messages, Computers, Archive, Logs and Settings over live terminals',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser overlay check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),pageErrors=[];let navigations=0,logRequests=0;page.setDefaultTimeout(5000);
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(pathname.startsWith('/api/hosts/'))return json({id:pathname.split('/')[3],name:pathname.endsWith('mac')?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(pathname==='/api/attention')return json({tabs:[tab('mac',1),tab('windows',42)],panes:[],errors:[]});
      if(pathname==='/api/logs'){logRequests++;return json({computers:[{name:'Mac',entries:[]}]});}
      if(pathname==='/api/mesh')return json({configured:true,computer:{name:'Mac'},mesh:{name:'My computers'},administrator:true,requests:[],members:[{name:'Mac',address:'https://192.0.2.1:8082'},{name:'Windows',address:'https://192.0.2.2:8082'}]});
      if(pathname.startsWith('/api/mesh/'))return json({});
      if(pathname.endsWith('/inboxes'))return json({machine_id:'mac',machines:[{id:'mac',name:'Mac',unread_count:1,participants:[]},{id:'windows',name:'Windows',unread_count:0,participants:[]}]});
      if(pathname.startsWith('/api/message-board/'))return json({items:[],next_cursor:null});
      if(pathname.startsWith('/hosts/')){
        const id=pathname.split('/')[2]==='mac'?1:42;
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
          const input=document.querySelector('input');
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;window.__zjSendControl=()=>{};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus();},blur(){input.blur();},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:true,cols:100,rows:40}}})}));
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!statics.includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const requested='https://switchboard.test/?host=windows&session=main&tab=42';
    await page.goto(requested);
    await page.waitForFunction(()=>document.querySelectorAll('#terminals>iframe').length===2&&document.activeElement===document.querySelector('iframe[title="Windows: main"]'));
    await page.evaluate(()=>{window.terminalFrames=[...document.querySelectorAll('#terminals>iframe')];for(const frame of terminalFrames)frame.contentWindow.stillLoaded=true;});
    const messagesFrame=page.frameLocator('#messages-frame'),computersFrame=page.frameLocator('#computers-frame');
    async function terminalsIntact(){
      await page.waitForFunction(()=>!document.querySelector('dialog[open]')&&[...document.querySelectorAll('#panel iframe')].every(frame=>frame.getAttribute('src')==='about:blank'));
      await page.waitForTimeout(500);console.log(await page.evaluate(()=>[document.activeElement.id,document.activeElement.tagName,document.activeElement.title]));
      assert.equal(page.url(),requested);assert.equal(navigations,1);
      assert.deepEqual(await page.evaluate(()=>{
        const frames=[...document.querySelectorAll('#terminals>iframe')],active=document.querySelector('iframe[title="Windows: main"]');
        return {same:frames.length===terminalFrames.length&&frames.every((frame,i)=>frame===terminalFrames[i]),
          loaded:frames.every(frame=>frame.contentWindow.stillLoaded),
          focused:document.activeElement===active&&active.contentDocument.activeElement.id==='terminal-input'};
      }),{same:true,loaded:true,focused:true});
    }
    async function section(){
      return page.evaluate(()=>{
        const tabs=[...document.querySelectorAll('#panel [role=tab]')],selected=tabs.filter(tab=>tab.getAttribute('aria-selected')==='true');
        const panels=[...document.querySelectorAll('#panel [role=tabpanel]')].filter(panel=>!panel.hidden);
        return {open:document.querySelector('#panel').open,selected:selected.map(tab=>tab.textContent),
          visible:panels.map(panel=>panel.id),title:document.querySelector('#panel-title').textContent,
          focused:document.activeElement.textContent,roving:tabs.map(tab=>tab.tabIndex).join('')};
      });
    }
    const at=(name,focused=name)=>({open:true,selected:[name],visible:['panel-'+name.toLowerCase()],title:name,focused,
      roving:['Messages','Computers','Archive','Logs','Settings'].map(tab=>tab===name?'0':'-1').join('')});

    // Sidebar Messages keeps its href for new-tab use and opens the panel at Messages.
    const messages=page.locator('#sidebar-utilities a[href="/messages.html"]');
    assert.equal(await messages.getAttribute('href'),'/messages.html');
    await messages.click();
    assert.deepEqual(await section(),at('Messages'));
    await messagesFrame.locator('button[data-key="computer:windows"]').waitFor();
    for(const selector of ['a[href="/"]','h1','a[href="/computers.html"]'])assert.equal(await messagesFrame.locator(selector).isHidden(),true,selector+' hidden in panel');
    await page.keyboard.press('Escape');
    await terminalsIntact();

    // Switching sections keeps each embedded page where it was.
    await messages.click();
    await messagesFrame.locator('button[data-key="computer:windows"]').waitFor();
    await page.getByRole('tab',{name:'Computers'}).click();
    assert.deepEqual(await section(),at('Computers'));
    await computersFrame.locator('text=Windows').first().waitFor();
    for(const selector of ['a[href="/"]','h1'])assert.equal(await computersFrame.locator(selector).isHidden(),true,selector+' hidden in panel');
    assert.equal(await page.locator('#messages-frame').evaluate(frame=>frame.contentWindow.location.pathname),'/messages.html');

    // Arrow keys move between sections with roving focus; Home/End and wrapping work.
    await page.keyboard.press('ArrowDown');assert.deepEqual(await section(),at('Archive'));
    await page.keyboard.press('End');assert.deepEqual(await section(),at('Settings'));
    await page.keyboard.press('ArrowDown');assert.deepEqual(await section(),at('Messages'));
    await page.keyboard.press('ArrowUp');assert.deepEqual(await section(),at('Settings'));
    await page.keyboard.press('Home');assert.deepEqual(await section(),at('Messages'));
    // Tab leaves the tab list for the section's content.
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'close-panel');
    // Clicking a left-nav section loads it.
    const logsRequests=logRequests;
    await page.getByRole('tab',{name:'Logs'}).click();
    assert.deepEqual(await section(),at('Logs'));
    await page.waitForFunction(()=>document.querySelector('#logs .log-computer'));
    assert.equal(logRequests,logsRequests+1);
    // Esc pressed inside an embedded page also closes the panel.
    await page.getByRole('tab',{name:'Messages'}).click();
    await messagesFrame.locator('button[data-key="computer:windows"]').click();
    await page.keyboard.press('Escape');
    await terminalsIntact();

    // Settings, Archive and the pairing notice each open their own section; Close restores focus.
    await page.locator('#settings').click();assert.deepEqual(await section(),at('Settings'));
    assert.equal(await page.locator('#native-tabs').isVisible(),true);
    await page.locator('#close-panel').click();await terminalsIntact();
    await page.locator('#archive').click();assert.deepEqual(await section(),at('Archive'));
    assert.equal(await page.locator('#archive-list').textContent(),'No archived tabs.');
    await page.locator('#close-panel').click();await terminalsIntact();
    await page.evaluate(()=>document.querySelector('#pairing-notice').click());assert.deepEqual(await section(),at('Computers'));

    // A backdrop click closes; a click inside, or a drag from inside to the backdrop, does not.
    await page.locator('#panel-title').click();assert.equal((await section()).open,true);
    const title=await page.locator('#panel-title').boundingBox();
    await page.mouse.move(title.x+2,title.y+title.height/2);await page.mouse.down();
    await page.mouse.move(6,6,{steps:4});await page.mouse.up();
    assert.equal((await section()).open,true);
    await page.mouse.click(6,6);
    await terminalsIntact();

    // Opened standalone, the pages keep their back link and title.
    const standalone=await context.newPage();await standalone.goto('https://switchboard.test/messages.html');
    for(const selector of ['a[href="/"]','h1','a[href="/computers.html"]'])assert.equal(await standalone.locator(selector).isVisible(),true,selector+' visible standalone');
    await standalone.close();
    // Phone width: full screen, title and Close above a single row of sections, no horizontal scroll.
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>document.querySelector('#sidebar-utilities a[href="/messages.html"]').click());
    const box=await page.locator('#panel').boundingBox();
    assert.deepEqual([box.x,box.y,box.width,box.height],[0,0,390,844]);
    await page.waitForFunction(()=>matchMedia('(max-width:700px)').matches);
    const layout=await page.evaluate(()=>{
      const tabs=[...document.querySelectorAll('#panel [role=tab]')].map(tab=>tab.getBoundingClientRect());
      return {row:new Set(tabs.map(tab=>tab.top)).size,within:tabs.every(tab=>tab.left>=0&&tab.right<=390),
        headerAbove:document.querySelector('#panel-body>header').getBoundingClientRect().bottom<=tabs[0].top,
        orientation:document.querySelector('#panel-tabs').getAttribute('aria-orientation'),
        scroll:Math.max(document.documentElement.scrollWidth,document.querySelector('#panel').scrollWidth)};
    });
    assert.deepEqual(layout,{row:1,within:true,headerAbove:true,orientation:'horizontal',scroll:390});
    await page.getByRole('tab',{name:'Settings'}).click();
    assert.equal(await page.evaluate(()=>document.querySelector('#panel-settings').scrollWidth<=document.querySelector('#panel-settings').clientWidth),true);
    await page.locator('#close-panel').click();
    await terminalsIntact();
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});
