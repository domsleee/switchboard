// A real browser stays attached while its session moves to a new engine.
// Everything runs in a private home; never point this at the user's sessions.
// Usage: PLAYWRIGHT_MODULE=/path/to/playwright node engine-handoff-viewer.test.cjs [BINARY]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const {execFileSync, spawn} = require('node:child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '../..');
const binary = path.resolve(process.argv[2] || path.join(root, 'target/release/zellij'));
const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? (process.env.RUNNER_TEMP || os.tmpdir()) : '/tmp', 'sbh-'));
const config = path.join(dir, 'config.kdl');
const hosts = path.join(dir, 'hosts');
const name = `handoff-viewer-${crypto.randomBytes(6).toString('hex')}`;
const outer = `${name}-outer`;
const notShared = `${name}-unshared`;
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const fixture = path.join(root, 'tools/switchboard/resumable-viewer/fixture.py');
const env = {
    ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(dir, 'AppData', 'Local'), XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_CACHE_HOME: path.join(dir, 'cache'), ZELLIJ_SOCKET_DIR: path.join(dir, 'sockets'),
    SWITCHBOARD_ATTACHMENT_DIRECTORY: path.join(dir, 'attachments'),
    SWITCHBOARD_VIEWER_LOCK: path.join(dir, 'viewers.lock'),
    SWITCHBOARD_TERMINAL_HOST: '1', SWITCHBOARD_TERMINAL_HOST_ROOT: hosts,
    ZELLIJ_CONFIG_FILE: config, TERM: 'xterm-256color',
};
for (const key of ['ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'ZELLIJ_CONFIG_DIR']) delete env[key];
for (const folder of [env.APPDATA, env.LOCALAPPDATA, env.ZELLIJ_SOCKET_DIR]) fs.mkdirSync(folder, {recursive: true});

let cliSequence = 0;
// A background engine inherits these handles, so a pipe here would never close.
const cli = (...args) => {
    const log = path.join(dir, `cli-${++cliSequence}.log`), out = fs.openSync(log, 'w');
    try {
        execFileSync(binary, ['--config', config, ...args], {env, windowsHide: true, timeout: 20000, stdio: ['ignore', out, out]});
        const result = fs.readFileSync(log, 'utf8');
        if (args.includes('--create-token')) fs.writeFileSync(log, '[credential output omitted]\n');
        return result;
    } finally {
        fs.closeSync(out);
    }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message, attempts = 300) {
    for (let n = 0; n < attempts; n++) {
        try { if (await check()) return; } catch {}
        await sleep(100);
    }
    throw Error(message);
}
async function availablePort() {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function stop(child) {
    if (!child || child.exitCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([done, sleep(5000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })]);
}
const findFile = (folder, file) => fs.readdirSync(folder, {recursive: true}).map(entry => path.join(folder, entry)).find(entry => path.basename(entry) === file);
const panes = () => JSON.parse(cli('-s', name, 'action', 'list-panes', '--json', '--all')).filter(pane => !pane.is_plugin);
const identities = () => panes().map(pane => [pane.id, pane.tab_id]).sort();
const frame = "document.querySelector('#terminals>iframe.active')?.contentWindow";

let native, relay, browser, created = false;
(async () => {
    try {
        console.log('Private fixture:', dir);
        fs.writeFileSync(config, 'web_sharing "on"\nshow_startup_tips false\nsession_serialization false\n');
        const tokenLine = cli('web', '--create-token').split('\n').find(line => line.includes(': '));
        const token = tokenLine.slice(tokenLine.indexOf(': ') + 2).trim();
        const tokenPath = path.join(dir, 'token');
        fs.writeFileSync(tokenPath, token, {mode: 0o600});
        const nativePort = await availablePort(), relayPort = await availablePort();
        const url = `http://127.0.0.1:${relayPort}`, nativeUrl = `http://127.0.0.1:${nativePort}`;
        const relayConfig = path.join(dir, 'hosts.json');
        fs.writeFileSync(relayConfig, JSON.stringify({hosts: [{id: 'test', name: 'Handoff', url: nativeUrl, token_file: tokenPath, zellij_binary: binary}]}));
        const start = (args, label) => spawn(binary, args, {env, windowsHide: true, stdio: ['ignore', fs.openSync(path.join(dir, label + '.log'), 'a'), fs.openSync(path.join(dir, label + '-error.log'), 'a')]});

        const firstDir = path.join(dir, 'first'), targetDir = path.join(dir, 'target');
        fs.mkdirSync(firstDir);
        fs.mkdirSync(targetDir);
        cli('attach', '--create-background', name, '--', python, '-u', fixture, firstDir);
        created = true;
        const fixturePid = folder => JSON.parse(fs.readFileSync(path.join(folder, 'fixture.json'))).pid;
        await waitFor(() => fixturePid(firstDir), 'First fixture did not start');
        cli('-s', name, 'action', 'new-tab', '--name', 'Target', '--', python, '-u', fixture, targetDir);
        await waitFor(() => fixturePid(targetDir), 'Target fixture did not start');
        const firstPid = fixturePid(firstDir), targetPid = fixturePid(targetDir);
        const firstPane = panes().map(pane => pane.id).sort((a, b) => a - b)[0];
        const targetPane = panes().map(pane => pane.id).sort((a, b) => b - a)[0];
        assert.notEqual(firstPane, targetPane);

        native = start(['--config', config, 'web', '--port', String(nativePort)], 'native');
        relay = start(['serve', '--host-config', relayConfig, '--port', String(relayPort)], 'relay');
        await waitFor(async () => (await fetch(url)).ok, 'Services did not start');

        browser = await chromium.launch({headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE});
        const context = await browser.newContext({viewport: {width: 1200, height: 800}});
        const page = await context.newPage();
        page.on('pageerror', error => console.error('Browser error:', error.message));
        await page.addInitScript(() => window.addEventListener('zellij-resumable-sockets', event => { window.testPair = event.detail; }));
        await page.goto(url);
        await page.waitForFunction(`${frame}?.testPair?.terminal.readyState===1`);
        await page.waitForFunction(`${frame}?.__zjLastMobileState?.active_pane`);

        const control = (target, payload) => target.evaluate(payload => {
            const pair = (document.querySelector('#terminals>iframe.active')?.contentWindow || window).testPair;
            pair.control.send(JSON.stringify({web_client_id: pair.control.owner.viewer, payload}));
        }, payload);
        const drained = target => target.waitForFunction(() => {
            const owner = (document.querySelector('#terminals>iframe.active')?.contentWindow || window).testPair.terminal.owner;
            return !owner.stopped && owner.pending.length === 0;
        });
        await control(page, {type: 'FocusPane', pane_id: targetPane, is_plugin: false});
        await drained(page);

        const inputFile = path.join(targetDir, 'input.bin');
        let expected = '';
        const send = async text => {
            expected += text;
            await page.evaluate(([frameSource, text]) => eval(frameSource).term.input(text), [frame, text]);
        };
        const delivered = message => waitFor(() => fs.readFileSync(inputFile, 'utf8') === expected, message);
        await send('before|');
        await delivered('Typing did not reach the focused pane before the handoff');

        const health = async () => (await (await fetch(url + '/api/health')).json()).attachment_workers;
        const workers = await health(), before = identities();
        await page.evaluate(frameSource => { const w = eval(frameSource); window.savedTerm = w.term; window.savedDocument = w.document; }, frame);

        const swap = async id => {
            const marker = path.join(hosts, 'in-progress', name);
            const pipe = spawn(binary, ['--config', config, '-s', name, 'pipe', '--name', 'switchboard-handoff', '--', id], {env, windowsHide: true, stdio: 'ignore'});
            const exited = new Promise(resolve => pipe.once('exit', resolve));
            await waitFor(() => fs.existsSync(marker), 'The handoff was not marked');
            await send(`marked-${id}|`);
            let manifest;
            await waitFor(() => (manifest = findFile(hosts, `${id}.json`)), 'No handoff manifest appeared');
            await send(`frozen-${id}|`);
            await Promise.race([exited, sleep(20000).then(() => { throw Error('The old engine did not exit'); })]);
            await sleep(500);
            await send(`absent-${id}|`);
            env.SWITCHBOARD_HANDOFF_MANIFEST = manifest;
            try { cli('attach', '--create-background', name); } finally { delete env.SWITCHBOARD_HANDOFF_MANIFEST; }
            await waitFor(() => !fs.existsSync(marker), 'The new engine did not finish adopting');
        };

        fs.writeFileSync(path.join(targetDir, 'go'), '');
        await swap('first');
        await send('after|');
        await delivered('Typing was lost or duplicated across the handoff');
        await drained(page);
        console.log('PASS: typing is held through the handoff and delivered once to the focused pane');

        assert.deepEqual(identities(), before, 'Panes and tabs keep their identities');
        process.kill(firstPid, 0);
        process.kill(targetPid, 0);
        assert.deepEqual(await health(), workers, 'The same attachment worker serves the viewer');
        assert.deepEqual((await (await fetch(url + '/api/hosts/test')).json()).sessions.map(session => session.name), [name], 'No session is created in place of the moving one');
        assert.ok(await page.evaluate(frameSource => { const w = eval(frameSource); return w.term === window.savedTerm && w.document === window.savedDocument && !w.__zjResumeFailure; }, frame), 'The browser document and renderer survive');
        assert.equal(fs.readFileSync(path.join(firstDir, 'input.bin'), 'utf8'), '', 'A new engine does not move the viewer to the first tab');
        console.log('PASS: viewer, panes, processes and focus survive the handoff without a new session');

        await waitFor(() => fs.readFileSync(path.join(targetDir, 'output.txt'), 'utf8').includes('OUT:000400'), 'The pane stopped producing output', 600);
        await page.waitForFunction(frameSource => {
            const term = eval(frameSource).term;
            return Array.from({length: term.buffer.active.length}, (_, i) => term.buffer.active.getLine(i)?.translateToString() || '').some(line => line.includes('OUT:000400'));
        }, frame);
        console.log('PASS: output reaches the viewer after the handoff');

        // A viewer the user cannot see must stay out of sizing on the new engine.
        const largeContext = await browser.newContext({viewport: {width: 1800, height: 1000}});
        assert.equal((await largeContext.request.post(nativeUrl + '/command/login', {data: {auth_token: token, remember_me: true}})).status(), 200);
        const large = await largeContext.newPage();
        await large.addInitScript(() => window.addEventListener('zellij-resumable-sockets', event => { window.testPair = event.detail; }));
        await large.goto(`${nativeUrl}/${name}`);
        await large.waitForFunction(() => window.testPair?.terminal.readyState === 1);
        await control(large, {type: 'FocusPane', pane_id: targetPane, is_plugin: false});
        await drained(large);
        await page.setViewportSize({width: 600, height: 450});
        const small = await page.evaluate(frameSource => eval(frameSource).__zjViewport.dimensions(), frame);
        await control(page, {type: 'TerminalResize', ...small});
        await drained(page);
        const columns = () => panes().find(pane => pane.id === targetPane).pane_columns;
        await waitFor(() => columns() === small.cols, 'The small viewer did not constrain the terminal');
        await control(page, {type: 'SetViewerHidden', hidden: true});
        await drained(page);
        await waitFor(() => columns() > small.cols + 40, 'Hiding the small viewer did not release its size');
        const wide = columns();
        await swap('hidden');
        await send('after-hidden|');
        await delivered('Typing was lost or duplicated across a second handoff');
        await sleep(4000); // Past the window in which the new engine holds PTY resizes.
        assert.equal(columns(), wide, 'A hidden viewer does not size the terminal on the new engine');
        assert.deepEqual(identities(), before, 'Panes survive a second handoff');
        await largeContext.close();
        console.log('PASS: a hidden viewer stays hidden on the new engine across a second handoff');

        // A native client runs in a pane of another private session, which gives it a terminal.
        const clients = () => cli('-s', name, 'action', 'list-clients').split('\n').filter(line => /^\s*\d+/.test(line)).length;
        const viewersOnly = clients();
        const unsetNesting = "import os,subprocess,sys;[os.environ.pop(k,None) for k in ('ZELLIJ','ZELLIJ_SESSION_NAME','ZELLIJ_PANE_ID')];sys.exit(subprocess.call(sys.argv[1:]))";
        cli('attach', '--create-background', outer, '--', python, '-c', unsetNesting, binary, '--config', config, 'attach', name);
        await waitFor(() => clients() === viewersOnly + 1, 'The native client did not attach');
        const typeNatively = async text => {
            // The outer session has no client, so its pane must be named.
            cli('-s', outer, 'action', 'write-chars', '--pane-id', 'terminal_0', text);
            try {
                // A native client is not told which tab it was on, so either pane may receive this.
                await waitFor(() => [firstDir, targetDir].some(folder => fs.readFileSync(path.join(folder, 'input.bin'), 'utf8').includes(text)), `Native typing did not arrive: ${text}`, 100);
                if (fs.readFileSync(inputFile, 'utf8').includes(text)) expected += text;
            } catch (error) {
                console.error('Native client screen:', cli('-s', outer, 'action', 'dump-screen', '-f').trimEnd());
                console.error('Clients:', cli('-s', name, 'action', 'list-clients').trimEnd());
                throw error;
            }
        };
        await sleep(1000);
        await typeNatively('native-before|');
        await swap('native');
        await waitFor(() => clients() === viewersOnly + 1, 'The native client did not reattach to the new engine');
        await sleep(1000);
        await swap('native-again'); // With no key press between handoffs.
        await waitFor(() => clients() === viewersOnly + 1, 'The native client did not reattach twice');
        await sleep(1000);
        await typeNatively('native-after|');
        await delivered('Typing was lost or duplicated across a third handoff');
        assert.deepEqual((await (await fetch(url + '/api/hosts/test')).json()).sessions.map(session => session.name).sort(), [name, outer].sort(), 'A reattaching native client creates no session');
        console.log('PASS: a native client reattaches to the new engine and keeps typing');

        assert.match(cli('switchboard', 'engine-fingerprint').trim(), /^[0-9a-f]{16}$/);
        const swapEngine = async (tag, ...flags) => {
            const log = path.join(dir, `swap-${tag}.log`), out = fs.openSync(log, 'w');
            const child = spawn(binary, ['--config', config, 'switchboard', 'swap-engine', name, '--binary', binary, '--config', config, ...flags], {env, windowsHide: true, stdio: ['ignore', out, out]});
            fs.closeSync(out);
            const exited = new Promise(resolve => child.once('exit', resolve));
            await waitFor(() => fs.existsSync(path.join(hosts, 'in-progress', name)), 'The swap did not start');
            await send(`${tag}-moving|`);
            const code = await Promise.race([exited, sleep(120000).then(() => { throw Error(`Swap ${tag} did not finish: ${fs.readFileSync(log, 'utf8')}`); })]);
            return {code, output: fs.readFileSync(log, 'utf8')};
        };
        const stillTheSameSession = async message => {
            await send(`${message}|`);
            await delivered(`Typing was lost or duplicated: ${message}`);
            assert.deepEqual(identities(), before, `Panes survive: ${message}`);
            process.kill(firstPid, 0);
            process.kill(targetPid, 0);
            assert.equal(fs.existsSync(path.join(hosts, 'in-progress', name)), false, `No move is left in progress: ${message}`);
        };
        const moved = await swapEngine('verified');
        assert.equal(moved.code, 0, moved.output);
        assert.match(moved.output, /Moved /);
        await stillTheSameSession('after-verified-swap');
        console.log('PASS: the updater command verifies and commits a new engine');

        // An update can replace the file a running engine started from.
        const previousBuild = path.join(dir, `previous${path.extname(binary)}`);
        fs.copyFileSync(binary, previousBuild);
        const sessionRecord = path.join(hosts, 'sessions', `${name}.json`);
        const editRecord = change => fs.writeFileSync(sessionRecord, JSON.stringify({...JSON.parse(fs.readFileSync(sessionRecord, 'utf8')), ...change}));
        editRecord({executable: path.join(dir, 'replaced-by-an-update')});
        const rejected = await swapEngine('rejected', '--reject-first-verification', '--previous', previousBuild);
        assert.notEqual(rejected.code, 0, rejected.output);
        assert.match(rejected.output, /Rolled .* back/);
        await stillTheSameSession('after-rollback');
        assert.equal(path.basename(JSON.parse(fs.readFileSync(path.join(hosts, 'sessions', `${name}.json`), 'utf8')).executable), path.basename(previousBuild), 'Rollback uses the retained build');
        console.log('PASS: a new engine that fails verification hands the session back');

        // Sharing changed at runtime must not fall back to what the configuration says.
        cli('attach', '--create-background', notShared);
        await waitFor(() => cli('-s', notShared, 'action', 'list-panes', '--json', '--all').includes('"id"'), 'The unshared session did not start');
        cli('-s', notShared, 'action', 'set-web-sharing', 'off');
        const sharing = async () => (await (await fetch(url + '/api/hosts/test')).json()).sessions.find(session => session.name === notShared)?.web_clients_allowed;
        await waitFor(async () => (await sharing()) === false, 'Sharing was not turned off');
        const unsharedLog = path.join(dir, 'swap-unshared.log'), unsharedOutput = fs.openSync(unsharedLog, 'w');
        execFileSync(binary, ['--config', config, 'switchboard', 'swap-engine', notShared, '--binary', binary, '--config', config], {env, windowsHide: true, timeout: 120000, stdio: ['ignore', unsharedOutput, unsharedOutput]});
        fs.closeSync(unsharedOutput);
        assert.match(fs.readFileSync(unsharedLog, 'utf8'), /Moved /);
        await sleep(1000);
        assert.equal(await sharing(), false, 'A session unshared at runtime stays unshared on its new engine');
        console.log('PASS: runtime sharing survives a move');

        // The updater moves only sessions whose engine is built differently.
        // A wrapper stands in for an older build, which reports its own fingerprint.
        const olderBuild = path.join(dir, process.platform === 'win32' ? 'older.cmd' : 'older');
        fs.writeFileSync(olderBuild, process.platform === 'win32'
            ? `@echo off\r\nif "%1"=="switchboard" if "%2"=="engine-fingerprint" (echo an-older-build& exit /b 0)\r\n"${binary}" %*\r\n`
            : `#!/bin/sh\nif [ "$1 $2" = "switchboard engine-fingerprint" ]; then echo an-older-build; exit 0; fi\nexec "${binary}" "$@"\n`, {mode: 0o755});
        editRecord({engine: 'an-older-build', executable: olderBuild});
        const swapOutdated = () => {
            const log = path.join(dir, `outdated-${++cliSequence}.log`), out = fs.openSync(log, 'w');
            execFileSync(binary, ['--config', config, 'switchboard', 'swap-outdated-engines', '--binary', binary, '--config', config], {env, windowsHide: true, timeout: 120000, stdio: ['ignore', out, out]});
            fs.closeSync(out);
            return fs.readFileSync(log, 'utf8');
        };
        assert.deepEqual(swapOutdated().trim().split('\n'), [`Moved ${name} to a new engine`], 'Only the outdated session moves');
        await stillTheSameSession('after-updater-move');
        assert.equal(swapOutdated().trim(), '', 'A moved session is not moved again');
        console.log('PASS: the updater moves outdated sessions and leaves current ones alone');
    } finally {
        if (browser) await browser.close();
        try { cli('kill-session', outer); } catch {}
        try { cli('kill-session', notShared); } catch {}
        if (created) try { cli('kill-session', name); } catch {}
        await stop(native);
        await stop(relay);
        const attachments = path.join(dir, 'attachments');
        for (const file of fs.existsSync(attachments) ? fs.readdirSync(attachments) : []) {
            if (file.endsWith('.json')) try { process.kill(JSON.parse(fs.readFileSync(path.join(attachments, file))).pid, 'SIGTERM'); } catch {}
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
