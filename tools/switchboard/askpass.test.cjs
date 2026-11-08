const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createAskpass}=require('./static/askpass.js');

// A fake <dialog>: close() fires its close event later, as browsers do.
function page(){
  const elements=new Map(),listeners={};
  const $=id=>{
    if(!elements.has(id))elements.set(id,{id,textContent:'',value:'',open:false,focused:false,
      addEventListener(type,listener){(listeners[id+type]??=[]).push(listener);},
      showModal(){this.open=true;},focus(){this.focused=true;},
      close(){if(!this.open)return;this.open=false;queueMicrotask(()=>(listeners[id+'close']||[]).forEach(l=>l()));}});
    return elements.get(id);
  };
  const fire=(id,type,event={preventDefault(){}})=>(listeners[id+type]||[]).forEach(l=>l(event));
  return {$,fire};
}
const request={id:'r1',host:'linux',session:'main',pane_id:7,prompt:'[sudo] password for me: ',command:'sudo -A install x /etc/y'};
function setup(selected=request){
  const {$,fire}=page(),posts=[],state={selected,other:false,focused:0};
  const askpass=createAskpass({$,current:()=>state.selected,hostName:host=>host==='linux'?'Linux PC':host,
    fetch:async(url,options)=>{posts.push([url,JSON.parse(options.body)]);return {ok:true};},
    focusTerminal:()=>state.focused++,otherDialogOpen:()=>state.other});
  return {$,fire,posts,state,askpass};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('a request on the selected tab asks once and sends the password only to its request',async()=>{
  const {$,fire,posts,state,askpass}=setup();
  askpass.update([request]);
  const dialog=$('askpass-dialog');
  assert.equal(dialog.open,true);
  assert.equal($('askpass-computer').textContent,'Linux PC');
  assert.equal($('askpass-command').textContent,'sudo -A install x /etc/y');
  assert.equal($('askpass-prompt').textContent,'[sudo] password for me:');
  assert.equal($('askpass-password').focused,true);
  $('askpass-password').value='hunter2';
  fire('askpass-form','submit');
  assert.equal($('askpass-password').value,'','the field forgets the password at once');
  await settle();
  assert.deepEqual(posts,[['/api/askpass/answer',{host:'linux',id:'r1',password:'hunter2'}]]);
  assert.equal(dialog.open,false);assert.equal(state.focused,1,'focus returns to the terminal');
  // The relay has not republished yet: the answered request must not reopen.
  askpass.update([request]);
  assert.equal(dialog.open,false);
  askpass.update([]);
  assert.equal(posts.length,1);
});

test('closing without Send cancels so sudo fails at once',async()=>{
  for(const close of [({$})=>$('askpass-cancel').onclick(),({$})=>$('askpass-dialog').close()]){
    const context=setup();
    context.askpass.update([request]);
    close(context);await settle();
    assert.deepEqual(context.posts,[['/api/askpass/answer',{host:'linux',id:'r1'}]]);
    assert.equal(context.$('askpass-dialog').open,false);
  }
});

test('a request answered elsewhere or withdrawn closes without cancelling, and the next one still asks',async()=>{
  const {$,posts,state,askpass}=setup();
  askpass.update([request]);
  const next={...request,id:'r2'};
  state.selected=next;
  askpass.update([next]);
  assert.equal($('askpass-dialog').open,false);
  // A snapshot arriving before the close event must not open a dialog the event then cancels.
  askpass.update([next]);
  assert.equal($('askpass-dialog').open,false);
  await settle();
  assert.deepEqual(posts,[]);
  askpass.update([next]);
  assert.equal($('askpass-dialog').open,true);
});

test('another open dialog or an unselected tab leaves the request on its badge',()=>{
  const {$,state,askpass}=setup(null);
  askpass.update([request]);
  assert.equal($('askpass-dialog').open,false);
  state.selected=request;state.other=true;
  askpass.update([request]);
  assert.equal($('askpass-dialog').open,false);
});

test('a tab with a password request is marked and labelled before any agent state',()=>{
  const source=fs.readFileSync(__dirname+'/static/app.js','utf8');
  const context={ready:{},seenAttention:{},paneAttention:new Map()};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function attentionKey('),source.indexOf('const reviewSent=')),context);
  vm.runInContext(source.slice(source.indexOf('function isReady('),source.indexOf('function matchesSearch(')),context);
  const item={key:'k',entry:{host:'linux',name:'main'},tab:{name:'shell',panes:[{pane_id:7,is_plugin:false}]}};
  context.paneAttention.set(context.attentionKey('linux','main',7),{state:'approval'});
  assert.equal(context.autoLabel(item),'Approval needed');
  vm.runInContext('askpassRequests='+JSON.stringify([request]),context);
  assert.equal(context.autoLabel(item),'Password needed');
  context.paneAttention.clear();
  assert.equal(context.isReady(item),true);
  for(const other of [{...request,pane_id:8},{...request,session:'work'},{...request,host:'mac'}]){
    vm.runInContext('askpassRequests='+JSON.stringify([other]),context);
    assert.equal(context.isReady(item),false);
  }
});

// Fixture relay and terminals only; never the live sidebar.
test('the sidebar badges a password request, asks when its tab is selected, and answers the relay',
  {skip:!process.env.PLAYWRIGHT_MODULE&&'Set PLAYWRIGHT_MODULE for the isolated browser check'},async()=>{
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage(),errors=[],answers=[];page.setDefaultTimeout(5000);
    page.on('pageerror',e=>errors.push(e.message));
    const tabs=['first','second'].map((name,i)=>({host:'linux',session:'main',id:i+1,position:i,name,panes:[{pane_id:i+1,is_plugin:false,tab_position:i}]}));
    let open=[{...request,pane_id:2}];
    await page.addInitScript(()=>{window.setInterval=()=>0;});
    await context.route('**/*',async route=>{
      const path=new URL(route.request().url()).pathname;
      const json=value=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(path==='/api/hosts')return json([{id:'linux',name:'Linux PC',local:true}]);
      if(path.startsWith('/api/hosts/'))return json({id:'linux',name:'Linux PC',sessions:[{name:'main',web_clients_allowed:true}]});
      if(path==='/api/attention')return json({tabs,panes:[],errors:[],...(open.length?{askpass:open}:{})});
      if(path==='/api/askpass/answer'){answers.push(route.request().postDataJSON());open=[];return route.fulfill({status:204,body:''});}
      if(path.startsWith('/hosts/'))return route.fulfill({contentType:'text/html',body:'<p>terminal fixture</p>'});
      const file=path==='/'?'index.html':path.slice(1);
      if(!['index.html','app.js','model-picker.js','close.js','askpass.js','titles.js','style.css'].includes(file))return route.fulfill({status:404,body:''});
      return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:fs.readFileSync(__dirname+'/static/'+file,'utf8')});
    });
    await page.goto('https://switchboard.test/');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select').length===2);
    const second=page.locator('#tabs .tab-select').nth(1);
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select')[1].dataset.agentState==='Password needed');
    assert.match(await second.getAttribute('class'),/needs-attention/);
    assert.equal(await page.locator('#askpass-dialog').isVisible(),false,'only the selected tab asks');
    await second.click();
    await page.locator('#askpass-dialog').waitFor({state:'visible'});
    assert.equal(await page.locator('#askpass-command').textContent(),'sudo -A install x /etc/y');
    assert.equal(await page.locator('#askpass-computer').textContent(),'Linux PC');
    await page.keyboard.type('hunter2');
    await page.keyboard.press('Enter');
    await page.locator('#askpass-dialog').waitFor({state:'hidden'});
    assert.deepEqual(answers,[{host:'linux',id:'r1',password:'hunter2'}]);
    assert.equal(await page.locator('#askpass-password').inputValue(),'');
    await page.waitForFunction(()=>document.querySelectorAll('#tabs .tab-select')[1].dataset.agentState==='',null,{timeout:8000});
    assert.equal(await page.locator('#askpass-dialog').isVisible(),false);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
