const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');

test('Windows Health activates a ready build through the tray without a startable update job',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:900,height:700}}),actions=[],errors=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    const commit='b'.repeat(40),sb={commit:'aaaaaaa',automaticUpdates:true,updateNow:false,activateUpdate:false,
      readyUpdate:{commit,since:Math.floor(Date.now()/1000)-360},activationTarget:commit,updatePhase:'waiting'};
    const computer={name:'Desktop',local:true,agents:[],groups:[],switchboard:sb};
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/tasks')return json({computers:[computer]});
      if(path==='/api/tasks/update'){
        actions.push(JSON.parse(request.postData()));sb.updatePhase='requested';return json({ok:true});
      }
      if(path==='/api/hosts')return json([]);
      if(path.startsWith('/api/'))return json({});
      if(path==='/tasks.js'||path==='/style.css')return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(__dirname+'/static'+path,'utf8')});
      return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="panel-health"><p id="health-summary"></p><div id="updates"></div></div><p id="status-message"></p><script src="/tasks.js"></script>'});
    });
    await page.goto('https://health.test/');
    const refresh=async()=>{
      await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
      await page.evaluate(()=>SwitchboardTasks.load());
    };
    // A refresh that starts before the update request lands would read the old phase.
    const dispatch=async()=>{
      await Promise.all([page.waitForResponse(response=>new URL(response.url()).pathname==='/api/tasks/update'),button.click()]);
      await refresh();
    };
    await refresh();
    await page.locator('.computer-summary').click();
    const group=page.locator('.switchboard-group'),button=group.getByRole('button',{name:'Update now',exact:true});
    assert.match(await group.textContent(),/needs a newer updater/,'older services keep their capability warning');
    assert.equal(await button.count(),0);
    if(process.env.WINDOWS_ACTIVATION_SCREENSHOTS)await group.screenshot({path:process.env.WINDOWS_ACTIVATION_SCREENSHOTS+'/before.png'});
    sb.activateUpdate=true;await refresh();
    assert.equal(await button.isVisible(),true);
    assert.equal(await group.getByRole('button',{name:'Check for updates',exact:true}).count(),0);
    assert.doesNotMatch(await group.textContent(),/needs a newer updater/);
    assert.match(await group.textContent(),/Terminals briefly reconnect; running commands continue/);
    assert.doesNotMatch(await group.textContent(),/Updates leave/);
    sb.sessionsWithoutHost=['old-work'];await refresh();
    assert.match(await group.textContent(),/Updates leave old-work on the engine it has/);
    delete sb.sessionsWithoutHost;await refresh();
    if(process.env.WINDOWS_ACTIVATION_SCREENSHOTS)await group.screenshot({path:process.env.WINDOWS_ACTIVATION_SCREENSHOTS+'/after.png'});
    await dispatch();
    assert.deepEqual(actions,[{activate:commit}],'local activation queues the exact ready build');
    assert.equal(await button.isDisabled(),true,'do not dispatch twice while the tray is about to update');
    assert.match(await group.textContent(),/Update requested/);
    computer.local=false;computer.host='mesh-desktop';sb.updatePhase='waiting';await refresh();
    await page.locator('.computer-summary').click();
    await dispatch();
    assert.deepEqual(actions.at(-1),{host:'mesh-desktop',activate:commit},'paired activation targets the owning computer');
    sb.updatePhase='current';sb.readyUpdate=null;sb.activationTarget=null;await refresh();
    assert.equal(await button.count(),0,'a tray without a waiting build has no startable update action');
    assert.equal(await group.getByRole('button',{name:'Check for updates',exact:true}).count(),0);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

