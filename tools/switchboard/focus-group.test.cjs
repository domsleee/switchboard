const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// All HTTP and terminal state is local fixture data; never attach to user sessions.
test('a browser focused on Work shows only Work, keeps the other groups behind Show more, and sends Work claude.ai links to its browser',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const tabs=[['mac','Personal'],['windows','Job']].map(([host,name],i)=>({host,session:'main',id:i+1,position:0,name,panes:[{pane_id:i+1,is_plugin:false,tab_position:0}]}));
    await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-groups',JSON.stringify({mac:'home',windows:'work'}));});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'},{id:'windows',name:'Windows'}]);
      if(path.startsWith('/api/hosts/'))return json({id:path.split('/').at(-1),name:path.endsWith('/mac')?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:[],errors:[]});
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:'<p>terminal fixture</p>'});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const names=()=>page.locator('#tabs .tab-name').allTextContents();
    const buttons=()=>page.locator('#filters [data-filter]:visible').allTextContents();
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    assert.deepEqual(await buttons(),['All','Work','Home']);
    assert.equal(await page.locator('#filter-more').isVisible(),false);

    await page.locator('#settings').click();
    await page.locator('#focus-group').selectOption('work');
    await page.locator('#close-panel').click();
    assert.deepEqual(await buttons(),['Work']);
    assert.deepEqual(await names(),['Job']);
    const more=page.locator('#filter-more'),menu=page.locator('#filter-menu');
    assert.equal(await more.textContent(),'Show more');
    await more.click();
    assert.deepEqual(await menu.getByRole('menuitemradio').evaluateAll(items=>items.map(item=>item.getAttribute('aria-label'))),['All, 2 tabs','Home, 1 tab']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'Home, 1 tab');
    await page.keyboard.press('Escape');
    assert.equal(await menu.isVisible(),false,'Escape closes the menu');
    assert.equal(await more.getAttribute('aria-expanded'),'false');
    await more.click();await page.locator('#tab-search').click();
    assert.equal(await menu.isVisible(),false,'Clicking elsewhere closes the menu');
    await more.click();await page.keyboard.press('ControlOrMeta+KeyK');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'tab-search');
    assert.equal(await menu.isVisible(),false,'A shortcut that moves focus closes the menu');
    await more.click();await menu.getByRole('menuitemradio',{name:'Home, 1 tab'}).click();
    assert.equal(await menu.isVisible(),false);
    assert.equal(await more.textContent(),'Home','The button names the chosen group');
    await more.click();
    assert.equal(await menu.getByRole('menuitemradio',{name:'Home, 1 tab'}).getAttribute('aria-checked'),'true');
    await page.keyboard.press('Escape');
    assert.deepEqual(await names(),['Personal']);
    assert.equal(new URL(page.url()).searchParams.get('group'),'home');

    // A reload opens on the focused group; the setting belongs to this browser.
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===1);
    assert.deepEqual(await names(),['Job']);
    assert.equal(new URL(page.url()).searchParams.has('group'),false);
    assert.equal(await page.locator('#focus-group').inputValue(),'work');

    await page.locator('#settings').click();
    await page.locator('#focus-group').selectOption('');
    await page.locator('#close-panel').click();
    assert.deepEqual(await buttons(),['All','Work','Home']);
    assert.deepEqual(await names(),['Personal','Job']);

    // claude.ai links from Work tabs open in the browser named for Work.
    const opened=[];let refuse=false;
    await context.route('**/api/open-link',route=>{opened.push(route.request().postDataJSON());
      return refuse?route.fulfill({status:502,body:'That browser could not be opened'}):route.fulfill({contentType:'application/json',body:'{"ok":true}'});});
    await page.locator('#settings').click();
    await page.locator('#link-app-work').fill('Google Chrome Canary');
    await page.locator('#link-app-work').press('Tab');
    await page.locator('#close-panel').click();
    const route=(host,url)=>page.evaluate(([host,url])=>window.SwitchboardOpenInApp(host,url),[host,url]);
    assert.equal(await route('windows','https://claude.ai/new'),true);
    assert.equal(await route('windows','https://www.claude.ai/chat/1'),true);
    assert.equal(await route('mac','https://claude.ai/new'),false,'Home has no browser set');
    assert.equal(await route('windows','https://notclaude.ai/'),false);
    assert.equal(await route('windows','https://github.com/'),false);
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.deepEqual(opened,[{url:'https://claude.ai/new',app:'Google Chrome Canary'},{url:'https://www.claude.ai/chat/1',app:'Google Chrome Canary'}]);
    refuse=true;
    await route('windows','https://claude.ai/new');
    await page.waitForFunction(()=>document.querySelector('#status-message').textContent.includes('Could not open the link in Google Chrome Canary'));
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    assert.equal(await page.locator('#link-app-work').inputValue(),'Google Chrome Canary','saved in this browser');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
