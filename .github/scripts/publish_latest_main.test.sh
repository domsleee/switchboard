#!/usr/bin/env bash
# Runs publish_latest_main.sh against a fake gh and git: bash .github/scripts/publish_latest_main.test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/published"
# Fake gh: release assets live in $work/published; compare answers from $COMPARE.
cat > "$work/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >> "$WORK/calls"
case "$1 $2" in
  "release view") exit 0 ;;
  "release download") file="$WORK/published/$5"; [ -f "$file" ] && cat "$file" || exit 1 ;;
  "release upload") shift 4; for f in "$@"; do cp "$f" "$WORK/published/"; done ;;
  "api repos/"*) echo "$COMPARE" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
EOF
printf '#!/usr/bin/env bash\necho "git $*" >> "$WORK/calls"\n' > "$work/bin/git"
chmod +x "$work/bin/gh" "$work/bin/git"
export WORK=$work PATH="$work/bin:$PATH" GH_REPO=owner/repo

build() { # build COMMIT PLATFORM...: artifacts for COMMIT
  rm -rf "$work/artifacts"
  for platform in "${@:2}"; do
    mkdir -p "$work/artifacts/switchboard-$platform"
    echo "{\"commit\":\"$1\"}" > "$work/artifacts/switchboard-$platform/bundle.json"
    echo "$1" > "$work/artifacts/switchboard-$platform/zellij"
  done
}
publish() { : > "$work/calls"; GITHUB_SHA=$1 COMPARE=$2 bash "$here/publish_latest_main.sh" "$work/artifacts"; }
commit() { jq -r .commit "$work/published/switchboard-$1-bundle.json"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

build new windows; publish new unused
[ "$(commit windows)" = new ] || fail 'a first build publishes'
build old windows; publish old behind
[ "$(commit windows)" = new ] || fail 'an older build that finishes later must not replace a newer one'
[ "$(cat "$work/published/switchboard-windows-zellij")" = new ] || fail 'the binary stays with its manifest'
! grep -q '^git ' "$work/calls" || fail 'the tag stays on the newer build'
build newer windows; publish newer ahead
[ "$(commit windows)" = newer ] || fail 'a newer build replaces an older one'
publish newer unused
grep -q 'release upload' "$work/calls" || fail 'rerunning the same build republishes it'
build orphan windows; publish orphan diverged
[ "$(commit windows)" = orphan ] || fail 'a build the compare cannot order still publishes'
# One job publishes several platforms; each is judged by its own manifest.
build mac1 macos-arm64; publish mac1 unused
build mac0 macos-arm64 macos-x86_64; publish mac0 behind
[ "$(commit macos-arm64)" = mac1 ] && [ "$(commit macos-x86_64)" = mac0 ] || fail 'platforms are skipped independently'
echo 'publish_latest_main: all checks passed'
