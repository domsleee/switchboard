const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
test('current conversation opens directly, stays pane-local, and follows a new chat in the same pane',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE);let queries=0,held=null,hold=false;
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname==='/api/chats/search'){queries++;return json({error:'Unexpected history search'});}
  if(url.pathname==='/api/chats/claude-two'){assert.equal(url.searchParams.get('host'),'peer');return json({title:'Remote Claude',messages:[{role:'assistant',text:'Remote Claude answer'}],next_cursor:null});}
  if(url.pathname==='/api/chats/codex-one'){if(hold){hold=false;held=()=>json({messages:[{role:'assistant',text:'Stale response'}],next_cursor:null});return;}assert.equal(url.searchParams.get('host'),'local');const cursor=Number(url.searchParams.get('cursor'));return json({title:'Actual chat',messages:cursor?[{role:'assistant',text:'Final answer'}]:[{role:'user',text:'<img src=x onerror="window.injected=true">'},{role:'assistant',phase:'commentary',text:'Working on it'}],next_cursor:cursor?null:2});}
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(`<link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100vh}</style><main id="terminals"><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>
  window.sent=[];window.returned=0;window.current={key:'pane1',host:'mac',chatHost:'local',pane:1,title:'Test agent',agent:'codex',state:'ready',chatId:'codex-one',frame:{contentWindow:{postMessage:data=>sent.push(data)}}};
  SwitchboardConversation.install({selection:()=>current,terminal:()=>returned++});
  </script>`);}
  const file=path.join(__dirname,'static',path.basename(url.pathname));res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{const page=await browser.newPage({viewport:{width:390,height:844}});await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}`);
 const terminalMode=page.getByRole('button',{name:'Terminal',exact:true}),conversationMode=page.getByRole('button',{name:'Conversation',exact:true});
 const checkModes=async()=>{const a=await terminalMode.boundingBox(),b=await conversationMode.boundingBox();assert.ok(a&&b);assert.equal(a.y,b.y);assert.ok(a.x<b.x);assert.ok(b.y<20&&b.x+b.width<=page.viewportSize().width&&b.x+b.width>=page.viewportSize().width-20);};
 await checkModes();assert.equal(await conversationMode.getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.locator('.conversation-message').first().waitFor();assert.equal(queries,0);assert.equal(await page.getByRole('button',{name:'Search',exact:true}).count(),0);assert.equal(await page.locator('.conversation-message img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('details').count(),1);
 await checkModes();assert.equal(await conversationMode.getAttribute('aria-pressed'),'true');
 if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/conversation.png'});
 await page.getByRole('button',{name:'Load next messages'}).click();await page.getByText('Final answer',{exact:true}).waitFor();assert.equal(await page.locator('.conversation-message').count(),3);
 await page.evaluate(()=>{window.originalMessage=document.querySelector('.conversation-message');document.querySelector('details').open=true;});
 await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/codex-one')),page.getByRole('button',{name:'Refresh',exact:true}).click()]);
 assert.equal(await page.evaluate(()=>originalMessage===document.querySelector('.conversation-message')),true);assert.equal(await page.locator('details[open]').count(),1);
 await page.getByRole('button',{name:'Refresh',exact:true}).focus();
 await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/codex-one')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);
 await page.getByLabel('Reply draft').fill('draft one');await page.getByLabel('Reply draft').press('Shift+Enter');assert.equal(await page.evaluate(()=>sent.length),0);await page.getByLabel('Reply draft').fill('draft one');await page.getByLabel('Reply draft').press('Enter');assert.equal(await page.evaluate(()=>sent[0].pane_id),1);assert.equal(await page.evaluate(()=>sent[0].submit),true);
 await page.evaluate(()=>{const m=sent[0];window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:null,data:{type:'zellij-conversation-paste-result',id:m.id,ok:true}}));});assert.equal(await page.getByLabel('Reply draft').inputValue(),'draft one');
 await page.evaluate(()=>{current={...current,key:'pane2',pane:2,chatId:null};SwitchboardConversation.update();});assert.equal(await page.getByLabel('Reply draft').inputValue(),'');assert.equal(await page.locator('.conversation-message').count(),0);
 await page.evaluate(()=>{current={...current,key:'pane1',pane:1,chatId:'codex-one'};SwitchboardConversation.update();});assert.equal(await page.getByLabel('Reply draft').inputValue(),'draft one');await page.locator('.conversation-message').first().waitFor();
 // A new/unreported session in the same pane must not retain the old transcript or draft.
 await page.evaluate(()=>{current={...current,chatId:null};SwitchboardConversation.update();});
 assert.equal(await page.locator('.conversation-message').count(),0);
 assert.equal(await page.getByLabel('Reply draft').isVisible(),false);
 assert.match(await page.locator('.conversation-notice').textContent(),/not reported/);
 // A hook arriving later connects the open panel automatically.
 await page.evaluate(()=>{current={...current,chatId:'codex-one'};SwitchboardConversation.update();});
 await page.locator('.conversation-message').first().waitFor();assert.equal(queries,0);
 // A late response from the previous chat must not paint into the selected peer's chat.
 hold=true;
 await page.getByRole('button',{name:'Refresh',exact:true}).click();
 while(!held)await new Promise(r=>setTimeout(r,10));
 await page.evaluate(()=>{current={...current,key:'peer/main/1',host:'peer',chatHost:'peer',pane:1,agent:'claude',chatId:'claude-two'};SwitchboardConversation.update();});
 await page.getByText('Remote Claude answer',{exact:true}).waitFor();held();
 await page.waitForTimeout(50);
 assert.equal(await page.getByText('Stale response',{exact:true}).count(),0);
 assert.equal(await page.getByLabel('Reply draft').inputValue(),'');
 for(const viewport of [{width:360,height:800},{width:844,height:390}]){await page.setViewportSize(viewport);await checkModes();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
 await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await page.evaluate(()=>returned),1);await checkModes();assert.equal(await terminalMode.getAttribute('aria-pressed'),'true');if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:process.env.MODE_SCREENSHOTS+'/terminal.png'});await page.reload();assert.equal(await terminalMode.getAttribute('aria-pressed'),'true');await conversationMode.click();await page.reload();assert.equal(await conversationMode.getAttribute('aria-pressed'),'true');assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
