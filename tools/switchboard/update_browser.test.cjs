// Real browser acceptance. Never attach to or restart the user's sessions.
// Usage: PLAYWRIGHT_MODULE=/path/to/playwright node update_browser.test.cjs [OLD_BINARY] [NEW_BINARY]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const {execFileSync, spawn, spawnSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const newBinary = path.resolve(process.argv[3] || path.join(root, 'target/release/zellij'));
const oldBinary = path.resolve(process.argv[2] || newBinary);
const recoveryMode=process.env.SWITCHBOARD_TEST_RECOVERY_ADAPTER==='1';
const inPlace = process.env.SWITCHBOARD_TEST_IN_PLACE_RECONNECT === '1';
const explicitUpdate = process.env.SWITCHBOARD_TEST_EXPLICIT_UPDATE === '1';
const dir = fs.mkdtempSync('/tmp/switchboard-browser-update-');
const installed = path.join(dir, 'zellij');
const config = path.join(dir, 'config.kdl');
const name = `update-acceptance-${crypto.randomBytes(8).toString('hex')}`;
const env = {...process.env, HOME:dir, ZELLIJ_SOCKET_DIR:path.join(dir,'sockets'),
    SWITCHBOARD_RELEASES_DIR:path.join(dir,'releases'), SWITCHBOARD_VIEWER_LOCK:path.join(dir,'viewers.lock'), TERM:'xterm-256color'};
