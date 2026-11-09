//! Create tabs without attaching a browser viewer or changing terminal geometry.
use super::{
    authentication::IsReadOnly,
    types::AppState,
    websocket_handlers::{project_cwd, prompt_agent, prompt_command, tab_command, Agent},
};
use crate::os_input_output::ClientOsApi;
use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{ffi::OsString, path::PathBuf, process::Stdio, time::Duration};
use zellij_utils::{
    cli::CliAction,
    consts::session_layout_cache_file_name,
    data::{PaneId, WebSharing},
    input::actions::Action,
    ipc::{ClientToServerMsg, ExitReason, IpcReceiveError, ServerToClientMsg},
};

type Error = (StatusCode, &'static str);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    session: String,
    project: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    elevated: bool,
    /// Opened by an agent for its own checks: named System, so no computer alerts for it.
    #[serde(default)]
    system: bool,
}

fn valid(target: &Target) -> bool {
    !target.session.trim().is_empty()
        && target.session.len() <= 200
        && !matches!(target.session.as_str(), "." | "..")
        && !target
            .session
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        && target.project.len() <= 4096
        && !target.project.contains('\0')
        && match target.prompt {
            Some(_) => prompt_agent(&target.command).is_some(),
            None => !target.command.trim().is_empty(),
        }
        && target
            .prompt
            .as_ref()
            .is_none_or(|text| text.len() <= 16000 && !text.contains('\0'))
        && target.images.len() <= 8
        && target.images.iter().all(|path| {
            !path.is_empty() && path.len() <= 4096 && !path.chars().any(char::is_control)
        })
        && target.command.len() <= 16000
        && !target.command.contains('\0')
}

async fn cli(state: &AppState, args: Vec<OsString>) -> Result<String, Error> {
    let binary = crate::switchboard_relay::own_executable().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Terminal executable unavailable",
        )
    })?;
    let background = args.iter().any(|arg| arg == "--create-background");
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("--config")
        .arg(&state.config_file_path)
        .args(args)
        .env_remove("ZELLIJ")
        .env_remove("ZELLIJ_SESSION_NAME")
        .env_remove("ZELLIJ_PANE_ID")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if background {
        // The engine's first shell starts here; the service's own folder means nothing to a user.
        if let Some(home) = std::env::home_dir() {
            command.current_dir(home);
        }
        // The background engine can inherit these handles on Windows. Waiting
        // for EOF would keep the creation request open for the session's life.
        command.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    // Command::output replaces configured stdout/stderr with pipes. Spawn
    // explicitly so background startup keeps its null handles.
    let child = command
        .spawn()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?;
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                if background {
                    "Session startup timed out; check the tab list before retrying"
                } else {
                    "Tab creation timed out; check the tab list before retrying"
                },
            )
        })?
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?;
    if !output.status.success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Terminal command failed; check the tab list before retrying",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

const FAILED: Error = (
    StatusCode::BAD_GATEWAY,
    "Terminal command failed; check the tab list before retrying",
);

/// Sends one action over the session's socket and returns the lines it
/// prints, as `zellij -s <session> action ...` would. Starting that CLI loads
/// the configuration and probes every session first, about 250 ms per call on
/// Windows; this process already speaks the same IPC protocol.
fn session_action(session: &str, action: Action) -> Result<String, Error> {
    let os_input = crate::os_input_output::get_cli_client_os_input()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?;
    let socket = zellij_utils::consts::ZELLIJ_SOCK_DIR.join(session);
    // One attempt: a missing session fails now rather than at the timeout.
    os_input
        .try_connect_to_server(&socket)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?;
    os_input.send_to_server(ClientToServerMsg::Action {
        action,
        terminal_id: None,
        client_id: None,
        is_cli_client: true,
    });
    if os_input.send_failure().is_some() {
        return Err(FAILED);
    }
    // The engine unblocks a client after each action, following its output.
    let mut output = String::new();
    let result = loop {
        match os_input.try_recv_from_server() {
            Ok((ServerToClientMsg::UnblockInputThread, _)) => break Ok(output),
            Ok((ServerToClientMsg::Log { lines }, _)) => lines
                .iter()
                .for_each(|line| output.push_str(&format!("{line}\n"))),
            Ok((ServerToClientMsg::LogError { .. }, _))
            | Ok((
                ServerToClientMsg::Exit {
                    exit_reason: ExitReason::Error(_),
                },
                _,
            ))
            | Err(IpcReceiveError::Disconnected) => break Err(FAILED),
            Ok((
                ServerToClientMsg::Exit {
                    exit_reason: ExitReason::CustomExitStatus(status),
                },
                _,
            )) => break if status == 0 { Ok(output) } else { Err(FAILED) },
            Ok((ServerToClientMsg::Exit { .. }, _)) => break Ok(output),
            _ => {},
        }
    };
    os_input.send_to_server(ClientToServerMsg::ClientExited);
    result
}

