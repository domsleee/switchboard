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
for(const text of ['/Users/dom/clips/demo.png','file:///C:/Users/dom/a%20b.png']){
  link.text=text;handlers.mousedown({...click,shiftKey:false,metaKey:true});handlers.mouseup({...click,shiftKey:false,metaKey:true});
}
assert.deepEqual(files,[['windows','/Users/dom/clips/demo.png'],['windows','C:/Users/dom/a b.png']]);
assert.equal(opened.length,1);
// Cmd/Ctrl-click on a video opens the file route in a new tab; Shift still goes to the page.
for(const modifier of ['metaKey','ctrlKey']){
  link.text='C:\\clips\\a b.mov';handlers.mousedown({...click,shiftKey:false,[modifier]:true});handlers.mouseup({...click,shiftKey:false,[modifier]:true});
  assert.deepEqual(opened.at(-1),['http://127.0.0.1:8090/api/hosts/windows/file?path=C%3A%5Cclips%5Ca%20b.mov','_blank','noopener noreferrer']);
}
link.text='/Users/dom/clips/demo.mp4';handlers.mousedown(click);handlers.mouseup(click);
assert.deepEqual(files.at(-1),['windows','/Users/dom/clips/demo.mp4']);assert.equal(opened.length,3);
opened.splice(1);link.text='http://127.0.0.1:8765/';delete parent.SwitchboardOpenFile;
// Browser pages such as chrome://settings go to the Switchboard page, which asks the browser to open them.
assert.deepEqual([...window.__switchboardBrowserPages('Open `chrome://settings/system`, then chrome://flags/#ignore-gpu-blocklist. Not xchrome://a or chrome:settings; edge://gpu')],
  ['chrome://settings/system','chrome://flags/#ignore-gpu-blocklist','edge://gpu']);
assert.deepEqual([...window.__switchboardFilePaths('chrome://settings/system')],[],'A browser page is not also a file path');
const pages=[];
link.text='chrome://settings/system';handlers.mousedown({...click,shiftKey:false,metaKey:true});handlers.mouseup({...click,shiftKey:false,metaKey:true});
assert.equal(opened.length,1,'Outside the Switchboard page a browser page opens nothing');
parent.SwitchboardOpenBrowserPage=url=>pages.push(url);
handlers.mousedown({...click,shiftKey:false,metaKey:true});handlers.mouseup({...click,shiftKey:false,metaKey:true});
assert.deepEqual(pages,['chrome://settings/system']);assert.equal(opened.length,1);
link.text='http://127.0.0.1:8765/';delete parent.SwitchboardOpenBrowserPage;
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
  const settings={};let provider;const line='Saved /Users/dom/clips/demo.mp4 and /Users/dom/notes.txt and C:\\out\\map.png then D:\\Program Files\\Captures\\run (1).mp4 and \\\\nas\\share\\a.webm, mv /tmp/a.txt /tmp/b.png then `chrome://settings/system`';
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
  assert.deepEqual([...links.map(link=>link.text)].sort(),['/Users/dom/clips/demo.mp4','/Users/dom/notes.txt','C:\\out\\map.png','D:\\Program Files\\Captures\\run (1).mp4','\\\\nas\\share\\a.webm','/tmp/a.txt','/tmp/b.png','chrome://settings/system'].sort(),'Windows media paths keep spaces, parentheses and UNC roots, and a path never runs into the next one');
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
// Relative media paths resolve through this session's pane directories before previewing or opening.
(async()=>{
  const body=[],requests=[],opened=[],node=tag=>({tagName:tag.toUpperCase(),style:{},children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},remove(){body.splice(body.indexOf(this),1);}});
  let provider;const line='Saved `out/shot.png` and ./clip.webm; see docs/notes.md, http://host/a.png, /tmp/x/b.png and missing.png';
  const term={cols:200,buffer:{active:{getLine:()=>({isWrapped:false,translateToString:()=>line})}},options:{},registerLinkProvider:value=>provider=value,_core:{}};
  const found={'out/shot.png':'/home/me/project/out/shot.png','./clip.webm':'/home/me/project/./clip.webm'};
  const fetch=async url=>{requests.push(url);const path=new URL(url,'http://relay').searchParams.get('path');return found[path]?{ok:true,json:async()=>({path:found[path]})}:{ok:false};};
  const tabs=[];
  vm.runInNewContext(fs.readFileSync(__dirname+'/static/links.js','utf8'),{window:{term,innerWidth:800,innerHeight:600,addEventListener(){},open:()=>{const tab={closed:false,close(){this.closed=true;},focus(){},document:{createElement:()=>({click(){tab.href=this.href;}})}};tabs.push(tab);return tab;}},parent:{SwitchboardOpenFile:(host,path)=>opened.push([host,path])},
    location:{...location,pathname:'/hosts/mesh-pc/my%20session'},URL,console,fetch,localStorage:{getItem:()=>'true'},
    document:{createElement:node,body:{append:value=>body.push(value)}},setInterval:fn=>(Promise.resolve().then(fn),1),clearInterval(){},setTimeout:fn=>fn(),clearTimeout(){}});
  await Promise.resolve();let links;provider.provideLinks(1,value=>links=value);
  assert.deepEqual([...links.map(link=>link.text)].sort(),['./clip.webm','/tmp/x/b.png','missing.png','out/shot.png'].sort(),'URLs, other files and backticks are not relative media paths');
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const hover=text=>links.find(link=>link.text===text).hover({clientX:10,clientY:10},text);
  hover('out/shot.png');await settle();
  assert.equal(requests[0],'/api/hosts/mesh-pc/resolve-file?session=my%20session&path=out%2Fshot.png');
  assert.equal(body[0].children[0].src,'/api/hosts/mesh-pc/file?path=%2Fhome%2Fme%2Fproject%2Fout%2Fshot.png');
  hover('out/shot.png');await settle();assert.equal(requests.length,1,'A found path is resolved once');
  hover('missing.png');await settle();assert.equal(body.length,0,'A path no pane holds shows nothing');
  hover('missing.png');await settle();assert.equal(requests.length,3,'A missing path is looked up again');
  // A late resolution never shows after the pointer left.
  hover('./clip.webm');links[0].leave();await settle();assert.equal(body.length,0);
  const click={metaKey:true,button:0,preventDefault(){},stopImmediatePropagation(){}};
  links.find(link=>link.text==='out/shot.png').activate(click,'out/shot.png');await settle();
  assert.deepEqual(opened,[['mesh-pc','/home/me/project/out/shot.png']]);
  // A video's tab opens within the click, then follows the resolved file or closes.
  links.find(link=>link.text==='./clip.webm').activate(click,'./clip.webm');
  assert.equal(tabs.length,1,'The tab opens before the lookup finishes');await settle();
  assert.equal(tabs[0].href,'http://127.0.0.1:8090/api/hosts/mesh-pc/file?path=%2Fhome%2Fme%2Fproject%2F.%2Fclip.webm');
  found['gone.webm']=null;links[0].activate(click,'gone.webm');await settle();
  assert.equal(tabs[1].closed,true);assert.equal(opened.length,1);
  console.log('Relative media paths resolve through the session before previewing or opening.');
})().catch(error=>{console.error(error);process.exitCode=1;});