for (const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_FILE','ZELLIJ_CONFIG_DIR']) delete env[key];
env.ZELLIJ_CONFIG_FILE = config;
const cli = (...args) => execFileSync(installed, ['--config',config,...args], {env,encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function availablePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function waitFor(check, message) {
    for(let n=0;n<150;n++) {try {if(await check()) return;} catch {} await sleep(100);}
    throw Error(message);
}
async function stop(child) {
    if(!child || child.exitCode !== null) return;
    const done = new Promise(resolve => child.once('exit',resolve));
    child.kill('SIGTERM');
    await Promise.race([done,sleep(5000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);
}
function processes() {
    return execFileSync('/bin/ps',['-axo','pid=,ppid=,lstart=,command='],{encoding:'utf8'}).trim().split('\n').map(line=>{
        const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
        return m && {pid:Number(m[1]),ppid:Number(m[2]),started:m[3],command:m[4]};
    }).filter(Boolean);
}
const identities = () => JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).map(p=>[p.is_plugin,p.id,p.tab_id]).sort();
let updateController, native, relay, browser, tokenName, readOnlyTokenName, created=false, otherCreated=false;
const otherName='excluded-'+name.slice(-16);
let recoveryPanes, reconnectTarget;
(async()=>{
    try {
        fs.mkdirSync(path.join(dir,'git','switchboard'),{recursive:true});
        fs.writeFileSync(config,`web_sharing "${recoveryMode?'off':'on'}"\ndefault_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\ndisable_session_metadata false\n`);
        fs.copyFileSync(oldBinary,installed);fs.chmodSync(installed,0o755);
        if(recoveryMode)console.log(JSON.stringify({engine_sha256:crypto.createHash('sha256').update(fs.readFileSync(installed)).digest('hex'),web_sha256:crypto.createHash('sha256').update(fs.readFileSync(newBinary)).digest('hex')}));
        const output = cli('web','--create-token');
        const tokenLine = output.split('\n').find(line=>line.includes(': '));
        assert.ok(tokenLine,'Native token was created');
        tokenName = tokenLine.split(': ')[0];
        const tokenPath=path.join(dir,'token');
        fs.writeFileSync(tokenPath,tokenLine.slice(tokenName.length+2).trim(),{mode:0o600});
        const nativePort=await availablePort(), relayPort=await availablePort();
        const url=`http://127.0.0.1:${relayPort}`;
        const relayConfig=path.join(dir,'hosts.json');
        fs.writeFileSync(relayConfig,JSON.stringify({hosts:[{id:'test',name:'Acceptance',url:`http://127.0.0.1:${nativePort}`,token_file:tokenPath,zellij_binary:installed}]}),{mode:0o600});
        let recoveryEnabled=false;
        const startNative=()=>spawn(recoveryMode?newBinary:installed,['--config',config,'web','--port',String(nativePort)],{env:{...env,...(recoveryEnabled?{SWITCHBOARD_RECOVER_UNSHARED_SESSION:name}:{})},stdio:['ignore',fs.openSync(path.join(dir,'native.log'),'a'),fs.openSync(path.join(dir,'native-error.log'),'a')]});
        const startRelay=()=>spawn(explicitUpdate?installed:newBinary,['serve','--host-config',relayConfig,'--port',String(relayPort)],{env,stdio:['ignore',fs.openSync(path.join(dir,'relay.log'),'a'),fs.openSync(path.join(dir,'relay-error.log'),'a')]});
        native=startNative(); relay=startRelay();
        await waitFor(async()=> (await fetch(url)).ok,'Private services did not start');
        cli('attach','--create-background',name,'--','/bin/bash','--noprofile','--norc');created=true;
        if(recoveryMode){
            let initialPane;
            await waitFor(()=>{
                initialPane=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).find(p=>!p.is_plugin);
                return !!initialPane;
            },'First private terminal did not start');
            cli('-s',name,'action','rename-tab','--tab-id',String(initialPane.tab_id),'Recovery first');
            cli('-s',name,'action','new-tab','--name','Recovery second','--','/bin/bash','--noprofile','--norc');
            await waitFor(()=>{
                recoveryPanes=JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin);
                return new Set(recoveryPanes.map(p=>p.tab_id)).size===2;
            },'Second private terminal did not start');
            recoveryPanes.sort((a,b)=>a.tab_position-b.tab_position);
            cli('attach','--create-background',otherName,'--','/bin/bash','--noprofile','--norc');otherCreated=true;
            await waitFor(async()=> (await (await fetch(url+'/api/hosts/test')).json()).sessions?.some(s=>s.name===name&&!s.web_clients_allowed),'Off session was not listed as blocked');
            await stop(native);native=null;recoveryEnabled=true;native=startNative();
        }
        await waitFor(async()=> (await (await fetch(url+'/api/hosts/test')).json()).sessions?.some(s=>s.name===name&&s.web_clients_allowed),'Session was not shared with the browser');
        if(recoveryMode){
            const sessions=(await (await fetch(url+'/api/hosts/test')).json()).sessions;
            assert.ok(sessions.find(s=>s.name===name)?.sharing_recovery,'Catalog identifies temporary adapter recovery');
            assert.ok(!sessions.find(s=>s.name===otherName)?.web_clients_allowed,'Recovery excludes other Off sessions');
        }
        if (inPlace && !recoveryMode) {
            cli('-s',name,'action','new-tab','--name','Reconnect target','--','/bin/bash','--noprofile','--norc');
            await waitFor(() => {
                const panes = JSON.parse(cli('-s',name,'action','list-panes','--json','--all')).filter(p=>!p.is_plugin).sort((a,b)=>a.tab_position-b.tab_position);
                reconnectTarget = panes[1];
                return !!reconnectTarget;
            }, 'Second private terminal did not start');
        }
        const beforeIdentities=identities();
        const names=()=>JSON.parse(cli('-s',name,'action','list-tabs','--json'))
            .map(tab=>[tab.tab_id,tab.name]).sort((a,b)=>a[0]-b[0]);
        const beforeNames=names();
        const server=processes().find(p=>p.command.includes('--server ')&&p.command.endsWith('/'+name));
        assert.ok(server,'Private session server exists');
        const children=processes().filter(p=>p.ppid===server.pid);
        assert.ok(children.length,'Session owns terminal processes');
        browser=await chromium.launch({headless:true});
        const context=await browser.newContext({viewport:{width:1200,height:800}});
        const page=await context.newPage();
        page.setDefaultTimeout(30000);
        page.on('pageerror',error=>console.error('Browser error:',error.message));
        await page.addInitScript(()=>{
            const Original=window.WebSocket;
            window.__acceptanceSockets=[];
            window.WebSocket=class extends Original {
                constructor(...args){
                    super(...args);window.__acceptanceSockets.push(this);
                    const replacementControl = String(args[0]).includes('/ws/control') && window.__acceptanceSockets.filter(s=>s.url.includes('/ws/control')).length > 1;
                    if (replacementControl) this.addEventListener('message', event => {
                        if (!window.__acceptanceReconnectCommand || window.__acceptanceInjected || JSON.parse(event.data).type !== 'MobileState') return;
                        // Both sockets are open, but the sidebar has not seen the
                        // new client's default first-tab state or restored focus.
                        window.__acceptanceInjected = true;
                        event.stopImmediatePropagation();
                        window.term.input(window.__acceptanceReconnectCommand);
                        for (const event of [
                            {code:'KeyL',ctrlKey:true}, {code:'Backspace',ctrlKey:true},
                            {code:'ArrowLeft',altKey:true}, {code:'ArrowRight',altKey:true},
                        ]) window.term.textarea.dispatchEvent(new KeyboardEvent('keydown', {...event,bubbles:true,cancelable:true}));
                        this.dispatchEvent(new MessageEvent('message', {data:event.data}));
                    });
                }
                send(data) {
                    if (window.__acceptanceInjected && ['\x0c','\x17','\x1b[1;5D','\x1b[1;5C'].includes(data)) window.__acceptanceShortcutLeaked = true;
                    return super.send(data);
                }
            };
        });
        await page.goto(url);
        if(recoveryMode&&process.env.SWITCHBOARD_TEST_RAW_RECOVERY==='1'){
            await page.waitForFunction(()=>[...document.querySelectorAll('#terminals>iframe')].some(f=>f.contentWindow.__acceptanceSockets?.some(s=>s.url.includes('/ws/terminal')&&s.readyState===1)));
            const marker='RAW_'+crypto.randomBytes(8).toString('hex');
            await page.evaluate(value=>{
                const frame=[...document.querySelectorAll('#terminals>iframe')].find(f=>f.contentWindow.__acceptanceSockets?.some(s=>s.url.includes('/ws/terminal')&&s.readyState===1));
                frame.classList.add('active');frame.contentWindow.term.focus();
                const socket=frame.contentWindow.__acceptanceSockets.find(s=>s.url.includes('/ws/terminal')&&s.readyState===1);
                socket.send(`SB_RAW=${value}; printf '%s%s\\n' "CONFIRMED_" "$SB_RAW"\r`);
            },marker);
            await page.waitForFunction(value=>{
                const term=document.querySelector('#terminals>iframe.active')?.contentWindow.term;
                return term&&Array.from({length:term.buffer.active.length},(_,n)=>term.buffer.active.getLine(n)?.translateToString()).some(line=>line?.includes('CONFIRMED_'+value));
            },marker);
            console.log('DIAGNOSTIC: authenticated recovery terminal WebSocket accepts input and renders real shell output. Sidebar/MobileState is a separate acceptance requirement.');
        }
        if(recoveryMode){
            const roOutput=cli('web','--create-read-only-token');
            const roLine=roOutput.split('\n').find(line=>line.includes(': '));
            readOnlyTokenName=roLine.split(': ')[0];
            const roContext=await browser.newContext();
            const nativeUrl=`http://127.0.0.1:${nativePort}`;
            assert.equal((await fetch(nativeUrl+'/session-list')).status,401,'Recovery does not allow unauthenticated session discovery');
            assert.equal((await roContext.request.post(nativeUrl+'/command/login',{data:{auth_token:roLine.slice(readOnlyTokenName.length+2).replace(/ \(read-only\)\s*$/,'').trim(),remember_me:false}})).status(),200);
            const roCatalog=await (await roContext.request.get(nativeUrl+'/session-list')).json();
            assert.ok(!roCatalog.sessions.find(s=>s.name===name)?.web_clients_allowed,'Read-only catalog cannot use recovery');
            const roPage=await roContext.newPage();
            let roData='',roClosed=false;
            roPage.on('websocket',ws=>{if(ws.url().includes('/ws/terminal')){
                ws.on('framereceived',event=>{roData+=String(event.payload);});ws.on('close',()=>{roClosed=true;});
            }});
            await roPage.goto(nativeUrl+'/'+name);
            await waitFor(()=>roClosed,'Read-only terminal socket was not rejected');
            assert.ok(!roData || /sharing.*disabled|sharing.*off|not.*sharing|does not allow web connections|web clients are not allowed/i.test(roData),'Read-only client receives only a sharing rejection, not terminal output: '+JSON.stringify(roData.slice(-600)));
            console.log('DIAGNOSTIC: unauthenticated catalog rejected; authenticated read-only catalog excludes recovery and its terminal WebSocket is rejected.');
            await roContext.close();
        }
        await page.waitForSelector('#tabs .tab-select');
        const connected=()=>page.waitForFunction(expectedSession=>{
            const w=document.querySelector('#terminals>iframe.active')?.contentWindow;
            return w?.__zjLastMobileState?.session_name===expectedSession && ['terminal','control'].every(type=>
                w.__acceptanceSockets.some(s=>s.url.includes('/ws/'+type)&&s.readyState===1));
        },name);
        await connected();
        const sidebarNames=()=>page.evaluate(session=>[...document.querySelectorAll('#tabs .tab-select')]
            .filter(button=>button._item?.entry.name===session)
            .map(button=>[button._item.tab.id,button.children[1].textContent])
            .sort((a,b)=>a[0]-b[0]),name);
        let beforeSidebarNames;
        if(recoveryMode){
            await page.waitForFunction(expected=>expected.every(([id,title])=>[...document.querySelectorAll('#tabs .tab-select')]
                .some(button=>button._item?.tab.id===id&&button.children[1].textContent===title)),beforeNames);
            beforeSidebarNames=await sidebarNames();
            assert.deepEqual(beforeSidebarNames,beforeNames,'Recovery preserves the original displayed tab names');
        }
        async function command(text,expected,target=page) {
            const frame=target.locator('#terminals>iframe.active').contentFrame();
            await frame.locator('.xterm-helper-textarea').focus();
            await target.keyboard.type(text);await target.keyboard.press('Enter');
            await target.waitForFunction(marker=>{
                const term=document.querySelector('#terminals>iframe.active')?.contentWindow.term;
                if(!term) return false;
                for(let n=0;n<term.buffer.active.length;n++)if(term.buffer.active.getLine(n)?.translateToString().includes(marker))return true;
                return false;
            },expected).catch(async error => {
                console.error('Terminal command diagnostics:', JSON.stringify(await target.evaluate(() => {
                    const w=document.querySelector('#terminals>iframe.active')?.contentWindow;
                    return {state:w?.__zjLastMobileState,disabled:w?.term?.options.disableStdin,status:w?.document.body.innerText,
                        sockets:w?.__acceptanceSockets?.map(s=>({url:s.url,state:s.readyState})),
                        screen:w?.term && Array.from({length:w.term.buffer.active.length},(_,n)=>w.term.buffer.active.getLine(n)?.translateToString()).filter(s=>s?.trim()).slice(-15)};
                })));
                throw error;
            });
        }
        async function selectedPane(pane,target=page){
            await target.waitForFunction(expected=>{
                const w=document.querySelector('#terminals>iframe.active')?.contentWindow;
                return w?.__zjLastMobileState?.active_pane?.pane_id===expected && !w.term?.options.disableStdin;
            },pane.id);
        }
        async function selectPane(pane,target=page){
            const index=await target.evaluate(id=>[...document.querySelectorAll('#tabs .tab-select')].findIndex(b=>b._item?.tab.id===id),pane.tab_id);
            assert.ok(index>=0,'Expected tab is present in the sidebar');
            await target.locator('#tabs .tab-select').nth(index).click();
            await selectedPane(pane,target);
        }
        if(!recoveryMode){
            const follower=await page.context().newPage();
            await follower.setViewportSize({width:720,height:480});
            await follower.goto(url);await follower.waitForSelector('#tabs .tab-select');
            // Headless Chromium reports every page focused, even with CDP focus
            // emulation disabled. Drive window focus explicitly; resize/IPC is real.
            for(const viewer of [page,follower])await viewer.evaluate(()=>{
                Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>window.__viewportTestFocused});
            });
            async function focusViewer(target){
                for(const viewer of [page,follower])await viewer.evaluate(focused=>{window.__viewportTestFocused=focused;},viewer===target);
                await target.bringToFront();
                await target.evaluate(()=>window.dispatchEvent(new Event('focus')));
            }
            const owned=target=>target.waitForFunction(()=>{
                const w=document.querySelector('#terminals>iframe.active')?.contentWindow;
                const viewport=w?.__zjLastMobileState?.tab_viewport,physical=w?.__zjViewport?.dimensions();
                return viewport?.is_owner&&viewport.cols===physical?.cols&&viewport.rows===physical?.rows;
            });
            await focusViewer(follower);await owned(follower);
            const small=await follower.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjLastMobileState.tab_viewport.cols);
            await focusViewer(page);await owned(page);
            const large=await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjLastMobileState.tab_viewport.cols);
            assert.ok(large>small,'The last focused larger viewer overrides the smaller viewer');
            await follower.setViewportSize({width:640,height:400});
            await sleep(1200);
            await owned(page);
            assert.equal(await page.evaluate(()=>document.querySelector('#terminals>iframe.active').contentWindow.__zjLastMobileState.tab_viewport.cols),large,'A background resize cannot reclaim ownership');
            await focusViewer(follower);await owned(follower);
            await focusViewer(page);await owned(page);
            await follower.close();
            await page.evaluate(()=>{delete document.hasFocus;delete window.__viewportTestFocused;});
            console.log('PASS: last focused browser owns physical dimensions; background resize does not shrink it.');
        }
        // Construct markers at runtime: echoed command text cannot satisfy output checks.
        let marker='SB_'+crypto.randomBytes(8).toString('hex');
        if(recoveryMode){
            assert.equal(await page.locator('#tabs .tab-select').count(),2,'Both recovered tabs appear in the sidebar');
            await selectPane(recoveryPanes[0]);
            const firstMarker=marker;
            await command(`SB_STATE=${firstMarker}; printf '%s%s\\n' "FIRST_" "$SB_STATE"`,'FIRST_'+firstMarker);
            await selectPane(recoveryPanes[1]);
            marker='SECOND_'+crypto.randomBytes(8).toString('hex');
            await command(`SB_STATE=${marker}; printf '%s%s\\n' "SECOND_" "$SB_STATE"`,'SECOND_'+marker);
            await selectPane(recoveryPanes[0]);
            await command(`printf '%s%s\\n' "FIRST_REVISITED_" "$SB_STATE"`,'FIRST_REVISITED_'+firstMarker);
            await selectPane(recoveryPanes[1]);
            const otherViewer=await browser.newPage({viewport:{width:1200,height:800}});
            otherViewer.setDefaultTimeout(30000);
            await otherViewer.goto(url);await otherViewer.waitForSelector('#tabs .tab-select');
            await selectPane(recoveryPanes[0],otherViewer);
            await command(`printf '%s%s\\n' "OTHER_VIEWER_" "$SB_STATE"`,'OTHER_VIEWER_'+firstMarker,otherViewer);
            await selectedPane(recoveryPanes[1]);
            await command(`printf '%s%s\\n' "PRIMARY_VIEWER_" "$SB_STATE"`,'PRIMARY_VIEWER_'+marker);
            await selectedPane(recoveryPanes[0],otherViewer);
            await otherViewer.close();
            const beforeRefresh=page.url();
            await page.reload();await connected();await selectedPane(recoveryPanes[1]);
            assert.equal(page.url(),beforeRefresh,'Refresh retains the selected terminal URL');
            await command(`printf '%s%s\\n' "REFRESHED_" "$SB_STATE"`,'REFRESHED_'+marker);
        }
        await command(`SB_STATE=${marker}; printf '%s%s\\n' "BEFORE_" "$SB_STATE"`,'BEFORE_'+marker);
        let selected=await page.evaluate(()=>location.href);
        if(!recoveryMode){
        const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
        const counter=path.join(dir,'failed-probe-count');
        const failing=path.join(dir,'failed-update');
        fs.writeFileSync(failing,`#!/bin/bash\nif [[ "$1" == -s ]]; then\n n=0; [[ ! -f ${quote(counter)} ]] || read -r n < ${quote(counter)}\n n=$((n+1)); echo "$n" > ${quote(counter)}\n if [[ $n -gt 1 ]]; then echo '[]'; exit 0; fi\nfi\nexec ${quote(newBinary)} "$@"\n`,{mode:0o755});
        const beforeBytes=fs.readFileSync(installed);
        const rejected=spawnSync('/bin/bash',[path.join(__dirname,'update_local.sh'),'--binary-only',failing,installed],{env,encoding:'utf8',timeout:60000});
        assert.notEqual(rejected.status,0,'Post-install verification failure rejects the update');
        assert.match(rejected.stderr,/restoring the previous executable/);
        assert.ok(fs.readFileSync(installed).equals(beforeBytes),'Rollback restores the exact binary');
        await command(`printf '%s%s\\n' "ROLLED_BACK_" "$SB_STATE"`,'ROLLED_BACK_'+marker);
        if(!explicitUpdate)execFileSync('/bin/bash',[path.join(__dirname,'update_local.sh'),'--binary-only',newBinary,installed],{env,timeout:60000,stdio:'pipe'});
        await command(`printf '%s%s\\n' "UPDATED_" "$SB_STATE"`,'UPDATED_'+marker);
        }
        // The rollback fixture temporarily reports an empty catalog. Select the
        // second terminal after those probes, before testing transport recovery.
        if (reconnectTarget) {
            await selectPane(reconnectTarget);
            await command(`SB_STATE=${marker}; printf '%s%s\\n' "SECOND_READY_" "$SB_STATE"`, 'SECOND_READY_'+marker);
            selected=await page.evaluate(()=>location.href);
        }
        // In-place recovery must retain the actual iframe document and xterm instance.
        const viewerLockBusy = () => {
            const result = spawnSync('python3', ['-c', `import fcntl,sys
with open(sys.argv[1], 'a+') as lock:
    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(2)
`, env.SWITCHBOARD_VIEWER_LOCK], {encoding:'utf8'});
            assert.ok([0,2].includes(result.status), result.stderr);
            return result.status === 2;
        };
        if (inPlace) assert.ok(viewerLockBusy(), 'A browser connection excludes an updater in another process');
        const misplacedInput = path.join(dir, 'misplaced-input');
        if (inPlace) await page.evaluate(command => {
            const w = document.querySelector('#terminals>iframe.active').contentWindow;
            window.savedTerminalDocument = w.document;
            window.savedTerminal = w.term;
            w.__acceptanceReconnectCommand = command;
        }, `printf misplaced > '${misplacedInput}'\r`);
        if(explicitUpdate){
            // Native updater with a private service adapter, never launchd/systemd or user services.
            const helpers=path.join(dir,'helpers'),source=path.join(dir,'release'),state=path.join(dir,'update-state');
            for(const folder of [helpers,source,state])fs.mkdirSync(folder);
            const originalCommit=(await(await fetch(url+'/api/health')).json()).commit;
            let failNext=true,installs=0;
            updateController=http.createServer(async(req,res)=>{
                try{
                    const chunks=[];for await(const chunk of req)chunks.push(chunk);
                    const candidate=Buffer.concat(chunks).toString();assert.ok(candidate.startsWith(dir+'/'));
                    await stop(native);native=null;await stop(relay);relay=null;
                    fs.copyFileSync(candidate,installed+'.next');fs.chmodSync(installed+'.next',0o755);fs.renameSync(installed+'.next',installed);
                    native=startNative();relay=startRelay();
                    await waitFor(async()=> (await fetch(url+'/api/health')).ok,'Private services did not restart');
                    installs++;
                    if(failNext){failNext=false;res.writeHead(500);res.end('Injected handoff failure');}else res.end('ok');
                }catch(error){res.writeHead(500);res.end(error.message);}
            });
            await new Promise(resolve=>updateController.listen(0,'127.0.0.1',resolve));
            const helper=`#!/bin/bash\nset -euo pipefail\ncurl -fsS --max-time 40 -X POST --data-binary "$1" http://127.0.0.1:${updateController.address().port}/restart\n`;
            fs.writeFileSync(path.join(helpers,'update_local.sh'),helper);
            const platform=process.platform==='darwin'?(process.arch==='arm64'?'macos-arm64':'macos-x86_64'):(process.arch==='arm64'?'linux-arm64':'linux-x86_64');
            const files=process.platform==='darwin'?['auto_update.py','install_service.py','menu_bar.swift','update_local.sh','zellij']:['update_local.sh','zellij'];
            const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),hashes={};
            for(const file of files){
                const bytes=file==='zellij'?fs.readFileSync(newBinary):Buffer.from(file==='update_local.sh'?helper:'# private unused fixture helper\n');
                fs.writeFileSync(path.join(source,`switchboard-${platform}-${file}`),bytes);
                hashes[file]=crypto.createHash('sha256').update(bytes).digest('hex');
                if(file!=='zellij')fs.writeFileSync(path.join(helpers,file),bytes);
            }
            fs.writeFileSync(path.join(source,`switchboard-${platform}-bundle.json`),JSON.stringify({schema:1,commit,platform,run_number:1,files:hashes}));
            const runUpdate=extra=>new Promise((resolve,reject)=>{
                const child=spawn(newBinary,['switchboard','update','--config',config,'--host-config',relayConfig,'--port',String(relayPort),'--binary',installed,'--helper-directory',helpers,'--state-directory',state,'--source',source,...extra],{env,stdio:['ignore',fs.openSync(path.join(dir,'update.log'),'a'),fs.openSync(path.join(dir,'update-error.log'),'a')]});
                child.on('error',reject);child.on('exit',resolve);
            });
            assert.ok(viewerLockBusy());
            assert.equal(await runUpdate([]),0);assert.equal(installs,0,'Automatic run waits for viewers');
            assert.equal(JSON.parse(fs.readFileSync(path.join(state,'state.json'))).ready.commit,commit);
            assert.notEqual(await runUpdate(['--activate',commit]),0,'Injected handoff fails');
            assert.equal(installs,2,'Failed handoff runs rollback');
            await connected();
            if(reconnectTarget)await selectedPane(reconnectTarget);
            await command(`printf '%s%s\\n' "ROLLBACK_LIVE_" "$SB_STATE"`,'ROLLBACK_LIVE_'+marker);
            assert.equal((await(await fetch(url+'/api/health')).json()).commit,originalCommit);
            assert.equal(await runUpdate([]),0);assert.equal(installs,2,'Failed activation does not force a later automatic attempt');
            assert.equal(await runUpdate(['--activate',commit]),0);
            assert.equal(installs,3);assert.ok(commit.startsWith((await(await fetch(url+'/api/health')).json()).commit));
            console.log('PASS: automatic update deferred with live viewers; exact explicit activation reconnected them; failed handoff rolled back; later automatic retry remained gated.');
        }else{
        // Restart only the connection services, leaving the existing shell and browser alone.
        await stop(native);native=null;await stop(relay);relay=null;
        if (inPlace) assert.ok(!viewerLockBusy(), 'Stopping connection services releases their viewer locks');
        await sleep(500);
        native=startNative();relay=startRelay();
        await waitFor(async()=> (await fetch(url)).ok,'Connection services did not recover');
        }
        await connected();
        if(recoveryMode)await selectedPane(recoveryPanes[1]);
        if(reconnectTarget)await selectedPane(reconnectTarget);
        await command(`printf '%s%s\\n' "RECONNECTED_" "$SB_STATE"`,'RECONNECTED_'+marker);
        if (inPlace) {
            assert.ok(await page.evaluate(() => document.querySelector('#terminals>iframe.active').contentWindow.__acceptanceInjected), 'Typing was attempted before the first restored-pane metadata');
            assert.ok(!await page.evaluate(() => document.querySelector('#terminals>iframe.active').contentWindow.__acceptanceShortcutLeaked), 'Shortcuts cannot bypass pane restoration');
            assert.ok(!fs.existsSync(misplacedInput), 'Input before pane restoration never reaches the first tab or gets replayed');
            assert.ok(viewerLockBusy(), 'Reconnected viewers protect the new services');
        }
        if (inPlace) assert.ok(await page.evaluate(() => {
            const w = document.querySelector('#terminals>iframe.active').contentWindow;
            return w.document === window.savedTerminalDocument && w.term === window.savedTerminal;
        }), 'Reconnect preserves the terminal document and xterm instance');
        assert.equal(await page.evaluate(()=>location.href),selected,'Selected terminal URL survives');
        assert.deepEqual(identities(),beforeIdentities,'Tab and pane identities survive');
        assert.deepEqual(names(),beforeNames,'Native tab names survive updates and reconnection');
        if(recoveryMode)assert.deepEqual(await sidebarNames(),beforeSidebarNames,'Displayed sidebar names survive refresh and reconnection');
        const after=processes();
        for(const original of [server,...children])assert.ok(after.some(p=>p.pid===original.pid&&p.started===original.started),'Session server and terminal processes survive');
        const host=await (await fetch(url+'/api/hosts/test')).json();
        assert.ok(host.sessions.some(s=>s.name===name&&s.web_clients_allowed),'Sharing survives connection-service restart');
        if(!recoveryMode){
            const previousTabIds=names().map(([id])=>id);
            await page.keyboard.press('Alt+KeyT');
            await page.waitForFunction(()=>document.querySelector('#new-tab-dialog').open);
            // This private test has no dotfiles aliases; keep a plain shell for the input checks.
            await page.locator('#new-tab-command').fill('exec /bin/bash --noprofile --norc');
            await page.keyboard.press('Enter');
            await page.waitForFunction(previous=>{
                const button=document.querySelector('#tabs .tab-select.selected'),frame=document.querySelector('#terminals>iframe.active');
                const w=frame?.contentWindow,active=w?.__zjLastMobileState?.active_pane;
                return button&&!button._item.tab.pending&&!previous.includes(button._item.tab.id)&&!button._item.entry.pendingNewTab&&
                    button.getAttribute('aria-pressed')==='true'&&button._item.tab.panes.some(p=>p.pane_id===active?.pane_id&&!p.is_plugin)&&
                    !w.term.options.disableStdin&&document.activeElement===frame&&w.term.element.contains(w.document.activeElement);
            },previousTabIds);
            const tabId=await page.locator('#tabs .tab-select.selected').evaluate(button=>button._item.tab.id);
            assert.equal(new URL(page.url()).searchParams.get('tab'),String(tabId),'New tab URL matches the highlighted terminal');
            const createdMarker='CREATED_'+crypto.randomBytes(8).toString('hex');
            // No explicit terminal focus: typing must work directly after Create.
            await page.keyboard.type(`SB_NEW=${createdMarker}; printf '%s%s\\n' "AUTOFOCUSED_" "$SB_NEW"`);
            await page.keyboard.press('Enter');
            await page.waitForFunction(expected=>{
                const term=document.querySelector('#terminals>iframe.active')?.contentWindow.term;
                return term&&Array.from({length:term.buffer.active.length},(_,n)=>term.buffer.active.getLine(n)?.translateToString()).some(line=>line?.includes('AUTOFOCUSED_'+expected));
            },createdMarker);
            await page.reload();await connected();
            await page.waitForFunction(id=>document.querySelector('#tabs .tab-select.selected')?._item.tab.id===id,tabId);
            await command(`printf '%s%s\\n' "CREATED_REFRESHED_" "$SB_NEW"`,'CREATED_REFRESHED_'+createdMarker);
            console.log('PASS: Create highlights the actual new native tab, focuses input immediately without another click, updates its URL, and refreshes into the same shell.');
            const second=await context.newPage();await second.goto(page.url());
            await second.waitForSelector('#tabs .tab-select');
            await second.waitForFunction(session=>document.querySelector('#terminals>iframe.active')?.contentWindow.__zjLastMobileState?.session_name===session,name);
            for(const [id] of names()){
                const result=await fetch(url+'/api/hosts/test/close-tab',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:name,tab_id:id})});
                assert.equal(result.status,200,await result.text());
            }
            const closed=async()=> !(await (await fetch(url+'/api/hosts/test')).json()).sessions.some(s=>s.name===name);
            await waitFor(closed,'Final tab did not close');
            await sleep(3000);
            assert.ok(await closed(),'Two viewers must not recreate an intentionally closed session');
            assert.ok(!processes().some(p=>p.pid===server.pid),'Closed private engine exits');
            created=false;await second.close();
            console.log('PASS: closing the final tab disconnects both viewers without recreating its session.');

        }
        if(recoveryMode){
            await stop(native);native=null;recoveryEnabled=false;native=startNative();
            await waitFor(async()=> (await (await fetch(url+'/api/hosts/test')).json()).sessions?.some(s=>s.name===name&&!s.web_clients_allowed),'Recovery disable did not restore Off policy');
            assert.deepEqual(identities(),beforeIdentities,'Disabling recovery preserves panes');
            console.log('PASS: Off session recovery is opt-in, exact-session and writable-authentication only; read-only attach rejected; both sidebar tabs and concurrent viewers focus actual separate shells; independent shell state, selected terminal refresh and automatic reconnect survive; process/tab IDs preserved; removing adapter restores Off policy. Native sharing policy remains Off.');
        }else console.log('PASS: real browser terminal input/output before and after failed-update rollback, binary update and native web/relay restart; automatic reconnection; preserved shell state, process IDs, tab/pane IDs, selected URL and sharing.');
    } catch(error) {
        if(browser)for(const context of browser.contexts())for(const page of context.pages())try{
            console.error('Browser diagnostics:',JSON.stringify(await page.evaluate(()=>({status:document.querySelector('#status')?.textContent,frames:[...document.querySelectorAll('iframe')].map(f=>({path:new URL(f.src).pathname,text:f.contentDocument?.body?.innerText?.slice(-500),state:f.contentWindow.__zjLastMobileState,sockets:f.contentWindow.__acceptanceSockets?.map(s=>({path:new URL(s.url).pathname,state:s.readyState}))}))}))));
        }catch{}
        console.error('Private acceptance logs:',dir);throw error;
    } finally {
        if(browser)await browser.close();
        if(created)try{cli('kill-session',name);}catch{}
        if(otherCreated)try{cli('kill-session',otherName);}catch{}
        await stop(relay);await stop(native);
        if(updateController){updateController.closeAllConnections();await new Promise(resolve=>updateController.close(resolve));}
        if(tokenName)try{cli('web','--revoke-token',tokenName);}catch{}
        if(readOnlyTokenName)try{cli('web','--revoke-token',readOnlyTokenName);}catch{}
        fs.rmSync(path.join(dir,'token'),{force:true});
    }
})().catch(error=>{console.error(error);process.exitCode=1;});
