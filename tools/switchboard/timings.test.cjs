const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

function timer({hidden=false}={}){
  const listeners={},posts=[],timers=[];let clock=1000;
  const document={hidden,addEventListener:(name,fn)=>{listeners[name]=fn;}};
  const window={};
  const context={window,document,clearTimeout,setTimeout:fn=>{timers.push(fn);return timers.length;},
    performance:{now:()=>clock,measure(){}},
    fetch:(url,init)=>{posts.push({url,body:JSON.parse(init.body)});return Promise.resolve();}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/static/timing.js','utf8'),context);
  return {timing:window.SwitchboardTiming,posts,document,advance:ms=>{clock+=ms;},timeout(){timers.at(-1)();},changeVisibility(){listeners.visibilitychange();}};
}

test('A journey reports its wait and numeric stages without an unmeasured stage',()=>{
  const {timing,posts,advance}=timer();
  const journey=timing.begin('conversation_to_terminal',{host:'mesh-a'});
  advance(250);journey.end('ready',{stages:{socket:30,frame_ms:40.4,render:null}});
  assert.equal(posts[0].url,'/api/diagnostics/timing');
  assert.deepEqual(JSON.parse(JSON.stringify(posts[0].body)),{journey:'conversation_to_terminal',outcome:'ready',elapsed_ms:250,hidden:false,stages:[['socket',30],['frame',40]],host:'mesh-a'});
});

test('A journey ends once, so a late report cannot overwrite the first result',()=>{
  const {timing,posts,advance}=timer();
  const journey=timing.begin('conversation_to_terminal');
  advance(10);journey.end('left');advance(10);journey.end('ready');
  assert.equal(posts.length,1);assert.equal(posts[0].body.outcome,'left');
});

test('A timed out terminal wait retains its last known stage without increasing the deadline',()=>{
  const {timing,posts,advance,timeout}=timer();let metadata=0;
  const journey=timing.begin('terminal_input_ready',{timeoutStages:()=>({metadata,focus:30000-metadata})});
  metadata=20000;advance(30000);timeout();journey.end('ready');
  assert.equal(posts.length,1);
  assert.equal(posts[0].body.outcome,'timeout');
  assert.deepEqual(posts[0].body.stages,[['metadata',20000],['focus',10000]]);
});

test('Time spent in a background tab is marked hidden rather than counted as a wait',()=>{
  const {timing,posts,document,advance,changeVisibility}=timer();
  const journey=timing.begin('conversation_to_terminal');
  advance(10);document.hidden=true;changeVisibility();
  advance(86400000);document.hidden=false;changeVisibility();
  advance(10);journey.end('ready');
  assert.equal(posts[0].body.hidden,true);
  assert.equal(posts[0].body.elapsed_ms,120000,'Elapsed time stays within what the relay accepts');
});

test('A journey that starts after the tab returns is not marked hidden',()=>{
  const {timing,posts,document,advance,changeVisibility}=timer();
  document.hidden=true;changeVisibility();advance(5000);document.hidden=false;changeVisibility();advance(1);
  const journey=timing.begin('conversation_to_terminal');advance(50);journey.end('ready');
  assert.equal(posts[0].body.hidden,false);
});

// All HTTP is local fixture data; never attach to user sessions.
test('Performance dashboard separates browser, destination and build, preserves inspection and stops polling',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),path=require('node:path');
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const series=over=>({journey:'conversation_to_terminal',build:'abc12345',target:'Fixture PC',first_seen:2,count:40,p50_ms:120,p95_ms:1800,max_ms:3400,outcomes:{ready:40},hidden:0,slowest:[],...over});
    let requests=0,fail=false,held;
    let timings={computers:[
      {name:'Windows',local:true,series:[]},
      {name:'Mac',series:[series({hidden:3,slowest:[{time:Date.now(),elapsed_ms:3400,outcome:'ready',stages:[['socket',3000],['render',400]]}]}),
        series({journey:'conversation_select',count:5,p50_ms:16,p95_ms:32,max_ms:32}),
        series({journey:'conversation_select',target:'Studio',count:2,p50_ms:25,max_ms:30}),
        series({journey:'conversation_select',build:'old00000',first_seen:1,count:50,p50_ms:900,p95_ms:1000,max_ms:1200})]},
      {name:'Old PC',error:"Timings unavailable on this computer's version"}]};
    await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-performance-computer','Removed PC');});
    await page.clock.install();
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),p=url.pathname;
      const json=value=>route.fulfill({json:value});
      if(p==='/api/timings'){requests++;if(held)await new Promise(resolve=>held=resolve);return fail?route.fulfill({status:500,body:''}).catch(()=>{}):json(timings).catch(()=>{});}
      if(p==='/api/hosts')return json([]);
      if(p==='/api/attention'){if(url.searchParams.has('after'))return;return json({version:1,tabs:[],panes:[],errors:[]});}
      if(p.startsWith('/api/'))return json({});
      const file=p==='/'?'index.html':p.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css','timing.js','performance.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({path:path.join(__dirname,'static',file),contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    });
    await page.goto('https://switchboard.test/');
    assert.equal(requests,0,'No dashboard traffic until opened');
    assert.equal(await page.locator('#performance + #settings').count(),1,'Icon sits beside Settings');
    await page.getByRole('button',{name:'Performance dashboard',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#timing-series details').length===3);
    assert.equal(await page.locator('#timing-computer').inputValue(),'Mac','Defaults to the computer with measurements when this relay has none');
    assert.equal(await page.locator('#timing-build').inputValue(),'abc12345');
    const cached=page.locator('.perf-card[data-journey=conversation_select]');
    assert.equal(await cached.locator('.perf-value').textContent(),'16 ms – 25 ms','Shows a range of destination medians, never an invented aggregate percentile');
    assert.match(await cached.locator('.perf-card-meta').textContent(),/7 samples/);
    assert.match(await page.locator('.perf-card[data-journey=conversation_load]').textContent(),/No samples/);
    assert.match(await page.locator('#timing-scale').textContent(),/0 – 3\.4 s/);
    const medianPosition=await cached.locator('.perf-range-median').evaluate(node=>parseFloat(node.style.left));
    assert.ok(Math.abs(medianPosition-25/3400*100)<0.001,'All comparison marks use the same measured maximum');
    assert.equal(await page.locator('.perf-card[data-journey=conversation_load] .perf-range').evaluate(node=>node.children.length),0,'Missing samples have no plotted marks');
    const rows=page.locator('#timing-series details'),terminal=rows.filter({hasText:'Return to terminal'});
    assert.ok((await page.locator('#timings').boundingBox()).width>640,'Dashboard uses the available desktop width');
    const medianColumns=await rows.locator('summary').evaluateAll(summaries=>summaries.map(summary=>summary.querySelectorAll('.timing-stat')[1].getBoundingClientRect().x));
    assert.equal(new Set(medianColumns).size,1,'Desktop median values share one column');
    assert.match(await terminal.locator('summary').textContent(),/Samples 40.*Median 120 ms.*p95 1\.8 s.*Worst 3\.4 s/);
    assert.match(await rows.filter({hasText:'Switch conversation'}).first().locator('summary').textContent(),/p95 —/);
    await terminal.locator('summary').click();
    assert.match(await terminal.textContent(),/3 excluded because the page was hidden/);
    assert.deepEqual(await terminal.locator('.timing-stage > span:first-child').allTextContents(),['socket','render']);
    assert.equal(Math.round(await terminal.locator('.timing-track i').first().evaluate(bar=>parseFloat(bar.style.width))),88);
    await terminal.locator('summary').focus();
    const before=requests;await page.clock.runFor(10050);
    await page.waitForFunction(()=>document.querySelector('#timings').getAttribute('aria-busy')==='false');
    assert.equal(requests,before+1);assert.equal(await terminal.getAttribute('open'),'');
    assert.equal(await page.locator('#timing-announcement').textContent(),'','Routine refresh timestamps do not interrupt screen-reader users');
    assert.equal(await terminal.locator('summary').evaluate(node=>node===document.activeElement),true,'Unchanged refresh preserves keyboard inspection');
    timings.computers[1].series[0].count++;
    await page.clock.runFor(10050);await page.waitForFunction(()=>document.querySelector('#timing-series').textContent.includes('Samples 41'));
    assert.equal(await terminal.getAttribute('open'),'','Changed data preserves expanded rows');
    assert.equal(await terminal.locator('summary').evaluate(node=>node===document.activeElement),true,'Changed data preserves keyboard focus');
    await page.locator('#refresh-timings').focus();await page.clock.runFor(10050);
    await page.waitForFunction(()=>document.querySelector('#timings').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('#refresh-timings').evaluate(node=>node===document.activeElement),true,'Automatic refresh never disables or blurs Refresh');
    if(process.env.PERF_SCREENSHOTS){fs.mkdirSync(process.env.PERF_SCREENSHOTS,{recursive:true});await page.locator('#panel').screenshot({path:path.join(process.env.PERF_SCREENSHOTS,'dashboard.png')});}
    await page.locator('#timing-target').selectOption('Studio');assert.equal(await rows.count(),1);assert.equal(await cached.locator('.perf-value').textContent(),'25 ms');
    await page.locator('#timing-build').selectOption('old00000');assert.equal(await page.locator('#timing-target').inputValue(),'','Missing destinations reset safely');assert.equal(await cached.locator('.perf-value').textContent(),'900 ms');
    await page.locator('#timing-computer').selectOption('Windows');assert.match(await page.locator('#timing-series').textContent(),/No timings yet/);
    await page.locator('#timing-computer').selectOption('Old PC');assert.match(await page.locator('#timing-series').textContent(),/Timings unavailable on this computer/);
    await page.locator('#timing-computer').selectOption('Mac');assert.equal(await page.locator('#timing-build').inputValue(),'abc12345');
    fail=true;await page.locator('#refresh-timings').click();await page.locator('#timing-status').filter({hasText:/Refresh failed\. Showing the last measurements/}).waitFor();assert.equal(await rows.count(),3);
    await page.locator('#timing-target').selectOption('Studio');assert.match(await page.locator('#timing-status').textContent(),/Refresh failed/,'Filtering cannot make stale measurements appear current');
    await page.locator('#timing-target').selectOption('');
    fail=false;await page.locator('#refresh-timings').click();await page.waitForFunction(()=>!document.querySelector('#timing-status').classList.contains('perf-stale'));
    assert.doesNotMatch(await page.locator('#timing-status').textContent(),/failed/,'An unchanged successful refresh clears the stale warning');
    await page.evaluate(()=>{window.perfHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>perfHidden});document.dispatchEvent(new Event('visibilitychange'));});
    const hidden=requests;await page.clock.runFor(20000);assert.equal(requests,hidden,'A background browser tab stops dashboard polling');
    await page.evaluate(()=>{perfHidden=false;document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>document.querySelector('#timings').getAttribute('aria-busy')==='false');assert.equal(requests,hidden+1,'Returning to the browser refreshes immediately');
    await page.getByRole('tab',{name:'Settings',exact:true}).click();const stopped=requests;await page.clock.runFor(20000);assert.equal(requests,stopped,'No polling in other sections');
    await page.getByRole('tab',{name:'Performance',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#timings').getAttribute('aria-busy')==='false');
    await page.setViewportSize({width:390,height:844});
    await page.locator('#close-panel').click();await page.evaluate(()=>document.querySelector('#performance').click());
    await page.waitForFunction(()=>document.querySelector('#timings').getAttribute('aria-busy')==='false');
    assert.equal(await page.locator('#panel-performance').evaluate(node=>node.scrollWidth<=node.clientWidth),true,'Phone dashboard fits without horizontal scrolling');
    const selectedTab=await page.locator('#panel-tab-performance').boundingBox();
    assert.ok(selectedTab.x>=0&&selectedTab.x+selectedTab.width<=390,'The selected phone tab scrolls fully into view');
    assert.equal(await page.locator('#timing-build').evaluate(node=>getComputedStyle(node).fontSize),'16px','Phone controls avoid focus zoom');
    const cardRows=await page.locator('.perf-card').evaluateAll(cards=>cards.map(card=>card.getBoundingClientRect().left));
    assert.equal(new Set(cardRows).size,1,'Phone summaries use readable single-column rows');
    if(process.env.PERF_SCREENSHOTS)await page.locator('#panel').screenshot({path:path.join(process.env.PERF_SCREENSHOTS,'dashboard-mobile.png')});
    held=true;await page.locator('#refresh-timings').click();await page.waitForFunction(()=>document.querySelector('#timings').getAttribute('aria-busy')==='true');
    await page.keyboard.press('Escape');held();held=null;const closed=requests;await page.clock.runFor(20000);assert.equal(requests,closed,'Closing cancels in-flight work and polling');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Waiting for a running agent to report its chat is timed until that chat arrives',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),path=require('node:path');
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],reports=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');});
    await page.route('http://connect.test/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/diagnostics/timing'){reports.push(route.request().postDataJSON());return route.fulfill({status:204});}
      if(url.pathname.startsWith('/api/chats/'))return route.fulfill({json:{messages:[{role:'assistant',text:'Bound'}],start_cursor:0,previous_cursor:null,next_cursor:null}});
      if(url.pathname.startsWith('/api/'))return route.fulfill({json:{}});
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><main id="terminals" style="height:100dvh;position:relative"><section id="artifact-preview" hidden></section></main><script src="/timing.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',chatHost:'fixture',pane:1,agent:'codex',state:'working'};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});window.select=value=>{current=value;SwitchboardConversation.update();};</script>`});
      return route.fulfill({path:path.join(__dirname,'static',path.basename(url.pathname)),contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript'}).catch(()=>route.abort());
    });
    const connect=()=>reports.filter(report=>report.journey==='conversation_connect');
    const until=async count=>{for(let i=0;i<100&&connect().length<count;i++)await page.waitForTimeout(20);assert.equal(connect().length,count);};
    await page.goto('http://connect.test/');
    await page.getByText('Connecting to this agent’s conversation…').waitFor();
    await page.waitForTimeout(150);
    assert.equal(connect().length,0,'The wait stays open while the chat is unknown');
    await page.evaluate(()=>select({...current,chatId:'chat-1'}));
    await until(1);
    assert.equal(connect()[0].outcome,'ready');assert.equal(connect()[0].host,'fixture');
    assert.ok(connect()[0].elapsed_ms>=150,'The journey covers the whole wait');
    await page.evaluate(()=>select({key:'pane2',host:'fixture',chatHost:'fixture',pane:2,agent:'codex',state:'working'}));
    await page.getByText('Connecting to this agent’s conversation…').waitFor();
    await page.evaluate(()=>select({key:'pane3',host:'fixture',chatHost:'fixture',pane:3,agent:'codex',state:'ready',chatId:'chat-3'}));
    await until(2);
    assert.equal(connect()[1].outcome,'left','Moving to another chat is not mistaken for this one connecting');
    const unbound=pane=>({key:`pane${pane}`,host:'fixture',chatHost:'fixture',pane,agent:'codex',state:'working'});
    await page.evaluate(value=>select(value),unbound(4));
    await page.getByText('Connecting to this agent’s conversation…').waitFor();
    await page.evaluate(value=>select(value),unbound(5));
    await until(3);
    assert.equal(connect()[2].outcome,'left','Moving between two connecting agents ends the first wait');
    await page.evaluate(()=>select({...current,chatId:'chat-5'}));
    await until(4);
    assert.equal(connect()[3].outcome,'ready','The second agent has its own wait');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
