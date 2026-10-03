// Real old/new engines and a live PTY, isolated from the user's sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');

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
const env = {...process.env, ZELLIJ_SOCKET_DIR: path.join(dir, 'sockets'), SWITCHBOARD_RELEASES_DIR: path.join(dir, 'releases'), TERM: 'xterm-256color'};
for (const key of ['ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_CONFIG_FILE', 'ZELLIJ_CONFIG_DIR']) delete env[key];
env.ZELLIJ_CONFIG_FILE = config;
fs.writeFileSync(config, 'default_shell "/bin/bash"\nshow_startup_tips false\nsession_serialization false\nweb_server false\n');
fs.copyFileSync(oldBinary, installed);
fs.chmodSync(installed, 0o755);
const run = (binary, args) => execFileSync(binary, args, {env, encoding:'utf8', timeout:30000, stdio:['ignore','pipe','pipe']});
const cli = (...args) => run(installed, args);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const panes = session => JSON.parse(cli('-s', session, 'action', 'list-panes', '--json', '--all'));
const processes = () => run('/bin/ps', ['-axo', 'pid=,ppid=,command=']).trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return {pid:Number(match[1]), ppid:Number(match[2]), command:match[3]};
});
const update = (binary, overrides = {}) => spawnSync('/bin/bash', [path.join(__dirname, 'update_local.sh'), binary, installed], {env:{...env,...overrides}, encoding:'utf8', timeout:30000});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    let oldCreated = false, newCreated = false;
    try {
        const heartbeat = path.join(dir, 'heartbeat');
        const shell = `while true; do printf . >> '${heartbeat}'; printf .; sleep 0.2; done`;
        cli('attach', '--create-background', oldSession, '--', '/bin/bash', '--noprofile', '--norc', '-c', shell);
        oldCreated = true;
        const server = processes().find(p => p.command.includes('--server ') && p.command.endsWith('/'+oldSession));
        assert.ok(server, 'Old session server was started');
        const children = processes().filter(p => p.ppid === server.pid).map(p => p.pid);
        assert.ok(children.length, 'Session owns a terminal child');
        const identities = panes(oldSession).map(p => [p.is_plugin,p.id,p.tab_id]);
        await sleep(400);
        const beforeOutput = fs.statSync(heartbeat).size;
        const oldHash = hash(installed);

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

        const result = update(newBinary);
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.equal(hash(installed), hash(newBinary), 'New executable is installed');
        assert.deepEqual(panes(oldSession).map(p => [p.is_plugin,p.id,p.tab_id]), identities);
        const after = processes();
        assert.ok(after.some(p => p.pid === server.pid), 'Old session server survives');
        for (const pid of children) assert.ok(after.some(p => p.pid === pid && p.ppid === server.pid), 'Terminal child survives');
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
        console.log('PASS: incompatible/malformed/stalled candidate rejection, atomic installation, rollback and failed-copy protection, stable PTY/server IDs, ongoing output, new native sessions. Input/browser reconnection are not covered.');
    } finally {
        if (newCreated) try {run(newBinary, ['kill-session', newSession]);} catch {}
        if (oldCreated) try {run(newBinary, ['kill-session', oldSession]);} catch {}
        fs.rmSync(dir, {recursive:true, force:true});
    }
})().catch(error => {console.error(error); process.exitCode=1;});
