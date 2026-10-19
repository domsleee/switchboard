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
  vm.runInNewContext(source,{window,document,performance:{now:()=>now,timeOrigin:1000000},PerformanceObserver:Observer,
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
    task(duration,startTime=now){pendingTasks.push({startTime,duration,name:'private page URL',attribution:['secret terminal text']});},
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

test('delivery, iframe scheduling and reply delay remain separate across document time origins',()=>{
  for(const delays of [[650,10,5],[5,650,10],[10,5,650]]){
    const h=harness();h.visibility(true);h.advance(1000);h.visibility(false);
    const [delivery,frame,reply]=delays,childOrigin=900000;
    const receivedAt=childOrigin+(101000+delivery),animationAt=receivedAt+frame;
    h.advance(delivery+frame+reply);
    h.diagnostics.terminal({id:h.probes[0],phase:'animation',received_at:receivedAt,animation_at:animationAt,
      initial_writes_pending:7,initial_render_pending:true,writes_pending:0,render_pending:false,
      terminal_hidden:false,terminal_active:true,long_task_tracking:true,long_tasks:1,max_long_task_ms:650,total_long_task_ms:650});
    h.advance(5000);
    const sample=h.reports[0];
    assert.deepEqual([sample.terminal_message_ms,sample.terminal_frame_ms,sample.terminal_reply_ms],delays);
    assert.equal(sample.terminal_animation_ms,delivery+frame+reply);
    assert.equal(sample.initial_writes_pending,7);assert.equal(sample.writes_pending,0);
    assert.equal(sample.initial_render_pending,true);assert.equal(sample.render_pending,false);
    assert.equal(sample.terminal_hidden,false);assert.equal(sample.terminal_active,true);
    assert.equal(sample.terminal_long_task_tracking,true);assert.equal(sample.terminal_long_tasks,1);
    assert.equal(sample.terminal_max_long_task_ms,650);assert.equal(sample.terminal_total_long_task_ms,650);
  }
});

test('an immediate receipt survives a missing animation without being mistaken for the final reply',()=>{
  const h=harness();h.visibility(true);h.advance(1000);h.visibility(false);h.advance(10);
  const receipt={id:h.probes[0],phase:'received',received_at:1001005,
    initial_writes_pending:9,initial_render_pending:true,terminal_hidden:true,terminal_active:false,
    long_task_tracking:true,long_tasks:2,max_long_task_ms:700,total_long_task_ms:900};
  h.diagnostics.terminal(receipt);h.advance(100);
  h.diagnostics.terminal({...receipt,received_at:1001100,initial_writes_pending:0});
  h.advance(5000);
  const sample=h.reports[0];
  assert.equal(sample.terminal_message_ms,5);assert.equal(sample.initial_writes_pending,9);
  assert.equal(sample.terminal_animation_ms,null);assert.equal(sample.terminal_frame_ms,null);
  assert.equal(sample.writes_pending,null);assert.equal(sample.render_pending,null);
  assert.equal(sample.terminal_long_tasks,2);assert.equal(sample.terminal_hidden,true);assert.equal(sample.terminal_active,false);
});

test('invalid stage timestamps cannot become valid-looking measurements, and legacy replies still work',()=>{
  for(const timestamps of [{received_at:999999,animation_at:1000001},{received_at:1000011,animation_at:1000012},
    {received_at:'private URL',animation_at:1000001},{received_at:NaN,animation_at:Infinity}]){
    const h=harness();h.visibility(true);h.visibility(false);h.advance(10);
    h.diagnostics.terminal({id:h.probes[0],...timestamps,initial_writes_pending:'secret',long_tasks:-1});
    h.advance(5000);
    const sample=h.reports[0];
    assert.equal(sample.terminal_message_ms,null);assert.equal(sample.terminal_frame_ms,null);assert.equal(sample.terminal_reply_ms,null);
    assert.equal(sample.initial_writes_pending,null);assert.equal(sample.terminal_long_tasks,null);
    assert.doesNotMatch(JSON.stringify(sample),/private|secret|received_at|animation_at/);
  }
  const h=harness();h.visibility(true);h.visibility(false);h.advance(10);
  h.diagnostics.terminal({id:h.probes[0],received_at:1000008,animation_at:1000007});h.advance(5000);
  assert.equal(h.reports[0].terminal_message_ms,8);assert.equal(h.reports[0].terminal_frame_ms,null);
  const legacy=harness();legacy.visibility(true);legacy.visibility(false);legacy.advance(20);
  legacy.diagnostics.terminal({id:legacy.probes[0],writes_pending:0,render_pending:false});legacy.advance(5000);
  assert.equal(legacy.reports[0].terminal_animation_ms,20);assert.equal(legacy.reports[0].terminal_message_ms,null);
});

test('long tasks starting before the observation are counted when they overlap it',()=>{
  const h=harness();h.visibility(true);h.advance(1000);h.visibility(false);
  h.task(700,900);h.task(200,700);h.advance(5000);
  assert.equal(h.reports[0].long_tasks,1);assert.equal(h.reports[0].max_long_task_ms,700);
});

// Synthetic lifecycle events and native sockets, but real Chrome, xterm and the
// production parent/iframe bridge. Never attach to a live terminal.
test('a Chrome-tab wake-up persists browser and terminal timings without native focus or resize commands',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),headed=!!process.env.SWITCHBOARD_HEADFUL_RESUME;
  const browser=await chromium.launch({headless:!headed,
    ...(headed?{ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']}: {})});
  try{
    const context=await browser.newContext(),page=await context.newPage(),reports=[],errors=[];
    page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(()=>{
      if(window===top){
        window.setInterval=()=>0;
        window.addEventListener('message',event=>{
          if(event.data?.type==='zellij-browser-resume-diagnostic'&&window.fixtureReplyDelay){
            const until=performance.now()+fixtureReplyDelay;while(performance.now()<until){}
          }
        });
      }
    });
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
          window.pendingWrites=[];
          const write=term.write;
          term.write=function(data,callback){return write.call(this,data,()=>{
            if(window.holdWrites)pendingWrites.push(callback);else callback?.();
          });};
          window.addEventListener('message',event=>{
            if(event.data?.type!=='zellij-browser-resume')return;
            if(window.fixtureDeliveryDelay){const until=performance.now()+fixtureDeliveryDelay;while(performance.now()<until){}}
            if(window.fixtureFrameDelay){
              const animation=window.requestAnimationFrame;
              window.requestAnimationFrame=callback=>{
                window.requestAnimationFrame=animation;
                return setTimeout(()=>animation(time=>{
                  pendingWrites.splice(0).forEach(done=>done());callback(time);
                }),fixtureFrameDelay);
              };
            }
          });
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
      Object.defineProperty(document,'hidden',{configurable:true,get:()=>fixtureHidden});
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
    assert.ok(sample.terminal_message_ms>=600);
    assert.ok(sample.terminal_frame_ms>=0);assert.ok(sample.terminal_reply_ms>=0);
    assert.ok(Math.abs(sample.terminal_animation_ms-sample.terminal_message_ms-sample.terminal_frame_ms-sample.terminal_reply_ms)<=2);

    for(const [stage,field] of [['Delivery','terminal_message_ms'],['Frame','terminal_frame_ms'],['Reply','terminal_reply_ms']]){
      await page.evaluate(stage=>{window.fixtureReplyDelay=stage==='Reply'?650:0;},stage);
      await terminal.evaluate((_,stage)=>{
        window.fixtureDeliveryDelay=stage==='Delivery'?650:0;
        window.fixtureFrameDelay=stage==='Frame'?650:0;
        window.holdWrites=stage==='Frame';
        if(holdWrites)term.write('private fixture terminal text');
      },stage);
      if(stage==='Frame')await page.waitForFunction(()=>document.querySelector('iframe.active').contentWindow.pendingWrites.length===1);
      const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/diagnostics/browser-resume');
      await page.evaluate(()=>{
        fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'));
        fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'));
      });
      await response;
      const staged=reports.at(-1);
      assert.ok(staged[field]>=600,stage+': '+JSON.stringify(staged));
      if(stage==='Delivery')assert.ok(staged.terminal_max_long_task_ms>=600);
      if(stage==='Frame'){
        assert.equal(staged.initial_writes_pending,1);assert.equal(staged.writes_pending,0);
        assert.equal(staged.terminal_long_tasks,0,'Scheduling delay must not be reported as busy JavaScript');
      }
      assert.equal(staged.terminal_hidden,false);assert.equal(staged.terminal_active,true);
      assert.doesNotMatch(JSON.stringify(staged),/private|fixture terminal text|received_at|animation_at/);
    }
    if(headed){
      await page.evaluate(()=>{delete document.hidden;window.fixtureReplyDelay=0;});
      await terminal.evaluate(()=>{window.fixtureDeliveryDelay=0;window.fixtureFrameDelay=0;window.holdWrites=false;});
      // Focus emulation is per CDP client. A new session cannot undo Playwright's own override.
      const disableFocus=page=>require(process.env.PLAYWRIGHT_MODULE)._toImpl(page)._delegate._mainFrameSession._client
        .send('Emulation.setFocusEmulationEnabled',{enabled:false});
      await disableFocus(page);
      const other=await context.newPage();await disableFocus(other);
      await other.goto('about:blank');await other.bringToFront();
      await page.waitForFunction(()=>document.hidden,undefined,{polling:100});
      assert.equal(await page.evaluate(()=>document.hidden),true,'The original Chrome tab must really be hidden');
      await new Promise(resolve=>setTimeout(resolve,5000));
      const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/diagnostics/browser-resume');
      await page.bringToFront();await response;
      const actual=reports.at(-1);
      assert.equal(actual.reason,'visible');assert.ok(actual.hidden_ms>=4900);
      assert.equal(actual.terminal_hidden,false);assert.ok(actual.terminal_message_ms!==null);
      assert.ok(actual.terminal_frame_ms!==null);assert.ok(actual.terminal_reply_ms!==null);
      console.log('Real Chrome return:',JSON.stringify(actual));
      await other.close();
    }
    assert.deepEqual(await terminal.evaluate(()=>commands),[]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