async fn action(session: &str, action: Action) -> Result<String, Error> {
    let session = session.to_owned();
    let task = tokio::task::spawn_blocking(move || session_action(&session, action));
    tokio::time::timeout(Duration::from_secs(15), task)
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "Tab creation timed out; check the tab list before retrying",
            )
        })?
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?
}

/// The action `zellij action new-tab --no-focus --cwd <cwd> [--name <name>] -- <command>` sends.
fn new_tab_action(cwd: PathBuf, name: Option<String>, command: Vec<String>) -> Option<Action> {
    let current_dir = cwd.clone();
    Action::actions_from_cli(
        CliAction::NewTab {
            name,
            layout: None,
            layout_string: None,
            layout_dir: None,
            cwd: Some(cwd),
            initial_command: command,
            initial_plugin: None,
            close_on_exit: false,
            start_suspended: false,
            block_until_exit: false,
            block_until_exit_success: false,
            block_until_exit_failure: false,
            no_focus: true,
        },
        Box::new(move || current_dir.clone()),
        None,
    )
    .ok()?
    .pop()
}

async fn panes(session: &str) -> Result<Vec<Value>, Error> {
    let catalog = action(
        session,
        Action::ListPanes {
            show_tab: false,
            show_command: false,
            show_state: false,
            show_geometry: false,
            show_all: true,
            output_json: true,
        },
    )
    .await?;
    // A simultaneous close can unblock a successful CLI before it prints.
    if catalog.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&catalog).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Cannot identify the created terminal; check the tab list",
        )
    })
}

