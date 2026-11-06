// Real browser acceptance. Never attach to or restart the user's sessions.
// Usage: PLAYWRIGHT_MODULE=/path/to/playwright node update_browser.test.cjs [OLD_BINARY] [NEW_BINARY]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFileSync, spawn, spawnSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const newBinary = path.resolve(process.argv[3] || path.join(root, 'target/release/zellij'));
const oldBinary = path.resolve(process.argv[2] || newBinary);
const dir = fs.mkdtempSync(path.join(process.platform==='win32'?(process.env.RUNNER_TEMP||os.tmpdir()):'/tmp','sba-'));
const installed = path.join(dir,process.platform==='win32'?'zellij.exe':'zellij');
const config = path.join(dir, 'config.kdl');
const name = `update-acceptance-${crypto.randomBytes(8).toString('hex')}`;
const env = {...process.env, HOME:dir, USERPROFILE:dir, APPDATA:path.join(dir,'appdata'), LOCALAPPDATA:path.join(dir,'localappdata'), XDG_DATA_HOME:path.join(dir,'data'), XDG_CACHE_HOME:path.join(dir,'cache'), ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),
    SWITCHBOARD_ATTACHMENT_DIRECTORY:path.join(dir,'attachments'), SWITCHBOARD_RELEASES_DIR:path.join(dir,'releases'), SWITCHBOARD_VIEWER_LOCK:path.join(dir,'viewers.lock'), TERM:'xterm-256color'};
