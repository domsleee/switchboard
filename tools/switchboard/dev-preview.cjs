#!/usr/bin/env node
// Live preview of sidebar changes against real data, without building the relay.
//
// Serves index.html, CSS and JS from a working copy, and forwards everything else
// (API calls, terminal pages and their WebSockets) to this computer's running relay,
// so the page shows the real tabs and chats. The sidebar shows which version the page
// is running. When the files change, the page offers "Update to … · Reload" instead of
// reloading, so an open conversation, its draft and its scroll position stay until you
// choose; a page that was asleep or offline offers it when it reconnects.
//
//   node tools/switchboard/dev-preview.cjs [--port 8199] [--relay 8090] [--static DIR]
//        [--allow IP,IP] [--token-file FILE] [--label NAME]
//
// --label names what is served (the preview service passes "main"); without it the
// working copy's branch is shown. It listens on loopback only unless --allow or
// --token-file is given. --allow names other computers' addresses. --token-file holds a
// secret: a device that opens /?token=SECRET once gets a cookie and can then use the
// preview from any address. Allowed devices get full terminal control over plain HTTP,
// so use this only on networks you trust.
const net=require('node:net'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');

function options(argv){
 const value=name=>{const i=argv.indexOf(name);return i>=0?argv[i+1]:undefined;};
 const allow=(value('--allow')||'').split(',').map(s=>s.trim()).filter(Boolean);
 const tokenFile=value('--token-file'),token=tokenFile?fs.readFileSync(tokenFile,'utf8').trim():null;
 if(tokenFile&&token.length<16)throw Error(`${tokenFile} must hold a secret of at least 16 characters`);
 return {port:Number(value('--port')||8199),relayPort:Number(value('--relay')||8090),
  staticDir:path.resolve(value('--static')||path.join(__dirname,'static')),allow,token,label:value('--label')||null};
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
// Fingerprints the served files' contents, so a page can tell what it is missing, including
// after it was disconnected or this server restarted. File hashes are reused until a file's
// size or modification time changes.
const fileHashes=new Map();
function version(dir){
 const hash=crypto.createHash('sha1');
 for(const name of fs.readdirSync(dir).sort()){
  try{const file=path.join(dir,name),stat=fs.statSync(file);if(!stat.isFile())continue;
   const stamp=`${stat.size}:${stat.mtimeMs}`;let entry=fileHashes.get(file);
   if(entry?.stamp!==stamp){entry={stamp,hash:crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')};fileHashes.set(file,entry);}
   hash.update(`${name}\0${entry.hash}\n`);}catch{}
 }
 return hash.digest('hex').slice(0,16);
}
const git=(dir,args)=>new Promise(resolve=>execFile('git',args,{cwd:dir,windowsHide:true,timeout:5000},(error,stdout)=>resolve(error?null:stdout.trim())));
// What the served files are: branch or label, commit, its title and PR, local edits to the
// served files, and how far the relay's own build trails it.
async function describe(dir,label,relayCommit){
 const [log,branch,status]=await Promise.all([git(dir,['log','-1','--format=%h%x1f%s%x1f%cI']),git(dir,['branch','--show-current']),git(dir,['status','--porcelain','--','.'])]);
 if(!log)return {label:label||'working copy',commit:null,subject:null,date:null,pr:null,edits:false,relay:relayCommit,behind:null};
 const [commit,subject,date]=log.split('\x1f'),pr=/\(#(\d+)\)\s*$/.exec(subject)?.[1]||null;
 let behind=null;
 if(relayCommit&&await git(dir,['merge-base','--is-ancestor',relayCommit,'HEAD'])!==null)behind=Number(await git(dir,['rev-list','--count',`${relayCommit}..HEAD`]));
 return {label:label||branch||'detached',commit,subject,date,pr,edits:!!status,relay:relayCommit,behind:Number.isFinite(behind)?behind:null};
}

// The sidebar label and the Reload offer. The page keeps what it loaded until the viewer reloads.
const client=loaded=>`<script>(()=>{const loaded=${JSON.stringify(loaded).replace(/</g,'\\u003c')};let shown=loaded.info,prompt=null,es=null,offline=false;
 const name=info=>[info.label,info.pr&&'#'+info.pr,info.commit].filter(Boolean).join(' · ')+(info.edits?' · local edits':'');
 const ago=date=>{const minutes=Math.round((Date.now()-new Date(date))/60000);return minutes<1?'just now':minutes<60?minutes+' min ago':minutes<1440?Math.round(minutes/60)+' h ago':Math.round(minutes/1440)+' d ago';};
 let box=null,details=null,inline=null,next=null;
 const offerText=info=>'Update to '+([info.pr&&'#'+info.pr,info.commit].filter(Boolean).join(' · ')||'the latest files')+' · Reload';
 const buttonStyle='padding:8px 14px;border:1px solid #5689cc;border-radius:6px;background:#182c47;color:#fff;font:14px system-ui,sans-serif;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
 const paint=()=>{const tools=document.getElementById('sidebar-tools');if(!tools)return;
  if(!box){box=document.createElement('div');box.id='preview-version';box.style.cssText='font:12px system-ui,sans-serif;color:#9aa4b2;margin:-2px 0 0;min-width:0';
   details=document.createElement('details');inline=document.createElement('button');inline.id='preview-reload-inline';inline.type='button';
   inline.style.cssText=buttonStyle+';display:none;width:100%;margin-top:6px;font-size:13px;padding:6px 10px';inline.onclick=()=>location.reload();box.append(details,inline);
   const brand=tools.querySelector('.sidebar-brand');if(brand)brand.after(box);else tools.prepend(box);}
  if(next){inline.style.display='block';inline.textContent=offerText(next);inline.title=next.subject||'';}
  const info=shown,lines=[];
  if(info.subject)lines.push(info.subject);if(info.date)lines.push('Committed '+ago(info.date));
  if(info.edits)lines.push('Includes saved edits that are not committed yet');
  if(info.relay)lines.push('Background service: '+info.relay+(info.behind?' · '+info.behind+' change'+(info.behind===1?'':'s')+' behind; changes that need it may still be pending':info.behind===0?' · up to date':' · updates separately'));
  if(offline)lines.push('Not connected to the preview, so updates are not being checked');
  const summary=document.createElement('summary');summary.style.cssText='cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  summary.textContent='Preview · '+name(info)+(offline?' · offline':'');summary.title=info.subject||'';
  details.replaceChildren(summary,...lines.map(text=>{const line=document.createElement('div');line.style.cssText='margin:4px 0 0 12px;overflow-wrap:anywhere';line.textContent=text;return line;}));};
 // The floating offer floats over the terminal or conversation. On phones it sits below the
 // top bar's menu button and Terminal/Conversation switch, and it steps aside while the
 // sidebar is on screen beneath it (the open drawer), whose own offer is then in view.
 const place=()=>{if(!prompt)return;prompt.style.top=innerWidth<=700?'calc(max(8px,env(safe-area-inset-top)) + 56px)':'max(8px,env(safe-area-inset-top))';
  prompt.style.display='';const sidebar=document.getElementById('sidebar');if(!sidebar||!next)return;
  const a=prompt.getBoundingClientRect(),b=sidebar.getBoundingClientRect(),x=Math.max(b.left,0)+10,y=Math.min(b.bottom,innerHeight)-10;
  const onScreen=b.width>0&&b.bottom>0&&b.right>0&&b.left<innerWidth&&b.top<innerHeight&&sidebar.contains(document.elementFromPoint(x,y));
  if(onScreen&&a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom)prompt.style.display='none';};
 const offer=info=>{next=info;if(!prompt){prompt=document.createElement('button');prompt.id='preview-reload';prompt.type='button';
   prompt.style.cssText=buttonStyle+';position:fixed;left:50%;top:max(8px,env(safe-area-inset-top));transform:translateX(-50%);z-index:2147483647;max-width:calc(100vw - 32px);box-shadow:0 2px 10px #0008';
   prompt.onclick=()=>location.reload();document.documentElement.append(prompt);addEventListener('resize',place);setInterval(place,500);}
  prompt.textContent=offerText(info);prompt.title=info.subject||'';};
 const receive=m=>{offline=false;if(m.version!==loaded.version)offer(m.info);else shown=m.info;paint();place();};
 const connect=()=>{es=new EventSource('/__live');es.onmessage=e=>receive(JSON.parse(e.data));es.onerror=()=>{if(!offline){offline=true;paint();}};};
 const resume=()=>{if(!document.hidden&&(!es||es.readyState===EventSource.CLOSED))connect();};
 connect();document.addEventListener('visibilitychange',resume);addEventListener('pageshow',resume);
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',paint);else paint();
})();</script>`;

function start({port,relayPort,staticDir,allow=[],token=null,label=null},log=console.log){
 const relay={host:'127.0.0.1',port:relayPort},allowed=new Set(['127.0.0.1','::1',...allow]),clients=new Set();
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
  up.on('data',d=>s+=d).on('end',()=>{try{resolve(JSON.parse(s).commit||null)}catch{resolve(null)}});});request.on('timeout',()=>request.destroy());request.on('error',()=>resolve(null));});
 // One shared description, refreshed after file changes and every 20 seconds (the branch can
 // move, or the relay update, without the served files changing).
 let current={version:version(staticDir),info:{label:label||'working copy'}},refreshing=null,again=false,closed=false;
 const refresh=()=>{if(refreshing){again=true;return refreshing;}
  refreshing=(async()=>{try{const next={version:version(staticDir),info:await describe(staticDir,label,await relayCommit())};
   if(!closed&&JSON.stringify(next)!==JSON.stringify(current)){current=next;for(const res of clients)res.write(`data: ${JSON.stringify(current)}\n\n`);}}catch{}
  })().finally(()=>{refreshing=null;if(again&&!closed){again=false;refresh();}});return refreshing;};
 const ready=refresh(),poll=setInterval(refresh,20000);
 let timer=null;const changed=new Set();
 const watcher=fs.watch(staticDir,(event,name)=>{if(!name)return;changed.add(name);clearTimeout(timer);timer=setTimeout(()=>{
  const names=[...changed];changed.clear();log(new Date().toLocaleTimeString(),'changed',names.join(' '));refresh();},120);});
 const check=(req,url)=>access({address:req.socket.remoteAddress,cookie:req.headers.cookie,query:url?.searchParams.get('token')},{allowed,token});
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://preview'),decision=check(req,url);
  if(decision==='grant'){url.searchParams.delete('token');
   res.writeHead(302,{'set-cookie':`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,location:url.pathname+url.search,'cache-control':'no-store'});return res.end();}
  if(decision==='deny'){res.writeHead(403,{'content-type':'text/plain; charset=utf-8'});return res.end('Not allowed. Open the preview with its link, which ends in ?token=…');}
  if(url.pathname==='/__live'){await ready;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
   res.write(`retry: 3000\ndata: ${JSON.stringify(current)}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return;}
  if((req.method==='GET'||req.method==='HEAD')&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/hosts/')){
   const name=url.pathname==='/'?'index.html':path.basename(url.pathname),file=path.join(staticDir,name);
   if(fs.existsSync(file)&&fs.statSync(file).isFile()){
    res.setHeader('cache-control','no-store');res.setHeader('content-type',types[path.extname(name)]||'application/octet-stream');
    if(!name.endsWith('.html'))return res.end(fs.readFileSync(file));
    await ready;const loaded={...current,version:version(staticDir)},commit=await relayCommit();let html=fs.readFileSync(file,'utf8');
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
 server.close=done=>{closed=true;watcher.close();clearTimeout(timer);clearInterval(poll);for(const res of clients)res.end();clients.clear();close(done);server.closeAllConnections();return server;};
 server.refresh=refresh;
 return new Promise(resolve=>server.listen(port,allow.length||token?'0.0.0.0':'127.0.0.1',()=>{
  log(`Sidebar preview on http://127.0.0.1:${server.address().port}/ from ${staticDir}; relay port ${relay.port}; allowed: ${[...allowed].join(', ')}${token?'; other devices with the token link':''}`);
  resolve(server);}));
}

module.exports={start,options,access,describe};
if(require.main===module)start(options(process.argv.slice(2)));
