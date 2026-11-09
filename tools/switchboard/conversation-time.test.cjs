const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

const local=(month,day,hour,year=2026)=>new Date(year,month,day,hour,5).toISOString();
const messages=[
 {role:'user',text:'Older year',timestamp:local(11,30,8,2025)},
 {role:'assistant',text:'Earlier this year',timestamp:local(10,2,14)},
 {role:'user',text:'From yesterday',timestamp:local(10,8,20)},
 {role:'assistant',phase:'commentary',text:'Thinking aloud',timestamp:local(10,9,9)},
 {role:'assistant',text:'From today',timestamp:local(10,9,9)},
 {role:'user',text:'Newest',timestamp:local(10,9,10)},
];

async function open(browser,options={}){
 const context=await browser.newContext({locale:'en-US',viewport:{width:1280,height:900},...options}),page=await context.newPage();page.setDefaultTimeout(5000);
 await page.clock.setFixedTime(new Date(2026,10,9,15,0));
 await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');});
 await page.route('http://time.test/**',route=>{
  const p=new URL(route.request().url()).pathname;
  if(p.startsWith('/api/chats/')&&!p.endsWith('/stream'))return route.fulfill({json:{messages,start_cursor:0,next_cursor:null}});
  if(p.startsWith('/api/'))return route.fulfill({status:404,body:''});
  if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',pane:1,title:'Fix',agent:'claude',state:'ready',since:1,chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
  return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
 });
 await page.goto('http://time.test/');await page.getByText('Newest',{exact:true}).waitFor();
 return page;
}
const message=(page,text)=>page.locator('.conversation-message').filter({hasText:text});
const opacity=locator=>locator.evaluate(node=>getComputedStyle(node).opacity);

test('Conversation shows each message time on hover without moving the transcript',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await open(browser),time=text=>message(page,text).locator(':scope>.conversation-time');
  assert.match(await time('Newest').textContent(),/^10:05\sAM$/);
  assert.match(await time('From today').textContent(),/^9:05\sAM$/);
  assert.match(await time('From yesterday').textContent(),/^yesterday at 8:05\sPM$/);
  assert.match(await time('Earlier this year').textContent(),/^11\/2 2:05\sPM$/);
  assert.match(await time('Older year').textContent(),/^12\/30\/2025 8:05\sAM$/);
  assert.match(await time('Newest').getAttribute('title'),/^November 9, 2026 at 10:05\sAM$/);
  assert.equal(await message(page,'Thinking aloud').locator('.conversation-time').count(),0);

  assert.equal(await opacity(time('From today')),'0');
  const list=page.locator('.conversation-messages'),next=message(page,'Newest');
  const before=[await next.boundingBox(),await list.evaluate(node=>node.scrollHeight)];
  await message(page,'From today').hover();
  await page.waitForFunction(()=>[...document.querySelectorAll('.conversation-time')].some(node=>getComputedStyle(node).opacity==='1'));
  assert.deepEqual([await next.boundingBox(),await list.evaluate(node=>node.scrollHeight)],before);
  // The time sits in the gap, clear of the next message.
  assert.ok((await time('From today').boundingBox()).y+(await time('From today').boundingBox()).height<=before[0].y);

  // Hovering after midnight relabels a message rendered the day before.
  await page.clock.setFixedTime(new Date(2026,10,10,0,1));
  await message(page,'Newest').hover();
  assert.match(await time('Newest').textContent(),/^yesterday at 10:05\sAM$/);
 }finally{await browser.close();}
});

test('Conversation keeps message times visible on touch screens',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await open(browser,{viewport:{width:390,height:800},hasTouch:true,isMobile:true});
  assert.equal(await opacity(message(page,'Newest').locator(':scope>.conversation-time')),'1');
 }finally{await browser.close();}
});
