const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/terminal-diagnostics.js','utf8');

function harness({tracking=true,discarded=false,probe=true,initialNow=0}={}){
  let now=initialNow,id=0,animationDelay=16;
  const timers=new Map(),listeners=new Map(),reports=[],probes=[],pendingTasks=[];
  const listen=(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);};
  const document={hidden:false,wasDiscarded:discarded,addEventListener:listen};
  const window={addEventListener:listen};
  const timeout=(fn,delay)=>{timers.set(++id,{fn,due:now+delay});return id;};
  class Observer{
    static supportedEntryTypes=tracking?['longtask']:[];
    constructor(fn){this.callback=fn;}
    observe(){}
    takeRecords(){return pendingTasks.splice(0);}
  }
  vm.runInNewContext(source,{window,document,performance:{now:()=>now},PerformanceObserver:Observer,
    setTimeout:timeout,clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>timeout(fn,animationDelay),
    cancelAnimationFrame:id=>timers.delete(id)});
  const diagnostics=window.SwitchboardBrowserDiagnostics(report=>reports.push(report),id=>{probes.push(id);return probe;});
  const advance=ms=>{
    const end=now+ms;
    for(;;){
      const next=[...timers.entries()].sort((a,b)=>a[1].due-b[1].due)[0];
      if(!next||next[1].due>end)break;
      now=next[1].due;timers.delete(next[0]);next[1].fn();
    }
    now=end;
  };
  const event=(type,extra={})=>listeners.get(type)?.forEach(fn=>fn({timeStamp:now,...extra}));
  return {diagnostics,reports,probes,advance,event,
    visibility(hidden,extra={}){document.hidden=hidden;event('visibilitychange',extra);},
    task(duration){pendingTasks.push({startTime:now,duration,name:'private page URL',attribution:['secret terminal text']});},
    setAnimationDelay(ms){animationDelay=ms;}};
}

test('Chrome-tab return records hidden duration, event delay, animation and terminal queue without contents',()=>{
  const h=harness();h.visibility(true);h.advance(60000);h.visibility(false,{timeStamp:59400});
  h.advance(25);
  h.diagnostics.terminal({id:h.probes[0],terminal_socket:1,control_socket:3,writes_pending:7,render_pending:true,contents:'private terminal text'});
  h.task(650);h.advance(5000);
  const sample=h.reports[0];
  assert.equal(sample.reason,'visible');assert.equal(sample.hidden_ms,60000);assert.equal(sample.event_delay_ms,600);
  assert.equal(sample.first_animation_ms,16);assert.equal(sample.terminal_animation_ms,25);
  assert.equal(sample.terminal_socket,1);assert.equal(sample.control_socket,3);
  assert.equal(sample.writes_pending,7);assert.equal(sample.render_pending,true);
  assert.equal(sample.long_tasks,1);assert.equal(sample.max_long_task_ms,650);assert.equal(sample.total_long_task_ms,650);
  assert.equal(sample.elapsed_ms,5000);assert.equal(sample.outcome,'sampled');
  assert.doesNotMatch(JSON.stringify(sample),/private|secret|contents|attribution|started/);
});

test('hidden animation probes cannot contaminate the next return, and stale or duplicate replies are ignored',()=>{
  const h=harness();h.visibility(true);h.advance(1000);h.visibility(false);
  const old=h.probes[0];h.advance(5);h.visibility(true);
  assert.equal(h.reports[0].outcome,'hidden');assert.equal(h.reports[0].first_animation_ms,null);
  h.advance(2000);h.setAnimationDelay(700);h.visibility(false);
  h.diagnostics.terminal({id:old,terminal_socket:3});
  h.advance(800);h.diagnostics.terminal({id:h.probes[1],terminal_socket:1,contents:'secret'});
  h.advance(100);h.diagnostics.terminal({id:h.probes[1],terminal_socket:3});
  h.advance(5000);
  assert.equal(h.reports.length,2);assert.equal(h.reports[1].first_animation_ms,700);
  assert.equal(h.reports[1].terminal_animation_ms,800);assert.equal(h.reports[1].terminal_socket,1);
});

test('freeze recovery, discarded reloads and back-forward cache restores have separate reasons',()=>{
  const h=harness();h.event('freeze');h.event('resume');h.advance(5000);
  assert.equal(h.reports[0].reason,'resumed');assert.equal(h.reports[0].frozen,true);
  h.event('pageshow',{persisted:true});h.advance(5000);
  assert.equal(h.reports[1].reason,'restored');assert.equal(h.reports[1].frozen,false);
  h.event('pageshow',{persisted:false});h.advance(5000);assert.equal(h.reports.length,2);
  const discarded=harness({discarded:true,initialNow:2750});discarded.advance(5000);
  assert.equal(discarded.reports[0].reason,'discarded');assert.equal(discarded.reports[0].load_ms,2750);
});

