const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../../zellij-client/assets/connection.js','utf8').replace(/^export /gm,'');
function harness(worker,saved=false){
  const events=[],dialogs=[],window={__zjTerminalFailure:worker,__zjTerminalFailureSaved:saved,__zjPendingTerminalRecords:2,dispatchEvent:e=>events.push(e)};
  const context={window,crypto:{randomUUID:()=> '01234567-89ab-cdef-0123-456789abcdef'},performance:{now:()=>42},
    CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},clearTimeout(){},showErrorModal:async(...args)=>dialogs.push(args)};
  vm.createContext(context);vm.runInContext(source+'\nglobalThis.disconnect=handleDisconnected;',context);
  return {disconnect:context.disconnect,events,dialogs};
}
test('Every fatal browser dialog reports once, with a reference and no arbitrary error text',async()=>{
  const h=harness();await h.disconnect('Terminal attachment could not resume. private error text');await h.disconnect('again');
  assert.equal(h.events.length,1);assert.equal(h.events[0].type,'zellij-terminal-failed');
  assert.equal(h.events[0].detail.code,'resume_timeout');assert.equal(h.events[0].detail.pending_records,2);
  assert.doesNotMatch(JSON.stringify(h.events),/private error text/);
  assert.match(h.dialogs[0][1],/Reference: 0123456789ab/);
});
test('Worker failures keep the original correlation reference and protocol evidence',async()=>{
  const worker={reference:'abcdef012345',code:'focus_unconfirmed',query_received:true,focus_confirmed:false};
  const h=harness(worker);await h.disconnect('Engine did not confirm\nReference: abcdef012345');
  assert.equal(h.events[0].detail,worker);assert.equal((h.dialogs[0][1].match(/Reference:/g)||[]).length,1);
});
test('An older worker without structured reports still records the focus failure code',async()=>{
  const h=harness();await h.disconnect('Engine did not confirm terminal pane selection; queued typing was not sent');
  assert.equal(h.events[0].detail.code,'focus_unconfirmed');assert.match(h.dialogs[0][1],/Reference: 0123456789ab/);
});
test('A durable source report is not posted again on a remote viewing computer',async()=>{
  const h=harness({reference:'abcdef012345',code:'focus_unconfirmed'},true);
  await h.disconnect('Engine did not confirm\nReference: abcdef012345');
  assert.equal(h.events.length,0);assert.match(h.dialogs[0][1],/abcdef012345/);
});
