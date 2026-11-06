const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../../zellij-client/assets/resumable.js','utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
function fixture(){
 const sockets=[],timers=[],intervals=[];let uuid=0,now=0;
 class Socket{constructor(url){this.url=url;this.sent=[];sockets.push(this)}send(data){this.sent.push(JSON.parse(data))}close(){}message(data){this.onmessage({data:JSON.stringify(data)})}drop(){this.onclose()}}
 class CustomEvent extends Event{constructor(type,opts){super(type);this.detail=opts.detail}}
 const window=new EventTarget();
 const ctx={window,EventTarget,Event,MessageEvent,CustomEvent,TextEncoder,URLSearchParams,crypto:{randomUUID:()=>String(++uuid)},Date:{now:()=>now},Promise,
  WebSocket:Socket,queueMicrotask,setTimeout:fn=>{timers.push(fn);return fn},clearTimeout:()=>{},setInterval:fn=>{intervals.push(fn);return fn},clearInterval:()=>{},markConnectionEstablished(){},showConnectionStatus(){}};
 vm.createContext(ctx);vm.runInContext(source+'\nglobalThis.Connection=ResumableConnection;',ctx);
 const client=new ctx.Connection('ws://fixture',{web_client_id:'viewer',resumable:{session:'main'}});
 const renders=[],controls=[];client.terminal.onmessage=e=>{renders.push(e);};client.control.onmessage=e=>controls.push(JSON.parse(e.data));
 client.connect();sockets[0].message({type:'hello',generation:1,input_ack:0});
 return {client,sockets,timers,renders,controls,window,intervals,advance:ms=>now+=ms};
}
test('input and focus controls remain ordered across lost acknowledgments and rollback',()=>{
 const f=fixture();const {client,sockets}=f;
 client.terminal.send('first');client.control.send(JSON.stringify({web_client_id:'viewer',payload:{type:'FocusPane',pane_id:2,is_plugin:false}}));client.terminal.send('second');
 assert.equal(sockets[0].sent.length,1);
 sockets[0].drop();client.terminal.send('typed while offline');
 f.timers.shift()();const next=sockets[1];next.message({type:'hello',generation:2,input_ack:1});
 assert.equal(next.sent[0].input.seq,2);assert.equal(next.sent[0].input.channel,'control');
 next.message({type:'ack',input_ack:2});assert.equal(next.sent[1].input.data,'second');
 next.drop();f.timers.shift()();const rollback=sockets[2];rollback.message({type:'hello',generation:3,input_ack:2});
 assert.equal(rollback.sent[0].input.seq,3);rollback.message({type:'ack',input_ack:3});
 assert.equal(rollback.sent[1].input.data,'typed while offline');rollback.message({type:'ack',input_ack:4});
 assert.equal(client.pending.length,0);assert.equal(client.stopped,false);
});
test('lost resume reply retries the same nonce and expected generation',()=>{
 const f=fixture();f.sockets[0].drop();f.timers.shift()();const first=new URL(f.sockets[1].url);
 f.sockets[1].drop();f.timers.shift()();const retry=new URL(f.sockets[2].url);
 assert.equal(first.searchParams.get('nonce'),retry.searchParams.get('nonce'));
 assert.equal(first.searchParams.get('generation'),retry.searchParams.get('generation'));
 f.sockets[2].message({type:'hello',generation:2,input_ack:0});assert.equal(f.client.stopped,false);
});
test('output is acknowledged only after xterm applies it, including duplicate replay',async()=>{
 const f=fixture();const out={type:'output',record:{seq:1,channel:'terminal',data:'render'}};
 f.sockets[0].message(out);await Promise.resolve();assert.equal(f.renders.length,1);assert.equal(f.client.applied,0);
 f.sockets[0].drop();f.timers.shift()();f.sockets[1].message({type:'hello',generation:2,input_ack:0});f.sockets[1].message(out);
 f.renders[0].applied();await f.client.outputWork;
 assert.equal(f.renders.length,1);assert.equal(f.client.applied,1);
 assert.ok(f.sockets[1].sent.some(x=>x.type==='ack'&&x.applied===1));
});
test('unicode paste splitting preserves every byte and has bounded records',()=>{
 const f=fixture();const data='\x1b[200~'+'😀'.repeat(20000)+'\x1b[201~';f.client.terminal.send(data);
 assert.equal(f.client.pending.map(x=>x.data).join(''),data);
 assert.ok(f.client.pending.every(x=>new TextEncoder().encode(x.data).length<=48*1024));
});
test('unknown viewers and overflow fail explicitly without creating another session',()=>{
 const f=fixture();f.client.terminal.send('not acknowledged');f.sockets[0].message({type:'error',message:'Unknown viewer'});
 assert.equal(f.client.stopped,true);assert.equal(f.window.__zjPendingTerminalInput[0].data,'not acknowledged');assert.equal(f.sockets.length,1);
 const g=fixture();g.client.terminal.send('x'.repeat(1024*1024+1));assert.equal(g.client.stopped,true);
});

test('blackholed transport reconnects without waiting for a close event and stops within the recovery deadline',()=>{
 const f=fixture();f.client.terminal.send('retained');f.advance(11000);f.intervals.at(-1)();
 assert.equal(f.client.connected,false);assert.equal(f.timers.length,1);
 f.timers.shift()();f.advance(121000);f.intervals.at(-1)();
 assert.equal(f.client.stopped,true);assert.equal(f.window.__zjPendingTerminalInput[0].data,'retained');
});
