const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../../zellij-client/assets/app.js','utf8');
const slice=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
function press(key,mods={}){
  const sent=[],context={isMac:()=>true};vm.createContext(context);
  vm.runInContext(slice('function encode_kitty_key(','/**')+slice('function installCustomKeyHandler(','function installMouseHandlers('),context);
  let handler;context.installCustomKeyHandler({attachCustomKeyEventHandler:h=>handler=h},data=>sent.push(data));
  const ev={type:'keydown',key,ctrlKey:false,shiftKey:false,altKey:false,metaKey:false,preventDefault(){},...mods};
  return {xtermHandles:handler(ev)!==false,sent};
}
test('Ctrl+Enter keeps its modifier as a kitty key instead of xterm.js bare CR',()=>{
  assert.deepEqual(press('Enter',{ctrlKey:true}),{xtermHandles:false,sent:['\x1b[13;5u']});
});
test('multi-modifier and Cmd Enter encode Enter as 13, not the letter E',()=>{
  assert.deepEqual(press('Enter',{metaKey:true}).sent,['\x1b[13;9u']);
  assert.deepEqual(press('Enter',{ctrlKey:true,shiftKey:true}).sent,['\x1b[13;6u']);
});
test('Shift+Enter keeps its modifier so agent TUIs insert a newline instead of submitting',()=>{
  assert.deepEqual(press('Enter',{shiftKey:true}),{xtermHandles:false,sent:['\x1b[13;2u']});
});
test('plain and Alt Enter stay with xterm.js',()=>{
  for(const mods of [{},{altKey:true}])assert.deepEqual(press('Enter',mods),{xtermHandles:true,sent:[]});
});