pub(super) async fn create(
    State(state): State<AppState>,
    Extension(IsReadOnly(read_only)): Extension<IsReadOnly>,
    Json(target): Json<Target>,
) -> Result<Json<Value>, Error> {
    if read_only {
        return Err((StatusCode::FORBIDDEN, "Writable access is required"));
    }
    if !valid(&target) {
        return Err((StatusCode::BAD_REQUEST, "Invalid tab request"));
    }
    let sessions = state.session_manager.list_sessions();
    let shared = |name: &str, allowed: bool| {
        allowed
            || state
                .sharing_recovery
                .as_ref()
                .is_some_and(|r| r.catalog_allowed(name, false))
    };
    // A session started for this request opens a default shell tab nobody asked for.
    let mut default_tab = None;
    if let Some(session) = sessions.iter().find(|s| s.name == target.session) {
        if !shared(&session.name, session.web_clients_allowed) {
            return Err((StatusCode::FORBIDDEN, "Session is not shared"));
        }
    } else {
        // A computer's first shared session starts here; once it has one, tabs go there.
        if sessions
            .iter()
            .any(|s| shared(&s.name, s.web_clients_allowed))
        {
            return Err((StatusCode::NOT_FOUND, "Session is unavailable"));
        }
        if state.config.lock().unwrap().options.web_sharing == Some(WebSharing::Disabled) {
            return Err((StatusCode::FORBIDDEN, "Web sharing is disabled"));
        }
        // A saved layout makes this a restore: those tabs are the user's.
        let restoring = session_layout_cache_file_name(&target.session).is_file();
        cli(
            &state,
            vec![
                "attach".into(),
                "--create-background".into(),
                target.session.clone().into(),
                "options".into(),
                "--web-sharing".into(),
                "on".into(),
            ],
        )
        .await?;
        // Background creation returns before the engine accepts actions.
        // Wait on a read before issuing the one mutating new-tab request.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(started) = panes(&target.session)
                .await
                .ok()
                .filter(|panes| !panes.is_empty())
            {
                default_tab = (!restoring).then(|| only_terminal_tab(&started)).flatten();
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err((
                    StatusCode::GATEWAY_TIMEOUT,
                    "Session is still starting; check the tab list before retrying",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    let name = tab_name(&target);
    let shell = state.config.lock().unwrap().options.default_shell.clone();
    let cwd = project_cwd(
        std::env::home_dir().ok_or((StatusCode::BAD_GATEWAY, "Home directory unavailable"))?,
        &target.project,
    );
    let agent = prompt_agent(&target.command).unwrap_or(Agent::Alias("csol"));
    let typed = target
        .prompt
        .as_deref()
        .filter(|text| !agent.is_claude() && target.images.is_empty() && is_agent_command(text))
        .map(|text| text.trim().to_owned());
    let command = target
        .prompt
        .as_ref()
        .map(|text| {
            let text = if typed.is_some() { "" } else { text };
            prompt_command(shell.clone(), &agent, text, &target.images)
        })
        .unwrap_or(target.command);
    let run = tab_command(shell, command, Some(cwd.clone()), target.elevated);
    let command = std::iter::once(run.command.to_string_lossy().into_owned())
        .chain(run.args)
        .collect();
    let new_tab = new_tab_action(cwd, name, command)
        .ok_or((StatusCode::BAD_REQUEST, "Invalid tab request"))?;
    // `new-tab` prints a stable tab ID, then the terminal it started the command in.
    let reply = action(&target.session, new_tab).await?;
    let (tab_id, pane_id) = created_ids(&reply).ok_or((
        StatusCode::BAD_GATEWAY,
        "Tab created but its identity was not returned; check the tab list",
    ))?;
    if let Some(id) = default_tab.filter(|id| *id != tab_id) {
        let close = Action::CloseTabById { id: id.into() };
        if action(&target.session, close).await.is_err() {
            log::warn!(
                "Could not close the default tab of new session {}",
                target.session
            );
        }
    }
    if let Some(pane_id) = pane_id {
        return Ok(created(&target.session, pane_id, tab_id, typed));
    }
    // Without the terminal, resolve it from the tab's catalog. Listing costs a
    // command and folder lookup for every terminal in the session.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let panes = panes(&target.session).await?;
        if let Some(pane_id) = created_pane(&panes, tab_id) {
            return Ok(created(&target.session, pane_id, tab_id, typed));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err((
                StatusCode::BAD_GATEWAY,
                "The created terminal is not ready; check the tab list before retrying",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn created(session: &str, pane_id: u32, tab_id: u32, command: Option<String>) -> Json<Value> {
    if let Some(command) = command {
        tokio::spawn(type_when_ready(session.to_owned(), pane_id, command));
    }
    Json(json!({"pane_id":pane_id,"tab_id":tab_id}))
}

/// One line that starts with a command name, as Conversation recognizes one.
/// A path such as `/etc/hosts is broken` is still a message.
fn is_agent_command(text: &str) -> bool {
    let text = text.trim();
    let Some(rest) = text.strip_prefix('/') else {
        return false;
    };
    let name = rest.split([' ', '\t']).next().unwrap_or_default();
    !text.contains('\n')
        && name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// Codex sends a prompt given on its command line to the model, even a slash
/// command, and refuses commands while its MCP servers start. So type it instead.
fn codex_takes_commands(screen: &str) -> bool {
    !screen.contains("Starting MCP servers")
        && ["Ask Codex to do anything", "Ask a follow-up question"]
            .iter()
            .any(|placeholder| screen.contains(placeholder))
}

async fn type_when_ready(session: String, pane_id: u32, command: String) {
    let pane_id = PaneId::Terminal(pane_id);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let screen = action(
            &session,
            Action::DumpScreen {
                file_path: None,
                include_scrollback: false,
                pane_id: Some(pane_id),
                ansi: false,
            },
        )
        .await;
        if !screen.is_ok_and(|screen| codex_takes_commands(&screen)) {
            continue;
        }
        let chars = Action::WriteCharsToPaneId {
            chars: command,
            pane_id,
        };
        if action(&session, chars).await.is_ok() {
            // Codex reads an Enter that follows typed text at once as a pasted newline.
            tokio::time::sleep(Duration::from_millis(300)).await;
            let enter = Action::WriteToPaneId {
                bytes: vec![13],
                pane_id,
            };
            if action(&session, enter).await.is_ok() {
                return;
            }
        }
        break;
    }
    log::warn!("Could not type a New tab command into Codex in session {session}");
}

/// Sidebars mark tabs by these names: a shield for Administrator, and System tabs
/// (agents' own checks) stay hidden and never alert.
fn tab_name(target: &Target) -> Option<String> {
    if target.elevated {
        Some("Administrator".into())
    } else {
        target.system.then(|| "System".into())
    }
}

fn created_ids(reply: &str) -> Option<(u32, Option<u32>)> {
    let mut lines = reply.lines().map(str::trim);
    let tab_id = lines.next()?.parse().ok()?;
    let pane_id = lines.find_map(|line| line.strip_prefix("terminal_")?.parse().ok());
    Some((tab_id, pane_id))
}

fn created_pane(panes: &[Value], tab_id: u32) -> Option<u32> {
    panes
        .iter()
        .filter(|pane| {
            pane["tab_id"] == tab_id && pane["is_plugin"] == false && pane["is_suppressed"] != true
        })
        .max_by_key(|pane| pane["is_focused"] == true)
        .and_then(|pane| pane["id"].as_u64()?.try_into().ok())
}

/// The tab holding the session's only terminal, as a just-started default session has.
fn only_terminal_tab(panes: &[Value]) -> Option<u32> {
    let mut terminals = panes.iter().filter(|pane| pane["is_plugin"] == false);
    let tab = terminals.next()?["tab_id"].as_u64()?.try_into().ok()?;
    terminals.next().is_none().then_some(tab)
}

#[cfg(test)]
mod tests {

    #[test]
    fn switchboard_new_tab_recognizes_commands_but_not_paths_or_messages() {
        for command in ["/status", "/review focus on auth", " /prompts:deploy-now "] {
            assert!(super::is_agent_command(command), "{command}");
        }
        for message in [
            "/etc/hosts is broken",
            "/status\nthen continue",
            "/ status",
            "/1password login",
            "please run /status",
        ] {
            assert!(!super::is_agent_command(message), "{message}");
        }
    }

    #[test]
    fn switchboard_new_tab_waits_for_codex_to_finish_starting() {
        let starting = "› /status\nStarting MCP servers (3/4): blender (1s • esc to interrupt)\n› Ask Codex to do anything\n";
        assert!(!super::codex_takes_commands(starting));
        assert!(!super::codex_takes_commands("Quick safety check\n"));
        assert!(super::codex_takes_commands("  /status - show current session configuration\n› Ask Codex to do anything\n  GPT-6-Sol high\n"));
    }

    use super::*;
    use zellij_utils::{data::CommandOrPlugin, input::command::RunCommandAction};
    #[test]
    fn switchboard_tab_creation_finds_only_a_lone_default_tab() {
        let plugin = json!({"tab_id":0,"is_plugin":true});
        let shell = json!({"tab_id":0,"is_plugin":false});
        assert_eq!(only_terminal_tab(&[plugin.clone(), shell.clone()]), Some(0));
        assert_eq!(only_terminal_tab(&[plugin]), None);
        let restored = json!({"tab_id":1,"is_plugin":false});
        assert_eq!(only_terminal_tab(&[shell, restored]), None);
    }

    #[test]
    fn switchboard_tab_creation_reads_the_started_terminal_from_the_reply() {
        assert_eq!(created_ids("8\nterminal_17\n"), Some((8, Some(17))));
        assert_eq!(created_ids("8\n"), Some((8, None)));
        assert_eq!(created_ids("8\nplugin_3\n"), Some((8, None)));
        assert_eq!(created_ids(""), None);
        assert_eq!(created_ids("terminal_17\n"), None);
    }
    #[test]
    fn switchboard_tab_creation_sends_the_cli_new_tab_action() {
        let cwd = std::env::temp_dir().join("project");
        let action = new_tab_action(
            cwd.clone(),
            Some("Administrator".into()),
            vec![
                "nu".into(),
                "--interactive".into(),
                "--execute".into(),
                "csol".into(),
            ],
        );
        let Some(Action::NewTab {
            tiled_layout: None,
            tab_name,
            should_change_focus_to_new_tab: false,
            cwd: tab_cwd,
            initial_panes: Some(panes),
            first_pane_unblock_condition: None,
            ..
        }) = action
        else {
            panic!("expected an unfocused new tab, got {action:?}");
        };
        assert_eq!(tab_name.as_deref(), Some("Administrator"));
        assert_eq!(tab_cwd.as_ref(), Some(&cwd));
        assert_eq!(
            panes,
            vec![CommandOrPlugin::Command(RunCommandAction {
                command: "nu".into(),
                args: vec!["--interactive".into(), "--execute".into(), "csol".into()],
                cwd: Some(cwd),
                hold_on_close: true,
                ..Default::default()
            })]
        );
    }
    #[test]
    fn switchboard_tab_creation_resolves_the_terminal_from_the_returned_tab_id() {
        let panes = vec![
            json!({"id":8,"tab_id":3,"is_plugin":false}),
            json!({"id":2,"tab_id":8,"is_plugin":true,"is_focused":true}),
            json!({"id":15,"tab_id":8,"is_plugin":false,"is_suppressed":true}),
            json!({"id":16,"tab_id":8,"is_plugin":false}),
            json!({"id":17,"tab_id":8,"is_plugin":false,"is_focused":true}),
        ];
        assert_eq!(created_pane(&panes, 8), Some(17));
        assert_eq!(created_pane(&panes, 3), Some(8));
        assert_eq!(created_pane(&panes, 17), None);
    }
    #[test]
    fn switchboard_tab_creation_rejects_invalid_targets() {
        let mut target = Target {
            session: "main".into(),
            project: "switchboard".into(),
            command: "c".into(),
            prompt: None,
            images: vec![],
            elevated: false,
            system: false,
        };
        assert!(valid(&target));
        assert_eq!(tab_name(&target), None);
        target.system = true;
        assert_eq!(tab_name(&target).as_deref(), Some("System"));
        target.elevated = true;
        assert_eq!(tab_name(&target).as_deref(), Some("Administrator"));
        target.elevated = false;
        target.system = false;
        for name in ["", "..", "../main", "a\\b", "main\n"] {
            target.session = name.into();
            assert!(!valid(&target));
        }
        target.session = "main".into();
        target.command = "\0".into();
        assert!(!valid(&target));
        target.command = "c".into();
        target.project = "".into();
        assert!(valid(&target));
        target.project = "  \t ".into();
        assert!(valid(&target));
        target.project = "\0".into();
        assert!(!valid(&target));
        target.project = "switchboard".into();
        target.prompt = Some("go".into());
        for agent in ["", "c", "castra", "csol"] {
            target.command = agent.into();
            assert!(valid(&target), "{agent}");
        }
        target.command = "bash".into();
        assert!(!valid(&target));
    }
}
