//! Restart only a recorded idle agent, in its existing tab. No shell command injection.
use super::*;
use serde::Serialize;
use std::path::PathBuf;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use zellij_utils::agent_resumption::{interactive_invocation, resume_command, AgentKind};

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub(super) struct Identity {
    agent: AgentKind,
    session_id: String,
    cwd: PathBuf,
    pid: u32,
    started: u64,
    command: Vec<String>,
    executable: PathBuf,
}

fn processes() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_exe(UpdateKind::Always)
            .with_cmd(UpdateKind::Always)
            .with_environ(UpdateKind::Always),
    );
    system
}
fn command(p: &sysinfo::Process) -> Vec<String> {
    p.cmd()
        .iter()
        .map(|s| s.to_string_lossy().into_owned())
        .collect()
}
fn owns(p: &sysinfo::Process, session: &str, pane: u64) -> bool {
    let session = format!("ZELLIJ_SESSION_NAME={session}");
    let pane = format!("ZELLIJ_PANE_ID={pane}");
    p.environ().iter().any(|v| v == session.as_str())
        && p.environ().iter().any(|v| v == pane.as_str())
}

/// Record the reporting agent's process independently of whether its launch
/// flags allow a safe restart. Ambiguous processes are not bound.
pub(super) fn capture(agent: &str, event: &Value, session: &str, pane: u64) -> Option<Identity> {
    let agent = match agent {
        "codex" => AgentKind::Codex,
        "claude" => AgentKind::Claude,
        "copilot" => AgentKind::Copilot,
        _ => return None,
    };
    let id = event["session_id"].as_str()?;
    uuid::Uuid::parse_str(id).ok()?;
    let cwd = PathBuf::from(event["cwd"].as_str()?);
    if !cwd.is_absolute() {
        return None;
    }
    let system = processes();
    let mut candidates = system.processes().iter().filter_map(|(pid, p)| {
        let command = command(p);
        if !owns(p, session, pane) || !interactive_invocation(&command, agent) {
            return None;
        }
        Some(Identity {
            agent,
            session_id: id.into(),
            cwd: cwd.clone(),
            pid: pid.as_u32(),
            started: p.start_time(),
            command,
            executable: p.exe()?.to_path_buf(),
        })
    });
    let identity = candidates.next()?;
    if candidates.next().is_some() {
        return None;
    }
    Some(identity)
}
impl Identity {
    pub(super) fn resumable(&self) -> bool {
        self.agent != AgentKind::Copilot
            && resume_command(
                &self.command,
                self.agent,
                &self.session_id,
                self.cwd.clone(),
            )
            .is_ok()
    }

    fn live(&self, session: &str, pane: u32) -> bool {
        processes()
            .process(Pid::from_u32(self.pid))
            .is_some_and(|p| {
                p.start_time() == self.started
                    && p.exe() == Some(self.executable.as_path())
                    && command(p) == self.command
                    && owns(p, session, pane.into())
            })
    }
    fn stopped(&self) -> bool {
        processes()
            .process(Pid::from_u32(self.pid))
            .is_none_or(|p| p.start_time() != self.started)
    }
}

/// One process-table enumeration for the whole attention snapshot. The caller
/// runs this on the blocking pool without holding the attention mutex.
pub(super) fn running(identities: &[Identity]) -> Vec<bool> {
    let mut system = System::new();
    let pids: Vec<_> = identities.iter().map(|i| Pid::from_u32(i.pid)).collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    identities
        .iter()
        .map(|identity| {
            system
                .process(Pid::from_u32(identity.pid))
                .is_some_and(|p| {
                    p.start_time() == identity.started
                        && p.exe() == Some(identity.executable.as_path())
                })
        })
        .collect()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    session: String,
    pane_id: u32,
    tab_id: u32,
    chat_id: String,
    #[serde(default)]
    confirm_interrupt: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    handover: Option<Handover>,
}

