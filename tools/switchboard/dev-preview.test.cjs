const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {start,access,describe}=require('./dev-preview.cjs');

const get=(port,pathname)=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:pathname},res=>{let body='';res.on('data',d=>body+=d).on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],body}));}).on('error',reject));
const run=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
// A repository whose static folder holds the given files, committed with the given title.
function repository(files,subject){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preview-repo-')),dir=path.join(root,'static');fs.mkdirSync(dir);
 run(root,'init','-q','-b','main');run(root,'config','user.email','t@example.com');run(root,'config','user.name','T');run(root,'config','commit.gpgsign','false');
 for(const [name,body] of Object.entries(files))fs.writeFileSync(path.join(dir,name),body);
 run(root,'add','-A');run(root,'commit','-q','-m',subject);return {root,dir};
}
const commit=(root,dir,name,body,subject)=>{fs.writeFileSync(path.join(dir,name),body);run(root,'add','-A');run(root,'commit','-q','-m',subject);return run(root,'rev-parse','--short','HEAD');};

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
  // A saved file reaches open pages as a new version.
  const versions=[],event=new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/__live'},res=>{res.setEncoding('utf8');
   res.on('data',chunk=>{for(const m of chunk.matchAll(/data: (.*)\n/g)){versions.push(JSON.parse(m[1]).version);if(versions.length===2){res.destroy();resolve();}}});}).on('error',reject));
  await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(dir,'app.css'),'body{color:red}');
  await event;assert.notEqual(versions[0],versions[1]);
 }finally{await new Promise(r=>preview.close(r));relay.close();fs.rmSync(dir,{recursive:true,force:true});}
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

test('the served version names its branch, commit, PR, local edits and how far the relay trails it',async()=>{
 const {root,dir}=repository({'app.js':'1'},'Start the sidebar (#10)');
 try{
  const relay=run(root,'rev-parse','HEAD'),sha=commit(root,dir,'app.js','2','Show the effort (#12)');
  const info=await describe(dir,null,relay);
  assert.deepEqual({...info,date:null},{label:'main',commit:sha,subject:'Show the effort (#12)',date:null,pr:'12',edits:false,relay,behind:1});
  assert.equal((await describe(dir,'latest',null)).label,'latest','A label replaces the branch name');
  fs.writeFileSync(path.join(root,'outside.txt'),'x');assert.equal((await describe(dir,null,null)).edits,false,'Edits outside the served files do not count');
  fs.writeFileSync(path.join(dir,'new.js'),'x');assert.equal((await describe(dir,null,null)).edits,true,'A new served file counts');
  assert.equal((await describe(dir,null,'0000000')).behind,null,'An unknown relay build is not called older');
  run(root,'checkout','-q','--detach');assert.equal((await describe(dir,null,null)).label,'detached');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a real browser shows what it is running and offers Reload for what is next, including after missing a change',{skip:!process.env.PLAYWRIGHT_MODULE},async()=>{
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE),browser=await chromium.launch();
 const {root,dir}=repository({'index.html':'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#111;color:#fff"><aside id="sidebar" style="width:200px;height:100vh"><div id="sidebar-tools"><div class="sidebar-brand"><strong>Switchboard</strong></div></div></aside><main style="position:fixed;left:200px;right:0;top:0;bottom:0;z-index:1000;background:#222"><textarea aria-label="Reply draft"></textarea></main></body></html>','app.js':'1'},'Start the sidebar (#10)');
 const first=run(root,'rev-parse','--short','HEAD');
 let preview=await start({port:0,relayPort:1,staticDir:dir,allow:[],label:'main'},()=>{});const port=preview.address().port;
 try{
  let latest=first;
  for(const [index,viewport] of [{width:390,height:844},{width:1280,height:800}].entries()){
   const page=await browser.newPage({viewport});page.setDefaultTimeout(8000);let reloaded=0;
   await page.goto(`http://127.0.0.1:${port}/`);page.on('load',()=>reloaded++);
   const label=page.locator('#preview-version summary');
   assert.equal(await label.textContent(),`Preview · main · #${10+index} · ${latest}`);
   await page.getByLabel('Reply draft').fill('half-typed');await new Promise(r=>setTimeout(r,300));
   const next=commit(root,dir,'app.js',String(index+2),`Change ${index} (#${11+index})`);
   const offer=`Update to #${11+index} · ${next} · Reload`,inline=page.locator('#preview-reload-inline'),floating=page.locator('#preview-reload');
   await inline.filter({hasText:offer}).waitFor();await page.waitForFunction(()=>document.getElementById('preview-reload'));await new Promise(r=>setTimeout(r,600));
   const uncovered=id=>page.evaluate(id=>{const b=document.getElementById(id).getBoundingClientRect();return document.getElementById(id).contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));},id);
   if(viewport.width<500){
    assert.equal(await floating.isVisible(),false,'Steps aside while the sidebar shows the offer');
    await page.evaluate(()=>document.querySelector('aside').style.display='none');await floating.waitFor();
   }
   assert.equal(await floating.textContent(),offer);const box=await floating.boundingBox();
   assert.ok(viewport.width<500?box.y>50&&box.y<90:box.y<40,"At the top, below a phone top bar");assert.ok(Math.abs(box.x+box.width/2-viewport.width/2)<2,'Centred');assert.equal(await uncovered('preview-reload'),true,'Not covered by the page');
   if(viewport.width<500)await page.evaluate(()=>document.querySelector('aside').style.display='');
   else assert.equal(await uncovered('preview-version'),true,'Leaves the label visible');
   assert.equal(await label.textContent(),`Preview · main · #${10+index} · ${latest}`,'The label keeps naming what this page runs');
   assert.equal(reloaded,0);assert.equal(await page.getByLabel('Reply draft').inputValue(),'half-typed');
   await label.click();await page.getByText(`Change ${index-1} (#${10+index})`).or(page.getByText('Start the sidebar (#10)')).first().waitFor();
   if(process.env.PREVIEW_SCREENSHOTS)await page.screenshot({path:path.join(process.env.PREVIEW_SCREENSHOTS,`version-${viewport.width}.png`)});
   await inline.click();await page.waitForFunction(()=>!document.getElementById('preview-reload'));
   assert.equal(await page.locator('#preview-version summary').textContent(),`Preview · main · #${11+index} · ${next}`);
   latest=next;await page.close();
  }
  // Saved but uncommitted edits are named, and a page that was disconnected when they
  // landed offers Reload once it reconnects.
  const page=await browser.newPage();page.setDefaultTimeout(8000);await page.goto(`http://127.0.0.1:${port}/`);
  await new Promise(r=>setTimeout(r,300));await new Promise(r=>preview.close(r));preview=null;
  await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(dir,'app.js'),'missed');
  preview=await start({port,relayPort:1,staticDir:dir,allow:[],label:'main'},()=>{});
  await page.locator('#preview-reload-inline',{hasText:`Update to #12 · ${latest} · Reload`}).click();
  await page.locator('#preview-version summary',{hasText:'local edits'}).waitFor();
 }finally{if(preview)await new Promise(r=>preview.close(r));await browser.close();fs.rmSync(root,{recursive:true,force:true});}
});