for (const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_FILE','ZELLIJ_CONFIG_DIR']) delete env[key];
env.ZELLIJ_CONFIG_FILE = config;
let cliSequence=0;
const cliWith = (binary,...args) => {
    const prefix=path.join(dir,`cli-${++cliSequence}`),out=fs.openSync(prefix+'.log','w'),err=fs.openSync(prefix+'-error.log','w');
    try {execFileSync(binary,['--config',config,...args],{env,windowsHide:true,timeout:15000,stdio:['ignore',out,err]});const result=fs.readFileSync(prefix+'.log','utf8');if(args.some(arg=>arg==='--create-token'||arg==='--create-read-only-token'))fs.writeFileSync(prefix+'.log','[credential output omitted]\n');return result;}
    finally {fs.closeSync(out);fs.closeSync(err);}
};
const cli=(...args)=>cliWith(installed,...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function availablePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function waitFor(check, message) {
    for(let n=0;n<150;n++) {try {if(await check()) return;} catch {} await sleep(100);}
    throw Error(message);
}
async function stop(child) {
    if(!child || child.exitCode !== null) return;
    const done = new Promise(resolve => child.once('exit',resolve));
    child.kill('SIGTERM');
    await Promise.race([done,sleep(5000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);
}
const identities = () => JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).map(p=>[p.is_plugin,p.id,p.tab_id]).sort();
const recoveryMode=process.env.SWITCHBOARD_TEST_RECOVERY==='1';
const createdTokens=[];
let native, relay, browser, updateController, created=false;
(async()=>{
 try {
  console.log('Private fixture:',dir);
  fs.writeFileSync(config,`web_sharing "${recoveryMode?'off':'on'}"\nshow_startup_tips false\nsession_serialization false\n`);
  fs.copyFileSync(oldBinary,installed);fs.chmodSync(installed,0o755);
  const tokenLine=cli('web','--create-token').split('\n').find(line=>line.includes(': '));
  createdTokens.push(tokenLine.slice(0,tokenLine.indexOf(': ')));
  const tokenPath=path.join(dir,'token');fs.writeFileSync(tokenPath,tokenLine.slice(tokenLine.indexOf(': ')+2).trim(),{mode:0o600});
  const nativePort=await availablePort(),relayPort=await availablePort(),url=`http://127.0.0.1:${relayPort}`;
  const relayConfig=path.join(dir,'hosts.json');
  fs.writeFileSync(relayConfig,JSON.stringify({hosts:[{id:'test',name:'Acceptance',url:`http://127.0.0.1:${nativePort}`,token_file:tokenPath,zellij_binary:installed}]}));
  const start=(args,label)=>spawn(installed,args,{env,stdio:['ignore',fs.openSync(path.join(dir,label+'.log'),'a'),fs.openSync(path.join(dir,label+'-error.log'),'a')]});
  const startServices=()=>{native=start(['--config',config,'web','--port',String(nativePort)],'native');relay=start(['serve','--host-config',relayConfig,'--port',String(relayPort)],'relay');};
  cliWith(process.env.SWITCHBOARD_TEST_ENGINE||installed,'attach','--create-background',name,'--',process.env.PYTHON||(process.platform==='win32'?'python':'python3'),'-u',path.join(root,'tools/switchboard/resumable-viewer/fixture.py'),dir);created=true;
  await waitFor(()=>fs.existsSync(path.join(dir,'fixture.json')),'Raw fixture failed');
  if(recoveryMode)env.SWITCHBOARD_RECOVER_UNSHARED_SESSION=name;
  startServices();await waitFor(async()=> (await fetch(url)).ok,'Services failed');
  const fixturePid=JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'))).pid;
  const before=identities();
  browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE});const context=await browser.newContext({viewport:{width:1200,height:800}});const page=await context.newPage();
  page.on('pageerror',error=>console.error('Browser error:',error.message));
  await page.addInitScript(()=>window.addEventListener('zellij-resumable-sockets',event=>{window.testPair=event.detail;window.testOutput='';event.detail.terminal.addEventListener('message',e=>window.testOutput+=e.data);}));
  await page.goto(url);
  await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow.testPair?.terminal.readyState===1);
  await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow.__zjLastMobileState?.active_pane);
  const workers=(await(await fetch(url+'/api/health')).json()).attachment_workers;assert.equal(workers.length,1);
  await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow;window.savedTerm=w.term;window.savedDocument=w.document;});
  fs.writeFileSync(path.join(dir,'go'),'');
  let expected='';
  const send=async text=>{expected+=text;await page.evaluate(text=>document.querySelector('#terminals>iframe.active').contentWindow.term.input(text),text);};
  // An idle already-focused pane emits no new native MobileState.
  for(let i=0;i<2;i++) {
    await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow,pair=w.testPair,pane=w.__zjLastMobileState.active_pane;pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'FocusPane',pane_id:pane.pane_id,is_plugin:pane.is_plugin}}));});
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.pending.length===0);
  }
  await send('before|');
  await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Initial typing failed');
  await page.evaluate(()=>{
    const owner=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;
    const socket=owner.socket,handler=socket.onmessage;
    socket.onmessage=event=>{if(JSON.parse(event.data).type==='ack'){socket.close();socket.onmessage=null;}else handler(event);};
  });
  await send('lost-ack|');
  await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Lost-ack input delivered once');
  await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.pending.length===0);
  if(process.env.SWITCHBOARD_TEST_COMMIT) {
    const helpers=path.join(dir,'helpers'),source=path.join(dir,'release'),state=path.join(dir,'update-state');
    for(const folder of [helpers,source,state])fs.mkdirSync(folder);
    const originalCommit=(await(await fetch(url+'/api/health')).json()).commit;
    let failNext=true,installs=0;
    updateController=http.createServer(async(req,res)=>{
      try {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const candidate=Buffer.concat(chunks).toString();assert.ok(candidate.startsWith(dir+'/'));
        await stop(native);native=null;await stop(relay);relay=null;
        await send(`handoff:${++installs}|`);
        fs.copyFileSync(candidate,installed+'.next');fs.chmodSync(installed+'.next',0o755);fs.renameSync(installed+'.next',installed);
        startServices();await waitFor(async()=> (await fetch(url+'/api/health')).ok,'Private services did not restart');
        await waitFor(async()=> (await(await fetch(url+'/api/hosts/test')).json()).sessions?.some(s=>s.name===name),'Candidate catalog ready');
        assert.equal((await fetch(url+'/hosts/test/session?resumable=true&session='+name,{method:'POST'})).status,503,'Bootstrap fenced throughout activation/rollback');
        if(failNext){failNext=false;res.writeHead(500);res.end('Injected handoff failure');}else res.end('ok');
      }catch(error){res.writeHead(500);res.end(error.message);}
    });
    await new Promise(resolve=>updateController.listen(0,'127.0.0.1',resolve));
    const helper=`#!/bin/bash\nset -euo pipefail\ncurl -fsS --max-time 40 -X POST --data-binary "$1" http://127.0.0.1:${updateController.address().port}/restart\n`;
    const platform=process.platform==='darwin'?(process.arch==='arm64'?'macos-arm64':'macos-x86_64'):(process.arch==='arm64'?'linux-arm64':'linux-x86_64');
    const files=process.platform==='darwin'?['auto_update.py','install_service.py','menu_bar.swift','update_local.sh','zellij']:['update_local.sh','zellij'];
    const commit=process.env.SWITCHBOARD_TEST_COMMIT,hashes={};
    for(const file of files){
      const bytes=file==='zellij'?fs.readFileSync(newBinary):Buffer.from(file==='update_local.sh'?helper:'# private unused fixture helper\n');
      fs.writeFileSync(path.join(source,`switchboard-${platform}-${file}`),bytes);hashes[file]=crypto.createHash('sha256').update(bytes).digest('hex');
      if(file!=='zellij')fs.writeFileSync(path.join(helpers,file),bytes);
    }
    fs.writeFileSync(path.join(source,`switchboard-${platform}-bundle.json`),JSON.stringify({schema:1,attachment_protocol:1,commit,platform,run_number:1,files:hashes}));
    const runUpdate=()=>new Promise((resolve,reject)=>{
      const child=spawn(newBinary,['switchboard','update','--config',config,'--host-config',relayConfig,'--port',String(relayPort),'--binary',installed,'--helper-directory',helpers,'--state-directory',state,'--source',source],{env,stdio:['ignore',fs.openSync(path.join(dir,'update.log'),'a'),fs.openSync(path.join(dir,'update-error.log'),'a')]});
      child.on('error',reject);child.on('exit',resolve);
    });
    assert.notEqual(await runUpdate(),0,'Injected failure triggers rollback');assert.equal(installs,2);
    assert.equal((await(await fetch(url+'/api/health')).json()).commit,originalCommit);
    await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Rollback typing is exact');
    assert.equal(await runUpdate(),0,'Automatic update succeeds with open viewer');assert.equal(installs,3);
    assert.ok(commit.startsWith((await(await fetch(url+'/api/health')).json()).commit));
    console.log('PASS: real automatic updater activates with viewer open, rollback resumes the same worker, retry installs the new build');
  } else {
    await send('\x1b[200~split');
    await stop(native);native=null;await stop(relay);relay=null;await sleep(300);
    await send('during|');await send('unicode:😀é|\x1b[201~');await sleep(700);startServices();
    await waitFor(async()=> (await fetch(url)).ok,'Restart failed');
  }
  await send('after|');
  await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Buffered input lost/duplicated: '+expected);
  assert.deepEqual((await(await fetch(url+'/api/health')).json()).attachment_workers,workers,'Worker survives');
  assert.deepEqual(identities(),before,'Panes survive');process.kill(fixturePid,0);
  assert.ok(await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow;return w.term===window.savedTerm&&w.document===window.savedDocument;}),'Document and renderer survive');
  await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active').contentWindow.testOutput.includes('OUT:000400'));
  assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected);
  const otherDir=path.join(dir,'other');fs.mkdirSync(otherDir);
  cli('-s',name,'action','new-tab','--name','Other','--',process.env.PYTHON||(process.platform==='win32'?'python':'python3'),'-u',path.join(root,'tools/switchboard/resumable-viewer/fixture.py'),otherDir);
  await waitFor(()=>fs.existsSync(path.join(otherDir,'input.bin')),'Second raw terminal started');
  const oldPane=before.find(p=>!p[0])[1],otherPane=identities().find(p=>!p[0]&&p[1]!==oldPane)[1];
  const focus=async pane=>{
    await page.evaluate(id=>{const pair=document.querySelector('#terminals>iframe.active').contentWindow.testPair;pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'FocusPane',pane_id:id,is_plugin:false}}));},pane);
    await page.waitForFunction(()=>{const o=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;return !o.stopped&&o.pending.length===0;});
  };
  await focus(oldPane);await send('returned|');
  await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.socket.close());
  await focus(otherPane);
  await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.send('other|'));
  await waitFor(()=>fs.readFileSync(path.join(otherDir,'input.bin'),'utf8')==='other|','Typing follows confirmed target after reconnect');
  await focus(oldPane);
  assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected);
  console.log('PASS: repeated idle focus and real pane switches survive reconnect with typing sent only to the target');
  if(recoveryMode) {
    const resume=await page.evaluate(()=>{const o=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;window.savedOwner=o;return {session:o.session,web_client_id:o.viewer,generation:o.generation,nonce:'revoked-recovery',applied:o.applied};});
    await stop(native);native=null;delete env.SWITCHBOARD_RECOVER_UNSHARED_SESSION;
    await page.evaluate(()=>window.savedOwner.terminal.send('REVOKED_INPUT'));
    native=start(['--config',config,'web','--port',String(nativePort)],'native');
    await waitFor(async()=> (await(await fetch(url+'/api/hosts/test')).json()).sessions?.find(s=>s.name===name)?.web_clients_allowed===false,'Recovery revoked');
    const denied=await page.evaluate(async query=>new Promise(resolve=>{const ws=new WebSocket(location.origin.replace('http','ws')+'/hosts/test/ws/resume?'+new URLSearchParams(query));ws.onopen=()=>{resolve(false);ws.close();};ws.onerror=()=>resolve(true);}),resume);
    assert.ok(denied,'Removed recovery cannot resume an existing retained viewer');
    const freshContext=await browser.newContext(),nativeUrl=`http://127.0.0.1:${nativePort}`;
    assert.equal((await freshContext.request.post(nativeUrl+'/command/login',{data:{auth_token:fs.readFileSync(tokenPath,'utf8'),remember_me:true}})).status(),200);
    const fresh=await freshContext.newPage();
    await fresh.addInitScript(()=>window.addEventListener('zellij-resumable-sockets',e=>window.testPair=e.detail));
    await fresh.goto(nativeUrl+'/'+name);
    await fresh.waitForFunction(()=>window.__zjResumeFailure);
    assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected,'Removed recovery cannot forward buffered input');
    await freshContext.close();console.log('PASS: removing recovery authorization blocks retained and new viewers');
  } else {
  // A different credential cannot take over this retained viewer.
  const beforeReadonly=identities();
  const roLine=cli('web','--create-read-only-token').split('\n').find(line=>line.includes(': '));
  const roName=roLine.slice(0,roLine.indexOf(': '));
  createdTokens.push(roName);
  const roToken=roLine.slice(roLine.indexOf(': ')+2).replace(/ \(read-only\)\s*$/,'').trim();
  const roContext=await browser.newContext(),nativeUrl=`http://127.0.0.1:${nativePort}`;
  assert.equal((await roContext.request.post(nativeUrl+'/command/login',{data:{auth_token:roToken,remember_me:true}})).status(),200);
  const roPage=await roContext.newPage();
  await roPage.addInitScript(()=>window.addEventListener('zellij-resumable-sockets',e=>window.testPair=e.detail));
  await roPage.goto(nativeUrl+'/'+name);
  await roPage.waitForFunction(()=>window.testPair?.terminal.readyState===1);
  await roPage.evaluate(()=>{window.testPair.terminal.send('FORBIDDEN');const pair=window.testPair;pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'NewTab'}}));});
  await sleep(300);assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected,'Read-only input rejected');
  assert.deepEqual(identities(),beforeReadonly,'Read-only controls cannot create a tab');
  const resume=await page.evaluate(()=>{const o=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;return {session:o.session,web_client_id:o.viewer,generation:o.generation,nonce:'wrong-owner',applied:o.applied};});
  const denied=await roPage.evaluate(async query=>new Promise(resolve=>{const ws=new WebSocket(location.origin.replace('http','ws')+'/ws/resume?'+new URLSearchParams(query));ws.onopen=()=>{resolve(false);ws.close();};ws.onerror=()=>resolve(true);}),resume);
  assert.ok(denied,'Another credential cannot resume the viewer');
  cli('web','--revoke-token',roName);
  await roPage.waitForFunction(()=>window.testPair.terminal.readyState===3);
  await roContext.close();
  console.log('PASS: read-only input blocked, different credentials rejected, revocation closes retained viewer');
  // A stale sidebar target must never send queued typing to the old pane.
  await page.evaluate(()=>{
    const pair=document.querySelector('#terminals>iframe.active').contentWindow.testPair;
    pair.terminal.owner.socket.close();
    pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'FocusPane',pane_id:4294967294,is_plugin:false}}));
    pair.terminal.send('WRONG_PANE');
  });
  await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow.__zjResumeFailure);
  assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected,'Failed focus cannot deliver input to the prior pane');
  console.log('PASS: stale focus during reconnect fails without sending queued typing to the old pane');
  }
  console.log('PASS: production parser, retained attachment, same engine/pane/browser, lossless typing and numbered output across web+relay restart');
 } finally {
  if(updateController)await new Promise(resolve=>updateController.close(resolve));
  if(browser)await browser.close();
  for(const token of createdTokens)try{cli('web','--revoke-token',token);}catch{}
  if(created)try{cli('kill-session',name);}catch{}
  await stop(native);await stop(relay);
  for(const file of fs.existsSync(path.join(dir,'attachments'))?fs.readdirSync(path.join(dir,'attachments')):[])if(file.endsWith('.json')){try{process.kill(JSON.parse(fs.readFileSync(path.join(dir,'attachments',file))).pid,'SIGTERM');}catch{}}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
