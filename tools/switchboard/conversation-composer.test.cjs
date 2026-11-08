const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');

const static_=path.join(__dirname,'static');
const css=fs.readFileSync(path.join(static_,'conversation.css'),'utf8'),html=fs.readFileSync(path.join(static_,'index.html'),'utf8');
function newTabIcon(id){const button=html.match(new RegExp(`id="${id}"[\\s\\S]*?</svg>`));assert.ok(button,`index.html has #${id}`);return button[0].match(/ d="([^"]+)"/)[1];}
function rule(selector){const start=css.indexOf(selector+'{');assert.notEqual(start,-1,selector);return css.slice(start,css.indexOf('\n',start));}

test('Conversation composer draws the same attach and send icons as the new-tab composer',()=>{
 assert.ok(rule('.conversation-compose .conversation-attach::before').includes(`d='${newTabIcon('new-tab-attach')}'`),'Attach uses the new-tab paperclip');
 assert.ok(rule('.conversation-compose>button[type=submit]::before').includes(`d='${newTabIcon('new-tab-submit')}'`),'Send uses the new-tab arrow');
});

for(const [name,width,height] of [['desktop',1280,800],['phone',390,844]])test(`Conversation composer keeps attach left and the model beside send on ${name}`,
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.setInterval=()=>0;localStorage.setItem('switchboard-view-mode','conversation');});
  await page.route('http://composer.test/**',route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.endsWith('/stream')||p.startsWith('/api/diagnostics/'))return route.fulfill({status:404,body:''});
   if(p.endsWith('/conversation/skills'))return route.fulfill({json:{skills:[]}});
   if(p.startsWith('/api/chats/'))return route.fulfill({json:{model:'claude-opus-5-5',project:'/work/switchboard',usage:{cost_usd:1.23,input_tokens:1,cache_write_tokens:1,cache_read_tokens:1,output_tokens:1,responses:1,unpriced_tokens:0},messages:[{role:'assistant',text:'Done'}],start_cursor:0,next_cursor:null}});
   if(p==='/')return route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100vh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',pane:1,title:'Switchboard',agent:'claude',state:'ready',chatId:'chat-1',showCost:true,switchAvailable:true,frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){},switchModel(){}});</script>`});
   return route.fulfill({path:path.join(static_,path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
  });
  await page.goto('http://composer.test/');await page.getByText('Done',{exact:true}).waitFor();
  const box=selector=>page.locator(selector).boundingBox(),form='.conversation-compose';
  const composer=await box(form),attach=await box(form+' .conversation-attach'),model=await box(form+' button.conversation-model'),send=await box(form+'>button[type=submit]');
  assert.ok(attach.x-composer.x<16,'Attach starts the toolbar');
  assert.ok(send.x+send.width<=composer.x+composer.width&&composer.x+composer.width-(send.x+send.width)<16,'Send ends the toolbar');
  const gap=send.x-(model.x+model.width);assert.ok(gap>=0&&gap<=8,`The model sits beside send (gap ${gap})`);
  // Text in these grid buttons becomes a second grid item and pushes the drawn icon off centre.
  for(const button of [' .conversation-attach','>button[type=submit]'])assert.equal(await page.locator(form+button).textContent(),'','The icon is drawn, not typed');
  // The queued-switch cancel takes the cost's place left of the model, so send stays put.
  await page.evaluate(()=>{current.pendingSwitch={label:'Codex'};SwitchboardConversation.update();});
  const cancel=await box(form+' .conversation-model-cancel'),pending=await box(form+' button.conversation-model'),sendPending=await box(form+'>button[type=submit]');
  assert.ok(cancel.x+cancel.width<=pending.x,'Cancel sits left of the pending model');
  assert.equal(sendPending.x,send.x,'Send does not move while a switch is pending');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
