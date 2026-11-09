const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

for(const width of [1280,390])for(const native of [true,false]){
 test(`new Codex composer stays still while binding at ${width}px (${native?'native':'Terminal fallback'})`,{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  let release;
  try{
   const page=await browser.newPage({viewport:{width,height:844}}),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(()=>{
    localStorage.setItem('switchboard-view-mode','conversation');localStorage.setItem('switchboard-mobile-view-mode','conversation');
    window.setInterval=()=>0;
   });
   await page.route('http://startup-layout.test/**',async route=>{
    const p=new URL(route.request().url()).pathname;
    if(p==='/api/chats/chat-1'){
     await new Promise(resolve=>release=resolve);
     return route.fulfill({json:{session_id:native?'00000000-0000-4000-8000-000000000001':null,messages:[{role:'user',text:'First task'}],start_cursor:0,next_cursor:null}}).catch(()=>{});
    }
    if(p.startsWith('/api/'))return route.fulfill({json:{}});
    if(p==='/')return route.fulfill({contentType:'text/html',body:`
     <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css">
     <main id="terminals" style="height:100dvh;position:relative"><section id="artifact-preview" hidden></section></main>
     <script src="/conversation.js"></script><script>
      window.current={key:'launch',host:'fixture',agent:'codex',state:'working',terminalReady:false,
       launch:{text:'First task',at:Date.now()},requestedModel:{agent:'codex',model:'gpt-6.1-sol',reasoning_effort:'high'}};
      SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});
     </script>`});
    return route.fulfill({path:path.join(__dirname,'static',p.slice(1)),contentType:p.endsWith('.css')?'text/css':p.endsWith('.woff2')?'font/woff2':'text/javascript'});
   });
   await page.goto('http://startup-layout.test/');await page.evaluate(()=>document.fonts.ready);
   const form=page.locator('.conversation-compose'),draft=page.getByLabel('Reply draft'),notice=page.locator('.conversation-transport-notice');
   const initial=await form.boundingBox();
   await draft.fill('Follow up');
   await page.evaluate(()=>{current={...current,key:'pane1',session:'main',pane:1,tab:1};SwitchboardConversation.update();});
   assert.deepEqual(await form.boundingBox(),initial,'Creating the pane keeps the composer in place');
   await page.evaluate(()=>{current={...current,chatId:'chat-1'};SwitchboardConversation.update();});
   await page.waitForFunction(()=>document.querySelector('[aria-label="Refresh"]').disabled);
   if(process.env.STARTUP_LAYOUT_SCREENSHOTS&&native)await page.screenshot({path:path.join(process.env.STARTUP_LAYOUT_SCREENSHOTS,`startup-${width}.png`),clip:{x:0,y:644,width,height:200}});
   assert.deepEqual(await form.boundingBox(),initial,'Waiting for conversation details must not add a temporary footer');
   assert.equal(await notice.isVisible(),false,'The transport is unknown until the first response');
   release();release=null;
   await page.locator('.conversation-message.user:not(.conversation-launch)').waitFor();
   if(native){
    assert.deepEqual(await form.boundingBox(),initial,'Native replies never need the Terminal footer');
    assert.equal(await notice.isVisible(),false);
    assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isVisible(),true);
   }else{
    assert.equal(await notice.isVisible(),true,'A confirmed Terminal fallback still explains the send action');
    assert.equal(await page.getByRole('button',{name:'Send via Terminal',exact:true}).isVisible(),true);
   }
   await page.evaluate(()=>{current={...current,terminalReady:true,state:'ready'};SwitchboardConversation.update();});
   assert.deepEqual(await form.boundingBox(),initial,'Readiness leaves the composer in its original position');
   assert.equal(await draft.inputValue(),'Follow up');
   await page.getByRole('button',{name:'Terminal',exact:true}).click();
   assert.equal(await form.isVisible(),false);
   await page.getByRole('button',{name:'Conversation',exact:true}).click();
   assert.deepEqual(await form.boundingBox(),initial,'Returning from Terminal keeps the same layout');
   assert.equal(await draft.inputValue(),'Follow up');
   assert.deepEqual(errors,[]);
  }finally{release?.();await browser.close();}
 });
}
