const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
test('outgoing replies stay visible through queue acknowledgement and reconcile one-for-one',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const history=[{role:'user',text:'Same message'},{role:'assistant',text:'Earlier answer'}],requests=[];
 let held,hold=true,fail=false,relay=404,relayNotice,relayHold;const replies=[];
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);});
  await page.route('http://send.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/conversation/reply')){replies.push(route.request().postDataJSON());await relayHold;return relay===200?route.fulfill({json:{ok:true,...relayNotice&&{draft:'stashed',notice:relayNotice}}}):route.fulfill({status:relay,body:relay===409?'Claude is not at its prompt. Open Terminal to see what it needs.':''});}
   if(url.pathname.endsWith('/codex/reply')){requests.push(route.request().postDataJSON());if(fail)return route.abort();if(hold)await new Promise(resolve=>held=resolve);return route.fulfill({json:{status:'queued'}});}
   if(url.pathname.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',messages:history,start_cursor:0,next_cursor:null}});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'working',chatId:'codex-chat',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
  });
  await page.goto('http://send.test/');await page.getByText('Earlier answer',{exact:true}).waitFor();
  const draft=page.getByLabel('Reply draft'),send=page.getByRole('button',{name:'Send',exact:true}),outgoing=page.locator('.conversation-outgoing');
  const poll=async()=>{await page.waitForFunction(()=>!document.querySelector('button[aria-label=Refresh]').disabled);await Promise.all([page.waitForResponse(r=>r.url().includes('/api/chats/')),page.evaluate(()=>intervals.forEach(fn=>fn()))]);await page.waitForFunction(()=>!document.querySelector('button[aria-label=Refresh]').disabled);};
  await draft.fill('Same message');await send.click();await outgoing.getByText('Sending…',{exact:true}).waitFor();
  assert.equal(await outgoing.count(),1);assert.equal(await draft.inputValue(),'Same message');
  await poll();assert.equal(await outgoing.count(),1,'Old matching transcript must not acknowledge a new send');
  hold=false;held();await outgoing.getByText('Queued',{exact:true}).waitFor();
  const status=await outgoing.locator('.conversation-outgoing-status').boundingBox();assert.ok(status.width<=1&&status.height<=1,'A queued message shows no status words');
  assert.equal(await outgoing.evaluate(node=>getComputedStyle(node).opacity),'0.6','A queued message shows faded');
  assert.equal(await draft.inputValue(),'');assert.equal(await page.locator('.conversation-send-notice').isVisible(),false);assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),true);
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
  assert.equal(await page.locator('.conversation-message.user').count(),3);assert.equal(await page.evaluate(()=>SwitchboardConversation.hasUnsentWork()),false);
  // Transcript may arrive before the HTTP acknowledgement.
  hold=true;await draft.fill('Fast transcript');await send.click();await outgoing.getByText('Sending…',{exact:true}).waitFor();
  history.push({role:'user',text:'Fast transcript'});await poll();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  hold=false;held();await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');
  assert.equal(await outgoing.count(),0);assert.equal(await page.locator('.conversation-send-notice').isVisible(),false);
  // Retry a native receipt without replacing a newly typed draft.
  fail=true;await draft.fill('Uncertain send');await send.click();await outgoing.getByRole('button',{name:'Retry'}).waitFor();
  const retryKey=requests.at(-1).send_key;await draft.fill('My next thought');fail=false;
  await outgoing.getByRole('button',{name:'Retry'}).click();await outgoing.getByText('Queued',{exact:true}).waitFor();
  assert.equal(requests.at(-1).send_key,retryKey);assert.equal(await draft.inputValue(),'My next thought');
  history.push({role:'user',text:'Uncertain send'});await poll();await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  // A superseded bridge timeout must not fail a later manual attempt.
  await page.evaluate(()=>{current.agent='claude';current.state='ready';window.pastes=[];window.timers=[];current.frame.contentWindow.postMessage=data=>pastes.push(data);const original=setTimeout;window.setTimeout=(fn,ms,...args)=>ms===4000?timers.push(fn):original(fn,ms,...args);});
  await draft.fill('Bridge reply');await send.click();await page.waitForFunction(()=>pastes.length===1);
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:pastes[0].id,ok:false,error:'Fixture failure'}})));
  await outgoing.getByText('Fixture failure',{exact:true}).waitFor();await send.click();await page.waitForFunction(()=>pastes.length===2);
  await page.evaluate(()=>timers[0]());assert.equal(await outgoing.count(),1);assert.equal(await outgoing.getByText('Sending…',{exact:true}).count(),1);
  await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:pastes[1].id,ok:true}})));
  await outgoing.getByText('Sent',{exact:true}).waitFor();history.push({role:'user',text:'Bridge reply'});await poll();
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  // The transcript may acknowledge a bridge send before its result says where a terminal draft went.
  const stashNotice="Your terminal draft is in Claude's stash. Press Ctrl+S on its empty prompt to bring it back.";
  await draft.fill('Bridge acknowledged first');await send.click();await page.waitForFunction(()=>pastes.length===3);
  history.push({role:'user',text:'Bridge acknowledged first'});await poll();
  await page.waitForFunction(()=>document.querySelectorAll('.conversation-outgoing').length===0);
  await page.evaluate(notice=>window.dispatchEvent(new MessageEvent('message',{origin:location.origin,source:current.frame.contentWindow,data:{type:'zellij-conversation-paste-result',id:pastes[2].id,ok:true,error:'',notice}})),stashNotice);
  await page.getByText(stashNotice,{exact:true}).waitFor();
  // A current relay types Claude replies itself; the terminal is never used.
  relay=409;await draft.fill('Relay reply');await send.click();
  await outgoing.getByText('Claude is not at its prompt. Open Terminal to see what it needs.',{exact:true}).waitFor();
  relay=200;await send.click();await outgoing.getByText('Queued',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>pastes.length),3);
  assert.deepEqual(replies.at(-1),{pane_id:1,text:'Relay reply'});
  assert.equal(await draft.inputValue(),'');
  // The relay sets a terminal draft aside; if Claude did not restore it, say where it is.
  relayNotice="Your terminal draft is in Claude's stash. Press Ctrl+S on its empty prompt to bring it back.";
  await draft.fill('Over a draft');await send.click();await page.getByText(relayNotice,{exact:true}).waitFor();
  assert.equal(await draft.inputValue(),'');
  // The relay waits for the draft to come back; the transcript may acknowledge the reply first.
  let release;relayHold=new Promise(resolve=>release=resolve);
  await draft.fill('Acknowledged first');await send.click();await page.waitForFunction(()=>document.querySelector('.conversation-outgoing'));
  await page.waitForFunction(()=>document.querySelector('.conversation-send-notice').hidden);
  history.push({role:'user',text:'Acknowledged first'});await poll();
  await page.waitForFunction(()=>![...document.querySelectorAll('.conversation-outgoing')].some(item=>item.textContent.includes('Acknowledged first')));
  release();await page.getByText(relayNotice,{exact:true}).waitFor();
  relayHold=null;relayNotice=undefined;
  // A turn that ended with background work still running takes replies.
  await page.evaluate(()=>{current.state='waiting';SwitchboardConversation.update();});
  await draft.fill('While waiting');await send.click();await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');
  assert.deepEqual(replies.at(-1),{pane_id:1,text:'While waiting'});
  await page.evaluate(()=>{current.state='approval';SwitchboardConversation.update();});
  const sent=replies.length;
  await draft.fill('Needs approval');await send.click();await page.getByText('The agent needs attention in Terminal. Your draft is kept.',{exact:true}).waitFor();
  assert.equal(replies.length,sent);assert.equal(await draft.inputValue(),'Needs approval');
  assert.deepEqual(errors,[]);
 }finally{held?.();await browser.close();}
});
