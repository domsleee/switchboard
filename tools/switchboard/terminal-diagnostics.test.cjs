const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/static/terminal-diagnostics.js','utf8');
function harness(extraDimensions={}){
  let now=0,id=0;const timers=new Map(),reports=[],writes=[],window={};
  vm.runInNewContext(source,{window,performance:{now:()=>now},TextEncoder,
    setTimeout:(fn,delay)=>{timers.set(++id,{fn,due:now+delay});return id;},clearTimeout:id=>timers.delete(id)});
  const term={write(data,callback){assert.equal(this,term);writes.push({data,callback});return 'preserved';}};
  const diagnostics=window.SwitchboardTerminalDiagnostics(report=>reports.push(report),()=>({physical_cols:120,physical_rows:40,native_cols:120,native_rows:40,...extraDimensions}));
  const advance=ms=>{const end=now+ms;for(;;){const next=[...timers.entries()].sort((a,b)=>a[1].due-b[1].due)[0];if(!next||next[1].due>end)break;now=next[1].due;timers.delete(next[0]);next[1].fn();}now=end;};
  const start=(id,expected=true)=>diagnostics.start({focus_id:id,pane_id:30,is_plugin:false},term,expected);
  return {diagnostics,term,reports,writes,advance,start};
}
test('slow parser report counts UTF8 bytes and preserves original ANSI, callbacks, return value and receiver',()=>{
  const h=harness();h.start(1);h.advance(10);h.diagnostics.ack();
  const secret='\x1b[2Jprivate terminal transcript 😃';h.diagnostics.frame(secret);
  let completed=0;assert.equal(h.term.write(secret,()=>completed++),'preserved');
  h.diagnostics.sent(JSON.stringify({web_client_id:'fixture',payload:{type:'TerminalResize',rows:40,cols:120}}));
  h.diagnostics.sent(JSON.stringify({web_client_id:'fixture',payload:{type:'SetTabViewport'}}));
  h.advance(650);h.writes[0].callback();h.advance(150);
  assert.equal(completed,1);assert.equal(h.writes[0].data,secret);
  const report=h.reports[0];assert.equal(report.slow,true);assert.equal(report.ack_ms,10);
  assert.equal(report.frames,1);assert.equal(report.bytes,Buffer.byteLength(secret));
  assert.equal(report.max_parse_lag_ms,650);assert.equal(report.writes_pending,0);
  assert.equal(report.terminal_resizes,1);assert.equal(report.viewport_claims,1);
  assert.doesNotMatch(JSON.stringify(report),/private|transcript|😃/);
});
test('an oversized scrollable viewport is reported even when parsing and focus are fast',()=>{
  const h=harness({scroll_height_px:180000,client_height_px:800,scroll_top_px:179200,xterm_rows:10000,buffer_rows:10000});
  h.start(1,false);h.diagnostics.ack();h.advance(150);
  assert.equal(h.reports[0].slow,false);assert.equal(h.reports[0].oversized_viewport,true);
  assert.equal(h.reports[0].scroll_height_px,180000);assert.equal(h.reports[0].buffer_rows,10000);
});
test('quiet settle interval and continuous output are excluded from slow switch threshold',()=>{
  const h=harness();h.start(1);h.advance(400);h.diagnostics.ack();
  h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();h.advance(150);
  assert.equal(h.reports[0].elapsed_ms,550);assert.equal(h.reports[0].slow,false);
  h.start(2);h.advance(10);h.diagnostics.ack();
  for(let i=0;i<20;i++){h.diagnostics.frame('screen');h.term.write('screen');h.writes.at(-1).callback();h.advance(100);}
  assert.equal(h.reports[1].slow,false);assert.equal(h.reports[1].frames,20);
});
test('a queue predating focus is measured and superseded spans do not keep growing',()=>{
  const h=harness();h.diagnostics.hook(h.term);h.term.write('old screen');h.advance(700);
  h.start(1);h.diagnostics.ack();h.advance(10);h.writes[0].callback();h.advance(150);
  assert.equal(h.reports[0].max_parse_lag_ms,710);assert.equal(h.reports[0].slow,true);
  h.start(2);h.advance(600);h.start(3,false);
  assert.equal(h.reports[1].outcome,'superseded');assert.equal(h.reports[1].focus_id,2);
  h.diagnostics.ack();h.advance(150);assert.equal(h.reports[2].slow,false);
  h.advance(20000);assert.equal(h.reports.length,3);
});
test('fast acknowledgement waits for the terminal frame, and missing rendering is reported',()=>{
  const h=harness();h.start(1);h.diagnostics.ack();h.advance(800);assert.equal(h.reports.length,0);
  h.diagnostics.frame('screen');h.term.write('screen');h.writes[0].callback();h.advance(150);
  assert.equal(h.reports[0].first_parse_ms,800);assert.equal(h.reports[0].slow,true);
  h.start(2);h.diagnostics.ack();h.advance(2000);
  assert.equal(h.reports[1].outcome,'timeout');assert.equal(h.reports[1].slow,true);
});
test('missing acknowledgement reports timeout and stops collecting frames',()=>{
  const h=harness();h.start(1);h.advance(16000);
  assert.equal(h.reports[0].outcome,'timeout');assert.equal(h.reports[0].ack_ms,null);assert.equal(h.reports[0].slow,true);
  h.diagnostics.frame('late');h.advance(20000);assert.equal(h.reports.length,1);assert.equal(h.reports[0].frames,0);
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
