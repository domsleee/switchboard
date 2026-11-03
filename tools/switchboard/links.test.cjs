const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers={},messages=[],opened=[];let tabFocused=0;
const parent={postMessage:(message,origin)=>messages.push({message,origin})};
const location={pathname:'/hosts/windows/main',origin:'http://127.0.0.1:8090',href:'http://127.0.0.1:8090/hosts/windows/main'};
const window={open:(uri,target)=>{assert.equal(uri,'about:blank');assert.equal(target,'_blank');const tab={opener:{},document:{createElement:()=>({click(){assert.equal(tab.opener,null);assert.equal(this.rel,'noreferrer');opened.push([this.href,'_blank','noopener noreferrer']);}})},focus(){tabFocused++;}};return tab;},__switchboardLinkHosts:{windows:{origin:'https://172.20.10.69:8082',local:false,artifacts:{'9000':'http://127.0.0.1:9090'}}},addEventListener:(type,fn)=>handlers[type]=fn};
const document={createElement:tag=>{assert.equal(tag,'a');return {click(){opened.push([this.href,this.target,this.rel]);}};}};
window.term={cols:80,element:{},_core:{_mouseService:{},linkifier:{_positionFromMouseEvent:()=>({x:3,y:1}),_currentLink:{link:{text:'http://127.0.0.1:8765/',range:{start:{x:1,y:1},end:{x:8,y:1}}}}}}};
vm.runInNewContext(fs.readFileSync(__dirname+'/static/links.js','utf8'),{window,parent,location,document,URL,console,setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{}});
assert.equal(window.__switchboardResolveLink('http://127.0.0.1:8765/a?q=1'),'http://172.20.10.69:8765/a?q=1');
assert.equal(window.__switchboardResolveLink('http://localhost:9000/a'),'http://127.0.0.1:9090/a');
assert.throws(()=>window.__switchboardResolveLink('javascript:alert(1)'));
const click={shiftKey:true,button:0,clientX:1,clientY:1,target:{closest:()=>true},preventDefault(){},stopImmediatePropagation(){}};
handlers.mousedown({...click,shiftKey:false});handlers.mouseup({...click,shiftKey:false});assert.equal(messages.length,0);
handlers.mousedown(click);handlers.mouseup({...click,clientX:20});assert.equal(messages.length,0);
assert.equal(opened.length,0);
handlers.mousedown({...click,button:2});handlers.mouseup({...click,button:2});assert.equal(opened.length,0);
handlers.mousedown(click);handlers.mouseup({...click,shiftKey:false});assert.equal(opened.length,0);
handlers.mousedown(click);handlers.blur();handlers.mouseup(click);assert.equal(opened.length,0);
handlers.mousedown(click);handlers.mouseup(click);assert.equal(messages.length,0);
assert.deepEqual(opened,[['http://172.20.10.69:8765/','_blank','noopener noreferrer']]);
// A Windows terminal viewed on macOS must honor the viewer's Command key.
for(const modifier of ['metaKey','ctrlKey']){
  const event={...click,shiftKey:false,[modifier]:true};
  const before=opened.length;
  handlers.mousedown({...event,altKey:true});handlers.mouseup({...event,altKey:true});assert.equal(opened.length,before);
  handlers.mousedown(event);handlers.mouseup({...event,[modifier]:false});assert.equal(opened.length,before);
  handlers.mousedown(event);handlers.mouseup(event);
  assert.deepEqual(opened.at(-1),['http://172.20.10.69:8765/','_blank','noopener noreferrer']);
  assert.equal(opened.length,before+1,'Each modified click opens exactly one local browser tab');
}
opened.splice(1);
assert.equal(tabFocused,2,'Cmd/Ctrl-click requests foreground focus');
// A link the Switchboard page sends to another browser opens no tab here.
parent.SwitchboardOpenInApp=(host,url)=>{routed.push([host,url]);return true;};const routed=[];
handlers.mousedown({...click,shiftKey:false,metaKey:true});handlers.mouseup({...click,shiftKey:false,metaKey:true});
assert.deepEqual(routed,[['windows','http://172.20.10.69:8765/']]);assert.equal(opened.length,1);assert.equal(tabFocused,2);
delete parent.SwitchboardOpenInApp;
// File paths go to the Switchboard page, which opens or previews them; the browser opens no tab.
assert.deepEqual([...window.__switchboardFilePaths('Saved to /Users/dom/clips/demo.mp4. /help and/or https://x.test/a/b ~/a.mov C:\\Users\\dom\\b.mp4 /x/y.rs:12')],['/Users/dom/clips/demo.mp4','~/a.mov','C:\\Users\\dom\\b.mp4','/x/y.rs']);
const files=[];parent.SwitchboardOpenFile=(host,path)=>files.push([host,path]);
const link=window.term._core.linkifier._currentLink.link;
for(const text of ['/Users/dom/clips/demo.mp4','file:///C:/Users/dom/a%20b.mp4']){
  link.text=text;handlers.mousedown({...click,shiftKey:false,metaKey:true});handlers.mouseup({...click,shiftKey:false,metaKey:true});
}
assert.deepEqual(files,[['windows','/Users/dom/clips/demo.mp4'],['windows','C:/Users/dom/a b.mp4']]);
assert.equal(opened.length,1);link.text='http://127.0.0.1:8765/';delete parent.SwitchboardOpenFile;
const app=fs.readFileSync(__dirname+'/static/app.js','utf8'),frameWindow={};let active=true;
const sessions=new Map([['main',{frame:{contentWindow:frameWindow,classList:{contains:()=>active}}}]]);
vm.runInNewContext(app.slice(app.indexOf("window.addEventListener('message',event=>{"),app.indexOf("$('artifact-back').onclick=")),{window,location,document,URL,sessions,setStatus(){}});
const message={origin:location.origin,source:frameWindow,data:{type:'zellij-open-link',uri:'https://example.test/artifact'}};
handlers.message({...message,origin:'https://untrusted.test'});
handlers.message({...message,source:{}});
active=false;handlers.message(message);active=true;
handlers.message({...message,data:{...message.data,uri:'javascript:alert(1)'}});
assert.equal(opened.length,1,'Only a valid active terminal may open a link');
handlers.message(message);
assert.deepEqual(opened[1],['https://example.test/artifact','_blank','noopener noreferrer']);
// Hovering a media path shows a preview from the terminal's own computer; other paths show none.
(async()=>{
  const body=[],node=tag=>({tagName:tag.toUpperCase(),style:{},children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},remove(){body.splice(body.indexOf(this),1);}});
  const settings={};let provider;const line='Saved /Users/dom/clips/demo.mp4 and /Users/dom/notes.txt and C:\\out\\map.png then D:\\Program Files\\Captures\\run (1).mp4 and \\\\nas\\share\\a.webm';
  const term={cols:200,buffer:{active:{getLine:()=>({isWrapped:false,translateToString:()=>line})}},options:{},registerLinkProvider:value=>provider=value,_core:{}};
  vm.runInNewContext(fs.readFileSync(__dirname+'/static/links.js','utf8'),{window:{term,innerWidth:800,innerHeight:600,addEventListener(){}},parent,location,URL,console,localStorage:{getItem:key=>settings[key]??null},
    document:{createElement:node,body:{append:value=>body.push(value)}},setInterval:fn=>(Promise.resolve().then(fn),1),clearInterval(){},setTimeout:fn=>fn(),clearTimeout(){}});
  await Promise.resolve();let links;provider.provideLinks(1,value=>links=value);
  const hover=text=>links.find(link=>link.text===text).hover({clientX:700,clientY:20},text);
  hover('/Users/dom/clips/demo.mp4');assert.equal(body.length,0,'Previews are off by default');
  settings['switchboard-media-previews']='true';
  hover('/Users/dom/notes.txt');assert.equal(body.length,0);
  hover('/Users/dom/clips/demo.mp4');
  const video=body[0].children[0];
  assert.deepEqual([video.tagName,video.muted,video.src],['VIDEO',true,'/api/hosts/windows/file?path=%2FUsers%2Fdom%2Fclips%2Fdemo.mp4']);
  assert.match(body[0].style.cssText,/right:112px;top:36px/);
  hover('C:\\out\\map.png');assert.equal(body.length,1,'One preview at a time');
  body[0].children[0].onerror();assert.deepEqual(body[0].children,['Preview unavailable']);
  assert.deepEqual([...links.map(link=>link.text)].sort(),['/Users/dom/clips/demo.mp4','/Users/dom/notes.txt','C:\\out\\map.png','D:\\Program Files\\Captures\\run (1).mp4','\\\\nas\\share\\a.webm'].sort(),'Windows media paths keep spaces, parentheses and UNC roots');
  hover('D:\\Program Files\\Captures\\run (1).mp4');
  assert.equal(body[0].children[0].src,'/api/hosts/windows/file?path=D%3A%5CProgram%20Files%5CCaptures%5Crun%20(1).mp4');
  links[0].leave();assert.equal(body.length,0);
  console.log('Hovering a media path previews it; other paths do not.');
})().catch(error=>{console.error(error);process.exitCode=1;});
console.log('Cmd/Ctrl/Shift-click uses a native tab hyperlink; URL mapping and modifier/drag guards passed.');

