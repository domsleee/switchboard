const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// All HTTP and terminal state is local fixture data; never attach to user sessions.
test('a browser focused on Work shows only Work and keeps the other groups behind Show more',
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
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const names=()=>page.locator('#tabs .tab-name').allTextContents();
    const buttons=()=>page.locator('#filters button:visible').allTextContents();
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    assert.deepEqual(await buttons(),['All','Work','Home']);
    assert.equal(await page.locator('#filter-more').isVisible(),false);

    await page.locator('#settings').click();
    await page.locator('#focus-group').selectOption('work');
    await page.locator('#close-panel').click();
    assert.deepEqual(await buttons(),['Work']);
    assert.deepEqual(await names(),['Job']);
    assert.deepEqual(await page.locator('#filter-more option:not([hidden])').allTextContents(),['All','Home']);
    await page.locator('#filter-more').selectOption('home');
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
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
