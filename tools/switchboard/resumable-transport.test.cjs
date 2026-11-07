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
test('output may skip dropped terminal records only at a resync record',async()=>{
 const f=fixture();const apply=async record=>{f.sockets[0].message({type:'output',record});await new Promise(r=>setImmediate(r));f.renders.at(-1)?.applied?.();await f.client.outputWork;};
 await apply({seq:1,channel:'terminal',data:'a'});assert.equal(f.client.applied,1);
 await apply({seq:9,channel:'terminal',data:'\x1b[0m',resync:true});
 assert.equal(f.client.stopped,false);assert.equal(f.client.applied,9);
 await apply({seq:10,channel:'terminal',data:'repaint'});assert.equal(f.client.applied,10);
 await apply({seq:20,channel:'terminal',data:'gap'});assert.equal(f.client.stopped,true);
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

test('Conversation retirement drains input across reconnect and waits for confirmed retirement',async()=>{
 const f=fixture();f.client.terminal.send('queued');f.sockets[0].drop();
 const retired=f.client.retire();let completed=false;retired.then(()=>completed=true);
 f.timers.shift()();const next=f.sockets[1];next.message({type:'hello',generation:2,input_ack:0});
 assert.equal(next.sent[0].input.data,'queued');assert.equal(next.sent.some(m=>m.type==='retire'),false);
 next.message({type:'ack',input_ack:1});f.client.checkRetirement();
 assert.equal(next.sent.at(-1).type,'retire');assert.equal(completed,false);
 // Losing the receipt must reconnect to the same owner, not create a replacement.
 next.drop();f.timers.shift()();f.sockets[2].message({type:'retired'});
 assert.equal(await retired,true);assert.equal(f.client.stopped,true);assert.equal(f.client.pending.length,0);
});
test('returning to Terminal cancels retirement while preserving buffered input',async()=>{
 const f=fixture();f.sockets[0].drop();f.client.terminal.send('kept');let wanted=true;
 const retired=f.client.retire(()=>wanted);wanted=false;f.client.checkRetirement();
 assert.equal(await retired,false);assert.equal(f.client.stopped,false);assert.equal(f.client.pending[0].data,'kept');
});
test('unconfirmed retirement keeps the owner and its pending input for recovery',async()=>{
 const f=fixture();f.sockets[0].drop();f.client.terminal.send('kept');
 const retired=f.client.retire();const rejected=assert.rejects(retired,/pending input is kept/);
 f.advance(120001);f.client.checkRetirement();await rejected;
 assert.equal(f.client.stopped,false);assert.equal(f.client.pending[0].data,'kept');
});

test('a parser retirement refusal leaves the live stream available to finish input',async()=>{
 const f=fixture();const retired=f.client.retire();const rejected=assert.rejects(retired,/incomplete/);
 f.sockets[0].message({type:'retirement_rejected',message:'incomplete input'});await rejected;
 f.client.terminal.send('finish');assert.equal(f.client.stopped,false);assert.equal(f.sockets[0].sent.at(-1).input.data,'finish');
});

 test('returning after retirement was sent waits for confirmation instead of exposing an unusable owner',async()=>{
 const f=fixture();let wanted=true;const retired=f.client.retire(()=>wanted);wanted=false;f.client.checkRetirement();
 assert.equal(f.client.retiring,true);assert.equal(f.client.pending.length,0);
 f.sockets[0].message({type:'retired'});assert.equal(await retired,true);
});
test('a retirement timeout preserves the owner and recovers a lost parser refusal on explicit retry',async()=>{
 const f=fixture();const retired=f.client.retire();
 const rejected=assert.rejects(retired,e=>e.unresolvedRetirement===true);
 f.advance(120001);f.client.checkRetirement();await rejected;
 assert.equal(f.client.stopped,false);assert.equal(f.client.retirementPaused,true);
 const retry=f.client.retire(()=>false);const refusal=assert.rejects(retry,/incomplete/);
 f.sockets[1].message({type:'hello',generation:2,input_ack:0});
 assert.equal(f.sockets[1].sent.at(-1).type,'retire');
 f.sockets[1].message({type:'retirement_rejected',message:'incomplete sequence'});await refusal;
 f.client.terminal.send('finish');assert.equal(f.sockets[1].sent.at(-1).input.data,'finish');
});
test('retry after a retirement timeout accepts the retained receipt without creating a viewer',async()=>{
 const f=fixture();const retired=f.client.retire();const rejected=assert.rejects(retired,/unconfirmed/);
 f.advance(120001);f.client.checkRetirement();await rejected;
 const retry=f.client.retire(()=>false);f.sockets[1].message({type:'retired'});
 assert.equal(await retry,true);assert.equal(f.client.stopped,true);
});
