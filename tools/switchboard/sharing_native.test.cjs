// Native sharing CLI acceptance against private sessions and a private web service.
// Usage: node sharing_native.test.cjs [BINARY]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {execFileSync, spawn, spawnSync} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const binary = path.resolve(process.argv[2] || path.join(__dirname, '../../target/release/zellij'));
const dir = fs.mkdtempSync('/tmp/sbn-');
const suffix = crypto.randomBytes(6).toString('hex');
const names = ['off', 'disabled'].map(mode => `__switchboard_control_sharing_${mode}_${suffix}`);
const configs = names.map((_, index) => path.join(dir, `${index}.kdl`));
const env = {...process.env, ZELLIJ_SOCKET_DIR: path.join(dir, 'sockets'), TERM: 'xterm-256color'};
for (const key of ['ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_CONFIG_FILE','ZELLIJ_CONFIG_DIR','SWITCHBOARD_RECOVER_UNSHARED_SESSION']) delete env[key];
const run = (index, ...args) => execFileSync(binary, ['--config', configs[index], ...args], {env, encoding:'utf8', timeout:15000, stdio:['ignore','pipe','pipe']});
const action = (index, ...args) => run(index, '-s', names[index], 'action', ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message) {
    for (let n=0; n<150; n++) {try {if (await check()) return;} catch {} await sleep(100);}
    throw Error(message);
}
function processes() {
    return execFileSync('/bin/ps', ['-axo','pid=,ppid=,lstart=,command='], {encoding:'utf8'}).trim().split('\n').map(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
        return match && {pid:Number(match[1]), ppid:Number(match[2]), started:match[3], command:match[4]};
    }).filter(Boolean);
}
function paneIds(index) {
    return JSON.parse(action(index, 'list-panes','--json','--all')).map(pane => [pane.is_plugin,pane.id,pane.tab_id]).sort();
}
async function port() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const result = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return result;
}
let web, tokenName, readOnlyTokenName, browser;
const created = [];
(async () => {
    try {
        for (let index=0; index<configs.length; index++) {
            fs.writeFileSync(configs[index], `web_sharing "${index?'disabled':'off'}"\ndefault_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\nweb_server false\n`);
            run(index, 'attach','--create-background',names[index],'--','/bin/bash','--noprofile','--norc');
            created.push(index);
            await waitFor(() => paneIds(index).length > 0, 'Private session did not spawn its pane');
        }
        const snapshots = names.map((name,index) => {
            const entries = processes();
            const server = entries.find(entry => entry.command.includes('--server ') && entry.command.endsWith('/'+name));
            assert.ok(server,'Private session server exists');
            const shells = entries.filter(entry => entry.ppid === server.pid);
            assert.ok(shells.length,'Private session has a terminal process');
            return {server,shells,panes:paneIds(index)};
        });
        const marker = 'STATE_'+crypto.randomBytes(8).toString('hex');
        const before = path.join(dir,'before');
        const after = path.join(dir,'after');
        action(0,'write-chars','--pane-id',String(snapshots[0].panes[0][1]),`SB_NATIVE_STATE=${marker}; printf '%s %s\\n' "$$" "$SB_NATIVE_STATE" > '${before}'\r`);
        await waitFor(() => fs.readFileSync(before,'utf8').endsWith('\n'), 'Initial shell state command did not run');
        const initialState = fs.readFileSync(before,'utf8');
        assert.ok(initialState.trim().endsWith(marker));
        const output = run(0,'web','--create-token');
        const line = output.split('\n').find(line => line.includes(': '));
        assert.ok(line,'Created a fixture-only authentication token');
        tokenName = line.split(': ')[0];
        const authToken = line.slice(tokenName.length+2).trim();
        const nativePort = await port();
        const url = `http://127.0.0.1:${nativePort}`;
        web = spawn(binary, ['--config',configs[0],'web','--port',String(nativePort)], {env, stdio:['ignore',fs.openSync(path.join(dir,'web.log'),'a'),fs.openSync(path.join(dir,'web-error.log'),'a')]});
        await waitFor(async () => (await fetch(url+'/info/version')).ok, 'Private web service did not start');
        const login = await fetch(url+'/command/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({auth_token:authToken,remember_me:false})});
        assert.equal(login.status,200);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        const catalog = async () => {
            const response = await fetch(url+'/session-list',{headers:{Cookie:cookie}});
            assert.equal(response.status,200);
            return (await response.json()).sessions;
        };
        const allowed = async index => (await catalog()).find(session => session.name===names[index])?.web_clients_allowed;
        await waitFor(async () => await allowed(0) === false && await allowed(1) === false, 'Initial Off/Disabled metadata was not published');
        for (const enabled of ['on','off','on','off']) {
            action(0,'set-web-sharing',enabled);
            await waitFor(async () => await allowed(0) === (enabled==='on'), 'CLI success did not reach native session metadata');
            const entry = (await catalog()).find(session => session.name===names[0]);
            assert.ok(!entry.sharing_recovery,'Native sharing is not reported as temporary recovery');
            assert.deepEqual(paneIds(0),snapshots[0].panes,'Sharing preserves tab and pane identities');
        }
        action(0,'set-web-sharing','on');
        await waitFor(async()=>await allowed(0)===true,'Sharing did not enable before browser attachment');
        const readOnlyOutput=run(0,'web','--create-read-only-token');
        const readOnlyLine=readOnlyOutput.split('\n').find(line=>line.includes(': '));
        readOnlyTokenName=readOnlyLine.split(': ')[0];
        const readOnlyToken=readOnlyLine.slice(readOnlyTokenName.length+2).replace(/ \(read-only\)\s*$/,'').trim();
        const clients=()=>new Set(action(0,'list-clients').split('\n').map(line=>line.trim().split(/\s+/)[0]).filter(id=>/^\d+$/.test(id)));
        const originalClients=clients();
        browser=await chromium.launch({headless:true});
        async function viewer(token){
            const context=await browser.newContext({viewport:{width:1200,height:800}});
            assert.equal((await context.request.post(url+'/command/login',{data:{auth_token:token,remember_me:false}})).status(),200);
            const page=await context.newPage();page.setDefaultTimeout(30000);
            const sockets=[];
            page.on('websocket',socket=>{if(/\/ws\/(terminal|control)/.test(socket.url()))sockets.push(socket);});
            await page.goto(url+'/'+names[0]);
            await waitFor(()=>['terminal','control'].every(type=>sockets.some(socket=>socket.url().includes('/ws/'+type)&&!socket.isClosed())),'Authenticated viewer did not attach both terminal and control');
            await page.waitForFunction(()=>window.term?.buffer?.active);
            return {context,page,sockets};
        }
        const writable=await viewer(authToken), watcher=await viewer(readOnlyToken);
        async function terminalContains(page,text){
            await page.waitForFunction(expected=>{
                const term=window.term;
                if(!term)return false;
                for(let n=0;n<term.buffer.active.length;n++)if(term.buffer.active.getLine(n)?.translateToString().includes(expected))return true;
                return false;
            },text);
        }
        async function browserCommand(prefix){
            await writable.page.locator('.xterm-helper-textarea').focus();
            await writable.page.keyboard.type(`printf '%s%s\\n' "${prefix}" "$SB_NATIVE_STATE"`);
            await writable.page.keyboard.press('Enter');
            await terminalContains(writable.page,prefix+marker);
            await terminalContains(watcher.page,prefix+marker);
        }
        await browserCommand('WEB_BEFORE_');
        assert.ok(clients().size>originalClients.size,'Browser attachment creates actual native session clients');
        action(0,'set-web-sharing','off');
        await waitFor(async()=>await allowed(0)===false,'Off sharing did not publish');
        await waitFor(()=>[writable,watcher].every(view=>view.sockets.length&&view.sockets.every(socket=>socket.isClosed())),'Off did not close terminal/control for both writable browser and read-only watcher');
        await waitFor(()=>{
            const current=clients();
            return current.size===originalClients.size&&[...current].every(id=>originalClients.has(id));
        },'Screen/session clients were not cleaned up after sharing was disabled');
        assert.deepEqual(paneIds(0),snapshots[0].panes,'Evicting browsers preserves terminal panes');
        action(0,'set-web-sharing','on');
        await waitFor(async()=>await allowed(0)===true,'Sharing could not reenable');
        // Off intentionally disconnects viewers; an explicit reload reattaches after On.
        await writable.page.reload();await watcher.page.reload();
        await waitFor(()=>[writable,watcher].every(view=>['terminal','control'].every(type=>view.sockets.some(socket=>socket.url().includes('/ws/'+type)&&!socket.isClosed()))),'Browsers did not reattach after sharing was enabled');
        await browserCommand('WEB_REATTACHED_');
        await writable.context.close();await watcher.context.close();
        for (const enabled of ['on','off']) {
            const rejected = spawnSync(binary,['--config',configs[1],'-s',names[1],'action','set-web-sharing',enabled],{env,encoding:'utf8',timeout:15000});
            assert.equal(rejected.error,undefined,'Disabled action exits without timing out');
            assert.equal(rejected.status,2,'Disabled sharing rejects with a nonzero CLI status');
            assert.match(rejected.stderr,/sharing is disabled/i);
            assert.equal(await allowed(1),false,'Disabled session remains inaccessible');
        }
        action(0,'write-chars','--pane-id',String(snapshots[0].panes[0][1]),`printf '%s %s\\n' "$$" "$SB_NATIVE_STATE" > '${after}'\r`);
        await waitFor(() => fs.readFileSync(after,'utf8').endsWith('\n'), 'Shell input did not work after sharing changes');
        assert.equal(fs.readFileSync(after,'utf8'),initialState,'Shell PID and in-memory variable survive sharing changes');
        const finalProcesses = processes();
        for (let index=0; index<snapshots.length; index++) {
            const snapshot = snapshots[index];
            assert.deepEqual(paneIds(index),snapshot.panes,'All private sessions retain panes');
            for (const original of [snapshot.server,...snapshot.shells]) {
                assert.ok(finalProcesses.some(entry => entry.pid===original.pid && entry.ppid===original.ppid && entry.started===original.started),'Session and terminal process identities survive');
            }
        }
        console.log('PASS: native sharing CLI updates authenticated catalog; real writable browser and read-only watcher receive terminal output; Off evicts both and cleans session/screen clients; On permits explicit browser reconnection with preserved shell PID/state and tab/pane identities; Disabled rejects promptly.');
    } finally {
        if(browser)await browser.close();
        if (web && web.exitCode===null) {
            const stopped = new Promise(resolve => web.once('exit',resolve));
            web.kill('SIGTERM');
            await Promise.race([stopped,sleep(5000).then(() => {if(web.exitCode===null)web.kill('SIGKILL');})]);
        }
        for (const index of created) try {run(index,'kill-session',names[index]);} catch {}
        if (tokenName) try {run(0,'web','--revoke-token',tokenName);} catch {}
        if (readOnlyTokenName) try {run(0,'web','--revoke-token',readOnlyTokenName);} catch {}
        fs.rmSync(dir,{recursive:true,force:true});
    }
})().catch(error => {console.error(error);process.exitCode=1;});
