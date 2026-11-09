const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

test('New tab completes commands and skills for the chosen agent and launches them',
 {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  for(const mobile of [false,true]){
   const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
   const page=await context.newPage(),errors=[],skills=[],launches=[];let created=0;
   page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{window.setInterval=()=>0;});
   const tabs=()=>Array.from({length:created+1},(_,i)=>({host:'windows',session:'main',id:i?89+i:42,position:i,name:i?'New '+i:'Original',panes:[{pane_id:i?8+i:7,is_plugin:false,tab_position:i}]}));
   await context.route('**/*',async route=>{
    const p=new URL(route.request().url()).pathname,json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    if(p==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
    if(p==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
    if(p==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
    if(p==='/api/attention')return json({tabs:tabs(),panes:[],errors:[]});
    if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
    if(p.endsWith('/conversation/skills')){const body=route.request().postDataJSON();skills.push(body);return json({skills:body.agent==='claude'?[{name:'bro',description:'Review together'},{name:'tools:review',description:'From a plugin'}]:[{name:'bro',description:'Codex review'},{name:'build',description:'Build it'}]});}
    if(p==='/hosts/windows/project-list')return json(['switchboard']);
    if(p==='/hosts/windows/model-list')return json({codex:[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',default:true,efforts:[{id:'high'}]}]});
    if(p==='/hosts/windows/new-tab'){
     launches.push(route.request().postDataJSON());created++;const viewer=page.frames().find(frame=>frame.url().includes('/hosts/windows/'));
     await viewer?.evaluate(()=>window.confirmCreation()).catch(()=>{});
     return json({pane_id:8+created,tab_id:89+created}).catch(()=>{});
    }
    if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input></div><script>
     window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
     const input=document.querySelector('input');let count=${created},active=count;
     window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},_core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
     window.__zjSendControl=message=>{if(message.type==='FocusPane'){active=message.pane_id===7?0:message.pane_id-8;state();}};
     </script><script src="/bridge.js"></script><script>
     const socket=window.controlSocket=new WebSocket('wss://switchboard.test/ws/control');
     function state(){const panes=Array.from({length:count+1},(_,i)=>({pane_id:i?8+i:7,is_plugin:false,tab_position:i,title:'~'}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[active],tabs:panes.map((pane,i)=>({position:i,name:i?'New '+i:'Original',active:i===active}))}})}));}
     window.confirmCreation=()=>{count++;active=count;state();};state();
     </script>`});
    const file=p==='/'?'index.html':p.slice(1),local=path.join(__dirname,'static',path.basename(file));
    if(!fs.existsSync(local))return route.fulfill({status:404,body:''});
    return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(local,'utf8')});
   });
   await page.goto('https://switchboard.test/?host=windows&session=main&tab=42');
   await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Original'));
   const open=()=>page.evaluate(()=>document.querySelector('#new-tab').click()).then(()=>page.waitForFunction(()=>document.querySelector('#new-tab-dialog').open));
   await open();
   const prompt=page.locator('#new-tab-prompt'),dialog=page.locator('#new-tab-dialog'),menu=page.locator('#new-tab-completions'),option=name=>menu.getByRole('option',{name});
   const isOpen=()=>dialog.evaluate(node=>node.open);
   // The dialog closes before the terminal's bridge sends the request.
   const launched=async count=>{await page.waitForFunction(()=>!document.querySelector('#new-tab-dialog').open);for(let tries=0;launches.length<count&&tries<100;tries++)await page.waitForTimeout(20);assert.equal(launches.length,count);};
   // Codex: its own commands after /, and its skills after $, spelled as typed.
   await prompt.fill('/rev');await option('/review Review changes').waitFor();await prompt.press('Enter');assert.equal(await prompt.evaluate(node=>node.value),'/review ');assert.equal(launches.length,0);assert.equal(await menu.isVisible(),false);
   await prompt.fill('$br');await option('$bro Codex review').waitFor();assert.deepEqual(skills.at(-1),{cwd:'switchboard'});await prompt.press('Tab');assert.equal(await prompt.evaluate(node=>node.value),'$bro ');assert.equal(await prompt.evaluate(node=>document.activeElement===node),true);
   const badges=prompt.locator('.conversation-skill');
   await badges.waitFor();assert.equal(await badges.getAttribute('data-label'),'bro');
   await prompt.fill('$bro confirm $bro `$build` $unknown');await prompt.press('Escape');
   assert.equal(await badges.count(),2,'Each invocation stays inline; code and unknown names stay plain text');
   await badges.first().click();await dialog.locator('.conversation-skill-details:popover-open').waitFor();
   assert.match(await dialog.locator('.conversation-skill-details').textContent(),/Codex review/);
   await page.keyboard.press('Escape');assert.equal(await isOpen(),true,'Escape dismisses skill details before the New tab dialog');
   await prompt.fill('ordinary prompt');assert.equal(await badges.count(),0,'Removing an invocation removes its badge');
   // Escape closes the menu first and the dialog only after that.
   await prompt.fill('/');await menu.waitFor();await prompt.press('Escape');assert.equal(await menu.isVisible(),false);assert.equal(await isOpen(),true);assert.equal(await prompt.evaluate(node=>node.value),'/');
   if(!mobile&&process.env.COMMAND_SCREENSHOTS){await prompt.fill('/rev');await menu.waitFor();await page.screenshot({path:path.join(process.env.COMMAND_SCREENSHOTS,'new-tab-commands.png')});}
   // A command cannot carry attachments to Codex, which only takes it at its prompt.
   await prompt.fill('/status');await prompt.press('Escape');await page.locator('#new-tab-picker').setInputFiles({name:'shot.png',mimeType:'image/png',buffer:Buffer.from('image')});
   await page.evaluate(()=>document.querySelector('#new-tab-form').requestSubmit());await page.getByText('Send commands without attachments.',{exact:true}).waitFor();assert.equal(launches.length,0);assert.equal(await prompt.evaluate(node=>node.value),'/status');
   await page.locator('#new-tab-files button').click();
   await page.evaluate(()=>document.querySelector('#new-tab-form').requestSubmit());
   await launched(1);assert.equal(launches.at(-1).prompt,'/status');
   // Claude: both menus offer its skills, a pick is written with a slash, and so is a typed skill.
   await page.reload();await page.waitForFunction(()=>document.querySelector('#tabs .selected'));
   await open();await page.evaluate(()=>{newTabModelValue='claude:claude-opus-5-5#high';});
   await prompt.evaluate(node=>node.blur());await prompt.focus();for(let tries=0;!skills.some(item=>item.agent==='claude')&&tries<100;tries++)await page.waitForTimeout(20);assert.deepEqual(skills.at(-1),{cwd:'switchboard',agent:'claude'},'Focus loads the list, so a pasted $skill can be rewritten');
   await prompt.fill('/');await option('/tools:review From a plugin').waitFor();assert.equal(await option('/help Show commands').count(),1);assert.deepEqual(skills.at(-1),{cwd:'switchboard',agent:'claude'});
   await prompt.fill('$rev');await option('$tools:review From a plugin').waitFor();await prompt.press('Enter');assert.equal(await prompt.evaluate(node=>node.value),'/tools:review ');
   await prompt.fill('/tools:review confirm');
   if(process.env.SKILL_SCREENSHOTS)await dialog.screenshot({path:path.join(process.env.SKILL_SCREENSHOTS,`new-tab-${mobile?'phone':'desktop'}.png`)});
   await badges.waitFor();assert.equal(await badges.getAttribute('data-label'),'review');
   assert.equal(await badges.textContent(),'/tools:review');
   await badges.first().click();const details=dialog.locator('.conversation-skill-details:popover-open');await details.waitFor();
   const box=await details.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=page.viewportSize().width&&box.y>=0&&box.y+box.height<=page.viewportSize().height);
   assert.match(await details.textContent(),/From a plugin/);await page.keyboard.press('Escape');assert.equal(await isOpen(),true);
   await prompt.fill('use $bro then $missing and $review');await prompt.press('Escape');
   await page.evaluate(()=>document.querySelector('#new-tab-form').requestSubmit());
   await launched(2);assert.equal(launches.at(-1).prompt,'use /bro then $missing and /tools:review');
   assert.deepEqual(errors,[]);await context.close();
  }
 }finally{await browser.close();}
});
