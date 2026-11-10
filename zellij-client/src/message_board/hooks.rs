//! Lifecycle delivery for agents in Switchboard panes. The board remains the source
//! of unread mail; local cursors suppress repeated context, never acknowledge it.
use super::{cli::Client, *};
use anyhow::Context;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const POLL: Duration = Duration::from_secs(2);
// Watchers are owned and cancelled by the agent's hook runner, including at exit.
pub(crate) const WATCH_TIMEOUT: u64 = 365 * 24 * 60 * 60;

#[derive(Deserialize)]
struct Event {
    session_id: String,
    hook_event_name: String,
    cwd: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct Session {
    participant: Participant,
    #[serde(default)]
    cursor: u64,
}

enum Delivery {
    Waiting,
    Sent,
    Ended,
}

/// File locks serialize concurrent tools and the background watcher. Locks are
/// released by the OS if a hook is cancelled; persistent lock files are harmless.
fn lock(dir: &Path, name: &str) -> anyhow::Result<Option<File>> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(dir.join(format!("{name}.lock")))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(std::fs::TryLockError::Error(error)) => Err(error.into()),
    }
}

fn load<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<Option<T>> {
    match File::open(path) {
        Ok(file) => Ok(Some(serde_json::from_reader(file.take(1 << 20))?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn save(path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
    let staged = path.with_extension("tmp");
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staged)?;
    serde_json::to_writer(&mut file, value)?;
    file.sync_all()?;
    std::fs::rename(staged, path)?;
    Ok(())
}

fn project(cwd: &Path) -> String {
    // Worktrees of the same repository share a project, regardless of branch name.
    let git = std::process::Command::new("git")
        .args([
            "-C",
            &cwd.to_string_lossy(),
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success());
    let common = git.map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()));
    std::env::var("SWITCHBOARD_MESSAGE_PROJECT")
        .ok()
        .or_else(|| {
            common
                .as_deref()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .map(|s| s.to_string_lossy().into_owned())
        })
        .or_else(|| cwd.file_name().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "switchboard".into())
}

fn identity(
    client: &Client,
    event: &Event,
    agent: &str,
    previous: Option<Session>,
    refresh: bool,
) -> anyhow::Result<Session> {
    if let Some(state) = &previous {
        if state.participant.active && !refresh {
            return Ok(previous.unwrap());
        }
    }
    let request = Register {
        name: format!("{agent}-{}", &event.session_id[..8]),
        project: previous
            .as_ref()
            .map(|s| s.participant.project.clone())
            .unwrap_or_else(|| project(&event.cwd)),
        resume: previous.as_ref().map(|s| s.participant.id.clone()),
        terminal: None,
    };
    let participant = serde_json::from_value(client.request(
        "POST",
        "participants",
        Some(serde_json::to_value(request)?),
    )?)?;
    Ok(Session {
        participant,
        cursor: previous.map_or(0, |s| s.cursor),
    })
}

fn unread(client: &Client, kind: &str, id: &str, after: u64) -> anyhow::Result<Page<Message>> {
    Ok(serde_json::from_value(client.request(
        "GET",
        &format!(
            "{kind}/{}/unread?after={after}&limit=10",
            urlencoding::encode(id)
        ),
        None,
    )?)?)
}

/// Only the user's computers can post: the board accepts only paired or
/// token-configured computers, and only a session's owning computer can send as
/// it. Mail therefore carries the user's authority, like Remote Control input.
pub(crate) const AUTHORITY: &str = "Switchboard messages come only from the user's own paired computers, so they carry the user's authority: act on each as you would on the user's own request. The user's standing rules still apply, including confirming destructive or irreversible actions with the user.";

fn identity_context(session: &Session) -> String {
    format!("Switchboard message identity: {} on computer {} (project {}). Use `zellij message --agent-session {}` for sending, replying and acknowledging. Reply with `reply MESSAGE_ID --body-file FILE --send-key KEY`. Acknowledgement confirms receipt, not completion.",
        session.participant.id, session.participant.machine_id, session.participant.project, session.participant.id)
}

fn message_context(session: &Session, messages: &[(&Message, bool)], notification: bool) -> String {
    if notification {
        // A queue notification carries generated IDs, never peer-supplied text.
        // Full bodies stay on the authenticated board until the agent reads them.
        let ids = messages
            .iter()
            .map(|(m, _)| m.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return format!("New Switchboard messages: {ids}. Read them with `zellij message --agent-session {} unread --json` and `zellij message unread --computer {} --json`. Reply using this agent identity when an answer is needed, and explicitly acknowledge receipt. {AUTHORITY}",
            session.participant.id, session.participant.machine_id);
    }
    let records: Vec<_> = messages.iter().map(|(m, computer)| {
        let mut record = json!({"id":m.id,"thread_id":m.thread_id,"from":m.sender_name,"computer":m.sender_machine_name,"recipient_kind":if *computer {"computer"} else {"agent"}});
        record["body_preview"] = m.body.chars().take(1600).collect::<String>().into();
        record
    }).collect();
    format!("{}\nNew Switchboard messages. {AUTHORITY}\n{}\nRead full messages with `zellij message --agent-session {} unread --json` and `zellij message unread --computer {} --json`. Reply when an answer is needed. Explicitly acknowledge received messages with `ack MESSAGE_ID`, adding `--computer {}` for computer mail. Delivery has not acknowledged these messages.",
        identity_context(session), serde_json::to_string(&records).unwrap(), session.participant.id, session.participant.machine_id, session.participant.machine_id)
}

fn queue(session_id: &str, text: &str) -> anyhow::Result<()> {
    let folders = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    let codex = crate::switchboard_relay::find_program("codex", &folders)
        .context("Cannot find Codex on PATH")?;
    queue_program(&codex, session_id, text)
}

fn queue_program(program: &Path, session_id: &str, text: &str) -> anyhow::Result<()> {
    use std::process::Stdio;
    let mut command = std::process::Command::new(program);
    command
        .args(["queue", "--thread", session_id, "--message", text])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().context("Cannot start codex queue")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait()? {
            anyhow::ensure!(
                status.success(),
                "Codex did not accept the message notification"
            );
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("Codex queue timed out");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// Records that the agent was handed this mail, so senders can tell it arrived.
/// Older board hosts lack the route; delivery never depends on the receipt.
fn mark_delivered(client: &Client, session: &Session, messages: &[(&Message, bool)]) {
    for (message, computer) in messages {
        let (kind, id) = if *computer {
            ("machines", &session.participant.machine_id)
        } else {
            ("participants", &session.participant.id)
        };
        let _ = client.request(
            "POST",
            &format!(
                "{kind}/{}/delivered/{}",
                urlencoding::encode(id),
                urlencoding::encode(&message.id)
            ),
            None,
        );
    }
}

/// The watcher's nearest ancestors: the agent itself, or a launcher (PowerShell on
/// Windows) and the agent. An abrupt exit skips SessionEnd and leaves the watcher
/// polling, which keeps the dead agent looking active to senders.
fn ancestors() -> Vec<(sysinfo::Pid, u64)> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut chain = vec![];
    let mut next = sysinfo::get_current_pid()
        .ok()
        .and_then(|pid| system.process(pid))
        .and_then(|process| process.parent());
    while let Some(process) = next.and_then(|pid| system.process(pid)) {
        if chain.len() == 2 || process.pid().as_u32() <= 1 {
            break;
        }
        chain.push((process.pid(), process.start_time()));
        next = process.parent();
    }
    chain
}

/// A reused PID has a different start time, so it does not count as alive.
fn alive(chain: &[(sysinfo::Pid, u64)]) -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let pids: Vec<_> = chain.iter().map(|(pid, _)| *pid).collect();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing(),
    );
    chain.iter().all(|(pid, started)| {
        system
            .process(*pid)
            .is_some_and(|process| process.start_time() == *started)
    })
}

fn output(event: &str, context: &str, has_messages: bool) -> serde_json::Value {
    if event == "Stop" && has_messages {
        json!({"decision":"block","reason":context})
    } else {
        json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":context}})
    }
}

fn retire(client: &Client, file: &Path, state: &mut Session) -> anyhow::Result<Delivery> {
    // Persist the local end before the network call, so failed retirement cannot
    // reactivate delivery. The end marker keeps retirement retryable.
    state.participant.active = false;
    save(file, state)?;
    client.request(
        "POST",
        &format!("participants/{}/retire", state.participant.id),
        None,
    )?;
    Ok(Delivery::Ended)
}

fn mark_ended(path: &Path) -> anyhow::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.sync_all()?;
    Ok(())
}

/// One bounded read, shared by synchronous hooks and the long-lived watcher.
/// No board acknowledgement is made here. Failed output/queueing leaves cursors
/// unchanged so the next hook can try again.
fn deliver(
    client: &Client,
    dir: &Path,
    agent: &str,
    event: &Event,
    wait: bool,
    initializing: &mut bool,
    output: &mut dyn Write,
) -> anyhow::Result<Delivery> {
    let key = format!("{agent}-{}", event.session_id);
    let ended = dir.join(format!("{key}.ended"));
    if event.hook_event_name == "SessionEnd" {
        std::fs::create_dir_all(dir)?;
        // Publish before taking the session lock. Its current owner must handle
        // retirement even when this short-lived SessionEnd hook cannot acquire it.
        mark_ended(&ended)?;
    }
    if event.hook_event_name == "SessionStart" && !wait {
        // Publish an explicit resume even if the old watcher still owns the
        // lock. A later prompt can then restore this conversation's identity.
        match std::fs::remove_file(&ended) {
            Ok(()) => {},
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => return Err(error.into()),
        }
    }
    let Some(_guard) = lock(dir, &key)? else {
        return Ok(Delivery::Waiting);
    };
    let file = dir.join(format!("{key}.json"));
    let previous: Option<Session> = load(&file)?;
    // SessionStart hooks run concurrently. The watcher must wait for the
    // synchronous hook to clear the old end marker. It can then retry identity
    // restoration if that hook failed while the board was unavailable.
    // Only defer during initialization; a later SessionEnd still ends the watch.
    if *initializing && ended.exists() {
        return Ok(Delivery::Waiting);
    }
    if ended.exists() {
        if let Some(mut state) = previous {
            return retire(client, &file, &mut state);
        }
        return Ok(Delivery::Ended);
    }
    if wait && !*initializing && previous.as_ref().is_some_and(|s| !s.participant.active) {
        return Ok(Delivery::Ended);
    }
    let fresh = previous.is_none();
    let registering = fresh
        || previous.as_ref().is_some_and(|s| !s.participant.active)
        || (!wait && event.hook_event_name == "SessionStart");
    let mut state = identity(
        client,
        event,
        agent,
        previous,
        !wait && event.hook_event_name == "SessionStart",
    )?;
    // Save registration before attempting a read. A board outage must not turn
    // the next hook into a different participant.
    if registering {
        save(&file, &state)?;
    }
    *initializing = false;
    use sha2::{Digest, Sha256};
    let computer_key: String = Sha256::digest(state.participant.machine_id.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let Some(_computer_guard) = lock(dir, &format!("computer-{computer_key}"))? else {
        return Ok(Delivery::Waiting);
    };
    let computer_file = dir.join(format!("computer-{computer_key}.json"));
    let mut computer_cursor: u64 = load(&computer_file)?.unwrap_or_default();
    let before = (state.cursor, computer_cursor);
    let own = unread(client, "participants", &state.participant.id, state.cursor)?;
    let shared = unread(
        client,
        "machines",
        &state.participant.machine_id,
        computer_cursor,
    )?;
    if ended.exists() {
        return retire(client, &file, &mut state);
    }
    let messages: Vec<_> = own
        .items
        .iter()
        .filter(|m| m.sender != state.participant.id)
        .map(|m| (m, false))
        .chain(shared.items.iter().map(|m| (m, true)))
        .collect();
    let has_messages = !messages.is_empty();
    if has_messages
        || (!wait
            && event.hook_event_name != "Stop"
            && (fresh
                || matches!(
                    event.hook_event_name.as_str(),
                    "SessionStart" | "UserPromptSubmit"
                )))
    {
        let text = if has_messages {
            message_context(&state, &messages, wait && agent == "codex")
        } else {
            identity_context(&state)
        };
        if wait && agent == "codex" {
            // Only trusted IDs/metadata go in argv; bodies are read from the
            // authenticated board after wake-up, including on Windows shells.
            queue(&event.session_id, &text)?;
        } else if wait {
            let mut stderr = std::io::stderr().lock();
            writeln!(stderr, "{text}")?;
            stderr.flush()?;
        } else {
            serde_json::to_writer(
                &mut *output,
                &self::output(&event.hook_event_name, &text, has_messages),
            )?;
            writeln!(output)?;
            output.flush()?;
        }
        mark_delivered(client, &state, &messages);
    }
    if let Some(last) = own.items.last() {
        state.cursor = last.cursor;
    }
    if let Some(last) = shared.items.last() {
        computer_cursor = last.cursor;
    }
    if state.cursor != before.0 {
        save(&file, &state)?;
    }
    if computer_cursor != before.1 {
        save(&computer_file, &computer_cursor)?;
    }
    if ended.exists() {
        let retirement = retire(client, &file, &mut state);
        // Emitted Claude context still needs exit 2 to reach the conversation.
        // Retirement must not turn an already emitted notification into exit 0.
        if has_messages {
            return Ok(Delivery::Sent);
        }
        return retirement;
    }
    Ok(if has_messages {
        Delivery::Sent
    } else {
        Delivery::Waiting
    })
}

/// Read only this conversation's hook identity. This never registers or checks mail.
pub(super) fn conversation_participant(
    client: &Client,
    agent: &str,
    thread: &str,
) -> Option<String> {
    if !matches!(agent, "codex" | "claude" | "copilot") || Uuid::parse_str(thread).is_err() {
        return None;
    }
    let root = std::env::var_os("SWITCHBOARD_MESSAGE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| zellij_utils::consts::ZELLIJ_CACHE_DIR.join("message-hooks"));
    load::<Session>(
        &root
            .join(client.hook_namespace())
            .join(format!("{agent}-{thread}.json")),
    )
    .ok()
    .flatten()
    .map(|session| session.participant.id)
}

pub(super) fn conversation_for_participant(
    client: &Client,
    participant: &str,
) -> Option<(String, String)> {
    Uuid::parse_str(participant).ok()?;
    let root = std::env::var_os("SWITCHBOARD_MESSAGE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| zellij_utils::consts::ZELLIJ_CACHE_DIR.join("message-hooks"));
    for entry in std::fs::read_dir(root.join(client.hook_namespace()))
        .ok()?
        .flatten()
    {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "json") {
            continue;
        }
        let stem = path.file_stem()?.to_str()?;
        let Some((agent, thread)) = stem.split_once('-') else {
            continue;
        };
        if !matches!(agent, "codex" | "claude" | "copilot") || Uuid::parse_str(thread).is_err() {
            continue;
        }
        if load::<Session>(&path)
            .ok()
            .flatten()
            .is_some_and(|session| session.participant.id == participant)
        {
            return Some((agent.into(), thread.into()));
        }
    }
    None
}

/// Whether a hook comes from an agent started by another agent in the same pane.
/// Claude's own interactive hooks also set CLAUDECODE, but use the cli entrypoint.
pub(crate) fn nested(agent: &str, env: impl Fn(&str) -> Option<String>) -> bool {
    // A CLI review started by Codex inherits its thread and pane, but its own
    // lifecycle must not replace the terminal agent's status or message inbox.
    (env("CODEX_THREAD_ID").is_some() && agent != "codex")
        || (env("CLAUDECODE").is_some()
            && !(agent == "claude" && env("CLAUDE_CODE_ENTRYPOINT").as_deref() == Some("cli")))
}

/// Native Codex subagents run their hooks in the parent's terminal context.
/// Their rollout has its own ID, but hooks can still report the parent's ID.
/// A resumed child's direct user turn owns the terminal and its own inbox.
pub(crate) fn prepare_codex_hook(agent: &str, input: &mut Vec<u8>, root: &Path) -> bool {
    use std::io::{BufRead, BufReader};
    let mut prepare = || -> Option<bool> {
        if agent != "codex" {
            return None;
        }
        let mut event: serde_json::Value = serde_json::from_slice(input).ok()?;
        let session = Uuid::parse_str(event["session_id"].as_str()?).ok()?;
        let path = Path::new(event["transcript_path"].as_str()?);
        // Inspect only a regular rollout inside this Codex profile, including
        // on Windows where the hook may spell the path with different casing.
        let root = root.canonicalize().ok()?;
        let path = path.canonicalize().ok()?;
        let relative = path.strip_prefix(&root).ok()?;
        if (!relative.starts_with("sessions") && !relative.starts_with("archived_sessions"))
            || path.extension().is_none_or(|ext| ext != "jsonl")
        {
            return None;
        }
        let mut file = File::open(path).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        // Only the first metadata record owns the rollout: a fork can copy its
        // parent's later metadata. Bound both I/O and allocation independently
        // of the transcript's length or a malformed record.
        const LIMIT: u64 = 1 << 20;
        let mut line = Vec::new();
        BufReader::new((&mut file).take(LIMIT + 1))
            .read_until(b'\n', &mut line)
            .ok()?;
        if line.len() as u64 > LIMIT {
            return None;
        }
        let meta: serde_json::Value = serde_json::from_slice(&line).ok()?;
        if meta["type"] != "session_meta" {
            return None;
        }
        let meta = &meta["payload"];
        let id = Uuid::parse_str(meta["id"].as_str()?).ok()?;
        let source = meta.get("source")?.get("subagent")?;
        let matches = |value: &serde_json::Value| {
            value.as_str().and_then(|s| Uuid::parse_str(s).ok()) == Some(session)
        };
        if id == session
            || !(matches(&source["thread_spawn"]["parent_thread_id"])
                || matches(&meta["session_id"]))
        {
            return None;
        }
        if !codex_direct_turn(&mut file, &root, id, &event["turn_id"]) {
            return Some(false);
        }
        // Codex retains the parent session_id even in `codex resume CHILD`.
        // Both attention and message delivery must use the resumed child.
        event["session_id"] = id.to_string().into();
        *input = serde_json::to_vec(&event).ok()?;
        Some(true)
    };
    // Missing or unfamiliar metadata is not proof of inherited ownership.
    prepare().unwrap_or(true)
}

/// The current turn, unlike the rollout's original source, distinguishes work
/// delegated by a parent from a direct user turn in a resumed child. Codex writes
/// task_started before running UserPromptSubmit. Read a bounded tail so long
/// conversations do not make each hook scan the whole transcript.
fn codex_direct_turn(file: &mut File, root: &Path, thread: Uuid, turn: &serde_json::Value) -> bool {
    use std::io::{Seek, SeekFrom};
    let Some(turn) = turn.as_str().and_then(|s| Uuid::parse_str(s).ok()) else {
        return false;
    };
    let mut direct = || -> Option<bool> {
        const LIMIT: u64 = 1 << 20;
        let start = file.metadata().ok()?.len().saturating_sub(LIMIT);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut tail = Vec::new();
        file.take(LIMIT).read_to_end(&mut tail).ok()?;
        let tail = if start > 0 {
            tail.splitn(2, |byte| *byte == b'\n').nth(1)?
        } else {
            &tail
        };
        for line in tail.split(|byte| *byte == b'\n').rev() {
            let Ok(record) = serde_json::from_slice::<serde_json::Value>(line) else {
                continue;
            };
            let event = &record["payload"];
            if record["type"] != "event_msg"
                || event["type"] != "task_started"
                || event["turn_id"]
                    .as_str()
                    .and_then(|s| Uuid::parse_str(s).ok())
                    != Some(turn)
            {
                continue;
            }
            let attribution = &event["turn_attribution"];
            return Some(
                attribution.get("parent_turn_id") == Some(&serde_json::Value::Null)
                    && attribution["turn_id"]
                        .as_str()
                        .and_then(|s| Uuid::parse_str(s).ok())
                        == Some(turn)
                    && attribution["root_turn_id"]
                        .as_str()
                        .and_then(|s| Uuid::parse_str(s).ok())
                        == Some(turn),
            );
        }
        None
    };
    direct()
        .or_else(|| {
            // A long tool result can push task_started out of the bounded tail.
            // Codex projects that same turn's root into its indexed history DB.
            // Read only; never wait on the recorder or create a profile DB.
            let db = rusqlite::Connection::open_with_flags(
                root.join("thread_history_1.sqlite"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .ok()?;
            db.busy_timeout(Duration::ZERO).ok()?;
            let root: String = db
                .query_row(
                    "SELECT root_turn_id FROM thread_turns WHERE thread_id=?1 AND turn_id=?2",
                    [thread.to_string(), turn.to_string()],
                    |row| row.get(0),
                )
                .ok()?;
            Some(Uuid::parse_str(&root).ok()? == turn)
        })
        .unwrap_or(false)
}

/// Native HTTP hooks share the CLI/watcher's delivery cursor and identity, but
/// return context in the response instead of starting a process to print it.
pub(crate) fn http(input: &[u8], relay: &str) -> Option<serde_json::Value> {
    let root = std::env::var_os("SWITCHBOARD_MESSAGE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| zellij_utils::consts::ZELLIJ_CACHE_DIR.join("message-hooks"));
    http_at(input, relay, &root)
}

fn http_at(input: &[u8], relay: &str, root: &Path) -> Option<serde_json::Value> {
    let mut event = serde_json::from_slice::<Event>(input).ok()?;
    event.session_id = Uuid::parse_str(&event.session_id).ok()?.to_string();
    if !event.cwd.is_absolute()
        || !matches!(
            event.hook_event_name.as_str(),
            "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" | "Stop" | "SessionEnd"
        )
    {
        return None;
    }
    let client = Client::hook_relay(relay).ok()?;
    let mut output = Vec::new();
    let _ = deliver(
        &client,
        &root.join(client.hook_namespace()),
        "claude",
        &event,
        false,
        &mut false,
        &mut output,
    );
    serde_json::from_slice(&output).ok()
}

pub(crate) fn run(agent: &str, input: &[u8], wait: bool) {
    // A nested agent shares its parent's pane. Ignore its events; unsupported
    // agents keep their existing status hooks.
    if !matches!(agent, "claude" | "codex")
        || nested(agent, |name| {
            std::env::var(name).ok().filter(|value| !value.is_empty())
        })
        || std::env::var("ZELLIJ_SESSION_NAME")
            .unwrap_or_default()
            .is_empty()
        || std::env::var("ZELLIJ_PANE_ID")
            .ok()
            .and_then(|s| s.parse::<u32>().ok())
            .is_none()
    {
        return;
    }
    let Ok(mut event) = serde_json::from_slice::<Event>(input) else {
        return;
    };
    let Ok(id) = Uuid::parse_str(&event.session_id) else {
        return;
    };
    event.session_id = id.to_string();
    if !event.cwd.is_absolute()
        || !matches!(
            event.hook_event_name.as_str(),
            "SessionStart"
                | "UserPromptSubmit"
                | "PostToolUse"
                | "PostToolUseFailure"
                | "Stop"
                | "SessionEnd"
        )
    {
        return;
    }
    let Ok(client) = Client::for_hook() else {
        return;
    };
    let root = std::env::var_os("SWITCHBOARD_MESSAGE_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| zellij_utils::consts::ZELLIJ_CACHE_DIR.join("message-hooks"));
    let dir = root.join(client.hook_namespace());
    let _watcher = if wait {
        match lock(&dir, &format!("{agent}-{}.watch", event.session_id)) {
            Ok(Some(guard)) => Some(guard),
            _ => return,
        }
    } else {
        None
    };
    let mut initializing = wait && event.hook_event_name == "SessionStart";
    let owners = if wait { ancestors() } else { vec![] };
    let mut polls = 0u32;
    loop {
        match deliver(
            &client,
            &dir,
            agent,
            &event,
            wait,
            &mut initializing,
            &mut std::io::stdout(),
        ) {
            Ok(Delivery::Ended) => return,
            Ok(Delivery::Sent) if wait => {
                if agent == "claude" {
                    std::process::exit(2);
                }
                return;
            },
            // Messaging is optional. An unconfigured/offline board never blocks
            // normal agent work; a watcher retries without waking the model.
            Ok(_) | Err(_) if !wait => {
                // A pending SessionEnd may have arrived during a failed HTTP
                // read. Release the old guard and attempt its handoff once.
                if dir
                    .join(format!("{agent}-{}.ended", event.session_id))
                    .exists()
                {
                    let end = Event {
                        session_id: event.session_id.clone(),
                        cwd: event.cwd.clone(),
                        hook_event_name: "SessionEnd".into(),
                    };
                    let _ = deliver(
                        &client,
                        &dir,
                        agent,
                        &end,
                        false,
                        &mut false,
                        &mut std::io::stdout(),
                    );
                }
                return;
            },
            _ => {},
        }
        polls = polls.wrapping_add(1);
        // Checked every 10 seconds: one process-table read is cheap but not free on Windows.
        if polls.is_multiple_of(5) && !alive(&owners) {
            let end = Event {
                session_id: event.session_id.clone(),
                cwd: event.cwd.clone(),
                hook_event_name: "SessionEnd".into(),
            };
            let _ = deliver(
                &client,
                &dir,
                agent,
                &end,
                false,
                &mut false,
                &mut std::io::stdout(),
            );
            return;
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switchboard_codex_inherited_hooks_cannot_own_the_parent_pane() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join("rollout-child.jsonl");
        let parent = "00000000-0000-4000-8000-000000000001";
        let child = "00000000-0000-4000-8000-000000000002";
        // Sanitized first session_meta from a native Codex subagent. A fork
        // copies parent metadata later, which must not change the decision.
        let meta = json!({"type":"session_meta","payload":{
            "id":child,"session_id":parent,"thread_source":"subagent",
            "source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}
        }});
        std::fs::write(&path, format!("{meta}\n{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{parent}\",\"source\":\"cli\"}}}}\n")).unwrap();
        for event in [
            "SessionStart",
            "UserPromptSubmit",
            "PostToolUse",
            "PostToolUseFailure",
            "Stop",
            "SessionEnd",
        ] {
            let mut body =
                json!({"session_id":parent,"hook_event_name":event,"transcript_path":path});
            let inherited = |body: &serde_json::Value| {
                !prepare_codex_hook("codex", &mut body.to_string().into_bytes(), root.path())
            };
            assert!(
                inherited(&body),
                "{event} may neither report state nor register/retire the parent inbox"
            );
            body["session_id"] = child.into();
            assert!(
                !inherited(&body),
                "Already-correct child session IDs remain unchanged"
            );
        }
        let event = json!({"session_id":parent,"transcript_path":path}).to_string();
        assert!(prepare_codex_hook(
            "claude",
            &mut event.as_bytes().to_vec(),
            root.path()
        ));
        // A new root thread may replace the pane's old conversation normally.
        std::fs::write(
            &path,
            json!({"type":"session_meta","payload":{"id":child,"source":"cli"}}).to_string(),
        )
        .unwrap();
        assert!(prepare_codex_hook(
            "codex",
            &mut event.as_bytes().to_vec(),
            root.path()
        ));
    }

    #[test]
    fn switchboard_codex_resumed_child_uses_its_direct_turn_and_own_inbox() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join("rollout-child.jsonl");
        let parent = "00000000-0000-4000-8000-000000000001";
        let child = "00000000-0000-4000-8000-000000000002";
        let delegated = "00000000-0000-4000-8000-000000000003";
        let direct = "00000000-0000-4000-8000-000000000004";
        let meta = json!({"type":"session_meta","payload":{"id":child,"session_id":parent,
            "source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}});
        let started = |turn, root, parent| {
            json!({"type":"event_msg","payload":{
            "type":"task_started","turn_id":turn,"root_turn_id":root,
            "turn_attribution":{"turn_id":turn,"root_turn_id":root,"parent_turn_id":parent}}})
        };
        // Captured Codex 0.167 resume behaviour: session_id and original source
        // stay inherited; only the resumed turn starts its own attribution chain.
        std::fs::write(
            &path,
            format!(
                "{meta}\n{}\n{}\n{}\n",
                " ".repeat(1 << 20),
                started(delegated, delegated, Some(delegated)),
                started(direct, direct, None)
            ),
        )
        .unwrap();
        for (turn, allowed) in [(delegated, false), (direct, true), (parent, false)] {
            for event in ["UserPromptSubmit", "PostToolUse", "Stop"] {
                let mut body = json!({"session_id":parent,"agent_id":child,"turn_id":turn,
                    "hook_event_name":event,"transcript_path":path})
                .to_string()
                .into_bytes();
                assert_eq!(prepare_codex_hook("codex", &mut body, root.path()), allowed);
                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                assert_eq!(body["session_id"], if allowed { child } else { parent });
            }
        }
        // A missing/malformed or different turn must not borrow the last direct
        // turn's ownership, even after this child was used in a terminal.
        for turn in [json!(null), json!("malformed")] {
            let mut body = json!({"session_id":parent,"turn_id":turn,"transcript_path":path})
                .to_string()
                .into_bytes();
            assert!(!prepare_codex_hook("codex", &mut body, root.path()));
        }
        // Later hooks in the same long turn use Codex's indexed attribution
        // rather than rescanning megabytes of tool output on each invocation.
        let db = rusqlite::Connection::open(root.path().join("thread_history_1.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, root_turn_id TEXT, PRIMARY KEY(thread_id, turn_id))").unwrap();
        db.execute(
            "INSERT INTO thread_turns VALUES (?1, ?2, ?2)",
            [child, direct],
        )
        .unwrap();
        db.execute(
            "INSERT INTO thread_turns VALUES (?1, ?2, ?3)",
            [child, delegated, parent],
        )
        .unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&vec![b' '; (1 << 20) + 1])
            .unwrap();
        for (turn, allowed) in [(delegated, false), (direct, true), (parent, false)] {
            let mut body = json!({"session_id":parent,"turn_id":turn,"transcript_path":path})
                .to_string()
                .into_bytes();
            assert_eq!(prepare_codex_hook("codex", &mut body, root.path()), allowed);
        }
    }

    #[test]
    fn switchboard_codex_hook_ownership_requires_bounded_verified_metadata() {
        use serde_json::json;
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("archived_sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join("rollout.jsonl");
        let event =
            json!({"session_id":"00000000-0000-4000-8000-000000000001","transcript_path":path})
                .to_string();
        for bytes in [
            b"".to_vec(),
            b"{broken".to_vec(),
            vec![b' '; (1 << 20) + 1],
            b"{\"type\":\"event_msg\"}\n".to_vec(),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert!(prepare_codex_hook(
                "codex",
                &mut event.as_bytes().to_vec(),
                root.path()
            ));
        }
        let outside = tempfile::tempdir().unwrap();
        assert!(prepare_codex_hook(
            "codex",
            &mut event.as_bytes().to_vec(),
            outside.path()
        ));
        assert!(prepare_codex_hook(
            "codex",
            &mut b"{}".to_vec(),
            root.path()
        ));
    }

    #[test]
    fn switchboard_codex_tool_agents_do_not_own_the_parent_pane() {
        // Codex exports its thread ID to tool processes. A Claude CLI review
        // inherits it, along with ZELLIJ_PANE_ID, but owns no terminal pane.
        let env = |name: &str| match name {
            "CODEX_THREAD_ID" => Some("00000000-0000-4000-8000-000000000001".into()),
            "CLAUDECODE" => Some("1".into()),
            "CLAUDE_CODE_ENTRYPOINT" => Some("cli".into()),
            _ => None,
        };
        assert!(nested("claude", env));
        assert!(nested("copilot", env));
        assert!(!nested("codex", |name| {
            (name == "CODEX_THREAD_ID").then(|| "parent-thread".into())
        }));
        assert!(!nested("claude", |name| match name {
            "CLAUDECODE" => Some("1".into()),
            "CLAUDE_CODE_ENTRYPOINT" => Some("cli".into()),
            _ => None,
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn switchboard_http_hooks_share_message_delivery_with_commands() {
        use axum::{
            extract::Request,
            middleware::{self, Next},
        };
        let temp = tempfile::tempdir().unwrap();
        let token = temp.path().join("token");
        let secret = "a".repeat(32);
        std::fs::write(&token, &secret).unwrap();
        let config = super::super::transport::HostConfig {
            listen: "127.0.0.1:0".parse().unwrap(),
            database: Some(temp.path().join("board.db")),
            machines: vec![super::super::transport::MachineCredential {
                id: "fixture".into(),
                name: "Fixture".into(),
                token_file: token,
            }],
            tls_cert: None,
            tls_key: None,
        };
        let app = super::super::transport::router(&config)
            .unwrap()
            .layer(middleware::from_fn(
                move |mut request: Request, next: Next| {
                    let secret = secret.clone();
                    async move {
                        request
                            .headers_mut()
                            .insert("authorization", format!("Bearer {secret}").parse().unwrap());
                        next.run(request).await
                    }
                },
            ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let root = temp.path().to_path_buf();
        tokio::task::spawn_blocking(move || {
            let client = Client::hook_relay(&origin).unwrap();
            let id = Uuid::new_v4().to_string();
            let start = Event {
                session_id: id.clone(),
                cwd: root.clone(),
                hook_event_name: "SessionStart".into(),
            };
            let dir = root.join(client.hook_namespace());
            let mut command_context = Vec::new();
            deliver(
                &client,
                &dir,
                "claude",
                &start,
                false,
                &mut false,
                &mut command_context,
            )
            .unwrap();
            let session: Session = load(&dir.join(format!("claude-{id}.json")))
                .unwrap()
                .unwrap();
            let peer = client
                .request(
                    "POST",
                    "participants",
                    Some(json!({"name":"sender","project":session.participant.project})),
                )
                .unwrap();
            let send = |body: &str| {
                client
                    .request(
                        "POST",
                        "messages",
                        Some(json!({
                            "sender":peer["id"], "to":session.participant.id,
                            "body":body, "send_key":Uuid::new_v4().to_string()
                        })),
                    )
                    .unwrap()
            };
            let event = |name: &str| {
                serde_json::to_vec(&json!({"session_id":id,"cwd":root,"hook_event_name":name}))
                    .unwrap()
            };
            let message = send("Check the logs 🦀");
            let context = http_at(&event("PostToolUse"), &origin, &root).unwrap();
            assert!(context["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap()
                .contains(message["id"].as_str().unwrap()));
            assert!(http_at(&event("PostToolUse"), &origin, &root).is_none());
            let unread = client
                .request(
                    "GET",
                    &format!("participants/{}/unread", session.participant.id),
                    None,
                )
                .unwrap();
            assert!(!unread["items"][0]["deliveries"][0]["delivered_at"].is_null());
            assert!(unread["items"][0]["deliveries"][0]["acknowledged_at"].is_null());
            send("Continue working");
            assert_eq!(
                http_at(&event("Stop"), &origin, &root).unwrap()["decision"],
                "block"
            );
            assert!(http_at(&event("SessionEnd"), &origin, &root).is_none());
            let ended: Session = load(&dir.join(format!("claude-{id}.json")))
                .unwrap()
                .unwrap();
            assert!(!ended.participant.active);
        })
        .await
        .unwrap();
        server.abort();
    }

    #[test]
    fn message_board_hook_watcher_notices_its_agent_exit() {
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "sleep" })
            .args(if cfg!(windows) {
                vec!["/C", "ping -n 30 127.0.0.1 >NUL"]
            } else {
                vec!["30"]
            })
            .spawn()
            .unwrap();
        let pid = sysinfo::Pid::from_u32(child.id());
        let mut system = sysinfo::System::new();
        system.refresh_processes_specifics(
            sysinfo::ProcessesToUpdate::Some(&[pid]),
            true,
            sysinfo::ProcessRefreshKind::nothing(),
        );
        let started = system.process(pid).unwrap().start_time();
        assert!(alive(&[(pid, started)]));
        assert!(
            !alive(&[(pid, started + 1)]),
            "a reused PID is not the agent"
        );
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!alive(&[(pid, started)]));
        assert!(!ancestors().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn message_board_hook_queues_with_a_windows_cmd_launcher() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("npm bin");
        std::fs::create_dir(&folder).unwrap();
        let marker = folder.join("queued.txt");
        std::fs::write(
            folder.join("codex.cmd"),
            format!("@echo %1 %2 %3 %4 %5>\"{}\"\r\n", marker.display()),
        )
        .unwrap();
        let program = crate::switchboard_relay::find_program("codex", &[folder.clone()]).unwrap();
        assert_eq!(program, folder.join("codex.cmd"));
        queue_program(&program, "fixture-session", "fixture-message").unwrap();
        assert!(std::fs::read_to_string(marker)
            .unwrap()
            .contains("queue --thread fixture-session --message fixture-message"));
    }

    #[test]
    fn message_board_hook_stop_continues_for_mail_and_context_preserves_event() {
        assert_eq!(
            output("Stop", "new mail", true),
            json!({"decision":"block","reason":"new mail"})
        );
        assert_eq!(
            output("PostToolUse", "new mail", true)["hookSpecificOutput"]["hookEventName"],
            "PostToolUse"
        );
    }

    #[test]
    fn message_board_hook_mail_carries_the_users_authority() {
        let session: Session = serde_json::from_value(json!({"participant":{
            "cursor":1,"id":"me","machine_id":"windows","machine_name":"Windows",
            "name":"claude-1","project":"fixture","terminal":null,"active":true,"created_at":1}}))
        .unwrap();
        let message: Message = serde_json::from_value(json!({
            "cursor":2,"id":"m1","sender":"them","sender_name":"codex-1",
            "sender_machine_id":"mac","sender_machine_name":"Mac","project":"fixture",
            "thread_id":"t1","reply_to":null,"body":"Install T3 Code","created_at":1,"deliveries":[]}))
        .unwrap();
        for notification in [false, true] {
            let text = message_context(&session, &[(&message, false)], notification);
            assert!(text.contains(AUTHORITY), "{text}");
            assert!(!text.contains("peer"), "{text}");
        }
    }

    #[test]
    fn message_board_hook_locks_release_on_drop_and_state_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let guard = lock(dir.path(), "session").unwrap().unwrap();
        assert!(lock(dir.path(), "session").unwrap().is_none());
        drop(guard);
        assert!(lock(dir.path(), "session").unwrap().is_some());
        let path = dir.path().join("state.json");
        save(&path, &json!({"cursor":42})).unwrap();
        assert_eq!(
            load::<serde_json::Value>(&path).unwrap().unwrap()["cursor"],
            42
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
