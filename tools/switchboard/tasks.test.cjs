const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

// All HTTP is local fixture data; never attach to user sessions.
test('Update tasks show per computer, flag failures and changes in the sidebar, and act on the right computer',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],actions=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const now=Date.now();
    const task=(name,extra={})=>({name,status:'ok',started:now-7260e3,finished:now-7200e3,exitCode:0,durationMs:4200,tail:[],changed:[],note:null,whenAgentsIdle:false,...extra});
    const dotfiles={name:'dotfiles',every:'6h',enabled:true,paused:false,running:false,status:'failed',summary:'agent plugins: codex failed',notice:true,
      lastStart:now-7260e3,lastEnd:now-7200e3,nextRun:now+3*3600e3,tasks:[
        task('pull + install',{changed:['dotfiles: 3 commits']}),
        task('agent plugins',{status:'failed',exitCode:1,tail:['claude ok','codex failed'],whenAgentsIdle:true})]};
    const tools={name:'wtg tools',every:'1d',enabled:true,paused:true,running:false,status:'ok',summary:'',notice:false,
      lastStart:now-3600e3,lastEnd:now-3590e3,nextRun:null,tasks:[task('mcp-ediprod')]};
    const windows={name:'dotfiles',every:'6h',enabled:true,paused:false,running:false,status:'changed',summary:'nushell 0.104',notice:true,
      lastStart:now-60e3,lastEnd:now-30e3,nextRun:now+6*3600e3,tasks:[task('pull + install',{changed:['nushell 0.104']})]};
    let tasks={computers:[
      {name:'Mac',local:true,groups:[dotfiles,tools],error:null},
      {name:'Dom-PC',host:'mesh-dompc',groups:[windows],error:null},
      {name:'Old PC',host:'mesh-old',groups:[],error:"Update tasks unavailable on this computer's version"}]};
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/tasks')return json(tasks);
      if(path==='/api/tasks/action'){
        const body=JSON.parse(request.postData());actions.push(body);
        if(body.action==='clear')windows.notice=false;
        return json({ok:true});
      }
      if(path==='/api/hosts')return json([]);
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','close.js','titles.js','style.css','tasks.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');

    const notices=page.locator('#task-notices .task-notice-open');
    await page.waitForFunction(()=>document.querySelectorAll('#task-notices .task-notice').length===2);
    assert.deepEqual(await notices.allTextContents(),['Mac · dotfiles ✗ agent plugins: codex failed','Dom-PC · dotfiles ↑ nushell 0.104']);

    await notices.first().click();
    assert.equal(await page.locator('#panel-title').textContent(),'Updates');
    const computers=page.locator('#updates .task-computer');
    assert.deepEqual(await computers.locator('h4').allTextContents(),['Mac','Dom-PC','Old PC']);
    assert.equal(await computers.nth(2).locator('.log-note').textContent(),"Update tasks unavailable on this computer's version");
    const mac=computers.nth(0).locator('.task-group');
    assert.equal(await mac.nth(0).locator('.task-state').textContent(),'✗ agent plugins: codex failed');
    assert.match(await mac.nth(0).locator('.task-title small').textContent(),/^every 6h · next in 3h$/);
    assert.equal(await mac.nth(1).locator('.task-title small').textContent(),'every 1d · paused');
    assert.equal(await mac.nth(1).locator('.task-state').textContent(),'✓ 59m ago');
    assert.equal(await mac.nth(1).getByRole('button',{name:'Resume'}).count(),1);

    await mac.nth(0).locator('summary').click();
    const rows=mac.nth(0).locator('.task-row');
    assert.equal(await rows.count(),2);
    assert.equal(await rows.nth(0).locator('.task-change').textContent(),'↑ dotfiles: 3 commits');
    assert.equal(await rows.nth(1).locator('.task-tail').textContent(),'claude ok\ncodex failed');
    assert.match(await rows.nth(1).locator('.task-meta').textContent(),/2h ago · 4s · exit 1 · when agents are idle/);
    assert.equal(await rows.nth(1).getByRole('link',{name:'Log'}).getAttribute('href'),'/api/tasks/log?group=dotfiles&task=agent+plugins');
    assert.equal(await computers.nth(1).locator('.task-group .task-row a').getAttribute('href'),'/api/tasks/log?group=dotfiles&task=pull+%2B+install&host=mesh-dompc');

    // Actions go to the computer that owns the group; local groups carry no host.
    await rows.nth(1).getByRole('button',{name:'Run'}).click();
    await computers.nth(1).getByRole('button',{name:'Run now'}).click();
    await page.waitForFunction(()=>document.querySelector('#updates .task-group[open]'));
    assert.equal(await mac.nth(0).getAttribute('open'),'','Expanded groups stay open across reloads');
    await page.keyboard.press('Escape');
    await page.locator('#task-notices .task-notice-clear').nth(1).click();
    await page.waitForFunction(()=>document.querySelectorAll('#task-notices .task-notice').length===1);
    assert.deepEqual(actions,[
      {group:'dotfiles',action:'run',task:'agent plugins'},
      {group:'dotfiles',action:'run',host:'mesh-dompc'},
      {group:'dotfiles',action:'clear',host:'mesh-dompc'}]);

    tasks={computers:[{name:'Mac',local:true,groups:[],error:null}]};
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.getElementById('task-notices').hidden);
    await page.locator('#settings').click();await page.getByRole('tab',{name:'Updates'}).click();
    await page.waitForFunction(()=>document.querySelector('#updates .log-note')?.textContent==='No update tasks configured');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
