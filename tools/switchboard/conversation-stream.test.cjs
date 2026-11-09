const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');

test('conversation streams updates and restores cached tabs synchronously without terminal viewers',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const streams=[],preparations=[],errors=[];let hold=false,held,reads=0;
 const history=[{role:'user',text:'Question'},{role:'assistant',text:'Initial reply'}];
 const pageData=(id,messages=history,start_cursor=0)=>({id,session_id:'12345678-1234-1234-1234-123456789abc',messages,start_cursor,next_cursor:null,stream:true});
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.endsWith('/stream')){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});res.write('retry: 20\n\n');streams.push({id:url.pathname.split('/')[3],res,url});return;
  }
  if(url.pathname.startsWith('/api/chats/')){
   reads++;const id=url.pathname.split('/').at(-1);const reply=()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(pageData(id,id==='chat-2'?[{role:'assistant',text:'Other chat'}]:history)));};
   if(hold){held=reply;return;}return reply();
  }
  if(url.pathname.endsWith('/conversation/prepare')){
   let body='';req.on('data',data=>body+=data);req.on('end',()=>{preparations.push(JSON.parse(body));res.setHeader('Content-Type','application/json');res.end('{"trusted":true}');});return;
  }
  if(url.pathname==='/api/diagnostics/conversation'){res.writeHead(204);return res.end();}
  if(url.pathname==='/'){
   res.setHeader('Content-Type','text/html');return res.end(`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',tab:1,pane:1,agent:'codex',state:'working',chatId:'chat-1',frame:document.getElementById('terminal')};window.terminals=0;SwitchboardConversation.install({selection:()=>current,terminal:()=>terminals++});</script>`);
  }
  const file=path.join(__dirname,'static',path.basename(url.pathname));if(!fs.existsSync(file)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const wait=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('Timed out waiting for fixture connection');};
 const push=(connection,data)=>connection.res.write('event: page\ndata: '+JSON.stringify(data)+'\n\n');
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);await page.getByText('Initial reply',{exact:true}).waitFor();await wait(()=>streams.length===1);
  assert.equal(streams[0].url.searchParams.get('cursor'),'1');
  push(streams[0],pageData('chat-1',[{role:'assistant',text:'Hel'}],1));await page.getByText('Hel',{exact:true}).waitFor();
  await page.locator('.conversation-message.user').evaluate(node=>node.dataset.retained='yes');
  push(streams[0],pageData('chat-1',[{role:'assistant',text:'Hello streamed reply'}],1));await page.getByText('Hello streamed reply',{exact:true}).waitFor();
  assert.equal(await page.locator('.conversation-message.user').getAttribute('data-retained'),'yes');assert.equal(await page.locator('.conversation-message.assistant').count(),1);
  assert.equal(await page.evaluate(()=>terminals),0);assert.equal(await page.locator('#terminal').getAttribute('src'),null);
  // Healthy streams replace repeated browser polling.
  await page.waitForTimeout(2100);assert.equal(reads,1);
  await page.evaluate(()=>{window.first=current;current={...current,key:'pane2',pane:2,tab:2,chatId:'chat-2'};SwitchboardConversation.update();});
  await page.getByText('Other chat',{exact:true}).waitFor();await wait(()=>streams.length===2);
  push(streams[0],pageData('chat-1',[{role:'assistant',text:'Stale stream'}],1));
  assert.equal(await page.getByText('Other chat',{exact:true}).count(),1);
  hold=true;
  const immediate=await page.evaluate(()=>{current=first;SwitchboardConversation.update();return document.querySelector('.conversation-messages').textContent;});
  assert.match(immediate,/Hello streamed reply/);assert.doesNotMatch(immediate,/Other chat|Stale stream/);
  await wait(()=>!!held&&streams.length===3);
  push(streams[2],pageData('chat-1',[{role:'assistant',text:'Newer than the pending refresh'}],1));
  await page.waitForTimeout(50);hold=false;held();held=null;
  await page.getByText('Newer than the pending refresh',{exact:true}).waitFor();
  history.push({role:'assistant',text:'Arrived during the outage'});
  streams[2].res.destroy();await wait(()=>streams.length>=4);
  assert.equal(streams.at(-1).url.searchParams.get('cursor'),'2','A reconnect resumes from the loaded transcript, not the old URL');
  push(streams.at(-1),pageData('chat-1',[{role:'assistant',text:'Reconnected reply'}],1));await page.getByText('Reconnected reply',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();
  await page.evaluate(()=>{current={...current,key:'startup',pane:7,tab:8,chatId:null,state:'unknown'};SwitchboardConversation.update();});
  assert.equal(preparations.length,0,'Terminal mode does not automate setup');
  await page.getByRole('button',{name:'Conversation',exact:true}).click();await wait(()=>preparations.length===1);
  assert.deepEqual(preparations,[{session:'main',tab_id:8,pane_id:7}]);
  assert.equal(await page.evaluate(()=>terminals),1,'Startup setup must not attach a terminal');
  // Desktop preloads the selected chat while Terminal is visible. Opening
  // Conversation renders it before a deliberately stalled network refresh.
  history.push(...Array.from({length:30},(_,i)=>({role:'assistant',text:'Prefetched '+i+' '+('Reading content. '.repeat(30))})));
  const desktop=await browser.newPage({viewport:{width:1200,height:800}});desktop.on('pageerror',error=>errors.push(error.message));
  await desktop.goto('http://127.0.0.1:'+server.address().port);await desktop.waitForFunction(()=>document.querySelector('[aria-label="Refresh"]')?.disabled===false);
  assert.equal(await desktop.locator('.conversation-message').count(),0);
  hold=true;
  const prefetched=await desktop.evaluate(()=>{[...document.querySelectorAll('button')].find(button=>button.textContent==='Conversation').click();const list=document.querySelector('.conversation-messages');return {text:list.textContent,gap:list.scrollHeight-list.scrollTop-list.clientHeight};});
  assert.match(prefetched.text,/Prefetched 29/);assert.ok(prefetched.gap<80,'Prefetched chat opens at the latest output');
  await wait(()=>!!held);hold=false;held();held=null;
  assert.deepEqual(errors,[]);
 }finally{held?.();await browser.close();for(const {res} of streams)res.destroy();await new Promise(resolve=>server.close(resolve));}
});
