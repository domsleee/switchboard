// Conversation tab creation must not attach a viewer or resize an existing tab.
// Usage: node conversation_creation_native.test.cjs BINARY
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync,spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const binary=path.resolve(process.argv[2]||'target/release/zellij');
const dir=fs.mkdtempSync('/tmp/sbn-create-'),config=path.join(dir,'config.kdl');
const session='__conversation_create_'+path.basename(dir),empty=session+'_empty';
const env={...process.env,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color'};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_PANE_ID','ZELLIJ_CONFIG_FILE','ZELLIJ_CONFIG_DIR','SWITCHBOARD_RECOVER_UNSHARED_SESSION'])delete env[key];
const run=(...args)=>execFileSync(binary,['--config',config,...args],{env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
const action=(name,...args)=>run('-s',name,'action',...args);
const panes=name=>JSON.parse(action(name,'list-panes','--json','--all'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,message){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await sleep(100);}throw Error(message);}
let browser,web,passed=false;const tokens=[];
(async()=>{try{
  fs.writeFileSync(config,'web_sharing "on"\ndefault_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\nweb_server false\n');
  run('attach','--create-background',session,'--','/bin/bash','--noprofile','--norc');
  await waitFor(()=>panes(session).length,'Session did not start');
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const url=`http://127.0.0.1:${port}`;
  web=spawn(binary,['--config',config,'web','--port',String(port)],{env,stdio:['ignore',fs.openSync(path.join(dir,'web.log'),'a'),fs.openSync(path.join(dir,'web-error.log'),'a')]});
  await waitFor(async()=>(await fetch(url+'/info/version')).ok,'Web server did not start');
  browser=await chromium.launch({headless:true});
  async function client(readOnly=false){
    const line=run('web',readOnly?'--create-read-only-token':'--create-token').split('\n').find(line=>line.includes(': '));
    const name=line.split(': ')[0];tokens.push(name);
    const token=line.slice(name.length+2).replace(/ \(read-only\)\s*$/,'').trim();
    const context=await browser.newContext({viewport:{width:1200,height:800}});
    assert.equal((await context.request.post(url+'/command/login',{data:{auth_token:token,remember_me:false}})).status(),200);
    return context;
  }
  const writable=await client(),readOnly=await client(true);
  const catalog=async()=> (await (await writable.request.get(url+'/session-list')).json()).sessions;
  await waitFor(async()=>(await catalog()).some(s=>s.name===session&&s.web_clients_allowed),'Shared session absent');
  const page=await writable.newPage();await page.goto(url+'/'+session);
  await page.waitForFunction(()=>window.term?.cols>100&&window.term?.buffer?.active);
  await waitFor(()=>panes(session).some(p=>p.pane_columns>100),'Desktop did not size pane');
  const before=panes(session).filter(p=>!p.is_plugin).map(p=>({id:p.id,cols:p.pane_columns,rows:p.pane_rows}));
  const clientsBefore=action(session,'list-clients');
  const marker=path.join(dir,'command-ran');
  const target={session,project:dir,command:`printf created > '${marker}'`};
  assert.equal((await readOnly.request.post(url+'/new-tab',{data:target})).status(),403,'Read-only cannot create tabs');
  assert.equal((await writable.request.post(url+'/new-tab',{data:{...target,session:'../invalid'}})).status(),400);
  assert.equal((await writable.request.post(url+'/new-tab',{data:{...target,session:'missing'}})).status(),404);
  const response=await writable.request.post(url+'/new-tab',{data:target});
  assert.equal(response.status(),200,await response.text());const result=await response.json();
  await waitFor(()=>fs.readFileSync(marker,'utf8')==='created','Configured shell did not run command');
  assert.ok(panes(session).some(p=>p.id===result.pane_id),'Response identifies created pane');
  assert.deepEqual(panes(session).filter(p=>before.some(old=>old.id===p.id)).map(p=>({id:p.id,cols:p.pane_columns,rows:p.pane_rows})),before,'Original terminal dimensions remain unchanged');
  assert.equal(action(session,'list-clients'),clientsBefore,'No viewer attaches and desktop focus stays unchanged');
  action(session,'set-web-sharing','off');
  await waitFor(async()=>(await catalog()).some(s=>s.name===session&&!s.web_clients_allowed),'Sharing did not turn off');
  assert.equal((await writable.request.post(url+'/new-tab',{data:target})).status(),403,'Unshared session rejects creation');
  await page.close();run('kill-session',session);
  await waitFor(async()=>(await catalog()).length===0,'Session catalog did not empty');
  fs.unlinkSync(marker);
  const first=await writable.request.post(url+'/new-tab',{data:{...target,session:empty}});
  assert.equal(first.status(),200,await first.text());
  await waitFor(()=>fs.readFileSync(marker,'utf8')==='created','First tab on empty computer did not run command');
  const firstResult=await first.json();assert.ok(panes(empty).some(p=>p.id===firstResult.pane_id));
  passed=true;console.log('PASS: authenticated Conversation creates tabs without attaching viewers, resizing the desktop or changing its focus; read-only/unshared access is rejected; empty computers can start their first session.');
}finally{
  if(browser)await browser.close();
  if(web&&web.exitCode===null){const stopped=new Promise(resolve=>web.once('exit',resolve));web.kill('SIGTERM');await Promise.race([stopped,sleep(5000).then(()=>{if(web.exitCode===null)web.kill('SIGKILL');})]);}
  for(const name of [session,empty])try{run('kill-session',name);}catch{}
  for(const name of tokens)try{run('web','--revoke-token',name);}catch{}
  if(passed)fs.rmSync(dir,{recursive:true,force:true});
}})().catch(error=>{console.error(error);process.exitCode=1;});
