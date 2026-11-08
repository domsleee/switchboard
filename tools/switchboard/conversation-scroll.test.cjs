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
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204,body:''});
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

// Long runs of progress steps fold away, so the newest page can be far shorter than the list.
const folded=Array.from({length:120},(_,i)=>i%30===29?{role:'assistant',phase:'final_answer',text:`Answer ${i} `+'A paragraph of the final answer. '.repeat(40),timestamp:new Date(17e11+i*1000).toISOString()}:{role:'assistant',phase:'commentary',text:`Step ${i}`,timestamp:new Date(17e11+i*1000).toISOString()});
const fixture=async(browser,host,older,mode='conversation')=>{
 const page=await browser.newPage({viewport:{width:1280,height:800}});page.setDefaultTimeout(5000);
 const errors=[],reads=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(value=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode',value);},mode);
 await page.route(`http://${host}/**`,async route=>{
  const url=new URL(route.request().url()),p=url.pathname,q=url.searchParams;
  if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204,body:''});
  if(p.endsWith('/stream'))return route.fulfill({status:404,body:''});
  if(p.startsWith('/api/chats/')){
   reads.push({id:p.split('/').at(-1),limit:q.get('limit'),tail:q.get('tail'),context:q.get('context'),before:q.get('before'),host:q.get('host')});
   if(q.has('before'))await older();
   const end=q.has('before')?Number(q.get('before')):folded.length,limit=Number(q.get('limit')),start=q.has('tail')||q.has('before')?Math.max(0,end-limit):Number(q.get('cursor'));
   return route.fulfill({json:{messages:folded.slice(start,end),start_cursor:start,next_cursor:end<folded.length?end:null}}).catch(()=>{});
  }
  if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.tab=n=>({key:'pane'+n,host:'fixture',chatHost:'local',session:'main',pane:n,title:'T'+n,agent:'claude',state:'ready',chatId:'chat-'+n,frame:document.getElementById('terminal')});window.current=tab(1);window.viewedKeys=[];SwitchboardConversation.install({selection:(item=current)=>item,terminal(){},viewed:item=>viewedKeys.push(item.key)});</script>`});
  return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
 });
 await page.goto(`http://${host}/`);
 return {page,errors,reads,list:page.locator('.conversation-messages')};
};
const seen=list=>list.evaluate(node=>getComputedStyle(node).visibility==='visible');
const atBottom=list=>list.evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight<2);

