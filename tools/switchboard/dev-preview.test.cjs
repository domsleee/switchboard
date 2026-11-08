const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path');
const {start}=require('./dev-preview.cjs');

const get=(port,pathname)=>new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:pathname},res=>{let body='';res.on('data',d=>body+=d).on('end',()=>resolve({status:res.statusCode,type:res.headers['content-type'],body}));}).on('error',reject));

test('the sidebar preview serves the working copy, forwards the rest to the relay and announces saves',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'preview-'));
 fs.writeFileSync(path.join(dir,'index.html'),'<!doctype html><html><head><title>t</title></head><body>page</body></html>');
 fs.writeFileSync(path.join(dir,'app.css'),'body{}');
 const seen=[];
 const relay=http.createServer((req,res)=>{seen.push({url:req.url,host:req.headers.host,origin:req.headers.origin});
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
  // A saved stylesheet reaches open pages as a style-only update.
  const event=new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:'/__live'},res=>{res.setEncoding('utf8');res.on('data',chunk=>{const m=/data: (.*)\n/.exec(chunk);if(m){res.destroy();resolve(JSON.parse(m[1]));}});}).on('error',reject));
  await new Promise(r=>setTimeout(r,100));fs.writeFileSync(path.join(dir,'app.css'),'body{color:red}');
  assert.deepEqual(await event,{css:['app.css']});
 }finally{await new Promise(r=>preview.close(r));relay.close();fs.rmSync(dir,{recursive:true,force:true});}
});
