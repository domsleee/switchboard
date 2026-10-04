const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/static/bridge.js','utf8');
function harness(){
  const handlers={},messages=[],properties=new Map(),classes=new Set(),frames=[],resizes=[],timers=new Map();let timerId=0;
  let modal=false,focused=false,browserFocused=false,frameActive=true,bottomRows=2,firstRow='Zellij (main)';
  class Socket{constructor(){this.handlers={};this.readyState=1;this.sent=[];}addEventListener(type,fn){this.handlers[type]=fn;}send(data){this.sent.push(data);}}
  const parent={postMessage:data=>messages.push(data)};
  const window={WebSocket:Socket,addEventListener:(type,fn)=>handlers[type]=fn,dispatchEvent:()=>resizes.push(1),innerWidth:800,innerHeight:600,
    frameElement:{classList:{contains:()=>frameActive}},
    __switchboardBottomRows:()=>bottomRows,
    term:{options:{disableStdin:false},element:{contains:()=>focused,style:{pointerEvents:""}},blur(){},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>firstRow})}},_core:{_renderService:{dimensions:{css:{cell:{height:18,width:8}}}}},onRender(){},onResize(){},focus(){}}};
  const document={createElement:()=>({style:{},setAttribute(){}}),head:{append(){}},querySelector:()=>modal?{}:null,
    activeElement:{},visibilityState:'visible',hasFocus:()=>browserFocused,getElementById:()=>null,
    body:{append(){},classList:{contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)}},
    documentElement:{style:{getPropertyValue:key=>properties.get(key)||'',setProperty:(key,val)=>properties.set(key,val)}}};
  parent.document=document;
  vm.runInNewContext(source,{window,document,parent,location:{pathname:'/hosts/windows/main',origin:'http://localhost:8090'},localStorage:{getItem:()=>null},MutationObserver:class{observe(){}},requestAnimationFrame:fn=>frames.push(fn),setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),Event:class{},TextEncoder});
  const key=(code,extra={})=>{const event={code,altKey:true,ctrlKey:false,metaKey:false,shiftKey:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.keydown(event);return event;};
  const state=(payload={})=>{const socket=new window.WebSocket('ws://localhost:8090/hosts/windows/ws/control');socket.handlers.message({data:JSON.stringify({type:'MobileState',payload})});while(frames.length)frames.shift()();};
  const error=(...lines)=>{const socket=new window.WebSocket('ws://localhost:8090/hosts/windows/ws/control');socket.handlers.message({data:JSON.stringify({type:'LogError',lines})});};
  return{window,handlers,parent,messages,properties,classes,key,state,error,setFocus:v=>focused=v,setBrowserFocus:v=>browserFocused=v,setFrameActive:v=>frameActive=v,setModal:v=>modal=v,setBottomRows:v=>bottomRows=v,setFirstRow:v=>firstRow=v,frames,resizes,timers};
}
test('last focused browser claims once, background metadata and hidden sessions never reclaim',()=>{
  const h=harness(),sent=[];h.window.__zjSupportsTabViewport=true;h.window.__zjSendControl=message=>sent.push(message);
  const payload=tab=>({active_pane:{pane_id:tab+1,is_plugin:false,tab_position:tab},tab_viewport:{owner_active:false}});
  h.setBrowserFocus(true);h.state(payload(0));h.state(payload(0));
  assert.equal(sent.length,1);assert.equal(sent[0].ownership,true);assert.equal(sent[0].size.cols,100);
  h.setBrowserFocus(false);h.state(payload(1));h.handlers.focus();assert.equal(sent.length,1);
  h.setBrowserFocus(true);h.handlers.focus();assert.equal(sent.length,2);assert.equal(sent[1].tab_position,1);
  h.state(payload(1));assert.equal(sent.length,2,'A new owner in metadata must not trigger focus ping-pong');
  h.setFrameActive(false);h.state(payload(2));h.handlers.focus();assert.equal(sent.length,2);
  h.setFrameActive(true);h.state(payload(2));assert.equal(sent.length,3);
  h.parent.document.visibilityState='hidden';h.handlers.focus();assert.equal(sent.length,3);
  h.parent.document.visibilityState='visible';
  const socket=new h.window.WebSocket('ws://localhost:8090/hosts/windows/ws/control');socket.handlers.close();
  h.state(payload(2));assert.equal(sent.length,4,'A reconnected focused viewer claims its physical size');
});
test('size claim waits for the requested pane and follows the newly focused tab',()=>{
  const h=harness(),sent=[];h.window.__zjSupportsTabViewport=true;h.window.__zjSendControl=message=>sent.push(message);h.setBrowserFocus(true);
  const payload=tab=>({active_pane:{pane_id:tab+1,is_plugin:false,tab_position:tab},tab_viewport:{owner_active:false}});
  h.state(payload(0));
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:2,is_plugin:false}});
  h.handlers.focus();h.state(payload(0));
  assert.deepEqual(sent.map(m=>m.type),['SetTabViewport','FocusPane']);
  h.state(payload(1));assert.deepEqual(sent.map(m=>m.type),['SetTabViewport','FocusPane','SetTabViewport']);
  assert.equal(sent[2].tab_position,1);
});
test('New tab holds input until its native pane is active, then focuses without waiting for the catalog',()=>{
  const h=harness(),sent=[];let focused=0;
  h.window.term.focus=()=>focused++;h.window.__zjSendControl=message=>sent.push(message);
  const pane=id=>({pane_id:id,is_plugin:false,tab_position:id});
  h.state({active_pane:pane(1),panes:[pane(1),pane(2)]});
  const create=()=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-new-tab'}});
  create();create();assert.deepEqual(sent.map(m=>m.type),['NewTab']);assert.equal(h.window.term.options.disableStdin,true);
  h.state({active_pane:pane(1),panes:[pane(1),pane(2),pane(3)]});
  assert.equal(focused,0);assert.equal(h.window.term.options.disableStdin,true);
  h.state({active_pane:pane(3),panes:[pane(1),pane(2),pane(3)]});
  assert.equal(focused,1);assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.timers.size,0);
  h.state({active_pane:pane(3),panes:[pane(1),pane(2),pane(3)]});assert.equal(focused,1);
});
test('failed New tab creation restores input on timeout or disconnect',()=>{
  for(const failure of ['timeout','disconnect']){
    const h=harness();h.window.__zjSendControl=()=>{};
    h.state({active_pane:{pane_id:1,is_plugin:false},panes:[{pane_id:1,is_plugin:false}]});
    h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-new-tab'}});
    if(failure==='timeout')[...h.timers.values()][0]();
    else{const socket=new h.window.WebSocket('ws://localhost:8090/hosts/windows/ws/control');socket.handlers.close();}
    assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.timers.size,0);
  }
});
test('iframe H/L send one switch/move and stop native/browser navigation',()=>{
  const h=harness();
  for(const [code,direction] of [['KeyH',-1],['KeyL',1]]){
    h.messages.length=0;const event=h.key(code);
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(h.messages.length,1);
    assert.equal(h.messages[0].type,'zellij-tab-step');assert.equal(h.messages[0].direction,direction);
  }
  h.messages.length=0;h.key('KeyL',{shiftKey:true});assert.equal(h.messages[0].type,'zellij-tab-move');
});
test('Alt arrows move by words without switching tabs or panes',()=>{
  const h=harness();h.setFocus(true);
  const socket=new h.window.WebSocket('ws://localhost:8090/hosts/windows/ws/terminal/main');
  for(const code of ['ArrowLeft','ArrowRight'])assert.equal(h.key(code).prevented,true);
  assert.deepEqual(socket.sent.map(data=>Buffer.from(data).toString()),['\x1b[1;5D','\x1b[1;5C']);
  assert.equal(h.messages.length,0);
  h.window.term.options.disableStdin=true;assert.equal(h.key('ArrowLeft').prevented,true);
  h.window.term.options.disableStdin=false;socket.handlers.close();assert.equal(h.key('ArrowRight').prevented,true);
  assert.equal(socket.sent.length,2);
  assert.equal(h.key('ArrowLeft',{shiftKey:true}).prevented,undefined);
});
test('iframe modal and unrelated/modified keys keep native behavior',()=>{
  const h=harness();
  for(const extra of [{ctrlKey:true},{metaKey:true},{altKey:false}])assert.equal(h.key('ArrowLeft',extra).prevented,undefined);
  assert.equal(h.key('Escape',{altKey:false}).prevented,undefined);
  h.setModal(true);assert.equal(h.key('ArrowLeft').prevented,undefined);assert.equal(h.messages.length,0);
});
test('native top and bottom crop independently and restore zero offsets',()=>{
  const h=harness();h.state();
  assert.equal(h.properties.get('--switchboard-tab-height'),'18px');
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-native-tabs',visible:true}});
  assert.equal(h.classes.has('switchboard-hide-tabs'),false);assert.equal(h.classes.has('switchboard-hide-status'),true);
  assert.equal(h.properties.get('--switchboard-tab-height'),'0px');
  h.setBottomRows(0);h.setFirstRow('agent output');h.state();
  assert.equal(h.classes.has('switchboard-hide-status'),false);
});

