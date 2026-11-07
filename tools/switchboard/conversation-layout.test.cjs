const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Conversation folds finished progress, keeps the live step, and gives code a copyable card',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const at=seconds=>new Date(Date.UTC(2026,10,8,10,0,seconds)).toISOString();
 const step=(text,seconds)=>({role:'assistant',phase:'commentary',text,timestamp:at(seconds)});
 const messages=[
  {role:'user',text:'Fix the flicker',timestamp:at(0)},
  step('Reading app.js',5),step('Reproduced it',30),
  {role:'assistant',text:'Fixed.\n\n```js\nconst a = "<b>";\n```',timestamp:at(72),markdown:[
   {type:'start',tag:'p'},{type:'text',text:'Fixed. Run '},{type:'code',text:'node tools/switchboard/focus.test.cjs'},{type:'end'},
   {type:'start',tag:'pre',lang:'js'},{type:'text',text:'const a = "<b>";\n'},{type:'end'}]},
  {role:'user',text:'And Windows?',timestamp:at(80)},
  step('Checking Windows',85),step('Still checking',90),
 ],escapes=[];
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);localStorage.setItem('switchboard-view-mode','conversation');});
  await page.route('http://layout.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/stream'))return route.fulfill({status:404,body:''});
   if(p==='/api/hosts/fixture/escape'){escapes.push(route.request().postDataJSON());return route.fulfill({json:{ok:true}});}
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{messages,start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',pane:1,title:'Fix',agent:'claude',state:'working',since:Math.floor(Date.now()/1000)-65,chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://layout.test/');await page.getByText('Checking Windows',{exact:true}).waitFor();
  // The finished run folds behind one summary; the run still in progress stays open.
  const summary=page.locator('.conversation-steps');
  assert.equal(await summary.count(),1);assert.equal(await summary.textContent(),'Claude worked for 1m 12s · 2 steps');
  assert.equal(await summary.getAttribute('aria-expanded'),'false');
  assert.equal(await page.getByText('Reading app.js',{exact:true}).isVisible(),false);
  assert.equal(await page.getByText('Checking Windows',{exact:true}).isVisible(),true);
  await summary.click();
  assert.equal(await page.getByText('Reading app.js',{exact:true}).isVisible(),true);
  assert.equal(await summary.getAttribute('aria-expanded'),'true');
  // Polling again keeps the reader's choice.
  await page.evaluate(()=>intervals.forEach(fn=>fn()));await page.waitForTimeout(100);
  assert.equal(await page.getByText('Reading app.js',{exact:true}).isVisible(),true);
  // The newest step moves into the live row, which counts from when the turn started.
  const live=page.locator('.conversation-working');
  assert.equal(await live.locator('.conversation-working-step').getAttribute('data-step'),'Still checking');
  assert.match(await live.locator('.conversation-working-time').textContent(),/^1m [56]s$/);
  assert.equal(await page.locator('.conversation-message.commentary.live').isVisible(),false);
  // Code gets a card with its language, highlighting built from text nodes, and a copy button.
  const card=page.locator('.conversation-code');
  assert.equal(await card.locator('.conversation-code-bar span').textContent(),'js');
  assert.equal(await card.locator('pre').textContent(),'const a = "<b>";');
  assert.equal(await card.locator('.tok-k').first().textContent(),'const');
  assert.equal(await card.locator('pre b').count(),0);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await card.getByRole('button',{name:'Copy code'}).click();
  await page.getByRole('button',{name:'Copy code'}).filter({hasText:'Copied'}).waitFor();
  // Long inline paths may break at their separators.
  assert.equal(await page.locator('p code wbr').count(),2);
  assert.equal(await page.locator('p code').textContent(),'node tools/switchboard/focus.test.cjs');
  // While the agent works, an empty composer offers Stop, which sends Esc to that pane.
  const stop=page.getByRole('button',{name:'Stop',exact:true}),send=page.getByRole('button',{name:'Send',exact:true});
  assert.equal(await stop.isVisible(),true);assert.equal(await send.isVisible(),false);
  await stop.click();await page.waitForFunction(()=>!document.querySelector('.conversation-stop').disabled);
  assert.deepEqual(escapes,[{session:'main',pane_id:1}]);
  await page.getByLabel('Reply draft').fill('More context');
  assert.equal(await stop.isVisible(),false);assert.equal(await send.isVisible(),true);
  await page.getByLabel('Reply draft').fill('');
  await page.evaluate(()=>{current.state='ready';SwitchboardConversation.update();});
  assert.equal(await stop.isVisible(),false);assert.equal(await send.isVisible(),true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
