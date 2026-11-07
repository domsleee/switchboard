const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

for(const emptyMachine of [false,true])test(`${emptyMachine?'a machine with only unshared sessions starts nothing until + creates its first terminal; ':''}new terminals appear before attention discovery, remain focused, and acquire stable tab IDs without duplicates`,
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let created=0,catalog=0,failed=false,closes=0,frameBoots=0,connected=!emptyMachine,catalogReady=!emptyMachine;
    const diagnostics=[],uploads=[];let projectError=false,delayProjects=false,releaseProjects,uploadError=false,delayUpload=false,releaseUpload;
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    const nativeTabs=()=>Array.from({length:catalog+1},(_,i)=>({host:'windows',session:'main',id:i?89+i:42,position:i,name:i?'New shell '+i:'Original',panes:[{pane_id:i?8+i:7,is_plugin:false,tab_position:i}]}));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04',...(emptyMachine?{commit_timestamp:'2026-10-04T13:24:56+11:00'}:{})});
      if(path==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
      if(path==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:connected?[{name:'main',web_clients_allowed:true}]:[{name:'adamant-duck',web_clients_allowed:false}]});
      if(path==='/api/attention'&&new URL(route.request().url()).searchParams.has('after'))return;
      if(path==='/api/attention')return json({version:1,tabs:failed||!catalogReady?[]:nativeTabs(),panes:[],errors:failed?[{host:'windows',message:'Unavailable'}]:[]});
      if(path==='/api/diagnostics/new-tab'){diagnostics.push(route.request().postDataJSON());return route.fulfill({status:204});}
      if(path==='/api/hosts/windows/close-tab'){closes++;return json({ok:true});}
      if(path.endsWith('/attachments')){
        if(delayUpload)await new Promise(resolve=>releaseUpload=resolve);
        if(uploadError)return route.fulfill({status:503,body:'unavailable'});
        const name=new URL(route.request().url()).searchParams.get('name');uploads.push({path,name,body:route.request().postDataBuffer()});
        return json({path:"C:/User files/attachments/it's "+name});
      }
      if(path==='/hosts/windows/project-list'){if(delayProjects)await new Promise(resolve=>releaseProjects=resolve);return projectError?route.fulfill({status:503,body:'unavailable'}):json(['dotfiles','switchboard','switchboard-tools']);}
      if(path==='/hosts/other/project-list')return json(['other-project']);
      if(path.startsWith('/hosts/')){connected=true;frameBoots++;return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        const input=document.querySelector('input');let count=${created},active=count;
        window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        window.__zjSendControl=message=>{if(message.type==='NewTab'&&window.controlSocket.readyState===1){window.creationRequested=true;window.creationElevated=message.elevated;window.creationLaunch={project:message.project,command:message.command,prompt:message.prompt,images:message.images};}};
      </script><script src="/bridge.js"></script><script>
        const socket=window.controlSocket=new WebSocket('wss://switchboard.test/ws/control');
        function state(){const panes=Array.from({length:count+1},(_,i)=>({pane_id:i?8+i:7,is_plugin:false,tab_position:i,title:'~'}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[active],tabs:panes.map((p,i)=>({position:i,name:i?'New shell '+i:'Original',active:i===active}))}})}));}
        window.confirmCreation=()=>{count++;active=count;window.creationRequested=false;state()};state();
      </script>`});}
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/'+(emptyMachine?'':'?host=windows&session=main&tab=42'));
    await page.waitForFunction(()=>document.querySelector('#build-version').textContent==='abc123def · 2026-10-04');
    await page.locator('#settings').hover();
    // Exact times are shown in the viewer's locale with a relative age, e.g. "Sun, 4 Oct 2026, 1:24 pm (3 days ago)".
    const commitTitle=emptyMachine?/^Commit abc123def · \S+ .*2026.*\d:24.* \(.+\)$/:/^Commit abc123def · 2026-10-04$/;
    assert.equal(await page.locator('#settings').getAttribute('title'),null);
    assert.match(await page.locator('#build-version').getAttribute('title'),commitTitle);
    if(emptyMachine){
      // Switchboard never starts a session on its own, not even on another page load.
      const idle=()=>page.waitForFunction(()=>document.querySelector('#tab-empty-text')?.textContent==='No terminals yet');
      await idle();await page.evaluate(()=>refresh());
      await page.reload();await idle();
      assert.equal(frameBoots,0);assert.equal(await page.locator('#terminals>iframe').count(),0);
      // The + dialog offers the empty machine and creates its session.
      await page.locator('#new-tab').click();assert.equal(await page.locator('#new-tab-target option').count(),1);
      await page.locator('#new-tab-form button[type="submit"]').click();
      await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested);
      const input=page.frameLocator('iframe[title="Windows: main"]').locator('#terminal-input');
      assert.deepEqual(await input.evaluate(()=>window.creationLaunch),{project:'switchboard',command:'csol',prompt:'',images:[]});
      await input.evaluate(()=>window.confirmCreation());
      await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell 1');
      assert.equal(frameBoots,1);
      assert.equal(await input.evaluate(i=>document.activeElement===i&&!window.term.options.disableStdin),true);
      await page.keyboard.type('first command');assert.equal(await input.inputValue(),'first command');
      await page.evaluate(()=>refresh());assert.equal(frameBoots,1);
      await page.locator('#new-tab').click();assert.equal(await page.locator('#new-tab-target option').count(),1);
      await page.keyboard.press('Escape');
      assert.deepEqual(errors,[]);return;
    }
    const frame=page.frameLocator('iframe[title="Windows: main"]'),input=frame.locator('#terminal-input');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Original'));
    await page.waitForFunction(()=>document.activeElement===document.querySelector('#terminals>iframe.active'));
    async function create(number){
      if(number===1)await page.evaluate(()=>{const entry=[...sessions.values()][0];sessions.set(sessionKey(entry.host,'other'),{...entry,name:'other'});});
      if(number===1)await input.evaluate(()=>{window.controlSocket.readyState=0;});
      // The second tab comes from the shield button and asks for administrator.
      if(number===2){
        await page.keyboard.press('Alt+KeyT');
        await page.waitForFunction(()=>document.querySelector('#new-tab-dialog').open);
        assert.equal(await page.locator('#new-tab-title').textContent(),'New tab');
        await page.keyboard.press('Escape');
        await page.locator('#new-admin-tab').click();
      }else await page.keyboard.press('Alt+KeyT');
      await page.waitForFunction(()=>document.querySelector('#new-tab-dialog').open);
      assert.equal(await page.locator('#new-tab-title').textContent(),number===2?'New administrator tab':'New tab');
      assert.equal(await page.locator('#new-tab-prompt').evaluate(input=>document.activeElement===input),true);
      assert.equal(await page.locator('#new-tab-prompt').inputValue(),'');
      assert.equal(await page.getByLabel('Prompt',{exact:true}).count(),1);
      assert.deepEqual(await page.locator('#new-tab-form label').allTextContents(),['Computer','Project','Model','Prompt']);
      assert.equal(await page.getByLabel('Model',{exact:true}).inputValue(),'csol','Sol is the default model');
      assert.equal(await page.locator('#new-tab-target option').count(),1,'One option per computer even with multiple sessions');
      assert.equal(await page.locator('#new-tab-target option').first().textContent(),'Windows');
      if(number===1)await page.evaluate(()=>sessions.delete(sessionKey('windows','other')));
      assert.equal(await page.locator('#new-tab-project').inputValue(),'switchboard');
      assert.equal(await page.getByRole('button',{name:'Cancel',exact:true}).count(),0);
      if(number===1){
        await page.locator('#new-tab-prompt').fill('  Fix spaces, "quotes", $vars & symbols 🦀');
        await page.keyboard.press('Shift+Enter');await page.keyboard.type('second line  ');
        await page.locator('#new-tab-picker').setInputFiles({name:'screen shot.png',mimeType:'image/png',buffer:png});
        await page.locator('#new-tab-prompt').evaluate(input=>{
          const data=new DataTransfer();data.items.add(new File(['pasted image'],'pasted.png',{type:'image/png'}));
          input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
        });
        await page.locator('#new-tab-form').evaluate(form=>{
          const data=new DataTransfer();data.items.add(new File(['reference text'],'notes.txt',{type:'text/plain'}));
          form.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
        });
        assert.equal(await page.locator('#new-tab-files .new-tab-file').count(),3);
      }
      if(number===2){
        await page.locator('#new-tab-prompt').fill('Update this project');
        await page.getByLabel('Model',{exact:true}).selectOption({label:'c'});
        await page.locator('#new-tab-project').fill('dot');
        await page.getByRole('option',{name:'dotfiles',exact:true}).waitFor();
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#new-tab-project').inputValue(),'dotfiles');
        assert.equal(await page.locator('#new-tab-project-help').textContent(),'~/git/dotfiles');
        await page.locator('#new-tab-prompt').focus();
      }
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='Creating tab…');
      if(number===1){
        assert.equal(await input.evaluate(()=>!!window.creationRequested),false);
        await input.evaluate(()=>{window.controlSocket.readyState=1;window.controlSocket.dispatchEvent(new Event('open'));});
        await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested===true);
      }
      assert.equal(await page.locator('#tabs .tab-select').count(),number+1);
      // Repeated old scans must not treat the preceding provisional tab as this creation.
      await page.evaluate(()=>refreshAttention());
      assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'Creating tab…');
      assert.equal(await input.evaluate(()=>window.creationElevated),number===2);
      assert.deepEqual(await input.evaluate(()=>window.creationLaunch),number===2?{project:'dotfiles',command:'c',prompt:'Update this project',images:[]}:{project:'switchboard',command:'csol',prompt:'  Fix spaces, "quotes", $vars & symbols 🦀\nsecond line  \n\nAttached files:\nC:/User files/attachments/it\'s notes.txt',images:["C:/User files/attachments/it's screen shot.png","C:/User files/attachments/it's pasted.png"]});
      if(number===1){
        assert.deepEqual(uploads.slice(-3).map(({path,name})=>({path,name})),['screen shot.png','pasted.png','notes.txt'].map(name=>({path:'/api/hosts/windows/attachments',name})));
        assert.deepEqual(uploads.at(-3).body,png);
      }
      await input.evaluate(()=>window.confirmCreation());created=number;
      await page.waitForFunction(n=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell '+n,number);
      assert.equal(new URL(page.url()).searchParams.get('pane'),String(8+number));
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#terminals>iframe.active')),true,'New terminal receives keyboard focus after shortcut and Enter');
      assert.equal(await input.evaluate(i=>document.activeElement===i&&!window.term.options.disableStdin),true);
      await page.keyboard.type('draft '+number);
      assert.ok((await input.inputValue()).endsWith('draft '+number),'Typing reaches the new terminal without an extra click');
    }
    // A lookup must follow the selected computer, including a late reply from the previous one.
    await page.locator('#new-tab').click();
    await page.waitForFunction(()=>newTabProjects.includes('dotfiles'));
    await page.evaluate(()=>{const option=document.createElement('option');option.value=JSON.stringify(['other','main']);option.textContent='Other';document.querySelector('#new-tab-target').append(option);});
    delayProjects=true;
    await page.evaluate(()=>{loadNewTabProjects();});
    for(let i=0;!releaseProjects&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(releaseProjects);
    await page.locator('#new-tab-target').selectOption(JSON.stringify(['other','main']));
    await page.locator('#new-tab-project-lookup').click();
    await page.getByRole('option',{name:'other-project',exact:true}).waitFor();
    releaseProjects();delayProjects=false;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
    assert.deepEqual(await page.locator('#new-tab-projects [role=option] span').allTextContents(),['other-project']);
    projectError=true;
    await page.locator('#new-tab-target').selectOption(JSON.stringify(['windows','main']));
    await page.locator('#new-tab-project-lookup').click();
    await page.getByRole('status').filter({hasText:'Projects unavailable. Type a project name.'}).waitFor();
    await page.locator('#new-tab-project').fill('manual-project');
    assert.equal(await page.locator('#new-tab-project-help').textContent(),'~/git/manual-project');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#new-tab-dialog').evaluate(el=>el.open),true);
    projectError=false;await page.keyboard.press('Escape');
    await page.locator('#new-tab').click();
    await page.locator('#new-tab-prompt').fill('Keep this draft');
    await page.locator('#new-tab-picker').setInputFiles({name:'retry.png',mimeType:'image/png',buffer:png});
    uploadError=true;await page.locator('#new-tab-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#new-tab-error').textContent.includes('Could not upload'));
    assert.equal(await page.locator('#new-tab-prompt').inputValue(),'Keep this draft');
    assert.equal(await page.locator('#new-tab-files .new-tab-file').count(),1);
    assert.equal(await page.locator('#new-tab-form button[type=submit]').isEnabled(),true);
    uploadError=false;delayUpload=true;await page.locator('#new-tab-form button[type=submit]').click();
    for(let i=0;!releaseUpload&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(releaseUpload);
    assert.equal(await page.locator('#new-tab-target').isDisabled(),true);
    await page.keyboard.press('Escape');await page.locator('#new-tab').click();
    releaseUpload();delayUpload=false;
    await page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/attachments'));
    assert.equal(await page.locator('#new-tab-prompt').inputValue(),'');
    assert.equal(await page.locator('#new-tab-files .new-tab-file').count(),0);
    assert.equal(await input.evaluate(()=>!!window.creationRequested),false,'A cancelled upload cannot create a tab after reopening');
    await page.keyboard.press('Escape');
    await create(1);
    await page.locator('#tabs .selected').click({button:'right'});
    await page.locator('#ready').click();
    await input.click();
    failed=true;await page.evaluate(()=>refreshAttention());
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'New shell 1');
    assert.equal(await input.inputValue(),'draft 1');
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    // Pending panes can close through their own target, not a native tab ID.
    await page.locator('#tabs .selected').click({button:'right'});
    assert.equal(await page.locator('#close-tab').isDisabled(),false);assert.equal(closes,0);
    await page.keyboard.press('Escape');
    failed=false;await page.evaluate(()=>refreshAttention());
    await create(2);
    const pendingUrl=page.url();assert.equal(new URL(pendingUrl).searchParams.get('pane'),'10');
    // Reload can reconnect the confirmed pane even while attention still knows only the old tab.
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell 2');
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    catalog=2;await page.evaluate(()=>refreshAttention());
    await page.waitForFunction(()=>new URL(location.href).searchParams.get('tab')==='91');
    assert.equal(new URL(page.url()).searchParams.has('pane'),false);
    assert.equal(await page.locator('#tabs .tab-select').count(),3);
    assert.deepEqual(await page.locator('#tabs .tab-name').allTextContents(),['Original','New shell 1','New shell 2']);
    assert.equal(await page.evaluate(()=>ready[JSON.stringify(['windows','main','tab',90])]!==undefined),true);
    assert.equal(await input.evaluate(i=>document.activeElement===i),true);
    // A deliberate move to search while creation waits must still win.
    await page.locator('#new-tab').click();
    assert.equal(await page.getByLabel('Model',{exact:true}).inputValue(),'c','The dialog remembers the last model');
    await page.locator('#new-tab-prompt').fill('custom --flag');await page.keyboard.press('Tab');
    assert.equal(await page.locator('#new-tab-prompt').inputValue(),'custom --flag');
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Attach files','Tab moves to attachments');
    await page.locator('#new-tab-prompt').focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested);
    assert.deepEqual(await input.evaluate(()=>window.creationLaunch),{project:'switchboard',command:'c',prompt:'custom --flag',images:[]});
    await page.locator('#tab-search').click();
    await input.evaluate(()=>window.confirmCreation());
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell 3');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    await page.keyboard.type('keep searching');
    assert.equal(await page.locator('#tab-search').inputValue(),'keep searching');
    await page.locator('#tab-search').fill('');
    await page.locator('#new-tab').click();
    await page.locator('#new-tab-form button[type="submit"]').click();
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested);
    const failureReport=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/diagnostics/new-tab'&&response.request().postDataJSON().outcome==='disconnected');
    await input.evaluate(()=>{window.controlSocket.readyState=3;window.controlSocket.dispatchEvent(new Event('close'));});
    await failureReport;
    await page.waitForFunction(()=>![...document.querySelectorAll('#tabs .tab-name')].some(name=>name.textContent.includes('Creating tab'))&&document.querySelector('#status').textContent.includes('connection change'));
    assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),'New shell 3');
    assert.equal(await input.evaluate(()=>window.term.options.disableStdin),false);
    await page.waitForFunction(()=>document.querySelector('#status').classList.contains('has-error'));
    assert.ok(diagnostics.some(diagnostic=>diagnostic.outcome==='ready'&&diagnostic.pane_id===9&&diagnostic.sent_ms>=diagnostic.delivery_ms));
    assert.ok(diagnostics.some(diagnostic=>diagnostic.outcome==='disconnected'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
