const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const sandbox={};vm.runInNewContext(fs.readFileSync(__dirname+'/static/model-picker.js','utf8'),sandbox);
const {parse,normalize,describe,efforts}=sandbox.SwitchboardModelPicker;

test('a choice names its agent, model and optional effort, and refuses anything else',()=>{
  assert.deepEqual({...parse('claude:claude-opus-5-5#xhigh')},{provider:'claude',model:'claude-opus-5-5',effort:'xhigh'});
  assert.deepEqual({...parse('codex:gpt-6.1-sol')},{provider:'codex',model:'gpt-6.1-sol',effort:''});
  assert.deepEqual({...parse('claude:my-model[1m]')},{provider:'claude',model:'my-model[1m]',effort:''});
  for(const value of ['','gemini:pro','claude:','claude:-x','codex:a b','codex:gpt#HIGH','codex:gpt#high#low'])assert.equal(parse(value),null,value);
});

test("the owner's old shortcuts become the model and effort they run",()=>{
  assert.equal(normalize('csol'),'codex:gpt-6.1-sol#high');
  assert.equal(normalize('castra'),'codex:gpt-6-astra#medium');
  assert.equal(normalize('c'),'claude:claude-opus-5-5');
  assert.equal(normalize('nonsense'),'codex:gpt-6.1-sol#high','An unreadable choice falls back to the default');
});

test('names read as people say them, and each agent offers its own effort levels',()=>{
  const codex=[{id:'gpt-6.1-sol',name:'GPT-6.1-Sol',efforts:[{id:'low',description:'Fast'},{id:'ultra',description:'Delegates'}]}];
  const sol=describe('codex:gpt-6.1-sol#ultra',codex);
  assert.equal(sol.name,'GPT-6.1 Sol');assert.equal(sol.effortName,'Ultra');assert.equal(sol.providerName,'Codex');
  assert.equal(describe('claude:claude-opus-5-5#xhigh').name,'Opus 5.5');
  assert.equal(describe('claude:claude-opus-5-5#xhigh').effortName,'Extra high');
  assert.equal(describe('codex:gpt-6-luna').name,'GPT-6 Luna','An unlisted Codex model still reads as a name');
  assert.equal(efforts(parse('codex:gpt-6.1-sol'),codex).map(([id])=>id).join(),['low','ultra'].join());
  assert.equal(efforts(parse('codex:gpt-6-luna'),codex).map(([id])=>id).join(),['low','medium','high','xhigh'].join(),'An older relay without levels gets the common ones');
  assert.equal(efforts(parse('claude:claude-opus-5-5'),codex).map(([id])=>id).join(),['low','medium','high','xhigh','max'].join());
});
