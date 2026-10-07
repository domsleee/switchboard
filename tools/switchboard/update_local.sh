#!/bin/bash
# Manual macOS updates. Never overwrite a live executable or stop a session server.
# By default the web server and relay are restarted onto the new executable.
set -euo pipefail
umask 077

usage() {
    echo "Usage: $0 [--binary-only] NEW_BINARY [INSTALLED_BINARY]" >&2
    echo "Default: ~/.cargo/bin/zellij. Requires jq. Restarts the web server and relay" >&2
    echo "(launchd job dev.zellij.switchboard); --binary-only leaves running services alone." >&2
    exit 2
}
# The environment form lets auto_update.py (which restarts services itself)
# drive both this and older copies of the script, which reject unknown flags.
binary_only=${SWITCHBOARD_UPDATE_BINARY_ONLY:-0}
if [[ ${1:-} == --binary-only ]]; then binary_only=1; shift; fi
[[ $# -ge 1 && $# -le 2 && ${1:-} != --* ]] || usage
[[ $(uname -s) == Darwin ]] || { echo 'This updater supports macOS only.' >&2; exit 2; }
command -v jq >/dev/null || { echo 'Install jq before updating.' >&2; exit 2; }
# The web server and its sessions start panes with $SHELL; use the login shell,
# not whatever shell ran this script (agents often run zsh or sh).
login_shell=$(dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null | sed -n 's/^UserShell: //p') || true
[[ -z $login_shell ]] || export SHELL=$login_shell
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
job="gui/$(id -u)/${SWITCHBOARD_LAUNCHD_LABEL:-dev.zellij.switchboard}"
relay_port=${SWITCHBOARD_RELAY_PORT:-8090}
service_timeout=${SWITCHBOARD_UPDATE_SERVICE_TIMEOUT:-60}
expected_commit=${SWITCHBOARD_EXPECTED_COMMIT:-}
restarted=false

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

# This installation's web server and relay: "PID web|serve" lines plus start times.
snapshot_services() {
    : > "$work/$1"
    ps -U "$(id -u)" -o pid=,command= | while read -r pid command; do
        case $command in
            "$installed web "*) kind=web ;;
            "$installed serve "*) kind=serve ;;
            *) continue ;;
        esac
        ps -p "$pid" -o lstart= > "$work/service-$pid" && echo "$pid $kind" >> "$work/$1"
    done
}
alive() { ps -p "$1" -o lstart= 2>/dev/null | cmp -s "$2" -; }
previous_gone() {
    local pid kind
    while read -r pid kind; do
        [[ -n ${1:-} && $kind != "$1" ]] || ! alive "$pid" "$work/service-$pid" || return 1
    done < "$work/services-before"
}
wait_for() {
    local deadline=$((SECONDS + $1)); shift
    until "$@"; do (( SECONDS < deadline )) || return 1; sleep 0.5; done
}
restart_services() {
    restarted=true
    snapshot_services services-before
    # Session servers are separate processes; stopping web disconnects browsers only.
    probe "$installed" web --stop > /dev/null 2>&1 || true
    # The job starts web only if web --status fails, so let the old one exit first.
    wait_for 10 previous_gone web || true
    launchctl kickstart -k "$job"
}
services_ready() {
    previous_gone || return 1
    snapshot_services services-after
    grep -q ' web$' "$work/services-after" && grep -q ' serve$' "$work/services-after" || return 1
    probe "$installed" web --status --timeout 2 > /dev/null 2>&1 || return 1
    curl -fsS --max-time 3 -H 'Host: switchboard.localhost' "http://127.0.0.1:$relay_port/api/health" > "$work/health" 2>/dev/null || return 1
    jq -e --arg expected "$expected_commit" '.relay == "rust" and (.commit | type == "string") and
        ($expected == "" or (.commit as $c | ($expected | startswith($c)) or ($c | startswith($expected))))' "$work/health" > /dev/null
}
start_plain_web() {
    # A job pinned to SWITCHBOARD_RECOVER_UNSHARED_SESSION for a replaced socket
    # daemonizes and then exits, so its `|| web --daemonize` fallback never runs.
    probe "$installed" web --status --timeout 2 > /dev/null 2>&1 ||
        (cd "$HOME" && env -u SWITCHBOARD_RECOVER_UNSHARED_SESSION -u SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY \
            "$installed" web --daemonize < /dev/null > /dev/null 2>&1) || true
}
await_services() {
    wait_for $((service_timeout / 2)) services_ready && return 0
    start_plain_web
    wait_for $((service_timeout / 2)) services_ready
}

finish() {
    local result=$?
    trap - EXIT
    trap '' INT TERM
    set +e
    [[ -z $staged ]] || rm -f "$staged"
    staged=''
    if [[ $result != 0 && $changed == true ]]; then
        if [[ $restarted == true ]]; then
            echo 'Update failed; restoring the previous executable and restarting services.' >&2
        else
            echo 'Update failed; restoring the previous executable. Running services remain untouched.' >&2
        fi
        if ! atomic_install "$old_release" "$old_hash"; then
            echo "Automatic restore failed; restore manually from $old_release" >&2
        elif [[ $restarted == true ]]; then
            expected_commit=''
            if restart_services && await_services; then
                echo "Web server and relay restarted on the previous executable ($(jq -r .commit "$work/health"))." >&2
            else
                echo "Services did not recover on the previous executable; inspect: launchctl print $job" >&2
            fi
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
if [[ $binary_only != 1 ]]; then
    # Restart only the job that runs this executable's relay; otherwise change nothing.
    launchctl print "$job" > "$work/job" 2>&1 || {
        echo "Service job $job is not loaded; install it (install_service.py) or use --binary-only." >&2; exit 1;
    }
    grep -qF -- "$installed serve " "$work/job" || {
        echo "Service job $job does not run $installed serve; use --binary-only." >&2; exit 1;
    }
fi

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
# Session servers own the PTYs and must survive. Their shells and agents may
# exit on their own during an update, which is not an update failure.
ps -U "$(id -u)" -o pid=,lstart=,command= | awk '/(^|\/| )(zellij|switchboard) .*--server / {print $1}' > "$work/protected-pids"
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

verify_sessions() {
    local pid session index=0
    while IFS= read -r pid; do
        ps -p "$pid" -o lstart= > "$work/current-start"
        cmp -s "$work/process-$pid" "$work/current-start" || { echo "Session server process changed: $pid" >&2; exit 1; }
    done < "$work/protected-pids"
    while IFS= read -r session; do
        panes "$installed" "$session" > "$work/probe"
        cmp -s "$work/panes-$index" "$work/probe" || { echo "Session panes changed: $session" >&2; exit 1; }
        index=$((index+1))
    done < "$work/sessions"
}
verify_sessions
if [[ $binary_only == 1 ]]; then
    echo "Installed $new_hash. Existing session servers, terminal processes and pane identities are intact."
    echo "Previous binary retained at $old_release"
    echo 'Binary-only: running services and browser connections remain untouched; new sessions use the update.'
    exit 0
fi
restart_services
await_services || { echo "Web server or relay did not come back on $new_hash (relay port $relay_port)." >&2; exit 1; }
verify_sessions
echo "Installed $new_hash and restarted the web server and relay (relay reports $(jq -r .commit "$work/health"))."
echo 'Session servers, terminal processes and pane identities are intact; browsers reconnect.'
echo "Previous binary retained at $old_release"
