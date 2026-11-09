const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

test('Skill badges use the host catalog, preserve arguments and code, and open details on desktop and phone',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{for(const mobile of [false,true]){
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(5000);
  const requests=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');});
  await page.route('http://skills.test/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/conversation/skills')){requests.push(route.request().postDataJSON());return route.fulfill({json:{skills:[{name:'dotfiles-skills:council',description:'Ask several models to review a decision.'}]}});}
   if(p.endsWith('/codex/reply'))return route.fulfill({json:{status:'queued'}});
   if(p.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{project:'/work/switchboard',messages:[
    {role:'user',text:'$dotfiles-skills:council confirm'},
    {role:'user',text:'Keep $unknown $100 /tmp/path `$dotfiles-skills:council`\n\n```sh\n$dotfiles-skills:council\n```'},
    {role:'assistant',text:'$dotfiles-skills:council is a skill.'},
   ],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{height:100dvh;position:relative}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,agent:'codex',state:'ready',chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`});
   return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://skills.test/');
  const chip=page.getByRole('button',{name:'Skill council. Show details'});await chip.waitFor();
  assert.equal(await chip.count(),1,'Only a recognized skill in ordinary user text becomes a chip');
  assert.equal(await chip.getAttribute('data-label'),'council');
  assert.equal(await chip.textContent(),'$dotfiles-skills:council','The original invocation remains available for copying');
  assert.equal(await page.locator('.conversation-message.user').first().locator('p').textContent(),'$dotfiles-skills:council confirm');
  assert.deepEqual(requests,[{cwd:'/work/switchboard'}],'History loads the catalog without opening the composer menu');
  if(!mobile&&process.env.SKILL_SCREENSHOTS)await page.locator('.conversation-message.user').first().screenshot({path:path.join(process.env.SKILL_SCREENSHOTS,'skill-chip.png')});
  await chip.click();const popup=page.locator('.conversation-skill-details:popover-open');await popup.waitFor();
  assert.match(await popup.textContent(),/Ask several models/);assert.match(await popup.textContent(),/\$dotfiles-skills:council/);
  const box=await popup.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=page.viewportSize().width&&box.y>=0&&box.y+box.height<=page.viewportSize().height);
  if(process.env.SKILL_SCREENSHOTS)await page.screenshot({path:path.join(process.env.SKILL_SCREENSHOTS,mobile?'skills-phone.png':'skills-desktop.png')});
  await page.keyboard.press('Escape');await popup.waitFor({state:'detached'});
  const draft=page.getByLabel('Reply draft');await draft.fill('$dotfiles-skills:council confirm');await draft.press('Escape');await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.locator('.conversation-outgoing .conversation-skill').waitFor();
  assert.equal(await page.locator('.conversation-outgoing p').textContent(),'$dotfiles-skills:council confirm');
  assert.equal(requests.length,1,'Sending reuses the catalog');assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();}
});
