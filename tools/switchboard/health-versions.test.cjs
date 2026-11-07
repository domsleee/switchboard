const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

test('Health compares builds with this computer and handles missing or changing version metadata',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:850}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const computer=(name,commit,extra={})=>({name,host:name,groups:[],agents:[],switchboard:{commit,commitDate:'2026-11-06',automaticUpdates:true},...extra});
    const computers=[computer('Laptop 1','aaaaaaa',{local:true}),computer('Laptop 2','aaaaaaa'+'0'.repeat(33)),computer('Laptop 3','bbbbbbb'),computer('Laptop 4','ccccccc'),computer('Laptop 5','ddddddd')];
    let hosts=computers.map((c,i)=>({id:c.host,local:!!c.local,version:{commit:c.switchboard.commit,commit_timestamp:`2026-11-06T${['12','12','10','14','12'][i]}:00:00Z`}}));
    let hostsFail=false;
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/tasks')return json({computers});
      if(path==='/api/hosts')return hostsFail?route.fulfill({status:503,body:''}):json(hosts);
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      const file=path==='/'?'index.html':path.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      const source=file==='tasks.js'&&process.env.HEALTH_BEFORE_JS?process.env.HEALTH_BEFORE_JS:__dirname+'/static/'+file;
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(source)});
    });
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
    await page.locator('#settings').click();await page.getByRole('tab',{name:'Health',exact:true}).click();
    if(process.env.HEALTH_SCREENSHOT)await page.locator('#panel').screenshot({path:process.env.HEALTH_SCREENSHOT});
    if(process.env.HEALTH_BEFORE_JS)return;
    const labels=()=>page.locator('.computer-version').allTextContents();
    assert.deepEqual(await labels(),['This computer','Same version as this computer','Older than this computer','Newer than this computer','Different version · order unknown']);
    const reload=()=>page.evaluate(()=>SwitchboardTasks.load());
    // Missing timestamp metadata must not invent ordering within a single day.
    hostsFail=true;await reload();
    assert.equal((await labels())[2],'Different version · order unknown');
    computers[2].switchboard.commitDate='2026-11-05';await reload();
    assert.equal((await labels())[2],'Older than this computer');
    computers[2].switchboard.commitDate='2026-11-07';await reload();
    assert.equal((await labels())[2],'Newer than this computer');
    // A host snapshot from before a restart cannot date the new Health commit.
    hostsFail=false;computers[2].switchboard.commit='eeeeeee';computers[2].switchboard.commitDate='2026-11-06';await reload();
    assert.equal((await labels())[2],'Different version · order unknown');
    computers[1].error='Computer unavailable';computers[3].switchboard.commit='unknown';await reload();
    assert.equal((await labels())[1],'Version comparison unavailable');
    assert.equal((await labels())[3],'Version comparison unavailable');
    computers[0].switchboard=null;await reload();
    assert.ok((await labels()).slice(1).every(label=>label==='Version comparison unavailable'));
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
