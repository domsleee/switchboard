#!/usr/bin/env node
// Live preview of sidebar changes against real data, without building the relay.
//
// Serves index.html, CSS and JS from a working copy, and forwards everything else
// (API calls, terminal pages and their WebSockets) to this computer's running relay,
// so the page shows the real tabs and chats. Saving a CSS file swaps the styles in
// place; saving anything else offers a Reload button, so an open conversation, its
// draft and its scroll position stay until you choose to reload. A page that was asleep
// or offline when the change landed offers the button when it reconnects.
//
//   node tools/switchboard/dev-preview.cjs [--port 8199] [--relay 8090] [--static DIR]
//        [--allow IP,IP] [--token-file FILE]
//
// It listens on loopback only unless --allow or --token-file is given. --allow names
// other computers' addresses. --token-file holds a secret: a device that opens
// /?token=SECRET once gets a cookie and can then use the preview from any address.
// Allowed devices get full terminal control over plain HTTP, so use this only on
// networks you trust.
const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');

function options(argv){
 const value=name=>{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;};
 const allow=(value('--allow')||'').split(',').map(s=>s.trim()).filter(Boolean);
 const tokenFile=value('--token-file'),token=tokenFile?fs.readFileSync(tokenFile,'utf8').trim():null;
 if(tokenFile&&token.length<16)throw Error(`${tokenFile} must hold a secret of at least 16 characters`);
 return {port:Number(value('--port')||8199),relayPort:Number(value('--relay')||8090),
  staticDir:path.resolve(value('--static')||path.join(__dirname,'static')),allow,token};
}

const cookieName='switchboard_preview';
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const cookies=header=>(header||'').split(';').map(part=>part.trim()).filter(Boolean);
// 'allow' serves the request, 'grant' sets the cookie for a correct ?token=, 'deny' refuses.
function access({address,cookie,query},{allowed,token}){
 if(allowed.has(String(address).replace(/^::ffff:/,'')))return 'allow';
 if(!token)return 'deny';
 const presented=cookies(cookie).find(part=>part.startsWith(cookieName+'='))?.slice(cookieName.length+1);
 if(presented&&same(presented,token))return 'allow';
 return query&&same(query,token)?'grant':'deny';
}

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8',
 '.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};
// Identifies the served files, so a page can tell it missed a change while disconnected,
// including across a restart of this server.
function version(dir){
 const hash=crypto.createHash('sha1');
 for(const name of fs.readdirSync(dir).sort()){try{const stat=fs.statSync(path.join(dir,name));if(stat.isFile())hash.update(`${name}\0${stat.size}\0${stat.mtimeMs}\n`);}catch{}}
 hash.update(dir);return hash.digest('hex').slice(0,16);
}
// Swaps only the changed stylesheets. Any other change shows a Reload button instead of
// reloading, because a reload drops the open conversation, its draft and scroll position.
const client=loaded=>`<script>(()=>{let seen=${JSON.stringify(loaded)},prompt=null,es=null;
 const offer=()=>{if(prompt)return;prompt=document.createElement('button');prompt.id='preview-reload';prompt.type='button';
  prompt.textContent='Preview updated · Reload';prompt.title='Sidebar code changed. Reload to run it.';
  prompt.style.cssText='position:fixed;left:50%;top:max(8px,env(safe-area-inset-top));transform:translateX(-50%);z-index:2147483647;padding:8px 14px;border:1px solid #5689cc;border-radius:6px;background:#182c47;color:#fff;font:14px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px #0008';
  prompt.onclick=()=>location.reload();document.documentElement.append(prompt);};
 const swap=css=>{for(const link of document.querySelectorAll('link[rel=stylesheet]')){const u=new URL(link.href);
  if(css.includes(u.pathname.slice(1))){u.searchParams.set('v',Date.now());const next=link.cloneNode();next.href=u.href;next.onload=()=>link.remove();link.after(next);}}};
 const connect=()=>{es=new EventSource('/__live');es.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.css&&!prompt){swap(m.css);seen=m.version;return;}
  if(m.version!==seen)offer();};};
 connect();document.addEventListener('visibilitychange',()=>{if(!document.hidden&&es.readyState===EventSource.CLOSED)connect();});
})();</script>`;

