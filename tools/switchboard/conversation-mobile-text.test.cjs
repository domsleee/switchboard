const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');

const messages=[
 {role:'user',text:'Why is the composer bigger?',timestamp:'2026-11-08T10:00:00Z'},
 {role:'assistant',text:'It needs 16px on phones.',timestamp:'2026-11-08T10:00:05Z',markdown:[
  {type:'start',tag:'p'},{type:'text',text:'It needs 16px on phones.'},{type:'end'},
  {type:'start',tag:'h3'},{type:'text',text:'Details'},{type:'end'}]},
];
const page_html=`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/conversation.css"><style>body{margin:0}#terminals{position:relative;height:100dvh}</style><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation-media.js"></script><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',pane:1,title:'Fix',agent:'claude',state:'ready',since:Math.floor(Date.now()/1000)-65,chatId:'chat-1',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal(){}});</script>`;

async function open(browser,options){
 const context=await browser.newContext(options),page=await context.newPage();page.setDefaultTimeout(5000);
 await page.addInitScript(()=>localStorage.setItem('switchboard-view-mode','conversation'));
 await page.route('http://text.test/**',route=>{
  const p=new URL(route.request().url()).pathname;
  if(p==='/')return route.fulfill({contentType:'text/html',body:page_html});
  if(p.startsWith('/api/chats/')&&!p.endsWith('/stream'))return route.fulfill({json:{messages,start_cursor:0,next_cursor:null}});
  if(p.startsWith('/api/'))return route.fulfill({status:404,body:''});
  return route.fulfill({path:path.join(__dirname,'static',path.basename(p)),contentType:p.endsWith('.css')?'text/css':'text/javascript'});
 });
 await page.goto('http://text.test/');await page.locator('.conversation-message.assistant p').waitFor();
 return page;
}
const size=(page,selector)=>page.locator(selector).first().evaluate(node=>getComputedStyle(node).fontSize);

test('Conversation messages match the composer on phones and keep the compact size on desktop',
 {skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 try{
  const phone=await open(browser,{viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  assert.equal(await size(phone,'.conversation-compose textarea'),'16px');
  assert.equal(await size(phone,'.conversation-message.user'),'16px');
  assert.equal(await size(phone,'.conversation-message.assistant p'),'16px');
  assert.equal(await size(phone,'.conversation-message.assistant h3'),'16px');
  const desktop=await open(browser,{viewport:{width:1280,height:900}});
  assert.equal(await size(desktop,'.conversation-compose textarea'),'14px');
  assert.equal(await size(desktop,'.conversation-message.user'),'14px');
  assert.equal(await size(desktop,'.conversation-message.assistant p'),'14px');
 }finally{await browser.close();}
});
