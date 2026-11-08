const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Conversation shows the chat’s API cost only on computers chosen in Settings',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 let usage={cost_usd:1.2345,input_tokens:12,cache_write_tokens:3400,cache_read_tokens:56000,output_tokens:780,responses:3,unpriced_tokens:0};
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://cost.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.endsWith('/stream'))return route.fulfill({status:404});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{model:'claude-opus-5-5',project:'/work/switchboard',usage,messages:[{role:'assistant',text:'Done'}],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100vh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,title:'Switchboard',agent:'claude',state:'ready',chatId:'chat-1',showCost:false,frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://cost.test/');await page.getByText('Done',{exact:true}).waitFor();
  const cost=page.locator('.conversation-cost');
  assert.equal(await cost.isVisible(),false,'A subscription computer shows no cost');
  await page.evaluate(()=>{current.showCost=true;SwitchboardConversation.update();});
  assert.equal(await cost.textContent(),'$1.23');
  assert.match(await cost.getAttribute('title'),/cache read 56,000/);
  const [model,dollars]=await Promise.all([page.locator('.conversation-compose .conversation-model').boundingBox(),cost.boundingBox()]);
  assert.ok(Math.abs(model.y+model.height/2-(dollars.y+dollars.height/2))<3&&dollars.x>=model.x+model.width,'The cost follows the model in the composer');
  const breakdown=page.getByRole('dialog',{name:'API cost breakdown'});
  await cost.click();
  assert.equal(await breakdown.isVisible(),true,'Tapping the cost opens the breakdown');
  const values=await breakdown.locator('dt').evaluateAll(labels=>Object.fromEntries(labels.map(label=>[label.textContent,label.nextElementSibling.textContent])));
  assert.deepEqual(values,{'Input · cached':'56,000 tokens (94%)','Input · not cached':'12 tokens','Cache writes':'3,400 tokens','Output':'780 tokens'});
  const bounds=await breakdown.boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=390,'The breakdown fits a phone screen');
  await page.keyboard.press('Escape');assert.equal(await breakdown.isVisible(),false);
  await cost.focus();await page.keyboard.press('Enter');assert.equal(await breakdown.isVisible(),true,'The breakdown opens from the keyboard');
  // A pending model switch takes the space.

  await page.evaluate(()=>{current.pendingSwitch={label:'Codex'};SwitchboardConversation.update();});
  assert.equal(await cost.textContent(),'');
  assert.equal(await breakdown.isVisible(),false);
  await page.evaluate(()=>{delete current.pendingSwitch;SwitchboardConversation.update();});
  assert.equal(await cost.textContent(),'$1.23');
  // New responses update it; tokens from an unknown model make it a lower bound.
  usage={...usage,cost_usd:0.004,unpriced_tokens:900};
  await page.evaluate(()=>intervals.forEach(fn=>fn()));
  await page.waitForFunction(()=>document.querySelector('.conversation-cost').textContent==='≥ <$0.01');
  assert.match(await cost.getAttribute('title'),/900 tokens from models without a known price/);
  await page.setViewportSize({width:1280,height:800});await cost.click();
  assert.match(await breakdown.textContent(),/900 tokens from models without a known price/);
  await page.locator('.conversation-heading').click();assert.equal(await breakdown.isVisible(),false,'Clicking outside dismisses the breakdown');

  await page.evaluate(()=>{current.showCost=false;SwitchboardConversation.update();});
  assert.equal(await cost.textContent(),'');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
