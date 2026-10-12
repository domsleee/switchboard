// Keystroke echo latency in a private throwaway session; never types into user terminals.
// Opt-in (not run in CI): PLAYWRIGHT_MODULE=/path/to/playwright node latency.test.cjs BINARY [options]
//   --keys N          keystrokes to measure (default 60)
//   --gap MS          pause between keystrokes (default 120)
//   --hammer N        N extra loops replaying the attention scan's CLI calls back to back (default 0)
//   --tabs N          extra tabs, each holding --scrollback lines of output (default 4)
//   --scrollback N    lines printed into each extra tab (default 10000)
//   --cpu-load N      busy-loop N extra processes while measuring (default 0)
//   --tls             serve the engine over HTTPS with a pinned self-signed cert (needs openssl)
//   --max-p95 MS      fail when p95 echo latency exceeds MS
// Read-only probe of an existing session (times the relay's attention CLI calls, types nothing):
//   node latency.test.cjs BINARY --probe SESSION
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {execFileSync,execFile,spawn}=require('node:child_process');
const args=process.argv.slice(2);
const option=(name,fallback)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
if(!args[0]||args[0].startsWith('--')){console.log('latency.test.cjs: skipped (opt-in; pass BINARY)');return;}
const binary=path.resolve(args[0]);
const keys=Number(option('keys',60)),gap=Number(option('gap',120)),hammer=Number(option('hammer',0));
const tabs=Number(option('tabs',4)),scrollback=Number(option('scrollback',10000)),cpuLoad=Number(option('cpu-load',0));
const tls=args.includes('--tls'),maxP95=option('max-p95'),probe=option('probe');
const windows=process.platform==='win32';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stats=values=>{const s=[...values].sort((a,b)=>a-b),q=p=>s[Math.min(s.length-1,Math.floor(p*s.length))];return s.length?{n:s.length,p50:+q(0.5).toFixed(1),p95:+q(0.95).toFixed(1),max:+s[s.length-1].toFixed(1)}:{n:0};};
function timeCli(run,panes){
  const time=fn=>{const t=performance.now();fn();return performance.now()-t;};
  const list=[],dump=[];
  for(let n=0;n<5;n++){list.push(time(()=>run('list-panes','--json','--all')));for(const id of panes)dump.push(time(()=>run('dump-screen','-p',String(id))));}
  return {list_panes_ms:stats(list),dump_screen_ms:stats(dump),panes_dumped_per_scan:panes.length};
}
if(probe){
  const run=(...a)=>execFileSync(binary,['-s',probe,'action',...a],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
  const panes=JSON.parse(run('list-panes','--json','--all')).filter(p=>!p.is_plugin&&p.is_selectable!==false&&!p.exited).map(p=>p.id);
  console.log(JSON.stringify({probe,...timeCli(run,panes)},null,2));
  return;
}
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=fs.mkdtempSync(path.join(windows?os.tmpdir():'/tmp','sb-latency-'));
const installed=path.join(dir,windows?'zellij.exe':'zellij'),config=path.join(dir,'config.kdl');
const shell=windows?['cmd.exe']:['/bin/bash','--noprofile','--norc'];
const name='latency-'+crypto.randomBytes(6).toString('hex');
const env={...process.env,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color',ZELLIJ_CONFIG_FILE:config,HOME:dir};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR'])delete env[key];
const cli=(...a)=>execFileSync(installed,['--config',config,...a],{env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
const kdl=s=>JSON.stringify(s.replace(/\\/g,'/'));
async function port(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const p=server.address().port;await new Promise(resolve=>server.close(resolve));return p;}
async function until(check,message){for(let n=0;n<300;n++){try{if(await check())return;}catch{}await delay(100);}throw Error(message);}
async function stop(child){if(!child||child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await Promise.race([done,delay(3000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);}
let native,relay,browser,tokenName,created=false,failed=false;const burners=[];
(async()=>{
  try{
    fs.copyFileSync(binary,installed);fs.chmodSync(installed,0o755);
    let settings=`web_sharing "off"\ndefault_shell ${kdl(shell[0])}\nshow_startup_tips false\nsession_serialization false\ndisable_session_metadata false\n`;
    let fingerprint;
    if(tls){
      const cert=path.join(dir,'cert.pem'),key=path.join(dir,'key.pem');
      execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{stdio:'ignore'});
      fingerprint=new crypto.X509Certificate(fs.readFileSync(cert)).fingerprint256.replace(/:/g,'').toLowerCase();
      settings+=`web_server_cert ${kdl(cert)}\nweb_server_key ${kdl(key)}\n`;
    }
    fs.writeFileSync(config,settings);
    cli('attach','--create-background',name,'--',...shell);created=true;
    let first;
    await until(()=>{first=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>!p.is_plugin);return !!first;},'Private first terminal did not start');
    // Busy panes the attention scan must dump (not quiet shells), each with deep scrollback.
    const filler=windows?['cmd.exe','/k',`for /l %i in (1,1,${scrollback}) do @echo latency scrollback line %i`]:['/bin/bash','--noprofile','--norc','-c',`seq 1 ${scrollback} | sed 's/^/latency scrollback line /'; exec sleep 86400`];
    for(let n=0;n<tabs;n++)cli('-s',name,'action','new-tab','--name','Filler '+n,'--',...filler);
    await until(()=>JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin).length===tabs+1,'Filler tabs did not start');
    cli('-s',name,'action','go-to-tab','1');
    fs.writeFileSync(config,settings.replace('web_sharing "off"','web_sharing "on"'));
    const tokenLine=cli('web','--create-token').split('\n').find(line=>line.includes(': '));
    tokenName=tokenLine.split(': ')[0];
    const token=path.join(dir,'token');fs.writeFileSync(token,tokenLine.slice(tokenName.length+2).trim(),{mode:0o600});
    const nativePort=await port(),relayPort=await port(),url='http://127.0.0.1:'+relayPort;
    const host={id:'fixture',name:'Private fixture',url:(tls?'https':'http')+'://127.0.0.1:'+nativePort,token_file:token,zellij_binary:installed};
    if(fingerprint)host.tls_fingerprint=fingerprint;
    const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify({hosts:[host]}),{mode:0o600});
    const log=file=>fs.openSync(path.join(dir,file),'a');
    native=spawn(installed,['--config',config,'web','--port',String(nativePort)],{env:{...env,SWITCHBOARD_RECOVER_UNSHARED_SESSION:name},stdio:['ignore',log('native.log'),log('native-error.log')]});
    relay=spawn(installed,['serve','--host-config',hosts,'--port',String(relayPort)],{env,stdio:['ignore',log('relay.log'),log('relay-error.log')]});
    await until(async()=>{const data=await (await fetch(url+'/api/hosts/fixture')).json();return data.sessions?.some(s=>s.name===name&&s.web_clients_allowed);},'Private session did not appear through the relay');
    browser=await chromium.launch({headless:true});
    const page=await browser.newPage({viewport:{width:1200,height:800}});page.setDefaultTimeout(30000);
    await page.addInitScript(()=>{
      // Digit sent on the terminal socket -> first parsed frame whose cursor line shows it after the "> " prompt
      // (echo_ms); arrival_ms is when the last frame before that parse reached the socket.
      const Original=window.WebSocket;window.__latency=[];window.__arrival=[];window.__pending=[];window.__bytes=[];let typed='',hooked=false;window.__reset=()=>{typed='';window.__latency=[];window.__arrival=[];window.__pending=[];window.__bytes=[];};
      const check=()=>{const b=window.term.buffer.active,line=b.getLine(b.baseY+b.cursorY)?.translateToString(true)||'';
        while(window.__pending.length&&line.startsWith('> '+typed.slice(0,window.__pending[0].len))){const p=window.__pending.shift();window.__latency.push(performance.now()-p.t);window.__arrival.push(window.__lastArrival-p.t);}};
      window.WebSocket=class extends Original{
        constructor(...a){super(...a);if(String(a[0]).includes('/ws/terminal'))this.addEventListener('message',event=>window.__lastArrival=performance.now());this.addEventListener('message',event=>window.__bytes.push(event.data.length??event.data.size??event.data.byteLength));}
        send(data){if(String(this.url).includes('/ws/terminal')&&typeof data==='string'){
          if(!hooked&&window.term){hooked=true;window.term.onWriteParsed(check);}
          if(/^[0-9]$/.test(data)){typed+=data;window.__pending.push({len:typed.length,t:performance.now()});}else if(data==='\x15'||data==='\x1b')typed='';}
          return super.send(data);}
      };
    });
    await page.goto(url+'/?host=fixture&session='+name+'&tab='+first.tab_id);
    await page.waitForFunction(id=>{const f=document.querySelector('iframe.active'),w=f?.contentWindow;return w?.term&&!w.term.options.disableStdin&&f.contentDocument.activeElement===w.term.textarea&&w.__zjLastMobileState?.active_pane?.pane_id===id;},first.id);
    const frame=await (await page.$('iframe.active')).contentFrame();
    const prompt=windows?'prompt $G$S':'PS1="> "';
    await page.keyboard.type(prompt);await page.keyboard.press('Enter');await delay(500);
    for(let n=0;n<cpuLoad;n++)burners.push(spawn(process.execPath,['-e','for(;;){}'],{stdio:'ignore'}));
    const action=(...a)=>new Promise(resolve=>execFile(installed,['--config',config,'-s',name,'action',...a],{env,timeout:15000},resolve));
    const busy=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin).map(p=>p.id);
    let hammering=true,scans=0;
    const loops=Array.from({length:hammer},async()=>{while(hammering){await action('list-panes','--json','--all');for(const id of busy)await action('dump-screen','-p',String(id));scans++;}});
    await frame.evaluate(()=>window.__reset());
    const started=Date.now();
    for(let n=0;n<keys;n++){
      await page.keyboard.press(String(n%10));await delay(gap);
      if(n%30===29){await frame.waitForFunction(()=>!window.__pending.length,null,{timeout:15000}).catch(()=>{});await page.keyboard.press(windows?'Escape':'Control+U');await delay(300);}
    }
    await frame.waitForFunction(()=>!window.__pending.length,null,{timeout:15000}).catch(()=>{});
    hammering=false;await Promise.all(loops);
    const {latency,arrival,lost,bytes}=await frame.evaluate(()=>({latency:window.__latency,arrival:window.__arrival,lost:window.__pending.length,bytes:window.__bytes}));
    const result={kind:'disposable private terminal',platform:process.platform,tls,tabs,scrollback,cpu_load:cpuLoad,hammer,hammer_scans:scans,duration_s:(Date.now()-started)/1000,echo_ms:stats(latency),arrival_ms:stats(arrival),lost_echoes:lost,terminal_frame_bytes:stats(bytes)};
    // Per-call cost of what each attention scan spawns (one list-panes plus one dump-screen per busy pane).
    Object.assign(result,timeCli((...a)=>cli('-s',name,'action',...a),busy));
    console.log(JSON.stringify(result,null,2));
    if(maxP95&&!(result.echo_ms.p95<=Number(maxP95)))throw Error(`p95 echo ${result.echo_ms.p95} ms exceeds ${maxP95} ms`);
    if(lost)throw Error(lost+' keystrokes never echoed');
  }catch(error){failed=true;console.error('Private fixture logs:',dir);throw error;}
  finally{for(const b of burners)b.kill();if(browser)await browser.close();if(created)try{cli('kill-session',name);}catch{}await stop(relay);await stop(native);if(tokenName)try{cli('web','--revoke-token',tokenName);}catch{}if(!failed)fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