function start({port,relayPort,staticDir,allow=[],token=null},log=console.log){
 const relay={host:'127.0.0.1',port:relayPort},allowed=new Set(['127.0.0.1','::1',...allow]),clients=new Set();
 let timer=null;const changed=new Set();
 const watcher=fs.watch(staticDir,(event,name)=>{if(!name)return;changed.add(name);clearTimeout(timer);timer=setTimeout(()=>{
  const names=[...changed];changed.clear();const css=names.every(n=>n.endsWith('.css'))?names:null,current=version(staticDir);
  for(const res of clients)res.write(`data: ${JSON.stringify({css,version:current})}\n\n`);
  log(new Date().toLocaleTimeString(),css?'css':'reload',names.join(' '));},120);});
 // The relay only answers requests addressed to itself, and never sees the preview's own cookie.
 const relayHeaders=req=>{const headers={...req.headers,host:`${relay.host}:${relay.port}`};
  for(const h of Object.keys(headers))if(h==='referer'||h.startsWith('sec-fetch-'))delete headers[h];
  if(headers.cookie){const rest=cookies(headers.cookie).filter(part=>!part.startsWith(cookieName+'='));if(rest.length)headers.cookie=rest.join('; ');else delete headers.cookie;}
  if(headers.origin)headers.origin=`http://${relay.host}:${relay.port}`;return headers;};
 const forward=(req,res)=>{
  // A relay restart cuts streams mid-response; end the browser's copy so it reconnects.
  const out=http.request({...relay,method:req.method,path:req.url,headers:relayHeaders(req)},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);
   up.on('aborted',()=>res.destroy());up.on('error',()=>res.destroy());});
  out.on('error',e=>{if(!res.headersSent)res.writeHead(502);res.end('Relay unavailable: '+e.message);});res.on('close',()=>out.destroy());req.pipe(out);};
 // The page reloads itself when its build stamp differs from the relay's, so stamp it with the relay's.
 const relayCommit=()=>new Promise(resolve=>{const request=http.get({...relay,path:'/api/health',headers:{host:`${relay.host}:${relay.port}`},timeout:3000},up=>{let s='';
  up.on('data',d=>s+=d).on('end',()=>{try{resolve(JSON.parse(s).commit)}catch{resolve(null)}});});request.on('timeout',()=>request.destroy());request.on('error',()=>resolve(null));});
 const check=(req,url)=>access({address:req.socket.remoteAddress,cookie:req.headers.cookie,query:url?.searchParams.get('token')},{allowed,token});
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://preview'),decision=check(req,url);
  if(decision==='grant'){url.searchParams.delete('token');
   res.writeHead(302,{'set-cookie':`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,location:url.pathname+url.search,'cache-control':'no-store'});return res.end();}
  if(decision==='deny'){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'});return res.end('Not allowed. Open the preview with its link, which ends in ?token=…');}
  if(url.pathname==='/__live'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
   res.write(`retry: 3000\ndata: ${JSON.stringify({css:null,version:version(staticDir)})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if((req.method==='GET'||req.method==='HEAD')&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/hosts/')){
   const name=url.pathname==='/'?'index.html':path.basename(url.pathname),file=path.join(staticDir,name);
   if(fs.existsSync(file)&&fs.statSync(file).isFile()){
    res.setHeader('cache-control','no-store');res.setHeader('content-type',types[path.extname(name)]||'application/octet-stream');
    if(!name.endsWith('.html'))return res.end(fs.readFileSync(file));
    const loaded=version(staticDir),commit=await relayCommit();let html=fs.readFileSync(file,'utf8');
    if(commit)html=html.replace('<head>',()=>`<head><meta name="switchboard-build" content="${commit}">`);
    return res.end(html.includes('</body>')?html.replace('</body>',()=>client(loaded)+'</body>'):html+client(loaded));
   }
  }
  forward(req,res);
 });
 server.on('upgrade',(req,socket,head)=>{
  if(check(req)!=='allow')return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  const up=net.connect(relay.port,relay.host,()=>{
   up.write(`${req.method} ${req.url} HTTP/1.1\r\n`+Object.entries(relayHeaders(req)).map(([k,v])=>`${k}: ${v}`).join('\r\n')+'\r\n\r\n');
   if(head?.length)up.write(head);up.pipe(socket);socket.pipe(up);});
  up.setNoDelay(true);socket.setNoDelay(true);
  const close=()=>{up.destroy();socket.destroy();};for(const s of [up,socket]){s.on('error',close);s.on('close',close);}
 });
 // Open pages hold a live connection, so closing ends them instead of waiting for them.
 const close=server.close.bind(server);
 server.close=done=>{watcher.close();clearTimeout(timer);for(const res of clients)res.end();clients.clear();close(done);server.closeAllConnections();return server;};
 return new Promise(resolve=>server.listen(port,allow.length||token?'0.0.0.0':'127.0.0.1',()=>{
  log(`Sidebar preview on http://127.0.0.1:${server.address().port}/ from ${staticDir}; relay port ${relay.port}; allowed: ${[...allowed].join(', ')}${token?'; other devices with the token link':''}`);
  resolve(server);}));
}

module.exports={start,options,access};
if(require.main===module)start(options(process.argv.slice(2)));
