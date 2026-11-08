const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),fs=require('node:fs');
// Uses a real server: only a real connection shows whether a refresh cancels the send.
const fixture=(agent,chatId)=>`<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/conversation.css"><main id="terminals"><iframe id="terminal"></iframe><section id="artifact-preview" hidden></section></main><script src="/conversation.js"></script><script>window.current={key:'pane1',host:'fixture',session:'main',tab:1,pane:1,agent:'${agent}',state:'ready',chatId:'${chatId}',frame:document.getElementById('terminal')};SwitchboardConversation.install({selection:()=>current,terminal:()=>{}});</script>`;
for(const [agent,endpoint] of [['claude','/conversation/reply'],['codex','/codex/reply']])
test(`a ${agent} reply still reaches the relay when the page refreshes right after sending`,{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 let received,answered;const arrived=new Promise(resolve=>received=resolve),finished=new Promise(resolve=>answered=resolve);
 const server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://fixture');
  if(url.pathname.endsWith(endpoint)){
   let body='';request.on('data',chunk=>body+=chunk);
   request.on('end',()=>{received(JSON.parse(body));
    // The relay is still typing the reply when the old page goes away.
    const dropped=()=>answered(false);response.once('close',dropped);
    setTimeout(()=>{response.off('close',dropped);response.end(JSON.stringify({ok:true,status:'queued'}));answered(true);},700);});
   return;
  }
  if(url.pathname.startsWith('/api/chats/')){response.setHeader('Content-Type','application/json');return response.end(JSON.stringify({session_id:'00000000-0000-4000-8000-000000000001',messages:[{role:'assistant',text:'Earlier answer'}],start_cursor:0,next_cursor:null}));}
  if(url.pathname.startsWith('/api/')){response.statusCode=204;return response.end();}
  if(url.pathname==='/'){response.setHeader('Content-Type','text/html');return response.end(fixture(agent,agent+'-chat'));}
  const file=path.join(__dirname,'static',path.basename(url.pathname));
  if(!fs.existsSync(file)){response.statusCode=404;return response.end();}
  response.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':'application/javascript');response.end(fs.readFileSync(file));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.getByText('Earlier answer',{exact:true}).waitFor();
  await page.getByLabel('Reply draft').fill('Sent just before refreshing');await page.getByRole('button',{name:'Send',exact:true}).click();
  const delivered=await arrived;assert.match(delivered.text??delivered.message,/Sent just before refreshing/);
  await page.reload();
  assert.equal(await finished,true,'Refreshing must not cancel a reply the relay is still delivering');
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
