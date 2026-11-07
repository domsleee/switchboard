const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('phone terminal fits above the keyboard with a compact font and keeps manual zoom',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{if(window===parent){localStorage.setItem('switchboard-mobile-view-mode','terminal');window.visibleHeight=844;window.visibleTop=0;window.viewScale=1;Object.defineProperties(visualViewport,{height:{get:()=>visibleHeight},offsetTop:{get:()=>visibleTop},scale:{get:()=>viewScale}});}});
  await page.route('http://terminal.test/**',route=>{
   const p=new URL(route.request().url()).pathname,json=value=>route.fulfill({json:value});
   if(p==='/api/hosts')return json([{id:'fixture',name:'Fixture'}]);
   if(p==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture',sessions:[{name:'main',web_clients_allowed:true}]});
   if(p==='/api/attention')return json({tabs:[{host:'fixture',session:'main',id:1,position:0,name:'Mobile terminal',panes:[{pane_id:1,is_plugin:false,tab_position:0}]}],panes:[],errors:[]});
   if(p.startsWith('/api/'))return json({});
   if(p.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/style.css"><link rel="stylesheet" href="/assets/xterm.css"><div id="terminal"></div><script src="/assets/xterm.js"></script><script src="/assets/addon-fit.js"></script><script type="module">
    import {settleFontSize} from '/assets/terminal.js';
    const term=window.term=new Terminal({scrollback:0}),fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(document.getElementById('terminal'));settleFontSize(term,fit,{});
    window.setFont=px=>{term.options.fontSize=px;fit.fit();};window.explicitFont=px=>settleFontSize(term,fit,{font_size:px});
    const draw=()=>{term.clear();term.write('Mobile terminal\\r\\nKeyboard-aware layout\\r\\n'+('Line of output\\r\\n'.repeat(Math.max(0,term.rows-4))))};
    addEventListener('resize',()=>{fit.fit();draw();});draw();
    const pane={pane_id:1,is_plugin:false,tab_position:0};function state(id){parent.postMessage({type:'zellij-state',focus_id:id,payload:{session_name:'main',panes:[pane],active_pane:pane}},location.origin)};
    addEventListener('message',e=>{if(e.data.type==='zellij-focus')state(e.data.focus_id)});state();
   </script>`});
   const file=p.startsWith('/assets/')?path.join(__dirname,'../../zellij-client/assets',path.basename(p)):path.join(__dirname,'static',p==='/'?'index.html':path.basename(p));
   if(!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.woff2')?'font/woff2':'text/html',path:file});
  });
  await page.goto('http://terminal.test/');await page.locator('.conversation-modes:not([hidden])').waitFor();
  const frame=page.frames().find(f=>f.url().includes('/hosts/')),iframe=page.locator('#terminals>iframe.active');
  await frame.waitForFunction(()=>window.term?.cols>40);
  assert.equal(await frame.evaluate(()=>term.options.fontSize),14);assert.ok(await frame.evaluate(()=>term.cols)>=43);
  const fullRows=await frame.evaluate(()=>term.rows);
  async function keyboard(height,top=0){await page.evaluate(({height,top})=>{visibleHeight=height;visibleTop=top;visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'));},{height,top});await page.waitForFunction(height=>Math.abs(document.querySelector('#terminals>iframe.active').getBoundingClientRect().bottom-(visibleTop+height))<2,height);}
  await keyboard(420);await frame.waitForFunction(rows=>term.rows<rows,fullRows);
  assert.ok(await frame.evaluate(()=>term.rows)>=18);assert.equal(await frame.evaluate(()=>term.options.fontSize),14);
  let bounds=await iframe.boundingBox();assert.ok(bounds.y>=60&&bounds.y+bounds.height<=421);
  if(process.env.MOBILE_TERMINAL_SCREENSHOT)await page.screenshot({path:process.env.MOBILE_TERMINAL_SCREENSHOT});
  await keyboard(380,35);bounds=await iframe.boundingBox();assert.ok(bounds.y>=95&&bounds.y+bounds.height<=416);
  await frame.evaluate(()=>setFont(18));await keyboard(844);assert.equal(await frame.evaluate(()=>term.options.fontSize),18);
  await page.evaluate(()=>{viewScale=2;visibleHeight=300;visualViewport.dispatchEvent(new Event('resize'));});assert.equal(await page.evaluate(()=>document.body.style.getPropertyValue('--terminal-visible-height')),'844px');
  await page.evaluate(()=>{viewScale=1;visualViewport.dispatchEvent(new Event('resize'));});await keyboard(844);
  await page.getByRole('button',{name:'Conversation',exact:true}).click();await page.waitForFunction(()=>!document.body.classList.contains('mobile-terminal-viewport'));
  await page.getByRole('button',{name:'Terminal',exact:true}).click();await page.waitForFunction(()=>document.body.classList.contains('mobile-terminal-viewport'));
  await page.setViewportSize({width:844,height:390});await keyboard(240);bounds=await iframe.boundingBox();assert.ok(bounds.y+bounds.height<=241);assert.equal(await frame.evaluate(()=>term.options.fontSize),18);
  await frame.evaluate(()=>explicitFont(20));assert.equal(await frame.evaluate(()=>term.options.fontSize),20);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
