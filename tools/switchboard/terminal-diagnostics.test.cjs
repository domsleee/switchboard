const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/terminal-diagnostics.js','utf8');
function harness(extraDimensions={},trackRender=false){
  let now=0,id=0,animationDelay=16;const timers=new Map(),reports=[],writes=[],window={},renderListeners=new Set();
  const timeout=(fn,delay)=>{timers.set(++id,{fn,due:now+delay});return id;};
  vm.runInNewContext(source,{window,performance:{now:()=>now},TextEncoder,
    setTimeout:timeout,clearTimeout:id=>timers.delete(id),requestAnimationFrame:fn=>timeout(fn,animationDelay)});
  const term={write(data,callback){assert.equal(this,term);writes.push({data,callback});return 'preserved';}};
  if(trackRender)term.onRender=fn=>{renderListeners.add(fn);return {dispose:()=>renderListeners.delete(fn)};};
  const diagnostics=window.SwitchboardTerminalDiagnostics(report=>reports.push(report),()=>({physical_cols:120,physical_rows:40,native_cols:120,native_rows:40,...extraDimensions}));
  const advance=ms=>{const end=now+ms;for(;;){const next=[...timers.entries()].sort((a,b)=>a[1].due-b[1].due)[0];if(!next||next[1].due>end)break;now=next[1].due;timers.delete(next[0]);next[1].fn();}now=end;};
  const start=(id,expected=true)=>diagnostics.start({focus_id:id,pane_id:30,is_plugin:false},term,expected);
  return {diagnostics,term,reports,writes,advance,start,render:()=>renderListeners.forEach(fn=>fn()),setAnimationDelay:ms=>animationDelay=ms};
}
test('slow parser report counts UTF8 bytes and preserves original ANSI, callbacks, return value and receiver',()=>{
  const h=harness();h.start(1);h.advance(10);h.diagnostics.ack();
  const secret='\x1b[2Jprivate terminal transcript 😃';h.diagnostics.frame(secret);
  let completed=0;assert.equal(h.term.write(secret,()=>completed++),'preserved');
  h.diagnostics.sent(JSON.stringify({web_client_id:'fixture',payload:{type:'TerminalResize',rows:40,cols:120}}));
  h.diagnostics.sent(JSON.stringify({web_client_id:'fixture',payload:{type:'SetTabViewport'}}));
  h.advance(650);h.writes[0].callback();h.advance(10000);
  assert.equal(completed,1);assert.equal(h.writes[0].data,secret);
  const report=h.reports[0];assert.equal(report.slow,true);assert.equal(report.ack_ms,10);
  assert.equal(report.frames,1);assert.equal(report.bytes,Buffer.byteLength(secret));
  assert.equal(report.max_parse_lag_ms,650);assert.equal(report.writes_pending,0);
  assert.equal(report.terminal_resizes,1);assert.equal(report.viewport_claims,1);
  assert.doesNotMatch(JSON.stringify(report),/private|transcript|😃/);
});
test('an oversized scrollable viewport is reported even when parsing and focus are fast',()=>{
  const h=harness({scroll_height_px:180000,client_height_px:800,scroll_top_px:179200,xterm_rows:10000,buffer_rows:10000});
  h.start(1,false);h.diagnostics.ack();h.advance(10000);
  assert.equal(h.reports[0].slow,false);assert.equal(h.reports[0].oversized_viewport,true);
  assert.equal(h.reports[0].scroll_height_px,180000);assert.equal(h.reports[0].buffer_rows,10000);
});
test('quiet settle interval and continuous output are excluded from slow switch threshold',()=>{
  const h=harness();h.start(1);h.advance(400);h.diagnostics.ack();
  h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();h.advance(150);
  assert.equal(h.reports.length,0);h.advance(9850);
  assert.equal(h.reports[0].first_quiet_ms,550);assert.equal(h.reports[0].elapsed_ms,10400);assert.equal(h.reports[0].slow,false);
  h.start(2);h.advance(10);h.diagnostics.ack();
  for(let i=0;i<20;i++){h.diagnostics.frame('screen');h.term.write('screen');h.writes.at(-1).callback();h.advance(100);}
  h.advance(8000);
  assert.equal(h.reports[1].slow,false);assert.equal(h.reports[1].frames,20);
});
test('a queue predating focus is measured and superseded spans do not keep growing',()=>{
  const h=harness();h.diagnostics.hook(h.term);h.term.write('old screen');h.advance(700);
  h.start(1);h.diagnostics.ack();h.advance(10);h.writes[0].callback();h.advance(10000);
  assert.equal(h.reports[0].max_parse_lag_ms,710);assert.equal(h.reports[0].slow,true);
  h.start(2);h.advance(600);h.start(3,false);
  assert.equal(h.reports[1].outcome,'superseded');assert.equal(h.reports[1].focus_id,2);
  h.diagnostics.ack();h.advance(10000);assert.equal(h.reports[2].slow,false);
  h.advance(20000);assert.equal(h.reports.length,3);
});
test('fast acknowledgement waits for the terminal frame, and missing rendering is reported',()=>{
  const h=harness();h.start(1);h.diagnostics.ack();h.advance(800);assert.equal(h.reports.length,0);
  h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();h.advance(10000);
  assert.equal(h.reports[0].first_parse_ms,800);assert.equal(h.reports[0].slow,true);
  h.start(2);h.diagnostics.ack();h.advance(10000);
  assert.equal(h.reports[1].outcome,'timeout');assert.equal(h.reports[1].slow,true);
});
test('missing acknowledgement reports timeout and stops collecting frames',()=>{
  const h=harness();h.start(1);h.advance(16000);
  assert.equal(h.reports[0].outcome,'timeout');assert.equal(h.reports[0].ack_ms,null);assert.equal(h.reports[0].slow,true);
  h.diagnostics.frame('late');h.advance(20000);assert.equal(h.reports.length,1);assert.equal(h.reports[0].frames,0);
});
test('later replay bursts remain observable after a quick first frame and quiet gap',()=>{
  const h=harness();h.start(1);h.diagnostics.ack();
  h.diagnostics.frame('first');h.term.write('first');h.writes[0].callback();h.advance(600);
  assert.equal(h.reports.length,0);
  for(let i=0;i<4;i++){
    h.diagnostics.frame('replay');h.term.write('replay');h.writes.at(-1).callback();h.advance(700);
  }
  h.advance(10000);
  const report=h.reports[0];
  assert.equal(report.frames,5);assert.equal(report.late_frames,4);assert.equal(report.first_quiet_ms,150);
  assert.equal(report.last_frame_ms,2700);assert.equal(report.bytes,29);assert.equal(report.first_parse_ms,0);
});
test('fast parsing cannot hide delayed terminal rendering or the next animation frame',()=>{
  for(const delayed of ['render','animation']){
    const h=harness({},true);h.start(1);h.diagnostics.ack();h.advance(10);
    h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();
    if(delayed==='render')h.advance(700);else h.setAnimationDelay(700);
    h.render();h.advance(10000);
    const report=h.reports[0];
    assert.equal(report.first_parse_ms,10);assert.equal(report.slow,true);assert.equal(report.render_events,1);
    assert.equal(delayed==='render'?report.max_render_lag_ms:report.max_animation_lag_ms,700);
    assert.ok(report.first_quiet_ms>=860);assert.equal(report.render_pending,false);assert.equal(report.animation_pending,false);
  }
});
test('missing terminal rendering remains pending despite a completed parse',()=>{
  const h=harness({},true);h.start(1);h.diagnostics.ack();h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();
  h.advance(10000);
  assert.equal(h.reports[0].outcome,'timeout');assert.equal(h.reports[0].render_pending,true);assert.equal(h.reports[0].slow,true);
});
test('redraws without new output remain visible throughout the observation window',()=>{
  const h=harness({},true);h.start(1);h.diagnostics.ack();h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();h.render();
  for(let i=0;i<5;i++){h.advance(600);h.render();}
  h.advance(10000);
  const report=h.reports[0];assert.equal(report.frames,1);assert.equal(report.last_frame_ms,0);
  assert.equal(report.render_events,6);assert.equal(report.last_render_ms,3000);assert.equal(report.last_animation_ms,3016);
});
test('temporary clipping remains recorded after the screen returns to its full height',()=>{
  const dimensions={clipped_bottom_rows:0},h=harness(dimensions,true);h.start(1);h.diagnostics.ack();
  h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();h.render();
  // The crop updates after onRender; the next animation sample must see it.
  dimensions.clipped_bottom_rows=35;h.advance(16);
  dimensions.clipped_bottom_rows=0;h.render();h.advance(10000);
  assert.equal(h.reports[0].clipped_bottom_rows,0);assert.equal(h.reports[0].max_clipped_bottom_rows,35);
});
test('native size transitions are tracked only for the requested pane',()=>{
  const h=harness();h.start(1);h.diagnostics.ack();
  const state=(pane,cols,rows)=>h.diagnostics.state({active_pane:{pane_id:pane,is_plugin:false},tab_viewport:{cols,rows}});
  state(31,80,20);state(30,120,40);state(30,120,40);state(30,162,65);state(30,120,40);
  h.diagnostics.finish('superseded');
  const report=h.reports[0];assert.equal(report.viewport_size_changes,2);assert.equal(report.first_native_cols,120);
  assert.equal(report.min_native_rows,40);assert.equal(report.max_native_cols,162);assert.equal('last_native_cols' in report,false);
});
test('replacing a terminal discards its previous pending animation probe',()=>{
  const h=harness({},true);h.setAnimationDelay(900);h.start(1);h.diagnostics.ack();
  h.diagnostics.frame('old');h.term.write('old');h.writes[0].callback();h.render();h.advance(800);
  let render;const writes=[];
  const replacement={write:(_,callback)=>writes.push(callback),onRender:fn=>{render=fn;return {dispose(){}};}};
  h.diagnostics.hook(replacement);h.setAnimationDelay(16);
  h.diagnostics.frame('new');replacement.write('new');writes[0]();render();h.advance(16);
  h.diagnostics.finish('superseded');
  assert.equal(h.reports[0].first_animation_ms,816);assert.equal(h.reports[0].max_animation_lag_ms,16);
  h.advance(1000);assert.equal(h.reports.length,1);assert.equal(h.reports[0].max_animation_lag_ms,16);
});
test('parent persists slow metadata only from its own same-origin terminal frames',()=>{
  const app=fs.readFileSync(__dirname+'/static/app.js','utf8'),sent=[];let handler;
  const frame={contentWindow:{}},entry={host:'windows',name:'main',frame};
  const context={window:{addEventListener:(_,fn)=>handler=fn},location:{origin:'https://switchboard.test'},sessions:new Map([['windows',entry]]),
    fetch:async(path,options)=>{sent.push({path,body:JSON.parse(options.body)});}};
  vm.createContext(context);
  const begin=app.indexOf('function recordTerminalDiagnostic(');
  vm.runInContext(app.slice(begin,app.indexOf("$('artifact-back').onclick",begin)),context);
  const data={type:'zellij-switch-diagnostic',diagnostic:{slow:true,pane_id:30,frames:3,bytes:100,outcome:'settled',contents:'private transcript',token:'secret'}};
  const event={origin:context.location.origin,source:frame.contentWindow,data};
  handler({...event,origin:'https://attacker.test'});handler({...event,source:{}});
  handler({...event,data:{...data,diagnostic:{...data.diagnostic,slow:false}}});assert.equal(sent.length,0);
  handler(event);assert.equal(sent.length,1);assert.equal(sent[0].path,'/api/diagnostics/terminal-switch');
  assert.deepEqual(sent[0].body,{host:'windows',pane_id:30,outcome:'settled',frames:3,bytes:100});
  handler({...event,data:{...data,diagnostic:{...data.diagnostic,slow:false,expected_render:true}}});
  assert.equal(sent.length,2);assert.equal(sent[1].body.expected_render,true,'A fast ACK can still precede a server output replay');
});
