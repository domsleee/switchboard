const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const assets=__dirname+'/../../zellij-client/assets/';
const source=fs.readFileSync(assets+'wheel.js','utf8').replace(/^export /gm,'');

// A terminal at 15px rows with SGR mouse reporting on, as under Zellij.
function harness({mode='vt200',rowHeight=15}={}){
  const frames=[],reports=[];let handler;
  const context={requestAnimationFrame:callback=>frames.push(callback),window:{}};
  vm.createContext(context);vm.runInContext(source,context);
  const term={rows:40,modes:{mouseTrackingMode:mode},attachCustomWheelEventHandler:h=>handler=h,_core:{
    screenElement:{},_renderService:{dimensions:{css:{cell:{height:rowHeight}}}},
    _mouseService:{getMouseReportCoords:()=>({col:4,row:7,x:60,y:105})},
    coreMouseService:{areMouseEventsActive:mode!=='none',triggerMouseEvent:event=>{reports.push(event);return true;}},
  }};
  context.installWheelHandler(term);
  let time=0;
  const wheel=(deltaY,{deltaMode=0,gap=16,...mods}={})=>handler({deltaY,deltaX:0,deltaMode,timeStamp:time+=gap,ctrlKey:false,shiftKey:false,altKey:false,...mods});
  const flush=(raw=false)=>{const pending=frames.splice(0);for(const callback of pending)callback();const sent=reports.splice(0);return raw?sent:sent.map(r=>r.action===0?'up':'down');};
  return {wheel,flush,reports,context};
}

test('a 120px wheel notch scrolls by its distance, not one report per event',()=>{
  const h=harness();
  assert.equal(h.wheel(120,{gap:500}),false,'xterm sends nothing of its own');
  assert.deepEqual(h.flush(),['down','down'],'8 rows is two 3-line reports');
  h.wheel(-120,{gap:500});
  assert.deepEqual(h.flush(),['up','up']);
});

test('a touchpad stream reports once per 3 rows of travel instead of once per row',()=>{
  const h=harness();
  let first;for(let i=0;i<30;i++){h.wheel(4);if(i===0)first=h.flush();}
  // 120px is 8 rows: the gesture's first event scrolls at once, then one more report.
  assert.deepEqual(first,['down']);
  assert.deepEqual(h.flush(),['down']);
});

test('reports from one frame go out together in a single batch',()=>{
  const h=harness();
  h.wheel(90,{gap:500});h.wheel(90);
  assert.equal(h.reports.length,0);
  assert.deepEqual(h.flush(),['down','down','down','down']);
});

test('a small first step is never lost',()=>{
  const h=harness();
  h.wheel(4,{gap:500});
  assert.deepEqual(h.flush(),['down']);
  h.wheel(4,{gap:500});
  assert.deepEqual(h.flush(),['down'],'each separate notch scrolls');
});

test('line and page deltas are already in rows',()=>{
  const h=harness();
  h.wheel(3,{deltaMode:1,gap:500});
  assert.deepEqual(h.flush(),['down'],'a Firefox notch stays one report');
  h.wheel(-1,{deltaMode:2,gap:500});
  assert.equal(h.flush().length,13,'a page is 40 rows');
});

test('changing direction starts over instead of paying off the other way',()=>{
  const h=harness();
  h.wheel(40,{gap:500});
  assert.deepEqual(h.flush(),['down']);
  h.wheel(-4);
  assert.deepEqual(h.flush(),['up']);
  h.wheel(4);
  assert.deepEqual(h.flush(),['down']);
});

test('without mouse reporting, and for Ctrl, Shift or horizontal wheels, xterm keeps the event',()=>{
  for(const mode of ['none','x10']){
    const h=harness({mode});
    assert.equal(h.wheel(120),true);assert.deepEqual(h.flush(),[]);
  }
  const h=harness();
  assert.equal(h.wheel(120,{ctrlKey:true}),true);
  assert.equal(h.wheel(120,{shiftKey:true}),true);
  assert.equal(h.wheel(0,{deltaX:50}),true);
  assert.deepEqual(h.flush(),[]);
});

test('reports carry the pointer cell and Alt, and are counted for diagnostics',()=>{
  const h=harness();let counted=0;h.context.window.__zjOnWheelReports=count=>counted+=count;
  h.wheel(45,{gap:500,altKey:true});
  const [report]=h.flush(true);
  assert.deepEqual({...report},{col:4,row:7,x:60,y:105,ctrl:false,alt:true,shift:false,button:4,action:1});
  assert.equal(counted,1);
});

test('the bundled client installs the wheel handler once the terminal is open',()=>{
  const bundle=fs.readFileSync(assets+'app.js','utf8');
  assert.match(bundle,/function installWheelHandler\(term\)/);
  assert.match(bundle,/term\.open\(document\.getElementById\("terminal"\)\);\n\s*installWheelHandler\(term\);/);
});
