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
test('The Performance section shows each wait per build with its slowest stages',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const series=(over)=>({journey:'conversation_to_terminal',build:'abc12345',target:'Fixture PC',first_seen:2,count:40,p50_ms:120,p95_ms:1800,max_ms:3400,outcomes:{ready:38,left:2},hidden:0,slowest:[],...over});
    let timings={computers:[
      {name:'Mac',local:true,series:[series({hidden:3,slowest:[{time:Date.now(),elapsed_ms:3400,outcome:'ready',stages:[['socket',3000],['render',400]]}]}),series({journey:'conversation_select',build:'old00000',count:5,p95_ms:900})]},
      {name:'Windows',series:[]},
      {name:'Old PC',error:"Timings unavailable on this computer's version"}]};
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await page.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/timings')return timings?json(timings):route.fulfill({status:500,body:''});
      if(path==='/api/hosts')return json([]);
      if(path==='/api/attention')return json({tabs:[],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','titles.js','style.css','timing.js'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.locator('#settings').click();await page.getByRole('tab',{name:'Performance'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#timings .log-computer').length===3);
    const rows=page.locator('#timings .timing-series');
    assert.equal(await rows.count(),2);
    assert.match(await rows.nth(0).locator('summary').textContent(),/Conversation → Terminal.*Fixture PC · abc12345.*n 40.*p50 120 ms.*p95 1\.8 s.*max 3\.4 s/);
    assert.match(await rows.nth(1).locator('summary').textContent(),/p95 —/,'Five samples are too few for a p95');
    await rows.nth(0).locator('summary').click();
    assert.match(await rows.nth(0).locator('.log-note').textContent(),/ready 38 · left 2 · 3 left out because the page was hidden/);
    assert.deepEqual(await rows.nth(0).locator('.timing-stage > span:first-child').allTextContents(),['socket','render']);
    const widths=await rows.nth(0).locator('.timing-track i').evaluateAll(bars=>bars.map(bar=>bar.style.width));
    assert.equal(Math.round(parseFloat(widths[0])),88,'Each bar is its share of the whole wait');
    const notes=await page.locator('#timings .log-computer > .log-note').allTextContents();
    assert.deepEqual(notes,['No timings yet',"Timings unavailable on this computer's version"]);
    timings=null;
    await page.locator('#refresh-timings').click();
    await page.waitForFunction(()=>document.querySelector('#timings .log-note')?.textContent.startsWith('Timings unavailable;'));
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