test('A first page too short to fill the list appears once, at the bottom, with the older messages',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  let release;const gate=new Promise(resolve=>release=resolve);
  const {page,errors,reads,list}=await fixture(browser,'settle.test',()=>gate);
  await page.waitForFunction(()=>document.querySelector('.conversation-messages .conversation-message'));
  await page.waitForFunction(()=>document.querySelector('.conversation-messages').classList.contains('settling'));
  assert.equal(await seen(list),false,'A short first page stays hidden');
  assert.equal(await page.locator('.conversation-notice').isVisible(),true,'The loading notice stays up meanwhile');
  release();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.conversation-messages')).visibility==='visible');
  assert.equal(await atBottom(list),true,'It opens at the newest message');
  assert.equal(await page.locator('.conversation-notice').isVisible(),false);
  assert.deepEqual(reads.map(read=>[read.tail,read.before]),[['true',null],[null,'105']]);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('A held first page is reviewed only when it appears, and never for a tab left during the hold',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  let release;const gate=new Promise(resolve=>release=resolve);
  const {page,errors}=await fixture(browser,'viewed.test',()=>gate);
  const settling=()=>page.waitForFunction(()=>document.querySelector('.conversation-messages').classList.contains('settling'));
  const viewed=()=>page.evaluate(()=>viewedKeys);
  await settling();assert.equal(await page.evaluate(()=>document.hasFocus()),true);
  assert.deepEqual(await viewed(),[],'Hidden messages are not reviewed');
  await Promise.all([page.waitForResponse(response=>response.url().includes('chat-2')),page.evaluate(()=>{current=tab(2);SwitchboardConversation.update();})]);
  await settling();assert.deepEqual(await viewed(),[],'Leaving during the hold reviews neither tab');
  release();
  await page.waitForFunction(()=>viewedKeys.length>0);
  assert.deepEqual(await viewed(),['pane2'],'Only the tab on screen is reviewed, once it appears');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('A stalled read of older messages does not keep the first page hidden',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const {page,errors}=await fixture(browser,'stall.test',()=>new Promise(()=>{}));
  await page.waitForFunction(()=>document.querySelector('.conversation-messages').classList.contains('settling'));
  const started=Date.now();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.conversation-messages')).visibility==='visible');
  assert.ok(Date.now()-started<2000,'The page shows within the limit');
  assert.equal(await page.locator('.conversation-notice').isVisible(),false,'The loading notice clears with it');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('Hovering a tab warms its first page once, and only in Conversation',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const open=await fixture(browser,'warm.test',async()=>{});
  await open.page.waitForFunction(()=>document.querySelector('.conversation-messages .conversation-message'));
  await open.page.waitForFunction(()=>!document.querySelector('.conversation-messages').classList.contains('settling'));
  const count=reads=>reads.filter(read=>read.id==='chat-2').length;
  await Promise.all([open.page.waitForResponse(response=>response.url().includes('chat-2')),open.page.evaluate(()=>SwitchboardConversation.warm(tab(2)))]);
  assert.deepEqual(open.reads.find(read=>read.id==='chat-2'),{id:'chat-2',limit:'15',tail:'true',context:'true',before:null,host:'local'},'It asks for the page the click will ask for');
  await open.page.evaluate(()=>{SwitchboardConversation.warm(tab(2));SwitchboardConversation.warm(tab(1));SwitchboardConversation.warm({...tab(3),chatId:null});});
  await open.page.waitForTimeout(100);
  assert.equal(count(open.reads),1,'A second hover does not read again');
  assert.equal(open.reads.filter(read=>read.id==='chat-1'&&read.tail).length,1,'The open conversation is not warmed');
  assert.equal(open.reads.filter(read=>read.id==='chat-3').length,0,'A tab without a chat is not warmed');
  assert.deepEqual(open.errors,[]);
  const terminal=await fixture(browser,'warm-terminal.test',async()=>{},'terminal');
  await terminal.page.waitForFunction(()=>globalThis.SwitchboardConversation?.warm);
  await terminal.page.evaluate(()=>SwitchboardConversation.warm(tab(2)));await terminal.page.waitForTimeout(100);
  assert.equal(count(terminal.reads),0,'Terminal mode reads nothing on hover');
  assert.equal(await terminal.page.evaluate(()=>document.querySelector('.conversation-messages').classList.contains('settling')),false);
  assert.deepEqual(terminal.errors,[]);
 }finally{await browser.close();}
});

for(const mobile of [false,true])test(`live replies preserve upward scrolling and the message being read (${mobile?'phone':'desktop'})`,
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const messages=Array.from({length:40},(_,i)=>({role:i%2?'assistant':'user',text:`Message ${i} `+'Content to read. '.repeat(30)}));
 try{
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);localStorage.setItem('switchboard-view-mode','conversation');});
  await page.route('http://reading.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{messages,start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',pane:1,title:'Reading',agent:'codex',state:'working',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://reading.test/');await page.getByText(/^Message 39 /).waitFor();
  const list=page.locator('.conversation-messages');
  const settled=()=>page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const scrollUp=distance=>list.evaluate((node,distance)=>new Promise(resolve=>{node.addEventListener('scroll',()=>resolve(node.scrollTop),{once:true});node.dispatchEvent(new Event('touchmove'));node.scrollTop-=distance;}),distance);
  const poll=async()=>{await page.evaluate(()=>intervals.forEach(fn=>fn()));await settled();await frames();};
  await settled();await frames();
  // A short first gesture must be enough to stop following a streaming reply.
  const position=await scrollUp(40);
  messages.push({role:'assistant',text:'New output while the reader scrolls up'});await poll();
  assert.equal(await list.evaluate(node=>node.scrollTop),position,'A short upward gesture must not snap back to the latest reply');
  // A refresh can change a message above the viewport, not just append output.
  await scrollUp(600);
  const anchor=await list.evaluate(node=>{const top=node.getBoundingClientRect().top,entry=[...node.querySelectorAll('.conversation-message')].find(item=>item.getBoundingClientRect().bottom>top+40);return {id:entry.dataset.conversationEntry,top:entry.getBoundingClientRect().top};});
  messages[0]={...messages[0],text:messages[0].text+' More earlier content. '.repeat(100)};await poll();
  const after=await page.locator(`[data-conversation-entry="${anchor.id}"]`).evaluate(node=>node.getBoundingClientRect().top);
  assert.ok(Math.abs(after-anchor.top)<1,'A changed earlier message must preserve the message being read');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.getByRole('button',{name:'Conversation',exact:true}).click();await settled();await frames();
  assert.ok(Math.abs(await page.locator(`[data-conversation-entry="${anchor.id}"]`).evaluate(node=>node.getBoundingClientRect().top)-anchor.top)<1,'Returning from Terminal keeps the reading position');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
