// Isolated Codex homes only. Never installs or trusts hooks in the user's home.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const repo=path.resolve(__dirname,'../..');
const plugin=path.join(repo,'plugins/switchboard');
const config=JSON.parse(fs.readFileSync(path.join(plugin,'hooks/codex.json'),'utf8'));
const codex=process.env.CODEX_TEST_BINARY;

test('Codex plugin selects described Codex hooks without inheriting Claude hooks',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.join(plugin,'.codex-plugin/plugin.json'),'utf8'));
  assert.equal(manifest.hooks,'./hooks/codex.json');
  assert.match(config.description,/Switchboard/);
  let total=0;
  for(const [event,groups] of Object.entries(config.hooks)){
    for(const hook of groups[0].hooks){
      total++;
      assert.match(hook.statusMessage,/Switchboard/);
      assert.match(hook.command,/codex-agent-hook/);
      assert.match(hook.commandWindows,/hooks\/codex\.ps1/);
      assert.equal(hook.args,undefined,'Codex does not support Claude exec-form args');
      if(hook.async){assert.ok(['SessionStart','Stop'].includes(event));assert.match(hook.command,/ --wait$/);assert.match(hook.commandWindows,/ -WaitForMessages$/);}
    }
  }
  assert.equal(total,9);
});

test('Windows plugin wrapper preserves Unicode stdin and message listener arguments',
  {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-codex-wrapper-'));
  try{
    const launcherDir=path.join(root,'.local/share/switchboard');fs.mkdirSync(launcherDir,{recursive:true});
    const output=path.join(root,'event.json'),stub=path.join(root,'capture.cjs');
    fs.writeFileSync(stub,"const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.writeFileSync(process.env.HOOK_CAPTURE,JSON.stringify({input,args:process.argv.slice(2)}));process.stdout.write(input);});");
    fs.writeFileSync(path.join(launcherDir,'codex-agent-hook.cmd'),`@"${process.execPath}" "${stub}" %*\r\n`);
    const input=JSON.stringify({hook_event_name:'PostToolUse',cwd:'C:\\Users\\Zoë\\🦀',text:'東京\nsecond line'});
    for(const wait of [false,true]){
      const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(plugin,'hooks/codex.ps1'),...(wait?['-WaitForMessages']:[])],{env:{...process.env,USERPROFILE:root,HOOK_CAPTURE:output},input,encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(result.status,0,result.stderr);
      const captured=JSON.parse(fs.readFileSync(output,'utf8'));
      assert.deepEqual(JSON.parse(captured.input),JSON.parse(input));
      assert.deepEqual(JSON.parse(result.stdout),JSON.parse(input));
      assert.deepEqual(captured.args,wait?['--wait']:[]);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('Codex discovers all nine plugin hooks and retains their trust after reloading',
  {skip:!codex&&'Set CODEX_TEST_BINARY for installed Codex integration',timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-codex-plugin-'));
  let child;
  try{
    const env={...process.env,CODEX_HOME:root};
    for(const args of [['plugin','marketplace','add',repo],['plugin','add','switchboard@switchboard']]){
      const result=spawnSync(codex,['--no-daemon',...args],{env,encoding:'utf8',windowsHide:true,timeout:20000});
      assert.equal(result.status,0,result.stderr+result.stdout);
    }
    child=spawn(codex,['--no-daemon','app-server'],{env,cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let buffer='',next=0,stderr='';const pending=new Map();
    child.stderr.on('data',data=>stderr+=data);
    child.stdout.on('data',data=>{
      buffer+=data;let newline;
      while((newline=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let response;try{response=JSON.parse(line);}catch{continue;}
        const request=pending.get(response.id);if(!request)continue;pending.delete(response.id);
        if(response.error)request.reject(Error(JSON.stringify(response.error)));else request.resolve(response.result);
      }
    });
    child.on('exit',code=>{for(const request of pending.values())request.reject(Error(`Codex exited ${code}: ${stderr}`));pending.clear();});
    const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
    await call('initialize',{clientInfo:{name:'switchboard-hook-fixture',version:'1'}});
    child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
    const list=()=>call('hooks/list',{cwds:[]});
    const hooks=result=>result.data.flatMap(entry=>entry.hooks).filter(h=>h.key.startsWith('switchboard@switchboard:hooks/codex.json:'));
    const before=await list();
    const discovered=hooks(before);
    assert.equal(discovered.length,9,JSON.stringify(before));
    assert.ok(discovered.every(h=>h.trustStatus==='untrusted'));
    const edits=Object.fromEntries(discovered.map(h=>[h.key,{trusted_hash:h.currentHash}]));
    await call('config/batchWrite',{edits:[{keyPath:'hooks.state',value:edits,mergeStrategy:'upsert'}],reloadUserConfig:true});
    const after=hooks(await list());
    assert.equal(after.length,9);
    assert.ok(after.every(h=>h.trustStatus==='trusted'),JSON.stringify(after));
    assert.ok(after.every(h=>h.source==='plugin'&&h.statusMessage.includes('Switchboard')));
    assert.match(fs.readFileSync(path.join(root,'config.toml'),'utf8'),/trusted_content_hash/);
    // A changed bundled script requires fresh trust even with the same command.
    const script=path.join(root,'plugins/cache/switchboard/switchboard/local/hooks/codex.ps1');
    fs.appendFileSync(script,'\n# fixture changed script\n');
    const changed=hooks(await list());
    assert.ok(changed.some(h=>h.trustStatus==='modified'),JSON.stringify(changed));
  }finally{
    if(child){child.stdin.end();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('close',resolve);setTimeout(()=>{if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();resolve();},2000).unref();});}
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
