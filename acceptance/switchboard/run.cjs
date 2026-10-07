#!/usr/bin/env node
// Reuse the existing behavior tests. Never attach automation to a user's session.
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'../..');
const [suite='ui',...args]=process.argv.slice(2);
const node=process.execPath;
const env={...process.env};
const commands={
  ui:()=>[[node,'--test',...['sidebar','sidebar-ux','focus','startup','new-tab','bridge','viewport','clipboard','escape','close','titles','links'].map(name=>'tools/switchboard/'+name+'.test.cjs')]],
  messages:()=>[[node,'--test','tools/switchboard/messages.test.cjs']],
  relay:()=>[['cargo','test','-p','zellij-client','--features','web_server_capability','switchboard_relay','--lib']],
  colours:()=>[['cargo','test','-p','zellij-server','windows_pane_environment_advertises_colour_without_overriding_preferences','--lib']],
  recovery:()=>['recover_local','browser_readiness','install_service'].map(name=>[process.env.PYTHON_BINARY||'python3','tools/switchboard/'+name+'.test.py']),
  browser:()=>{
    if(process.platform!=='darwin'||args.length!==2)throw Error('browser requires macOS and OLD_BINARY NEW_BINARY');
    env.SWITCHBOARD_TEST_RUST_RELAY='1';
    return [[node,'tools/switchboard/update_browser.test.cjs',...args.map(value=>path.resolve(value))]];
  },
  sharing:()=>{
    if(process.platform==='win32'||args.length!==1)throw Error('sharing requires Unix and BINARY');
    return [[node,'tools/switchboard/sharing_native.test.cjs',path.resolve(args[0])]];
  },
  switching:()=>{
    if(process.platform==='win32'||args.length!==1)throw Error('switching requires Unix and BINARY (private recovered terminals)');
    return [[node,'tools/switchboard/tab_switch_native.test.cjs',path.resolve(args[0])]];
  },
  update:()=>{
    if(process.platform!=='darwin'||args.length!==2)throw Error('update requires macOS and OLD_BINARY NEW_BINARY');
    return [[node,'tools/switchboard/update_local.test.cjs',...args.map(value=>path.resolve(value))]];
  },
  'windows-update':()=>['windows_releases','windows_tray'].map(name=>[process.env.POWERSHELL_BINARY||(process.platform==='win32'?'powershell.exe':'pwsh'),'-NoLogo','-NoProfile','-NonInteractive','-File','tools/switchboard/'+name+'.test.ps1']),
  'windows-browser':()=>{
    if(process.platform!=='win32'||args.length!==2)throw Error('windows-browser requires Windows and distinct OLD_BINARY NEW_BINARY');
    return [[node,'tools/switchboard/update_windows_browser.test.cjs',...args.map(value=>path.resolve(value))]];
  },
  windows:()=>{
    if(args.length!==3)throw Error('windows requires BINARY HOSTS_JSON HOST_ID (creates disposable remote sessions)');
    return [[node,'tools/switchboard/relay_remote.test.cjs',path.resolve(args[0]),path.resolve(args[1]),args[2]]];
  },
};
try{
  if(suite==='--list'){console.log(Object.keys(commands).join('\n'));process.exit(0);}
  if(!commands[suite])throw Error('Unknown suite. Use --list.');
  if(!['browser','sharing','switching','update','windows','windows-browser'].includes(suite)&&args.length)throw Error('This suite takes no arguments.');
  for(const command of commands[suite]()){
    console.log('\nRunning '+command.slice(0,3).join(' '));
    const result=spawnSync(command[0],command.slice(1),{cwd:root,env,stdio:'inherit',windowsHide:true});
    if(result.error)throw result.error;
    if(result.status!==0)process.exit(result.status||1);
  }
}catch(error){console.error(error.message);process.exitCode=2;}
