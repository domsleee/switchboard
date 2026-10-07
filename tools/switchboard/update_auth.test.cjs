const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

function update(installedTokens, candidateTokens) {
  const dir = fs.mkdtempSync('/tmp/switchboard-auth-update-');
  const installed = path.join(dir, 'installed'), candidate = path.join(dir, 'candidate');
  const binary = tokens => `#!/bin/bash
case "$1" in
  --version) echo 'test binary';;
  web) cat <<'TOKENS'
${tokens}
TOKENS
  ;;
  list-sessions) echo 'No active zellij sessions found.' >&2; exit 1;;
  *) exit 2;;
esac
`;
  try {
    fs.writeFileSync(installed, binary(installedTokens), {mode:0o755});
    fs.writeFileSync(candidate, binary(candidateTokens), {mode:0o755});
    const before = fs.readFileSync(installed, 'utf8');
    const result = spawnSync('/bin/bash', [path.join(__dirname, 'update_local.sh'), candidate, installed], {
      env:{...process.env, LC_ALL:'C', SWITCHBOARD_RELEASES_DIR:path.join(dir, 'releases')}, encoding:'utf8', timeout:30000,
    });
    return {...result, unchanged:fs.readFileSync(installed, 'utf8') === before};
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
}

test('updater rejects a candidate using a different authentication database', {skip:process.platform !== 'darwin'}, () => {
  const result = update('existing token: created at 2026-10-07', '');
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Authentication compatibility check failed/);
  assert.equal(result.unchanged, true);
});

test('updater accepts a candidate that retains existing authentication tokens', {skip:process.platform !== 'darwin'}, () => {
  const result = update('existing token: created at 2026-10-07', 'existing token: created at 2026-10-07\nadditional token: created at 2026-10-07');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.unchanged, false);
});
