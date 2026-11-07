// Time Conversation -> Terminal against a real private session, relay and web client.
// Never attaches to a user's session. The sidebar under test is served from disk.
// Opt-in (not run in CI):
//   PLAYWRIGHT_MODULE=/path/to/playwright node tools/switchboard/terminal-swap.bench.cjs BINARY [options]
//   --rounds N      swaps to time in each scenario (default 5)
//   --latency MS    added browser network latency, like another computer on the mesh (default 0)
//   --static DIR    sidebar files to serve (default this checkout's tools/switchboard/static)
//   --scrollback N  lines printed into the measured terminal (default 5000)
// Scenarios:
//   connected     Terminal -> Conversation -> Terminal, the viewer having been shown already
//   after_reload  the sidebar reloads in Conversation (as after an update), then Terminal
// Headless Chromium renders WebGL in software, so absolute times run high; compare builds.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
if(!args[0]||args[0].startsWith('--')||!process.env.PLAYWRIGHT_MODULE){console.log('terminal-swap.bench.cjs: skipped (set PLAYWRIGHT_MODULE and pass BINARY)');return;}
const binary=path.resolve(args[0]),staticDir=path.resolve(option('static',path.join(__dirname,'static')));
const rounds=Number(option('rounds',5)),latency=Number(option('latency',0)),scrollback=Number(option('scrollback',5000));
const windows=process.platform==='win32',delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stats=values=>{const s=[...values].sort((a,b)=>a-b),q=p=>s[Math.min(s.length-1,Math.floor(p*s.length))];return s.length?{n:s.length,p50:Math.round(q(.5)),p95:Math.round(q(.95)),max:Math.round(s.at(-1))}:{n:0};};
const dir=fs.mkdtempSync(path.join(windows?os.tmpdir():'/tmp','sb-terminal-swap-'));
const installed=path.join(dir,windows?'zellij.exe':'zellij'),config=path.join(dir,'config.kdl');
const shell=windows?['cmd.exe']:['/bin/bash','--noprofile','--norc'];
const name='swap-'+crypto.randomBytes(6).toString('hex');
const env={...process.env,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color',ZELLIJ_CONFIG_FILE:config,HOME:dir};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR'])delete env[key];
const cli=(...a)=>execFileSync(installed,['--config',config,...a],{env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
const kdl=s=>JSON.stringify(s.replace(/\\/g,'/'));
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const p=server.address().port;await new Promise(resolve=>server.close(resolve));return p;}
async function until(check,message){for(let n=0;n<300;n++){try{if(await check())return;}catch{}await delay(100);}throw Error(message);}
async function stop(child){if(!child||child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([done,delay(3000)]);}
let native,relay,browser,tokenName,created=false,failed=false;
(async()=>{try{
  fs.copyFileSync(binary,installed);fs.chmodSync(installed,0o755);
  // Unshared-session recovery is UNIX-socket only, so the session is shared from the start.
  fs.writeFileSync(config,`web_sharing "on"\ndefault_shell ${kdl(shell[0])}\nshow_startup_tips false\nsession_serialization false\ndisable_session_metadata false\n`);
  if(windows)await new Promise((resolve,reject)=>spawn(installed,['--config',config,'attach','--create-background',name,'--',...shell],{env,detached:true,windowsHide:true,stdio:'ignore'}).on('exit',resolve).on('error',reject));
  else cli('attach','--create-background',name,'--',...shell);
  created=true;
  await until(()=>JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).some(p=>!p.is_plugin),'Private terminal did not start');
  const filler=windows?['cmd.exe','/k',`for /l %i in (1,1,${scrollback}) do @echo swap scrollback line %i`]:['/bin/bash','--noprofile','--norc','-c',`seq 1 ${scrollback} | sed 's/^/swap scrollback line /'; exec sleep 86400`];
  cli('-s',name,'action','new-tab','--name','Output','--',...filler);
  let measured;
  await until(()=>{measured=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin).at(-1);return measured&&JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin).length===2;},'Output tab did not start');
  const tokenLine=cli('web','--create-token').split('\n').find(line=>line.includes(': '));tokenName=tokenLine.split(': ')[0];
  const token=path.join(dir,'token');fs.writeFileSync(token,tokenLine.slice(tokenName.length+2).trim(),{mode:0o600});
  const nativePort=await port(),relayPort=await port(),url='http://127.0.0.1:'+relayPort;
  const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify({hosts:[{id:'fixture',name:'Private fixture',url:'http://127.0.0.1:'+nativePort,token_file:token,zellij_binary:installed}]}),{mode:0o600});
  const log=file=>fs.openSync(path.join(dir,file),'a');
  native=spawn(installed,['--config',config,'web','--port',String(nativePort)],{env,stdio:['ignore',log('native.log'),log('native-error.log')]});
  relay=spawn(installed,['serve','--host-config',hosts,'--port',String(relayPort)],{env,stdio:['ignore',log('relay.log'),log('relay-error.log')]});
  await until(async()=>(await (await fetch(url+'/api/hosts/fixture')).json()).sessions?.some(s=>s.name===name&&s.web_clients_allowed),'Private session did not appear through the relay');
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});page.setDefaultTimeout(30000);
  if(latency){const cdp=await page.context().newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency,downloadThroughput:-1,uploadThroughput:-1});}
  const loads=[];
  await page.route(url+'/**',route=>{
    const p=new URL(route.request().url()).pathname;
    if(p.startsWith('/hosts/')&&route.request().resourceType()==='document')loads.push(p);
    if(p.startsWith('/api/')||p.startsWith('/hosts/')||p.startsWith('/ws'))return route.continue();
    const file=path.join(staticDir,p==='/'?'index.html':p.slice(1));
    if(!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
    return route.fulfill({path:file,contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.json')||p.endsWith('.webmanifest')?'application/json':'text/html'});
  });
  // Typing reaches the measured terminal: it is shown, not inert, focused, and its focus is confirmed.
  const ready=`(()=>{const f=document.querySelector('#terminals>iframe.active'),w=f?.contentWindow;return !!(f&&getComputedStyle(f).display!=='none'&&!f.inert&&w?.term&&!w.term.options.disableStdin&&f.contentDocument?.activeElement===w.term.textarea&&[...sessions.values()].every(e=>!e.needsFocus&&!e.focusPending&&!e.suspended&&e.state));})()`;
  const swap=async label=>{await page.evaluate(label=>{window.benchStart=performance.now();[...document.querySelectorAll('.conversation-modes button')].find(b=>b.textContent===label).click();},label);};
  const toTerminal=async()=>{const before=loads.length;await swap('Terminal');await page.waitForFunction(ready,null,{polling:'raf'});return {ms:await page.evaluate(()=>performance.now()-benchStart),reloaded:loads.length>before};};
  const target=url+'/?host=fixture&session='+name+'&tab='+measured.tab_id;
  await page.addInitScript(()=>{try{if(!sessionStorage.getItem('bench-conversation'))localStorage.setItem('switchboard-view-mode','terminal');}catch{}});
  await page.goto(target);await page.waitForFunction(ready);await delay(1000);
  const results={connected:[],after_reload:[]};
  for(let n=0;n<rounds;n++){await swap('Conversation');await delay(1500);results.connected.push(await toTerminal());}
  for(let n=0;n<rounds;n++){
    await page.evaluate(()=>{sessionStorage.setItem('bench-conversation','1');localStorage.setItem('switchboard-view-mode','conversation');});
    await page.reload();await page.locator('.conversation-panel:not([hidden])').waitFor();await delay(3000);
    results.after_reload.push(await toTerminal());
  }
  const summary=Object.fromEntries(Object.entries(results).map(([scenario,runs])=>[scenario,{ms:stats(runs.map(r=>r.ms)),terminal_reloads:runs.filter(r=>r.reloaded).length}]));
  console.log(JSON.stringify({platform:process.platform,latency_ms:latency,scrollback,host_version:(await (await fetch(url+'/api/hosts/fixture')).json()).version,...summary},null,2));
}catch(error){failed=true;console.error('Private fixture logs:',dir);throw error;}
finally{if(browser)await browser.close();if(created)try{cli('kill-session',name);}catch{}await stop(relay);await stop(native);if(tokenName)try{cli('web','--revoke-token',tokenName);}catch{}if(!failed)try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:500});}catch{}}
})().catch(error=>{console.error(error);process.exitCode=1;});