// All HTTP is local fixture data; never attach to user sessions.
test('Update tasks show per computer, count only failures in the sidebar, and act on the right computer',
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
    const tools={name:'work tools',every:'1d',enabled:true,paused:true,running:false,status:'ok',summary:'',notice:false,
      lastStart:now-3600e3,lastEnd:now-3590e3,nextRun:null,tasks:[task('mcp server')]};
    const windows={name:'dotfiles',every:'6h',enabled:true,paused:false,running:false,status:'changed',summary:'nushell 0.104',notice:true,
      lastStart:now-60e3,lastEnd:now-30e3,nextRun:now+6*3600e3,tasks:[task('pull + install',{changed:['nushell 0.104']})]};
    let tasks={computers:[
      {name:'Mac',local:true,groups:[dotfiles,tools],error:null},
      {name:'Workstation',host:'mesh-workstation',groups:[windows],error:null},
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
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css','tasks.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');

    const notices=page.locator('#task-notices .task-notice-open');
    await notices.waitFor();
    assert.deepEqual(await notices.allTextContents(),['Health · 1'],'successful changes are not counted as problems');
    assert.equal(await notices.getAttribute('data-status'),'attention');
    assert.equal(await notices.getAttribute('aria-label'),'Health: 1 need attention');
    assert.equal(await notices.getAttribute('title'),'Mac · dotfiles ✗ agent plugins: codex failed\nOpen Health');
    const footerHeight=(await page.locator('#sidebar-bottom').boundingBox()).height;
    const extra=Array.from({length:20},(_,i)=>({...dotfiles,name:`Extra task ${i}`}));
    tasks.computers[1].groups.push(...extra);
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await notices.textContent(),'Health · 21');
    assert.equal((await page.locator('#sidebar-bottom').boundingBox()).height,footerHeight,'more results use no extra sidebar space');
    await page.setViewportSize({width:390,height:740});
    await page.locator('#sidebar-toggle').click();
    const healthBounds=await notices.boundingBox(),settingsBounds=await page.locator('#settings').boundingBox();
    assert.ok(healthBounds.width>0&&healthBounds.x>=0&&healthBounds.x+healthBounds.width<=settingsBounds.x,'Health fits beside Settings on mobile');
    assert.equal(healthBounds.y,settingsBounds.y,'mobile results stay on the utility row');
    assert.ok(healthBounds.height>=44,'mobile health control keeps a touch target');
    tasks.computers[1].groups.splice(1);
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.setViewportSize({width:1280,height:900});

    await notices.focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('#panel-title').textContent(),'Health');
    const computers=page.locator('#updates .task-computer');
    assert.deepEqual(await computers.locator('h4').allTextContents(),['Mac','Workstation','Old PC']);
    assert.equal(await computers.nth(2).locator('.log-note').textContent(),"Update tasks unavailable on this computer's version");
    await computers.nth(0).locator('.computer-summary').click();
    await computers.nth(1).locator('.computer-summary').click();
    const mac=computers.nth(0).locator('.task-group');
    assert.equal(await mac.nth(0).locator('.task-state').textContent(),'agent plugins: codex failed');
    assert.match(await mac.nth(0).locator('.task-title small').textContent(),/^every 6h · next in 3h$/);
    assert.equal(await mac.nth(1).locator('.task-title small').textContent(),'every 1d · paused');
    assert.equal(await mac.nth(1).locator('.task-state').textContent(),'Up to date · 59m ago');
    assert.equal(await mac.nth(1).locator('.task-footer button').last().textContent(),'Resume schedule');

    await mac.nth(0).locator('summary').click();
    const rows=mac.nth(0).locator('.task-row');
    assert.equal(await rows.count(),2);
    assert.equal(await rows.nth(0).locator('.task-change').textContent(),'dotfiles: 3 commits');
    assert.equal(await rows.nth(1).locator('.task-tail').textContent(),'claude ok\ncodex failed');
    assert.match(await rows.nth(1).locator('.task-meta').textContent(),/2h ago · 4s · exit 1 · when agents are idle/);
    assert.equal(await rows.nth(1).getByRole('link',{name:'Log'}).getAttribute('href'),'/api/tasks/log?group=dotfiles&task=agent+plugins');
    assert.equal(await computers.nth(1).locator('.task-group .task-row a').getAttribute('href'),'/api/tasks/log?group=dotfiles&task=pull+%2B+install&host=mesh-workstation');

    // Actions go to the computer that owns the group; local groups carry no host.
    await rows.nth(1).getByRole('button',{name:'Run'}).click();
    await computers.nth(1).locator('.task-group summary').click();
    await computers.nth(1).getByRole('button',{name:'Check again'}).click();
    await page.waitForFunction(()=>document.querySelector('#updates .task-group[open]'));
    assert.equal(await mac.nth(0).getAttribute('open'),'','Expanded groups stay open across reloads');
    await Promise.all([page.waitForRequest(r=>r.url().endsWith('/api/tasks/action')),
      computers.nth(1).getByRole('button',{name:'Clear result',exact:true}).click()]);
    assert.deepEqual(actions,[
      {group:'dotfiles',action:'run',task:'agent plugins'},
      {group:'dotfiles',action:'run',host:'mesh-workstation'},
      {group:'dotfiles',action:'clear',host:'mesh-workstation'}]);
    dotfiles.notice=false;windows.notice=true;
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.getElementById('task-notices').hidden,null,{timeout:5000});
    await page.keyboard.press('Escape');

    tasks={computers:[{name:'Mac',local:true,groups:[],error:null,switchboard:{commit:'abc1234'},agents:[]}]};
    await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.getElementById('task-notices').hidden);
    await page.locator('#settings').click();await page.getByRole('tab',{name:'Health'}).click();
    await page.waitForFunction(()=>document.querySelector('#updates .log-note')?.textContent==='No update tasks configured');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Health shows each computer\'s build and agent reporting, and sets agents up on the right computer',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],setups=[],updates=[],repairs=[];let updateWarning;page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const now=Date.now();
    const build=(commit,at,extra={})=>({commit,commitDate:at.slice(0,10),automaticUpdates:true,...extra});
    const agent=(id,name,state,detail,extra={})=>({agent:id,name,state,detail,lastReport:null,setupError:null,setupFinished:null,...extra});
    const absent=[agent('claude','Claude Code','absent','Not installed'),agent('copilot','Copilot CLI','absent','Not installed'),agent('codex','Codex','absent','Not installed')];
    const tasks={computers:[
      {name:'Mac',local:true,groups:[],error:null,switchboard:build('0c60c7f','2026-11-04T20:21:14+11:00'),agents:[
        agent('claude','Claude Code','ready','Plugin installed · auto-updates enabled',{lastReport:now-120e3}),
        agent('copilot','Copilot CLI','setup','Plugin not installed · Auto-update off'),
        agent('codex','Codex','approve','Codex has not trusted the status hooks yet')]},
      {name:'Workstation',host:'mesh-workstation',groups:[],error:null,switchboard:build('ca42095','2026-11-04T20:04:27+11:00',{automaticUpdates:false}),agents:[
        ...absent.slice(0,2),agent('codex','Codex','setup','Status hooks not installed',{setupError:'Could not save hooks.json: denied'})]},
      {name:'Linux',host:'mesh-linux',groups:[],error:null,switchboard:build('ca42095','2026-11-04T20:04:27+11:00',{automaticUpdates:undefined}),agents:absent},
      {name:'Old PC',host:'mesh-old',groups:[],error:null},
      {name:'Laptop',host:'mesh-laptop',groups:[],error:null,switchboard:build('6a5fd4c','2026-11-04T23:16:44+11:00',{updateNow:true,lastUpdateError:'This build cannot reach paired computers yet'}),agents:absent}]};
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/tasks')return json(tasks);
      if(path==='/api/tasks/update'){updates.push(JSON.parse(request.postData()));return json({ok:true,warning:updateWarning},202);}
      if(path==='/api/tasks/setup'){
        const body=JSON.parse(request.postData());
        if(body.action==='fix-skills'){
          repairs.push(body);
          const computer=tasks.computers.find(c=>body.host?c.host===body.host:c.local);
          computer.agents.find(a=>a.agent===body.agent).skillRepair={supported:true,running:true};
          return json({ok:true},202);
        }
        setups.push(body);
        if(!body.host)tasks.computers[0].agents[1].state='running';
        return json({ok:true},202);
      }
      if(path==='/api/hosts')return json([]);
      // No attention changes in this fixture. Keep the long poll pending so a
      // fabricated refresh cannot replace the update action's status message.
      if(path==='/api/attention'&&new URL(request.url()).searchParams.has('after'))return;
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css','tasks.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.evaluate(()=>{
      const status=document.querySelector('#status-message');
      const {get,set}=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
      window.__healthStatusMessages=[];
      // Sidebar refreshes can replace this notification before Playwright polls it.
      Object.defineProperty(status,'textContent',{configurable:true,get(){return get.call(this);},set(value){set.call(this,value);window.__healthStatusMessages.push(String(value));}});
    });
    await page.locator('#settings').click();await page.getByRole('tab',{name:'Health'}).click();
    const groups=page.locator('#updates .switchboard-group');
    await page.waitForFunction(()=>document.querySelectorAll('#updates .switchboard-group').length===4);
    for(const summary of await page.locator('.computer-summary').all())await summary.click();
    const [mac,pc,linux,laptop]=[groups.nth(0),groups.nth(1),groups.nth(2),groups.nth(3)];

    // Anything needing the user opens its group and names it in the summary.
    assert.equal(await mac.getAttribute('open'),'');
    assert.equal(await mac.locator('.task-title small').textContent(),'build 0c60c7f · 2026-11-04');
    assert.equal(await mac.locator('.task-state').textContent(),'Copilot CLI: needs setup · Codex: hooks not trusted');
    const macRows=mac.locator('.agent-row');
    assert.deepEqual(await macRows.locator('.task-name').allTextContents(),['Claude Code','Copilot CLI','Codex']);
    assert.equal(await macRows.nth(0).locator('.task-meta').textContent(),'Plugin installed · auto-updates enabled · reported 2m ago');
    if(process.env.AUTO_UPDATE_SCREENSHOTS){
      await page.screenshot({path:process.env.AUTO_UPDATE_SCREENSHOTS+'/after.png',clip:await macRows.nth(0).boundingBox()});
      await macRows.nth(0).locator('.task-meta').evaluate(el=>el.textContent='reported 2m ago');
      await page.screenshot({path:process.env.AUTO_UPDATE_SCREENSHOTS+'/before.png',clip:await macRows.nth(0).boundingBox()});
      await macRows.nth(0).locator('.task-meta').evaluate(el=>el.textContent='Plugin installed · auto-updates enabled · reported 2m ago');
    }
    assert.equal(await macRows.nth(0).getByRole('button',{name:'Set up'}).count(),0);
    assert.equal(await macRows.nth(1).locator('.task-meta').textContent(),'Plugin not installed · Auto-update off');
    assert.equal(await macRows.nth(2).getByRole('button',{name:'Set up'}).count(),0);
    assert.equal(await macRows.nth(2).getByRole('button',{name:'Trust hooks'}).count(),1,'untrusted Codex hooks are trusted from here');

    assert.equal(await mac.locator('.task-row').first().locator('.task-meta').textContent(),'on');
    assert.equal(await pc.locator('.task-state').textContent(),'Automatic updates are off');
    assert.equal(await pc.locator('.task-row').first().locator('.task-name').textContent(),'Automatic updates');
    assert.equal(await pc.locator('.task-row').first().locator('.task-meta').textContent(),'off');
    assert.equal(await pc.locator('.agent-row').count(),1,'agents that are not installed are left out');
    assert.equal(await pc.locator('.agent-row .task-tail').textContent(),'Could not save hooks.json: denied');
    assert.equal(await linux.locator('.task-state').textContent(),'Update status unknown');
    assert.equal(await linux.locator('.task-row').first().locator('.task-meta').textContent(),'unknown on this build');
    assert.equal(await linux.locator('.agent-none').textContent(),'No Claude Code, Copilot CLI or Codex on this computer');
    assert.equal(await page.locator('#updates .task-computer').nth(3).locator('.log-note').first().textContent(),'Update Switchboard on this computer to check its agents');

    // An old successful report must not hide incompatible plugin hooks.
    tasks.computers[0].agents[0].state='setup';
    tasks.computers[0].agents[0].detail='Reporting and message hooks missing or out of date';
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await macRows.nth(0).getAttribute('data-status'),'failed');
    assert.equal(await macRows.nth(0).getByRole('button',{name:'Set up'}).count(),1);
    assert.match(await macRows.nth(0).locator('.task-meta').textContent(),/hooks missing or out of date/);
    assert.match(await mac.locator('.task-state').textContent(),/Claude Code: needs setup/);
    tasks.computers[0].agents[0].detail='Plugin installed · auto-updates enabled';

    // Skill warnings remain visible when hooks are ready, without offering hook setup.
    tasks.computers[0].agents=tasks.computers[0].agents.map(a=>({...a,state:'ready',lastReport:now-120e3}));
    await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelector('#updates .switchboard-group .task-state')?.textContent==='All set');
    await mac.evaluate(el=>el.open=true);
    if(process.env.PLUGIN_HOST_SCREENSHOTS)await mac.screenshot({path:process.env.PLUGIN_HOST_SCREENSHOTS+'/before.png'});

    // A damaged zellij on PATH earns the sidebar's count, not only a Health row.
    tasks.computers[0].switchboard.pathCopyDamaged=true;
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.match(await page.locator('#task-notices .task-notice-open').getAttribute('title'),/Mac · zellij on PATH is damaged/);
    tasks.computers[0].switchboard.pathCopyDamaged=false;
    await page.evaluate(()=>SwitchboardTasks.load());

    for(const agent of tasks.computers[0].agents){
      agent.plugins={state:'attention',warnings:['dotfiles-work@dotfiles: not intended for this computer or agent. Remove it from '+agent.name+'.']};
    }
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await mac.getAttribute('data-status'),'attention');
    assert.match(await mac.locator('.task-state').textContent(),/Claude Code: plugins need attention/);
    assert.equal(await mac.locator('.plugin-warning').count(),3);
    for(const row of await mac.locator('.agent-row').all())assert.equal(await row.getAttribute('data-status'),'attention');
    assert.equal(await mac.getByRole('button',{name:'Set up',exact:true}).count(),0,'host plugin warnings do not offer Switchboard hook setup');
    if(process.env.PLUGIN_HOST_SCREENSHOTS)await mac.screenshot({path:process.env.PLUGIN_HOST_SCREENSHOTS+'/after.png'});
    for(const agent of tasks.computers[0].agents)agent.plugins={state:'ok',warnings:[]};
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await mac.locator('.task-state').textContent(),'All set');
    assert.equal(await mac.locator('.plugin-warning').count(),0);
    if(process.env.SKILL_HEALTH_SCREENSHOTS)await page.screenshot({path:'/tmp/skill-health-before.png',clip:await page.locator('#updates .task-computer').first().boundingBox()});
    if(process.env.INSTALL_HEALTH_SCREENSHOTS)await mac.screenshot({path:process.env.INSTALL_HEALTH_SCREENSHOTS+'/before.png'});
    tasks.computers[0].agents[2].installation={state:'attention',manager:'npm',detail:'Codex uses an npm installation on Windows. Updates can fail with EBUSY.',command:'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'};
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelector('#updates .switchboard-group .task-state')?.textContent==='Codex: installation needs attention');
    assert.equal(await macRows.nth(2).getAttribute('data-status'),'attention');
    assert.match(await mac.locator('.installation-warning').textContent(),/EBUSY/);
    assert.match(await mac.locator('.installation-command').textContent(),/install.ps1/);
    assert.equal(await macRows.nth(2).getByRole('button').count(),0,'migration must not run hook setup');
    if(process.env.INSTALL_HEALTH_SCREENSHOTS)await mac.screenshot({path:process.env.INSTALL_HEALTH_SCREENSHOTS+'/after.png'});
    delete tasks.computers[0].agents[2].installation;
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelector('#updates .switchboard-group .task-state')?.textContent==='All set');
    tasks.computers[0].agents[2].skills={state:'attention',scope:'Codex user skills and enabled local marketplace plugins; remote and project skills not checked',warnings:[
      'pr-description-style@dotfiles: cached skills differ from source. Refresh with codex plugin add pr-description-style@dotfiles',
      'Conflicting skill pr-description-style: ~/.agents/skills/pr-description-style/SKILL.md and ~/.codex/plugins/cache/dotfiles/pr-description-style/local/skills/pr-description-style/SKILL.md']};
    await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelector('#updates .switchboard-group .task-state')?.textContent==='Codex: skills need attention');
    assert.equal(await mac.locator('.task-state').textContent(),'Codex: skills need attention');
    assert.equal(await mac.getAttribute('data-status'),'attention');
    assert.equal(await mac.locator('.skill-warning').count(),2);
    assert.equal(await mac.locator('.skill-warning').first().isVisible(),false,'raw diagnostics are collapsed');
    assert.equal(await mac.getByText('User skills need attention',{exact:true}).isVisible(),true);
    if(process.env.HEALTH_SUMMARY_SCREENSHOTS)await mac.screenshot({path:process.env.HEALTH_SUMMARY_SCREENSHOTS+'/after.png'});
    await mac.locator('.skill-details summary').click();
    assert.equal(await mac.locator('.skill-warning').first().isVisible(),true);
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await mac.locator('.skill-warning').first().isVisible(),true,'polling preserves expanded diagnostics');

    assert.equal(await macRows.nth(2).getByRole('button').count(),0);
    if(process.env.SKILL_HEALTH_SCREENSHOTS)await page.screenshot({path:'/tmp/skill-health-after.png',clip:await page.locator('#updates .task-computer').first().boundingBox()});
    const codex=tasks.computers[0].agents[2];
    if(process.env.FIX_SKILLS_SCREENSHOTS)await mac.screenshot({path:process.env.FIX_SKILLS_SCREENSHOTS+'/before.png'});
    codex.skillRepair={supported:true,running:false};
    codex.skills.refreshPlugins=['pr-description-style@dotfiles'];
    await page.evaluate(()=>SwitchboardTasks.load());
    if(process.env.FIX_SKILLS_SCREENSHOTS)await mac.screenshot({path:process.env.FIX_SKILLS_SCREENSHOTS+'/after.png'});
    await mac.getByRole('button',{name:'Fix skills',exact:true}).click();
    await mac.getByRole('button',{name:'Fixing skills…'}).waitFor({state:'visible'});
    assert.equal(await mac.getByRole('button',{name:'Fixing skills…'}).isDisabled(),true);
    codex.skillRepair={supported:true,running:false,error:'Refresh denied'};
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await mac.locator('.skill-repair-error').textContent(),'Refresh denied');
    await mac.getByRole('button',{name:'Fix skills',exact:true}).click();
    await mac.getByRole('button',{name:'Fixing skills…'}).waitFor({state:'visible'});
    codex.skillRepair={supported:true,running:false,finished:now};
    codex.skills={state:'ok',warnings:[],refreshPlugins:[]};
    const remote=tasks.computers[1].agents[2];
    remote.skillRepair={supported:true,running:false};
    remote.skills={state:'attention',warnings:['Stale plugin'],refreshPlugins:['example@test']};
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await mac.getByRole('button',{name:'Fix skills',exact:true}).count(),0);
    assert.equal(await mac.getByText('Skills refreshed. Start a new Codex conversation to use them.').count(),1);
    await pc.getByRole('button',{name:'Fix skills',exact:true}).click();
    await pc.getByRole('button',{name:'Fixing skills…'}).waitFor({state:'visible'});
    assert.deepEqual(repairs,[{agent:'codex',action:'fix-skills'},{agent:'codex',action:'fix-skills'},{agent:'codex',action:'fix-skills',host:'mesh-workstation'}]);
    delete remote.skillRepair;delete remote.skills;delete codex.skillRepair;
    tasks.computers[0].agents[1].state='setup';tasks.computers[0].agents[2].state='approve';
    delete tasks.computers[0].agents[2].skills;
    await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
    await page.evaluate(()=>SwitchboardTasks.load());

    // Setup goes to the computer that owns the agent; this computer's carries no host.
    await macRows.nth(1).getByRole('button',{name:'Set up'}).click();
    await page.waitForFunction(()=>document.querySelector('#updates .agent-row[data-agent=copilot] .task-meta')?.textContent==='Setting up…'||document.querySelector('#updates .agent-row[data-agent=copilot]')?.dataset.status==='running');
    await pc.getByRole('button',{name:'Set up'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#updates .switchboard-group').length===4);
    await page.locator('#updates .switchboard-group').nth(0).locator('.agent-row[data-agent=codex]').getByRole('button',{name:'Trust hooks'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#updates .switchboard-group').length===4);
    assert.deepEqual(setups,[{agent:'copilot'},{agent:'codex',host:'mesh-workstation'},{agent:'codex'}]);
    // A failed update shows why, and Update now starts that computer's update job.
    assert.equal(await laptop.locator('.task-state').textContent(),'Last update failed');
    assert.equal(await laptop.getAttribute('open'),'');
    assert.equal(await laptop.locator('.task-row').first().locator('.task-tail').textContent(),'This build cannot reach paired computers yet');
    assert.equal(await mac.getByRole('button',{name:'Update now'}).count(),0,'no button without an update job to start');
    await laptop.getByRole('button',{name:'Check for updates'}).click();
    await page.waitForFunction(()=>window.__healthStatusMessages.includes('Checking for a newer build on Laptop…'));
    assert.deepEqual(updates,[{host:'mesh-laptop'}]);
    const sb=tasks.computers.find(c=>c.host==='mesh-laptop').switchboard;
    // A failed check for new builds is not a failed update.
    sb.lastUpdateError=null;sb.updateCheckError='Release manifest unavailable: 504';sb.updatePhase='current';
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelectorAll('#updates .switchboard-group')[3]?.textContent.includes("Couldn't check for updates"));
    assert.equal(await laptop.locator('.task-row').first().locator('.task-tail').textContent(),'Release manifest unavailable: 504');
    sb.updateCheckError=null;sb.activateUpdate=true;sb.readyUpdate={commit:'b'.repeat(40),since:Math.floor(Date.now()/1000)-120};sb.updatePhase='waiting';
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelectorAll('#updates .switchboard-group')[3]?.textContent.includes('Update ready'));
    assert.match(await laptop.textContent(),/Terminals briefly reconnect; running commands continue/);
    assert.equal(await laptop.locator('.task-state').textContent(),'Update ready · terminals connected');
    if(process.env.UPDATE_ACTIVATION_SCREENSHOTS){
      await laptop.screenshot({path:process.env.UPDATE_ACTIVATION_SCREENSHOTS+'/ready.png'});
      await page.addScriptTag({content:require('node:child_process').execFileSync('git',['show','origin/main:tools/switchboard/static/tasks.js'],{cwd:__dirname,encoding:'utf8'})});
      await page.evaluate(()=>SwitchboardTasks.load());
      await laptop.screenshot({path:process.env.UPDATE_ACTIVATION_SCREENSHOTS+'/before.png'});
      await page.addScriptTag({content:fs.readFileSync(__dirname+'/static/tasks.js','utf8')});
      await page.evaluate(()=>SwitchboardTasks.load());
    }
    await laptop.getByRole('button',{name:'Update now',exact:true}).click();
    await page.waitForFunction(()=>window.__healthStatusMessages.includes('Update requested on Laptop; terminals will briefly reconnect…'));
    assert.deepEqual(updates.at(-1),{host:'mesh-laptop',activate:'b'.repeat(40)});
    sb.updatePhase='requested';
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.waitForFunction(()=>document.querySelectorAll('#updates .switchboard-group')[3]?.textContent.includes('Update requested'));
    assert.equal(await laptop.getByRole('button',{name:'Update now',exact:true}).isDisabled(),true);
    updateWarning='Request queued, but the update job could not start: job unavailable. Retry or wait; request expires in 5 minutes.';
    sb.updatePhase='recovery';sb.activationTarget=sb.readyUpdate.commit;sb.readyUpdate=null;
    sb.updateNotice='Recovery waiting for terminal viewers to disconnect';
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await laptop.locator('.task-state').textContent(),'Interrupted update · recovery waiting');
    assert.equal(await laptop.getByRole('button',{name:'Update now',exact:true}).isDisabled(),false);
    await laptop.getByRole('button',{name:'Update now',exact:true}).click();
    assert.deepEqual(updates.at(-1),{host:'mesh-laptop',activate:'b'.repeat(40)});
    await page.waitForFunction(message=>window.__healthStatusMessages.includes(message),updateWarning);

    // Refresh recovers a superseded selection without reauthorizing that build.
    sb.updatePhase='failed';
    sb.lastUpdateError='The requested update was superseded; check for updates and choose Update now again';
    await page.evaluate(()=>SwitchboardTasks.load());
    const updateCount=updates.length;
    await page.locator('#refresh-updates').click();
    await page.waitForFunction(()=>document.querySelector('#status-message')?.textContent==='Checking for a newer build on Laptop…');
    assert.deepEqual(updates.slice(updateCount),[{host:'mesh-laptop'}]);
    sb.lastUpdateError=null;sb.activationTarget='c'.repeat(40);sb.readyUpdate={commit:'c'.repeat(40)};sb.updatePhase='waiting';
    await page.evaluate(()=>SwitchboardTasks.load());
    await laptop.getByRole('button',{name:'Update now',exact:true}).click();
    assert.deepEqual(updates.at(-1),{host:'mesh-laptop',activate:'c'.repeat(40)});

    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Bulk Health runs skip ineligible groups, retain failures, and retry only failed groups',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),actions=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const group=(name,extra={})=>({name,enabled:true,paused:false,running:false,status:'failed',every:'12h',lastStart:1,lastEnd:2,tasks:[],...extra});
    const computers=[
      {name:'Mac',local:true,switchboard:{commit:'a',automaticUpdates:true},groups:[group('dotfiles'),group('paused',{paused:true}),group('disabled',{enabled:false}),group('busy',{running:true,status:'running'})]},
      {name:'Linux',host:'linux',switchboard:{commit:'a',automaticUpdates:true},groups:[group('dotfiles')]},
      {name:'Offline',host:'offline',error:'Computer offline',groups:[group('dotfiles')]}
    ];
    let rejectLinux=true,holdMac;
    const gate=new Promise(resolve=>holdMac=resolve);
    await page.route('**/*',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      const json=(v,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(v)});
      if(path==='/api/tasks')return json({computers});
      if(path==='/api/tasks/action'){
        const body=JSON.parse(request.postData());actions.push(body);
        if(body.host==='linux'&&rejectLinux)return json({error:'Update service unavailable'},503);
        if(!body.host)await gate;
        const c=computers.find(c=>(c.host||'')===(body.host||'')),g=c.groups.find(g=>g.name===body.group);
        g.lastStart+=10;g.running=true;g.status='running';return json({ok:true});
      }
      if(path==='/tasks.js'||path==='/style.css')return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(__dirname+'/static'+path,'utf8')});
      return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><link rel="stylesheet" href="/style.css"><div id="panel-health"><div class="settings-heading health-heading"><p id="health-summary"></p><div class="health-actions"><button id="refresh-updates">Refresh</button><button id="fix-all-health">Run all tasks</button></div></div><div id="health-batch" hidden></div><div id="updates"></div><div id="status-message"></div></div><script src="/tasks.js"></script>'});
    });
    await page.addInitScript(()=>{window.fixtureIntervals=[];window.setInterval=(fn,ms)=>{window.fixtureIntervals.push(ms);return window.fixtureIntervals.length};});
    await page.goto('https://health.test/');
    await page.locator('#fix-all-health').click();
    assert.equal(await page.locator('#fix-all-health').isDisabled(),true);
    assert.equal(await page.locator('.computer-run').count(),0);
    holdMac();
    await page.waitForFunction(()=>document.getElementById('health-batch').textContent.includes('Update service unavailable'));
    assert.deepEqual(actions,[{group:'dotfiles',action:'run'},{group:'dotfiles',action:'run',host:'linux'}]);
    assert.match(await page.locator('#health-batch').textContent(),/1\/2 repairs finished/);
    assert.equal(await page.evaluate(()=>fixtureIntervals.includes(2000)),true,'running tasks poll promptly');
    // Refreshing old results or losing contact must not pretend an accepted run finished.
    computers[0].error='Connection lost';
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await page.locator('#fix-all-health').isDisabled(),true);
    assert.match(await page.locator('#health-batch').textContent(),/Connection lost/);
    delete computers[0].error;
    Object.assign(computers[0].groups[0],{running:false,status:'failed',summary:'Update failed',lastEnd:20});
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.match(await page.locator('#health-batch').textContent(),/2\/2 repairs finished · 2 need attention/);
    // Retrying an eligible failure must retain another computer's disconnected failure.
    computers[1].error='Computer offline';
    await page.evaluate(()=>SwitchboardTasks.load());
    await page.getByRole('button',{name:'Retry failed'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.task-computer')[0].querySelector('.task-group:not(.switchboard-group)').dataset.status==='running');
    assert.equal(actions.length,3);
    assert.equal(actions.at(-1).host,undefined);
    assert.match(await page.locator('#health-batch').textContent(),/Linux.*Update service unavailable/);
    Object.assign(computers[0].groups[0],{running:false,status:'ok',summary:'',lastEnd:25});
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.match(await page.locator('#health-batch').textContent(),/2\/2 repairs finished · 1 need attention/);
    assert.equal(await page.getByRole('button',{name:'Retry failed'}).isDisabled(),true);
    delete computers[1].error;
    await page.evaluate(()=>SwitchboardTasks.load());
    rejectLinux=false;
    await page.getByRole('button',{name:'Retry failed'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.task-computer')[1].querySelector('.task-group:not(.switchboard-group)').dataset.status==='running');
    assert.deepEqual(actions.at(-1),{group:'dotfiles',action:'run',host:'linux'});
    assert.equal(actions.length,4);
    Object.assign(computers[1].groups[0],{running:false,status:'changed',summary:'dotfiles: 1 new commits not pulled, local changes',lastEnd:30});
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.match(await page.locator('#health-batch').textContent(),/Update blocked by local changes/);
    assert.match(await page.locator('.computer-state').nth(1).textContent(),/Update blocked by local changes/);
    // Native details is keyboard operable and polling retains the user's expansion.
    await page.locator('.computer-summary').nth(1).focus();await page.keyboard.press('Enter');
    await page.evaluate(()=>SwitchboardTasks.load());
    assert.equal(await page.locator('.task-computer').nth(1).getAttribute('open'),'');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Fix all installs missing plugins before refreshing skills and leaves healthy tasks alone',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),actions=[],errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const codex={agent:'codex',name:'Codex',state:'setup',detail:'Switchboard plugin not installed',setupFinished:null,
      skillRepair:{supported:true},skills:{state:'attention',warnings:['Stale skills'],refreshPlugins:['example@test']}};
    const remote={agent:'claude',name:'Claude Code',state:'approve',detail:'Hooks not trusted',setupFinished:null};
    const computers=[
      {name:'Laptop',local:true,switchboard:{commit:'abc123',automaticUpdates:true},agents:[codex],groups:[
        {name:'dotfiles',enabled:true,paused:false,running:false,status:'ok',every:'12h',lastStart:1,lastEnd:2,tasks:[]}]},
      {name:'Desktop',host:'desktop',switchboard:{commit:'abc123',automaticUpdates:true},agents:[remote],groups:[]},
      {name:'Offline',host:'offline',error:'Computer offline',agents:[{...remote}],groups:[]}
    ];
    await page.addInitScript(()=>{window.setInterval=()=>1;});
    await page.route('**/*',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/tasks')return json({computers});
      if(path==='/api/tasks/setup'){
        const body=JSON.parse(request.postData());actions.push(body);
        if(body.host)return json({error:'Setup unavailable'},503);
        if(body.action==='fix-skills')codex.skillRepair.running=true;
        else codex.state='running';
        return json({ok:true},202);
      }
      if(path==='/tasks.js'||path==='/style.css')return route.fulfill({contentType:path.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(__dirname+'/static'+path,'utf8')});
      return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css"><div id="panel-health"><p id="health-summary"></p><button id="fix-all-health">Fix all</button><div id="health-batch"></div><div id="updates"></div></div><script src="/tasks.js"></script>'});
    });
    const refresh=async()=>{
      await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
      await page.evaluate(()=>SwitchboardTasks.load());
    };
    await page.goto('https://health.test/');
    await page.waitForFunction(()=>document.querySelector('#updates')?.getAttribute('aria-busy')==='false');
    await page.getByRole('button',{name:'Fix all',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('health-batch').textContent.includes('Setup unavailable'));
    assert.deepEqual(actions,[{agent:'codex'},{agent:'claude',host:'desktop'}]);
    await refresh();
    assert.equal(actions.length,2,'skill refresh must wait for setup completion');
    codex.state='ready';codex.setupFinished=10;codex.detail='Plugin installed';
    await refresh();
    assert.deepEqual(actions.at(-1),{agent:'codex',action:'fix-skills'});
    assert.equal(actions.length,3);
    await refresh();
    assert.equal(actions.length,3,'polling cannot dispatch duplicate repairs');
    codex.skillRepair={supported:true,running:false,finished:20,error:'Refresh failed'};
    await refresh();
    assert.match(await page.locator('#health-batch').textContent(),/2\/2 repairs finished · 2 need attention/);
    assert.match(await page.locator('#health-batch').textContent(),/Refresh failed/);
    remote.state='ready';
    await refresh();
    await page.getByRole('button',{name:'Retry failed',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('health-batch').textContent.includes('1/2 repairs finished'));
    assert.equal(actions.length,4);
    assert.deepEqual(actions.at(-1),{agent:'codex',action:'fix-skills'});
    codex.skillRepair={supported:true,running:false,finished:30};codex.skills={state:'ok',warnings:[],refreshPlugins:[]};
    await refresh();
    assert.equal(await page.getByRole('button',{name:'Fix all',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('.computer-run').count(),0,'healthy computers have no repair button');
    await page.locator('.computer-summary').first().click();
    assert.equal(await page.getByRole('button',{name:'Check again',exact:true}).isVisible(),false,'healthy task action stays inside details');
    await page.locator('.task-group:not(.switchboard-group) summary').click();
    assert.equal(await page.getByRole('button',{name:'Check again',exact:true}).isVisible(),true);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
