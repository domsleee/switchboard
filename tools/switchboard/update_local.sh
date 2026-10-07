#!/bin/bash
# Manual macOS binary updates. Never stop services or overwrite a live executable.
set -euo pipefail
umask 077

usage() {
    echo "Usage: $0 NEW_BINARY [INSTALLED_BINARY]" >&2
    echo "Default: ~/.cargo/bin/zellij. Requires jq; running services are never restarted." >&2
    exit 2
}
[[ $# -ge 1 && $# -le 2 && ${1:-} != --* ]] || usage
[[ $(uname -s) == Darwin ]] || { echo 'This updater supports macOS only.' >&2; exit 2; }
command -v jq >/dev/null || { echo 'Install jq before updating.' >&2; exit 2; }
candidate=$1
installed=${2:-$HOME/.cargo/bin/zellij}
probe_timeout=${SWITCHBOARD_UPDATE_PROBE_TIMEOUT:-15}
[[ $probe_timeout =~ ^[1-9][0-9]*$ && ${#probe_timeout} -le 3 && $probe_timeout -le 300 ]] || {
    echo 'SWITCHBOARD_UPDATE_PROBE_TIMEOUT must be 1–300 seconds.' >&2; exit 2;
}
[[ -x $candidate && -f $candidate && -x $installed && -f $installed && ! -L $installed ]] || {
    echo 'Expected an executable candidate and a regular installed executable.' >&2; exit 2;
}
lock="$installed.update-lock"
work=''
staged=''
changed=false
old_release=''
releases=${SWITCHBOARD_RELEASES_DIR:-$HOME/.local/share/switchboard/releases}

digest() { shasum -a 256 "$1" | awk '{print $1}'; }
# The alarm survives exec and terminates only this read-only CLI probe.
probe() { /usr/bin/perl -e 'alarm shift; exec @ARGV; die "exec failed: $!\n"' "$probe_timeout" "$@"; }

atomic_install() {
    local actual_hash
    staged=$(mktemp "$installed.update.XXXXXX") || return 1
    cp "$1" "$staged" || return 1
    chmod 755 "$staged" || return 1
    actual_hash=$(digest "$staged") || return 1
    [[ $actual_hash == "$2" ]] || { echo 'Staged executable checksum mismatch.' >&2; return 1; }
    mv -f "$staged" "$installed" || return 1
    staged=''
}

finish() {
    local result=$?
    trap - EXIT
    trap '' INT TERM
    set +e
    [[ -z $staged ]] || rm -f "$staged"
    staged=''
    if [[ $result != 0 && $changed == true ]]; then
        echo 'Update failed; restoring the previous executable. Running services remain untouched.' >&2
        if ! atomic_install "$old_release" "$old_hash"; then
            echo "Automatic restore failed; restore manually from $old_release" >&2
        fi
    fi
    [[ -z $staged ]] || rm -f "$staged"
    [[ -z $work ]] || rm -rf "$work"
    rmdir "$lock"
    exit "$result"
}
mkdir "$lock" || { echo 'Another update is running (or its lock needs inspection).' >&2; exit 1; }
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
work=$(mktemp -d "$lock/work.XXXXXX")
old_hash=$(digest "$installed")
new_hash=$(digest "$candidate")
old_release="$releases/$old_hash/zellij"
new_release="$releases/$new_hash/zellij"

# Keep exact old and new binaries, including the old executable's inode when possible.
mkdir -p "$(dirname "$old_release")" "$(dirname "$new_release")"
if [[ ! -e $old_release ]]; then
    ln "$installed" "$old_release" 2>/dev/null || cp -p "$installed" "$old_release"
fi
[[ $(digest "$old_release") == "$old_hash" ]] || { echo 'Invalid rollback copy.' >&2; exit 1; }
if [[ ! -e $new_release ]]; then
    cp "$candidate" "$work/candidate"
    chmod 755 "$work/candidate"
    [[ $(digest "$work/candidate") == "$new_hash" ]] || { echo 'Candidate changed during staging.' >&2; exit 1; }
    mv "$work/candidate" "$new_release"
fi
[[ $(digest "$new_release") == "$new_hash" ]] || { echo 'Invalid staged release.' >&2; exit 1; }
probe "$new_release" --version

# A development build may use a different token database while still speaking
# the same session protocol. Refuse to strand the installed app's credentials.
probe "$installed" web --list-tokens > "$work/installed-tokens"
probe "$new_release" web --list-tokens > "$work/candidate-tokens"
LC_ALL=C sort -u "$work/installed-tokens" > "$work/installed-tokens-sorted"
LC_ALL=C sort -u "$work/candidate-tokens" > "$work/candidate-tokens-sorted"
LC_ALL=C comm -23 "$work/installed-tokens-sorted" "$work/candidate-tokens-sorted" > "$work/missing-tokens"
[[ ! -s "$work/missing-tokens" ]] || {
    echo 'Authentication compatibility check failed: candidate cannot see existing tokens. Use a release build with the same authentication database.' >&2
    exit 1
}

# Only live sessions: resurrectable layouts do not contain running processes.
if probe "$installed" list-sessions --no-formatting > "$work/session-list" 2> "$work/list-error"; then
    awk '!/\(EXITED - attach to resurrect\)/ {sub(/ \[Created .*$/, ""); print}' "$work/session-list" > "$work/sessions"
elif [[ $(cat "$work/list-error") == 'No active zellij sessions found.' ]]; then
    : > "$work/sessions"
else
    cat "$work/list-error" >&2; exit 1
fi
ps -U "$(id -u)" -o pid=,lstart=,command= | awk '/(^|\/| )(zellij|switchboard) .*--server / {print $1}' > "$work/server-pids"
# The direct PTY children are persistent shells/agents. Do not include their
# transient descendants (for example, a short-lived command completing normally).
ps -U "$(id -u)" -o pid=,ppid= > "$work/process-tree"
cp "$work/server-pids" "$work/protected-pids"
while IFS= read -r pid; do
    awk -v parent="$pid" '$2 == parent {print $1}' "$work/process-tree" >> "$work/protected-pids"
done < "$work/server-pids"
while IFS= read -r pid; do
    ps -p "$pid" -o lstart= > "$work/process-$pid"
done < "$work/protected-pids"

panes() {
    probe "$1" -s "$2" action list-panes --json --all > "$work/panes.json" || return 1
    jq -ce '
      def identity_number: type == "number" and . >= 0 and floor == .;
      if type != "array" then error("Expected a pane array")
      elif length == 0 then error("Live session has no panes")
      elif all(.[]; type == "object" and
          (.is_plugin | type == "boolean") and
          (.id | identity_number) and (.tab_id | identity_number))
      then map([.is_plugin, .id, .tab_id]) | sort
      else error("Invalid pane identity") end
    ' "$work/panes.json"
}
index=0
while IFS= read -r session; do
    panes "$installed" "$session" > "$work/panes-$index"
    panes "$new_release" "$session" > "$work/probe"
    cmp -s "$work/panes-$index" "$work/probe" || { echo "Session compatibility check failed: $session" >&2; exit 1; }
    index=$((index+1))
done < "$work/sessions"

# Set rollback intent before the atomic rename, including interruption immediately afterward.
changed=true
atomic_install "$new_release" "$new_hash"

while IFS= read -r pid; do
    ps -p "$pid" -o lstart= > "$work/current-start"
    cmp -s "$work/process-$pid" "$work/current-start" || { echo "Session or terminal process changed: $pid" >&2; exit 1; }
done < "$work/protected-pids"
index=0
while IFS= read -r session; do
    panes "$installed" "$session" > "$work/probe"
    cmp -s "$work/panes-$index" "$work/probe" || { echo "Session panes changed: $session" >&2; exit 1; }
    index=$((index+1))
done < "$work/sessions"
echo "Installed $new_hash. Existing session servers, terminal processes and pane identities are intact."
echo 'This is a binary-only install, not a browser recovery check or live engine upgrade.'
echo "Previous binary retained at $old_release"
echo 'Running services and browser connections remain untouched; new sessions use the update.'
