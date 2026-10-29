// Opt-in Windows check with a private session and socket directory. It never
// restarts Windows, the web service or another engine.
// node restart_windows.test.cjs BINARY
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
if(!process.argv[2]||process.platform!=='win32'){
  require('node:test')('Windows restart keeps and restores every saved tab',
    {skip:'Pass the zellij.exe to check on Windows'},()=>{});
  return;
}
const binary=path.resolve(process.argv[2]);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'switchboard-restart-'));
const config=path.join(directory,'config.kdl'),sockets=path.join(directory,'sockets');
const name='restart-'+crypto.randomBytes(8).toString('hex');
const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const env={...process.env,ZELLIJ_SOCKET_DIR:sockets};
for(const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR','ZELLIJ_CONFIG_FILE'])delete env[key];
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const ps=source=>execFileSync(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ProgressPreference='SilentlyContinue';"+source,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
let call=0;
function cli(...args){
  // Background engines inherit standard handles. Files let the launcher exit
  // without waiting for a grandchild to close an inherited output pipe.
  const output=path.join(directory,`cli-${++call}.log`),errors=path.join(directory,`cli-${call}-error.log`);
  const out=fs.openSync(output,'w'),err=fs.openSync(errors,'w');
  try{execFileSync(binary,['--config',config,...args],{env,windowsHide:true,timeout:20000,stdio:['ignore',out,err]});return fs.readFileSync(output,'utf8');}
  catch(error){error.message+='\n'+fs.readFileSync(errors,'utf8');throw error;}
  finally{fs.closeSync(out);fs.closeSync(err);}
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message){for(let n=0;n<150;n++){try{if(await check())return;}catch{}await delay(100);}throw Error(message);}
// Only engines started with this test's private socket directory are touched.
const engines=()=>JSON.parse(ps(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'zellij.exe' -and $_.CommandLine.Contains('--server') -and $_.CommandLine.Contains(${quote(sockets)})} | Select-Object -ExpandProperty ProcessId) -Compress`));
function stop(pid,parent){
  const owner=parent?`(Get-CimInstance Win32_Process -Filter 'ProcessId=${parent}').CommandLine.Contains(${quote(sockets)}) -and $p.ParentProcessId -eq ${parent}`:`$p.CommandLine.Contains(${quote(sockets)})`;
  ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p -and ${owner}) { Stop-Process -Id $p.ProcessId -Force }`);
}
const cache=path.join(process.env.LOCALAPPDATA,'Zellij','cache','contract_version_1','session_info');
const layout=path.join(cache,name,'session-layout.kdl');
const tabNames=()=>[...fs.readFileSync(layout,'utf8').matchAll(/^\s*tab name="([^"]*)"/gm)].map(match=>match[1]);
const expected=['Fix startup','Review changes','Notes'];
(async()=>{
  try{
    fs.writeFileSync(config,`default_shell ${JSON.stringify(powershell)}\nshow_startup_tips false\nserialization_interval 1\n`);
    const agent=path.join(directory,'fixture.cjs');
    fs.writeFileSync(agent,"process.stdout.write('\\x1b]0;codex - Fix startup\\x07Fixture ready\\r\\n');setInterval(()=>{},1000);\n");
    cli('attach','--create-background',name,'--',process.execPath,agent);
    await until(()=>JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).some(pane=>pane.title==='codex - Fix startup'),'Fixture title did not arrive');
    cli('-s',name,'action','new-tab','--name','Review changes');
    cli('-s',name,'action','new-tab','--name','Notes');
    await until(()=>JSON.stringify(tabNames())===JSON.stringify(expected),'Automatic saves did not keep every tab and title');

    // Windows ends shells and agents before the engine, so their panes close
    // one by one. The engine must not save the shrinking layout.
    const panes=kdl=>(kdl.split(/^\s*new_tab_template\b/m)[0].match(/^\s*pane\b/gm)||[]).length;
    const livePanes=()=>panes(cli('-s',name,'action','dump-layout'));
    const savedPanes=()=>panes(fs.readFileSync(layout,'utf8'));
    assert.equal(savedPanes(),3);
    const [engine]=engines();assert.ok(engine,'Private engine not found');
    const children=JSON.parse(ps(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${engine}' | Where-Object {$_.Name -in 'node.exe','powershell.exe'} | Select-Object -ExpandProperty ProcessId) -Compress`));
    assert.equal(children.length,3,'Expected the agent and two shells');
    for(const child of children)stop(child,engine);
    await until(()=>JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(pane=>!pane.is_plugin).length===1,'Shell panes did not close');
    assert.equal(livePanes(),1,'The live layout should have lost the shell panes');
    await delay(4000);
    assert.deepEqual([tabNames(),savedPanes()],[expected,3],'Closing panes during a shutdown replaced the saved layout');
    stop(engine);
    await until(()=>engines().length===0,'Private engine did not exit');
    assert.deepEqual(tabNames(),expected);

    // With only --config and no default config directory, the saved layout loads.
    cli('attach','--create-background',name);
    await until(()=>JSON.parse(cli('-s',name,'action','list-tabs','--json')).length===3,'Saved tabs were not restored');
    assert.deepEqual(JSON.parse(cli('-s',name,'action','list-tabs','--json')).map(tab=>tab.name),expected);
    const restored=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(pane=>!pane.is_plugin);
    assert.ok(restored.find(pane=>pane.is_held),'The restored agent command stays suspended');
    console.log('PASS: closing panes during shutdown kept the saved layout, and all three tabs and the agent title were restored.');
  }finally{
    for(const engine of engines())stop(engine);
    const folder=path.resolve(cache,name);
    assert.equal(path.dirname(folder),path.resolve(cache));
    fs.rmSync(folder,{recursive:true,force:true});
    console.log('Fixture logs:',directory);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
