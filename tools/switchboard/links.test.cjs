const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers={},messages=[],opened=[];
const parent={postMessage:(message,origin)=>messages.push({message,origin})};
const location={pathname:'/hosts/windows/main',origin:'http://127.0.0.1:8090',href:'http://127.0.0.1:8090/hosts/windows/main'};
const window={open:()=>{throw Error('Links must use a native tab hyperlink');},__switchboardLinkHosts:{windows:{origin:'https://172.20.10.69:8082',local:false,artifacts:{'9000':'http://127.0.0.1:9090'}}},addEventListener:(type,fn)=>handlers[type]=fn};
const document={createElement:tag=>{assert.equal(tag,'a');return {click(){opened.push([this.href,this.target,this.rel]);}};}};
window.term={cols:80,element:{},_core:{_mouseService:{},linkifier:{_positionFromMouseEvent:()=>({x:3,y:1}),_currentLink:{link:{text:'http://127.0.0.1:8765/',range:{start:{x:1,y:1},end:{x:8,y:1}}}}}}};
vm.runInNewContext(fs.readFileSync(__dirname+'/static/links.js','utf8'),{window,parent,location,document,URL,console,setInterval:()=>1,clearInterval:()=>{}});
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
console.log('Shift-click uses a native tab hyperlink; URL mapping and modifier/drag guards passed.');

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
      window.open=()=>{throw Error('Must use native hyperlink navigation');};
    });
    await page.addScriptTag({path:__dirname+'/static/links.js'});
    await page.locator('#terminal').click();
    assert.equal(context.pages().length,1,'Plain click must not navigate');
    const popupReady=context.waitForEvent('page');
    await page.locator('#terminal').click({modifiers:['Shift']});
    const popup=await popupReady;await popup.waitForLoadState();
    assert.equal(popup.url(),'http://172.20.10.69:8765/test?q=1#part');
    assert.equal(await popup.evaluate(()=>window.opener),null);
    assert.deepEqual(await page.evaluate(()=>window.linkClicks),[{shift:false,ctrl:false,alt:false,meta:false,button:0,target:'_blank',rel:'noopener noreferrer'}]);
    assert.equal(page.url(),location.href,'Original terminal stays in place');
    console.log('Headless browser: physical Shift-click produces an unmodified hyperlink click and opens the mapped URL with no opener.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