test('a normal hidden freeze resumes once, and unavailable probes stay distinct from measured zeroes',()=>{
  const h=harness({tracking:false,probe:false});
  h.visibility(true);h.event('freeze');h.advance(30000);h.event('resume');h.visibility(false);h.advance(5000);
  assert.equal(h.reports.length,1);assert.equal(h.reports[0].frozen,true);assert.equal(h.reports[0].reason,'visible');
  assert.equal(h.reports[0].hidden_ms,30000);assert.equal(h.reports[0].long_task_tracking,false);
  assert.equal(h.reports[0].terminal_probe,false);assert.equal(h.reports[0].terminal_animation_ms,null);
  assert.equal(h.reports[0].writes_pending,null);assert.equal(h.reports[0].terminal_socket,null);
  const reversed=harness();
  reversed.visibility(true);reversed.event('freeze');reversed.advance(30000);
  reversed.visibility(false);reversed.event('resume');reversed.advance(5000);
  assert.equal(reversed.reports.length,1);assert.equal(reversed.reports[0].frozen,true);
});

// Synthetic lifecycle events and native sockets, but real Chrome, xterm and the
// production parent/iframe bridge. Never attach to a live terminal.
test('a Chrome-tab wake-up persists browser and terminal timings without native focus or resize commands',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),reports=[],errors=[];
    page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(()=>{if(window===top)window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/diagnostics/browser-resume'){reports.push(route.request().postDataJSON());return route.fulfill({status:204,body:''});}
      if(path==='/api/hosts')return json([{id:'windows',name:'Windows'}]);
      if(path==='/api/hosts/windows')return json({id:'windows',name:'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs:[{host:'windows',session:'main',id:41,position:0,name:'Terminal',panes:[{pane_id:7,is_plugin:false,tab_position:0}]}],panes:[],errors:[]});
      if(path.startsWith('/api/'))return json({});
      if(path==='/hosts/windows/main')return route.fulfill({contentType:'text/html',body:`<!doctype html>
        <link rel="stylesheet" href="/assets/xterm.css"><div id="terminal"></div><script src="/assets/xterm.js"></script>
        <script>
          window.commands=[];window.WebSocket=class extends EventTarget{constructor(){super();this.readyState=1;}send(){}};
          window.term=new Terminal({cols:80,rows:24,scrollback:0});term.open(document.querySelector('#terminal'));
          window.__zjSendControl=message=>commands.push(message);
        </script><script src="/terminal-diagnostics.js"></script><script src="/bridge.js"></script><script>
          new WebSocket('wss://switchboard.test/ws/terminal');
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:7,is_plugin:false,tab_position:0};
          socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',active_pane:pane,panes:[pane]}})}));
        </script>`});
      const name=path==='/'?'index.html':path.split('/').at(-1);
      if(!/^[a-z-]+\.(html|css|js)$/.test(name))return route.fulfill({status:404,body:''});
      const file=__dirname+(path.startsWith('/assets/')?'/../../zellij-client/assets/':'/static/')+name;
      if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=windows&session=main&tab=41');
    await page.waitForFunction(()=>document.querySelector('iframe.active')?.contentWindow?.term&&sessions.get(JSON.stringify(['windows','main']))?.state);
    const terminal=page.frameLocator('iframe.active').locator('#terminal');
    await terminal.evaluate(()=>{commands.length=0;});
    const received=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/diagnostics/browser-resume');
    await page.evaluate(()=>{
      window.fixtureHidden=true;
      Object.defineProperty(document,'hidden',{get:()=>fixtureHidden});
      document.dispatchEvent(new Event('visibilitychange'));
      fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));
      const until=performance.now()+650;while(performance.now()<until){}
    });
    await received;
    assert.equal(reports.length,1);
    const sample=reports[0];assert.equal(sample.reason,'visible');assert.equal(sample.terminal_probe,true);
    assert.ok(sample.first_animation_ms>=600);assert.ok(sample.terminal_animation_ms>=600);
    assert.equal(sample.terminal_socket,1);assert.equal(sample.control_socket,1);
    assert.equal(sample.writes_pending,0);assert.equal(sample.render_pending,false);
    assert.deepEqual(await terminal.evaluate(()=>commands),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
