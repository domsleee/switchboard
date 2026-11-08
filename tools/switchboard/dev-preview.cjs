#!/usr/bin/env node
// Live preview of sidebar changes against real data, without building the relay.
//
// Serves index.html, CSS and JS from a working copy, and forwards everything else
// (API calls, terminal pages and their WebSockets) to this computer's running relay,
// so the page shows the real tabs and chats. Saving a CSS file swaps the styles in
// place; saving anything else reloads the page.
//
//   node tools/switchboard/dev-preview.cjs [--port 8199] [--relay 8090] [--static DIR] [--allow IP,IP]
//
// It listens on loopback only unless --allow names other computers' addresses. Those
// addresses get full terminal control over plain HTTP, so allow only your own devices
// on a network you trust.
const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');

function options(argv){
 const value=name=>{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;};
 const allow=(value('--allow')||'').split(',').map(s=>s.trim()).filter(Boolean);
 return {port:Number(value('--port')||8199),relayPort:Number(value('--relay')||8090),
  staticDir:path.resolve(value('--static')||path.join(__dirname,'static')),allow};
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8',
 '.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};
// Reloads the page on a change, or swaps only the changed stylesheets.
const client=`<script>(()=>{const es=new EventSource('/__live');es.onmessage=e=>{const m=JSON.parse(e.data);
 if(!m.css)return location.reload();for(const link of document.querySelectorAll('link[rel=stylesheet]')){const u=new URL(link.href);
 if(m.css.includes(u.pathname.slice(1))){u.searchParams.set('v',Date.now());const next=link.cloneNode();next.href=u.href;next.onload=()=>link.remove();link.after(next);}}};})();</script>`;

function start({port,relayPort,staticDir,allow},log=console.log){
 const relay={host:'127.0.0.1',port:relayPort},allowed=new Set(['127.0.0.1','::1',...allow]),clients=new Set();
 let timer=null;const changed=new Set();
 const watcher=fs.watch(staticDir,(event,name)=>{if(!name)return;changed.add(name);clearTimeout(timer);timer=setTimeout(()=>{
  const names=[...changed];changed.clear();const css=names.every(n=>n.endsWith('.css'))?names:null;
  for(const res of clients)res.write(`data: ${JSON.stringify({css})}\n\n`);
  log(new Date().toLocaleTimeString(),css?'css':'reload',names.join(' '));},120);});
 // The relay only answers requests addressed to itself.
 const relayHeaders=req=>{const headers={...req.headers,host:`${relay.host}:${relay.port}`};
  for(const h of Object.keys(headers))if(h==='referer'||h.startsWith('sec-fetch-'))delete headers[h];
  if(headers.origin)headers.origin=`http://${relay.host}:${relay.port}`;return headers;};
 const forward=(req,res)=>{
  const out=http.request({...relay,method:req.method,path:req.url,headers:relayHeaders(req)},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
  out.on('error',e=>{if(!res.headersSent)res.writeHead(502);res.end('Relay unavailable: '+e.message);});res.on('close',()=>out.destroy());req.pipe(out);};
 // The page reloads itself when its build stamp differs from the relay's, so stamp it with the relay's.
 const relayCommit=()=>new Promise(resolve=>http.get({...relay,path:'/api/health',headers:{host:`${relay.host}:${relay.port}`}},up=>{let s='';
  up.on('data',d=>s+=d).on('end',()=>{try{resolve(JSON.parse(s).commit)}catch{resolve(null)}});}).on('error',()=>resolve(null)));
 const permitted=req=>allowed.has(req.socket.remoteAddress.replace(/^::ffff:/,''));
 const server=http.createServer(async(req,res)=>{
  if(!permitted(req)){res.writeHead(403);return res.end('Not allowed from this address');}
  const url=new URL(req.url,'http://preview');
  if(url.pathname==='/__live'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write(':\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if((req.method==='GET'||req.method==='HEAD')&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/hosts/')){
   const name=url.pathname==='/'?'index.html':path.basename(url.pathname),file=path.join(staticDir,name);
   // The service worker would cache the working copy's files past the next save.
   if(name!=='sw.js'&&fs.existsSync(file)&&fs.statSync(file).isFile()){
    res.setHeader('cache-control','no-store');res.setHeader('content-type',types[path.extname(name)]||'application/octet-stream');
    if(!name.endsWith('.html'))return res.end(fs.readFileSync(file));
    const commit=await relayCommit();let html=fs.readFileSync(file,'utf8');
    if(commit)html=html.replace('<head>',()=>`<head><meta name="switchboard-build" content="${commit}">`);
    return res.end(html.includes('</body>')?html.replace('</body>',()=>client+'</body>'):html+client);
   }
  }
  forward(req,res);
 });
 server.on('upgrade',(req,socket,head)=>{
  if(!permitted(req))return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const up=net.connect(relay.port,relay.host,()=>{
   up.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries(relayHeaders(req)).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
   if(head?.length)up.write(head);up.pipe(socket);socket.pipe(up);});
  up.setNoDelay(true);socket.setNoDelay(true);
  const close=()=>{up.destroy();socket.destroy();};for(const s of [up,socket]){s.on('error',close);s.on('close',close);}
 });
 server.on('close',()=>{watcher.close();clearTimeout(timer);for(const res of clients)res.end();});
 return new Promise(resolve=>server.listen(port,allow.length?'0.0.0.0':'127.0.0.1',()=>{
  log(`Sidebar preview on http://127.0.0.1:${server.address().port}/ from ${staticDir}; relay port ${relay.port}; allowed: ${[...allowed].join(', ')}`);
  resolve(server);}));
}

module.exports={start,options};
if(require.main===module)start(options(process.argv.slice(2)));
