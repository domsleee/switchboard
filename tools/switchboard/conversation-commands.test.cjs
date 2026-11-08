const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Conversation completes commands and host skills, and sends commands through Terminal',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  for(const mobile of [false,true]){
   const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
   const queues=[],skills=[],errors=[];let failSkills=false,baseline=false;
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','conversation');window.setInterval=()=>0;});
   await page.route('http://commands.test/**',async route=>{
    const p=new URL(route.request().url()).pathname;
    if(baseline&&p==='/conversation.js')return route.fulfill({contentType:'text/javascript',body:require('node:child_process').execFileSync('git',['show','origin/main:tools/switchboard/static/conversation.js'],{cwd:path.join(__dirname,'../..'),encoding:'utf8'})});
    if(p.endsWith('/conversation/skills')){skills.push({path:p,...route.request().postDataJSON()});return failSkills?route.fulfill({status:503,body:'Unavailable'}):route.fulfill({json:{skills:[{name:'bro',description:'Review with a colleague'},{name:'build',description:'Build the project'}]}});}
    if(p.endsWith('/codex/reply')){queues.push(route.request().postDataJSON());return route.fulfill({json:{status:'queued'}});}
    if(p.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',project:'/projects/example',messages:[{role:'assistant',text:'Ready for a reply'}],start_cursor:0,next_cursor:null}});
    if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
    if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',tab:1,pane:1,agent:'codex',state:'ready',chatId:'chat-1',terminalReady:false,frame:document.getElementById('terminal')};window.pastes=[];current.frame.contentWindow.postMessage=data=>{pastes.push(data);window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:data.id,ok:true}}));};SwitchboardConversation.install({selection:()=>current,terminal:()=>{current.terminalReady=true;}});</script>`});
    return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
   });
   await page.goto('http://commands.test/');await page.getByText('Ready for a reply',{exact:true}).waitFor();
   const draft=page.getByLabel('Reply draft'),options=page.getByRole('listbox'),send=page.getByRole('button',{name:'Send',exact:true});
   await draft.fill('/ren');await page.getByRole('option',{name:'/rename Rename this conversation'}).waitFor();
   const screenshot=async name=>{const box=await page.locator('.conversation-compose').boundingBox();await page.screenshot({path:path.join(process.env.COMMAND_SCREENSHOTS,name+'.png'),clip:{x:box.x-8,y:box.y-210,width:box.width+16,height:box.height+226}});};
   if(!mobile&&process.env.COMMAND_SCREENSHOTS)await screenshot('commands-after');
   await draft.press('Enter');assert.equal(await draft.inputValue(),'/rename ');assert.equal(queues.length,0);assert.equal(await page.evaluate(()=>pastes.length),0);
   await draft.fill('/rename Example title');await send.click();
   await page.waitForFunction(()=>pastes.length===1);assert.equal(queues.length,0);assert.equal(await page.evaluate(()=>pastes[0].text),'/rename Example title');
   assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true');
   await page.getByRole('button',{name:'Conversation',exact:true}).click();assert.equal(await draft.inputValue(),'');assert.equal(await page.locator('.conversation-outgoing').count(),0);
   await draft.fill('/example:command argument');await send.click();await page.waitForFunction(()=>pastes.length===2);
   assert.equal(await page.evaluate(()=>pastes[1].text),'/example:command argument');assert.equal(queues.length,0);
   await page.getByRole('button',{name:'Conversation',exact:true}).click();
   await draft.fill('Please use $br');await page.getByRole('option',{name:'$bro Review with a colleague'}).click();assert.equal(await draft.inputValue(),'Please use $bro ');
   assert.deepEqual(skills,[{path:'/api/hosts/fixture/conversation/skills',cwd:'/projects/example'}]);
   await draft.fill('Please use $bro on these changes');await send.click();await page.getByText('Queued',{exact:true}).waitFor();assert.equal(queues.at(-1).message,'Please use $bro on these changes');
   await draft.fill('$');await options.waitFor();await draft.press('ArrowDown');await draft.press('Tab');assert.equal(await draft.inputValue(),'$build ');assert.equal(skills.length,1);
   await draft.fill('/');await draft.press('Escape');assert.equal(await options.isVisible(),false);assert.equal(await draft.inputValue(),'/');assert.equal(await draft.evaluate(node=>document.activeElement===node),true);
   await draft.fill('a/b $100');assert.equal(await options.isVisible(),true);assert.equal(await page.getByRole('option').count(),0);await draft.press('Escape');
   await draft.fill('/rename Later');await page.evaluate(()=>{current.state='working';SwitchboardConversation.update();});await send.click();await page.getByText('Wait for the agent to finish before sending a command. Your draft is kept.',{exact:true}).waitFor();assert.equal(await draft.inputValue(),'/rename Later');assert.equal(await page.evaluate(()=>pastes.length),2);
   await page.evaluate(()=>{current.agent='claude';SwitchboardConversation.update();});await send.click();await page.waitForFunction(()=>pastes.length===3);assert.deepEqual(await page.evaluate(()=>[pastes[2].text,pastes[2].agent]),['/rename Later','claude']);
   await page.evaluate(()=>{current.agent='codex';current.state='ready';});await page.getByRole('button',{name:'Conversation',exact:true}).click();
   await page.evaluate(()=>{current={...current,key:'pane2',host:'other',chatId:'chat-2',state:'ready'};SwitchboardConversation.update();});await page.getByText('Ready for a reply',{exact:true}).waitFor();
   failSkills=true;await draft.fill('$br');await page.getByText('Skills unavailable. You can still type a skill name.',{exact:true}).waitFor();assert.equal(skills.at(-1).path,'/api/hosts/other/conversation/skills');
   await draft.fill('$bro');await send.click();await page.getByText('Queued',{exact:true}).waitFor();assert.equal(queues.at(-1).message,'$bro');
   if(!mobile&&process.env.COMMAND_SCREENSHOTS){baseline=true;await page.reload();await page.getByText('Ready for a reply',{exact:true}).waitFor();await draft.fill('/ren');await screenshot('commands-before');}
   assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser.close();}
});
