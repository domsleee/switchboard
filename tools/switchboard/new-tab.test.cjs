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
    let created=0,catalog=0,failed=false,closes=0,frameBoots=0,connected=!emptyMachine,catalogReady=!emptyMachine,firstLaunch,releaseFirstCreation;
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
      if(path==='/api/attention')return json({tabs:failed||!catalogReady?[]:nativeTabs(),panes:[],errors:failed?[{host:'windows',message:'Unavailable'}]:[]});
      if(path==='/api/diagnostics/new-tab'){diagnostics.push(route.request().postDataJSON());return route.fulfill({status:204});}
      if(path==='/api/hosts/windows/close-tab'){closes++;return json({ok:true});}
      if(path==='/hosts/windows/new-tab'){
        const launch=route.request().postDataJSON(),viewer=page.frames().find(frame=>frame.url().includes('/hosts/windows/'));
        assert.equal(launch.session,'main');
        if(emptyMachine){
          firstLaunch=launch;assert.equal(frameBoots,0,'An explicit request creates the session before any viewer attaches');
          await new Promise(resolve=>releaseFirstCreation=resolve);
          connected=true;created=1;
          return json({pane_id:9,tab_id:90});
        }
        await viewer.evaluate(launch=>{
          window.creationRequested=true;window.creationElevated=launch.elevated;
          window.creationLaunch={project:launch.project,command:launch.command,prompt:launch.prompt,images:launch.images};
        },launch);
        await viewer.waitForFunction(()=>!window.creationRequested);
        return json({pane_id:await viewer.evaluate(()=>window.creationPane)});
      }
      if(path.endsWith('/attachments')){
        if(delayUpload)await new Promise(resolve=>releaseUpload=resolve);
        if(uploadError)return route.fulfill({status:503,body:'unavailable'});
        const name=new URL(route.request().url()).searchParams.get('name');uploads.push({path,name,body:route.request().postDataBuffer()});
        return json({path:"C:/User files/attachments/it's "+name});
      }
      if(path==='/hosts/windows/project-list'){if(delayProjects)await new Promise(resolve=>releaseProjects=resolve);return projectError?route.fulfill({status:503,body:'unavailable'}):json(['dotfiles','switchboard','switchboard-tools','C:\\work\\Org\\Sample.Tools','C:\\work\\Org\\Sample','C:/work/Glow/DotNet','C:/work/Glow2/DotNet']);}
      if(path==='/hosts/other/project-list')return json(['other-project']);
      if(path==='/hosts/windows/model-list')return json({codex:[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',default:true,efforts:[{id:'low'},{id:'high'}]},{id:'gpt-6-luna',name:'GPT-6-Luna',default:false}]});
      if(path.startsWith('/hosts/')){assert.equal(connected,true,'A named viewer cannot create a missing session');frameBoots++;return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        const input=document.querySelector('input');let count=${created},active=count;
        window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        window.__zjSendControl=message=>{if(message.type==='NewTab')throw Error('Model launch reached the retained worker');if(message.type==='FocusPane'&&window.controlSocket.readyState===1){active=message.pane_id===7?0:message.pane_id-8;state();}};
      </script><script src="/bridge.js"></script><script>
        const socket=window.controlSocket=new WebSocket('wss://switchboard.test/ws/control');
        function state(){const panes=Array.from({length:count+1},(_,i)=>({pane_id:i?8+i:7,is_plugin:false,tab_position:i,title:'~'}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[active],tabs:panes.map((p,i)=>({position:i,name:i?'New shell '+i:'Original',active:i===active}))}})}));}
        window.confirmCreation=()=>{count++;window.creationPane=8+count;window.creationRequested=false;state()};state();
      </script>`});}
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','skill-editor.js','model-picker.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/'+(emptyMachine?'':'?host=windows&session=main&tab=42'));
    await page.waitForFunction(()=>document.querySelector('#build-version').textContent==='abc123def · 2026-10-04');
    await page.locator('#settings').hover();
    // Exact times are shown in the viewer's locale with a relative age, e.g. "Sun, 4 Oct 2026, 1:24 pm (3 days ago)".
    const commitTitle=emptyMachine?/^Commit abc123def · \S+ .*2026.*\d:24.* \(.+\)$/:/^Commit abc123def · 2026-10-04$/;
    assert.equal(await page.locator('#settings').getAttribute('title'),'Settings');
    assert.match(await page.locator('#build-version').getAttribute('title'),commitTitle);
    if(emptyMachine){
      // Switchboard never starts a session on its own, not even on another page load.
      const idle=()=>page.waitForFunction(()=>document.querySelector('#tab-empty-text')?.textContent==='No terminals yet');
      await idle();await page.evaluate(()=>refresh());
      await page.reload();await idle();
      assert.equal(frameBoots,0);assert.equal(await page.locator('#terminals>iframe').count(),0);
      // The + dialog offers the empty machine and creates its session.
      await page.locator('#new-tab').click();assert.equal(await page.locator('#new-tab-target option').count(),1);
      await page.locator('#new-tab-prompt').fill('Start here');
      const firstRequest=page.waitForRequest('**/hosts/windows/new-tab');
      await page.locator('#new-tab-form button[type="submit"]').click();
      await firstRequest;
      assert.equal(frameBoots,0);assert.equal(connected,false);
      assert.deepEqual(firstLaunch,{session:'main',project:'switchboard',command:'codex:gpt-6.1-sol#high',prompt:'Start here',images:[],elevated:false});
      releaseFirstCreation();
      const input=page.frameLocator('iframe[title="Windows: main"]').locator('#terminal-input');
      await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='Start here'&&document.querySelector('iframe.active')?.contentWindow.term);
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
      assert.equal(await page.locator('#new-tab-prompt').evaluate(node=>node.value),'');
      assert.equal(await page.getByLabel('Prompt',{exact:true}).count(),1);
      assert.equal(await page.locator('#new-tab-model').getAttribute('aria-label'),'Model: GPT-6.1 Sol, Codex, High effort');
      // Shift+Tab from the prompt reaches the model chip, which opens the picker with focus in its search.
      await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-model-search');
      assert.equal(await page.locator('#new-tab-model-menu').isVisible(),true);
      // A tab per agent opens on the chosen model's agent: here the models this computer's Codex lists.
      await page.waitForFunction(()=>Array.isArray(newTabModels.get('windows')?.codex)&&document.querySelector('#new-tab-model-menu').textContent.includes('GPT-6 Luna'));
      assert.deepEqual(await page.locator('#new-tab-model-menu [role=tab]').allTextContents(),['Favourites','Codex','Claude Code']);
      assert.equal(await page.getByRole('tab',{name:/^Codex/}).getAttribute('aria-selected'),'true');
      assert.deepEqual(await page.locator('#new-tab-model-menu [role=option] .model-picker-name').allTextContents(),['GPT-6.1 Sol','GPT-6 Luna']);
      // The chosen model's levels follow Auto. Without a search, arrows choose as they move.
      assert.deepEqual(await page.locator('#new-tab-model-menu [role=radio] .model-picker-level-name').allTextContents(),['Agent setting','Low','High']);
      await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6-luna#high','The chosen effort carries to the next model');
      assert.deepEqual(await page.locator('#new-tab-model-menu [role=radio] .model-picker-level-name').allTextContents(),['Agent setting','Low','Medium','High','Extra high'],'A model the relay lists without levels gets the common ones');
      // Arrows stay in the agent's tab, wrapping at its ends.
      await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6.1-sol#high');
      await page.keyboard.press('ArrowUp');assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6-luna#high');
      // Another agent's tab says what is chosen instead of offering effort for a model not on screen.
      await page.getByRole('tab',{name:/^Claude Code/}).click();
      assert.match(await page.locator('#new-tab-model-menu .model-picker-effort-away').textContent(),/^GPT-6 Luna at High effort is chosen/);
      await page.getByRole('tab',{name:/^Codex/}).click();
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
      assert.equal(await page.locator('#new-tab-model-menu').isVisible(),false);
      // Escape cancels back to the choice from when the picker opened.
      await page.keyboard.press('Shift+Tab');await page.keyboard.press('ArrowUp');
      assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6.1-sol#high');
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6-luna#high');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
      // A search highlights its first match without choosing it; the first Escape only clears the search.
      await page.keyboard.press('Shift+Tab');await page.keyboard.type('opus 4.6');
      assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6-luna#high');
      await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-model-search');
      await page.keyboard.type('opus 4.6');await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>newTabModel()),'claude:claude-opus-4-6#high');
      // A name nobody listed can start either agent, chosen only by picking its row.
      await page.keyboard.press('Shift+Tab');await page.keyboard.type('my-model[1m]');
      assert.deepEqual(await page.locator('#new-tab-model-menu [role=option] small').allTextContents(),['with Codex','with Claude Code']);
      await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>newTabModel()),'claude:my-model[1m]#high');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
      assert.equal(await page.locator('#new-tab-model').getAttribute('aria-label'),'Model: my-model[1m], Claude Code, High effort');
      await page.keyboard.press('Shift+Tab');await page.keyboard.type('bad name');
      assert.equal(await page.locator('#new-tab-model-menu [role=option]').count(),0);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>newTabModel()),'claude:my-model[1m]#high','An invalid name keeps the earlier choice');
      // Left reaches the agent tabs and Tab moves on to effort; arrows change it and Enter keeps it.
      await page.keyboard.press('Shift+Tab');await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'tab');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('role')),'radio');
      await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>newTabModel()),'claude:my-model[1m]#xhigh');
      assert.equal(await page.locator('#new-tab-model-effort').textContent(),'Extra high');
      // Tab from the model search takes its highlighted model on to the prompt.
      await page.keyboard.press('Shift+Tab');await page.keyboard.type('opus 4.6');await page.keyboard.press('Tab');
      assert.match(await page.evaluate(()=>newTabModel()),/^claude:claude-opus-4-6#/);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
      assert.equal(await page.locator('#new-tab-model-menu').isVisible(),false);
      await page.evaluate(()=>setNewTabModel('codex:gpt-6.1-sol#high'));
      // Shift+Tab walks chat, model, project, computer; Tab walks computer, project, model, chat.
      await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-project');
      await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-machine');
      assert.equal(await page.locator('#new-tab-project-popover').isVisible(),false);
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-project');
      assert.equal(await page.locator('#new-tab-project-popover').isVisible(),true);
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-model-search');
      assert.equal(await page.locator('#new-tab-project-popover').isVisible(),false);
      assert.equal(await page.locator('#new-tab-model-menu').isVisible(),true);
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
      assert.equal(await page.locator('#new-tab-model-menu').isVisible(),false);
      assert.equal(await page.evaluate(()=>newTabModel()),'codex:gpt-6.1-sol#high','Sol is the default model');
      assert.equal(await page.locator('#new-tab-machine-name').textContent(),'Windows');
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
        await page.locator('#new-tab-model').click();await page.getByRole('tab',{name:/^Claude Code/}).click();
        await page.locator('#new-tab-model-menu').getByRole('option',{name:'Opus 5.5',exact:true}).click();
        assert.equal(await page.evaluate(()=>newTabModel()),'claude:claude-opus-5-5#high','Clicking a model chooses it');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-model-search','A clicked model leaves focus in search');
        await page.locator('#new-tab-model-menu').getByRole('button',{name:/^Done/}).click();
        assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
        // Folders from projects.json arrive as full paths and rank by their last folder.
        await page.locator('#new-tab-project-chip').click();
        await page.locator('#new-tab-project').fill('sample');
        await page.locator('#new-tab-projects [role=option]').filter({has:page.locator('span',{hasText:/^Sample$/})}).waitFor();
        assert.deepEqual(await page.locator('#new-tab-projects [role=option] span').allTextContents(),['Sample','Sample.Tools']);
        assert.deepEqual(await page.locator('#new-tab-projects [role=option] small').allTextContents(),['C:/work/Org','C:/work/Org']);
        await page.keyboard.press('Tab');await page.keyboard.press('Escape');
        assert.equal(await page.locator('#new-tab-project-help').textContent(),'C:\\work\\Org\\Sample');
        assert.equal(await page.locator('#new-tab-project-chip-name').textContent(),'Sample');
        assert.equal(await page.locator('#new-tab-project-chip-prefix').isHidden(),true);
        // Equal leaf names retain enough parents to distinguish each workspace.
        await page.locator('#new-tab-project-chip').click();
        await page.locator('#new-tab-project').fill('dotnet');
        await page.waitForFunction(()=>document.querySelectorAll('#new-tab-projects [role=option]').length===2);
        assert.deepEqual(await page.locator('#new-tab-projects [role=option] span').allTextContents(),['Glow/DotNet','Glow2/DotNet']);
        await page.locator('#new-tab-projects [role=option]').filter({has:page.locator('span',{hasText:/^Glow2\/DotNet$/})}).click();
        assert.equal(await page.locator('#new-tab-project').inputValue(),'C:/work/Glow2/DotNet');
        assert.equal(await page.locator('#new-tab-project-chip-name').textContent(),'Glow2/DotNet');
        // Enter selects the folder, typed or suggested, and leaves the dialog open on the prompt.
        for(const [typed,value] of [['dot','dotfiles'],['typed-folder','typed-folder']]){
          await page.locator('#new-tab-project-chip').click();
          await page.locator('#new-tab-project').fill(typed);
          if(typed==='dot'){await page.getByRole('option',{name:value,exact:true}).waitFor();assert.match(await page.locator('#new-tab-project-popover .new-tab-options-hint').textContent(),/Select dotfiles/);}
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('#new-tab-project').inputValue(),value);
          assert.equal(await page.locator('#new-tab-project-popover').isVisible(),false);
          assert.equal(await page.locator('#new-tab-dialog').evaluate(el=>el.open),true);
          assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
        }
        await page.locator('#new-tab-project-chip').click();
        await page.locator('#new-tab-project').fill('dot');
        await page.getByRole('option',{name:'dotfiles',exact:true}).waitFor();
        await page.keyboard.press('Tab');
        assert.equal(await page.locator('#new-tab-project').inputValue(),'dotfiles');
        assert.equal(await page.locator('#new-tab-project-help').textContent(),'~/git/dotfiles');
        assert.equal(await page.locator('#new-tab-project-chip-name').textContent(),'dotfiles');
        assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-model-search','Tab moves on to the model');
        await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt','Tab from the model reaches the prompt');
      }
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>allTabs().find(item=>item.key===selected)?.tab.id==='creating');
      if(number===1){
        assert.equal(await input.evaluate(()=>!!window.creationRequested),false);
        await input.evaluate(()=>{window.controlSocket.readyState=1;window.controlSocket.dispatchEvent(new Event('open'));});
        await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested===true);
      }
      assert.equal(await page.evaluate(()=>allTabs().length),number+1);
      // Repeated old scans must not treat the preceding provisional tab as this creation.
      await page.evaluate(()=>refreshAttention());
      assert.equal(await page.locator('#tabs .selected .tab-name').textContent(),number===2?'Update this project':'Fix spaces, "quotes", $vars & symbols 🦀');
      assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Working');
      assert.equal(await page.evaluate(()=>sidebarTabs().find(item=>item.key===selected).snoozed),true,'Terminal submissions immediately enter Working too');
      assert.equal(await input.evaluate(()=>window.creationElevated),number===2);
      assert.deepEqual(await input.evaluate(()=>window.creationLaunch),number===2?{project:'dotfiles',command:'claude:claude-opus-5-5#high',prompt:'Update this project',images:[]}:{project:'switchboard',command:'codex:gpt-6.1-sol#high',prompt:'  Fix spaces, "quotes", $vars & symbols 🦀\nsecond line  \n\nAttached files:\nC:/User files/attachments/it\'s notes.txt',images:["C:/User files/attachments/it's screen shot.png","C:/User files/attachments/it's pasted.png"]});
      if(number===1){
        assert.deepEqual(uploads.slice(-3).map(({path,name})=>({path,name})).sort((a,b)=>a.name.localeCompare(b.name)),['screen shot.png','pasted.png','notes.txt'].map(name=>({path:'/api/hosts/windows/attachments',name})).sort((a,b)=>a.name.localeCompare(b.name)));
        assert.deepEqual(uploads.slice(-3).find(upload=>upload.name==='screen shot.png').body,png);
      }
      await input.evaluate(()=>window.confirmCreation());created=number;
      await page.waitForFunction(n=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell '+n,number);
      assert.equal(await page.locator('#tabs .tab-select.selected').getAttribute('data-agent-state'),'Working','Working survives the native pane appearing');
      if(number===2){
        const report=(state,age)=>page.evaluate(([state,age])=>{
          const item=allTabs().find(item=>item.key===selected),pane=item.tab.panes.find(p=>!p.is_plugin),key=attentionKey(item.entry.host,item.entry.name,pane.pane_id);
          const launch=launchFor(item);if(age!==null){launch.reported=false;launch.worked=false;launch.at=Date.now()-age;}
          paneAttention.set(key,{key,agent:'claude',chat_id:'claude-new',...state});render();
          return document.querySelector('#tabs .tab-select.selected').dataset.agentState;
        },[state,age??null]);
        assert.equal(await report({state:'working'},0),'Working','A starting screen can read as working');
        assert.equal(await report({state:'ready',token:'idle:0',seen:true}),'Working','SessionStart reports a conversation before the launch text is submitted');
        assert.equal(await report({state:'ready',token:'idle:0',seen:true},61000),'Ready','A conversation that never received the launch text stops spinning');
        assert.equal(await report({state:'ready',token:'a1b2:1',seen:false},0),'Ready to review','A launched turn that finished between scans shows its result');
        await page.evaluate(()=>{const item=allTabs().find(item=>item.key===selected),pane=item.tab.panes.find(p=>!p.is_plugin);paneAttention.delete(attentionKey(item.entry.host,item.entry.name,pane.pane_id));const launch=launchFor(item);launch.reported=false;launch.worked=false;launch.at=Date.now();render();});
      }
      assert.equal(new URL(page.url()).searchParams.get('pane'),String(8+number));
      assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#terminals>iframe.active')),true,'New terminal receives keyboard focus after shortcut and Enter');
      assert.equal(await input.evaluate(i=>document.activeElement===i&&!window.term.options.disableStdin),true);
      await page.keyboard.type('draft '+number);
      assert.ok((await input.inputValue()).endsWith('draft '+number),'Typing reaches the new terminal without an extra click');
    }
    // The close event arrives after the dialog closes; a quick reopen keeps its new draft,
    // and an upload still running for the closed dialog can no longer create a tab.
    delayUpload=true;
    await page.evaluate(()=>{$('new-tab').click();addNewTabFiles([new File(['image'],'slow.png',{type:'image/png'})]);$('new-tab-form').requestSubmit();});
    for(let i=0;!releaseUpload&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(releaseUpload);
    assert.deepEqual(await page.evaluate(async()=>{
      $('new-tab-dialog').close();$('new-tab').click();
      addNewTabFiles([new File(['image'],'quick.png',{type:'image/png'})]);
      await new Promise(resolve=>setTimeout(resolve,50));
      return {files:newTabFiles.length,enabled:!$('new-tab-prompt').disabled};
    }),{files:1,enabled:true});
    releaseUpload();delayUpload=false;releaseUpload=null;
    await page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/attachments'));
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
    assert.equal(await page.locator('#new-tab-dialog').evaluate(dialog=>dialog.open),true,'The old upload does not close the fresh dialog');
    assert.equal(await input.evaluate(()=>!!window.creationRequested),false,'The old upload does not create a tab');
    await page.keyboard.press('Escape');
    // A lookup must follow the selected computer, including a late reply from the previous one.
    await page.locator('#new-tab').click();
    await page.waitForFunction(()=>newTabProjects.includes('dotfiles'));
    await page.evaluate(()=>{const option=document.createElement('option');option.value=JSON.stringify(['other','main']);option.textContent='Other';document.querySelector('#new-tab-target').append(option);});
    delayProjects=true;
    await page.evaluate(()=>{loadNewTabProjects();});
    for(let i=0;!releaseProjects&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.ok(releaseProjects);
    // Shift+Tab three times reaches the computer, whose list shows every computer; an arrow picks the next.
    await page.locator('#new-tab-prompt').focus();for(let i=0;i<3;i++)await page.keyboard.press('Shift+Tab');
    assert.deepEqual(await page.locator('#new-tab-machine-menu [role=option] span').allTextContents(),['Windows','Other']);
    // Typing finds a computer by name, even a name that starts with a digit; digits alone still pick a row.
    await page.evaluate(()=>{const option=document.createElement('option');option.value=JSON.stringify(['named','main']);option.textContent='1fern';document.querySelector('#new-tab-target').append(option);});
    await page.locator('#new-tab-prompt').focus();for(let i=0;i<3;i++)await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-machine');
    assert.equal(await page.locator('#new-tab-machine-search').isVisible(),false);
    await page.keyboard.type('1fern');
    assert.equal(await page.locator('#new-tab-machine-search').inputValue(),'1fern');
    assert.deepEqual(await page.locator('#new-tab-machine-menu [role=option] span').allTextContents(),['1fern']);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#new-tab-machine-name').textContent(),'1fern');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
    // Escape restores the computer from before the typing.
    await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('other');assert.equal(await page.locator('#new-tab-machine-name').textContent(),'Other');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#new-tab-machine-name').textContent(),'1fern');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
    await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
    // Tab from a computer search keeps its match and moves on to the project.
    await page.keyboard.type('other');await page.keyboard.press('Tab');
    assert.equal(await page.locator('#new-tab-machine-name').textContent(),'Other');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-project');
    assert.equal(await page.locator('#new-tab-machine-menu').isVisible(),false);
    await page.keyboard.press('Tab');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
    await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('2');assert.equal(await page.locator('#new-tab-machine-name').textContent(),'Other');
    await page.keyboard.press('Enter');
    // A leading digit that picked a row is undone by Escape too.
    await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('1fern');assert.equal(await page.locator('#new-tab-machine-name').textContent(),'1fern');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#new-tab-machine-name').textContent(),'Other');
    await page.evaluate(()=>[...document.querySelectorAll('#new-tab-target option')].find(option=>option.textContent==='1fern').remove());
    await page.locator('#new-tab-prompt').focus();for(let i=0;i<3;i++)await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    assert.equal(await page.locator('#new-tab-target').inputValue(),JSON.stringify(['other','main']));
    assert.equal(await page.locator('#new-tab-machine-name').textContent(),'Other');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-prompt');
    await page.locator('#new-tab-project-chip').click();
    await page.getByRole('option',{name:'other-project',exact:true}).waitFor();
    releaseProjects();delayProjects=false;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
    assert.deepEqual(await page.locator('#new-tab-projects [role=option] span').allTextContents(),['other-project']);
    projectError=true;
    // Shift+Tab from the project search reaches the computer; ArrowUp picks the previous one.
    await page.keyboard.press('Shift+Tab');await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('#new-tab-target').inputValue(),JSON.stringify(['windows','main']));
    await page.locator('#new-tab-project-chip').click();
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
    assert.equal(await page.locator('#new-tab-prompt').evaluate(node=>node.value),'Keep this draft');
    assert.equal(await page.locator('#new-tab-files .new-tab-file').count(),1);
    assert.equal(await page.locator('#new-tab-form button[type=submit]').isEnabled(),true);
    uploadError=false;delayUpload=true;await page.locator('#new-tab-form button[type=submit]').click();
    for(let i=0;!releaseUpload&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(releaseUpload);
    assert.equal(await page.locator('#new-tab-target').isDisabled(),true);
    assert.match(await page.locator('#new-tab-submit').getAttribute('aria-label'),/^Uploading 0%…/);
    assert.match(await page.locator('#new-tab-status').textContent(),/^Uploading 0%…/);
    assert.equal(await page.getByRole('button',{name:'Stop upload and close',exact:true}).isEnabled(),true,'Close stays available while files upload');
    // Closing cancels the upload rather than leaving it running.
    const cancelled=page.waitForEvent('requestfailed',request=>new URL(request.url()).pathname.endsWith('/attachments'));
    await page.keyboard.press('Escape');await cancelled;await page.locator('#new-tab').click();
    releaseUpload();delayUpload=false;
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
    assert.equal(await page.locator('#new-tab-prompt').evaluate(node=>node.value),'');
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
    assert.equal(await page.evaluate(()=>newTabModel()),'claude:claude-opus-5-5#high','The dialog remembers the last model');
    await page.locator('#new-tab-prompt').fill('custom --flag');await page.keyboard.press('Tab');
    assert.equal(await page.locator('#new-tab-prompt').evaluate(node=>node.value),'custom --flag');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'new-tab-attach','Tab moves to attachments');
    await page.locator('#new-tab-prompt').focus();await page.keyboard.press('Enter');
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow.creationRequested);
    assert.deepEqual(await input.evaluate(()=>window.creationLaunch),{project:'dotfiles',command:'claude:claude-opus-5-5#high',prompt:'custom --flag',images:[]},'The dialog remembers the last project on this computer');
    await page.locator('#tab-search').click();
    await input.evaluate(()=>window.confirmCreation());
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .tab-name')?.textContent==='New shell 3');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    await page.keyboard.type('keep searching');
    assert.equal(await page.locator('#tab-search').inputValue(),'keep searching');
    await page.locator('#tab-search').fill('');
    await page.locator('#new-tab').click();
    await page.locator('#new-tab-prompt').fill('Start here');
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
  }finally{for(const context of browser.contexts())await context.unrouteAll({behavior:'ignoreErrors'});await browser.close();}
});
