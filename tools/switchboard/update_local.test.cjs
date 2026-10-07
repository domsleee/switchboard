// Real old/new engines, a live PTY and real web/relay services, isolated from the
// user's sessions and services (private HOME, sockets, ports and a fake launchctl).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const {execFileSync, spawn, spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '../..');
assert.ok(process.argv[2], 'Pass an existing pre-update executable as the first argument');
const oldBinary = path.resolve(process.argv[2]);
const newBinary = path.resolve(process.argv[3] || path.join(root, 'target/release/zellij'));
const dir = fs.mkdtempSync('/tmp/switchboard-update-');
const installed = path.join(dir, 'zellij');
const config = path.join(dir, 'config.kdl');
const suffix = crypto.randomBytes(6).toString('hex');
const oldSession = `__switchboard_control_update_old_${suffix}`;
const newSession = `__switchboard_control_update_new_${suffix}`;
const hosts = path.join(dir, 'hosts.json');
const fakeBin = path.join(dir, 'fake-bin');
const label = `dev.zellij.switchboard.test-${suffix}`;
const env = {...process.env, HOME: dir, ZELLIJ_SOCKET_DIR: path.join(dir, 'sockets'), SWITCHBOARD_RELEASES_DIR: path.join(dir, 'releases'), TERM: 'xterm-256color',
    PATH: fakeBin + ':' + process.env.PATH, SWITCHBOARD_LAUNCHD_LABEL: label, SWITCHBOARD_UPDATE_SERVICE_TIMEOUT: '10',
    FAKE_JOB_PID: path.join(dir, 'job.pid'), FAKE_JOB_LOG: path.join(dir, 'job.log')};
for (const key of ['ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_CONFIG_FILE', 'ZELLIJ_CONFIG_DIR', 'SWITCHBOARD_UPDATE_BINARY_ONLY', 'SWITCHBOARD_EXPECTED_COMMIT',
    'SWITCHBOARD_RECOVER_UNSHARED_SESSION', 'SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY']) delete env[key];
env.ZELLIJ_CONFIG_FILE = config;
fs.copyFileSync(oldBinary, installed);
fs.chmodSync(installed, 0o755);
fs.writeFileSync(hosts, '{"hosts":[]}');
// launchd stand-in: one job, the same shape as install_service.py's command.
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'launchctl'), `#!/bin/bash
[[ $2 == -k ]] && target=$3 || target=$2
[[ $target == "gui/$(id -u)/${label}" ]] || { echo "Could not find service" >&2; exit 113; }
case $1 in
  print) printf 'arguments = {\\n\\t/bin/sh\\n\\t-c\\n\\t%s\\n}\\n' "$FAKE_JOB_COMMAND" ;;
  kickstart)
    if [[ -f $FAKE_JOB_PID ]]; then
      pid=$(cat "$FAKE_JOB_PID"); kill "$pid" 2>/dev/null
      while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    fi
    /bin/sh -c "$FAKE_JOB_COMMAND" < /dev/null >> "$FAKE_JOB_LOG" 2>&1 &
    echo $! > "$FAKE_JOB_PID" ;;
  *) exit 64 ;;
esac
`, {mode:0o755});
const run = (binary, args, extra = {}) => execFileSync(binary, args, {env:{...env,...extra}, encoding:'utf8', timeout:30000, stdio:['ignore','pipe','pipe']});
const cli = (...args) => run(installed, args);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const panes = session => JSON.parse(cli('-s', session, 'action', 'list-panes', '--json', '--all'));
const processes = () => run('/bin/ps', ['-axo', 'pid=,ppid=,command=']).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return {pid:Number(match[1]), ppid:Number(match[2]), command:match[3]};
});
const update = (binary, overrides = {}, flags = []) => spawnSync('/bin/bash', [path.join(__dirname, 'update_local.sh'), ...flags, binary, installed], {env:{...env,...overrides}, encoding:'utf8', timeout:90000});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => {
    const server = net.createServer().listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
});
// A fresh connection each time: services restart between requests.
const health = port => new Promise((resolve, reject) => {
    require('node:http').get({host:'127.0.0.1', port, path:'/api/health', agent:false, timeout:2000, headers:{host:'switchboard.localhost'}}, response => {
        let body = ''; response.on('data', chunk => body += chunk);
        response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    }).on('error', reject).on('timeout', function () { this.destroy(Error('timeout')); });
});
const waitFor = async (check, message) => {
    for (let n = 0; n < 100; n++) { try { const value = await check(); if (value) return value; } catch {} await sleep(200); }
    throw Error(message);
};
// This installation's web server and relay processes, identified like the updater does.
const services = () => processes().filter(p => p.command.startsWith(installed+' web ') || p.command.startsWith(installed+' serve '));
const relayPid = () => services().find(p => p.command.startsWith(installed+' serve ')).pid;
const webUp = () => spawnSync(installed, ['web', '--status', '--timeout', '2'], {env, timeout:10000}).status === 0;

