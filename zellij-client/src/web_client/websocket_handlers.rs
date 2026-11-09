use crate::web_client::authentication::SessionTokenHash;
use crate::web_client::control_message::{
    TerminalMetricsPayload, WebClientToWebServerControlMessage,
    WebClientToWebServerControlMessagePayload,
};
use crate::web_client::message_handlers::{
    parse_stdin, render_to_client, send_control_messages_to_client, StdinSession,
};
use crate::web_client::server_listener::zellij_server_listener;
use crate::web_client::types::{AppState, ControlParams, TerminalParams};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path as AxumPath, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::path::PathBuf;
use std::sync::{atomic::AtomicBool, Arc};
use tokio_util::sync::CancellationToken;
use zellij_utils::{
    data::{CommandOrPlugin, PaneId},
    input::actions::Action,
    input::command::RunCommandAction,
    input::mouse::MouseEvent,
    ipc::{ClientToServerMsg, PixelDimensions},
    pane_size::{Size, SizeInPixels},
};

pub async fn ws_handler_control(
    ws: WebSocketUpgrade,
    _path: Option<AxumPath<String>>,
    Query(params): Query<ControlParams>,
    State(state): State<AppState>,
    axum::Extension(session_token_hash): axum::Extension<SessionTokenHash>,
) -> Response {
    if !state
        .connection_table
        .lock()
        .unwrap()
        .verify_client_ownership(&params.web_client_id, &session_token_hash.0)
    {
        log::error!(
            "Control WebSocket: client does not own web_client_id {}",
            params.web_client_id
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(viewer) = crate::switchboard_viewers::viewer() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    log::warn!("Legacy connection /ws/control delays automatic updates");
    ws.on_upgrade(move |socket| async move {
        let _viewer = viewer;
        handle_ws_control(socket, params, state).await
    })
}

pub async fn ws_handler_terminal(
    ws: WebSocketUpgrade,
    session_name: Option<AxumPath<String>>,
    Query(params): Query<TerminalParams>,
    State(state): State<AppState>,
    axum::Extension(session_token_hash): axum::Extension<SessionTokenHash>,
) -> Response {
    let Ok(viewer) = crate::switchboard_viewers::viewer() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    log::warn!("Legacy connection /ws/terminal delays automatic updates");
    ws.on_upgrade(move |socket| async move {
        let _viewer = viewer;
        handle_ws_terminal(socket, session_name, params, state, session_token_hash).await
    })
}

async fn handle_ws_control(socket: WebSocket, params: ControlParams, state: AppState) {
    let web_client_id = params.web_client_id;

    let (control_socket_tx, mut control_socket_rx) = socket.split();

    let (control_channel_tx, control_channel_rx) = tokio::sync::mpsc::unbounded_channel();
    send_control_messages_to_client(control_channel_rx, control_socket_tx);

    state
        .connection_table
        .lock()
        .unwrap()
        .add_client_control_tx(&web_client_id, control_channel_tx);

    let send_message_to_server = |deserialized_msg: WebClientToWebServerControlMessage| {
        let Some((client_connection, recovery_refresh)) = state
            .connection_table
            .lock()
            .unwrap()
            .client_id_to_channels
            .get(&deserialized_msg.web_client_id)
            .map(|channels| {
                (
                    channels.os_api.clone(),
                    channels.recovery_metadata_refresh.clone(),
                )
            })
        else {
            log::error!("Unknown web_client_id: {}", deserialized_msg.web_client_id);
            return;
        };
        let refresh_focus = matches!(
            deserialized_msg.payload,
            WebClientToWebServerControlMessagePayload::FocusPane { .. }
        );
        let default_shell = state.config.lock().unwrap().options.default_shell.clone();
        let Some(client_msg) =
            control_payload_to_server_msg(deserialized_msg.payload, default_shell)
        else {
            return;
        };

        let _ = client_connection.send_to_server(client_msg);
        // Legacy recovered clients receive focus state through queries. Issue the
        // next batch after the action, without waiting for background polling.
        if refresh_focus {
            if let Some(refresh) = recovery_refresh {
                refresh.request();
            }
        }
    };

    while let Some(Ok(msg)) = control_socket_rx.next().await {
        match msg {
            Message::Text(msg) => {
                let deserialized_msg: Result<WebClientToWebServerControlMessage, _> =
                    serde_json::from_str(&msg);
                match deserialized_msg {
                    Ok(deserialized_msg) => {
                        if deserialized_msg.web_client_id != web_client_id {
                            log::error!(
                                "Client attempted to use web_client_id {} that does not belong to their connection",
                                deserialized_msg.web_client_id
                            );
                            return;
                        }
                        send_message_to_server(deserialized_msg);
                    },
                    Err(e) => {
                        log::error!("Failed to deserialize client msg: {:?}", e);
                    },
                }
            },
            Message::Close(_) => {
                return;
            },
            // The relay's keepalive; axum answers pings itself.
            Message::Ping(_) | Message::Pong(_) => {},
            _ => {
                log::error!("Unsupported messagetype : {:?}", msg);
            },
        }
    }
}

async fn handle_ws_terminal(
    socket: WebSocket,
    session_name: Option<AxumPath<String>>,
    params: TerminalParams,
    state: AppState,
    session_token_hash: SessionTokenHash,
) {
    let client_size = match (params.rows, params.cols) {
        (Some(rows), Some(cols)) if rows > 0 && cols > 0 => Some(Size {
            rows: rows as usize,
            cols: cols as usize,
        })
        .filter(has_room),
        _ => None,
    };
    let client_pixel_dims = match (params.cell_width, params.cell_height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Some(SizeInPixels {
            width: width as usize,
            height: height as usize,
        }),
        _ => None,
    };
    let web_client_id = params.web_client_id;

    // Verify the session token owns this web_client_id
    if !state
        .connection_table
        .lock()
        .unwrap()
        .verify_client_ownership(&web_client_id, &session_token_hash.0)
    {
        log::error!(
            "Terminal WebSocket: client does not own web_client_id {}",
            web_client_id
        );
        return;
    }

    let Some(os_input) = state
        .connection_table
        .lock()
        .unwrap()
        .get_client_os_api(&web_client_id)
        .cloned()
    else {
        log::error!("Unknown web_client_id: {}", web_client_id);
        return;
    };

    let (client_terminal_channel_tx, mut client_terminal_channel_rx) = socket.split();
    let (stdout_channel_tx, stdout_channel_rx) = tokio::sync::mpsc::unbounded_channel();
    state
        .connection_table
        .lock()
        .unwrap()
        .add_client_terminal_tx(&web_client_id, stdout_channel_tx);

    let (attachment_complete_tx, attachment_complete_rx) = tokio::sync::oneshot::channel();

    zellij_server_listener(
        os_input.clone(),
        state.connection_table.clone(),
        session_name.map(|p| p.0),
        state.config.lock().unwrap().clone(),
        state.config_options.clone(),
        Some(state.config_file_path.clone()),
        web_client_id.clone(),
        state.session_manager.clone(),
        Some(attachment_complete_tx),
        client_size,
        client_pixel_dims,
        state.pending_welcome_sessions.clone(),
        state.sharing_recovery.clone(),
        params.hidden,
    );

    let terminal_channel_cancellation_token = CancellationToken::new();
    let should_not_reconnect = state
        .connection_table
        .lock()
        .unwrap()
        .get_should_not_reconnect_flag(&web_client_id)
        .unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    render_to_client(
        stdout_channel_rx,
        client_terminal_channel_tx,
        terminal_channel_cancellation_token.clone(),
        should_not_reconnect,
    );
    state
        .connection_table
        .lock()
        .unwrap()
        .add_client_terminal_channel_cancellation_token(
            &web_client_id,
            terminal_channel_cancellation_token,
        );

    let explicitly_disable_kitty_keyboard_protocol = state
        .config
        .lock()
        .unwrap()
        .options
        .support_kitty_keyboard_protocol
        .map(|e| !e)
        .unwrap_or(false);

    let _ = attachment_complete_rx.await;

    let mut mouse_old_event = MouseEvent::new();
    // Per-connection parser state. Hoisted so a CSI / Kitty sequence
    // split across two WebSocket frames resolves on the second frame.
    let mut stdin_session = StdinSession::new(explicitly_disable_kitty_keyboard_protocol);
    stdin_session.wheel_lines = params.wheel_lines.unwrap_or(0).min(3);
    let finalize_idle = std::time::Duration::from_millis(50);
    loop {
        // When termwiz is holding ambiguous-but-complete events from
        // the previous frame, race the next frame against an idle
        // timeout so the held events still drain if no further frame
        // arrives.
        let result = if stdin_session.pending_finalize() {
            tokio::select! {
                msg = client_terminal_channel_rx.next() => Some(msg),
                _ = tokio::time::sleep(finalize_idle) => None,
            }
        } else {
            Some(client_terminal_channel_rx.next().await)
        };
        let msg = match result {
            Some(Some(Ok(m))) => m,
            Some(_) => break,
            None => {
                // Idle timeout fired with `pending_finalize` set:
                // drain any ambiguous-but-complete events termwiz held
                // back on the previous frame.
                if let Some(client_connection) = state
                    .connection_table
                    .lock()
                    .unwrap()
                    .get_client_os_api(&web_client_id)
                    .cloned()
                {
                    stdin_session.finalize(&*client_connection, &mut mouse_old_event);
                } else {
                    // No client to send drained events to — clear the
                    // flag so we don't busy-loop the idle timer.
                    stdin_session.clear_pending_finalize();
                }
                continue;
            },
        };
        match msg {
            Message::Binary(buf) => {
                let Some(client_connection) = state
                    .connection_table
                    .lock()
                    .unwrap()
                    .get_client_os_api(&web_client_id)
                    .cloned()
                else {
                    log::error!("Unknown web_client_id: {}", web_client_id);
                    continue;
                };
                parse_stdin(
                    &buf,
                    client_connection.clone(),
                    &mut mouse_old_event,
                    &mut stdin_session,
                );
            },
            Message::Text(msg) => {
                let Some(client_connection) = state
                    .connection_table
                    .lock()
                    .unwrap()
                    .get_client_os_api(&web_client_id)
                    .cloned()
                else {
                    log::error!("Unknown web_client_id: {}", web_client_id);
                    continue;
                };
                parse_stdin(
                    msg.as_bytes(),
                    client_connection.clone(),
                    &mut mouse_old_event,
                    &mut stdin_session,
                );
            },
            Message::Close(_) => {
                break;
            },
            Message::Ping(_) | Message::Pong(_) => {},
            // TODO: support Message::Binary
            _ => {
                log::error!("Unsupported websocket msg type");
            },
        }
    }
    state
        .connection_table
        .lock()
        .unwrap()
        .remove_client(&web_client_id);
    os_input.send_to_server(ClientToServerMsg::ClientExited);
}

// An elevated tab runs the default shell through gsudo on Windows (built-in `sudo`
// needs 24H2 and inline mode turned on) and sudo elsewhere. Either prompts on that computer.
fn elevated_shell(default_shell: Option<PathBuf>) -> RunCommandAction {
    let shell = default_shell
        .or_else(|| std::env::var_os("SHELL").map(PathBuf::from))
        .or_else(|| std::env::var_os("COMSPEC").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    RunCommandAction {
        command: elevator(),
        args: vec![shell.to_string_lossy().into_owned()],
        // Keep a declined prompt or missing gsudo on screen, with Enter to retry.
        hold_on_close: true,
        // Agents in the tab still report their state through the title.
        use_terminal_title: true,
        ..Default::default()
    }
}

// Run through the configured shell so interactive aliases and functions are available.
fn tab_shell(default_shell: Option<PathBuf>) -> PathBuf {
    default_shell
        .or_else(|| std::env::var_os("SHELL").map(PathBuf::from))
        .or_else(|| std::env::var_os("COMSPEC").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

// Prompt text is data, never shell source. Quote on the destination computer,
// where the configured shell and uploaded image paths are known.
/// What New tab and handover launch: one of the owner's shell shortcuts, or
/// Claude Code or Codex with a chosen model and optional reasoning effort
/// (`claude:<model>`, `codex:<model>#<effort>`). An empty name keeps older clients on Sol.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Agent {
    Alias(&'static str),
    Claude(String, Option<String>),
    Codex(String, Option<String>),
}
/// Effort levels each agent's command line accepts. Anything else is refused, never passed on.
const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 8] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];
impl Agent {
    pub(crate) fn parse(command: &str) -> Option<Self> {
        let command = command.trim();
        match command {
            "" | "csol" => return Some(Self::Alias("csol")),
            "castra" => return Some(Self::Alias("castra")),
            "c" => return Some(Self::Alias("c")),
            _ => {},
        }
        let (provider, choice) = command.split_once(':')?;
        let (model, effort) = match choice.rsplit_once('#') {
            Some((model, effort)) => (model, Some(effort)),
            None => (choice, None),
        };
        // A model name is data, never a flag or shell source. It is quoted as well.
        let valid = model.len() <= 100
            && model.starts_with(|c: char| c.is_ascii_alphanumeric())
            && model.chars().all(|c| {
                c.is_ascii_alphanumeric()
                    || matches!(c, '.' | '-' | '_' | '[' | ']' | '/' | ':' | '@')
            });
        if !valid {
            return None;
        }
        let effort = |levels: &[&str]| match effort {
            None => Some(None),
            Some(effort) => levels.contains(&effort).then(|| Some(effort.to_owned())),
        };
        match provider {
            "claude" => Some(Self::Claude(model.into(), effort(&CLAUDE_EFFORTS)?)),
            "codex" => Some(Self::Codex(model.into(), effort(&CODEX_EFFORTS)?)),
            _ => None,
        }
    }
    pub(super) fn is_claude(&self) -> bool {
        matches!(self, Self::Alias("c") | Self::Claude(..))
    }
    /// The command the terminal shell must find to start this agent.
    pub(crate) fn program(&self) -> &str {
        match self {
            Self::Alias(alias) => alias,
            Self::Claude(..) => "claude",
            Self::Codex(..) => "codex",
        }
    }
}

pub(super) fn prompt_agent(command: &str) -> Option<Agent> {
    Agent::parse(command)
}

pub(super) fn prompt_command(
    shell: Option<PathBuf>,
    agent: &Agent,
    prompt: &str,
    images: &[String],
) -> String {
    let shell = tab_shell(shell);
    let name = shell
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let quote = |value: &str| match name.as_str() {
        "nu" => {
            let mut hashes = "#".to_owned();
            while value.contains(&format!("'{hashes}")) {
                hashes.push('#');
            }
            format!("r{hashes}'{value}'{hashes}")
        },
        "pwsh" | "powershell" | "cmd" => {
            use base64::Engine;
            let data = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
            format!("([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{data}')))")
        },
        "fish" => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'")),
        _ => format!("'{}'", value.replace('\'', "'\\''")),
    };
    // A chosen model passes the same bypass flags as the owner's shortcuts.
    let mut command = match agent {
        Agent::Alias(alias) => (*alias).to_owned(),
        Agent::Claude(model, effort) => {
            let mut command = format!(
                "claude --dangerously-skip-permissions --model {}",
                quote(model)
            );
            if let Some(effort) = effort {
                command.push_str(&format!(" --effort {}", quote(effort)));
            }
            command
        },
        Agent::Codex(model, effort) => {
            let mut command = format!(
                "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m {}",
                quote(model)
            );
            if let Some(effort) = effort {
                let setting = format!("model_reasoning_effort={effort}");
                command.push_str(&format!(" -c {}", quote(&setting)));
            }
            command
        },
    };
    let mut prompt = prompt.to_owned();
    if agent.is_claude() {
        // Claude has no image flag; it reads image paths named in the prompt.
        if !images.is_empty() {
            prompt.push_str(if prompt.is_empty() {
                "Attached images:\n"
            } else {
                "\n\nAttached images:\n"
            });
            prompt.push_str(&images.join("\n"));
        }
    } else {
        for image in images {
            command.push_str(&format!(" --image {}", quote(image)));
        }
    }
    if !prompt.is_empty() {
        command.push_str(&format!(" {} {}", quote("--"), quote(&prompt)));
    }
    if name == "cmd" {
        // cmd cannot quote arbitrary multiline data or suppress % expansion.
        // Use PowerShell's encoded script transport instead.
        use base64::Engine;
        let bytes: Vec<u8> = command.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -EncodedCommand {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    } else {
        command
    }
}

pub(super) fn tab_command(
    default_shell: Option<PathBuf>,
    command: String,
    cwd: Option<PathBuf>,
    elevated: bool,
) -> RunCommandAction {
    let shell = tab_shell(default_shell);
    let name = shell
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let args = match name.as_str() {
        "nu" => vec!["--interactive".into(), "--execute".into(), command],
        "pwsh" | "powershell" => vec!["-NoExit".into(), "-Command".into(), command],
        "cmd" => vec!["/K".into(), command],
        _ => vec!["-ic".into(), command],
    };
    let (command, args) = if elevated {
        (
            elevator(),
            std::iter::once(shell.to_string_lossy().into_owned())
                .chain(args)
                .collect(),
        )
    } else {
        (shell, args)
    };
    RunCommandAction {
        command,
        args,
        cwd,
        hold_on_close: true,
        use_terminal_title: true,
        ..Default::default()
    }
}

// Services started before gsudo was installed keep a PATH without it, and new
// tabs inherit that PATH, so prefer winget's default install location.
fn elevator() -> PathBuf {
    if !cfg!(windows) {
        return PathBuf::from("sudo");
    }
    std::env::var_os("ProgramFiles")
        .map(|dir| PathBuf::from(dir).join(r"gsudo\Current\gsudo.exe"))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("gsudo"))
}

/// A frame with no room measures xterm's floor of 2x1. New tabs copy a viewer's size,
/// and Claude's prompts cannot be read from a pane that narrow.
pub(super) fn has_room(size: &Size) -> bool {
    size.cols > 2 && size.rows > 1
}

pub(super) fn control_payload_to_server_msg(
    payload: WebClientToWebServerControlMessagePayload,
    default_shell: Option<PathBuf>,
) -> Option<ClientToServerMsg> {
    let client_msg = match payload {
        WebClientToWebServerControlMessagePayload::TerminalResize(size)
        | WebClientToWebServerControlMessagePayload::SetTabViewport { size, .. }
            if !has_room(&size) =>
        {
            return None;
        },
        WebClientToWebServerControlMessagePayload::TerminalResize(size) => {
            ClientToServerMsg::TerminalResize { new_size: size }
        },
        WebClientToWebServerControlMessagePayload::TerminalMetrics(metrics) => {
            terminal_metrics_to_ipc(metrics)
        },
        WebClientToWebServerControlMessagePayload::SoftKeyboardVisibilityChanged { visible } => {
            ClientToServerMsg::SoftKeyboardVisibilityChanged { visible }
        },
        WebClientToWebServerControlMessagePayload::NestedSessionFrameFromHost { payload_bytes } => {
            ClientToServerMsg::NestedSessionFrameFromHost { payload_bytes }
        },
        WebClientToWebServerControlMessagePayload::RequestSessionList => {
            ClientToServerMsg::RequestSessionList
        },
        WebClientToWebServerControlMessagePayload::FocusPane { pane_id, is_plugin } => {
            let pane_id = if is_plugin {
                PaneId::Plugin(pane_id)
            } else {
                PaneId::Terminal(pane_id)
            };
            ClientToServerMsg::Action {
                action: Action::FocusPaneByPaneId { pane_id },
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            }
        },
        WebClientToWebServerControlMessagePayload::NewPaneInTab { .. } => {
            ClientToServerMsg::Action {
                action: Action::NewTiledPane {
                    direction: None,
                    command: None,
                    pane_name: None,
                    near_current_pane: false,
                    no_focus: false,
                    borderless: None,
                    tab_id: None,
                },
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            }
        },
        WebClientToWebServerControlMessagePayload::NewTab {
            elevated,
            project,
            command,
            prompt,
            images,
        } => {
            let command = match prompt {
                Some(text) => {
                    let Some(agent) = prompt_agent(command.as_deref().unwrap_or_default()) else {
                        log::warn!("Ignoring a new tab for an unknown agent");
                        return None;
                    };
                    Some(prompt_command(
                        default_shell.clone(),
                        &agent,
                        &text,
                        &images,
                    ))
                },
                None => command,
            };
            let cwd = project.and_then(|p| std::env::home_dir().map(|home| project_cwd(home, &p)));
            let initial_panes = if command.as_ref().is_some_and(|c| !c.trim().is_empty()) {
                Some(vec![CommandOrPlugin::Command(tab_command(
                    default_shell,
                    command.unwrap(),
                    cwd.clone(),
                    elevated,
                ))])
            } else {
                elevated.then(|| vec![CommandOrPlugin::Command(elevated_shell(default_shell))])
            };
            ClientToServerMsg::Action {
                action: Action::NewTab {
                    tiled_layout: None,
                    floating_layouts: vec![],
                    swap_tiled_layouts: None,
                    swap_floating_layouts: None,
                    // The sidebar marks tabs with this name as elevated.
                    tab_name: elevated.then(|| "Administrator".to_owned()),
                    should_change_focus_to_new_tab: true,
                    cwd,
                    initial_panes,
                    first_pane_unblock_condition: None,
                },
                terminal_id: None,
                client_id: None,
                is_cli_client: false,
            }
        },
        WebClientToWebServerControlMessagePayload::SetMobileRenderPreferences {
            single_pane,
            fit,
        } => ClientToServerMsg::SetMobileRenderPreferences { single_pane, fit },
        WebClientToWebServerControlMessagePayload::SetTabViewport {
            size,
            tab_position,
            ownership,
        } => ClientToServerMsg::SetTabViewport {
            size,
            tab_position,
            ownership,
        },
        WebClientToWebServerControlMessagePayload::SetViewerHidden { hidden } => {
            ClientToServerMsg::SetViewerHidden { hidden }
        },
        WebClientToWebServerControlMessagePayload::Unknown => {
            log::warn!("Ignoring unknown control message type from web client");
            return None;
        },
    };
    Some(client_msg)
}

pub(super) fn project_cwd(home: PathBuf, project: &str) -> PathBuf {
    let project = project.trim();
    let git = home.join("git");
    if project.is_empty() && !git.is_dir() {
        home
    } else {
        git.join(project)
    }
}

fn terminal_metrics_to_ipc(metrics: TerminalMetricsPayload) -> ClientToServerMsg {
    ClientToServerMsg::TerminalPixelDimensions {
        pixel_dimensions: PixelDimensions {
            text_area_size: Some(SizeInPixels {
                width: metrics.text_area_pixel_width,
                height: metrics.text_area_pixel_height,
            }),
            character_cell_size: Some(SizeInPixels {
                width: metrics.cell_pixel_width,
                height: metrics.cell_pixel_height,
            }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switchboard_empty_project_uses_git_directory_or_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().to_path_buf();
        let git = home.join("git");
        for project in ["", "  \t "] {
            assert_eq!(project_cwd(home.clone(), project), home);
        }
        std::fs::write(&git, "not a directory").unwrap();
        assert_eq!(project_cwd(home.clone(), ""), home);
        std::fs::remove_file(&git).unwrap();
        std::fs::create_dir(&git).unwrap();
        for project in ["", "  \t "] {
            assert_eq!(project_cwd(home.clone(), project), git);
        }
        assert_eq!(project_cwd(home.clone(), "sample"), git.join("sample"));
        assert_eq!(project_cwd(home.clone(), home.to_str().unwrap()), home);
    }

    #[test]
    fn terminal_metrics_to_ipc_preserves_all_dimensions() {
        let metrics = TerminalMetricsPayload {
            cell_pixel_width: 9,
            cell_pixel_height: 18,
            text_area_pixel_width: 80 * 9,
            text_area_pixel_height: 24 * 18,
        };
        let msg = terminal_metrics_to_ipc(metrics);
        match msg {
            ClientToServerMsg::TerminalPixelDimensions { pixel_dimensions } => {
                let cell = pixel_dimensions
                    .character_cell_size
                    .expect("cell size missing");
                let area = pixel_dimensions
                    .text_area_size
                    .expect("text area size missing");
                assert_eq!(cell.width, 9);
                assert_eq!(cell.height, 18);
                assert_eq!(area.width, 720);
                assert_eq!(area.height, 432);
            },
            other => panic!("expected TerminalPixelDimensions, got {:?}", other),
        }
    }

    #[test]
    fn terminal_metrics_round_trips_through_json_payload() {
        // The browser sends this message as JSON over the control
        // socket. Verify that the on-wire shape deserializes into the
        // variant we route into terminal_metrics_to_ipc.
        let raw = serde_json::json!({
            "web_client_id": "abc",
            "payload": {
                "type": "TerminalMetrics",
                "cell_pixel_width": 7,
                "cell_pixel_height": 14,
                "text_area_pixel_width": 560,
                "text_area_pixel_height": 336,
            }
        });
        let parsed: WebClientToWebServerControlMessage =
            serde_json::from_value(raw).expect("parse");
        let metrics = match parsed.payload {
            WebClientToWebServerControlMessagePayload::TerminalMetrics(m) => m,
            other => panic!("expected TerminalMetrics, got {:?}", other),
        };
        assert_eq!(metrics.cell_pixel_width, 7);
        assert_eq!(metrics.cell_pixel_height, 14);
        assert_eq!(metrics.text_area_pixel_width, 560);
        assert_eq!(metrics.text_area_pixel_height, 336);
    }

    #[test]
    fn terminal_resize_still_deserializes_after_adding_variant() {
        // Regression guard for the new enum variant: the existing
        // TerminalResize wire shape must continue to parse unchanged
        // (no `type` rename, no required-field changes).
        let raw = serde_json::json!({
            "web_client_id": "abc",
            "payload": {
                "type": "TerminalResize",
                "rows": 24,
                "cols": 80,
            }
        });
        let parsed: WebClientToWebServerControlMessage =
            serde_json::from_value(raw).expect("parse");
        match parsed.payload {
            WebClientToWebServerControlMessagePayload::TerminalResize(size) => {
                assert_eq!(size.rows, 24);
                assert_eq!(size.cols, 80);
            },
            other => panic!("expected TerminalResize, got {:?}", other),
        }
    }

    #[test]
    fn switchboard_ignores_a_resize_from_a_frame_with_no_room() {
        let resize = |cols, rows| {
            control_payload_to_server_msg(
                WebClientToWebServerControlMessagePayload::TerminalResize(Size { rows, cols }),
                None,
            )
        };
        assert!(resize(2, 1).is_none());
        assert!(matches!(
            resize(80, 24),
            Some(ClientToServerMsg::TerminalResize { .. })
        ));
        let viewport = |cols, rows| {
            control_payload_to_server_msg(
                WebClientToWebServerControlMessagePayload::SetTabViewport {
                    size: Size { rows, cols },
                    tab_position: 0,
                    ownership: None,
                },
                None,
            )
        };
        assert!(viewport(2, 1).is_none());
        assert!(viewport(80, 24).is_some());
    }

    #[test]
    fn focus_pane_payload_deserializes() {
        let raw = serde_json::json!({
            "web_client_id": "abc",
            "payload": {
                "type": "FocusPane",
                "pane_id": 7,
                "is_plugin": true,
            }
        });
        let parsed: WebClientToWebServerControlMessage =
            serde_json::from_value(raw).expect("parse");
        match parsed.payload {
            WebClientToWebServerControlMessagePayload::FocusPane { pane_id, is_plugin } => {
                assert_eq!(pane_id, 7);
                assert!(is_plugin);
            },
            other => panic!("expected FocusPane, got {:?}", other),
        }
    }

    #[test]
    fn new_pane_in_tab_payload_deserializes() {
        let raw = serde_json::json!({
            "web_client_id": "abc",
            "payload": {
                "type": "NewPaneInTab",
                "tab_id": 2,
            }
        });
        let parsed: WebClientToWebServerControlMessage =
            serde_json::from_value(raw).expect("parse");
        match parsed.payload {
            WebClientToWebServerControlMessagePayload::NewPaneInTab { tab_id } => {
                assert_eq!(tab_id, 2);
            },
            other => panic!("expected NewPaneInTab, got {:?}", other),
        }
    }

    #[test]
    fn new_tab_payload_deserializes() {
        let raw = serde_json::json!({
            "web_client_id": "abc",
            "payload": { "type": "NewTab" }
        });
        let parsed: WebClientToWebServerControlMessage =
            serde_json::from_value(raw).expect("parse");
        assert!(matches!(
            parsed.payload,
            WebClientToWebServerControlMessagePayload::NewTab {
                elevated: false,
                project: None,
                command: None,
                prompt: None,
                images
            } if images.is_empty()
        ));
    }

    #[test]
    fn new_tab_project_and_alias_run_in_the_configured_shell() {
        for elevated in [false, true] {
            let payload = serde_json::from_value(serde_json::json!({
                "type": "NewTab", "project": "switchboard", "command": "castra", "elevated": elevated
            })).unwrap();
            let Some(ClientToServerMsg::Action {
                action:
                    Action::NewTab {
                        cwd,
                        initial_panes: Some(panes),
                        ..
                    },
                ..
            }) = control_payload_to_server_msg(payload, Some(PathBuf::from("nu")))
            else {
                panic!("expected a command tab")
            };
            let expected = std::env::home_dir()
                .unwrap()
                .join("git")
                .join("switchboard");
            assert_eq!(cwd, Some(expected.clone()));
            let [CommandOrPlugin::Command(run)] = panes.as_slice() else {
                panic!("expected one pane")
            };
            assert_eq!(run.cwd, Some(expected));
            assert_eq!(
                run.command,
                if elevated {
                    elevator()
                } else {
                    PathBuf::from("nu")
                }
            );
            let mut args = vec!["--interactive", "--execute", "castra"];
            if elevated {
                args.insert(0, "nu");
            }
            assert_eq!(run.args, args);
            assert!(run.hold_on_close && run.use_terminal_title);
        }
    }

    #[test]
    fn new_tab_shell_arguments_keep_the_command_intact() {
        for (shell, flags) in [
            ("zsh", vec!["-ic"]),
            ("pwsh.exe", vec!["-NoExit", "-Command"]),
            ("cmd.exe", vec!["/K"]),
        ] {
            let run = tab_command(
                Some(PathBuf::from(shell)),
                "csol 'some prompt'".into(),
                None,
                false,
            );
            assert_eq!(&run.args[..run.args.len() - 1], flags.as_slice());
            assert_eq!(run.args.last().unwrap(), "csol 'some prompt'");
        }
    }

    #[test]
    fn switchboard_new_tab_prompt_round_trips_through_real_shells() {
        use std::process::Command;
        let prompt = "  --help it's \"quoted\" ‘smart’ $HOME $(echo bad); & | %PATH% \\ 🦀\nsecond line '# '## \\server\\share  ";
        let images = vec![
            "C:/my images/it's a $shot.png".to_owned(),
            "/tmp/second image.png".to_owned(),
        ];
        let mut tested = 0;
        let shells = if cfg!(windows) {
            vec![
                "nu",
                "pwsh",
                "powershell",
                "C:/Program Files/Git/bin/bash.exe",
            ]
        } else {
            vec!["/bin/sh", "bash", "zsh", "fish", "nu", "pwsh"]
        };
        let agents = [
            Agent::Alias("csol"),
            Agent::Alias("c"),
            Agent::Claude("claude-opus-5-5[1m]".into(), None),
            Agent::Claude("claude-opus-5-5".into(), Some("xhigh".into())),
            Agent::Codex("gpt-6.1-sol".into(), None),
            Agent::Codex("gpt-6.1-sol".into(), Some("high".into())),
        ];
        for (shell, choice) in shells
            .into_iter()
            .flat_map(|shell| agents.clone().map(|agent| (shell, agent)))
        {
            let command = prompt_command(Some(shell.into()), &choice, prompt, &images);
            let agent = choice.program();
            let (script, flags, json) = match shell {
                "nu" => (format!("def --wrapped {agent} [...args: string] {{ $args | to json --raw }}; {command}"), vec!["--no-config-file", "-c"], true),
                "pwsh" | "powershell" => (format!("[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); function {agent} {{ ConvertTo-Json -Compress -InputObject @($args) }}; {command}"), vec!["-NoProfile", "-Command"], true),
                "fish" => (format!("function {agent}; printf '%s\\0' $argv; end; {command}"), vec!["-c"], false),
                _ => (format!("{agent}() {{ printf '%s\\0' \"$@\"; }}; {command}"), vec!["-c"], false),
            };
            let output = match Command::new(shell).args(flags).arg(script).output() {
                Ok(output) => output,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => panic!("{shell}: {error}"),
            };
            assert!(
                output.status.success(),
                "{shell}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let args: Vec<String> = if json {
                serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
                    panic!(
                        "{shell}: {error}: {}",
                        String::from_utf8_lossy(&output.stdout)
                    )
                })
            } else {
                output
                    .stdout
                    .split(|byte| *byte == 0)
                    .filter(|arg| !arg.is_empty())
                    .map(|arg| String::from_utf8(arg.to_vec()).unwrap())
                    .collect()
            };
            let claude_prompt = format!("{prompt}\n\nAttached images:\n{}", images.join("\n"));
            let setting = match &choice {
                Agent::Codex(_, Some(effort)) => format!("model_reasoning_effort={effort}"),
                _ => String::new(),
            };
            let mut expected: Vec<&str> = match &choice {
                Agent::Alias(_) => vec![],
                Agent::Claude(model, effort) => {
                    let mut args = vec!["--dangerously-skip-permissions", "--model", model];
                    if let Some(effort) = effort {
                        args.extend(["--effort", effort.as_str()]);
                    }
                    args
                },
                Agent::Codex(model, effort) => {
                    let mut args = vec![
                        "--dangerously-bypass-approvals-and-sandbox",
                        "--dangerously-bypass-hook-trust",
                        "-m",
                        model,
                    ];
                    if effort.is_some() {
                        args.extend(["-c", setting.as_str()]);
                    }
                    args
                },
            };
            if choice.is_claude() {
                expected.extend(["--", claude_prompt.as_str()]);
            } else {
                expected.extend(["--image", &images[0], "--image", &images[1], "--", prompt]);
            }
            assert_eq!(args, expected, "{shell} {agent}");
            tested += 1;
        }
        assert!(tested > 0, "No shell available to test prompt quoting");
        assert_eq!(
            prompt_command(Some("nu".into()), &Agent::Alias("csol"), "", &[]),
            "csol"
        );
        assert_eq!(
            prompt_command(Some("nu".into()), &Agent::Alias("c"), "", &[]),
            "c"
        );
    }

    #[test]
    fn switchboard_new_tab_prompt_reaches_the_configured_shell() {
        for elevated in [false, true] {
            let payload = serde_json::from_value(serde_json::json!({
                "type":"NewTab", "project":"sample", "prompt":"fix this\nplease", "images":["/tmp/my shot.png"], "elevated":elevated
            })).unwrap();
            let Some(ClientToServerMsg::Action {
                action:
                    Action::NewTab {
                        initial_panes: Some(panes),
                        ..
                    },
                ..
            }) = control_payload_to_server_msg(payload, Some("nu".into()))
            else {
                panic!("Expected prompt command");
            };
            let [CommandOrPlugin::Command(run)] = panes.as_slice() else {
                panic!("Expected one command");
            };
            assert_eq!(
                run.args.last().unwrap(),
                "csol --image r#'/tmp/my shot.png'# r#'--'# r#'fix this\nplease'#"
            );
        }
    }

    #[test]
    fn switchboard_new_tab_prompt_launches_the_chosen_agent() {
        let launch = |command: &str| {
            let payload = serde_json::from_value(serde_json::json!({
                "type":"NewTab", "project":"sample", "command":command, "prompt":"go", "images":["/tmp/a.png"]
            }))
            .unwrap();
            match control_payload_to_server_msg(payload, Some("nu".into())) {
                Some(ClientToServerMsg::Action {
                    action:
                        Action::NewTab {
                            initial_panes: Some(panes),
                            ..
                        },
                    ..
                }) => match panes.as_slice() {
                    [CommandOrPlugin::Command(run)] => Some(run.args.last().unwrap().clone()),
                    _ => panic!("Expected one command"),
                },
                _ => None,
            }
        };
        assert_eq!(
            launch("castra").as_deref(),
            Some("castra --image r#'/tmp/a.png'# r#'--'# r#'go'#")
        );
        assert_eq!(
            launch("c").as_deref(),
            Some("c r#'--'# r#'go\n\nAttached images:\n/tmp/a.png'#")
        );
        assert_eq!(
            launch("claude:claude-opus-5-5").as_deref(),
            Some(
                "claude --dangerously-skip-permissions --model r#'claude-opus-5-5'# r#'--'# r#'go

Attached images:
/tmp/a.png'#"
            )
        );
        assert_eq!(
            launch("codex:gpt-6-luna").as_deref(),
            Some("codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m r#'gpt-6-luna'# --image r#'/tmp/a.png'# r#'--'# r#'go'#")
        );
        assert_eq!(
            launch("codex:gpt-6.1-sol#xhigh").as_deref(),
            Some("codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m r#'gpt-6.1-sol'# -c r#'model_reasoning_effort=xhigh'# --image r#'/tmp/a.png'# r#'--'# r#'go'#")
        );
        assert_eq!(
            launch("claude:claude-opus-5-5#max").as_deref(),
            Some(
                "claude --dangerously-skip-permissions --model r#'claude-opus-5-5'# --effort r#'max'# r#'--'# r#'go

Attached images:
/tmp/a.png'#"
            )
        );
        for command in [
            "rm -rf ~",
            "claude:",
            "claude:--help",
            "codex:gpt 6",
            "codex:$(id)",
            "gemini:pro",
            "claude:a;b",
            "claude:claude-opus-5-5#ultra",
            "codex:gpt-6.1-sol#",
            "codex:gpt-6.1-sol#high;id",
            "codex:#high",
            "csol#high",
        ] {
            assert_eq!(launch(command), None, "{command}");
        }
    }

    #[test]
    fn elevated_new_tab_runs_the_default_shell_through_the_elevator() {
        let payload =
            serde_json::from_value(serde_json::json!({ "type": "NewTab", "elevated": true }))
                .expect("parse");
        let Some(ClientToServerMsg::Action {
            action:
                Action::NewTab {
                    initial_panes: Some(panes),
                    tab_name: Some(tab_name),
                    ..
                },
            ..
        }) = control_payload_to_server_msg(payload, Some(PathBuf::from("nu")))
        else {
            panic!("expected a NewTab with an initial pane");
        };
        let [CommandOrPlugin::Command(run)] = panes.as_slice() else {
            panic!("expected one command pane, got {panes:?}");
        };
        assert_eq!(
            tab_name, "Administrator",
            "The sidebar shields tabs by this name"
        );
        assert_eq!(
            (&run.command, run.args.as_slice()),
            (&elevator(), &["nu".to_owned()][..])
        );
        let name = run.command.file_stem().and_then(|name| name.to_str());
        assert_eq!(name, Some(if cfg!(windows) { "gsudo" } else { "sudo" }));
    }

    #[test]
    fn set_mobile_render_preferences_payload_deserializes() {
        let raw = serde_json::json!({
            "web_client_id": "abc",
            "payload": {
                "type": "SetMobileRenderPreferences",
                "single_pane": false,
                "fit": true,
            }
        });
        let parsed: WebClientToWebServerControlMessage =
            serde_json::from_value(raw).expect("parse");
        match parsed.payload {
            WebClientToWebServerControlMessagePayload::SetMobileRenderPreferences {
                single_pane,
                fit,
            } => {
                assert!(!single_pane);
                assert!(fit);
            },
            other => panic!("expected SetMobileRenderPreferences, got {:?}", other),
        }
    }

    #[test]
    fn tab_viewport_reports_and_ownership_survive_web_control_conversion() {
        for ownership in [None, Some(false), Some(true)] {
            let raw = serde_json::json!({
                "web_client_id": "abc",
                "payload": {
                    "type": "SetTabViewport",
                    "size": { "rows": 24, "cols": 80 },
                    "tab_position": 2,
                    "ownership": ownership,
                }
            });
            let parsed: WebClientToWebServerControlMessage =
                serde_json::from_value(raw).expect("parse");
            assert_eq!(
                control_payload_to_server_msg(parsed.payload, None),
                Some(ClientToServerMsg::SetTabViewport {
                    size: Size { rows: 24, cols: 80 },
                    tab_position: 2,
                    ownership,
                })
            );
        }
    }

    #[test]
    fn hidden_viewer_reports_survive_web_control_conversion() {
        for hidden in [false, true] {
            let raw = serde_json::json!({
                "web_client_id": "abc",
                "payload": { "type": "SetViewerHidden", "hidden": hidden }
            });
            let parsed: WebClientToWebServerControlMessage =
                serde_json::from_value(raw).expect("parse");
            assert_eq!(
                control_payload_to_server_msg(parsed.payload, None),
                Some(ClientToServerMsg::SetViewerHidden { hidden })
            );
        }
    }

    #[test]
    fn new_pane_in_tab_is_routed_to_the_requesting_client() {
        let client_msg = control_payload_to_server_msg(
            WebClientToWebServerControlMessagePayload::NewPaneInTab { tab_id: 2 },
            None,
        )
        .expect("message dropped");
        match client_msg {
            ClientToServerMsg::Action {
                action:
                    Action::NewTiledPane {
                        tab_id, no_focus, ..
                    },
                ..
            } => {
                assert_eq!(
                    tab_id, None,
                    "The pane is opened in the client's own tab so that it is focused for it, \
                     keeping single-pane mode attached to the new pane"
                );
                assert!(!no_focus, "The new pane takes focus");
            },
            other => panic!("expected a NewTiledPane action, got {:?}", other),
        }
    }

    #[test]
    fn unknown_control_message_is_dropped() {
        assert!(control_payload_to_server_msg(
            WebClientToWebServerControlMessagePayload::Unknown,
            None
        )
        .is_none());
    }
}
