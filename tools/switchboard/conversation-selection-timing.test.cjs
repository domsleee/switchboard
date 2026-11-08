const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

for(const mobile of [false,true])test(`chat selections report request, server and render time (${mobile?'phone':'desktop'})`,{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch(),timings=[],reads=[],gates=new Map();let serverTiming=true;
 const history=Array.from({length:100},(_,i)=>({role:'assistant',text:`Message ${i}. `+'Content to read. '.repeat(20)}));
 try{
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.clock.install();
  await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');localStorage.setItem('switchboard-mobile-view-mode','conversation');});
  await page.route('http://selection.test/**',async route=>{
   const url=new URL(route.request().url()),q=url.searchParams;
   if(url.pathname.startsWith('/api/diagnostics/')){if(url.pathname.endsWith('/conversation-shown'))timings.push(route.request().postDataJSON());return route.fulfill({status:204});}
   if(url.pathname.startsWith('/api/chats/')){
    reads.push({id:url.pathname.split('/').at(-1),limit:Number(q.get('limit')),tail:q.has('tail')});
    await gates.get(reads.at(-1).id);
    const end=q.has('before')?Number(q.get('before')):history.length,start=q.has('tail')||q.has('before')?Math.max(0,end-Number(q.get('limit'))):Number(q.get('cursor'));
    const messages=history.slice(start,Math.min(start+Number(q.get('limit')),end));
    return route.fulfill({headers:serverTiming?{'Server-Timing':'queue;dur=25,read;dur=450,index;dur=400,page;dur=25'}:{},json:{messages,start_cursor:start,previous_cursor:start||null,next_cursor:start+messages.length<end?start+messages.length:null}}).catch(()=>{});
   }
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',chatHost:'fixture',pane:1,agent:'codex',state:'ready',chatId:'private-chat-1'};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});window.selectChat=id=>{current={...current,key:'pane'+id,pane:id,chatId:'private-chat-'+id};SwitchboardConversation.update();};</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(url.pathname)),contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript'});
  });
  const waitTiming=async count=>{const done=timings.length>=count?Promise.resolve():page.waitForResponse(response=>response.url().endsWith('/conversation-shown')&&timings.length>=count);await page.clock.runFor(40);await done;assert.equal(timings.length,count);};
  await page.goto('http://selection.test/');await page.getByText(/^Message 99\./).waitFor();await waitTiming(1);
  assert.equal(timings[0].reason,'selection');assert.equal(timings[0].end,'history');
  assert.equal(reads[0].limit,15);assert.equal(await page.locator('.conversation-message').count(),15);
  let release;gates.set('private-chat-2',new Promise(resolve=>release=resolve));
  await Promise.all([page.waitForRequest(request=>request.url().includes('private-chat-2')),page.evaluate(()=>selectChat(2))]);
  await page.clock.runFor(650);assert.equal(timings.length,1,'Loading is not mistaken for a visible transcript');release();
  await page.getByText(/^Message 99\./).waitFor();await waitTiming(2);
  const slow=timings[1];assert.equal(slow.reason,'selection');assert.equal(slow.end,'history');assert.ok(slow.elapsed_ms>=650);assert.ok(slow.request_ms>=650);assert.equal(slow.remote,true);
  assert.equal(slow.queue_ms,25);assert.equal(slow.read_ms,450);assert.equal(slow.index_ms,400);assert.equal(slow.page_ms,25);assert.ok(Number.isInteger(slow.render_ms));
  await page.evaluate(()=>selectChat(1));await waitTiming(3);assert.equal(timings[2].end,'cached');assert.equal(timings[2].request_ms,undefined,'A cached selection does not attribute its background refresh to the visible wait');
  await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.evaluate(()=>selectChat(3));
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh"]').disabled);await page.clock.runFor(40);assert.equal(timings.length,3,'Hidden preloading is not a visible selection');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();await waitTiming(4);assert.equal(timings[3].reason,'mode');assert.equal(timings[3].end,'cached');
  let releaseSuperseded;gates.set('private-chat-4',new Promise(resolve=>releaseSuperseded=resolve));
  await Promise.all([page.waitForRequest(request=>request.url().includes('private-chat-4')),page.evaluate(()=>selectChat(4))]);
  await page.clock.runFor(100);await page.evaluate(()=>selectChat(1));await waitTiming(6);
  assert.equal(timings[4].end,'superseded');assert.equal(timings[5].end,'cached');releaseSuperseded();
  serverTiming=false;await page.evaluate(()=>selectChat(5));await page.getByText(/^Message 99\./).waitFor();await waitTiming(7);
  assert.equal(timings[6].end,'history');assert.ok(Number.isInteger(timings[6].request_ms));assert.equal(timings[6].read_ms,undefined,'Old peers do not supply invented backend timings');
  await page.evaluate(()=>{current={...current,key:'shell',agent:null,chatId:null};SwitchboardConversation.update();});await waitTiming(8);assert.equal(timings[7].end,'unbound');
  assert.doesNotMatch(JSON.stringify(timings),/private-chat|Message|fixture/);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