/// A shortcut (`c`, `csol`, `castra`) or `claude:<model>` / `codex:<model>`, as New tab sends.
#[derive(Clone, Deserialize, Serialize)]
#[serde(try_from = "String", into = "String")]
struct HandoverModel(String);
impl TryFrom<String> for HandoverModel {
    type Error = &'static str;
    fn try_from(model: String) -> Result<Self, Self::Error> {
        if model.trim().is_empty() || !crate::web_client::known_agent(&model) {
            return Err("unknown handover model");
        }
        Ok(Self(model))
    }
}
impl From<HandoverModel> for String {
    fn from(model: HandoverModel) -> Self {
        model.0
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Handover {
    model: HandoverModel,
    prompt: String,
    source_messages: usize,
}
impl Target {
    fn valid_handover(&self) -> Result<(), Error> {
        if self.handover.as_ref().is_some_and(|handover| {
            handover.prompt.trim().is_empty()
                || handover.prompt.len() > conversation::REPLY_LIMIT
                || handover.source_messages > 10_000_000
                || handover
                    .prompt
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
        }) {
            return Err((StatusCode::BAD_REQUEST, "Invalid context handover prompt"));
        }
        Ok(())
    }
}

fn refused(message: &'static str) -> Error {
    (StatusCode::CONFLICT, message)
}

pub(super) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<Target>,
) -> Result<Response, Error> {
    control::validate_session(&target.session)?;
    target.valid_handover()?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = tokio::time::timeout(
            Duration::from_secs(90),
            host.request(
                Method::POST,
                "/switchboard/restart-agent",
                serde_json::to_vec(&target).unwrap().into(),
                "application/json",
            ),
        )
        .await
        .map_err(|_| refused("No restart confirmation. Check the terminal before trying again"))?
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot reach the other computer"))?;
        return Ok((response.status, response.body).into_response());
    }
    local(&host, &state.poll, target)
        .await
        .map(IntoResponse::into_response)
}

