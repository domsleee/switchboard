const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');

test('an ambiguous earlier reply can be discarded without replaying it or losing later input',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const question of [false,true]){
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(5000);
  const errors=[],sends=[],deletes=[];page.on('pageerror',error=>errors.push(error.message));
  const thread='00000000-0000-4000-8000-000000000001',blocker={send_key:'old-terminal-send',message:'Ship the earlier change'};
  const detail='Saved. An earlier terminal submission is unconfirmed; check the conversation before resending. Later messages remain in order.';
  let receipt='review',acceptDiscard=false;
  const history=question?[{role:'assistant',text:'Continue?',phase:'final',async_question:{id:'question-1',questions:[{title:'Continue?',options:['Yes','No']}]}}]:[{role:'assistant',text:'Ready for your next message.'}];
  await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);let clock=Date.now();Date.now=()=>clock;window.advance=()=>clock+=6000;});
  await page.route('http://recovery.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname.endsWith('/codex/reply')){
    if(route.request().method()==='DELETE'){deletes.push(Object.fromEntries(url.searchParams));receipt='pending';return route.fulfill({json:{status:'cancelled'}});}
    sends.push(route.request().postDataJSON());return route.fulfill({json:{status:'queued'}});
   }
   if(url.pathname.endsWith('/codex/receipt'))return route.fulfill({json:{status:receipt,...receipt==='review'&&{detail,blocked_by:blocker}}});
   if(url.pathname.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(url.pathname.endsWith('/skills'))return route.fulfill({json:{skills:[]}});
   if(url.pathname.startsWith('/api/chats/'))return route.fulfill({json:{session_id:thread,messages:history,start_cursor:0,next_cursor:null}});
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'working',chatId:'codex-chat',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`});
   const source=url.pathname==='/conversation.js'&&process.env.RECOVERY_BASELINE?process.env.RECOVERY_BASELINE:url.pathname==='/conversation.css'&&process.env.RECOVERY_BASELINE_CSS?process.env.RECOVERY_BASELINE_CSS:path.join(__dirname,'static',path.basename(url.pathname));
   return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:source});
  });
  page.on('dialog',async dialog=>{assert.match(dialog.message(),/Ship the earlier change/);assert.match(dialog.message(),/Later saved replies will continue/);await(acceptDiscard?dialog.accept():dialog.dismiss());});
  await page.goto('http://recovery.test/');
  const draft=page.getByLabel('Reply draft'),outgoing=page.locator('.conversation-outgoing');
  if(question)await page.getByRole('button',{name:'Yes',exact:true}).click();
  else{await draft.fill('Continue with the next change');await page.getByRole('button',{name:'Send',exact:true}).click();}
  await page.waitForFunction(()=>!document.querySelector('button[aria-label=Refresh]').disabled);
  const poll=async()=>{await page.evaluate(()=>{advance();intervals.forEach(fn=>fn());});await page.waitForFunction(()=>!document.querySelector('button[aria-label=Refresh]').disabled);};
  await poll();await page.getByText(detail,{exact:true}).waitFor();
  if(!question&&process.env.RECOVERY_SCREENSHOTS){
   fs.mkdirSync(process.env.RECOVERY_SCREENSHOTS,{recursive:true});
   await outgoing.evaluate((node,before)=>{node.style.outline='2px solid '+(before?'#ef7979':'#72ce98');const note=document.createElement('span');note.textContent=before?'No recovery action':'Discard the saved blocker';note.style.cssText='display:block;margin-bottom:8px;font:12px system-ui;color:'+(before?'#ef7979':'#72ce98');node.prepend(note);},!!process.env.RECOVERY_BASELINE);
   await page.screenshot({path:path.join(process.env.RECOVERY_SCREENSHOTS,process.env.RECOVERY_BASELINE?'recovery-before.png':'recovery-after.png'),clip:{x:10,y:Math.max(0,(await outgoing.boundingBox()).y-35),width:370,height:300}});
  }
  if(process.env.RECOVERY_BASELINE){await page.close();break;}
  await draft.fill('Keep my next thought');
  const discard=page.getByRole('button',{name:'Discard saved reply',exact:true});await discard.click();
  assert.equal(deletes.length,0,'Dismissing confirmation must leave the saved reply alone');
  acceptDiscard=true;await discard.click();await page.waitForFunction(()=>!document.body.textContent.includes('An earlier terminal submission is unconfirmed'));
  assert.deepEqual(deletes,[{thread,send_key:blocker.send_key}],'Discard targets the earlier blocker, never its follower');
  assert.equal(sends.length,1,'Recovery must never replay either reply');
  assert.equal(await draft.inputValue(),'Keep my next thought');
  if(!question)assert.equal(await outgoing.count(),1,'The later saved reply stays visible');
  // Another browser may resolve a blocker: keep checking after the warning.
  receipt='review';await poll();await page.getByText(detail,{exact:true}).waitFor();
  receipt='pending';await poll();await page.waitForFunction(()=>!document.body.textContent.includes('An earlier terminal submission is unconfirmed'));
  assert.equal(deletes.length,1);assert.equal(sends.length,1);assert.deepEqual(errors,[]);
  await page.close();
 }}finally{await browser.close();}
});
