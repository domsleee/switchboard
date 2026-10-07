const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// All HTTP is local fixture data; never attach to user sessions.
test('Settings shows recent errors per computer, newest first, with refresh and empty states',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const now=Date.now();
    let logs={computers:[
      {name:'Mac',local:true,entries:[
        {time:now-60e3,source:'Windows',message:'Status unavailable: Remote snapshots unavailable',count:14},
        {time:now-3600e3,source:'pairing',message:'Pairing setup unavailable; choose a connection in Computers',count:1}]},
      {name:'Windows',entries:[]},
      {name:'Old PC',error:"Logs unavailable on this computer's version"}]};
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/logs')return logs?json(logs):route.fulfill({status:500,body:''});
      if(path==='/api/hosts')return json([]);
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.locator('#settings').click();
    const groups=page.locator('#logs .log-computer');
    await page.waitForFunction(()=>document.querySelectorAll('#logs .log-computer').length===3);
    assert.deepEqual(await groups.locator('h4').allTextContents(),['Mac','Windows','Old PC']);
    const mac=groups.nth(0).locator('.log-entry');
    assert.equal(await mac.count(),2);
    assert.equal(await mac.nth(0).locator('span').textContent(),'Status unavailable: Remote snapshots unavailable');
    assert.match(await mac.nth(0).locator('small').textContent(),/^Windows · .+ · ×14$/);
    assert.doesNotMatch(await mac.nth(1).locator('small').textContent(),/×/);
    assert.equal(await groups.nth(1).locator('.log-note').textContent(),'No recent errors');
    assert.equal(await groups.nth(2).locator('.log-note').textContent(),"Logs unavailable on this computer's version");
    logs={computers:[{name:'Mac',local:true,entries:[]}]};
    await page.locator('#refresh-logs').click();
    await page.waitForFunction(()=>document.querySelectorAll('#logs .log-computer').length===1);
    assert.equal(await page.locator('#logs .log-note').textContent(),'No recent errors');
    logs=null;
    await page.locator('#refresh-logs').click();
    await page.waitForFunction(()=>document.querySelector('#logs .log-note')?.textContent.startsWith('Logs unavailable'));
    assert.equal(await page.locator('#refresh-logs').isDisabled(),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
