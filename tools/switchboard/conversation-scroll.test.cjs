const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Conversation keeps the reader in place in the same frame and shows the scrollbar only for their own scrolling',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const messages=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',text:`Message ${i} `+'with enough text to wrap onto a second line. '.repeat(4)}));
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);localStorage.setItem('switchboard-view-mode','conversation');});
  await page.route('http://scroll.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/stream'))return route.fulfill({status:404,body:''});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{messages,start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',pane:1,title:'Scroll',agent:'claude',state:'ready',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://scroll.test/');await page.getByText(/^Message 39 /).waitFor();await page.waitForTimeout(200);
  const list=page.locator('.conversation-messages');
  // Scrolling the page does itself (following new output) leaves the scrollbar hidden.
  await list.evaluate(node=>{node.scrollTop=node.scrollHeight;});await page.waitForTimeout(50);
  assert.equal(await list.evaluate(node=>node.classList.contains('scrolling')),false);
  assert.equal(await list.evaluate(node=>getComputedStyle(node).scrollbarColor),'rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)');
  // The reader's own scrolling shows it.
  await page.mouse.move(640,400);await page.mouse.wheel(0,-600);await page.waitForTimeout(100);
  assert.equal(await list.evaluate(node=>node.classList.contains('scrolling')),true);
  // Something above the reader grows: by the next frame the reader has not moved.
  const moved=await page.evaluate(async()=>{
   const list=document.querySelector('.conversation-messages'),top=list.getBoundingClientRect().top;
   const anchor=[...list.querySelectorAll('.conversation-message')].find(node=>node.getBoundingClientRect().bottom>top+40);
   const before=anchor.getBoundingClientRect().top;
   const above=list.querySelector('.conversation-message'),grown=document.createElement('div');grown.style.height='300px';above.append(grown);
   // The frame after the change paints with the observer's correction already applied.
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   return Math.round(anchor.getBoundingClientRect().top-before);
  });
  assert.equal(moved,0,'The correction lands before the next frame paints');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
