// Isolated Codex homes only. Never installs or trusts hooks in the user's home.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
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
      assert.match(hook.commandWindows,/codex-agent-hook\.cmd/);
      assert.doesNotMatch(hook.commandWindows,/powershell/i,'Each hook would start another process');
      assert.equal(hook.args,undefined,'Codex does not support Claude exec-form args');
      if(hook.async){assert.ok(['SessionStart','Stop'].includes(event));assert.match(hook.command,/ --wait$/);assert.match(hook.commandWindows,/ --wait'$/);}
    }
  }
  assert.equal(total,9);
});

test('Windows hook command preserves Unicode stdin and message listener arguments',
  {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard codex wrapper-'));
  try{
    const launcherDir=path.join(root,'.local/share/switchboard');fs.mkdirSync(launcherDir,{recursive:true});
    const output=path.join(root,'event.json'),stub=path.join(root,'capture.cjs');
    fs.writeFileSync(stub,"const fs=require('node:fs');let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{fs.writeFileSync(process.env.HOOK_CAPTURE,JSON.stringify({input,args:process.argv.slice(2)}));process.stdout.write(input);});");
    fs.writeFileSync(path.join(launcherDir,'codex-agent-hook.cmd'),`@"${process.execPath}" "${stub}" %*\r\n`);
    const input=JSON.stringify({hook_event_name:'PostToolUse',cwd:'C:\\Users\\Zoë\\🦀',text:'東京\nsecond line'});
    for(const wait of [false,true]){
      const command=Object.values(config.hooks).flatMap(groups=>groups[0].hooks).map(hook=>hook.commandWindows).find(hook=>hook.includes('--wait')===wait);
      const result=spawnSync('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{env:{...process.env,USERPROFILE:root,HOOK_CAPTURE:output},input,encoding:'utf8',windowsHide:true,timeout:10000});
      assert.equal(result.status,0,result.stderr);
      const captured=JSON.parse(fs.readFileSync(output,'utf8'));
      assert.deepEqual(JSON.parse(captured.input),JSON.parse(input));
      assert.deepEqual(JSON.parse(result.stdout),JSON.parse(input));
      assert.deepEqual(captured.args,wait?['--wait']:[]);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('Codex discovers and executes its plugin hooks and reloads content trust',
  {skip:!codex&&'Set CODEX_TEST_BINARY for installed Codex integration',timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-codex-plugin-'));
  let child,relay,env;
  try{
    const events=[];
    relay=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      if(request.url==='/api/agent-hook'){events.push({event:JSON.parse(body),headers:request.headers});response.writeHead(204).end();}
      else if(request.url.startsWith('/v1/responses')){
        const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture reply',annotations:[]}]};
        const result={id:'resp_fixture',object:'response',status:'completed',model:'fixture',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
        const stream=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
          {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
          {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'Fixture reply'},
          {type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:result}];
        response.writeHead(200,{'Content-Type':'text/event-stream'}).end(stream.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      }else response.writeHead(404).end();
    });});
    await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+relay.address().port;
    env={...process.env,CODEX_HOME:root,HOME:root,USERPROFILE:root,ZELLIJ_SESSION_NAME:'plugin-fixture',ZELLIJ_PANE_ID:'7',SWITCHBOARD_FIXTURE_KEY:'local-fixture-only',
      APPDATA:path.join(root,'AppData/Roaming'),LOCALAPPDATA:path.join(root,'AppData/Local'),XDG_CACHE_HOME:path.join(root,'cache'),
      SWITCHBOARD_MESSAGE_STATE_DIR:path.join(root,'message-state'),SWITCHBOARD_RELAY_URL:origin,SWITCHBOARD_BOARD_CONFIG:path.join(root,'unconfigured-board.json')};
    fs.mkdirSync(env.APPDATA,{recursive:true});fs.mkdirSync(env.LOCALAPPDATA,{recursive:true});
    delete env.CLAUDECODE;delete env.SWITCHBOARD_AGENT_SESSION;delete env.CODEX_THREAD_ID;
    const launcherDir=path.join(root,'.local/share/switchboard');fs.mkdirSync(launcherDir,{recursive:true});
    const capture=path.join(root,'capture.cjs');
    fs.writeFileSync(capture,"const http=require('node:http');let body='';process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>{const r=http.request(process.env.SWITCHBOARD_RELAY_URL+'/api/agent-hook',{method:'POST',headers:{'x-agent':'codex','x-zellij-session':process.env.ZELLIJ_SESSION_NAME,'x-zellij-pane':process.env.ZELLIJ_PANE_ID}},res=>res.resume());r.end(body);});");
    const binary=process.env.SWITCHBOARD_TEST_BINARY;
    const target=binary?`"${path.resolve(binary)}" agent-hook --agent codex`:`"${process.execPath}" "${capture}"`;
    fs.writeFileSync(path.join(launcherDir,process.platform==='win32'?'codex-agent-hook.cmd':'codex-agent-hook'),
      process.platform==='win32'?`@${target} %*\r\n`:`#!/bin/sh\nexec ${target} "$@"\n`,{mode:0o755});
    for(const args of [['plugin','marketplace','add',repo],['plugin','add','switchboard@switchboard']]){
      const result=spawnSync(codex,args,{env,encoding:'utf8',windowsHide:true,timeout:20000});
      assert.equal(result.status,0,result.stderr+result.stdout);
    }
    child=spawn(codex,['app-server','-c','model_provider="fixture"','-c','model="fixture"',
      '-c','model_providers.fixture.name="Fixture"','-c',`model_providers.fixture.base_url="${origin}/v1"`,
      '-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.requires_openai_auth=false',
      '-c','model_providers.fixture.env_key="SWITCHBOARD_FIXTURE_KEY"','-c','model_providers.fixture.supports_websockets=false'],
      {env,cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});
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
    assert.equal(before.data.flatMap(entry=>entry.hooks).filter(h=>h.key.startsWith('switchboard@switchboard:')).length,9,'Claude hooks must not be inherited');
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
    const skill=path.join(root,'plugins/cache/switchboard/switchboard/local/skills/interactive/SKILL.md');
    const originalSkill=fs.readFileSync(skill);
    fs.appendFileSync(skill,'\n<!-- updated fixture skill -->\n');
    assert.ok(hooks(await list()).every(h=>h.trustStatus==='modified'),'Codex content trust includes skills, so Health must include them too');
    fs.writeFileSync(skill,originalSkill);
    assert.ok(hooks(await list()).every(h=>h.trustStatus==='trusted'));
    // Start a real Codex session with a local fake model and no credentials. Codex
    // itself must resolve PLUGIN_ROOT, run the platform command, and forward its
    // event through the launcher to a loopback relay with the pane environment.
    const thread=await call('thread/start',{model:'fixture',cwd:root,approvalPolicy:'never',sandbox:'danger-full-access'});
    await call('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Fixture prompt'}]});
    const deadline=Date.now()+20000;
    while(!events.some(item=>item.event.hook_event_name==='Stop')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
    const started=events.find(item=>item.event.hook_event_name==='SessionStart');
    assert.ok(started,'Codex must actually execute its plugin SessionStart hook: '+stderr);
    assert.equal(started.headers['x-agent'],'codex');
    assert.equal(started.headers['x-zellij-session'],'plugin-fixture');
    assert.equal(started.headers['x-zellij-pane'],'7');
    assert.ok(events.some(item=>item.event.hook_event_name==='UserPromptSubmit'));
    assert.ok(events.some(item=>item.event.hook_event_name==='Stop'),'Codex must complete the local fixture turn');
    await call('thread/archive',{threadId:thread.thread.id});
    // A changed hook requires fresh trust.
    const cached=path.join(root,'plugins/cache/switchboard/switchboard/local/hooks/codex.json');
    const changedConfig=JSON.parse(fs.readFileSync(cached,'utf8'));
    changedConfig.hooks.UserPromptSubmit[0].hooks[0].timeout+=1;
    fs.writeFileSync(cached,JSON.stringify(changedConfig));
    const changed=hooks(await list());
    assert.ok(changed.some(h=>h.trustStatus==='modified'),JSON.stringify(changed));
  }finally{
    if(child){await new Promise(resolve=>{
      if(child.exitCode!==null)return resolve();child.once('close',resolve);
      if(process.platform==='win32')spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();
      setTimeout(resolve,5000).unref();
    });}
    if(env)spawnSync(codex,['app-server','daemon','stop'],{env,cwd:root,windowsHide:true,timeout:5000});
    if(relay){relay.closeAllConnections();await new Promise(resolve=>relay.close(resolve));}
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

test('Codex refreshes an existing Git marketplace before replacing the old plugin',
  {skip:!codex&&'Set CODEX_TEST_BINARY for installed Codex integration',timeout:60000},async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-codex-git-'));
  const market=path.join(root,'market'),home=path.join(root,'codex');
  fs.mkdirSync(market);fs.mkdirSync(home);
  let server;
  const git=(...args)=>{
    const result=spawnSync('git',args,{cwd:market,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);return result.stdout;
  };
  const commit=()=>{git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture');git('update-server-info');};
  const run=args=>new Promise((resolve,reject)=>{
    const child=spawn(codex,args,{env:{...process.env,CODEX_HOME:home,GIT_TERMINAL_PROMPT:'0'},cwd:root,windowsHide:true});
    let output='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
    const timeout=setTimeout(()=>{child.kill();reject(Error('Codex Git fixture timed out: '+output));},20000);
    child.once('error',reject);child.once('close',code=>{clearTimeout(timeout);code===0?resolve():reject(Error(output));});
  });
  try{
    git('init','-b','fixture');
    fs.mkdirSync(path.join(market,'.agents/plugins'),{recursive:true});
    fs.copyFileSync(path.join(repo,'.agents/plugins/marketplace.json'),path.join(market,'.agents/plugins/marketplace.json'));
    const source=path.join(market,'plugins/switchboard');fs.cpSync(plugin,source,{recursive:true});
    fs.writeFileSync(path.join(source,'.codex-plugin/plugin.json'),JSON.stringify({name:'switchboard',skills:'./skills/',hooks:{hooks:{}}}));
    commit();
    const gitRoot=path.join(market,'.git');
    server=http.createServer((request,response)=>{
      const name=decodeURIComponent(new URL(request.url,'http://fixture').pathname).replace(/^\/market\.git\//,'');
      const file=path.resolve(gitRoot,name);
      if(!file.startsWith(gitRoot+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return response.writeHead(404).end();
      response.writeHead(200,{'Content-Type':name==='info/refs'?'text/plain':'application/octet-stream'}).end(fs.readFileSync(file));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin='http://127.0.0.1:'+server.address().port+'/market.git';
    const add=['plugin','marketplace','add',origin,'--ref','fixture','--sparse','.agents/plugins','--sparse','plugins'];
    await run(add);
    await run(['plugin','add','switchboard@switchboard']);
    const cached=path.join(home,'plugins/cache/switchboard/switchboard/local/.codex-plugin/plugin.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(cached,'utf8')).hooks,{hooks:{}});
    fs.copyFileSync(path.join(plugin,'.codex-plugin/plugin.json'),path.join(source,'.codex-plugin/plugin.json'));commit();
    await run(add);
    await run(['plugin','marketplace','upgrade','switchboard']);
    await run(['plugin','add','switchboard@switchboard']);
    assert.equal(JSON.parse(fs.readFileSync(cached,'utf8')).hooks,'./hooks/codex.json');
  }finally{
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
