// Opt-in executable check. Uses a private loopback board and two synthetic machine
// credentials, with no terminal sessions, installed services or visible browsers.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const net=require('node:net');
const {spawn}=require('node:child_process');
const binary=process.env.SWITCHBOARD_TEST_BINARY;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function port(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const value=socket.address().port;await new Promise(resolve=>socket.close(resolve));return value;}
async function stop(child){
  if(!child?.pid||child.exitCode!==null||child.signalCode!==null)return;
  const done=new Promise(resolve=>child.once('exit',resolve));
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.kill('SIGTERM');
  await done;clearTimeout(timer);
}
test('message board CLI exchanges multiline threads, preserves delivery across restart, and fails clearly offline',
  {skip:!binary&&'Set SWITCHBOARD_TEST_BINARY for the isolated executable check'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-board-'));
  let server;
  try{
    assert.ok(fs.existsSync(binary),'Choose an existing test executable');
    const address='http://127.0.0.1:'+await port(),hostConfig=path.join(dir,'host.json');
    const credentials=['mac','windows'].map(id=>({id,name:id==='mac'?'Mac':'Windows',token:crypto.randomBytes(32).toString('hex')}));
    const clients={};
    for(const machine of credentials){
      const tokenFile=path.join(dir,machine.id+'.token');fs.writeFileSync(tokenFile,machine.token,{mode:0o600});
      clients[machine.id]=path.join(dir,machine.id+'.json');
      fs.writeFileSync(clients[machine.id],JSON.stringify({url:address,token_file:tokenFile}),{mode:0o600});
    }
    fs.writeFileSync(hostConfig,JSON.stringify({listen:new URL(address).host,database:path.join(dir,'board.sqlite3'),
      machines:credentials.map(({id,name})=>({id,name,token_file:path.join(dir,id+'.token')}))}),{mode:0o600});
    async function start(){
      server=spawn(path.resolve(binary),['message','serve','--board-config',hostConfig],{windowsHide:true,stdio:['ignore','ignore','pipe']});
      let startupError='';server.stderr.on('data',data=>startupError+=data);
      const until=Date.now()+15000;
      while(Date.now()<until){
        if(server.exitCode!==null)throw Error('Private board failed to start: '+startupError);
        try{if((await fetch(address+'/api/message-board/health',{headers:{Authorization:'Bearer '+credentials[0].token},signal:AbortSignal.timeout(1000)})).ok)return;}catch{}
        await sleep(100);
      }
      throw Error('Private board startup timed out');
    }
    async function invoke(machine,args,input){
      const child=spawn(path.resolve(binary),['message','--board-config',clients[machine],'--json',...args],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,SWITCHBOARD_AGENT_SESSION:''}});
      let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
      const timer=setTimeout(()=>child.kill('SIGKILL'),20000);
      child.stdin.end(input);
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
      for(const credential of credentials)assert.ok(!stdout.includes(credential.token)&&!stderr.includes(credential.token),'A machine token must never reach CLI output');
      return {code,stdout,stderr,value:code===0?JSON.parse(stdout):null};
    }
    async function ok(machine,args,input){const result=await invoke(machine,args,input);assert.equal(result.code,0,result.stderr);return result.value;}
    await start();
    const a=await ok('mac',['register','--name','backend','--project','switchboard']);
    const directory=await ok('mac',['inboxes']);
    assert.equal(directory.machine_id,'mac');
    assert.deepEqual(directory.machines.find(m=>m.id==='windows').participants,[]);
    const computerArgs=['--agent-session',a.id,'send','--computer','windows','--send-key','computer-question'];
    const computerMessage=await ok('mac',computerArgs,'Computer question');
    assert.equal(computerMessage.deliveries[0].recipient_kind,'computer');
    assert.equal((await ok('mac',computerArgs,'Computer question')).id,computerMessage.id);
    assert.equal((await ok('mac',['inbox','--computer','windows'])).items[0].id,computerMessage.id);
    assert.equal((await invoke('mac',['unread','--computer','windows'])).code,1);
    assert.equal((await invoke('mac',['ack',computerMessage.id,'--computer','windows'])).code,1);
    assert.equal((await ok('windows',['unread','--computer','windows'])).items[0].id,computerMessage.id);
    const b=await ok('windows',['register','--name','reviewer','--project','switchboard']);
    const computerReply=await ok('windows',['--agent-session',b.id,'reply',computerMessage.id,'--send-key','computer-reply'],'Received on Windows');
    assert.equal(computerReply.thread_id,computerMessage.thread_id);
    const duplicate=await ok('windows',['register','--name','reviewer','--project','switchboard']);
    assert.notEqual(b.id,duplicate.id);
    const ambiguous=await invoke('mac',['--agent-session',a.id,'send','--to','reviewer','--send-key','ambiguous'],'Question');
    assert.equal(ambiguous.code,1);assert.ok(ambiguous.stderr.includes(b.id)&&ambiguous.stderr.includes(duplicate.id));
    const text='Question 🦀\nSecond line\r\n',bodyFile=path.join(dir,'question.txt');fs.writeFileSync(bodyFile,text);
    const args=['--agent-session',a.id,'send','--to',b.id,'--body-file',bodyFile,'--send-key','question'];
    const sent=await ok('mac',args);assert.equal(sent.body,text);assert.equal(sent.sender_machine_name,'Mac');
    assert.equal((await ok('mac',args)).id,sent.id);
    for(let i=0;i<2;i++)assert.equal((await ok('windows',['--agent-session',b.id,'unread'])).items[0].id,sent.id);
    const impersonation=await invoke('mac',['--agent-session',b.id,'ack',sent.id]);assert.equal(impersonation.code,1);
    const reply=await ok('windows',['--agent-session',b.id,'reply',sent.id,'--send-key','reply'],'Answer\nYes');
    assert.equal(reply.thread_id,sent.thread_id);assert.equal(reply.deliveries[0].recipient,a.id);
    const acknowledgement=await ok('windows',['--agent-session',b.id,'ack',sent.id]);assert.ok(acknowledgement.acknowledged_at);
    await stop(server);await start();
    assert.equal((await ok('windows',['--agent-session',b.id,'unread'])).items.length,0);
    assert.equal((await ok('windows',['unread','--computer','windows'])).items[0].id,computerMessage.id);
    await ok('windows',['ack',computerMessage.id,'--computer','windows']);
    assert.equal((await ok('windows',['unread','--computer','windows'])).items.length,0);
    assert.ok((await ok('mac',['inbox','--computer','windows'])).items[0].deliveries[0].acknowledged_at);
    assert.equal((await ok('mac',['--agent-session',b.id,'inbox'])).items[0].id,sent.id);
    const thread=await ok('mac',['thread',sent.thread_id]);assert.equal(thread.items.length,2);
    assert.equal(thread.items[0].deliveries[0].acknowledged_at,acknowledgement.acknowledged_at);
    const replacement=await ok('windows',['register','--name','reviewer','--project','switchboard']);
    assert.equal((await ok('windows',['--agent-session',replacement.id,'unread'])).items.length,0);
    await stop(server);
    const offline=await invoke('mac',args);assert.equal(offline.code,1);assert.match(offline.stderr,/Configured board is unavailable/);
    assert.equal(fs.readFileSync(bodyFile,'utf8'),text);
  }finally{await stop(server);fs.rmSync(dir,{recursive:true,force:true});}
});
