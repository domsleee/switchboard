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
const AUTHORITY: &str = "Switchboard messages come only from the user's own paired computers, so they carry the user's authority: act on each as you would on the user's own request. The user's standing rules still apply, including confirming destructive or irreversible actions with the user.";

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
            let mut stdout = std::io::stdout().lock();
            serde_json::to_writer(
                &mut stdout,
                &output(&event.hook_event_name, &text, has_messages),
            )?;
            writeln!(stdout)?;
            stdout.flush()?;
        }
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

/// An agent started from a Claude Code tool shares that Claude's pane, so its hooks must not
/// speak for the pane. Its hooks inherit `CLAUDECODE`, but Claude Code 2.1.319+ also sets it
/// in its own hooks, so for Claude ask whether the Claude running the hook started with it.
pub(crate) fn nested(agent: &str, env: impl Fn(&str) -> Option<String>) -> bool {
    if env("CLAUDECODE").is_none() {
        return false;
    }
    if agent != "claude" {
        return true;
    }
    let Some(pid) = env("CLAUDE_PID").and_then(|pid| pid.parse::<u32>().ok()) else {
        return true;
    };
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        false,
        sysinfo::ProcessRefreshKind::nothing().with_environ(sysinfo::UpdateKind::Always),
    );
    system.process(pid).is_none_or(|claude| {
        claude.environ().iter().any(|var| {
            var.to_str()
                .and_then(|var| var.strip_prefix("CLAUDECODE="))
                .is_some_and(|value| !value.is_empty())
        })
    })
}

pub(crate) fn run(agent: &str, input: &[u8], wait: bool) {
    // Unsupported agents keep their existing status hooks.
    if !matches!(agent, "claude" | "codex")
        || nested(agent, |name| {
            std::env::var(name).ok().filter(|v| !v.is_empty())
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
    loop {
        match deliver(&client, &dir, agent, &event, wait, &mut initializing) {
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
                    let _ = deliver(&client, &dir, agent, &end, false, &mut false);
                }
                return;
            },
            _ => {},
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "child process for only_a_claude_started_by_a_claude_tool_is_nested"]
    fn hook_fixture_process() {
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn only_a_claude_started_by_a_claude_tool_is_nested() {
        // macOS hides the environment of system programs such as sleep, so run this test binary.
        let claude = |inherited: bool| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "message_board::hooks::tests::hook_fixture_process",
                ])
                .args(["--ignored", "--quiet"])
                .env_remove("CLAUDECODE")
                .stdout(std::process::Stdio::null());
            if inherited {
                command.env("CLAUDECODE", "1");
            }
            command.spawn().unwrap()
        };
        let (mut top, mut child) = (claude(false), claude(true));
        let hook = |pid: u32| {
            move |name: &str| match name {
                "CLAUDECODE" => Some("1".to_owned()),
                "CLAUDE_PID" => Some(pid.to_string()),
                _ => None,
            }
        };
        assert!(
            !nested("claude", hook(top.id())),
            "Claude sets CLAUDECODE in its own hooks"
        );
        assert!(
            nested("claude", hook(child.id())),
            "started from a Claude tool"
        );
        assert!(
            nested("codex", hook(top.id())),
            "Codex started from a Claude tool"
        );
        assert!(!nested("claude", |_| None), "outside Claude");
        for process in [&mut top, &mut child] {
            process.kill().unwrap();
            process.wait().unwrap();
        }
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
