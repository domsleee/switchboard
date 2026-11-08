const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

// The agent's own report of a new turn is held back here, as a slow hook would be.
test('submitting typed text shows Working before the agent reports its turn',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    let pane={host:'mac',session:'main',pane_id:7,agent:'claude',state:'ready',token:'one',seen:true},version=1;
    const watches=[],snapshot=()=>JSON.stringify({version,tabs:[{host:'mac',session:'main',id:42,position:0,name:'Alpha',panes:[{pane_id:7,is_plugin:false,tab_position:0}]}],panes:[pane],errors:[]});
    const report=next=>{pane={...pane,...next};version++;for(const route of watches.splice(0))route.fulfill({contentType:'application/json',body:snapshot()});};
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      const json=data=>route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/api/health')return json({commit:'abc123def',commit_date:'2026-10-04'});
      if(path==='/api/hosts')return json([{id:'mac',name:'Mac'}]);
      if(path==='/api/hosts/mac')return json({id:'mac',name:'Mac',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention'){
        if(url.searchParams.has('after')&&Number(url.searchParams.get('after'))>=version){watches.push(route);return;}
        return route.fulfill({contentType:'application/json',body:snapshot()});
      }
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:`<div id="terminal"><input id="terminal-input"></div><script>window.WebSocket=class extends EventTarget {constructor(){super();this.readyState=1;}send(){}};</script><script src="/bridge.js"></script><script>
        const input=document.querySelector('input');
        const terminal=new WebSocket('wss://switchboard.test/ws/terminal'),control=new WebSocket('wss://switchboard.test/ws/control');
        window.term={element:document.querySelector('#terminal'),textarea:input,options:{disableStdin:false},focus(){input.focus()},blur(){input.blur()},getSelection:()=>'',input(data){terminal.send(data);},
          _core:{_renderService:{dimensions:{css:{cell:{width:8,height:16}}}}},buffer:{active:{viewportY:0,getLine:()=>({translateToString:()=>''})}},onRender(){},onResize(){}};
        const panes=[{pane_id:7,is_plugin:false,tab_position:0,title:'~'}];
        control.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'MobileState',payload:{session_name:'main',panes,active_pane:panes[0],tabs:[{position:0,name:'Alpha',active:true}]}})}));
      </script>`});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','bridge.js','close.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/?host=mac&session=main&tab=42');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected')?.textContent.includes('Alpha'));
    const frame=page.frames().find(item=>item.url().includes('/hosts/'))||await page.waitForEvent('frameattached');
    await frame.waitForFunction(()=>window.term);
    const star=()=>page.locator('#tabs .selected .star').getAttribute('class');
    const send=data=>frame.evaluate(data=>window.term.input(data),data);
    const stillNot=async()=>{await page.waitForTimeout(150);assert.doesNotMatch(await star(),/working/);};

    await stillNot();
    await send('\r');await stillNot();
    await send('/');await send('h');await send('\r');await stillNot();
    await send('a');await send('\x7f');await send('\r');await stillNot();
    // A path is a prompt, not a command.
    await send('/tmp/x fix');await send('\r');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .star')?.classList.contains('working'),null,{timeout:500});
    report({state:'ready',token:'path'});
    await page.waitForFunction(()=>!document.querySelector('#tabs .selected .star')?.classList.contains('working'),null,{timeout:1000});

    await send('h');await send('i');await send('\r');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .star')?.classList.contains('working'),null,{timeout:500});
    assert.equal(watches.length>0,true,'the relay has not been heard from');

    // The same report it replaces keeps the tab working; a finished turn ends it.
    report({state:'ready'});await page.waitForTimeout(100);
    assert.match(await star(),/working/);
    report({state:'working'});await page.waitForTimeout(100);
    assert.match(await star(),/working/);
    report({state:'ready',token:'two'});
    await page.waitForFunction(()=>!document.querySelector('#tabs .selected .star')?.classList.contains('working'),null,{timeout:1000});

    // A submission that starts no turn falls back to what the relay says.
    await send('o');await send('k');await send('\r');
    await page.waitForFunction(()=>document.querySelector('#tabs .selected .star')?.classList.contains('working'),null,{timeout:500});
    await page.waitForFunction(()=>!document.querySelector('#tabs .selected .star')?.classList.contains('working'),null,{timeout:7000});
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

test('Conversation reports a reply as submitted and takes it back when it fails',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),errors=[];
    page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
    let status=409;
    await page.route('http://send.test/**',route=>{
      const url=new URL(route.request().url());
      if(url.pathname.startsWith('/api/diagnostics/'))return route.fulfill({status:204});
      if(url.pathname.endsWith('/conversation/reply'))return status===200?route.fulfill({json:{ok:true}}):route.fulfill({status,body:'Claude is not at its prompt.'});
      if(url.pathname.startsWith('/api/chats/'))return route.fulfill({json:{session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'Earlier answer'}],start_cursor:0,next_cursor:null}});
      if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.calls=[];window.current={key:'pane1',host:'fixture',session:'main',pane:1,agent:'claude',state:'ready',chatId:'chat',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{},sending:(view,command)=>calls.push(['sending',view.pane,command]),notSent:key=>calls.push(['notSent',key])});</script>`});
      return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',path:path.join(__dirname,'static',path.basename(url.pathname))});
    });
    await page.goto('http://send.test/');await page.getByText('Earlier answer',{exact:true}).waitFor();
    const draft=page.getByLabel('Reply draft'),send=page.getByRole('button',{name:'Send',exact:true});
    const calls=()=>page.evaluate(()=>window.calls);

    await draft.fill('Refused reply');await send.click();
    await page.waitForFunction(()=>calls.length===2);
    assert.deepEqual(await calls(),[['sending',1,false],['notSent','pane1']]);

    status=200;await page.evaluate(()=>{window.calls=[];});
    await draft.fill('Accepted reply');await send.click();
    await page.waitForFunction(()=>document.querySelector('.conversation-compose textarea').value==='');
    await page.waitForTimeout(150);
    assert.deepEqual(await calls(),[['sending',1,false]]);

    // A command goes through the terminal and may not start a turn.
    await page.evaluate(()=>{window.calls=[];});
    await draft.fill('/help');await send.click();
    await page.waitForFunction(()=>calls.length===1);
    assert.deepEqual(await calls(),[['sending',1,true]]);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
