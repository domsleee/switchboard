// Private board, synthetic agent events and native queue stub. No live panes or agents.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const http=require('node:http');
const {spawn}=require('node:child_process');
const binary=process.env.SWITCHBOARD_TEST_BINARY;
const children=new Set();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check,label){const until=Date.now()+15000;while(Date.now()<until){if(await check())return;await sleep(50);}throw Error('Timed out: '+label);}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await done;clearTimeout(timer);}
function run(args,env,input,pauseStderr=false){
  const child=spawn(path.resolve(binary),args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  children.add(child);
  const timer=args.includes('serve')?null:setTimeout(()=>child.kill('SIGKILL'),20000);
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end(input);
  if(pauseStderr)child.stderr.pause();
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{clearTimeout(timer);children.delete(child);resolve({code,stdout,stderr});});});
  return {child,done};
}
test('agent hooks deliver and reply across machines, suppress duplicates, preserve receipts and wake idle agents',
  {skip:!binary&&'Set SWITCHBOARD_TEST_BINARY for the isolated executable check',timeout:90000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-message-hooks-'));
  let board,watcher;
  try{
    const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
    const origin='http://127.0.0.1:'+port,clients={},tokens={};
    for(const id of ['mac','windows']){
      tokens[id]=crypto.randomBytes(32).toString('hex');
      const token=path.join(root,id+'.token');fs.writeFileSync(token,tokens[id],{mode:0o600});
      clients[id]=path.join(root,id+'.json');fs.writeFileSync(clients[id],JSON.stringify({url:origin,token_file:token}));
    }
    const config=path.join(root,'host.json');fs.writeFileSync(config,JSON.stringify({listen:'127.0.0.1:'+port,database:path.join(root,'board.db'),machines:['mac','windows'].map(id=>({id,name:id,token_file:path.join(root,id+'.token')}))}));
    async function api(machine,resource,body){
      const response=await fetch(origin+'/api/message-board/'+resource,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+tokens[machine],'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
      assert.equal(response.status,200,await response.clone().text());return response.json();
    }
    board=run(['message','serve','--board-config',config],process.env).child;
    await waitFor(async()=>{try{return(await fetch(origin+'/api/message-board/health',{headers:{Authorization:'Bearer '+tokens.mac},signal:AbortSignal.timeout(500)})).ok;}catch{return false;}},'private board startup');
    const base={...process.env,SWITCHBOARD_RELAY_URL:origin,SWITCHBOARD_MESSAGE_STATE_DIR:path.join(root,'state'),SWITCHBOARD_MESSAGE_PROJECT:'switchboard',ZELLIJ_SESSION_NAME:'fixture',ZELLIJ_PANE_ID:'17'};
    delete base.CLAUDECODE;delete base.CODEX_THREAD_ID;delete base.SWITCHBOARD_AGENT_SESSION;
    const ids={claude:crypto.randomUUID(),codex:crypto.randomUUID()};
    function hook(agent,event='PostToolUse',wait=false,override={}){
      const {session=ids[agent],machine=agent==='claude'?'windows':'mac',...extra}=override;
      // Claude Code sets CLAUDECODE=1 for its own hooks.
      const env={...base,SWITCHBOARD_BOARD_CONFIG:clients[machine],...(agent==='claude'?{CLAUDECODE:'1',CLAUDE_CODE_ENTRYPOINT:'cli'}:{}),...extra};
      return run(['agent-hook','--agent',agent,...(wait?['--wait']:[])],env,JSON.stringify({session_id:session,cwd:root,hook_event_name:event}));
    }
    async function sync(...args){const r=await hook(...args).done;assert.equal(r.code,0,r.stderr);return r.stdout?JSON.parse(r.stdout):null;}
    const aStart=await sync('codex','SessionStart'),bStart=await sync('claude','SessionStart');
    const a=(await api('mac','participants')).items.find(p=>p.name==='codex-'+ids.codex.slice(0,8));
    const b=(await api('windows','participants')).items.find(p=>p.name==='claude-'+ids.claude.slice(0,8));
    assert.ok(aStart.hookSpecificOutput.additionalContext.includes(a.id));assert.ok(bStart.hookSpecificOutput.additionalContext.includes(b.id));
    const send=(sender,to,body,key=crypto.randomUUID(),computer=false)=>api(sender.machine_id,'messages',{sender:sender.id,send_key:key,body,...(computer?{to_machine:to}:{to})});
    const question=await send(a,b.id,'Check the logs 🦀\nsecond line');
    const delivered=await sync('claude');assert.ok(delivered.hookSpecificOutput.additionalContext.includes(question.id));assert.ok(delivered.hookSpecificOutput.additionalContext.includes('Check the logs'));
    assert.equal(await sync('claude'),null,'normal hooks do not inject the same mail repeatedly');
    let unread=await api('windows',`participants/${b.id}/unread`);assert.equal(unread.items[0].id,question.id);assert.equal(unread.items[0].deliveries[0].acknowledged_at,null);
    assert.ok(unread.items[0].deliveries[0].delivered_at>0,'senders can see the hook handed the mail over');
    const answer=await api('windows','messages',{sender:b.id,send_key:'reply',body:'The terminal pipe closed',reply_to:question.id});
    const stopReply=await sync('codex','Stop');assert.equal(stopReply.decision,'block');assert.ok(stopReply.reason.includes(answer.id));
    await api('windows',`participants/${b.id}/ack/${question.id}`,{});
    const concurrent=await send(a,b.id,'One delivery with simultaneous tools');
    const simultaneous=await Promise.all(Array.from({length:4},()=>sync('claude')));
    assert.equal(simultaneous.filter(r=>JSON.stringify(r)?.includes(concurrent.id)).length,1);
    const computer=await send(a,'windows','Computer inbox question',undefined,true);
    const other=crypto.randomUUID();const machineDelivery=await sync('claude','SessionStart',false,{session:other,SWITCHBOARD_MESSAGE_PROJECT:'other-project'});
    assert.ok(JSON.stringify(machineDelivery).includes(computer.id),'computer-addressed mail reaches an agent even in another project');
    assert.equal(await sync('claude','PostToolUse',false,{session:other,SWITCHBOARD_MESSAGE_PROJECT:'other-project'}),null);
    assert.equal(await sync('claude'),null,'computer mail is delivered to one local agent');
    const sibling=crypto.randomUUID();const siblingStart=await sync('claude','SessionStart',false,{session:sibling});
    assert.ok(!JSON.stringify(siblingStart).includes(computer.id),'computer mail wakes one local agent');
    assert.equal((await api('windows','machines/windows/unread')).items[0].deliveries[0].acknowledged_at,null);
    // Claude's native asyncRewake contract: a background hook exits 2 with context.
    watcher=hook('claude','Stop',true);await sleep(200);
    const duplicate=await hook('claude','Stop',true).done;assert.equal(duplicate.code,0);assert.equal(duplicate.stderr,'');
    const wake=await send(a,b.id,'Wake the idle Claude');
    const woken=await watcher.done;assert.equal(woken.code,2);assert.ok(woken.stderr.includes(wake.id));assert.equal(woken.stdout,'');watcher=null;
    assert.equal(await sync('claude'),null);
    // Codex uses the native queue, with failed queue attempts leaving mail deliverable.
    const bin=path.join(root,'bin');fs.mkdirSync(bin);const calls=path.join(root,'queue.jsonl'),fail=path.join(root,'fail');fs.writeFileSync(fail,'');
    const stub=path.join(bin,'queue.cjs');fs.writeFileSync(stub,`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.exit(fs.existsSync(${JSON.stringify(fail)})?1:0);`);
    const launcher=path.join(bin,process.platform==='win32'?'codex.cmd':'codex');fs.writeFileSync(launcher,process.platform==='win32'?`@"${process.execPath}" "${stub}" %*\r\n`:`#!/bin/sh\nexec '${process.execPath.replaceAll("'","'\\''")}' '${stub.replaceAll("'","'\\''")}' "$@"\n`,{mode:0o755});
    const queueEnv={PATH:bin+path.delimiter+process.env.PATH};
    watcher=hook('codex','Stop',true,queueEnv);const queued=await send(b,a.id,'Wake Codex without putting this body into argv');
    await waitFor(()=>fs.existsSync(calls),'failed native queue attempt');
    assert.ok((await api('mac',`participants/${a.id}/unread`)).items.some(m=>m.id===queued.id));
    fs.unlinkSync(fail);const accepted=await watcher.done;assert.equal(accepted.code,0);watcher=null;
    const argv=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);assert.ok(argv.length>=2);assert.deepEqual(argv.at(-1).slice(0,4),['queue','--thread',ids.codex,'--message']);assert.ok(argv.at(-1)[4].includes(queued.id));assert.ok(!argv.at(-1)[4].includes('without putting this body'));
    assert.equal(await sync('codex'),null,'queued notification is not repeated by the next hook');
    // A replacement conversation in the same pane has a fresh identity and inbox.
    const old=await send(a,b.id,'Old conversation only');const replacement=crypto.randomUUID();
    const newStart=await sync('claude','SessionStart',false,{session:replacement});assert.ok(!JSON.stringify(newStart).includes(old.id));
    const participants=(await api('windows','participants')).items;const newAgent=participants.find(p=>p.name==='claude-'+replacement.slice(0,8));assert.notEqual(newAgent.id,b.id);
    watcher=hook('claude','Stop',true,{session:replacement});await sleep(200);
    await sync('claude','SessionEnd',false,{session:replacement});
    assert.equal((await watcher.done).code,0,'ending a session stops its watcher without a wake-up');watcher=null;
    await sync('claude','SessionEnd');assert.ok(!(await api('windows','participants')).items.some(p=>p.id===b.id));
    const resumed=await sync('claude','SessionStart');assert.ok(JSON.stringify(resumed).includes(b.id));assert.ok(JSON.stringify(resumed).includes(old.id));
    const nested=await hook('claude','SessionStart',false,{session:crypto.randomUUID(),CLAUDE_CODE_ENTRYPOINT:'sdk-cli'}).done;assert.equal(nested.code,0);assert.equal(nested.stdout,'');
    await stop(board);board=null;
    const offline=await hook('codex').done;assert.equal(offline.code,0);assert.equal(offline.stdout,'','offline messaging never blocks the agent');
  }finally{await stop(watcher?.child);await stop(board);for(const child of children)await stop(child);fs.rmSync(root,{recursive:true,force:true});}
});

