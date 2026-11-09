const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/static/bridge.js','utf8');
function harness(){
 const handlers={},calls=[],inputs=[],notices=[],focus={},posted=[],parent={document:{querySelector:()=>null},postMessage(message){posted.push(message);}},frames=[];
 let modal=false,focused=true,response={ok:true},payload={session_name:'current-session',active_pane:{pane_id:13,is_plugin:false}};
 class Socket{constructor(){this.handlers={};this.readyState=1;}addEventListener(t,f){this.handlers[t]=f;}send(){}}
 const window={WebSocket:Socket,addEventListener:(t,f)=>handlers[t]=f,term:{options:{},element:{contains:el=>focused&&el===focus},focus(){},input(data){inputs.push(data);}}};
 const document={activeElement:focus,createElement:()=>({setAttribute(){},style:{},textContent:''}),head:{append(){}},body:{append:el=>notices.push(el)},querySelector:()=>modal?{}:null};
 vm.runInNewContext(source,{window,document,parent,navigator:{platform:'MacIntel'},location:{pathname:'/hosts/windows/old-session',origin:'http://localhost:8090'},localStorage:{getItem:()=>null},requestAnimationFrame:fn=>frames.push(fn),fetch:async(url,opts)=>{calls.push({url,...JSON.parse(opts.body)});return response;}});
 const socket=new window.WebSocket('ws://localhost/hosts/windows/ws/control'),terminal=new window.WebSocket('ws://localhost/hosts/windows/ws/terminal');
 const state=p=>socket.handlers.message({data:JSON.stringify({type:'MobileState',payload:p})});state(payload);
 const key=extra=>{const e={code:'Escape',altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};handlers.keydown(e);return e;};
 const message=data=>handlers.message({origin:'http://localhost:8090',source:parent,data});
 return {calls,inputs,message,notices,key,state,socket,terminal,posted,parent,setFocused:v=>focused=v,setModal:v=>modal=v,setResponse:v=>response=v};
}
const flush=()=>new Promise(r=>setImmediate(r));
// Escape travels like any other key: xterm sends byte 27 on the terminal socket,
// in order with typing, instead of a relay request per press.
test('terminal Escape is left to xterm, with no relay request',async()=>{const h=harness();for(const extra of [{},{shiftKey:true},{ctrlKey:true}]){const e=h.key(extra);assert.equal(e.prevented,undefined);assert.equal(e.stopped,undefined);}h.state({session_name:'current',active_pane:{pane_id:1,is_plugin:true}});assert.equal(h.key().prevented,undefined);await flush();assert.deepEqual(h.calls,[]);assert.deepEqual(h.inputs,[]);});
test('Escape forwarded by the sidebar is typed into the terminal',async()=>{const h=harness();h.message({type:'zellij-escape'});h.state({session_name:'current',active_pane:{pane_id:1,is_plugin:true}});h.message({type:'zellij-escape'});await flush();assert.deepEqual(h.inputs,['\x1b','\x1b']);assert.deepEqual(h.calls,[]);});
test('a dialog keeps a forwarded Escape',async()=>{const h=harness();h.setModal(true);h.message({type:'zellij-escape'});assert.deepEqual(h.inputs,[]);});
const sentEscapes=h=>h.posted.filter(m=>m.type==='zellij-escape-sent').map(m=>m.pane_id);
test('Escape typed into the terminal tells the sidebar which pane got it',()=>{const h=harness();h.terminal.send('\x1b');h.terminal.send('a');h.terminal.send('\x1b[A');assert.deepEqual(sentEscapes(h),[13]);h.state({session_name:'current-session',active_pane:{pane_id:1,is_plugin:true}});h.terminal.send('\x1b');assert.deepEqual(sentEscapes(h),[13]);});
const interrupt=(h,extra={})=>{h.message({type:'zellij-interrupt',id:7,session:'current-session',pane_id:13,expires:Date.now()+200,...extra});return h.posted.filter(m=>m.type==='zellij-interrupt-result').at(-1);};
test('Stop types Escape on the open terminal socket when it shows that pane',()=>{const h=harness();assert.deepEqual({...interrupt(h)},{type:'zellij-interrupt-result',id:7,ok:true});assert.deepEqual(h.inputs,['\x1b']);});
test('Stop leaves Escape to the relay unless the socket can deliver it to that pane now',()=>{
 for(const [name,change,extra] of [['another pane',()=>{},{pane_id:14}],['another session',()=>{},{session:'other'}],['a late request',()=>{},{expires:Date.now()-1}],['a dialog',h=>h.setModal(true)],['a closed socket',h=>{h.terminal.readyState=3;}]]){
  const h=harness();change(h);assert.equal(interrupt(h,extra).ok,false,name);assert.deepEqual(h.inputs,[],name);
 }
});