test("bottom-bar redraws do not trigger the resize feedback loop",()=>{
  const h=harness();h.state();h.resizes.length=0;
  for(const rows of [0,1,2,0,2]){h.setBottomRows(rows);h.state();}
  assert.equal(h.resizes.length,0);
});

test('a changed WebGL backing scale recovers without resizing the terminal or looping',()=>{
  const h=harness(),term=h.window.term,redraws=[],repairs=[];
  h.setFirstRow('agent output');h.setBottomRows(0);term.cols=80;term.rows=24;
  h.properties.set('--switchboard-tab-height','0px');
  const canvas={width:1120,height:672},expected={width:560,height:336};
  term._core._renderService._renderer={value:{_canvas:canvas,dimensions:{device:{canvas:expected}},handleResize(cols,rows){
    repairs.push([cols,rows]);canvas.width=expected.width;canvas.height=expected.height;
  }}};
  term.refresh=(start,end)=>redraws.push([start,end]);
  h.state();h.state();
  assert.deepEqual(repairs,[[80,24]]);assert.deepEqual(redraws,[[0,23]]);assert.equal(h.resizes.length,0);
  expected.width=1120;expected.height=672;h.state();h.state();
  assert.equal(repairs.length,2);assert.equal(redraws.length,2);assert.equal(h.resizes.length,0);
});