pub(super) async fn local(
    host: &Host,
    poll: &Arc<Mutex<attention::PollState>>,
    target: Target,
) -> Result<Json<Value>, Error> {
    target.valid_handover()?;
    // Serialize explicit requests. A duplicate then sees the replaced pane missing.
    static RESTARTING: Mutex<()> = Mutex::const_new(());
    let _guard = RESTARTING
        .try_lock()
        .map_err(|_| refused("An agent restart is already running"))?;
    control::validate_session(&target.session)?;
    if !control::sessions(host)
        .await
        .map_err(|_| refused("Cannot check shared sessions"))?
        .contains(&target.session)
    {
        return Err(refused("Session is not shared"));
    }
    let (identity, hook_working) = poll
        .lock()
        .await
        .restart_identity(&target.session, target.pane_id, &target.chat_id)
        .ok_or_else(|| refused("The agent must report its conversation before restarting"))?;
    let panes = control::list_panes(host, &target.session, true, Duration::from_secs(20))
        .await
        .map_err(|_| refused("Cannot read terminal panes"))?;
    let pane = panes
        .iter()
        .find(|p| {
            p["id"] == target.pane_id && p["is_plugin"] == false && p["tab_id"] == target.tab_id
        })
        .ok_or_else(|| refused("The selected pane or tab has changed"))?;
    let id = target.pane_id.to_string();
    let screen = control::run_local(
        host,
        &target.session,
        &["dump-screen", "-p", &id],
        Duration::from_secs(20),
    )
    .await
    .map_err(|_| refused("Cannot check the agent's prompt"))?;
    let working = hook_working || attention::classify(pane, &screen)["state"] == "working";
    if working && target.handover.is_some() {
        return Err(refused(
            "Finish or stop the current turn before switching models",
        ));
    }
    if working && !target.confirm_interrupt {
        return Err(refused(
            "Confirm that the current turn should be interrupted",
        ));
    }
    if !working && crate::switchboard_absorb::prompt_empty(identity.agent, &screen).is_err() {
        return Err(refused("Clear any unsent prompt before restarting"));
    }
    if let Some(handover) = &target.handover {
        if chats::context_count(&target.chat_id).await? != handover.source_messages {
            return Err(refused(
                "The conversation changed. Reload context before switching models",
            ));
        }
    }
    let run = resume_command(
        &identity.command,
        identity.agent,
        &identity.session_id,
        identity.cwd.clone(),
    )
    .map_err(|_| refused("This agent launch cannot be resumed safely"))?;
    let (executable, launch_args) = if let Some(handover) = &target.handover {
        let run = crate::web_client::handover_command(
            &handover.model.0,
            &handover.prompt,
            identity.cwd.clone(),
        )
        .await
        .map_err(refused)?;
        (run.command, run.args)
    } else {
        (identity.executable.clone(), run.args)
    };
    if !identity.cwd.is_dir() || !identity.executable.is_file() {
        return Err(refused(
            "The agent executable or working folder is no longer available",
        ));
    }
    let probe = identity.clone();
    let session = target.session.clone();
    let pane_id = target.pane_id;
    if !tokio::task::spawn_blocking(move || probe.live(&session, pane_id))
        .await
        .unwrap_or(false)
    {
        return Err(refused("The recorded agent process has changed"));
    }
    // Recheck hooks after slow terminal/process reads. Busy or changed chats are refused.
    if poll
        .lock()
        .await
        .restart_identity(&target.session, target.pane_id, &target.chat_id)
        != Some((identity.clone(), hook_working))
    {
        return Err(refused(
            "The conversation changed while checking the restart",
        ));
    }
    if let Some(handover) = &target.handover {
        if chats::context_count(&target.chat_id).await? != handover.source_messages {
            return Err(refused(
                "The conversation changed. Reload context before switching models",
            ));
        }
    }
    // Hold the replacement until the original process has exited, so two agents never
    // write the same conversation. An error after replacement leaves a recoverable held pane.
    let marker = format!("Switchboard restart {}", uuid::Uuid::new_v4());
    let original_title = pane["title"]
        .as_str()
        .unwrap_or(identity.agent.name())
        .to_string();
    let mut args = vec![
        "new-pane".to_string(),
        "--in-place".into(),
        "--close-replaced-pane".into(),
        "--start-suspended".into(),
        "--name".into(),
        marker.clone(),
        "--pane-id".into(),
        id,
        "--cwd".into(),
        identity.cwd.to_string_lossy().into_owned(),
        "--".into(),
        executable.to_string_lossy().into_owned(),
    ];
    args.extend(launch_args);
    control::run_local(
        host,
        &target.session,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        Duration::from_secs(30),
    )
    .await
    .map_err(|_| refused("Restart was not confirmed. Check the terminal before retrying"))?;
    // Closing the replaced pane can unblock a CLI before its created-ID reply.
    // Correlate the held replacement with a private per-request title, never focus or position.
    let replacements = control::list_panes(host, &target.session, true, Duration::from_secs(20))
        .await
        .map_err(|_| refused("Cannot verify the held replacement. Check the terminal"))?;
    let matching: Vec<_> = replacements
        .iter()
        .filter(|p| p["title"] == marker && p["tab_id"] == target.tab_id && p["is_held"] == true)
        .collect();
    let new_id = match matching.as_slice() {
        [pane] => pane["id"].as_u64().and_then(|id| u32::try_from(id).ok()),
        _ => None,
    }.ok_or_else(|| refused("Replacement was not confirmed. Check the terminal; a held pane can be resumed with Enter"))?;
    for _ in 0..50 {
        let probe = identity.clone();
        if tokio::task::spawn_blocking(move || probe.stopped())
            .await
            .unwrap_or(false)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let probe = identity.clone();
    if !tokio::task::spawn_blocking(move || probe.stopped())
        .await
        .unwrap_or(false)
    {
        return Err(refused(
            "The original agent has not exited. The replacement is held; check the terminal",
        ));
    }
    let panes = control::list_panes(host, &target.session, true, Duration::from_secs(20))
        .await
        .map_err(|_| refused("Cannot verify the replacement. Check the terminal"))?;
    if !panes
        .iter()
        .any(|p| p["id"] == new_id && p["tab_id"] == target.tab_id && p["is_held"] == true)
    {
        return Err(refused(
            "Replacement is not held in the expected tab; no input was sent",
        ));
    }
    control::run_local(
        host,
        &target.session,
        &[
            "rename-pane",
            "--pane-id",
            &new_id.to_string(),
            &original_title,
        ],
        Duration::from_secs(20),
    )
    .await
    .map_err(|_| refused("The replacement is held. Check the terminal before resuming"))?;
    control::run_local(
        host,
        &target.session,
        &["write", "--pane-id", &new_id.to_string(), "13"],
        Duration::from_secs(20),
    )
    .await
    .map_err(|_| refused("The agent is held. Press Enter in the terminal to resume it"))?;
    Ok(Json(
        json!({"ok":true,"pane_id":new_id,"tab_id":target.tab_id}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_agent_process_checks_exit_executable_and_resume_safety() {
        let system = processes();
        let pid = Pid::from_u32(std::process::id());
        let process = system.process(pid).unwrap();
        let identity = Identity {
            agent: AgentKind::Claude,
            session_id: "11111111-2222-4333-8444-555555555555".into(),
            cwd: std::env::current_dir().unwrap(),
            pid: std::process::id(),
            started: process.start_time(),
            command: vec!["claude".into(), "--debug".into()],
            executable: process.exe().unwrap().into(),
        };
        assert_eq!(running(&[identity.clone()]), [true]);
        assert!(
            !identity.resumable(),
            "Liveness must not enable an unsafe restart"
        );
        let mut copilot = identity.clone();
        copilot.agent = AgentKind::Copilot;
        copilot.command = vec!["copilot".into()];
        assert!(
            !copilot.resumable(),
            "Liveness must not enable Copilot restart controls"
        );
        let mut wrong_exe = identity.clone();
        wrong_exe.executable = identity.cwd.join("different-program");
        assert_eq!(running(&[wrong_exe]), [false]);
        #[cfg(windows)]
        let mut command = {
            let mut c = std::process::Command::new("cmd.exe");
            c.args(["/d", "/q", "/c", "set /p switchboard_test_wait="]);
            c
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "read token"]);
            c
        };
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = Pid::from_u32(child.id());
        let mut processes = System::new();
        processes.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        let process = processes.process(pid).unwrap();
        let mut dead = identity;
        dead.pid = child.id();
        dead.started = process.start_time();
        dead.executable = process.exe().unwrap().into();
        assert_eq!(running(&[dead.clone()]), [true]);
        drop(child.stdin.take());
        child.wait().unwrap();
        drop(child);
        drop(processes);
        assert_eq!(running(&[dead]), [false]);
    }

    #[test]
    fn switchboard_restart_rejects_unbound_and_noninteractive_sessions() {
        for event in [
            json!({}),
            json!({"session_id":"latest","cwd":"/tmp"}),
            json!({"session_id":"11111111-2222-4333-8444-555555555555","cwd":"relative"}),
        ] {
            assert!(capture("codex", &event, "main", 1).is_none());
        }
        assert!(capture("copilot", &json!({}), "main", 1).is_none());
        let cwd = std::env::temp_dir();
        assert!(resume_command(
            &["codex".into(), "exec".into()],
            AgentKind::Codex,
            "11111111-2222-4333-8444-555555555555",
            cwd
        )
        .is_err());
    }
    #[test]
    fn switchboard_restart_target_never_accepts_commands_or_implicit_panes() {
        let valid = json!({"session":"main","pane_id":65,"tab_id":64,"chat_id":"codex-test"});
        assert!(serde_json::from_value::<Target>(valid.clone()).is_ok());
        let mut injected = valid.clone();
        injected["command"] = json!(["sh", "-c", "bad"]);
        assert!(serde_json::from_value::<Target>(injected).is_err());
        let mut missing = valid;
        missing.as_object_mut().unwrap().remove("pane_id");
        assert!(serde_json::from_value::<Target>(missing).is_err());
    }
    #[test]
    fn switchboard_handover_accepts_only_known_models_and_bounded_literal_prompts() {
        let base = json!({"session":"main","pane_id":65,"tab_id":64,"chat_id":"codex-test"});
        let restart: Target = serde_json::from_value(base.clone()).unwrap();
        assert!(
            serde_json::to_value(restart)
                .unwrap()
                .get("handover")
                .is_none(),
            "Ordinary restarts remain compatible with older peers"
        );
        for model in [
            "c",
            "csol",
            "castra",
            "claude:claude-opus-5-5",
            "codex:gpt-6-luna",
            "codex:gpt-6.1-sol#xhigh",
            "claude:claude-opus-5-5#max",
        ] {
            let mut value = base.clone();
            value["handover"] =
                json!({"model":model,"prompt":"Literal $(text)\nNext request","source_messages":2});
            assert!(serde_json::from_value::<Target>(value)
                .unwrap()
                .valid_handover()
                .is_ok());
        }
        let mut value = base;
        for model in [
            "sh -c bad",
            "",
            "codex:-c",
            "claude:$(id)",
            "claude:claude-opus-5-5#ultra",
        ] {
            value["handover"] = json!({"model":model,"prompt":"text","source_messages":2});
            assert!(
                serde_json::from_value::<Target>(value.clone()).is_err(),
                "{model}"
            );
        }
        value["handover"]["model"] = json!("c");
        for text in [
            String::new(),
            "\x1b[2J".into(),
            "x".repeat(conversation::REPLY_LIMIT + 1),
        ] {
            value["handover"]["prompt"] = json!(text);
            assert!(serde_json::from_value::<Target>(value.clone())
                .unwrap()
                .valid_handover()
                .is_err());
        }
    }
}
