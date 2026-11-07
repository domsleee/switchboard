const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('outgoing replies stay visible through queue acknowledgement and reconcile one-for-one',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const history=[{role:'user',text:'Same message'},{role:'assistant',text:'Earlier answer'}],requests=[];
 let held,hold=true,fail=false;
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://send.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/codex/reply')){requests.push(route.request().postDataJSON());if(fail)return route.abort();if(hold)await new Promise(resolve=>held=resolve);return route.fulfill({json:{status:'queued'}});}
   if(url.pathname.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',messages:history,start_cursor:0,next_cursor:null}});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'working',chatId:'codex-chat',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
  });
  await page.goto('http://send.test/');await page.getByText('Earlier answer',{exact:true}).waitFor();
  const draft=page.getByLabel('Reply draft'),send=page.getByRole('button',{name:'Send',exact:true}),outgoing=page.locator('.conversation-outgoing');
  const poll=async()=>{await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);await page.evaluate(()=>new Promise(requestAnimationFrame));};
  await draft.fill('Same message');await send.click();await outgoing.getByText('Sending…',{exact:true}).waitFor();
  assert.equal(await outgoing.count(),1);assert.equal(await draft.inputValue(),'Same message');
  await poll();assert.equal(await outgoing.count(),1,'Old matching transcript must not acknowledge a new send');
  hold=false;held();await outgoing.getByText('Waiting for agent…',{exact:true}).waitFor();
  assert.equal(await draft.inputValue(),'');assert.equal(await page.locator('.conversation-send-notice').isVisible(),false);
  // Two identical sends need two distinct transcript entries.
  await draft.fill('Same message');await send.click();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing.queued').length===2);
  assert.notEqual(requests[0].send_key,requests[1].send_key);
  await poll();assert.equal(await outgoing.count(),2);
  history.push({role:'user',text:'Same message'});await poll();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===1);
  await poll();assert.equal(await outgoing.count(),1,'A repeated poll cannot acknowledge a second send with the same entry');
  await page.evaluate(()=>{window.original=current;current={...current,key:'pane2',chatId:'other-chat'};SwitchboardConversation.update();});
  await page.getByText('Earlier answer',{exact:true}).waitFor();assert.equal(await outgoing.count(),0);
  await page.evaluate(()=>{current=original;SwitchboardConversation.update();});await outgoing.waitFor();
  history.push({role:'user',text:'Same message'});await poll();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  assert.equal(await page.locator('.conversation-message.user').count(),3);
  // Transcript may arrive before the HTTP acknowledgement.
  hold=true;await draft.fill('Fast transcript');await send.click();await outgoing.getByText('Sending…',{exact:true}).waitFor();
  history.push({role:'user',text:'Fast transcript'});await poll();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  hold=false;held();await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');
  assert.equal(await outgoing.count(),0);assert.equal(await page.locator('.conversation-send-notice').isVisible(),false);
  // Retry a native receipt without replacing a newly typed draft.
  fail=true;await draft.fill('Uncertain send');await send.click();await outgoing.getByRole('button',{name:'Retry'}).waitFor();
  const retryKey=requests.at(-1).send_key;await draft.fill('My next thought');fail=false;
  await outgoing.getByRole('button',{name:'Retry'}).click();await outgoing.getByText('Waiting for agent…',{exact:true}).waitFor();
  assert.equal(requests.at(-1).send_key,retryKey);assert.equal(await draft.inputValue(),'My next thought');
  history.push({role:'user',text:'Uncertain send'});await poll();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  // A superseded bridge timeout must not fail a later manual attempt.
  await page.evaluate(()=>{current.agent='claude';current.state='ready';window.pastes=[];window.timers=[];current.frame.contentWindow.postMessage=data=>pastes.push(data);const original=setTimeout;window.setTimeout=(fn,ms,...args)=>ms===4000?timers.push(fn):original(fn,ms,...args);});
  await draft.fill('Bridge reply');await send.click();
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:pastes[0].id,ok:false,error:'Fixture failure'}})));
  await outgoing.getByText('Fixture failure',{exact:true}).waitFor();await send.click();
  await page.evaluate(()=>timers[0]());assert.equal(await outgoing.count(),1);assert.equal(await outgoing.getByText('Sending…',{exact:true}).count(),1);
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:pastes[1].id,ok:true}})));
  await outgoing.getByText('Waiting for agent…',{exact:true}).waitFor();history.push({role:'user',text:'Bridge reply'});await poll();
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  assert.deepEqual(errors,[]);
 }finally{held?.();await browser.close();}
});
