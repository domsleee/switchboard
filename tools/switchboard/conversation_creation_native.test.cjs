// Conversation tab creation must not attach a viewer or resize an existing tab.
// Usage: node conversation_creation_native.test.cjs BINARY
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {execFileSync,spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const binary=path.resolve(process.argv[2]||'target/release/zellij');
// macOS's per-user temporary path exceeds its Unix socket path limit.
const dir=fs.mkdtempSync(path.join(process.platform==='darwin'?'/tmp':require('node:os').tmpdir(),'sbn-create-')),config=path.join(dir,'config.kdl');
const session='__conversation_create_'+path.basename(dir),empty=session+'_empty';
const env={...process.env,ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),TERM:'xterm-256color'};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_PANE_ID','ZELLIJ_CONFIG_FILE','ZELLIJ_CONFIG_DIR','SWITCHBOARD_RECOVER_UNSHARED_SESSION'])delete env[key];
const run=(...args)=>execFileSync(binary,['--config',config,...args],{env,encoding:'utf8',timeout:15000,stdio:args.includes('--create-background')?'ignore':['ignore','pipe','pipe']});
const action=(name,...args)=>run('-s',name,'action',...args);
const panes=name=>JSON.parse(action(name,'list-panes','--json','--all'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,message){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await sleep(100);}throw Error(message);}
let browser,web,passed=false;const tokens=[];
(async()=>{try{
  const shell=process.platform==='win32'?'powershell.exe':'/bin/bash';
  fs.writeFileSync(config,`web_sharing "on"\ndefault_shell ${JSON.stringify(shell)}\nshow_startup_tips false\nsession_serialization false\nweb_server false\n`);
  run('attach','--create-background',session,'--',shell,...(process.platform==='win32'?[]:['--noprofile','--norc']));
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
  // Force tab and terminal IDs apart before exercising creation. Treating
  // new-tab's returned tab ID as a pane ID used to select this extra shell.
  action(session,'new-pane','--',shell,...(process.platform==='win32'?[]:['--noprofile','--norc']));
  await waitFor(()=>panes(session).filter(p=>!p.is_plugin).length===2,'Split pane did not start');
  const before=panes(session).filter(p=>!p.is_plugin).map(p=>({id:p.id,cols:p.pane_columns,rows:p.pane_rows}));
  const clientsBefore=action(session,'list-clients');
  const marker=path.join(dir,'command-ran');
  const command=process.platform==='win32'?`Set-Content -LiteralPath '${marker.replaceAll("'","''")}' -Value created`:`printf created > '${marker}'`;
  const target={session,project:dir,command};
  assert.equal((await readOnly.request.post(url+'/new-tab',{data:target})).status(),403,'Read-only cannot create tabs');
  assert.equal((await writable.request.post(url+'/new-tab',{data:{...target,session:'../invalid'}})).status(),400);
  assert.equal((await writable.request.post(url+'/new-tab',{data:{...target,session:'missing'}})).status(),404);
  const response=await writable.request.post(url+'/new-tab',{data:target});
  assert.equal(response.status(),200,await response.text());const result=await response.json();
  await waitFor(()=>fs.readFileSync(marker,'utf8').trim()==='created','Configured shell did not run command');
  assert.ok(panes(session).some(p=>p.id===result.pane_id),'Response identifies created pane');
  assert.notEqual(result.pane_id,result.tab_id,'Fixture must distinguish pane and tab IDs');
  assert.ok(panes(session).some(p=>p.id===result.pane_id&&p.tab_id===result.tab_id),'Response identifies the command terminal in the created tab');
  assert.deepEqual(panes(session).filter(p=>before.some(old=>old.id===p.id)).map(p=>({id:p.id,cols:p.pane_columns,rows:p.pane_rows})),before,'Original terminal dimensions remain unchanged');
  assert.equal(action(session,'list-clients'),clientsBefore,'No viewer attaches and desktop focus stays unchanged');
  action(session,'set-web-sharing','off');
  await waitFor(async()=>(await catalog()).some(s=>s.name===session&&!s.web_clients_allowed),'Sharing did not turn off');
  assert.equal((await writable.request.post(url+'/new-tab',{data:target})).status(),403,'Unshared session rejects creation');
  await page.close();
  // A computer whose sessions are all unshared starts its first shared session beside them.
  fs.unlinkSync(marker);
  const first=await writable.request.post(url+'/new-tab',{data:{...target,session:empty}});
  assert.equal(first.status(),200,await first.text());
  await waitFor(()=>fs.readFileSync(marker,'utf8').trim()==='created','First tab beside unshared sessions did not run command');
  const firstResult=await first.json();assert.ok(panes(empty).some(p=>p.id===firstResult.pane_id));

  // Hold an attachment bootstrap while its target is still alive, then connect
  // it only after the session ends. The retained worker must not start a shell.
  const bootstrap=await writable.request.post(url+'/session?resumable=true&session='+encodeURIComponent(empty));
  assert.equal(bootstrap.status(),200,await bootstrap.text());
  const boot=await bootstrap.json();
  run('kill-session',empty);
  await waitFor(async()=>!(await catalog()).some(s=>s.name===empty),'Ended session remains in catalog');
  const delayed=await writable.newPage();
  await delayed.route('**/session?*',route=>route.fulfill({json:boot}));
  await delayed.goto(url+'/'+empty);
  await waitFor(async()=>await delayed.evaluate(()=>!!window.__zjResumeFailure)||(await catalog()).some(s=>s.name===empty),'Delayed attachment did not settle');
  assert.ok(!(await catalog()).some(s=>s.name===empty),'Delayed viewer recreated the ended session');
  await delayed.close();
  for(const resumable of [false,true]){
    const stale=await writable.request.post(url+`/session?session=${encodeURIComponent(empty)}&resumable=${resumable}`);
    assert.equal(stale.status(),410,'A stale named URL cannot bootstrap a new session');
  }
  passed=true;console.log('PASS: authenticated Conversation creates tabs without attaching viewers, resizing the desktop or changing its focus; read-only/unshared access is rejected; a computer without a shared session can start its first one.');
  console.log('PASS: stale URLs and delayed retained viewers cannot recreate an ended session.');
}finally{
  if(!passed)try{const current=panes(session);fs.writeFileSync(path.join(dir,'panes.json'),JSON.stringify(current,null,2));for(const pane of current.filter(p=>!p.is_plugin))fs.writeFileSync(path.join(dir,`pane-${pane.id}.txt`),action(session,'dump-screen','-p',String(pane.id)));console.error('Fixture logs:',dir);}catch{}
  if(browser)await browser.close();
  if(web&&web.exitCode===null){const stopped=new Promise(resolve=>web.once('exit',resolve));if(process.platform==='win32')execFileSync('taskkill',['/pid',String(web.pid),'/t','/f'],{stdio:'ignore'});else web.kill('SIGTERM');await Promise.race([stopped,sleep(5000).then(()=>{if(web.exitCode===null)web.kill('SIGKILL');})]);}
  for(const name of [session,empty])try{run('kill-session',name);}catch{}
  for(const name of tokens)try{run('web','--revoke-token',name);}catch{}
  if(passed)fs.rmSync(dir,{recursive:true,force:true});
}})().catch(error=>{console.error(error);process.exitCode=1;});
