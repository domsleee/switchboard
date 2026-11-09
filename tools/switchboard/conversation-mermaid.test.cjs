const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const FIXTURE='<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><div class="conversation-panel"><div class="conversation-messages" style="height:800px;overflow:auto"><article class="conversation-message assistant" id="message"></article></div></div><script src="/conversation-media.js"></script><script src="/conversation-mermaid.js"></script>';
// conversation.js owns decorateCode inside its closure, so build the same card here.
const card=(source,lang='mermaid')=>{
 const pre=document.createElement('pre'),code=document.createElement('code'),box=document.createElement('div'),bar=document.createElement('div'),label=document.createElement('span'),copy=document.createElement('button');
 pre.dataset.lang=lang;code.textContent=source;pre.append(code);box.className='conversation-code';bar.className='conversation-code-bar';label.textContent=lang;copy.textContent='Copy';copy.type='button';bar.append(label,copy);box.append(bar,pre);
 document.getElementById('message').append(box);SwitchboardConversationMermaid.attach(box,pre,source);return box;
};
async function open(browser,options={}){
 const page=await browser.newPage({viewport:{width:options.width||1100,height:options.height||800}}),requests=[];page.setDefaultTimeout(20000);
 await page.route('http://mermaid.test/**',route=>{
  const {pathname}=new URL(route.request().url());requests.push(pathname);
  if(pathname==='/')return route.fulfill({contentType:'text/html',body:FIXTURE});
  return route.fulfill({path:path.join(__dirname,'static',path.basename(pathname))});
 });
 await page.goto('http://mermaid.test/');await page.evaluate(`window.card=${card}`);
 return {page,requests};
}
const rendered=page=>page.waitForFunction(()=>{const img=document.querySelector('.conversation-mermaid-diagram img');return img?.complete&&img.naturalWidth>0;});
test('a Mermaid block draws as an image whose source stays available',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const {page,requests}=await open(browser);
  await page.evaluate(()=>card('flowchart LR\n  A[Sidebar] --> B{Relay}\n  B -->|paired| C[Other computer]'));
  await rendered(page);
  assert.equal(requests.filter(url=>url.startsWith('/mermaid-')).length,1);
  const diagram=page.locator('.conversation-mermaid-diagram');
  assert.equal(await page.locator('.conversation-code>pre').isVisible(),false);
  assert.match(await page.locator('.conversation-mermaid-diagram img').getAttribute('src'),/^data:image\/svg\+xml/);
  const svg=await page.evaluate(()=>decodeURIComponent(document.querySelector('.conversation-mermaid-diagram img').src.split(',').slice(1).join(',')));
  assert.equal(svg.includes('foreignObject'),false,'Labels are SVG text, which Safari draws inside an image');
  assert.match(svg,/computer/);
  await page.getByRole('button',{name:'Code',exact:true}).click();
  assert.equal(await diagram.isVisible(),false);assert.match(await page.locator('.conversation-code>pre').innerText(),/flowchart LR/);
  await page.getByRole('button',{name:'Diagram',exact:true}).click();assert.equal(await diagram.isVisible(),true);
  await diagram.click();await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('link',{name:'Open original',exact:true}).isVisible(),false,'A data URL has no original to open');
  const shown=await page.locator('.conversation-media-stage img').boundingBox();
  assert.ok(shown.width>800,'The viewer scales a small diagram up to the screen');
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download',exact:true}).click()]);
  assert.equal(download.suggestedFilename(),'mermaid-diagram.svg');
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
  const again=await page.evaluate(()=>{const box=card('flowchart LR\n  A[Sidebar] --> B{Relay}\n  B -->|paired| C[Other computer]');return !!box.querySelector('.conversation-mermaid-diagram');});
  assert.equal(again,true,'A message rebuilt after an update shows its diagram at once');
 }finally{await browser.close();}
});
test('hostile or broken Mermaid stays inert',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const {page}=await open(browser);
  await page.evaluate(()=>card('flowchart LR\n  A["<img src=x onerror=window.fired=1>"] --> B\n  click A "javascript:window.fired=2"\n%%{init:{"securityLevel":"loose"}}%%'));
  await rendered(page);
  await page.evaluate(()=>card('flowchart LR\n  A[[[ this is not valid'));
  await page.locator('.conversation-mermaid-note').waitFor();
  assert.equal(await page.locator('.conversation-code>pre:visible').count(),1,'Source that cannot be drawn stays readable');
  assert.equal(await page.evaluate(()=>window.fired),undefined);
  assert.equal(await page.locator('#message svg,#message iframe').count(),0,'Nothing Mermaid produced reaches the page DOM');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser.close();}
});
test('a diagram far above the reader waits, and the library loads only when one is needed',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const {page,requests}=await open(browser);
  await page.waitForLoadState('load');assert.equal(requests.some(url=>url.startsWith('/mermaid-')),false,'The 5 MB library is not part of startup');
  await page.evaluate(()=>{document.getElementById('message').style.paddingTop='6000px';card('sequenceDiagram\n  Phone->>Relay: open tab');});
  await page.waitForTimeout(400);assert.equal(requests.some(url=>url.startsWith('/mermaid-')),false);
  await page.locator('.conversation-messages').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await rendered(page);
  const width=await page.locator('.conversation-mermaid-diagram img').evaluate(img=>img.getBoundingClientRect().width);assert.ok(width>0);
 }finally{await browser.close();}
});
test('Conversation draws Mermaid from markdown and plain transcripts and stays at the newest message',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const source='flowchart TD\n  A --> B\n  B --> C\n  C --> D\n  D --> E\n  E --> F';
 const messages=[...Array(30)].map((_,i)=>({role:i%2?'assistant':'user',text:'Earlier '+i,timestamp:new Date(1e12+i).toISOString()})),last={role:'assistant',timestamp:new Date(1e12+60).toISOString()};
 messages.push({...last,text:'```mermaid\n'+source+'\n```'},{...last,text:'Chart',markdown:[{type:'start',tag:'pre',lang:'mermaid'},{type:'text',text:source.replace('A','Q')+'\n'},{type:'end'}]});
 try{
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
   const page=await browser.newPage({viewport});page.setDefaultTimeout(20000);
   await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');});
   await page.route('http://chat.test/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.startsWith('/api/chats/')&&!p.endsWith('/stream'))return route.fulfill({json:{messages,start_cursor:0,next_cursor:null}});
    if(p.startsWith('/api/'))return route.fulfill({status:404,body:''});
    if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation-mermaid.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',pane:1,title:'Fix',agent:'claude',state:'ready',since:1,chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
    return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
   });
   await page.goto('http://chat.test/');
   await page.waitForFunction(()=>{const all=[...document.querySelectorAll('.conversation-mermaid-diagram img')];return all.length===2&&all.every(img=>img.complete&&img.naturalWidth>0);});
   await page.waitForFunction(()=>{const list=document.querySelector('.conversation-messages');return Math.abs(list.scrollHeight-list.clientHeight-list.scrollTop)<2;});
   const box=await page.locator('.conversation-mermaid-diagram').last().boundingBox();
   assert.ok(box.x>=0&&box.x+box.width<=viewport.width,'The diagram fits the transcript column');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.equal(await page.locator('.conversation-code-bar').last().getByRole('button',{name:'Copy code'}).isVisible(),true);
   await page.close();
  }
 }finally{await browser.close();}
});
