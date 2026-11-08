const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path');
const {start,access}=require('./dev-preview.cjs');

const get=(port,pathname)=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:pathname},res=>{let body='';res.on('data',d=>body+=d).on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],body}));}).on('error',reject));

test('the sidebar preview serves the working copy, forwards the rest to the relay and announces saves',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preview-'));
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><head><title>t</title></head><body>page</body></html>');
 fs.writeFileSync(path.join(dir,'app.css'),'body{}');
 const seen=[];
 const relay=http.createServer((req,res)=>{seen.push({url:req.url,host:req.headers.host,origin:req.headers.origin});
  if(req.url==='/api/chats/c/stream'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: 1\n\n');return setTimeout(()=>res.socket.destroy(),50);}
  res.setHeader('content-type','application/json');res.end(req.url==='/api/health'?'{"commit":"abc1234"}':'{"relay":true}');});
 await new Promise(r=>relay.listen(0,'127.0.0.1',r));
 const preview=await start({port:0,relayPort:relay.address().port,staticDir:dir,allow:[]},()=>{});
 const port=preview.address().port;
 try{
  assert.equal(preview.address().address,'127.0.0.1','Loopback only without --allow');
  const page=await get(port,'/');
  assert.match(page.body,/<meta name="switchboard-build" content="abc1234">/);
  assert.match(page.body,/EventSource\('\/__live'\)/);
  assert.equal((await get(port,'/app.css')).body,'body{}');
  const api=await new Promise((resolve,reject)=>http.request({host:'127.0.0.1',port,path:'/api/attention',headers:{origin:'http://192.0.2.1:8199'}},res=>{let b='';res.on('data',d=>b+=d).on('end',()=>resolve(b));}).on('error',reject).end());
  assert.equal(api,'{"relay":true}');
  const forwarded=seen.find(r=>r.url==='/api/attention');
  assert.equal(forwarded.host,`127.0.0.1:${relay.address().port}`);assert.equal(forwarded.origin,`http://127.0.0.1:${relay.address().port}`);
  // A relay restart cutting a stream ends the browser's copy, so it can reconnect.
  const ended=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(false),3000);
   http.get({host:'127.0.0.1',port,path:'/api/chats/c/stream'},res=>{res.resume();res.on('close',()=>{clearTimeout(timer);resolve(true);});}).on('error',()=>{clearTimeout(timer);resolve(true);});});
  assert.equal(ended,true);
  // A saved stylesheet reaches open pages as a style-only update.
  const event=new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/__live'},res=>{res.setEncoding('utf8');res.on('data',chunk=>{for(const m of chunk.matchAll(/data: (.*)\n/g)){const data=JSON.parse(m[1]);if(data.css){res.destroy();resolve(data);}}});}).on('error',reject));
  await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(dir,'app.css'),'body{color:red}');
  assert.deepEqual((await event).css,['app.css']);
 }finally{await new Promise(r=>preview.close(r));relay.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a script or page change offers a Reload button instead of reloading the open conversation',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preview-'));
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><head></head><body>page</body></html>');
 const preview=await start({port:0,relayPort:1,staticDir:dir,allow:[]},()=>{});
 try{
  const body=(await get(preview.address().port,'/')).body,script=/<script>([\s\S]*)<\/script>/.exec(body)[1];
  let source=null,reloads=0;const appended=[];
  const context={EventSource:class{constructor(){source=this;}},location:{reload(){reloads++;}},URL,Date,JSON,
   document:{querySelectorAll:()=>[],createElement:()=>({style:{}}),addEventListener(){},documentElement:{append:node=>appended.push(node)}}};
  require('node:vm').runInNewContext(script,context);
  const loaded=/let seen="([0-9a-f]+)"/.exec(script)[1];
  source.onmessage({data:JSON.stringify({css:null,version:loaded})});assert.equal(appended.length,0,'Connecting to unchanged files offers nothing');
  source.onmessage({data:'{"css":null,"version":"changed"}'});source.onmessage({data:'{"css":null,"version":"again"}'});
  assert.equal(reloads,0,'The page keeps its state until the viewer reloads');
  assert.equal(appended.length,1,'One button however many changes arrive');
  assert.match(appended[0].textContent,/Reload/);
  appended[0].onclick();assert.equal(reloads,1);
 }finally{await new Promise(r=>preview.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('only this computer, listed addresses and holders of the token get in',()=>{
 const allowed=new Set(['127.0.0.1','::1','192.0.2.5']),token='0123456789abcdef0123';
 assert.equal(access({address:'::ffff:127.0.0.1'},{allowed,token:null}),'allow');
 assert.equal(access({address:'192.0.2.5'},{allowed,token:null}),'allow');
 assert.equal(access({address:'192.0.2.9',query:token},{allowed,token:null}),'deny','No token configured');
 assert.equal(access({address:'192.0.2.9'},{allowed,token}),'deny');
 assert.equal(access({address:'192.0.2.9',query:'wrong'},{allowed,token}),'deny');
 assert.equal(access({address:'192.0.2.9',query:token},{allowed,token}),'grant');
 assert.equal(access({address:'192.0.2.9',cookie:`other=1; switchboard_preview=${token}`},{allowed,token}),'allow');
 assert.equal(access({address:'192.0.2.9',cookie:'switchboard_preview=0123456789abcdef0124'},{allowed,token}),'deny');
});

test('a real browser shows the Reload button at the top, including after missing a change while disconnected',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preview-'));
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main style="position:fixed;inset:0;z-index:1000;background:#111"><textarea aria-label="Reply draft"></textarea></main></body></html>');
 fs.writeFileSync(path.join(dir,'app.js'),'1');
 let preview=await start({port:0,relayPort:1,staticDir:dir,allow:[]},()=>{});const port=preview.address().port;
 try{
  for(const viewport of [{width:390,height:844},{width:1280,height:800}]){
   const page=await browser.newPage({viewport});page.setDefaultTimeout(5000);let reloaded=0;
   await page.goto(`http://127.0.0.1:${port}/`);page.on('load',()=>reloaded++);
   await page.getByLabel('Reply draft').fill('half-typed');
   await page.waitForFunction(()=>document.readyState==='complete');await new Promise(r=>setTimeout(r,300));
   fs.writeFileSync(path.join(dir,'app.js'),String(Date.now()));
   const button=page.getByRole('button',{name:'Preview updated · Reload'});await button.waitFor();
   const box=await button.boundingBox();assert.ok(box.y<40,'At the top');assert.ok(Math.abs(box.x+box.width/2-viewport.width/2)<2,'Centred');
   assert.equal(await page.evaluate(()=>{const b=document.getElementById('preview-reload').getBoundingClientRect();return document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.id;}),'preview-reload','Not covered by the page');
   assert.equal(reloaded,0);assert.equal(await page.getByLabel('Reply draft').inputValue(),'half-typed');
   if(process.env.PREVIEW_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PREVIEW_SCREENSHOTS,`reload-${viewport.width}.png`)});
   await page.close();
  }
  // A page that was disconnected when the change landed offers the button once it reconnects.
  const page=await browser.newPage();page.setDefaultTimeout(8000);await page.goto(`http://127.0.0.1:${port}/`);
  await new Promise(r=>setTimeout(r,300));await new Promise(r=>preview.close(r));preview=null;
  await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(dir,'app.js'),'missed');
  preview=await start({port,relayPort:1,staticDir:dir,allow:[]},()=>{});
  await page.getByRole('button',{name:'Preview updated · Reload'}).waitFor();
 }finally{if(preview)await new Promise(r=>preview.close(r));await browser.close();fs.rmSync(dir,{recursive:true,force:true});}
});
