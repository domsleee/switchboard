const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(__dirname+'/../../zellij-client/assets/app.js','utf8');
const slice=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const handlerSources={
  bundle:slice('function installCustomKeyHandler(','function installMouseHandlers('),
  module:fs.readFileSync(__dirname+'/../../zellij-client/assets/key-handler.js','utf8').replace(/^import .*;\r?\n/gm,'').replace('export function','function'),
};
function installHandler(term,send,variant='bundle',platform='MacIntel'){
  const context={isMac:()=>platform.startsWith('Mac'),navigator:{platform}};vm.createContext(context);
  const encoder=variant==='bundle'?slice('function encode_kitty_key(','/**'):fs.readFileSync(__dirname+'/../../zellij-client/assets/keyboard.js','utf8').replace('export function','function');
  vm.runInContext(encoder+handlerSources[variant],context);
  context.installCustomKeyHandler(term,send);
}
function press(key,mods={}){
  const sent=[];let handler;installHandler({attachCustomKeyEventHandler:h=>handler=h},data=>sent.push(data));
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
test('Shift is taken from each Enter event, with no held modifier after uppercase typing or Shift+Enter',()=>{
  const context={isMac:()=>true};vm.createContext(context);
  vm.runInContext(slice('function encode_kitty_key(','/**')+slice('function installCustomKeyHandler(','function installMouseHandlers('),context);
  let handler;const sent=[];context.installCustomKeyHandler({attachCustomKeyEventHandler:h=>handler=h},data=>sent.push(data));
  const event=(key,type='keydown',shiftKey=false)=>({key,type,shiftKey,ctrlKey:false,altKey:false,metaKey:false,preventDefault(){}});
  handler(event('Shift','keydown',true));handler(event('A','keydown',true));handler(event('Shift','keyup'));
  assert.equal(handler(event('Enter')),true);assert.deepEqual(sent,[]);
  assert.equal(handler(event('Enter','keydown',true)),false);
  assert.equal(handler(event('Enter')),true);assert.deepEqual(sent,['\x1b[13;2u']);
});
test('multi-modifier navigation and function keys retain their named keys',()=>{
  const expected={ArrowUp:'1;6A',ArrowDown:'1;6B',ArrowRight:'1;6C',ArrowLeft:'1;6D',Home:'1;6H',End:'1;6F',
    Insert:'2;6~',Delete:'3;6~',PageUp:'5;6~',PageDown:'6;6~',F1:'1;6P',F2:'1;6Q',F3:'1;6R',F4:'1;6S',
    F5:'15;6~',F6:'17;6~',F7:'18;6~',F8:'19;6~',F9:'20;6~',F10:'21;6~',F11:'23;6~',F12:'24;6~'};
  for(const [key,sequence] of Object.entries(expected))assert.deepEqual(press(key,{ctrlKey:true,shiftKey:true}),{xtermHandles:false,sent:['\x1b['+sequence]},key);
  assert.deepEqual(press('ArrowLeft',{altKey:true,shiftKey:true}).sent,['\x1b[1;4D']);
  assert.deepEqual(press('ArrowLeft',{shiftKey:true}),{xtermHandles:true,sent:[]});
});
test('Ctrl/Alt Backspace send word-delete instead of native Move mode without the sidebar bridge',()=>{
  for(const mods of [{ctrlKey:true},{altKey:true}])assert.deepEqual(press('Backspace',mods),{xtermHandles:false,sent:['\x17']});
  for(const key of ['Backspace','Delete'])assert.deepEqual(press(key),{xtermHandles:true,sent:[]});
  for(const mods of [{ctrlKey:true,isComposing:true},{altKey:true,getModifierState:key=>key==='AltGraph'},{ctrlKey:true,type:'keyup'},{altKey:true,type:'keyup'}])assert.deepEqual(press('Backspace',mods),{xtermHandles:true,sent:[]});
  assert.deepEqual(press('Backspace',{ctrlKey:true,shiftKey:true}).sent,['\x1b[127;6u']);
  assert.deepEqual(press('Backspace',{ctrlKey:true,altKey:true}).sent,['\x1b[127;7u']);
});
test('real bundled xterm sends one word-delete then ordinary Backspace/Delete across key releases',()=>{
  global.self=global;
  const {Terminal}=require(__dirname+'/../../zellij-client/assets/xterm.js');
  for(const variant of Object.keys(handlerSources)){
    const term=new Terminal(),sent=[],core=term._core;
    // Only DOM/render services are stubbed; xterm's production keydown/keyup
    // and keyboard encoder run without opening or attaching a browser terminal.
    core.browser={...core.browser,isWindows:true};core._compositionHelper={keydown:()=>true};core.textarea={value:''};
    core.updateCursorStyle=()=>{};core._showCursor=()=>{};core.focus=()=>{};
    term.onData(data=>sent.push(data));installHandler(term,data=>sent.push(data),variant,'Win32');
    const event=(key,keyCode,mods={})=>({type:'keydown',key,keyCode,ctrlKey:false,altKey:false,metaKey:false,shiftKey:false,getModifierState:()=>false,preventDefault(){this.prevented=true;},stopPropagation(){},...mods});
    const pressAndRelease=(key,keyCode,mods={})=>{const down=event(key,keyCode,mods);core._keyDown(down);core._keyUp({...down,type:'keyup'});return down;};
    try{
      for(let digit=1;digit<=9;digit++){
        assert.equal(pressAndRelease(String(digit),48+digit,{ctrlKey:true,code:'Digit'+digit}).prevented,undefined,'Windows Ctrl+digit stays with Chrome');
      }
      assert.deepEqual(sent,[],'Windows browser tab shortcuts never reach the shell');
      assert.equal(pressAndRelease('Backspace',8,{ctrlKey:true}).prevented,true);
      pressAndRelease('Control',17);
      pressAndRelease('Backspace',8);pressAndRelease('Delete',46);
      pressAndRelease('Backspace',8,{altKey:true});pressAndRelease('Alt',18);
      pressAndRelease('Backspace',8);pressAndRelease('Delete',46);
      assert.deepEqual(sent,['\x17','\x7f','\x1b[3~','\x17','\x7f','\x1b[3~'],variant);
      assert.equal(sent.includes('\x08'),false,variant);
      sent.length=0;
      pressAndRelease('ArrowLeft',37,{shiftKey:true});pressAndRelease('c',67,{ctrlKey:true});
      pressAndRelease('ArrowLeft',37,{ctrlKey:true,shiftKey:true});pressAndRelease('ArrowRight',39,{ctrlKey:true,shiftKey:true});
      pressAndRelease('Home',36,{ctrlKey:true,shiftKey:true});pressAndRelease('End',35,{ctrlKey:true,shiftKey:true});
      pressAndRelease('Delete',46,{ctrlKey:true,shiftKey:true});
      assert.deepEqual(sent,['\x1b[1;2D','\x03','\x1b[1;6D','\x1b[1;6C','\x1b[1;6H','\x1b[1;6F','\x1b[3;6~'],variant);
    }finally{term.dispose();}
  }
});

for(const variant of Object.keys(handlerSources))for(const bridge of [false,true])test(`${variant}, bridge ${bridge}: touchscreen input preserves interruption, deletion and clipboard text`,
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true});
  try{
    // navigator.platform selects the Windows handlers, but Chrome's native
    // clipboard accelerator still follows the operating system running the test.
    const pasteShortcut=process.platform==='darwin'?'Meta+V':'Control+V';
    const context=await browser.newContext({viewport:{width:1280,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(()=>{
      Object.defineProperty(Navigator.prototype,'platform',{get:()=> 'Win32'});
      Object.defineProperty(Navigator.prototype,'maxTouchPoints',{get:()=>1});
    });
    const bundle=variant==='bundle'?`<script>
      function isMac(){return false;}
      ${slice('function encode_kitty_key(','/**')}
      ${slice('function installImeBypass(','function isCoarsePointerDevice(')}
      ${slice('function isCoarsePointerDevice(','function installCustomKeyHandler(')}
      ${handlerSources.bundle}
    </script>`:'';
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(path==='/hosts/windows/main')return route.fulfill({contentType:'text/html',body:`<!doctype html>
        <link rel="stylesheet" href="/assets/xterm.css"><div id="terminal"></div><script src="/assets/xterm.js"></script>
        <script>window.sent=[];window.WebSocket=class extends EventTarget{constructor(){super();this.readyState=1;}send(data){sent.push(String(data));}};</script>
        ${bridge?'<script src="/clipboard.js"></script><script src="/bridge.js"></script>':''}${bundle}<script type="module">
          ${variant==='module'?`import {installCustomKeyHandler} from '/assets/key-handler.js';
          import {installImeBypass} from '/assets/ime-bypass.js';
          import {installSoftKeyboardCapture,suppressSoftKeyboardOnTouch} from '/assets/soft-keyboard.js';`:''}
          const socket=new WebSocket('wss://fixture/ws/terminal');window.term=new Terminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});
          term.open(document.querySelector('#terminal'));installImeBypass(term,data=>socket.send(data));
          installSoftKeyboardCapture(term,data=>socket.send(data));suppressSoftKeyboardOnTouch(term);
          installCustomKeyHandler(term,data=>socket.send(data));term.onData(data=>socket.send(data));term.focus();window.ready=true;
        </script>`});
      if(path==='/bridge.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(__dirname+'/static/bridge.js','utf8')});
      if(path==='/clipboard.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(__dirname+'/static/clipboard.js','utf8')});
      const name=path.split('/').at(-1);
      if(!path.startsWith('/assets/')||!['xterm.js','xterm.css','key-handler.js','keyboard.js','utils.js','ime-bypass.js','soft-keyboard.js'].includes(name))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(__dirname+'/../../zellij-client/assets/'+name,'utf8')});
    });
    await page.goto('https://switchboard.test/hosts/windows/main');await page.waitForFunction(()=>window.ready);
    await page.locator('#terminal').click({position:{x:20,y:20}});
    assert.equal(await page.evaluate(()=>document.activeElement===window.__zjSoftKbdCapture.element),false,'closed shadow root hides the focused input');
    assert.equal(await page.evaluate(()=>window.__zjSoftKbdCapture.isFocused),true);
    await page.keyboard.press('Control+c');
    assert.deepEqual(await page.evaluate(()=>[...sent]),['\x03'],'physical Ctrl+C interrupts through the touchscreen input exactly once');
    assert.deepEqual(await page.evaluate(()=>{const input=window.__zjSoftKbdCapture.element;return [input.value,input.selectionStart];}),['\u00a0'.repeat(8),4],'interrupt leaves the hidden input ready for normal typing');
    await page.evaluate(()=>{sent.length=0;});
    if(bridge){
      await page.evaluate(()=>new Promise(resolve=>term.write('copy this',resolve)));
      await page.evaluate(()=>term.select(0,0,9));
      for(const shortcut of ['Control+c','Control+Shift+c']){
        await page.keyboard.press(shortcut);
        assert.deepEqual(await page.evaluate(()=>[...sent]),[],'copying a terminal selection must not interrupt the remote process');
        assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'copy this');
      }
      await page.evaluate(()=>term.clearSelection());
    }
    for(const modifier of ['Control','Alt']){
      await page.keyboard.type('hello world',{delay:20});
      assert.equal(await page.evaluate(()=>sent.join('')),'hello world');
      await page.evaluate(()=>{sent.length=0;});
      await page.keyboard.press(modifier+'+Backspace');
      assert.equal(await page.evaluate(()=>sent.join('')),'\x17','word-delete must reach the terminal instead of deleting the hidden field');
      await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');await page.keyboard.press('Delete');
      assert.equal(await page.evaluate(()=>sent.join('')),'\x17\x7f\x7f\x1b[3~','Backspace and forward Delete still work after word-delete');
      await page.evaluate(()=>{sent.length=0;});
    }
    await page.evaluate(()=>{term.options.disableStdin=true;});
    for(const key of ['Control+c','Control+Backspace','Backspace','Delete'])await page.keyboard.press(key);
    assert.equal(await page.evaluate(()=>sent.join('')),'','input suspension also applies to touchscreen hardware shortcuts');
    await page.evaluate(()=>{
      term.options.disableStdin=false;
      const capture=window.__zjSoftKbdCapture.element;
      capture.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}));
      capture.value=capture.value.slice(1);
      capture.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
    });
    assert.equal(await page.evaluate(()=>sent.join('')),'\x7f','virtual keyboards without physical key codes keep their input-event path');
    for(const bracketed of [false,true]){
      await page.evaluate(enabled=>{term._core.coreService.decPrivateModes.bracketedPasteMode=enabled;},bracketed);
      for(const text of ['WI01128808','0011222333','hello\r\nworld\nnext','a\u00a0b','Ω😀']){
        await page.evaluate(async text=>{sent.length=0;await navigator.clipboard.writeText(text);},text);
        await page.keyboard.press(pasteShortcut);
        const normalized=text.replace(/\r?\n/g,'\r');
        assert.deepEqual(await page.evaluate(()=>[...sent]),[bracketed?'\x1b[200~'+normalized+'\x1b[201~':normalized],'paste uses one xterm input without dropping repeated characters or formatting');
        assert.deepEqual(await page.evaluate(()=>{const input=window.__zjSoftKbdCapture.element;return [input.value,input.selectionStart];}),['\u00a0'.repeat(8),4],'paste leaves the capture ready for further typing and deletion');
      }
    }
    await page.evaluate(()=>{sent.length=0;});
    await page.keyboard.insertText('0011222333');
    assert.equal(await page.evaluate(()=>sent.join('')),'0011222333','an insertion event preserves repeated characters without the virtual Backspace debounce');
    await page.evaluate(()=>{sent.length=0;});
    await page.keyboard.type('0011222333');
    assert.equal(await page.evaluate(()=>sent.join('')),'0011222333','rapid physical typing also preserves repeated characters across input events');
    await page.evaluate(async()=>{sent.length=0;term.options.disableStdin=true;await navigator.clipboard.writeText('disabled paste');});
    await page.keyboard.press(pasteShortcut);
    assert.deepEqual(await page.evaluate(()=>[...sent]),[],'input suspension also blocks a paste into the touchscreen input');
    await page.keyboard.insertText('disabled text');
    assert.deepEqual(await page.evaluate(()=>[...sent]),[],'input suspension also blocks ordinary touchscreen text');
    await page.evaluate(()=>{
      term.options.disableStdin=false;
      const capture=window.__zjSoftKbdCapture.element;
      for(let i=0;i<2;i++){
        capture.value=capture.value.slice(1);
        capture.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
      }
    });
    assert.deepEqual(await page.evaluate(()=>[...sent]),['\x7f'],'duplicate virtual Backspace events still produce one deletion');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
