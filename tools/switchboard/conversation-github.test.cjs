const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('repository references and PR previews stay alongside Conversation and preserve terminal navigation',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const reads=[],errors=[];let fail=false,release;
 try{
  const page=await browser.newPage({viewport:{width:1400,height:900}});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','conversation');window.intervals=[];window.setInterval=fn=>intervals.push(fn);const now=Date.now;window.githubClock=0;Date.now=()=>now()+window.githubClock;});
  await page.route('http://github-preview.test/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.endsWith('/conversation/github')){
    const body=route.request().postDataJSON();reads.push(body);
    if(body.cwd)return route.fulfill({json:{repo:body.cwd==='/repo'?'example/project':null}});
    if(body.number===99)await new Promise(resolve=>release=resolve);
    if(fail)return route.fulfill({status:503,body:'offline'});
    return route.fulfill({json:{__typename:'PullRequest',title:'Keep references in context',state:'OPEN',body:'References open next to the conversation, keeping the reply draft in view.',markdown:[{type:'start',tag:'p'},{type:'text',text:'References open next to the conversation, keeping the reply draft in view.'},{type:'end'},{type:'start',tag:'ul'},...['Resolve #42 against the current repository.','Preview pull requests without leaving the conversation.','Keep keyboard navigation and drafts intact.'].flatMap(text=>[{type:'start',tag:'li'},{type:'text',text},{type:'end'}]),{type:'end'}],author:{login:'reviewer'},additions:12,deletions:3,changedFiles:2,headRefName:'feature/references',baseRefName:'main',reviewDecision:'APPROVED',mergeStateStatus:'CLEAN'}}).catch(()=>{});
   }
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{project:'/repo',session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'Review #42 and example/other#7. Code #9.',markdown:[{type:'start',tag:'p'},{type:'text',text:'Review #42 and example/other#7. '},{type:'code',text:'#9'},{type:'text',text:' and C# or heading ##. '},{type:'end'},{type:'start',tag:'p'},{type:'start',tag:'a',url:'https://github.com/example/project/pull/43/files'},{type:'text',text:'PR details'},{type:'end'},{type:'text',text:' https://github.com/example/project/pull/99'},{type:'end'}]}],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100vh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-github.js"></script><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,title:'Example project',agent:'codex',state:'ready',chatId:'chat-one',frame:document.getElementById('terminal')};window.terminalVisits=0;SwitchboardConversation.install({selection:()=>current,terminal:()=>terminalVisits++});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://github-preview.test/');
  const ref=page.getByRole('link',{name:'#42',exact:true}),preview=page.getByRole('complementary',{name:'GitHub preview'});
  await ref.waitFor();assert.equal(await ref.getAttribute('href'),'https://github.com/example/project/issues/42');
  assert.equal(await page.getByRole('link',{name:'example/other#7',exact:true}).getAttribute('href'),'https://github.com/example/other/issues/7');
  assert.equal(await page.getByRole('link',{name:'#9',exact:true}).count(),0,'code stays code');
  await ref.click();await preview.getByRole('heading',{name:'Keep references in context'}).waitFor();
  assert.equal(await preview.locator('.github-branches').getAttribute('aria-label'),'feature/references → main');assert.match(await preview.textContent(),/\+12/);assert.equal(await preview.locator('script').count(),0);assert.equal(await preview.getByRole('heading',{name:'Description',exact:true}).count(),1);assert.equal(await preview.getByText('Approved',{exact:true}).count(),1);assert.equal(await preview.getByText('No conflicts',{exact:true}).count(),1);
  assert.equal(await preview.getByRole('link',{name:'Open on GitHub'}).getAttribute('href'),'https://github.com/example/project/issues/42');
  const boxes=await page.evaluate(()=>{const a=document.querySelector('.conversation-panel').getBoundingClientRect(),b=document.querySelector('.conversation-github-panel').getBoundingClientRect();return {chat:a.right,preview:b.left};});assert.equal(boxes.chat,boxes.preview);
  await page.keyboard.press('Escape');assert.equal(await preview.isVisible(),false);assert.equal(await ref.evaluate(n=>n===document.activeElement),true);
  assert.equal(reads.filter(r=>r.cwd).length,1,'repo lookup is shared');
  // Both modifiers retain the browser default on references and explicit PR links.
  // Meta's native new-tab gesture is macOS-specific; this fixture runs on Windows too.
  for(const label of ['#42','PR details'])for(const modifier of ['metaKey','ctrlKey']){
   const prevented=await page.getByRole('link',{name:label,exact:true}).evaluate((link,modifier)=>{
    const event=new MouseEvent('click',{button:0,[modifier]:true,bubbles:true,cancelable:true});
    let intercepted;
    link.addEventListener('click',event=>{intercepted=event.defaultPrevented;event.preventDefault();},{once:true});
    link.dispatchEvent(event);return intercepted;
   },modifier);
   assert.equal(prevented,false,modifier+' leaves '+label+' to the browser');
   assert.equal(await preview.isVisible(),false);
  }
  await page.route('https://github.com/**',r=>r.fulfill({body:'GitHub'}));
  const popupPromise=page.context().waitForEvent('page');await ref.click({modifiers:['ControlOrMeta']});const popup=await popupPromise;await popup.close();assert.equal(await preview.isVisible(),false,'modified click stays a browser gesture');
  await page.getByRole('link',{name:'PR details',exact:true}).click();await preview.getByRole('heading',{name:'Keep references in context'}).waitFor();
  await page.getByRole('button',{name:'Terminal',exact:true}).click();assert.equal(await preview.isVisible(),false);assert.equal(await page.locator('#terminals').evaluate(n=>n.classList.contains('github-open')),false);assert.ok(await page.evaluate(()=>terminalVisits)>0);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.evaluate(()=>window.githubClock+=31000);fail=true;await ref.click();await preview.getByRole('button',{name:'Retry'}).waitFor();fail=false;await preview.getByRole('button',{name:'Retry'}).click();await preview.getByRole('heading',{name:'Keep references in context'}).waitFor();
  await page.setViewportSize({width:390,height:844});const size=await preview.boundingBox();assert.equal(Math.round(size.width),390);
  if(process.env.GITHUB_SCREENSHOT)await page.screenshot({path:process.env.GITHUB_SCREENSHOT.replace('.png','-mobile.png')});
  await page.setViewportSize({width:1400,height:900});if(process.env.GITHUB_SCREENSHOT)await page.screenshot({path:process.env.GITHUB_SCREENSHOT});
  await page.getByRole('link',{name:'https://github.com/example/project/pull/99',exact:true}).click();await preview.getByText('Loading GitHub…').waitFor();await page.keyboard.press('Escape');release();await page.waitForTimeout(50);assert.equal(await preview.isVisible(),false,'a closed request cannot reopen the panel');
  if(process.env.GITHUB_SCREENSHOT){await page.route('**/conversation-github.js',r=>r.fulfill({contentType:'text/javascript',body:''}));await page.reload();await page.getByRole('link',{name:'PR details',exact:true}).waitFor();await page.screenshot({path:process.env.GITHUB_SCREENSHOT.replace('.png','-before.png')});}
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
