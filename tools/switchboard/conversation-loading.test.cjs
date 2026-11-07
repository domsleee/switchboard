const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('conversation recovers from stalled reads, logs safe diagnostics and preserves reading position',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch(),diagnostics=[];
 let mode='hang',release,partial=false,reads=0;
 const history=Array.from({length:40},(_,i)=>({role:'assistant',text:`Message ${i}. `+'Some content to read. '.repeat(12)}));
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
  await page.addInitScript(()=>{window.polls=[];window.setInterval=fn=>polls.push(fn);});
  await page.route('http://loading.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/api/diagnostics/conversation'){diagnostics.push(route.request().postDataJSON());return route.fulfill({status:204});}
   if(url.pathname.startsWith('/api/chats/')){
    reads++;if(mode==='hang'){await new Promise(resolve=>release=resolve);return route.fulfill({json:{messages:[]}}).catch(()=>{});}
    if(mode==='invalid')return route.fulfill({json:{unexpected:'data'}});
    return route.fulfill({json:{messages:history,start_cursor:0,next_cursor:null,partial,partial_reasons:partial?['record_limit']:[]}});
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'working',chatId:'private-chat-id',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
  });
  await page.goto('http://loading.test/');await page.waitForFunction(()=>document.querySelector('.conversation-panel')&&!document.querySelector('.conversation-panel').hidden);
  await page.clock.runFor(15010);await page.getByText('Loading took too long. Retrying…',{exact:true}).waitFor();
  assert.equal(diagnostics[0].outcome,'timeout');assert.equal(diagnostics[0].phase,'initial');
  mode='ok';release();const poll=async()=>{await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>polls.forEach(fn=>fn()))]);await page.clock.runFor(30);};
  await poll();await page.locator('.conversation-message').first().waitFor();assert.equal(await page.locator('.conversation-message').count(),40);
  assert.equal(diagnostics.at(-1).outcome,'recovered');assert.equal(await page.locator('.conversation-notice').isVisible(),false);
  await page.waitForFunction(()=>document.querySelector('.conversation-messages').classList.contains('scrolling'));await page.clock.runFor(750);assert.equal(await page.locator('.conversation-messages').evaluate(n=>getComputedStyle(n).scrollbarWidth),'none');
  await page.locator('.conversation-messages').evaluate(n=>new Promise(resolve=>{n.addEventListener('scroll',()=>resolve(),{once:true});n.scrollTop=150;}));
  await page.clock.runFor(800);assert.equal(await page.locator('.conversation-messages').evaluate(n=>getComputedStyle(n).scrollbarWidth),'none');
  const position=await page.locator('.conversation-messages').evaluate(n=>n.scrollTop);history.push({role:'assistant',text:'A fresh answer'});await poll();
  assert.equal(await page.locator('.conversation-messages').evaluate(n=>n.scrollTop),position);
  await page.getByRole('button',{name:'Scroll to bottom',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Scroll to bottom',exact:true}).textContent(),'↓ New messages');
  if(process.env.CONVERSATION_SCROLL_SCREENSHOT)await page.screenshot({path:process.env.CONVERSATION_SCROLL_SCREENSHOT});
  await page.getByRole('button',{name:'Scroll to bottom',exact:true}).click();await page.clock.runFor(30);assert.equal(await page.getByRole('button',{name:'Scroll to bottom',exact:true}).isVisible(),false);
  partial=true;await poll();await page.getByText('An oversized history record was skipped. Later messages can still load.',{exact:true}).waitFor();
  assert.equal(diagnostics.at(-1).outcome,'partial');const count=diagnostics.length;await poll();assert.equal(diagnostics.length,count,'Repeated partial reads do not flood browser diagnostics');
  partial=false;mode='invalid';await poll();await page.getByText('The conversation response was incomplete. Retrying…',{exact:true}).waitFor();assert.equal(await page.locator('.conversation-message').count(),41,'Failed reads preserve visible history');
  mode='ok';await poll();assert.equal(await page.locator('.conversation-notice').isVisible(),false);
  for(const d of diagnostics)assert.deepEqual(Object.keys(d).sort(),['elapsed_ms','outcome','phase']);assert.doesNotMatch(JSON.stringify(diagnostics),/private-chat-id|fresh answer|Some content/);
  await page.getByRole('button',{name:'Terminal',exact:true}).click();const priorReads=reads;await page.evaluate(()=>polls.forEach(fn=>fn()));assert.equal(reads,priorReads);
  assert.deepEqual(errors,[]);
 }finally{release?.();await browser.close();}
});