test('terminal input waits for FocusPane acknowledgement',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  h.state({active_pane:{pane_id:1,is_plugin:false}});
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:2,is_plugin:false}});
  assert.equal(h.window.term.options.disableStdin,true);assert.equal(h.window.term.element.style.pointerEvents,'none');
  assert.equal(sent[0].pane_id,2);
  h.state({active_pane:{pane_id:1,is_plugin:false}});assert.equal(h.window.term.options.disableStdin,true);
  h.state({active_pane:{pane_id:2,is_plugin:false}});assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.window.term.element.style.pointerEvents,'');
});

test('fullscreen and mobile transitions clear a previous status clip',()=>{
  const window={},classes=new Set(),document={body:{append(){},classList:{contains:mode=>classes.has(mode)}}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/static/chrome.js','utf8'),{window,document});
  const screen={style:{}},term={rows:4,buffer:{active:{viewportY:0,getLine:index=>({translateToString:()=>index===3?'Ctrl + LOCK PANE TAB':''})}},_core:{screenElement:screen,_renderService:{dimensions:{css:{cell:{height:18}}}}}};
  assert.equal(window.__switchboardBottomRows(term,{}),1);assert.match(screen.style.clipPath,/18px/);
  window.__switchboardBottomRows(term,{render_prefs:{single_pane:true}});assert.equal(screen.style.clipPath,'');
  window.__switchboardBottomRows(term,{});classes.add('zj-mobile-active');window.__switchboardBottomRows(term,{});assert.equal(screen.style.clipPath,'');
});

test('rapid A to B to A waits for B then acknowledges the replacement A',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  const state=id=>h.state({active_pane:{pane_id:id,is_plugin:false}});
  const focus=(id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:id,is_plugin:false,focus_id}});
  state(1);focus(2,1);focus(1,2);assert.deepEqual(sent.map(x=>x.pane_id),[2]);assert.equal(h.window.term.options.disableStdin,true);
  state(1);assert.equal(h.window.term.options.disableStdin,true);
  assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,true);
  state(2);assert.deepEqual(sent.map(x=>x.pane_id),[2,1]);assert.equal(h.window.term.options.disableStdin,true);
  state(1);assert.equal(h.window.term.options.disableStdin,false);
  assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,false);
});

