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
const env = {...process.env, HOME:dir, USERPROFILE:dir, APPDATA:path.join(dir,'AppData','Roaming'), LOCALAPPDATA:path.join(dir,'AppData','Local'), XDG_DATA_HOME:path.join(dir,'data'), XDG_CACHE_HOME:path.join(dir,'cache'), ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),
    SWITCHBOARD_TERMINAL_FAILURE_FILE:path.join(dir,'terminal-failures.json'),
    SWITCHBOARD_ATTACHMENT_DIRECTORY:path.join(dir,'attachments'), SWITCHBOARD_RELEASES_DIR:path.join(dir,'releases'), SWITCHBOARD_VIEWER_LOCK:path.join(dir,'viewers.lock'), TERM:'xterm-256color'};
// Windows known-folder lookup verifies these profile directories before CLI startup.
for(const folder of [env.APPDATA,env.LOCALAPPDATA])fs.mkdirSync(folder,{recursive:true});
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
async function waitFor(check, message, attempts=150) {
    for(let n=0;n<attempts;n++) {try {if(await check()) return;} catch {} await sleep(100);}
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
  if(process.env.SWITCHBOARD_RECONNECT_PROOF==='1') {
    fs.writeFileSync(path.join(dir,'go'),'');
    const state=()=>page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow,o=w.testPair.terminal.owner;return {viewer:o.viewer,connected:o.connected,pending:o.pending.length,checkpoint:o.replacementAck===o.inputAck,pane:w.__zjLastMobileState?.active_pane,failed:w.__zjResumeFailure};});
    const initial=await state();
    await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow;window.savedTerm=w.term;window.savedDocument=w.document;});
    // Model a suspended browser's wall-clock jump without advancing the engine.
    await page.evaluate(()=>{
      const o=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner,s=o.socket;
      o.offlineSince=Date.now()-5*60*60*1000;s.onclose();s.close();o.terminal.send('after-sleep|');
    });
    const resumedAt=Date.now();
    await waitFor(async()=>{const s=await state();return s.connected&&!s.pending&&!s.failed;},'Viewer did not resume after a long sleep');
    const resumeMs=Date.now()-resumedAt;
    await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')==='after-sleep|','Queued typing was lost or duplicated');
    assert.equal((await state()).viewer,initial.viewer,'A transport outage preserves its input owner');
    await waitFor(async()=> (await state()).checkpoint,'Worker did not confirm a clean parser');
    // This worker belongs only to this private fixture; leave the engine running.
    process.kill(workers[0].pid,'SIGTERM');
    const replacedAt=Date.now();
    await waitFor(async()=>{const s=await state();return s.viewer!==initial.viewer&&s.connected&&!s.pending&&s.pane?.pane_id===initial.pane.pane_id&&!s.failed;},'A lost clean worker did not recover to its pane');
    const replaceMs=Date.now()-replacedAt;
    await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.term.input('after-expiry|'));
    await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')==='after-sleep|after-expiry|','Typing after worker replacement failed');
    assert.equal(await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow;return w.term===window.savedTerm&&w.document===window.savedDocument;}),true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'fixture.json'))).pid,fixturePid);
    assert.deepEqual(identities(),before,'Recovery preserves the engine and panes');
    assert.equal(await page.frameLocator('#terminals>iframe.active').locator('.security-modal.error').count(),0);
    console.log(`PASS: five-hour browser suspension recovers on the same owner in ${resumeMs}ms; clean worker loss recovers in ${replaceMs}ms; typing is delivered exactly once and the engine, pane, document and terminal survive`);
    return;
  }
  if(process.env.SWITCHBOARD_FAILURE_LOG_PROOF==='1') {
    const browserReports=[];
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/diagnostics/terminal-failure')browserReports.push(request.postDataJSON());});
    await page.evaluate(()=>{
      const pair=document.querySelector('#terminals>iframe.active').contentWindow.testPair;
      pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'FocusPane',pane_id:4294967294,is_plugin:false}}));
      pair.terminal.send('PRIVATE_UNSENT_PROMPT');
    });
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow.__zjTerminalFailure);
    const failure=await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjTerminalFailure);
    assert.equal(failure.code,'pane_unavailable');assert.equal(failure.pane_id,4294967294);
    assert.match(failure.reference,/^[a-f0-9]{12}$/);assert.equal(failure.engine_build,null);
    assert.equal(JSON.parse(fs.readFileSync(env.SWITCHBOARD_TERMINAL_FAILURE_FILE,'utf8')).some(e=>e.references.includes(failure.reference)),true,'Worker saved the report before sending the fatal response');
    assert.match(await page.frameLocator('#terminals>iframe.active').locator('body').innerText(),new RegExp('Reference: '+failure.reference));
    const entries=async()=> (await(await fetch(url+'/api/logs')).json()).computers.flatMap(c=>c.entries||[]);
    await waitFor(async()=> (await entries()).some(e=>e.references?.includes(failure.reference)),'Failure missing from Logs');
    const saved=(await entries()).find(e=>e.references?.includes(failure.reference));
    assert.equal(saved.count,1,'Browser fallback does not double count the worker report');
    assert.equal(browserReports.length,0,'A saved worker failure is not copied to the viewing relay');
    assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_UNSENT_PROMPT/);
    const browserReference=crypto.randomBytes(6).toString('hex');
    await page.evaluate(reference=>{
      const w=document.querySelector('#terminals>iframe.active').contentWindow;
      w.dispatchEvent(new w.CustomEvent('zellij-terminal-failed',{detail:{reference,code:'resume_timeout',session:'',pane_id:null,is_plugin:false,
        operation:'browser',elapsed_ms:120000,focus_confirmed:false,query_received:false,worker_build:null,engine_build:null,pending_records:2}}));
    },browserReference);
    await waitFor(async()=> (await entries()).some(e=>e.references?.includes(browserReference)),'Browser-only failure missing from Logs');
    assert.equal(browserReports.length,1);assert.equal(browserReports[0].host,'test');
    const browserSaved=(await entries()).find(e=>e.references?.includes(browserReference));
    assert.equal(browserSaved.failure.pending_records,2);assert.equal(browserSaved.failure.session,name);
    await page.locator('#settings').click();await page.getByRole('tab',{name:'Logs'}).click();
    await page.locator('#logs').getByText(saved.message,{exact:true}).waitFor();
    if(process.env.SWITCHBOARD_FAILURE_SCREENSHOT)await page.screenshot({path:process.env.SWITCHBOARD_FAILURE_SCREENSHOT});
    await stop(relay);relay=start(['serve','--host-config',relayConfig,'--port',String(relayPort)],'relay');
    await waitFor(async()=>{try{const logs=await entries();return [failure.reference,browserReference].every(ref=>logs.some(e=>e.references?.includes(ref)));}catch{return false;}},'Failure missing after relay restart');
    assert.deepEqual(identities(),before,'Logging and relay restart preserve the engine and panes');
    console.log('PASS: terminal failure is saved at source, correlated with its dialog and Settings Logs, private, counted once, and retained after relay restart');
    return;
  }
  {
    // A slow first resumable hello (a worker starting under Defender) must not
    // fall back to legacy sockets, which every service update disconnects.
    const slowContext=await browser.newContext({viewport:{width:1200,height:800}}),slow=await slowContext.newPage(),opened=[];
    let delayed=false;
    await slowContext.routeWebSocket(/\/ws\/resume/,async ws=>{if(!delayed){delayed=true;await sleep(7000);}ws.connectToServer();});
    slow.on('websocket',socket=>opened.push(new URL(socket.url()).pathname));
    await slow.addInitScript(()=>window.addEventListener('zellij-resumable-sockets',event=>{window.testPair=event.detail;}));
    await slow.goto(url);
    await slow.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow.testPair?.terminal.readyState===1,null,{timeout:30000});
    assert.ok(delayed,'The first resumable socket was delayed');
    assert.deepEqual(opened.filter(path=>/\/ws\/(terminal|control)/.test(path)),[],'A slow resumable attachment fell back to legacy sockets');
    // Retire the viewer; a closed page would keep its native client for ten minutes.
    assert.equal(await slow.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjSuspendTerminal()),true);
    await slowContext.close();
    console.log('PASS: a slow first resumable attachment stays resumable');
  }
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
  try {await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Buffered input lost/duplicated');}
  catch(error){console.error('Fixture input bytes:',JSON.stringify({expected:Buffer.from(expected).toString('hex'),actual:fs.readFileSync(path.join(dir,'input.bin')).toString('hex')}));throw error;}
  assert.deepEqual((await(await fetch(url+'/api/health')).json()).attachment_workers,workers,'Worker survives');
  assert.deepEqual(identities(),before,'Panes survive');process.kill(fixturePid,0);
  assert.ok(await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow;return w.term===window.savedTerm&&w.document===window.savedDocument;}),'Document and renderer survive');
  await waitFor(()=>fs.readFileSync(path.join(dir,'output.txt'),'utf8').includes('OUT:000400'),'Fixture did not emit final output',600);
  // Native render deltas can split text with cursor moves; assert what xterm displays.
  try {await page.waitForFunction(()=>{
    const term=document.querySelector('#terminals>iframe.active').contentWindow.term;
    return Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()||'').some(line=>line.includes('OUT:000400'));
  });} catch(error){
    console.error('Rendered fixture output:',JSON.stringify(await page.evaluate(()=>{
      const w=document.querySelector('#terminals>iframe.active').contentWindow,term=w.term,owner=w.testPair.terminal.owner;
      return {rows:Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()||''),failure:w.__zjResumeFailure,stopped:owner.stopped,pending:owner.pending.length};
    })));throw error;
  }
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
  // A hidden tab or sleeping laptop stops applying output while the pane keeps
  // writing. The relay must repaint that viewer, not fail it, once its replay fills.
  await page.evaluate(()=>{
    const owner=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;
    const socket=owner.socket,handler=socket.onmessage,apply=owner.apply.bind(owner);
    window.floodOwner=owner;window.sawResync=false;
    owner.apply=record=>{if(record.resync)window.sawResync=true;return apply(record);};
    socket.onmessage=event=>{if(JSON.parse(event.data).type==='output')owner.lastReceived=Date.now();else handler(event);};
  });
  fs.writeFileSync(path.join(dir,'flood'),'');
  await waitFor(()=>fs.existsSync(path.join(dir,'flood-done')),'Fixture did not finish flooding',600);
  await sleep(1000);
  await page.evaluate(()=>window.floodOwner.socket.close());
  try {await page.waitForFunction(()=>{
    const w=document.querySelector('#terminals>iframe.active').contentWindow,term=w.term;
    return w.__zjResumeFailure||Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i)?.translateToString()||'').some(line=>line.includes('FLOOD:DONE'));
  },null,{timeout:30000});} finally {
    const state=await page.evaluate(()=>({failure:document.querySelector('#terminals>iframe.active').contentWindow.__zjResumeFailure??null,stopped:window.floodOwner.stopped,resync:window.sawResync}));
    assert.deepEqual(state,{failure:null,stopped:false,resync:true},'A lagging viewer is repainted after its replay buffer fills');
  }
  await send('after-flood|');
  await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Typing works after a repaint');
  console.log('PASS: a viewer that stopped applying output is repainted after its replay buffer fills');
  if(!recoveryMode) {
    const clientIds=()=>cli('-s',name,'action','list-clients').split('\n').map(line=>line.trim().split(/\s+/)[0]).filter(id=>/^\d+$/.test(id)).sort();
    const originalClients=clientIds();
    await send('\x1b[200~cancel-retirement');
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.pending.length===0);
    await stop(relay);relay=null;
    await page.waitForFunction(()=>!document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.connected);
    await page.evaluate(()=>{window.cancelOwner=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;document.querySelector('.conversation-toggle').click();});
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#terminals>iframe.active').inert);
    await send('-finished\x1b[201~');
    relay=start(['serve','--host-config',relayConfig,'--port',String(relayPort)],'relay');
    await page.waitForFunction(()=>window.cancelOwner.stopped||window.cancelOwner.connected&&window.cancelOwner.pending.length===0);
    assert.equal(await page.evaluate(()=>window.cancelOwner.stopped),false,'Canceling retirement preserves parser-buffered paste: '+JSON.stringify(await page.evaluate(()=>({pending:window.cancelOwner.pending,failure:document.querySelector('#terminals>iframe.active').contentWindow.__zjResumeFailure}))));
    await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Canceled retirement paste completes on the same owner');
    await send('\x1b[200~partial-retirement');
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.pending.length===0);
    await assert.rejects(page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjSuspendTerminal()),/incomplete terminal sequence/);
    assert.equal(await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.stopped),false);
    await page.evaluate(()=>{
      const pair=document.querySelector('#terminals>iframe.active').contentWindow.testPair;
      for(const payload of [
        {type:'TerminalResize',rows:40,cols:100},
        {type:'TerminalMetrics',cell_pixel_width:8,cell_pixel_height:16,text_area_pixel_width:800,text_area_pixel_height:640},
        {type:'SetTabViewport',size:{cols:100,rows:40},tab_position:0,ownership:true}
      ])pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload}));
    });
    await send('-finished\x1b[201~');
    await waitFor(()=>fs.readFileSync(path.join(dir,'input.bin'),'utf8')===expected,'Refused retirement preserves partial paste for completion');
    const largeContext=await browser.newContext({viewport:{width:1800,height:1000}}),nativeUrl=`http://127.0.0.1:${nativePort}`;
    assert.equal((await largeContext.request.post(nativeUrl+'/command/login',{data:{auth_token:fs.readFileSync(tokenPath,'utf8'),remember_me:true}})).status(),200);
    const large=await largeContext.newPage(),largeAttaches=[];
    large.on('pageerror',error=>console.error('Large browser error:',error.message));
    // Attach and resume answers, so a reload that never opens names the refusal.
    large.on('response',async response=>{
      const url=new URL(response.url());
      if(url.pathname.endsWith('/session')&&response.request().method()==='POST')largeAttaches.push(`session ${response.status()} ${(await response.text().catch(()=>'')).slice(0,120)}`);
    });
    large.on('websocket',socket=>{if(socket.url().includes('/ws/resume'))socket.on('close',()=>largeAttaches.push('resume socket closed'));});
    await large.addInitScript(()=>window.addEventListener('zellij-resumable-sockets',e=>window.testPair=e.detail));
    await large.goto(nativeUrl+'/'+name);
    await large.waitForFunction(()=>window.testPair?.terminal.readyState===1);
    await large.evaluate(id=>{const pair=window.testPair;pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'FocusPane',pane_id:id,is_plugin:false}}));},oldPane);
    await large.waitForFunction(()=>window.testPair.terminal.owner.pending.length===0);
    await page.setViewportSize({width:600,height:450});
    // Use the same measured size as automatic browser resize reports. Synthetic
    // dimensions can be overwritten by a pending render after their input ack.
    const smallViewport=await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjViewport.dimensions());
    const largeColumns=await large.evaluate(()=>Math.floor(innerWidth/term._core._renderService.dimensions.css.cell.width));
    assert.ok(largeColumns>smallViewport.cols+40,'The large browser has room to expand after retirement');
    await page.evaluate(size=>{const pair=document.querySelector('#terminals>iframe.active').contentWindow.testPair;for(const payload of [{type:'TerminalResize',...size},{type:'SetTabViewport',size,tab_position:0,ownership:true}])pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload}));},smallViewport);
    await page.waitForFunction(()=>{const owner=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;return !owner.stopped&&owner.pending.length===0;});
    const columns=()=>JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>p.id===oldPane&&!p.is_plugin).pane_columns;
    try {await waitFor(()=>columns()===smallViewport.cols,'Small viewer constrains terminal before suspension');}
    catch(error){console.error('Retirement size setup:',JSON.stringify({smallViewport,largeColumns,nativeColumns:columns(),browser:await page.evaluate(()=>{const w=document.querySelector('#terminals>iframe.active').contentWindow;return {physical:w.__zjViewport.dimensions(),state:w.__zjLastMobileState};})}));throw error;}
    const smallColumns=columns();
    await stop(relay);relay=null;
    await page.waitForFunction(()=>!document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner.connected);
    await send('conversation|');
    await page.evaluate(()=>{
      const owner=document.querySelector('#terminals>iframe.active').contentWindow.testPair.terminal.owner;
      window.retirementOwner=owner;window.lostRetirementReceipt=false;
      const connect=owner.connect.bind(owner);
      owner.connect=()=>{connect();const socket=owner.socket,handler=socket.onmessage;
        socket.onmessage=event=>{if(JSON.parse(event.data).type==='retired'&&!window.lostRetirementReceipt){window.lostRetirementReceipt=true;owner.socket=null;owner.connected=false;clearInterval(owner.watchdog);socket.onmessage=null;socket.onclose=()=>{};socket.close();setTimeout(()=>owner.pauseRetirement(),50);}else handler(event);};};
      document.querySelector('.conversation-toggle').click();
    });
    await sleep(300);
    assert.notEqual(await page.locator('#terminals>iframe').first().getAttribute('src'),'about:blank','Buffered owner remains alive while relay is down');
    assert.ok(await page.evaluate(()=>window.retirementOwner.pending.length>0));
    relay=start(['serve','--host-config',relayConfig,'--port',String(relayPort)],'relay');
    await page.waitForFunction(()=>window.lostRetirementReceipt);
    await page.evaluate(()=>{
      const frame=document.querySelector('#terminals>iframe');
      frame.contentDocument.querySelector('.xterm-helper-textarea')?.focus();
      [...document.querySelectorAll('button')].find(b=>b.textContent==='Terminal').click();
    });
    assert.equal(await page.locator('#terminals>iframe').first().evaluate(frame=>frame.inert),true,'Returning during retirement cannot expose a retired input owner');
    await page.keyboard.type('MUST_NOT_REACH_TERMINAL');await sleep(150);
    assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected,'An already-focused iframe cannot receive typing while retirement is unresolved');
    await page.screenshot({path:path.join(dir,'retirement-pending.png')});
    await page.evaluate(()=>document.querySelector('.conversation-toggle').click());
    await sleep(12000);
    await page.getByRole('button',{name:'Retry terminal connection',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe')?.getAttribute('src')==='about:blank');
    assert.equal(fs.readFileSync(path.join(dir,'input.bin'),'utf8'),expected,'Conversation drains queued typing exactly once');
    assert.equal(await page.evaluate(()=>window.lostRetirementReceipt),true,'Lost retirement confirmation is recovered');
    await waitFor(()=>originalClients.every(id=>!clientIds().includes(id)),'Retired native viewer is removed promptly');
    await waitFor(()=>columns()>smallColumns+40,'Large viewer regains terminal dimensions after retirement');
    await large.evaluate(()=>window.__zjSuspendTerminal());
    for(let cycle=0;cycle<65;cycle++){
      largeAttaches.length=0;
      await large.reload();
      await large.waitForFunction(()=>window.testPair?.terminal.readyState===1).catch(async error=>{
        const why=await large.evaluate(()=>JSON.stringify({failure:window.__zjResumeFailure??null,readyState:window.testPair?.terminal.readyState??null,status:document.body.innerText.slice(-200)}));
        throw Error(`Reload cycle ${cycle} never opened: ${error.message} ${why} ${JSON.stringify(largeAttaches.slice(-6))}`);
      });
      // This intermittently finds the owner already stopped; name the cause when it does.
      await large.evaluate(()=>window.__zjSuspendTerminal()).catch(async error=>{
        const why=await large.evaluate(()=>JSON.stringify({failure:window.__zjResumeFailure??null,readyState:window.testPair?.terminal.readyState}));
        throw Error(`Reload cycle ${cycle}: ${error.message} ${why}`);
      });
    }
    await large.reload();await large.waitForFunction(()=>window.testPair?.terminal.readyState===1);
    await large.evaluate(()=>window.testPair.terminal.send('\x1b[200~unfinished'));
    await large.waitForFunction(()=>window.testPair.terminal.owner.pending.length===0);
    await large.evaluate(pane=>{const pair=window.testPair;pair.control.send(JSON.stringify({web_client_id:pair.control.owner.viewer,payload:{type:'FocusPane',pane_id:pane,is_plugin:false}}));pair.terminal.send('MUST_NOT_ROUTE');},otherPane);
    await large.waitForFunction(()=>window.__zjResumeFailure);
    assert.match(await large.evaluate(()=>window.__zjResumeFailure),/Incomplete terminal sequence/);
    assert.equal(fs.readFileSync(path.join(otherDir,'input.bin'),'utf8'),'other|','Focus cannot reroute an unfinished paste');
    await largeContext.close();
    await page.setViewportSize({width:1200,height:800});
    await page.getByRole('button',{name:'Terminal',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#terminals>iframe.active')?.contentWindow.testPair?.terminal.readyState===1);
    await focus(oldPane);
    console.log('PASS: Conversation preserves queued typing through relay downtime, recovers a lost retirement receipt, removes the old native viewer and restores terminal size');
  }
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
    const socket=pair.terminal.owner.socket,handler=socket.onmessage;
    // Lose the first error response, then require resume to deliver the retained failure.
    socket.onmessage=event=>{if(JSON.parse(event.data).type==='error'){socket.onmessage=null;socket.close();}else handler(event);};
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
