const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

const pane=id=>({pane_id:id+1,tab_position:0,is_plugin:false});
const row=(id,position)=>({host:'fixture',session:'main',id,position,name:'Chat '+id,panes:[{...pane(id),tab_position:position}]});

// All HTTP and terminal state is local fixture data; never attach to user sessions.
async function open(browser,mode){
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  const page=await context.newPage(),errors=[],fixture={ids:[42,90,105],created:0};
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(view=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode',view);},mode);
  await context.route('https://switchboard.test/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname,json=value=>route.fulfill({json:value});
    // An unchanged watch stays pending, as the relay's does.
    if(path==='/api/attention'&&url.searchParams.has('after'))return;
    if(path==='/api/hosts')return json([{id:'fixture',name:'Fixture desktop',local:true}]);
    if(path==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture desktop',local:true,sessions:[{name:'main',web_clients_allowed:true}]});
    if(path==='/api/hosts/fixture/projects'||path.endsWith('/models'))return json({});
    if(path==='/api/attention')return json({tabs:fixture.ids.map(row),panes:[],errors:[]});
    if(path.startsWith('/api/file')||path.endsWith('/file'))return route.fulfill({contentType:'text/html',body:'<p>artifact fixture</p>'});
    if(path.startsWith('/api/chats/'))return json({messages:[],start_cursor:0,next_cursor:null});
    if(path.startsWith('/api/'))return json({});
    if(path==='/hosts/fixture/new-tab'){fixture.created++;return json({pane_id:300,tab_id:300});}
    if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:'<p>terminal fixture</p>'});
    const file=__dirname+'/static/'+(path==='/'?'index.html':path.slice(1));
    return fs.existsSync(file)?route.fulfill({path:file,contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'}):route.fulfill({status:404,body:''});
  });
  const cdp=await context.newCDPSession(page);
  // Playwright's mouse has no back or forward buttons; these reach the browser as real ones do.
  const press=async button=>{
    const at={x:800,y:400,button,clickCount:1};
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:at.x,y:at.y});
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...at,buttons:button==='back'?8:16});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...at,buttons:0});
  };
  const click=id=>page.locator('#tabs .tab-select',{hasText:'Chat '+id}).click();
  const tabInUrl=()=>new URL(page.url()).searchParams.get('tab');
  const shows=async id=>{
    await page.waitForFunction(id=>new URLSearchParams(location.search).get('tab')===id&&document.querySelector('#tabs .selected')?.textContent.includes('Chat '+id),String(id));
    assert.equal(tabInUrl(),String(id));
  };
  await page.goto('https://switchboard.test/?host=fixture&session=main&tab=42');
  await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===3);
  await shows(42);
  return {context,page,errors,fixture,press,click,shows,tabInUrl};
}

for(const mode of ['conversation','terminal']){
  test(`the mouse's back and forward buttons walk the chats opened in ${mode} mode`,
    {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
    const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
    try{
      const {page,errors,press,click,shows}=await open(browser,mode);
      const before=await page.evaluate(()=>history.length);
      await click(90);await shows(90);
      await click(105);await shows(105);
      await click(105);
      assert.equal(await page.evaluate(()=>history.length),before+2,'Each switch adds one entry; reselecting adds none');
      await page.evaluate(()=>refreshAttention(true));
      assert.equal(await page.evaluate(()=>history.length),before+2,'A background refresh adds no entry');
      await press('back');await shows(90);
      await press('back');await shows(42);
      await press('forward');await shows(90);
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
}

test('Back leaves a new chat for the chat it was opened from',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const {page,errors,press,click,shows,fixture}=await open(browser,'conversation');
    await click(90);await shows(90);
    const before=await page.evaluate(()=>history.length);
    await page.locator('#new-tab').click();await page.locator('#new-tab-dialog').waitFor({state:'visible'});
    await press('back');
    await page.waitForFunction(()=>!document.getElementById('new-tab-dialog').open);
    await shows(90);
    await page.locator('#new-tab').click();await page.locator('#new-tab-prompt').fill('Start something');
    await page.locator('#new-tab-form button[type="submit"]').click();
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('pane')==='300');
    assert.equal(fixture.created,1);
    assert.equal(await page.locator('#new-tab-dialog').evaluate(dialog=>dialog.open),false);
    assert.equal(await page.evaluate(()=>history.state?.switchboardNewTab||false),false,'The new chat owns the entry the dialog used');
    await press('back');await shows(90);
    await press('back');await shows(42);
    assert.ok(await page.evaluate(()=>history.length)>=before);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Back skips a chat that has closed, and stops rather than leaving Switchboard',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const {page,errors,press,click,shows,fixture}=await open(browser,'conversation');
    await click(90);await shows(90);
    await click(105);await shows(105);
    fixture.ids=[42,105];
    await page.evaluate(()=>refreshAttention(true));
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    await press('back');await shows(42);
    await press('forward');await shows(105);
    fixture.ids=[105];
    await page.evaluate(()=>refreshAttention(true));
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===1);
    await press('back');
    await page.waitForFunction(()=>new URLSearchParams(location.search).get('tab')==='105');
    assert.equal(new URL(page.url()).hostname,'switchboard.test');
    await shows(105);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('A file preview and a chat switch share one history step; reconnecting a terminal adds none',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const {page,errors,press,click,shows}=await open(browser,'terminal');
    await click(90);await shows(90);
    const before=await page.evaluate(()=>history.length);
    await page.evaluate(()=>{const entry=[...sessions.values()][0];replaceFrameSrc(entry.frame,'about:blank');replaceFrameSrc(entry.frame,'/hosts/fixture/main');});
    assert.equal(await page.evaluate(()=>history.length),before,'Replacing a loaded terminal page adds no entry');
    await page.evaluate(()=>{const entry=[...sessions.values()][0],panes=[{pane_id:106,tab_position:2,is_plugin:false}];entry.state={session_name:'main',panes,active_pane:panes[0]};SwitchboardOpenFile('fixture','/tmp/fixture.html');});
    await page.locator('#artifact-preview').waitFor({state:'visible'});
    await click(105);await shows(105);
    await page.waitForFunction(()=>document.getElementById('artifact-preview').hidden);
    await press('back');await shows(90);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Back steps over a closed chat that took over a preview entry',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const {page,errors,press,click,shows,fixture}=await open(browser,'terminal');
    await page.evaluate(()=>{const entry=[...sessions.values()][0],panes=[{pane_id:43,tab_position:0,is_plugin:false}];entry.state={session_name:'main',panes,active_pane:panes[0]};SwitchboardOpenFile('fixture','/tmp/fixture.html');});
    await page.locator('#artifact-preview').waitFor({state:'visible'});
    await click(90);await shows(90);
    await click(105);await shows(105);
    fixture.ids=[42,105];
    await page.evaluate(()=>refreshAttention(true));
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    await press('back');await shows(42);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Settings pages stay out of the back button',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    const {page,errors,press,click,shows}=await open(browser,'conversation');
    await click(90);await shows(90);
    for(let i=0;i<2;i++){
      await page.locator('#settings').click();
      await page.getByRole('tab',{name:'Messages'}).click();
      await page.locator('#close-panel').click();
    }
    await press('back');await shows(42);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
