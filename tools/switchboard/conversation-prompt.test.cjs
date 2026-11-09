const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

// Menus as the relay reads them from Claude Code 2.1.319 (see conversation/prompt.rs).
const permission={detail:['Bash command','Write hello to out.txt in the working directory','echo hello > out.txt'],question:'Do you want to proceed?',token:'perm1',choices:[{label:'Yes',number:1,checked:null,text:false},{label:'Yes, and always allow access to C:\\caps from this project',number:2,checked:null,text:false},{label:'No',number:3,checked:null,text:false}]};
const colour={detail:[],question:'Which colour?',token:'colour1',choices:[{label:'Red',description:'Warm',number:1,checked:null,text:false},{label:'Blue',description:'Cool',number:2,checked:null,text:false},{label:'Type something.',number:3,checked:null,text:true},{label:'Chat about this',number:4,checked:null,text:false}]};
const toppings={detail:[],question:'Which toppings?',token:'top1',choices:[{label:'Cheese',number:1,checked:true,text:false},{label:'Ham',number:2,checked:false,text:false},{label:'Submit',number:null,checked:null,text:false}]};

test('Conversation answers Claude permission prompts and questions without Terminal',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const f={prompt:permission,answers:[],answerStatus:200,promptStatus:200,reads:0};
 try{
  for(const viewport of [{width:1280,height:800},{width:390,height:844}]){
   const page=await browser.newPage({viewport,isMobile:viewport.width<700,hasTouch:viewport.width<700});page.setDefaultTimeout(5000);
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   f.prompt=permission;f.answers=[];f.answerStatus=200;f.promptStatus=200;
   // Each manual poll moves the clock past the 1.5 s read throttle.
   await page.addInitScript(()=>{window.intervals=[];window.setInterval=fn=>intervals.push(fn);const now=Date.now;window.skew=0;Date.now=()=>now()+skew;});
   await page.route('http://prompt.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
    if(p.endsWith('/conversation/prompt')){f.reads++;return f.promptStatus===200?route.fulfill({json:{prompt:f.prompt}}):route.fulfill({status:f.promptStatus,body:''});}
    if(p.endsWith('/conversation/answer')){f.answers.push(route.request().postDataJSON());return f.answerStatus===200?route.fulfill({json:{ok:true}}):route.fulfill({status:f.answerStatus,body:'The question changed. Check it and choose again.'});}
    if(p.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'s1',messages:[{role:'assistant',text:'I need to run a command.'}],start_cursor:0,next_cursor:null}});
    if(p.startsWith('/api/'))return route.fulfill({json:{}});
    if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane7',host:'fixture',session:'main',tab:3,pane:7,title:'Switchboard',agent:'claude',state:'approval',chatId:'chat-1',frame:document.getElementById('terminal')};localStorage.setItem('switchboard-view-mode','conversation');localStorage.setItem('switchboard-mobile-view-mode','conversation');SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
    return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
   });
   const poll=()=>Promise.all([page.waitForResponse(r=>r.url().endsWith('/conversation/prompt')),page.evaluate(()=>{skew+=2000;intervals.forEach(fn=>fn());})]);
   await page.goto('http://prompt.test/');await page.getByText('I need to run a command.',{exact:true}).waitFor();
   const card=page.getByRole('region',{name:'Agent question'});
   await card.getByText('Do you want to proceed?',{exact:true}).waitFor();
   assert.equal(await card.locator('.conversation-question-detail').textContent(),'Bash commandWrite hello to out.txt in the working directoryecho hello > out.txt','The command being approved is shown');
   if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:`${process.env.MODE_SCREENSHOTS}/conversation-permission-${viewport.width}.png`});
   // The card sits above the composer and inside the viewport.
   const [cardBox,formBox]=[await card.boundingBox(),await page.locator('.conversation-compose').boundingBox()];
   assert.ok(cardBox.y+cardBox.height<=formBox.y+1&&cardBox.y>0,'The question sits above the composer');
   assert.ok(cardBox.x>=0&&cardBox.x+cardBox.width<=viewport.width,'The question fits the width');

   await card.getByRole('button',{name:/^3\s*No$/}).click();
   await page.waitForFunction(()=>document.querySelector('.conversation-question').classList.contains('answering'));
   assert.deepEqual(f.answers.at(-1),{session:'main',tab_id:3,pane_id:7,token:'perm1',choice:2});
   // The pane may still show the answered menu for a moment; it must not take a second answer.
   await poll();assert.equal(await card.getByRole('button',{name:/^1\s*Yes$/}).isDisabled(),true);

   f.prompt=colour;await poll();await card.getByText('Which colour?',{exact:true}).waitFor();
   if(process.env.MODE_SCREENSHOTS)await card.screenshot({path:`${process.env.MODE_SCREENSHOTS}/conversation-question-${viewport.width}.png`});
   assert.equal(await card.getByRole('button',{name:/Blue/}).textContent(),'2BlueCool');
   assert.equal(await card.getByRole('button',{name:/Type something/}).count(),0,'Type something. becomes a text field');
   await card.getByLabel('Type your own answer').fill('A goldfish');await card.getByRole('button',{name:'Send',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.conversation-question').classList.contains('answering'));
   assert.deepEqual(f.answers.at(-1),{session:'main',tab_id:3,pane_id:7,token:'colour1',choice:2,text:'A goldfish'});

   f.prompt=toppings;await poll();await card.getByText('Which toppings?',{exact:true}).waitFor();
   if(process.env.MODE_SCREENSHOTS)await card.screenshot({path:`${process.env.MODE_SCREENSHOTS}/conversation-toppings-${viewport.width}.png`});
   assert.equal(await card.getByRole('button',{name:/Cheese/}).getAttribute('aria-pressed'),'true');
   assert.equal(await card.getByRole('button',{name:/Ham/}).getAttribute('aria-pressed'),'false');
   f.answerStatus=409;await card.getByRole('button',{name:'Submit'}).click();
   await card.getByText('The question changed. Check it and choose again.',{exact:true}).waitFor();
   assert.equal(f.answers.at(-1).choice,2);assert.equal(await card.getByRole('button',{name:'Submit'}).isDisabled(),false,'A rejected answer can be retried');

   // A draft cannot be sent over the question; it is kept.
   await page.getByLabel('Reply draft').fill('later');await page.getByRole('button',{name:'Send',exact:true}).last().click();
   await page.getByText('Answer the agent’s question first. Your draft is kept.',{exact:true}).waitFor();

   // The card goes once the menu leaves the screen or the agent is busy again.
   f.prompt=null;await poll();await card.waitFor({state:'hidden'});
   f.prompt=permission;await poll();await card.waitFor();
   const reads=f.reads;await page.evaluate(()=>{current.state='working';SwitchboardConversation.update();});
   assert.equal(await card.isVisible(),false);await page.evaluate(()=>{skew+=2000;intervals.forEach(fn=>fn());});assert.equal(f.reads,reads,'No screen reads while the agent works');
   // Folder trust appears before Claude has a transcript. Waiting for the user's
   // answer must not turn an approval into a failed connection.
   f.prompt={detail:['Accessing workspace:','C:\\git\\GitHub\\acme\\sample-project','Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.',"Claude Code'll be able to read, edit, and execute files here.",'Security guide'],question:'Do you trust this folder?',token:'trust1',choices:[{label:'No, exit',number:null,checked:null,text:false},{label:'Yes, I trust this folder',number:null,checked:null,text:false}]};
   f.answerStatus=200;
   await page.evaluate(()=>{current={...current,chatId:null,state:'approval'};SwitchboardConversation.update();});
   await poll();await card.getByText('Do you trust this folder?',{exact:true}).waitFor();
   await page.evaluate(()=>{skew+=60000;intervals.forEach(fn=>fn());});
   assert.equal(await page.locator('.conversation-notice').textContent(),'Approval needed before the conversation can start.');
   assert.equal(await page.getByRole('button',{name:'Retry connection',exact:true}).isVisible(),false);
   assert.equal(await page.getByLabel('Reply draft').isVisible(),false);
   assert.ok((await card.locator('.conversation-question-detail').textContent()).includes('sample-project'));
   const trustBox=await card.boundingBox();assert.ok(trustBox.y>=0&&trustBox.y+trustBox.height<=viewport.height,'Startup approval fits the viewport');
   if(process.env.MODE_SCREENSHOTS)await page.screenshot({path:`${process.env.MODE_SCREENSHOTS}/conversation-folder-trust-${viewport.width}.png`});
   await card.getByRole('button',{name:'Yes, I trust this folder',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('.conversation-question').classList.contains('answering'));
   assert.deepEqual(f.answers.at(-1),{session:'main',tab_id:3,pane_id:7,token:'trust1',choice:1});
   await page.evaluate(()=>{current.state='ready';SwitchboardConversation.update();});
   assert.equal(await card.isVisible(),false);
   assert.equal(await page.locator('.conversation-notice').textContent(),'Send a message to start the conversation.');
   await page.evaluate(()=>{current={...current,chatId:'chat-1'};SwitchboardConversation.update();});
   // Codex panes and older relays keep the Open Terminal fallback.
   const codexReads=f.reads;
   await page.evaluate(()=>{current.state='approval';current.agent='codex';SwitchboardConversation.update();});
   assert.equal(await card.isVisible(),false);assert.equal(f.reads,codexReads);
   f.promptStatus=404;await page.evaluate(()=>{current.agent='claude';SwitchboardConversation.update();});
   await poll();
   const after=f.reads;await page.evaluate(()=>{skew+=2000;intervals.forEach(fn=>fn());});await page.waitForTimeout(100);
   assert.equal(f.reads,after,'An older relay is asked once');assert.equal(await card.isVisible(),false);
   assert.equal(await page.getByRole('button',{name:'Open Terminal'}).isVisible(),true);
   assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser.close();}
});
