// Stock web client reconnection: an upgrade restarts the web server and relay
// for about a second, so terminals must retry quickly before backing off.
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const assets=__dirname+'/../../zellij-client/assets/';
const read=name=>fs.readFileSync(assets+name,'utf8');

function connection(serverUpAt,storage=new Map()){
  const context={now:0,delays:[],reloadedAt:null,checks:0};
  const sandbox={
    getBaseUrl:()=>'/hosts/mac',
    AbortSignal,Date,JSON,
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},
    fetch:async()=>{context.checks++;if(context.now<serverUpAt)throw TypeError('Failed to fetch');return{ok:true};},
    window:{location:{reload:()=>{context.reloadedAt=context.now;}},addEventListener(){}},
    // The modal waits delaySeconds, then asks to reconnect.
    showReconnectionModal:async(_,delay)=>{context.delays.push(delay);context.now+=delay;return{action:'reconnect',cleanup(){}};},
  };
  const source=read('connection.js').replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')
    +'\nObject.assign(globalThis,{getReconnectionDelay,handleReconnection,markConnectionEstablished});';
  vm.runInNewContext(source,sandbox);
  return Object.assign(context,sandbox);
}

test('reconnection retries every 250 ms for 10 seconds, then backs off',()=>{
  const {getReconnectionDelay}=connection(0);
  for(let attempt=1;attempt<=40;attempt++)assert.equal(getReconnectionDelay(attempt),0.25);
  assert.deepEqual([41,42,43,44,45,46,100].map(getReconnectionDelay),[1,2,4,8,16,16,16]);
});

test('a terminal reloads within 250 ms of a short restart ending',async()=>{
  for(const outage of [0.4,1,3.2,9.9]){
    const c=connection(outage);
    c.markConnectionEstablished();
    await c.handleReconnection();
    assert.ok(c.reloadedAt>=outage&&c.reloadedAt<outage+0.25+1e-9,`${outage}s outage reloaded at ${c.reloadedAt}s`);
  }
});

test('a long outage stops polling quickly',async()=>{
  const c=connection(40);
  c.markConnectionEstablished();
  await c.handleReconnection();
  // 40 quick checks over 10 s, then 1+2+4+8+16 s.
  assert.equal(c.reloadedAt,41);
  assert.equal(c.checks,45);
});

test('a page that keeps losing its connection right after reloading backs off across reloads',async()=>{
  // Sharing Off: the server stays up but closes each new attachment.
  const storage=new Map(),reloads=[];
  for(let n=0;n<4;n++){
    const c=connection(0,storage);
    c.markConnectionEstablished();
    await c.handleReconnection();
    reloads.push(c.reloadedAt);
  }
  assert.deepEqual(reloads,[0.25,1,2,4]);
  // A drop long after the last reload (the next upgrade) retries quickly again.
  storage.set('zellij-reconnect-reload',JSON.stringify({at:Date.now()-60000,attempt:43}));
  const later=connection(0,storage);later.markConnectionEstablished();await later.handleReconnection();
  assert.equal(later.reloadedAt,0.25);
});

function modal(){
  const timeouts=[],intervals=[];
  const element=()=>({children:[],style:{},appendChild(child){this.children.push(child);return child;},focus(){},addEventListener(){},removeEventListener(){},
    querySelector(selector){for(const child of this.children){if('#'+child.id===selector)return child;const found=child.querySelector?.(selector);if(found)return found;}return null;}});
  const body={nodes:[],appendChild(node){this.nodes.push(node);},contains(node){return this.nodes.includes(node);},removeChild(node){this.nodes=this.nodes.filter(n=>n!==node);}};
  const sandbox={window:{},
    document:{createElement:element,createTextNode:text=>({text}),querySelector:selector=>selector==='#modal-styles'?{}:null,body},
    setTimeout:(fn,ms)=>{timeouts.push({fn,ms});return timeouts.length;},clearTimeout(){},
    setInterval:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;},clearInterval(){}};
  vm.runInNewContext(read('modals.js')+'\nglobalThis.showReconnectionModal=showReconnectionModal;',sandbox);
  return{show:sandbox.showReconnectionModal,timeouts,body};
}

test('the reconnection modal waits exactly its delay',async()=>{
  for(const [attempt,delay] of [[1,0.25],[41,1],[42,2]]){
    const m=modal();
    const result=m.show(attempt,delay);
    assert.deepEqual(m.timeouts.map(t=>t.ms),[delay*1000]);
    m.timeouts[0].fn();
    assert.equal((await result).action,'reconnect');
  }
});

test('quick retries say Reconnecting without a countdown',()=>{
  const m=modal();
  m.show(7,0.25);
  const content=m.body.nodes[0].children[0];
  assert.equal(content.querySelector('#modal-title').textContent,'Connection Lost');
  assert.equal(content.querySelector('#modal-message').textContent,'Reconnecting...');
  assert.equal(content.querySelector('#countdown'),null);
});
