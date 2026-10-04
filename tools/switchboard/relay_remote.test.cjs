// Opt-in acceptance against an authenticated Windows host. All input is limited
// to a new disposable session; existing user sessions are queried read-only.
// Usage: node relay_remote.test.cjs BINARY HOSTS_JSON HOST_ID
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const binary=path.resolve(process.argv[2]||'target/release/zellij');
const source=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const host=source.hosts.find(h=>h.id===process.argv[4]);
assert.ok(host,'Choose an explicit host to test');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-remote-relay-'));
const config=path.join(dir,'hosts.json');
fs.writeFileSync(config,JSON.stringify({hosts:[{...host,escape_transport:'windows'}]}),{mode:0o600});
const name='relay-acceptance-'+crypto.randomBytes(8).toString('hex');
const bootstrapName='__switchboard_control_acceptance_'+crypto.randomBytes(8).toString('hex');
const encoded=script=>Buffer.from(script,'utf16le').toString('base64');
const ps=value=>"'"+value.replaceAll("'","''")+"'";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function wait(check,message,timeout=90000){
 const until=Date.now()+timeout;
 while(Date.now()<until){if(await check())return;await sleep(200);}
 throw Error(message);
}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
let relay,terminal,control,bootstrapTerminal,bootstrapControl,bootstrapState,base,state,output='',created=false,bootstrapCreated=false,inputSession=bootstrapName;
let recorderRoots=[];
async function request(endpoint,data){
 const r=await fetch(base+endpoint,{method:data?'POST':'GET',headers:data?{'content-type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(25000)});
 return {status:r.status,body:await r.text()};
}
async function connect(url){
 const socket=new WebSocket(url);socket.binaryType='arraybuffer';
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 return socket;
}
const plain=()=>output.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*?(?:\x07|\x1b\\)/g,'');
async function command(script,socket=terminal){
 if(socket===bootstrapTerminal){assert.equal(bootstrapState?.session_name,bootstrapName);assert.equal(bootstrapState?.active_pane?.is_plugin,false);}
 else {assert.equal(socket,terminal,'Commands require a verified disposable terminal');assert.equal(state?.session_name,inputSession,'Commands belong only to the disposable session');}
 const marker='REMOTE_'+crypto.randomBytes(8).toString('hex');output='';
 socket.send(Buffer.from('powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '+encoded("$ErrorActionPreference='Stop'; try { "+script+"; [Console]::WriteLine('"+marker+":OK') } catch { [Console]::WriteLine('"+marker+":FAIL') }")));
 socket.send(Buffer.from('\r'));
 await wait(()=>{assert.equal(socket.readyState,1,'Private terminal disconnected');return plain().includes(marker+':OK')||plain().includes(marker+':FAIL');},'Remote command did not acknowledge',20000);
 assert.ok(plain().includes(marker+':OK'),'Remote command failed');
}
async function attention(){const r=await request('/api/attention');assert.equal(r.status,200);return JSON.parse(r.body);}
async function sessionNames(){
 const r=await request('/hosts/'+encodeURIComponent(host.id)+'/session-list');assert.equal(r.status,200,r.body);
 return JSON.parse(r.body).sessions.map(s=>s.name);
}
function closeOwnedScript(session){
 assert.ok(session===name||session===bootstrapName,'Cleanup may only close this run\'s disposable sessions');
 return `$panes=(& zellij -s ${ps(session)} action list-panes --json --all) -join [Environment]::NewLine; if($LASTEXITCODE -ne 0){throw 'Cannot identify disposable tabs'}; $ids=@(($panes | ConvertFrom-Json).tab_id | Select-Object -Unique); foreach($id in $ids){& zellij -s ${ps(session)} action close-tab --tab-id $id; if($LASTEXITCODE -ne 0){throw 'Cannot close disposable tab'}}`;
}
async function proveEscape(target,observer){
 assert.ok(Number.isInteger(target)&&Number.isInteger(observer)&&target!==observer,'Two distinct native pane IDs are required');
 const roots=recorderRoots=[target,observer].map(id=>name+'-escape-'+id);
 for(const [index,id] of [target,observer].entries()){
  const recorder=`$p=Join-Path ([IO.Path]::GetTempPath()) ${ps(roots[index])}; $keys=New-Object 'System.Collections.Generic.List[int]'; [IO.File]::WriteAllText($p+'.json','[]'); [IO.File]::WriteAllText($p+'.ready','ready'); $until=[DateTime]::UtcNow.AddSeconds(60); try{while([DateTime]::UtcNow -lt $until -and -not [IO.File]::Exists($p+'.stop')){while([Console]::KeyAvailable){$keys.Add([int][Console]::ReadKey($true).KeyChar); [IO.File]::WriteAllText($p+'.json',(ConvertTo-Json -InputObject @($keys.ToArray()) -Compress))}; Start-Sleep -Milliseconds 10}}finally{[IO.File]::WriteAllText($p+'.done','done')}`;
  const line='powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+encoded(recorder);
  await command(`& zellij -s ${ps(name)} action write-chars -p ${id} ${ps(line)}; if($LASTEXITCODE -ne 0){throw 'Cannot start recorder'}; & zellij -s ${ps(name)} action write -p ${id} 13; if($LASTEXITCODE -ne 0){throw 'Cannot submit recorder'}`,bootstrapTerminal);
 }
 const paths=`$paths=@(${roots.map(root=>`(Join-Path ([IO.Path]::GetTempPath()) ${ps(root)})`).join(',')});`;
 await command(paths+" $until=[DateTime]::UtcNow.AddSeconds(5); while(@($paths | Where-Object {-not [IO.File]::Exists($_+'.ready')}).Count -gt 0){if([DateTime]::UtcNow -ge $until){throw 'Recorders did not become ready'}; Start-Sleep -Milliseconds 20}",bootstrapTerminal);
 const escape=await request('/api/hosts/'+encodeURIComponent(host.id)+'/escape',{session:name,pane_id:target});assert.equal(escape.status,200,escape.body);
 await command(paths+" $until=[DateTime]::UtcNow.AddSeconds(5); do{$got=[IO.File]::ReadAllText($paths[0]+'.json') | ConvertFrom-Json; $got=@($got); if($got.Count -gt 0){break}; Start-Sleep -Milliseconds 20}while([DateTime]::UtcNow -lt $until); foreach($p in $paths){[IO.File]::WriteAllText($p+'.stop','stop')}; $until=[DateTime]::UtcNow.AddSeconds(5); while(@($paths | Where-Object {-not [IO.File]::Exists($_+'.done')}).Count -gt 0){if([DateTime]::UtcNow -ge $until){throw 'Recorders did not stop'}; Start-Sleep -Milliseconds 20}; $target=[IO.File]::ReadAllText($paths[0]+'.json') | ConvertFrom-Json; $target=@($target); $other=[IO.File]::ReadAllText($paths[1]+'.json') | ConvertFrom-Json; $other=@($other); if($target.Count -ne 1 -or $target[0] -ne 27 -or $other.Count -ne 0){throw 'Escape was missing, duplicated, or reached another pane'}; [Console]::WriteLine('ESCAPE_BYTE_27_ONLY_IN_TARGET'); foreach($p in $paths){foreach($suffix in @('.json','.ready','.stop','.done')){[IO.File]::Delete($p+$suffix)}}",bootstrapTerminal);
 assert.ok(plain().includes('ESCAPE_BYTE_27_ONLY_IN_TARGET'));
}
(async()=>{
 try{
  const n=await port();base='http://127.0.0.1:'+n;
  relay=spawn(binary,['serve','--host-config',config,'--port',String(n)],{windowsHide:true,stdio:['ignore',fs.openSync(path.join(dir,'relay.log'),'a'),fs.openSync(path.join(dir,'relay-error.log'),'a')]});
  await wait(async()=>{try{return (await request('/api/health')).status===200;}catch{return false;}},'Rust relay did not start',15000);
  const hostPath='/hosts/'+encodeURIComponent(host.id);
  const before=await request('/api/hosts/'+encodeURIComponent(host.id));assert.equal(before.status,200);
  console.log('Disposable Windows fixture:',name);
  const beforeNames=JSON.parse(before.body).sessions.map(s=>s.name);
  const ws=base.replace('http','ws');
  async function attach(session){
   const bootResponse=await request(hostPath+'/session?session='+session+'&welcome=false',{});assert.equal(bootResponse.status,200);
   if(session===bootstrapName)bootstrapCreated=true;
   const boot=JSON.parse(bootResponse.body);assert.equal(boot.session_name,session);assert.equal(boot.is_read_only,false);
   const client='web_client_id='+encodeURIComponent(boot.web_client_id);state=null;
   terminal=await connect(ws+hostPath+'/ws/terminal/'+session+'?'+client+'&rows=40&cols=160');
   terminal.addEventListener('message',event=>{output+=(typeof event.data==='string'?event.data:Buffer.from(event.data).toString('utf8'));});
   const attachedControl=control=await connect(ws+hostPath+'/ws/control?'+client);
   control.addEventListener('message',event=>{const v=JSON.parse(event.data);if(v.type==='MobileState'){if(attachedControl===control)state=v.payload;if(attachedControl===bootstrapControl)bootstrapState=v.payload;}});
   await wait(()=>state?.session_name===session&&state?.active_pane?.is_plugin===false,'Private terminal not ready',20000);
  }
  await attach(bootstrapName);
  bootstrapTerminal=terminal;bootstrapControl=control;bootstrapState=state;
  // Hosts may auto-start agents in ordinary shells. Explicitly request a plain
  // PowerShell process for this fixture rather than typing into that startup agent.
  created=true;
  await command(`& zellij attach --create-background ${ps(name)} -- powershell.exe -NoLogo -NoProfile; if($LASTEXITCODE -ne 0){throw 'Cannot create fixture'}`);
  inputSession=name;await attach(name);
  await command("$self=(Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID)); if(-not $self){throw 'No process identity'}; [Console]::WriteLine('WINDOWS_CONPTY_OK'); $cap=@{TERM=$env:TERM;COLORTERM=$env:COLORTERM;NO_COLOR=$env:NO_COLOR;outputRedirected=[Console]::IsOutputRedirected;inputRedirected=[Console]::IsInputRedirected}; [Console]::WriteLine('CAPABILITIES:'+($cap | ConvertTo-Json -Compress))");
  console.log(plain().match(/CAPABILITIES:[^\r\n]+/)?.[0]||'Capability probe output unavailable');
  assert.ok(plain().includes('WINDOWS_CONPTY_OK'),'This check must run on Windows');
  await command(`& zellij -s ${ps(name)} action rename-tab --tab-id 0 'Relay first'; if($LASTEXITCODE -ne 0){throw 'rename failed'}; & zellij -s ${ps(name)} action new-tab --name 'Relay second' -- powershell.exe -NoLogo -NoProfile; if($LASTEXITCODE -ne 0){throw 'new tab failed'}`,bootstrapTerminal);
  let tabs;
  let lastDiagnostic;
  await wait(async()=>{const v=await attention();tabs=v.tabs.filter(t=>t.session===name);const diagnostic=JSON.stringify({tabs:v.tabs,errors:v.errors});if(diagnostic!==lastDiagnostic){console.log('Scanner diagnostics:',diagnostic);lastDiagnostic=diagnostic;}return tabs.length===2;},'Remote Rust scanner did not discover both tabs');
  assert.deepEqual(tabs.sort((a,b)=>a.position-b.position).map(t=>t.name),['Relay first','Relay second']);
  const pane=state.active_pane.pane_id;
  const active=tabs.find(t=>t.panes.some(p=>p.pane_id===pane));assert.ok(active,'Focused pane must belong to the disposable fixture');
  const inactive=tabs.find(t=>t.id!==active.id);
  const target=inactive.panes.find(p=>!p.is_plugin)?.pane_id;
  await proveEscape(target,pane);console.log("Verified Escape byte 27 in the target only.");
  assert.equal(state.active_pane.pane_id,pane,'Targeted Escape must preserve the focused pane');
  const missing=await request('/api/hosts/'+encodeURIComponent(host.id)+'/escape',{session:name,pane_id:0xffffffff});assert.equal(missing.status,409,missing.body);
  const closed=await request('/api/hosts/'+encodeURIComponent(host.id)+'/close-tab',{session:name,tab_id:inactive.id});assert.equal(closed.status,200,closed.body);console.log('Verified inactive-tab close.');
  await wait(async()=>{const v=await attention();return v.tabs.filter(t=>t.session===name).length===1;},'Closed tab still in catalog');
  const repeated=await request('/api/hosts/'+encodeURIComponent(host.id)+'/close-tab',{session:name,tab_id:inactive.id});assert.equal(repeated.status,409,repeated.body);
  const readyFixture='powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+encoded("[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); [Console]::Write([char]27+']0;codex - relay acceptance'+[char]7); [Console]::WriteLine('Worked for 2s'); [Console]::WriteLine([char]0x203a+' Ask Codex to do anything'); [Console]::WriteLine('GPT-6.1-Sol high'); [Console]::WriteLine('? for shortcuts'); Start-Sleep -Seconds 60");
  await command(`& zellij -s ${ps(name)} action write-chars -p ${pane} ${ps(readyFixture)}; if($LASTEXITCODE -ne 0){throw 'Cannot start ready fixture'}; & zellij -s ${ps(name)} action write -p ${pane} 13; if($LASTEXITCODE -ne 0){throw 'Cannot submit ready fixture'}`,bootstrapTerminal);
  let notification;
  await wait(async()=>{notification=(await attention()).panes.find(p=>p.session===name&&p.pane_id===pane&&p.state==='ready');return !!notification;},'Remote ready state was not detected');
  assert.ok(notification.token);
  const remaining=(await attention()).tabs.find(t=>t.session===name);
  const last=await request('/api/hosts/'+encodeURIComponent(host.id)+'/close-tab',{session:name,tab_id:remaining.id});assert.equal(last.status,200,last.body);
  await wait(async()=>!(await attention()).tabs.some(t=>t.session===name),'Disposable session did not close');
  await wait(async()=>!(await sessionNames()).includes(name),'Disposable session remains in the native catalog',15000);created=false;
  const after=JSON.parse((await request('/api/hosts/'+encodeURIComponent(host.id))).body).sessions.map(s=>s.name);
  for(const existing of beforeNames)assert.ok(after.includes(existing),'Existing session remains available');
  console.log('PASS: actual remote Windows private ConPTY session, native tab names/order, Python-free scanner, ready state, pane-targeted Escape, missing-target conflicts, inactive-tab close, last-tab close, existing sessions preserved.');
 }catch(error){console.error('Private remote acceptance logs:',dir);try{const v=await attention();console.error('Attention snapshot:',JSON.stringify({tabs:v.tabs,errors:v.errors}));}catch{}fs.writeFileSync(path.join(dir,'private-terminal.txt'),plain(),{mode:0o600});throw error;}
 finally{
  const cleanupErrors=[];
  try{
   if(created&&(await sessionNames()).includes(name)){
    assert.equal(bootstrapTerminal?.readyState,1,'A verified bootstrap connection is required to clean up the fixture');
    await command(closeOwnedScript(name),bootstrapTerminal);
   await wait(async()=>!(await sessionNames()).includes(name),'Disposable fixture cleanup was not confirmed',15000);created=false;
   }
   if(recorderRoots.length&&bootstrapTerminal?.readyState===1&&!created){
    await command(`foreach($root in @(${recorderRoots.map(ps).join(',')})){$p=Join-Path ([IO.Path]::GetTempPath()) $root; foreach($suffix in @('.json','.ready','.stop','.done')){[IO.File]::Delete($p+$suffix)}}`,bootstrapTerminal);
   }
  }catch(error){cleanupErrors.push('Fixture '+name+': '+error.message);}
  try{
   if(bootstrapCreated&&(await sessionNames()).includes(bootstrapName)){
    assert.equal(bootstrapTerminal?.readyState,1,'Bootstrap connection unavailable');
    assert.equal(bootstrapState?.session_name,bootstrapName,'Bootstrap ownership not verified');
    assert.equal(bootstrapState?.active_pane?.is_plugin,false,'Bootstrap is not a private terminal');
    // Closing this shell's final native tab necessarily disconnects before an acknowledgment.
    bootstrapTerminal.send(Buffer.from('powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand '+encoded(closeOwnedScript(bootstrapName))));bootstrapTerminal.send(Buffer.from('\r'));
    await wait(async()=>!(await sessionNames()).includes(bootstrapName),'Bootstrap cleanup was not confirmed',15000);bootstrapCreated=false;
   }
  }catch(error){cleanupErrors.push('Bootstrap '+bootstrapName+': '+error.message);}
  for(const socket of [terminal,control,bootstrapTerminal,bootstrapControl])if(socket)socket.close();
  if(relay&&relay.exitCode===null){const done=new Promise(r=>relay.once('exit',r));relay.kill('SIGTERM');await Promise.race([done,sleep(6000).then(()=>{if(relay.exitCode===null)relay.kill('SIGKILL');})]);}
  fs.rmSync(config,{force:true});
  if(cleanupErrors.length){console.error('Unconfirmed private-session cleanup:',cleanupErrors.join('; '));process.exitCode=1;}
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
