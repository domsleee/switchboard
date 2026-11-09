const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('the loading notice counts seconds, restarts for each chat and clears with the messages',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const releases=[],history=Array.from({length:40},(_,i)=>({role:'assistant',text:`Message ${i}. `+'Some content to read. '.repeat(12)}));
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.clock.install();
  await page.route('http://timer.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(url.pathname.startsWith('/api/chats/')){await new Promise(resolve=>releases.push(resolve));return route.fulfill({json:{messages:history,start_cursor:0,next_cursor:null}}).catch(()=>{});}
   if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'ready',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
  });
  await page.goto('http://timer.test/');
  const notice=page.locator('.conversation-notice'),time=page.locator('.conversation-loading-time');
  await page.getByText('Loading conversation…',{exact:true}).waitFor();
  assert.equal(await notice.textContent(),'Loading conversation…','A quick load never shows a count');
  await page.clock.runFor(1010);assert.equal(await time.textContent(),'1s');
  await page.clock.runFor(2000);assert.equal(await time.textContent(),'3s');
  assert.equal(await time.getAttribute('aria-hidden'),'true','Screen readers are not told every second');
  if(process.env.CONVERSATION_LOADING_SCREENSHOT)await page.screenshot({path:process.env.CONVERSATION_LOADING_SCREENSHOT,clip:{x:0,y:0,width:390,height:160}});
  await page.evaluate(()=>{current={...current,key:'pane2',pane:2,chatId:'chat-2'};SwitchboardConversation.update();});
  assert.equal(await time.textContent(),'','Another chat starts from zero');
  await page.clock.runFor(1010);assert.equal(await time.textContent(),'1s');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.getByRole('button',{name:'Conversation',exact:true}).click();
  await page.getByText('Loading conversation…',{exact:true}).waitFor();
  assert.equal(await time.textContent(),'','Returning from Terminal starts a new read from zero');
  await page.clock.runFor(1010);assert.equal(await time.textContent(),'1s');
  while(releases.length)releases.shift()();
  await page.locator('.conversation-message').first().waitFor();await page.clock.runFor(1000);
  assert.equal(await notice.isVisible(),false);assert.equal(await time.textContent(),'','The count clears once messages appear');
  await page.clock.runFor(2000);assert.equal(await time.textContent(),'','The count does not resume');
  assert.deepEqual(errors,[]);
 }finally{while(releases.length)releases.shift()();await browser.close();}
});
