const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const tab=(host,id)=>({host,session:'main',id,position:0,name:host+' terminal',panes:[{pane_id:id,is_plugin:false,tab_position:0}]});
const statics=['index.html','app.js','bridge.js','close.js','titles.js','pairing-notice.js','style.css'];
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8DwH4QZGBgAEPYD/WQ/5WMAAAAASUVORK5CYII=','base64');

// Synthetic hosts and fixture terminals only; never a live relay.
test('Back, including a mouse back button, closes a file preview and stays on Switchboard',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE to run the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),pageErrors=[];page.setDefaultTimeout(5000);
    page.on('pageerror',error=>pageErrors.push(error.message));
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url()),pathname=url.pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(pathname==='/api/hosts/windows/file')return route.fulfill({contentType:'image/png',body:png});
      if(pathname==='/api/hosts')return json([{id:'mac',name:'Mac',local:true},{id:'windows',name:'Windows'}]);
      if(pathname.startsWith('/api/hosts/'))return json({id:pathname.split('/')[3],name:pathname.endsWith('mac')?'Mac':'Windows',sessions:[{name:'main',web_clients_allowed:true}]});
      if(pathname==='/api/attention')return json({tabs:[tab('mac',1),tab('windows',42)],panes:[],errors:[]});
      if(pathname==='/api/mesh')return json({configured:true,computer:{name:'Mac'},mesh:{name:'My computers'},administrator:true,requests:[],members:[]});
      if(pathname.startsWith('/api/'))return json({});
      if(pathname.startsWith('/hosts/')){
        const id=pathname.split('/')[2]==='mac'?1:42;
        return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>
          const input=document.querySelector('input');
          window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
          window.__zjSupportsTabViewport=true;window.__zjSendControl=()=>{};
          window.term={element:document.querySelector('#terminal'),options:{disableStdin:false},focus(){input.focus();},blur(){input.blur();},
            _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        </script><script src="/bridge.js"></script><script>
          const socket=new WebSocket('wss://switchboard.test/ws/control');
          const pane={pane_id:${id},is_plugin:false,tab_position:0};
          socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes:[pane],active_pane:pane,tab_viewport:{owner_active:true,cols:100,rows:40}}})}));
        </script>`});
      }
      const file=pathname==='/'?'index.html':pathname.slice(1);
      if(!statics.includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    const requested='https://switchboard.test/?host=windows&session=main&tab=42';
    await page.goto(requested);
    await page.waitForFunction(()=>document.querySelectorAll('#terminals>iframe').length===2&&document.activeElement===document.querySelector('iframe[title="Windows: main"]'));
    await page.evaluate(()=>{for(const frame of document.querySelectorAll('#terminals>iframe'))frame.contentWindow.stillLoaded=true;});
    const length=await page.evaluate(()=>history.length);
    const preview=()=>page.evaluate(()=>({open:!document.querySelector('#artifact-preview').hidden,history:history.length,frame:document.querySelector('#artifact-frame').contentWindow.location.href}));
    const open=path=>page.evaluate(path=>window.SwitchboardOpenFile('windows',path),path);
    const closed=()=>page.waitForFunction(()=>document.querySelector('#artifact-preview').hidden&&!history.state?.switchboardPreview);

    // Opening one file then another adds one history entry in all.
    await open('C:\\shots\\before.png');
    await page.waitForFunction(()=>document.querySelector('#artifact-frame').contentWindow.location.href.includes('before.png'));
    await open('C:\\shots\\after.png');
    await page.waitForFunction(()=>document.querySelector('#artifact-frame').contentWindow.location.href.includes('after.png'));
    assert.deepEqual(await preview(),{open:true,history:length+1,frame:'https://switchboard.test/api/hosts/windows/file?path=C%3A%5Cshots%5Cafter.png'});

    // The mouse's back button is the browser's Back: it closes the preview, with focus in the image.
    await page.frameLocator('#artifact-frame').locator('img').click();
    const cdp=await context.newCDPSession(page);
    for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:700,y:400,button:'back',buttons:type==='mousePressed'?8:0,clickCount:1});
    await closed();
    assert.equal(page.url(),requested,'Back stays on Switchboard');
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('#terminals>iframe')].every(frame=>frame.contentWindow.stillLoaded)),true,'Terminals stay connected');
    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('iframe[title="Windows: main"]')),true,'The terminal gets focus back');

    // Closing it with its own button or Escape drops the entry, so the next Back has nothing of the preview left.
    for(const close of [()=>page.locator('#artifact-back').click(),()=>page.keyboard.press('Escape')]){
      await open('C:\\shots\\before.png');
      assert.equal((await preview()).open,true);
      await close();await closed();
      assert.equal(await page.evaluate(()=>document.querySelector('#artifact-frame').contentWindow.location.href),'about:blank');
    }
    await page.evaluate(()=>{window.stillHere=true;});
    await page.goBack({waitUntil:'commit'}).catch(()=>{});
    assert.notEqual(await page.evaluate(()=>window.stillHere).catch(()=>undefined),true,'Back after a closed preview leaves the page as before');
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});