test('a rejected A to B to A focus immediately acknowledges A without a no-op command',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  h.state({active_pane:{pane_id:1,is_plugin:false}});
  const focus=(pane_id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id,is_plugin:false,focus_id}});
  focus(2,1);focus(1,2);
  h.error('Unrelated clipboard error');assert.deepEqual(sent.map(x=>x.pane_id),[2]);assert.equal(h.window.term.options.disableStdin,true);
  h.error('Could not find pane with id: Terminal(2)');assert.deepEqual(sent.map(x=>x.pane_id),[2]);
  assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,false);
  assert.equal(h.window.term.element.style.pointerEvents,'');
  assert.equal(h.messages.some(message=>message.type==='zellij-focus-failed'),false);
});

test('a disappeared target releases input and reports the exact failed request',()=>{
  const h=harness();h.window.__zjSendControl=()=>{};
  const state={active_pane:{pane_id:1,is_plugin:false},panes:[{pane_id:1,is_plugin:false}]};h.state(state);
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:2,is_plugin:false,focus_id:4}});
  h.state(state);
  const failure=h.messages.find(message=>message.type==='zellij-focus-failed');
  assert.equal(failure.focus_id,4);assert.equal(failure.payload.active_pane.pane_id,1);
  assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.messages.at(-1).focus_pending,false);
});

test('a disappeared B in A to B to A immediately acknowledges the already active A',()=>{
  const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
  const panes=[{pane_id:1,is_plugin:false},{pane_id:2,is_plugin:false}],state={active_pane:panes[0],panes};h.state(state);
  const focus=(pane_id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id,is_plugin:false,focus_id}});
  focus(2,1);focus(1,2);
  h.state({...state,panes:[panes[0]]});
  assert.deepEqual(sent.map(command=>command.pane_id),[2]);assert.equal(h.window.term.options.disableStdin,false);
  assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,false);
  assert.equal(h.window.term.element.style.pointerEvents,'');
  assert.equal(h.messages.some(message=>message.type==='zellij-focus-failed'),false);
});

test('a rejected focus still waits when its queued replacement is not the active pane',()=>{
  for(const disappeared of [false,true]){
    const h=harness(),sent=[];h.window.__zjSendControl=message=>sent.push(message);
    const panes=[1,2,3].map(pane_id=>({pane_id,is_plugin:false}));
    h.state({active_pane:panes[0],panes});
    const focus=(pane_id,focus_id)=>h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id,is_plugin:false,focus_id}});
    focus(2,1);focus(3,2);
    if(disappeared)h.state({active_pane:panes[0],panes:[panes[0],panes[2]]});
    else h.error('Could not find pane with id: Terminal(2)');
    assert.deepEqual(sent.map(command=>command.pane_id),[2,3]);assert.equal(h.window.term.options.disableStdin,true);
    h.state({active_pane:panes[2],panes:[panes[0],panes[2]]});
    assert.equal(h.window.term.options.disableStdin,false);assert.equal(h.messages.at(-1).focus_id,2);assert.equal(h.messages.at(-1).focus_pending,false);
  }
});

test('Cmd/Ctrl+K opens sidebar search from the terminal and respects dialogs',()=>{
  const h=harness();
  for(const modifier of ['metaKey','ctrlKey']){
    const event=h.key('KeyK',{altKey:false,[modifier]:true});
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);
    assert.equal(h.messages.at(-1).type,'zellij-tab-search');
  }
  h.setModal(true);assert.equal(h.key('KeyK',{altKey:false,metaKey:true}).prevented,undefined);
});