// Optional real-browser check: PLAYWRIGHT_MODULE=/path/to/playwright node links.test.cjs
if(process.env.PLAYWRIGHT_MODULE)(async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext();
    await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<div id="terminal" style="width:500px;height:200px">Terminal link</div>'}));
    const page=await context.newPage();
    await page.goto(location.href);
    await page.evaluate(()=>{
      window.__switchboardLinkHosts={windows:{origin:'https://172.20.10.69:8082',local:false}};
      window.term={cols:80,element:document.querySelector('#terminal'),options:{linkHandler:{}},_core:{_mouseService:{},linkifier:{_positionFromMouseEvent:()=>({x:3,y:1}),_currentLink:{link:{text:'http://localhost:8765/test?q=1#part',range:{start:{x:1,y:1},end:{x:8,y:1}}}}}}};
      window.linkClicks=[];
      const createElement=document.createElement.bind(document);
      document.createElement=(...args)=>{const node=createElement(...args);if(node.tagName==='A')node.addEventListener('click',event=>window.linkClicks.push({shift:event.shiftKey,ctrl:event.ctrlKey,alt:event.altKey,meta:event.metaKey,button:event.button,target:node.target,rel:node.rel}));return node;};
      const open=window.open.bind(window);window.focusRequests=0;window.open=(...args)=>{const tab=open(...args);if(tab){const focus=tab.focus.bind(tab);tab.focus=()=>{window.focusRequests++;focus();};}return tab;};
    });
    await page.addScriptTag({path:__dirname+'/static/links.js'});
    await page.locator('#terminal').click();
    assert.equal(context.pages().length,1,'Plain click must not navigate');
    for(const modifier of ['Meta','Control','Shift']){
    const popupReady=context.waitForEvent('page');
    await page.locator('#terminal').click({modifiers:[modifier]});
    const popup=await popupReady;await popup.waitForURL('http://172.20.10.69:8765/test?q=1#part');await popup.waitForLoadState();
    assert.equal(popup.url(),'http://172.20.10.69:8765/test?q=1#part');
    assert.equal(await popup.evaluate(()=>window.opener),null);
    if(modifier!=='Shift')assert.equal(await popup.evaluate(()=>document.hasFocus()),true,'The new tab receives focus');
    assert.deepEqual(await page.evaluate(()=>window.linkClicks.splice(0)),modifier==='Shift'?[{shift:false,ctrl:false,alt:false,meta:false,button:0,target:'_blank',rel:'noopener noreferrer'}]:[]);
    assert.equal(page.url(),location.href,'Original terminal stays in place');
    await popup.close();
    }
    assert.equal(await page.evaluate(()=>window.focusRequests),2);
    console.log('Headless browser: Cmd/Ctrl/Shift-click opens each remote URL in the viewing browser with no opener.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