(async () => {
    let oldCreated = false, newCreated = false;
    try {
        const webPort = await freePort(), relayPort = await freePort(), probePort = await freePort();
        fs.writeFileSync(config, `default_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\nweb_server false\nweb_server_port ${webPort}\n`);
        env.SWITCHBOARD_RELAY_PORT = String(relayPort);
        const relayCommand = `exec ${installed} serve --host-config ${hosts} --port ${relayPort}`;
        env.FAKE_JOB_COMMAND = `${installed} web --status --timeout 2 >/dev/null 2>&1 || { ${installed} web --daemonize; }; ${relayCommand}`;
        // The candidate's build identity, read from a short-lived private relay.
        const probeRelay = spawn(newBinary, ['serve', '--host-config', hosts, '--port', String(probePort)], {env, stdio:'ignore'});
        const newCommit = (await waitFor(() => health(probePort), 'Candidate relay did not start')).commit;
        probeRelay.kill();
        run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
        const oldCommit = (await waitFor(() => health(relayPort), 'Fake service job did not start the relay')).commit;
        await waitFor(webUp, 'Fake service job did not start the web server');

        const heartbeat = path.join(dir, 'heartbeat');
        const shell = `while true; do printf . >> '${heartbeat}'; printf .; sleep 0.2; done`;
        cli('attach', '--create-background', oldSession, '--', '/bin/bash', '--noprofile', '--norc', '-c', shell);
        oldCreated = true;
        const server = await waitFor(() => processes().find(p => p.command.includes('--server ') && p.command.endsWith('/'+oldSession)), 'Old session server was started');
        const children = await waitFor(() => { const pids = processes().filter(p => p.ppid === server.pid).map(p => p.pid); return pids.length && pids; }, 'Session owns a terminal child');
        const identities = panes(oldSession).map(p => [p.is_plugin,p.id,p.tab_id]);
        await sleep(400);
        const beforeOutput = fs.statSync(heartbeat).size;
        const oldHash = hash(installed);
        const firstRelay = relayPid();

        const missingJob = update(newBinary, {SWITCHBOARD_LAUNCHD_LABEL: label+'-missing'});
        assert.notEqual(missingJob.status, 0);
        assert.match(missingJob.stderr, /is not loaded/);
        const otherJob = update(newBinary, {FAKE_JOB_COMMAND: '/other/zellij serve --port 1'});
        assert.notEqual(otherJob.status, 0);
        assert.match(otherJob.stderr, /does not run/);
        assert.equal(hash(installed), oldHash, 'Service preflight failures leave installation unchanged');
        assert.equal(relayPid(), firstRelay, 'Service preflight failures leave services running');

        const incompatible = path.join(dir, 'incompatible');
        fs.writeFileSync(incompatible, `#!/bin/bash\nif [[ "$1" == -s ]]; then exit 7; fi\nexec '${newBinary}' "$@"\n`, {mode:0o755});
        assert.notEqual(update(incompatible).status, 0, 'Incompatible candidates are refused');
        assert.equal(hash(installed), oldHash, 'Preflight failure leaves installation unchanged');

        const malformed = path.join(dir, 'malformed');
        fs.writeFileSync(malformed, `#!/bin/bash\nif [[ "$1" == -s ]]; then echo '{"unexpected":true}'; exit 0; fi\nexec '${newBinary}' "$@"\n`, {mode:0o755});
        assert.notEqual(update(malformed).status, 0, 'Malformed pane JSON is refused');
        assert.equal(hash(installed), oldHash);

        const stalled = path.join(dir, 'stalled');
        fs.writeFileSync(stalled, `#!/bin/bash\nif [[ "$1" == -s ]]; then exec /bin/sleep 30; fi\nexec '${newBinary}' "$@"\n`, {mode:0o755});
        const started = Date.now();
        const timedOut = update(stalled, {SWITCHBOARD_UPDATE_PROBE_TIMEOUT:'1'});
        assert.notEqual(timedOut.status, 0, 'Stalled probes are refused');
        assert.equal(timedOut.error, undefined, 'The updater bounds its own probes');
        assert.ok(Date.now() - started < 10000);
        assert.equal(hash(installed), oldHash);
        assert.ok(!fs.existsSync(installed+'.update-lock'), 'Timed-out probes release the lock');

        const failing = path.join(dir, 'postcheck-failure');
        const counter = path.join(dir, 'counter');
        fs.writeFileSync(failing, `#!/bin/bash\nif [[ "$1" == -s ]]; then\n n=0; [[ ! -f '${counter}' ]] || read -r n < '${counter}'\n n=$((n+1)); echo "$n" > '${counter}'\n if [[ $n -gt 1 ]]; then echo '[]'; exit 0; fi\nfi\nexec '${newBinary}' "$@"\n`, {mode:0o755});
        const failed = update(failing);
        assert.notEqual(failed.status, 0, 'A failed post-install check rolls back');
        assert.match(failed.stderr, /restoring the previous executable/);
        assert.equal(hash(installed), oldHash, 'Rollback restores exact previous bytes');

        // A failed rollback copy must never rename a partial file over the installed binary.
        fs.unlinkSync(counter);
        const mockBin = path.join(dir, 'mock-bin');
        fs.mkdirSync(mockBin);
        fs.writeFileSync(path.join(mockBin, 'cp'), `#!/bin/bash\nif [[ "$1" == */${oldHash}/zellij ]]; then printf partial > "$2"; exit 9; fi\nexec /bin/cp "$@"\n`, {mode:0o755});
        const restoreFailed = update(failing, {PATH:mockBin+':'+env.PATH});
        assert.notEqual(restoreFailed.status, 0);
        assert.match(restoreFailed.stderr, /Automatic restore failed/);
        assert.equal(hash(installed), hash(failing), 'Failed rollback leaves the complete candidate in place');
        assert.equal(hash(path.join(env.SWITCHBOARD_RELEASES_DIR, oldHash, 'zellij')), oldHash);
        fs.copyFileSync(oldBinary, installed+'.restore');
        fs.renameSync(installed+'.restore', installed);
        fs.chmodSync(installed, 0o755);

        assert.equal(relayPid(), firstRelay, 'Failures before installation completes never restart services');
        const sessionsSurvive = () => {
            const after = processes();
            assert.ok(after.some(p => p.pid === server.pid), 'Old session server survives');
            for (const pid of children) assert.ok(after.some(p => p.pid === pid && p.ppid === server.pid), 'Terminal child survives');
            assert.deepEqual(panes(oldSession).map(p => [p.is_plugin,p.id,p.tab_id]), identities);
        };

        // Services restart on the candidate, then a failed check rolls back and restarts them again.
        const servicesBefore = services().map(p => p.pid);
        const wrongBuild = update(newBinary, {SWITCHBOARD_EXPECTED_COMMIT: '0000000'});
        assert.notEqual(wrongBuild.status, 0, 'A post-restart verification failure rolls back');
        assert.match(wrongBuild.stderr, /restoring the previous executable and restarting services/);
        assert.match(wrongBuild.stderr, /restarted on the previous executable/, wrongBuild.stderr);
        assert.equal(hash(installed), oldHash, 'Rollback restores exact previous bytes');
        assert.equal((await health(relayPort)).commit, oldCommit, 'Relay is back on the previous build');
        assert.ok(webUp(), 'Web server is back after rollback');
        assert.ok(services().every(p => !servicesBefore.includes(p.pid)), 'Rollback replaced both services');
        sessionsSurvive();

        // A job pinned to recovery of a missing socket kills its own web start; the
        // updater must still bring up a plain web server.
        const pinned = `env SWITCHBOARD_RECOVER_UNSHARED_SESSION=gone-${suffix} SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY=1:2:3:4 ${installed} web --daemonize || ${installed} web --daemonize`;
        const rolledBack = services().map(p => p.pid);
        const result = update(newBinary, {SWITCHBOARD_EXPECTED_COMMIT: newCommit,
            FAKE_JOB_COMMAND: `${installed} web --status --timeout 2 >/dev/null 2>&1 || { ${pinned}; }; ${relayCommand}`});
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, /restarted the web server and relay/);
        assert.equal(hash(installed), hash(newBinary), 'New executable is installed');
        assert.equal((await health(relayPort)).commit, newCommit, 'Relay runs the new build');
        assert.ok(webUp(), 'Web server answers after the update');
        const restarted = services();
        assert.ok(restarted.some(p => p.command.startsWith(installed+' web ')) && restarted.some(p => p.command.startsWith(installed+' serve ')));
        assert.ok(restarted.every(p => !rolledBack.includes(p.pid)), 'Web server and relay were restarted onto the new executable');
        sessionsSurvive();
        await sleep(400);
        assert.ok(fs.statSync(heartbeat).size > beforeOutput, 'Output continues across update and rollback');

        cli('attach', '--create-background', newSession, '--', '/bin/bash', '--noprofile', '--norc');
        newCreated = true;
        let nativePanes = [];
        for (let n=0; n<30 && !nativePanes.length; n++) {
            await sleep(100);
            nativePanes = panes(newSession);
        }
        assert.ok(nativePanes.length, 'New native session spawns a terminal');
        assert.ok(nativePanes.every(p => !p.is_plugin), 'New sessions use the plugin-free engine');
        const relayBeforeBinaryOnly = relayPid();
        const binaryOnly = update(oldBinary, {}, ['--binary-only']);
        assert.equal(binaryOnly.status, 0, binaryOnly.stderr);
        assert.equal(hash(installed), oldHash);
        assert.equal(relayPid(), relayBeforeBinaryOnly, '--binary-only leaves services running');
        console.log('PASS: service-job preflight, incompatible/malformed/stalled candidate rejection, atomic installation, rollback and failed-copy protection, web/relay restart onto the new build (including a job pinned to stale recovery), post-restart rollback with service restart, --binary-only, stable PTY/server IDs, ongoing output, new native sessions. Real launchd, input and browser reconnection are not covered.');
    } catch (error) {
        try { console.error('Service job log:\n' + fs.readFileSync(env.FAKE_JOB_LOG, 'utf8').slice(-3000)); } catch {}
        throw error;
    } finally {
        if (newCreated) try {run(newBinary, ['kill-session', newSession]);} catch {}
        if (oldCreated) try {run(newBinary, ['kill-session', oldSession]);} catch {}
        try {run(newBinary, ['web', '--stop']);} catch {}
        for (const p of services()) try {process.kill(p.pid);} catch {}
        fs.rmSync(dir, {recursive:true, force:true});
    }
})().catch(error => {console.error(error); process.exitCode=1;});