test('Ctrl+D requests Close once from the focused terminal, preserving modifiers, dialogs and unfinished focus',()=>{
  const h=harness();h.setFocus(true);h.messages.length=0;
  const key=h.key('KeyD',{altKey:false,ctrlKey:true});
  assert.equal(key.prevented,true);assert.equal(key.stopped,true);
  assert.equal(h.messages[0].type,'zellij-close-tab');
  h.key('KeyD',{altKey:false,ctrlKey:true,repeat:true});assert.equal(h.messages.length,1);
  for(const extra of [{metaKey:true},{shiftKey:true},{altKey:true},{isComposing:true}]){
    assert.equal(h.key('KeyD',{altKey:false,ctrlKey:true,...extra}).prevented,undefined);
  }
  h.setFocus(false);assert.equal(h.key('KeyD',{altKey:false,ctrlKey:true}).prevented,undefined);
  h.setFocus(true);h.setModal(true);assert.equal(h.key('KeyD',{altKey:false,ctrlKey:true}).prevented,undefined);
  h.setModal(false);h.window.__zjSendControl=()=>{};
  h.state({active_pane:{pane_id:1,is_plugin:false}});
  h.handlers.message({origin:'http://localhost:8090',source:h.parent,data:{type:'zellij-focus',pane_id:2,is_plugin:false}});
  h.messages.length=0;h.key('KeyD',{altKey:false,ctrlKey:true});
  assert.equal(h.messages.length,0);
});

test('Cmd/Ctrl+Alt+T opens New tab once only from terminal focus',()=>{
  const h=harness();h.setFocus(true);
  const key=h.key('KeyT',{ctrlKey:true});
  assert.equal(key.prevented,true);assert.equal(key.stopped,true);
  assert.equal(h.messages.length,1);assert.equal(h.messages[0].type,'zellij-open-new-tab');assert.equal(h.messages[0].host,'windows');
  const repeat=h.key('KeyT',{ctrlKey:true,repeat:true});
  assert.equal(repeat.prevented,true);assert.equal(repeat.stopped,true);assert.equal(h.messages.length,1);
  for(const extra of [{ctrlKey:false},{metaKey:true},{shiftKey:true},{isComposing:true}]){
    assert.equal(h.key('KeyT',{ctrlKey:true,...extra}).prevented,undefined);
  }
  assert.equal(h.key('KeyT',{altKey:false,metaKey:true}).prevented,undefined);
  const mac=h.key('KeyT',{metaKey:true});assert.equal(mac.prevented,true);assert.equal(mac.stopped,true);assert.equal(h.messages.length,2);
  assert.equal(h.key('KeyN',{ctrlKey:true}).prevented,undefined);
  h.setFocus(false);assert.equal(h.key('KeyT',{ctrlKey:true}).prevented,undefined);
  h.setFocus(true);h.setModal(true);assert.equal(h.key('KeyT',{ctrlKey:true}).prevented,undefined);
  h.setModal(false);h.parent.document={querySelector:()=>({})};
  assert.equal(h.key('KeyT',{ctrlKey:true}).prevented,undefined);assert.equal(h.messages.length,2);
});

test('plain Ctrl+T cannot open native Tab mode, including repeats, and preserves other input',()=>{
  const h=harness();h.setFocus(true);
  const socket=new h.window.WebSocket('ws://localhost:8090/hosts/windows/ws/terminal/main');
  for(const repeat of [false,true]){
    const event=h.key('KeyT',{altKey:false,ctrlKey:true,repeat});
    assert.equal(event.prevented,true);assert.equal(event.stopped,true);
  }
  assert.equal(socket.sent.length,0);assert.equal(h.messages.length,0);
  for(const extra of [{metaKey:true},{shiftKey:true},{isComposing:true}]){
    assert.equal(h.key('KeyT',{altKey:false,ctrlKey:true,...extra}).prevented,undefined);
  }
  h.setFocus(false);assert.equal(h.key('KeyT',{altKey:false,ctrlKey:true}).prevented,undefined);
  h.setFocus(true);h.setModal(true);assert.equal(h.key('KeyT',{altKey:false,ctrlKey:true}).prevented,undefined);
});
