// Opt-in: real Codex TUI, private Zellij engine/relay, fake loopback Responses server.
// SWITCHBOARD_TEST_CODEX=/path/to/codex node codex-user-queue.test.cjs /path/to/zellij
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const codex=process.env.SWITCHBOARD_TEST_CODEX||process.env.CODEX_TEST_BINARY;
if(!codex){console.log('SKIP: set SWITCHBOARD_TEST_CODEX for the private native queue acceptance test');process.exit(0);}
const binary=path.resolve(process.argv[2]);
const root=fs.mkdtempSync(path.join(process.platform==='win32'?os.tmpdir():'/tmp','sbq-'));
const name='user-queue-'+path.basename(root),home=path.join(root,'codex'),config=path.join(root,'config.kdl');
fs.mkdirSync(home);
fs.writeFileSync(config,'web_sharing "on"\nweb_server false\nshow_startup_tips false\nsession_serialization false\n');
const env={...process.env,CODEX_HOME:home,HOME:root,USERPROFILE:root,APPDATA:path.join(root,'AppData','Roaming'),LOCALAPPDATA:path.join(root,'AppData','Local'),XDG_DATA_HOME:path.join(root,'data'),XDG_CACHE_HOME:path.join(root,'cache'),ZELLIJ_SOCKET_DIR:path.join(root,'sockets'),ZELLIJ_CONFIG_FILE:config,SWITCHBOARD_TERMINAL_HOST:'0',SWITCHBOARD_FIXTURE_KEY:'local-fixture-only',TERM:'xterm-256color'};
env.PATH=path.dirname(codex)+path.delimiter+process.env.PATH;
for(const k of ['CODEX_THREAD_ID','ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_PANE_ID','CLAUDECODE','OPENAI_API_KEY','OPENAI_BASE_URL','SWITCHBOARD_AGENT_SESSION'])delete env[k];
for(const d of [env.APPDATA,env.LOCALAPPDATA,env.ZELLIJ_SOCKET_DIR])fs.mkdirSync(d,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function cli(...args){
  const file=path.join(root,'cli.log'),fd=fs.openSync(file,'w');
  try{const r=spawnSync(binary,['--config',config,...args],{env,cwd:root,windowsHide:true,timeout:15000,stdio:['ignore',fd,fd]});if(r.error)throw r.error;assert.equal(r.status,0,'Fixture CLI failed');return fs.readFileSync(file,'utf8');}
  finally{fs.closeSync(fd);if(args.includes('--create-token'))fs.writeFileSync(file,'[credential output omitted]\n');}
}
function start(args,label,extra={}){const fd=fs.openSync(path.join(root,label+'.log'),'a');try{return spawn(binary,args,{env:{...env,...extra},cwd:root,windowsHide:true,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}}
async function stop(child){if(!child||child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
async function port(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function until(check,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await check())return;await sleep(100);}throw Error('Timed out: '+label);}
function transcript(){const dir=path.join(home,'sessions');if(!fs.existsSync(dir))return null;const file=fs.readdirSync(dir,{recursive:true}).map(n=>path.join(dir,n)).find(n=>n.endsWith('.jsonl'));if(!file)return null;return {file,rows:fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}})};}
function userInputs(){return (transcript()?.rows||[]).filter(r=>r.type==='event_msg'&&r.payload?.item?.type==='UserMessage').map(r=>r.payload.item.content.map(p=>p.text||'').join('\n'));}
let requests=0,created=false,native,relay;
const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{
  if(!req.url.startsWith('/v1/responses')){res.writeHead(404).end();return;}
  const n=++requests,item={id:'msg_'+n,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture reply '+n,annotations:[]}]};
  const result={id:'resp_'+n,object:'response',status:'completed',model:'fixture',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
  const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'Fixture reply '+n},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}];
  res.writeHead(200,{'Content-Type':'text/event-stream'}).end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''));
});});
(async()=>{console.log('Private fixture:',root);try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const opts=['--no-daemon','--no-alt-screen','--dangerously-bypass-approvals-and-sandbox','--dangerously-bypass-hook-trust','-c','model_provider="fixture"','-c','model="fixture"','-c','model_providers.fixture.name="Fixture"','-c',`model_providers.fixture.base_url="http://127.0.0.1:${server.address().port}/v1"`,'-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.env_key="SWITCHBOARD_FIXTURE_KEY"','-c','model_providers.fixture.requires_openai_auth=false','-c','model_providers.fixture.supports_websockets=false','-c','check_for_update_on_startup=false','-c','tui.screen_reader_detection_done=true','-c',`projects."${root.replaceAll('\\','/')}".trust_level="trusted"`,'Fixture initial prompt'];
  cli('attach','--create-background',name,'--',codex,...opts);created=true;
  await until(()=>requests>=1&&transcript()?.rows.some(r=>JSON.stringify(r).includes('Fixture reply 1')),'initial turn');
  const thread=transcript().rows.find(r=>r.type==='session_meta').payload.id;
  const pane=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>!p.is_plugin);
  fs.writeFileSync(config,fs.readFileSync(config,'utf8').replace('web_sharing "off"','web_sharing "on"'));
  const tokenLine=cli('web','--create-token').split('\n').find(line=>line.includes(': '));assert.ok(tokenLine);
  const token=path.join(root,'token');fs.writeFileSync(token,tokenLine.slice(tokenLine.indexOf(': ')+2).trim(),{mode:0o600});
  const nativePort=await port(),relayPort=await port(),origin='http://127.0.0.1:'+relayPort;
  const hosts=path.join(root,'hosts.json');fs.writeFileSync(hosts,JSON.stringify({hosts:[{id:'fixture',name:'Private fixture',url:'http://127.0.0.1:'+nativePort,token_file:token,zellij_binary:binary,escape_transport:'local'}]}));
  native=start(['--config',config,'web','--port',String(nativePort)],'native');
  const launch=()=>start(['serve','--host-config',hosts,'--port',String(relayPort)],'relay');
  relay=launch();
  const ready=()=>until(async()=>{try{return (await (await fetch(origin+'/api/hosts/fixture')).json()).sessions?.some(s=>s.name===name);}catch{return false;}},'private relay');await ready();
  const hook=async()=>assert.equal((await fetch(origin+'/api/agent-hook',{method:'POST',headers:{'Content-Type':'application/json','x-agent':'codex','x-zellij-session':name,'x-zellij-pane':String(pane.id)},body:JSON.stringify({hook_event_name:'Stop',session_id:thread,transcript_path:transcript().file,cwd:root})})).status,204);
  await hook();
  cli('-s',name,'action','paste','-p',String(pane.id),'Private unsent terminal draft');
  const screen=()=>{const text=cli('-s',name,'action','dump-screen','-p',String(pane.id));fs.writeFileSync(path.join(root,'screen.txt'),text);return text.replace(/\s+/g,' ');};
  await until(()=>screen().includes('Private unsent terminal draft'),'terminal draft');
  const send=async(key,message)=>{const began=performance.now();const response=await fetch(origin+'/api/hosts/fixture/codex/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread,message,send_key:key})});return {code:response.status,body:await response.json(),ack_ms:Math.round(performance.now()-began)};};
  const first='Don’t lose ‘quotes’ — 東京 🦀\nsecond line',second='<send_user_message_question_reply>\n'+JSON.stringify([{questionItemId:'fixture-question',question:'Shouldn’t this work?',answer:'Yes 🦀'}])+'\n</send_user_message_question_reply>';
  // Repeat one send key and restart the relay before the next submission.
  let started=Date.now();const a=await send('first',first);assert.equal(a.code,200);assert.equal(a.body.status,'queued');
  await until(()=>userInputs().includes(first),'exact Unicode native input');const cold_ms=Date.now()-started;
  assert.equal((await send('first',first)).code,200);
  assert.equal((await send('first','different')).body.status,'conflict');
  await stop(relay);relay=launch();await ready();await hook();
  started=Date.now();const b=await send('second',second);assert.equal(b.code,200);await until(()=>userInputs().includes(second),'question answer after relay restart');const restart_ms=Date.now()-started;
  started=Date.now();const c=await send('third','Warm native message');await until(()=>userInputs().includes('Warm native message'),'warm persistent sender');const warm_ms=Date.now()-started;
  await sleep(300);
  const inputs=userInputs();assert.equal(inputs.filter(t=>t===first).length,1);assert.equal(inputs.filter(t=>t===second).length,1);assert.ok(inputs.indexOf(first)<inputs.indexOf(second));
  assert.ok(screen().includes('Private unsent terminal draft'),'Native queue must preserve the terminal draft');
  const result={cold_ms,restart_ms,warm_ms,ack_ms:[a.ack_ms,b.ack_ms,c.ack_ms],pass:true};fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result));console.log('PASS:',JSON.stringify(result));
}finally{
  await stop(relay);await stop(native);if(created)cli('kill-session',name);
  server.closeAllConnections();await new Promise(r=>server.close(r));console.log('Private fixture stopped');
}})().catch(e=>{console.error(e);process.exitCode=1;});
