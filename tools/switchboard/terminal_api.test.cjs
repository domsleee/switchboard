// Real TLS + engine IPC, isolated from the user's sessions, credentials and services.
// node terminal_api.test.cjs BINARY
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const crypto=require('node:crypto');
const {execFileSync,spawn}=require('node:child_process');
const binary=path.resolve(process.argv[2]);
const dir=fs.mkdtempSync(path.join(process.platform==='win32'?os.tmpdir():'/tmp','sb-api-'));
const name='api-'+crypto.randomBytes(5).toString('hex');
const config=path.join(dir,'config.kdl');
const windows=process.platform==='win32';
const shell=windows?path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):'/bin/bash';
const env={...process.env,HOME:dir,USERPROFILE:dir,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),ZELLIJ_CONFIG_FILE:config,TERM:'xterm-256color'};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR'])delete env[key];
const secure=require('./tls-fixture.cjs')(()=>env);
const cli=(...args)=>execFileSync(binary,['--config',config,...args],{env,encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));return port;}
async function until(check){for(let n=0;n<100;n++){try{if(await check())return;}catch{}await delay(100);}throw Error('Fixture did not become ready: '+dir);}
async function stop(child){if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,delay(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
const children=[];let created=false,passed=false;
(async()=>{try{
  fs.writeFileSync(config,'web_sharing "on"\ndefault_shell '+JSON.stringify(shell)+'\nshow_startup_tips false\nsession_serialization false\n');
  cli('attach','--create-background',name,'--',shell,...(windows?['-NoLogo','-NoProfile','-NoExit']:['--noprofile','--norc']));created=true;
  function credential(readonly){const line=cli('web',readonly?'--create-read-only-token':'--create-token').split('\n').find(l=>l.includes(': '));assert.ok(line);return {name:line.split(': ')[0],token:line.slice(line.indexOf(': ')+2).replace(/ \(read-only\)$/,'').trim()};}
  const writer=credential(false),reader=credential(true);
  const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,writer.token,{mode:0o600});
  const nativePort=await port(),relayPort=await port();
  const nativeUrl='https://127.0.0.1:'+nativePort,url='https://127.0.0.1:'+relayPort;
  const launch=(label,args)=>{const child=spawn(binary,args,{env,stdio:['ignore',fs.openSync(path.join(dir,label+'.log'),'a'),fs.openSync(path.join(dir,label+'-error.log'),'a')]});children.push(child);return child;};
  launch('native',['--config',config,'web','--port',String(nativePort)]);
  await until(async()=> (await secure.fetch(nativeUrl+'/info/version')).ok);
  assert.match(cli('web','--status','--port',String(nativePort)),/https:\/\//);
  const hosts=path.join(dir,'hosts.json');fs.writeFileSync(hosts,JSON.stringify({hosts:[{id:'fixture',name:'Private fixture',url:nativeUrl,token_file:tokenFile}]}));
  launch('relay',['serve','--host-config',hosts,'--port',String(relayPort)]);
  await until(async()=> (await secure.fetch(url+'/api/hosts/fixture')).json().then(h=>h.sessions?.some(s=>s.name===name&&s.web_clients_allowed)));
  const call=(body,token=writer.token,extra={})=>secure.fetch(url+'/api/hosts/fixture/terminal',{method:'POST',headers:{'content-type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify({session:name,...body})});
  assert.equal((await call({action:'list'},null)).status,401);
  assert.equal((await call({action:'list'},'invalid')).status,401);
  assert.equal((await call({action:'list'},writer.token,{Origin:'https://attacker.invalid'})).status,403);
  const listing=await call({action:'list'},reader.token);assert.equal(listing.status,200,await listing.clone().text());
  const panes=(await listing.json()).panes,pane=panes.find(p=>!p.is_plugin);assert.ok(pane);
  const pane_id=pane.id;
  assert.equal((await call({action:'input',pane_id,text:'should not arrive'},reader.token)).status,403);
  assert.equal((await call({action:'close',pane_id},reader.token)).status,403);
  assert.equal((await call({action:'read',pane_id:4294967295})).status,409);
  const marker='verified-'+crypto.randomBytes(6).toString('hex');
  const text=windows?`[Console]::WriteLine('${marker.slice(0,7)}' + '${marker.slice(7)}')`:`printf '%s%s\\n' '${marker.slice(0,7)}' '${marker.slice(7)}'`;
  assert.equal((await call({action:'input',pane_id,text})).status,200);
  assert.equal((await call({action:'key',pane_id,key:'enter'})).status,200);
  await until(async()=>{const response=await call({action:'read',pane_id});assert.equal(response.status,200);return (await response.json()).screen.split('\n').some(line=>line.trim()===marker);});
  const after=(await (await call({action:'list'})).json()).panes;
  assert.equal(after.length,panes.length,'API did not create a viewer or pane');
  for(const key of ['pane_x','pane_y','pane_columns','pane_rows','tab_id'])assert.equal(after.find(p=>p.id===pane_id)[key],pane[key]);
  cli('web','--revoke-token',reader.name);
  assert.equal((await call({action:'list'},reader.token)).status,401);
  assert.equal((await call({action:'close',pane_id})).status,200);
  created=false;passed=true;
  console.log('PASS: verified HTTPS, missing/invalid/revoked/read-only credentials, exact-pane IPC read/input/close, unchanged geometry.');
}finally{
  for(const child of children.reverse())await stop(child);
  if(created)try{cli('kill-session',name);}catch{}
  if(passed)fs.rmSync(dir,{recursive:true,force:true});else console.error('Private fixture logs: '+dir);
}})().catch(error=>{console.error(error);process.exitCode=1;});
