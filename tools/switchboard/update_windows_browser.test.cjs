// Opt-in Windows acceptance. Only this run's private session/connection services
// are started/stopped. No tray, startup shortcut, live service or user shell is used.
// Usage: PLAYWRIGHT_MODULE=... node update_windows_browser.test.cjs OLD_BINARY NEW_BINARY
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
assert.equal(process.platform, 'win32', 'This acceptance runner requires Windows');
assert.equal(process.argv.length, 4, 'Pass OLD_BINARY NEW_BINARY');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const oldBinary = path.resolve(process.argv[2]), newBinary = path.resolve(process.argv[3]);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.notEqual(digest(oldBinary), digest(newBinary), 'Use two distinct executable releases to exercise rollback');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-windows-browser-'));
const store = path.join(dir, 'releases'), config = path.join(dir, 'config.kdl');
const agentScript = path.join(dir,'codex','fixture.cjs');
const name = 'update-acceptance-' + crypto.randomBytes(8).toString('hex');
const powershell = process.env.POWERSHELL_BINARY || path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const env = {...process.env, ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'), ZELLIJ_CONFIG_FILE:config, TERM:'xterm-256color'};
for(const key of Object.keys(env))if(key.toLowerCase()==='psmodulepath')delete env[key];
for (const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_DIR']) delete env[key];
const ps = value => "'" + value.replaceAll("'", "''") + "'";
const runPS = script => execFileSync(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); " + script,'utf16le').toString('base64')], {env, encoding:'utf8', timeout:120000, windowsHide:true});
const modulePath = path.join(__dirname,'windows_releases.psm1');
const withStore = script => runPS(`Import-Module ${ps(modulePath)} -Force; ${script}`);
const selectedBinary = () => path.join(store, JSON.parse(fs.readFileSync(path.join(store,'current.json'),'utf8')).sha256, 'zellij.exe');
const cli = (...args) => execFileSync(selectedBinary(), ['--config',config,...args], {env, encoding:'utf8', timeout:15000, windowsHide:true});
// A real hidden console is required: redirected launcher handles otherwise
// leak into the Windows shell and bypass its ConPTY.
const startSession = session => withStore(`$parts=@(${['--config',config,'attach','--create-background',session,'--',powershell,'-NoLogo','-NoProfile'].map(ps).join(',')}); Start-Process -FilePath ${ps(selectedBinary())} -ArgumentList (($parts | ForEach-Object { ConvertTo-SwitchboardArgument $_ }) -join ' ') -WindowStyle Hidden`);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function wait(check,message,timeout=45000) {
    const until=Date.now()+timeout;
    while(Date.now()<until) {try {if(await check())return;}catch{} await sleep(100);}
    throw Error(message);
}
async function port() {
    const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const number=server.address().port;await new Promise(resolve=>server.close(resolve));return number;
}
async function stop(child) {
    if(!child || child.exitCode!==null || child.signalCode!==null)return;
    const done=new Promise(resolve=>child.once('exit',resolve));child.kill();
    await Promise.race([done,sleep(5000)]);
    assert.ok(child.exitCode!==null || child.signalCode!==null,'Owned connection-service process did not stop');
}
const processes = () => JSON.parse(runPS(`ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.CreationDate} | ForEach-Object { @{pid=$_.ProcessId; ppid=$_.ParentProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o'); command=$_.CommandLine} }) -Compress`));
const panes = () => JSON.parse(cli('-s',name,'action','list-panes','--json','--all'));
const identities = () => panes().map(p=>[p.is_plugin,p.id,p.tab_id,p.tab_name]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
const names = () => JSON.parse(cli('-s',name,'action','list-tabs','--json')).map(t=>[t.tab_id,t.name]).sort((a,b)=>a[0]-b[0]);
let native,relay,browser,page,created=false,tokenName,agentIdentity,autoHelpers;
function start(binary,args,label) {
    const stdout=fs.openSync(path.join(dir,label+'.log'),'a'), stderr=fs.openSync(path.join(dir,label+'-error.log'),'a');
    const child=spawn(binary,args,{env, windowsHide:true, stdio:['ignore',stdout,stderr]});
    fs.closeSync(stdout);fs.closeSync(stderr);return child;
}
(async()=>{
    try {
        fs.writeFileSync(config,`web_sharing "on"\ndefault_shell ${JSON.stringify(powershell)}\nweb_server_ip "127.0.0.1"\nshow_startup_tips false\nsession_serialization false\ndisable_session_metadata false\n`);
        withStore(`Initialize-SwitchboardReleaseStore -Binary ${ps(oldBinary)} -Directory ${ps(store)} | Out-Null`);
        // Create/revoke only this fixture's named token, never reuse/revoke a
        // user token or copy credentials into the retained release store.
        const tokenOutput=cli('web','--create-token');
        const tokenLine=tokenOutput.split(/\r?\n/).find(line=>line.includes(': '));
        assert.ok(tokenLine,'Fixture token was created');
        tokenName=tokenLine.split(': ')[0];
        const tokenPath=path.join(dir,'token');fs.writeFileSync(tokenPath,tokenLine.slice(tokenName.length+2).trim());
        const nativePort=await port(),relayPort=await port(), url=`http://127.0.0.1:${relayPort}`;
        fs.appendFileSync(config,`web_server_port ${nativePort}\n`);
        const relayConfig=path.join(dir,'hosts.json');
        fs.writeFileSync(relayConfig,JSON.stringify({hosts:[{id:'test',name:'Acceptance',url:`http://127.0.0.1:${nativePort}`,token_file:tokenPath,zellij_binary:selectedBinary(),escape_transport:'local'}]}));
        const startServices=()=>{
            native=start(selectedBinary(),['--config',config,'web','--start','--port',String(nativePort)],'native');
            relay=start(selectedBinary(),['serve','--host-config',relayConfig,'--port',String(relayPort)],'relay');
        };
        startServices();await wait(async()=> (await fetch(url+'/api/health')).ok,'Private connection services did not start');
        created=true;startSession(name);
        let first;
        await wait(()=>{first=panes().find(p=>!p.is_plugin);return !!first;},'Private shell did not start');
        cli('-s',name,'action','rename-tab','--tab-id',String(first.tab_id),'Agent work');
        cli('-s',name,'action','new-tab','--name','Second shell','--',powershell,'-NoLogo','-NoProfile');
        let second;
        await wait(()=>{second=panes().find(p=>!p.is_plugin&&p.tab_id!==first.tab_id);return !!second;},'Second private shell did not start');
        await wait(async()=> (await (await fetch(url+'/api/hosts/test')).json()).sessions?.some(s=>s.name===name&&s.web_clients_allowed),'Private session is not shared');
        browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});page=await browser.newPage({viewport:{width:1200,height:800}});
        page.setDefaultTimeout(45000);
        await page.addInitScript(()=>{
            const Original=window.WebSocket;window.__acceptanceSockets=[];
            window.WebSocket=class extends Original {constructor(...args){super(...args);window.__acceptanceSockets.push(this);}};
        });
        await page.goto(url);await page.waitForSelector('#tabs .tab-select');
        async function connected() {
            await page.waitForFunction(session=>{
                const w=document.querySelector('#terminals>iframe.active')?.contentWindow;
                return w?.__zjLastMobileState?.session_name===session&&!w.term?.options.disableStdin&&
                    ['terminal','control'].every(type=>w.__acceptanceSockets?.some(s=>s.url.includes('/ws/'+type)&&s.readyState===1));
            },name);
        }
        async function select(pane) {
            const index=await page.evaluate(id=>[...document.querySelectorAll('#tabs .tab-select')].findIndex(b=>b._item?.tab.id===id),pane.tab_id);
            assert.ok(index>=0,'Native tab appears in sidebar');await page.locator('#tabs .tab-select').nth(index).click();
            await page.waitForFunction(id=>document.querySelector('#terminals>iframe.active')?.contentWindow.__zjLastMobileState?.active_pane?.pane_id===id,pane.id);
            await connected();
        }
        async function hasOutput(expected) {
            await page.waitForFunction(value=>{
                const term=document.querySelector('#terminals>iframe.active')?.contentWindow.term;
                return term&&Array.from({length:term.buffer.active.length},(_,n)=>term.buffer.active.getLine(n)?.translateToString()).some(line=>line?.includes(value));
            },expected);
        }
        async function command(text,expected) {
            await connected();
            await page.locator('#terminals>iframe.active').contentFrame().locator('.xterm-helper-textarea').focus();
            await page.keyboard.type(text);await page.keyboard.press('Enter');await hasOutput(expected);
        }
        const sidebarNames=()=>page.evaluate(session=>[...document.querySelectorAll('#tabs .tab-select')].filter(b=>b._item?.entry.name===session).map(b=>[b._item.tab.id,b.children[1].textContent]).sort((a,b)=>a[0]-b[0]),name);
        await select(first);
        const heartbeat=path.join(dir,'heartbeat'), agentDir=path.join(dir,'codex');fs.mkdirSync(agentDir);
        fs.writeFileSync(agentScript,`const fs=require('node:fs');let n=0;setInterval(()=>{fs.writeFileSync(process.argv[2],String(++n));process.stdout.write('HEARTBEAT:'+n+'\\n');},750);`);
        // A long-lived agent fixture is a real child process, not an actual
        // Codex/Claude run. It prints through ConPTY while the shell accepts input.
        const marker=crypto.randomBytes(8).toString('hex');
        const argumentsPS=ps('"'+agentScript+'" "'+heartbeat+'"');
        await command(`$global:SB_STATE=${ps(marker)}; $global:SB_AGENT=Start-Process -FilePath ${ps(process.execPath)} -ArgumentList ${argumentsPS} -NoNewWindow -PassThru; [Console]::WriteLine('FIRST_'+$SB_STATE)`,'FIRST_'+marker);
        await hasOutput('HEARTBEAT:');
        await select(second);
        await command(`$global:SB_STATE=${ps(marker+'-second')}; [Console]::WriteLine('SECOND_'+$SB_STATE)`,'SECOND_'+marker+'-second');
        const selectedURL=page.url(), beforeIdentities=identities(), beforeNames=names(), beforeSidebar=await sidebarNames();
        assert.deepEqual(beforeSidebar,beforeNames,'Sidebar shows actual named tabs');
        const beforeProcesses=processes(), engine=beforeProcesses.find(p=>p.command?.includes('--server ')&&p.command.includes(name));
        assert.ok(engine,'Private engine process is observable');
        const shells=beforeProcesses.filter(p=>p.ppid===engine.pid&&/powershell\.exe(?:"|\s)/i.test(p.command));assert.equal(shells.length,2,'Both private terminal shells are observable');
        agentIdentity=beforeProcesses.find(p=>p.command?.includes(agentScript));assert.ok(agentIdentity,'Long-lived agent fixture is observable');
        const protectedProcesses=[engine,...shells,agentIdentity];
        const continuity=async(prefix)=>{
            const beforeHeartbeat=Number(fs.readFileSync(heartbeat,'utf8'));
            await connected();
            assert.equal(page.url(),selectedURL,'Selected terminal URL survives automatically');
            await page.waitForFunction(id=>document.querySelector('#terminals>iframe.active')?.contentWindow.__zjLastMobileState?.active_pane?.pane_id===id,second.id);
            await command(`[Console]::WriteLine(${ps(prefix+'_')}+$SB_STATE)`,prefix+'_'+marker+'-second');
            assert.deepEqual(identities(),beforeIdentities,'Stable native tab/pane IDs and tab names survive');
            assert.deepEqual(names(),beforeNames,'Native names survive');
            assert.deepEqual(await sidebarNames(),beforeSidebar,'Displayed sidebar names survive');
            const current=processes();
            for(const original of protectedProcesses)assert.ok(current.some(p=>p.pid===original.pid&&p.started===original.started),'Engine/shell/agent PID and creation time survive');
            await wait(()=>Number(fs.readFileSync(heartbeat,'utf8'))>beforeHeartbeat,'Agent output stopped');
            assert.ok((await (await fetch(url+'/api/hosts/test')).json()).sessions.some(s=>s.name===name&&s.web_clients_allowed),'Sharing preference survives');
            await select(first);await hasOutput('FIRST_'+marker);await hasOutput('HEARTBEAT:');
            await command(`[Console]::WriteLine(${ps(prefix+'_FIRST_')}+$SB_STATE)`,prefix+'_FIRST_'+marker);
            await select(second);assert.equal(page.url(),selectedURL,'Selecting the original terminal restores its URL');
        };
        if(process.env.SWITCHBOARD_TEST_AUTO_UPDATE==='1'){
            const helpers=path.join(dir,'updater');fs.mkdirSync(helpers);
            autoHelpers=helpers;
            for(const file of ['auto_update.py','update_services_windows.ps1','windows_releases.psm1','update_windows.ps1','windows_cli.ps1'])fs.copyFileSync(path.join(__dirname,file),path.join(helpers,file));
            // Only the desktop tray installer is replaced. The production updater
            // (zellij switchboard update), selector, service capture/restart,
            // health checks and rollback run. Trays are matched in this private
            // helper directory, so the user's own tray is untouched.
            fs.writeFileSync(path.join(helpers,'install_windows_web.ps1'),'param([string]$ReleaseDirectory,[string]$Config)\n');
            const candidateCommit=process.env.SWITCHBOARD_TEST_CANDIDATE_COMMIT;
            assert.ok(/^[a-f0-9]{40}$/.test(candidateCommit||''),'Set the candidate executable full commit for automatic handoff verification');
            let runNumber=0;
            const apply=(mode,commit)=>{
                runNumber++;
                const bundle=path.join(dir,'bundle-'+runNumber), release=path.join(dir,'release-'+runNumber);fs.mkdirSync(release);
                execFileSync(newBinary,['switchboard','package','--platform','windows','--commit',commit,'--run-number',String(runNumber),'--helpers',helpers,'--output',bundle],{env,windowsHide:true});
                for(const file of fs.readdirSync(bundle))fs.copyFileSync(path.join(bundle,file),path.join(release,'switchboard-windows-'+file));
                try{
                    execFileSync(newBinary,['switchboard','update','--source',release,'--state-directory',path.join(helpers,'state'),'--helper-directory',helpers,
                        '--release-directory',store,'--config',config,'--host-config',relayConfig,'--port',String(relayPort)],{env,encoding:'utf8',timeout:240000,windowsHide:true});
                }catch(error){
                    if(mode!=='fail'||!/build identity/.test(String(error.stderr)))throw error;
                    return;
                }
                if(mode==='fail')throw new assert.AssertionError({message:'Expected failed-candidate rollback'});
            };
            // A manifest naming another commit fails the relay's build identity
            // check after the restart, exercising the production rollback.
            apply('fail','0'.repeat(40));await continuity('AUTO_ROLLBACK');
            assert.equal(selectedBinary(),path.join(store,digest(oldBinary),'zellij.exe'));
            apply('success',candidateCommit);await continuity('AUTO_UPDATED');
            assert.equal(selectedBinary(),path.join(store,digest(newBinary),'zellij.exe'));
            // The service children were replaced by the updater, so capture and
            // stop only its recorded private service PIDs during cleanup.
            console.log('PASS: production automatic Windows handoff and failed-candidate rollback preserve browser input/output, engines, shells, agent fixture and tab identity.');
            return;
        }
        withStore(`Invoke-SwitchboardWindowsUpdate -Candidate ${ps(newBinary)} -Directory ${ps(store)} -Config ${ps(config)} | ConvertTo-Json -Compress`);
        assert.equal(selectedBinary(),path.join(store,digest(newBinary),'zellij.exe'));
        await continuity('SELECTED');
        // This is test-only service orchestration. The production updater never
        // restarts these services and cannot claim this acceptance automatically.
        await stop(native);native=null;await stop(relay);relay=null;
        const reconnectStarted=Date.now();startServices();await continuity('UPGRADED');
        const reconnectMs=Date.now()-reconnectStarted;
        await stop(relay);relay=null; // Controlled private connection-service failure.
        withStore(`Invoke-SwitchboardWindowsUpdate -Directory ${ps(store)} -Config ${ps(config)} -Rollback | ConvertTo-Json -Compress`);
        assert.equal(selectedBinary(),path.join(store,digest(oldBinary),'zellij.exe'));
        await stop(native);native=null;startServices();await continuity('ROLLED_BACK');
        await page.reload();await connected();await command(`[Console]::WriteLine('REFRESH_'+$SB_STATE)`,'REFRESH_'+marker+'-second');
        assert.equal(page.url(),selectedURL,'Refresh preserves selected terminal');
        // A new private engine must load the selected release after rollback.
        const newName=name+'-new';
        try {
            startSession(newName);
            await wait(()=>processes().some(p=>p.command?.includes('--server ')&&p.command.includes(newName)&&p.command.toLowerCase().includes(selectedBinary().toLowerCase())),'New session did not load the selected executable');
        } finally { cli('kill-session',newName); }
        console.log(`PASS: real Windows browser input/output, automatic service reconnection (${reconnectMs} ms including checks), manual rollback, ConPTY engine/shell/agent-fixture PID+creation-time preservation, ongoing output, shell variables, scrollback marker, native/sidebar names, pane/tab IDs, selected URL, sharing and new-session release selection.`);
    } catch(error) { console.error('Private acceptance logs:',dir,error);throw error; }
    finally {
        if(agentIdentity)try{
            runPS(`$p=Get-CimInstance Win32_Process -Filter ${ps('ProcessId='+agentIdentity.pid)}; if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq ${ps(agentIdentity.started)} -and $p.CommandLine.Contains(${ps(dir)})){Stop-Process -Id $p.ProcessId -ErrorAction Stop}`);
        }catch(error){console.error('Agent fixture cleanup failed:',error.message);process.exitCode=1;}
        else if(fs.existsSync(agentScript))try{
            runPS(`Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -and $_.CommandLine.Contains(${ps(agentScript)})} | ForEach-Object {Stop-Process -Id $_.ProcessId -ErrorAction Stop}`);
        }catch(error){console.error('Early agent fixture cleanup failed:',error.message);process.exitCode=1;}
        if(browser)await browser.close();
        if(created)try{cli('kill-session',name);}catch(error){console.error('Private session cleanup failed:',error.message);process.exitCode=1;}
        if(autoHelpers)try{
            const stateDir=path.join(autoHelpers,'state');
            const latest=fs.readdirSync(stateDir).filter(n=>n.startsWith('rollback-')).sort().at(-1);
            if(latest)runPS(`& ${ps(path.join(autoHelpers,'update_services_windows.ps1'))} -Action Stop -Snapshot ${ps(path.join(stateDir,latest,'services.json'))} -ReleaseDirectory ${ps(store)}`);
        }catch(error){console.error('Automatic fixture service cleanup failed:',error.message);process.exitCode=1;}
        await stop(relay);await stop(native);
        if(tokenName)try{cli('web','--revoke-token',tokenName);}catch(error){console.error('Fixture token cleanup failed:',error.message);process.exitCode=1;}
        fs.rmSync(path.join(dir,'token'),{force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
