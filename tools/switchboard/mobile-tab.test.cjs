const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
for(const empty of [false,true])test(`mobile conversation survives creation on ${empty?'empty':'existing'} session`,{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
  try{
    // Landscape touch layouts use the same mobile default as phones.
    const page=await browser.newPage({viewport:{width:900,height:600},hasTouch:true,isMobile:true});
    page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{localStorage.setItem('switchboard-view-mode','terminal');window.setInterval=()=>0;});
    let connected=!empty;
    await page.route('**/*',route=>{
      const path=new URL(route.request().url()).pathname;
      const json=data=>route.fulfill({json:data});
      if(path==='/api/hosts')return json([{id:'fixture',name:'Fixture'}]);
      if(path==='/api/hosts/fixture')return json({id:'fixture',name:'Fixture',sessions:connected?[{name:'main',web_clients_allowed:true}]:[]});
      if(path==='/api/attention')return json({tabs:connected?[{host:'fixture',session:'main',id:1,position:0,name:'Original',panes:[{pane_id:1,is_plugin:false,tab_position:0}]}]:[],panes:[],errors:[]});
      if(path==='/hosts/fixture/project-list')return json(['switchboard']);
      if(path.startsWith('/api/'))return json({});
      if(path.startsWith('/hosts/')){connected=true;return route.fulfill({contentType:'text/html',body:`<div id=terminal></div><script>
        window.term={element:document.getElementById('terminal'),options:{},focus(){},blur(){},_core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};
        window.__zjSendControl=m=>{if(m.type==='NewTab')window.created=true;};
      </script><script src="/bridge.js"></script><script>
        const socket=window.controlSocket=new WebSocket('wss://switchboard.test/ws/control');
        window.state=count=>{const panes=Array.from({length:count},(_,i)=>({pane_id:i+1,is_plugin:false,tab_position:i}));socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[count-1],tabs:panes.map((p,i)=>({position:i,name:i?'New shell':'Original',active:i===count-1}))}})}));};state(1);
      </script>`});}
      const file=path==='/'?'index.html':path.slice(1);
      if(!/^[\w.-]+$/.test(file)||!fs.existsSync(__dirname+'/static/'+file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',path:__dirname+'/static/'+file});
    });
    await page.goto('https://switchboard.test/');
    if(empty)await page.getByText('No terminals yet',{exact:true}).waitFor({state:'attached'});
    else await page.locator('.conversation-panel').waitFor();
    await page.evaluate(()=>openNewTabDialog(false));
    await page.locator('#new-tab-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe')?.contentWindow.created);
    assert.equal(await page.locator('#terminals').evaluate(el=>el.classList.contains('conversation-open')),true);
    await page.evaluate(()=>document.querySelector('#terminals>iframe').contentWindow.state(2));
    await page.waitForFunction(()=>document.querySelector('.conversation-heading strong').textContent==='New shell');
    assert.equal(await page.locator('.conversation-panel').isVisible(),true);
    assert.equal(await page.locator('#terminals>iframe').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('.conversation-panel')),true);
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.reload();
    await page.locator('.conversation-modes:not([hidden])').waitFor();
    assert.equal(await page.getByRole('button',{name:'Terminal',exact:true}).getAttribute('aria-pressed'),'true','Explicit mobile preference survives reload');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