test('SessionEnd hands retirement to a watcher holding the session lock',
  {skip:!binary&&'Set SWITCHBOARD_TEST_BINARY for the isolated executable check',timeout:30000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-hook-end-'));
  const session=crypto.randomUUID(),participant={id:crypto.randomUUID(),cursor:1,machine_id:'fixture',machine_name:'Fixture',name:'agent',project:'fixture',terminal:null,active:true,created_at:1};
  let hold=false,reading=false,release,retirements=0,watcher,mail=false,statusDelay=0,registrationOffline=false,registrationFailures=0;
  const messages=Array.from({length:20},(_,index)=>({cursor:index+1,id:crypto.randomUUID(),sender:crypto.randomUUID(),sender_name:'peer',sender_machine_id:'other',sender_machine_name:'Other',project:'fixture',thread_id:crypto.randomUUID(),reply_to:null,body:'🦀'.repeat(1600),created_at:1,deliveries:[]}));
  const barrier=new Promise(resolve=>release=resolve);
  const server=http.createServer(async(req,res)=>{
    req.resume();
    if(req.url==='/api/agent-hook'){if(statusDelay)await sleep(statusDelay);res.writeHead(204).end();return;}
    let value;
    if(req.url==='/api/message-board/participants'){if(registrationOffline){registrationFailures++;res.writeHead(503).end('{}');return;}value=participant;}
    else if(req.url.endsWith('/retire')){retirements++;value={...participant,active:false};}
    else {
      if(hold&&req.url.includes('/participants/')){reading=true;await barrier;}
      value={items:mail?(req.url.includes('/machines/')?messages.slice(10):messages.slice(0,10)):[],next_cursor:null};
    }
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(value));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,config=path.join(root,'client.json'),token=path.join(root,'token');
  fs.writeFileSync(token,'f'.repeat(64));fs.writeFileSync(config,JSON.stringify({url:origin,token_file:token}));
  const env={...process.env,SWITCHBOARD_BOARD_CONFIG:config,SWITCHBOARD_RELAY_URL:origin,SWITCHBOARD_MESSAGE_STATE_DIR:path.join(root,'state'),SWITCHBOARD_MESSAGE_PROJECT:'fixture',ZELLIJ_SESSION_NAME:'fixture',ZELLIJ_PANE_ID:'1'};
  delete env.CLAUDECODE;
  const hook=(event,wait=false,pause=false)=>run(['agent-hook','--agent','claude',...(wait?['--wait']:[])],env,JSON.stringify({session_id:session,cwd:root,hook_event_name:event}),pause);
  try{
    assert.equal((await hook('SessionStart').done).code,0);
    hold=true;watcher=hook('Stop',true);
    await waitFor(()=>reading,'watcher holds lock during its unread request');
    assert.equal((await hook('SessionEnd').done).code,0);
    assert.equal(retirements,0,'the end event arrived while the watcher still held the lock');
    release();
    assert.equal((await watcher.done).code,0,'retirement ends the watcher without waking Claude');watcher=null;
    assert.equal(retirements,1,'the watcher completes the contended retirement');
    const namespace=fs.readdirSync(path.join(root,'state'))[0];
    const state=JSON.parse(fs.readFileSync(path.join(root,'state',namespace,'claude-'+session+'.json'),'utf8'));
    assert.equal(state.participant.active,false);
    assert.equal((await hook('PostToolUse').done).stdout,'','late tools cannot reactivate an ended conversation');
    // The async hook can start before the synchronous resume reaches the board.
    statusDelay=300;
    const resuming=hook('SessionStart');watcher=hook('SessionStart',true);
    const resumed=await resuming.done;assert.ok(resumed.stdout.includes(participant.id),'explicit resume restores the same identity');
    await sleep(2200);
    assert.equal(watcher.child.exitCode,null,'resumed idle conversation keeps its watcher');
    assert.equal((await hook('SessionEnd').done).code,0);
    assert.equal((await watcher.done).code,0,'a later end still stops the initialized watcher');watcher=null;
    // Resume must recover without another user turn after registration fails.
    statusDelay=0;registrationOffline=true;
    await hook('SessionStart').done;watcher=hook('SessionStart',true);
    await waitFor(()=>registrationFailures>=2,'initial watcher retries offline resume registration');
    registrationOffline=false;
    await waitFor(()=>JSON.parse(fs.readFileSync(path.join(root,'state',namespace,'claude-'+session+'.json'),'utf8')).participant.active,'watcher restores identity after the board recovers');
    await hook('SessionEnd').done;assert.equal((await watcher.done).code,0);watcher=null;
    await hook('SessionStart').done;
    // End during a blocked stderr write: already emitted context still needs
    // Claude's exit-2 wake signal even after completing retirement.
    // Exceed socket buffers as well as pipe buffers; body previews alone can
    // fit entirely in Linux's child-process socket buffer.
    for(const message of messages)message.sender_name='peer'.repeat(65536);
    hold=false;mail=true;const before=retirements;
    watcher=hook('Stop',true,true);
    await waitFor(()=>watcher.child.stderr.readableLength>0,'watcher emitting context into the paused pipe');
    assert.equal(watcher.child.exitCode,null,'large context keeps the emitter in progress');
    assert.equal((await hook('SessionEnd').done).code,0);
    assert.equal(retirements,before,'retirement waits for the emitting lock owner');
    watcher.child.stderr.resume();
    const emitted=await watcher.done;watcher=null;
    assert.equal(emitted.code,2,'emitted context must retain the native wake signal');
    assert.ok(emitted.stderr.includes(messages[19].id));
    assert.equal(retirements,before+1);
  }finally{release();await stop(watcher?.child);for(const child of children)await stop(child);await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('a watcher whose agent exits without SessionEnd retires the identity and stops',
  {skip:!binary&&'Set SWITCHBOARD_TEST_BINARY for the isolated executable check',timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-hook-orphan-'));
  const session=crypto.randomUUID(),participant={id:crypto.randomUUID(),cursor:0,machine_id:'fixture',machine_name:'Fixture',name:'agent',project:'fixture',terminal:null,active:true,created_at:1};
  let retirements=0,agent;
  const server=http.createServer((req,res)=>{
    req.resume();
    let value={items:[],next_cursor:null};
    if(req.url==='/api/agent-hook'){res.writeHead(204).end();return;}
    if(req.url==='/api/message-board/participants')value=participant;
    else if(req.url.endsWith('/retire')){retirements++;value={...participant,active:false};}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(value));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port,config=path.join(root,'client.json'),token=path.join(root,'token');
  fs.writeFileSync(token,'f'.repeat(64));fs.writeFileSync(config,JSON.stringify({url:origin,token_file:token}));
  const env={...process.env,SWITCHBOARD_BOARD_CONFIG:config,SWITCHBOARD_RELAY_URL:origin,SWITCHBOARD_MESSAGE_STATE_DIR:path.join(root,'state'),SWITCHBOARD_MESSAGE_PROJECT:'fixture',ZELLIJ_SESSION_NAME:'fixture',ZELLIJ_PANE_ID:'1'};
  delete env.CLAUDECODE;
  const event=name=>JSON.stringify({session_id:session,cwd:root,hook_event_name:name});
  try{
    assert.equal((await run(['agent-hook','--agent','codex'],env,event('SessionStart')).done).code,0);
    // A stand-in agent starts the async watcher, then dies without a SessionEnd hook.
    const pidFile=path.join(root,'watcher.pid');
    // Windows otherwise kills the child in the stand-in agent's job on exit,
    // so the watcher never becomes orphaned and cannot exercise retirement.
    const script=`const c=require('node:child_process').spawn(${JSON.stringify(path.resolve(binary))},['agent-hook','--agent','codex','--wait'],{detached:process.platform==='win32',windowsHide:true,stdio:['pipe','ignore','ignore']});c.stdin.end(${JSON.stringify(event('SessionStart'))});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
    agent=spawn(process.execPath,['-e',script],{env,stdio:'ignore'});children.add(agent);
    await waitFor(()=>fs.existsSync(pidFile),'stand-in agent starts its watcher');
    const watcherPid=Number(fs.readFileSync(pidFile,'utf8'));
    await sleep(2500);
    assert.equal(retirements,0,'a live agent keeps its identity');
    agent.kill('SIGKILL');
    const exited=()=>{try{process.kill(watcherPid,0);return false;}catch{return true;}};
    const until=Date.now()+20000;while(Date.now()<until&&!exited())await sleep(100);
    assert.ok(exited(),'the watcher stops after its agent exits');
    assert.equal(retirements,1,'the dead agent no longer receives broadcasts');
  }finally{for(const child of children)await stop(child);await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
