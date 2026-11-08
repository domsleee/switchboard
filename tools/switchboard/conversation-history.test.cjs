const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

for(const mobile of [false,true])test(`older history survives a busy refresh and a failed read (${mobile?'phone':'desktop'})`,{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const history=Array.from({length:180},(_,i)=>({role:i%2?'assistant':'user',text:`Message ${i}. `+'Content to read. '.repeat(20)}));
 let holdPoll=false,releasePoll,pollStarted,failOlder=false,olderReads=0;
 try{
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);localStorage.setItem('switchboard-view-mode','conversation');});
  await page.route('http://history.test/**',async route=>{
   const url=new URL(route.request().url()),q=url.searchParams;
   if(url.pathname.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(url.pathname.startsWith('/api/chats/')){
    if(q.has('cursor')&&holdPoll){pollStarted();await new Promise(resolve=>releasePoll=resolve);}
    if(q.has('before')){olderReads++;if(failOlder)return route.abort();}
    const limit=Number(q.get('limit')),end=q.has('before')?Number(q.get('before')):history.length;
    const start=q.has('tail')||q.has('before')?Math.max(0,end-limit):Number(q.get('cursor'));
    const messages=history.slice(start,Math.min(start+limit,end));
    return route.fulfill({json:{messages,start_cursor:start,previous_cursor:start||null,next_cursor:start+messages.length<end?start+messages.length:null}});
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'ready',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(url.pathname)),contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript'});
  });
  await page.goto('http://history.test/');await page.getByText(/^Message 179\./).waitFor();
  const list=page.locator('.conversation-messages'),settled=()=>page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);
  const top=()=>list.evaluate(node=>new Promise(resolve=>{node.addEventListener('scroll',()=>resolve(),{once:true});node.scrollTop=0;}));
  await settled();await page.getByLabel('Reply draft').fill('Keep this draft');
  // Reach the top while the poll owns the request slot. There may be no more scroll events.
  holdPoll=true;const started=new Promise(resolve=>pollStarted=resolve);
  await page.evaluate(()=>intervals.forEach(fn=>fn()));await started;await top();
  assert.equal(olderReads,0);holdPoll=false;releasePoll();
  await page.getByText(new RegExp(`^Message ${180-(mobile?15:50)-50}\\.`)).waitFor();await settled();
  assert.equal(olderReads,1,'The refresh must service the reader waiting at the top');
  assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft');
  // A failed older read exposes a retry which incoming output must not remove.
  failOlder=true;await top();const retry=page.getByRole('button',{name:'Retry earlier messages',exact:true});await retry.waitFor();await settled();
  history.push({role:'assistant',text:'A new answer while reading history'});
  await page.evaluate(()=>intervals.forEach(fn=>fn()));await page.getByText('A new answer while reading history',{exact:true}).waitFor({state:'attached'});await settled();
  assert.equal(await retry.isVisible(),true,'Live updates keep the failed history request recoverable');
  assert.equal(olderReads,2,'A failed request waits for an explicit retry');
  failOlder=false;await retry.click();await page.getByText(new RegExp(`^Message ${180-(mobile?15:50)-100}\\.`)).waitFor();await settled();
  assert.equal(await retry.isVisible(),false);assert.equal(olderReads,3);
  // Terminal mode stops history work and returning keeps the transcript and draft.
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.evaluate(()=>intervals.forEach(fn=>fn()));assert.equal(olderReads,3);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  assert.equal(await page.getByLabel('Reply draft').inputValue(),'Keep this draft');assert.deepEqual(errors,[]);
 }finally{releasePoll?.();await browser.close();}
});
