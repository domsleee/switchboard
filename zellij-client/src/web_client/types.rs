use axum::extract::ws::Message;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{atomic::AtomicBool, Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;
use tokio_util::sync::CancellationToken;

use crate::os_input_output::ClientOsApi;
use crate::web_client::control_message::SetConfigPayload;
use crate::web_client::session_management::spawn_new_session;
use std::path::PathBuf;
use zellij_utils::{
    data::SessionInfo,
    input::{config::Config, options::Options},
    ipc::ClientToServerMsg,
    pane_size::Size,
};

pub trait ClientOsApiFactory: Send + Sync + std::fmt::Debug {
    fn create_client_os_api(&self) -> Result<Box<dyn ClientOsApi>, Box<dyn std::error::Error>>;
}

#[derive(Debug, Clone)]
pub struct RealClientOsApiFactory;

impl ClientOsApiFactory for RealClientOsApiFactory {
    fn create_client_os_api(&self) -> Result<Box<dyn ClientOsApi>, Box<dyn std::error::Error>> {
        crate::os_input_output::get_client_os_input()
            .map(|os_input| Box::new(os_input) as Box<dyn ClientOsApi>)
            .map_err(|e| format!("Failed to create client OS API: {:?}", e).into())
    }
}

pub trait SessionManager: Send + Sync + std::fmt::Debug {
    fn session_exists(&self, session_name: &str) -> Result<bool, Box<dyn std::error::Error>>;
    fn list_sessions(&self) -> Vec<WebSessionInfo>;
    fn get_resurrection_layout(
        &self,
        session_name: &str,
    ) -> Option<zellij_utils::input::layout::Layout>;
    fn spawn_session_if_needed(
        &self,
        session_name: &str,
        os_input: Box<dyn ClientOsApi>,
        session_exists: bool,
        zellij_ipc_pipe: &PathBuf,
        first_message: ClientToServerMsg,
    );
}

#[derive(Debug, Clone)]
pub struct RealSessionManager;

/// A session has no socket while it moves between engines, and the sidebar closes
/// the terminal of any session it stops seeing, so report its last known state.
fn keep_moving_sessions(mut live: Vec<WebSessionInfo>) -> Vec<WebSessionInfo> {
    static LAST_LISTED: Mutex<Vec<WebSessionInfo>> = Mutex::new(Vec::new());
    let mut last = LAST_LISTED
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    for session in last.iter() {
        if zellij_utils::handoff::in_progress(&session.name)
            && !live.iter().any(|listed| listed.name == session.name)
        {
            live.push(session.clone());
        }
    }
    last.clone_from(&live);
    live
}

/// When #357 merged, plus an hour to reach every computer. The engine publishes no marker
/// for it, and engines started earlier ignore SetViewerHidden.
const ENGINES_OBEY_HIDDEN_SINCE_UNIX_SECS: u64 = 1_794_048_177;

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// The size to attach a hidden viewer at on an engine that honours SetViewerHidden only
/// once the viewer has attached. A web viewer lands on the first tab, so attaching at that
/// tab's size cannot resize it before the hidden report arrives.
fn late_hidden_attach_size(info: &SessionInfo, now: u64) -> Option<Size> {
    if info.hidden_attach
        || now.saturating_sub(info.creation_time.as_secs()) < ENGINES_OBEY_HIDDEN_SINCE_UNIX_SECS
    {
        return None;
    }
    info.tabs
        .iter()
        .min_by_key(|tab| tab.position)
        .map(|tab| Size {
            rows: tab.display_area_rows,
            cols: tab.display_area_columns,
        })
        .filter(|size| size.rows > 0 && size.cols > 0)
}

#[cfg(test)]
mod late_hidden_attach_tests {
    use super::*;
    use std::time::Duration;
    use zellij_utils::data::TabInfo;

    const AFTER: u64 = ENGINES_OBEY_HIDDEN_SINCE_UNIX_SECS + 3600;

    fn tab(position: usize, cols: usize, rows: usize) -> TabInfo {
        TabInfo {
            position,
            display_area_columns: cols,
            display_area_rows: rows,
            ..Default::default()
        }
    }

    fn session(age: u64, hidden_attach: bool, tabs: Vec<TabInfo>) -> SessionInfo {
        SessionInfo {
            hidden_attach,
            tabs,
            creation_time: Duration::from_secs(age),
            ..Default::default()
        }
    }

    #[test]
    fn switchboard_late_hidden_attach_uses_the_tab_a_new_viewer_lands_on() {
        let info = session(60, false, vec![tab(1, 200, 60), tab(0, 120, 40)]);
        assert_eq!(
            late_hidden_attach_size(&info, AFTER),
            Some(Size {
                rows: 40,
                cols: 120
            })
        );
    }

    #[test]
    fn switchboard_late_hidden_attach_leaves_out_engines_it_cannot_help() {
        let tabs = vec![tab(0, 120, 40)];
        // Started before engines obeyed SetViewerHidden.
        assert_eq!(
            late_hidden_attach_size(&session(3601, false, tabs.clone()), AFTER),
            None
        );
        // Already keeps a report sent before the attach.
        assert_eq!(
            late_hidden_attach_size(&session(60, true, tabs), AFTER),
            None
        );
        // No known size could still resize the tab.
        assert_eq!(
            late_hidden_attach_size(&session(60, false, vec![tab(0, 0, 0)]), AFTER),
            None
        );
        assert_eq!(
            late_hidden_attach_size(&session(60, false, vec![]), AFTER),
            None
        );
    }
}

impl SessionManager for RealSessionManager {
    fn session_exists(&self, session_name: &str) -> Result<bool, Box<dyn std::error::Error>> {
        zellij_utils::sessions::session_exists(session_name)
            .map_err(|e| format!("Session check failed: {:?}", e).into())
    }

    fn list_sessions(&self) -> Vec<WebSessionInfo> {
        let live = zellij_utils::sessions::read_live_session_states_default_dirs("")
            .into_values()
            .map(|info| {
                let late_hidden_attach_size = late_hidden_attach_size(&info, unix_now());
                WebSessionInfo {
                    hidden_attach: info.hidden_attach || late_hidden_attach_size.is_some(),
                    late_hidden_attach_size,
                    name: info.name,
                    web_clients_allowed: info.web_clients_allowed,
                    sharing_recovery: false,
                    tab_count: info.tabs.len(),
                    pane_count: info.panes.panes.values().map(|panes| panes.len()).sum(),
                    connected_clients: info.connected_clients,
                    creation_secs_ago: info.creation_time.as_secs(),
                }
            })
            .collect();
        keep_moving_sessions(live)
    }

    fn get_resurrection_layout(
        &self,
        session_name: &str,
    ) -> Option<zellij_utils::input::layout::Layout> {
        zellij_utils::sessions::resurrection_layout(session_name)
            .ok()
            .flatten()
    }

    fn spawn_session_if_needed(
        &self,
        session_name: &str,
        os_input: Box<dyn ClientOsApi>,
        session_exists: bool,
        zellij_ipc_pipe: &PathBuf,
        first_message: ClientToServerMsg,
    ) {
        if !session_exists {
            spawn_new_session(session_name, os_input.clone(), zellij_ipc_pipe);
        }
        os_input.connect_to_server(&zellij_ipc_pipe);
        os_input.send_to_server(first_message);
    }
}

#[derive(Debug, Default, Clone)]
pub struct ConnectionTable {
    pub client_id_to_channels: HashMap<String, ClientChannels>,
    pub client_read_only_status: HashMap<String, bool>,
    pub client_session_token_hash: HashMap<String, String>,
}

const MAX_PENDING_CONTROL_MESSAGES: usize = 64;

#[derive(Debug, Clone)]
pub struct ClientChannels {
    pub os_api: Box<dyn ClientOsApi>,
    /// Only an explicit new-session request may start an engine during attachment.
    pub may_create_session: bool,
    pub control_channel_tx: Option<UnboundedSender<Message>>,
    pub terminal_channel_tx: Option<UnboundedSender<String>>,
    terminal_channel_cancellation_token: Option<CancellationToken>,
    pub should_not_reconnect: Arc<AtomicBool>,
    pub recovery_metadata_refresh:
        Option<crate::web_client::sharing_recovery::RecoveryMetadataRefresh>,
    pending_control_messages: Vec<Message>,
}

impl ClientChannels {
    pub fn new(os_api: Box<dyn ClientOsApi>) -> Self {
        ClientChannels {
            os_api,
            may_create_session: false,
            control_channel_tx: None,
            terminal_channel_tx: None,
            terminal_channel_cancellation_token: None,
            should_not_reconnect: Arc::new(AtomicBool::new(false)),
            recovery_metadata_refresh: None,
            pending_control_messages: Vec::new(),
        }
    }

    pub fn add_control_tx(&mut self, control_channel_tx: UnboundedSender<Message>) {
        for message in self.pending_control_messages.drain(..) {
            let _ = control_channel_tx.send(message);
        }
        self.control_channel_tx = Some(control_channel_tx);
    }

    pub fn queue_control_message(&mut self, message: Message) {
        if self.pending_control_messages.len() >= MAX_PENDING_CONTROL_MESSAGES {
            self.pending_control_messages.remove(0);
        }
        self.pending_control_messages.push(message);
    }

    pub fn add_terminal_tx(&mut self, terminal_channel_tx: UnboundedSender<String>) {
        self.terminal_channel_tx = Some(terminal_channel_tx);
    }

    pub fn add_terminal_channel_cancellation_token(
        &mut self,
        terminal_channel_cancellation_token: CancellationToken,
    ) {
        self.terminal_channel_cancellation_token = Some(terminal_channel_cancellation_token);
    }
    pub fn cleanup(&mut self) {
        if let Some(terminal_channel_cancellation_token) =
            self.terminal_channel_cancellation_token.take()
        {
            terminal_channel_cancellation_token.cancel();
        }
    }
}

#[derive(Debug)]
pub struct ClientConnectionBus {
    pub connection_table: Arc<Mutex<ConnectionTable>>,
    pub stdout_channel_tx: Option<UnboundedSender<String>>,
    pub control_channel_tx: Option<UnboundedSender<Message>>,
    pub web_client_id: String,
}

impl ClientConnectionBus {
    pub fn new(web_client_id: &str, connection_table: &Arc<Mutex<ConnectionTable>>) -> Self {
        let connection_table = connection_table.clone();
        let web_client_id = web_client_id.to_owned();
        let (stdout_channel_tx, control_channel_tx) = {
            let connection_table = connection_table.lock().unwrap();
            (
                connection_table.get_client_terminal_tx(&web_client_id),
                connection_table.get_client_control_tx(&web_client_id),
            )
        };
        ClientConnectionBus {
            connection_table,
            stdout_channel_tx,
            control_channel_tx,
            web_client_id,
        }
    }
}

pub const MAX_PENDING_WELCOME_SESSIONS: usize = 256;
pub const PENDING_WELCOME_SESSION_TTL: Duration = Duration::from_secs(300);

pub type PendingWelcomeSessions = Arc<Mutex<VecDeque<(String, Instant)>>>;

pub fn record_pending_welcome_session(pending: &PendingWelcomeSessions, session_name: &str) {
    let mut pending = pending.lock().unwrap();
    let now = Instant::now();
    pending.retain(|(_, created_at)| now.duration_since(*created_at) < PENDING_WELCOME_SESSION_TTL);
    while pending.len() >= MAX_PENDING_WELCOME_SESSIONS {
        pending.pop_front();
    }
    pending.push_back((session_name.to_owned(), now));
}

pub fn take_pending_welcome_session(pending: &PendingWelcomeSessions, session_name: &str) -> bool {
    let mut pending = pending.lock().unwrap();
    let now = Instant::now();
    pending.retain(|(_, created_at)| now.duration_since(*created_at) < PENDING_WELCOME_SESSION_TTL);
    match pending.iter().position(|(name, _)| name == session_name) {
        Some(index) => {
            pending.remove(index);
            true
        },
        None => false,
    }
}

#[derive(Clone)]
pub struct AppState {
    pub connection_table: Arc<Mutex<ConnectionTable>>,
    pub config: Arc<Mutex<Config>>,
    pub config_options: Options,
    pub config_file_path: PathBuf,
    pub session_manager: Arc<dyn SessionManager>,
    pub client_os_api_factory: Arc<dyn ClientOsApiFactory>,
    pub is_https: bool,
    pub pending_welcome_sessions: PendingWelcomeSessions,
    pub sharing_recovery: Option<crate::web_client::sharing_recovery::SharingRecovery>,
}

#[derive(Serialize)]
pub struct CreateClientIdResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumable: Option<super::attachment::ResumeInfo>,
    pub web_client_id: String,
    pub is_read_only: bool,
    pub session_name: String,
    pub config: SetConfigPayload,
}

#[derive(Deserialize)]
pub struct SessionQuery {
    #[serde(default)]
    pub resumable: bool,
    pub session: Option<String>,
    pub welcome: Option<bool>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WebSessionInfo {
    pub name: String,
    pub web_clients_allowed: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sharing_recovery: bool,
    /// A viewer can attach hidden (`hidden=true`) without sizing this session's tab.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden_attach: bool,
    /// Set when this session's engine needs the hidden report after the attach instead.
    #[serde(skip)]
    pub late_hidden_attach_size: Option<Size>,
    pub tab_count: usize,
    pub pane_count: usize,
    pub connected_clients: usize,
    pub creation_secs_ago: u64,
}

#[derive(Serialize, Deserialize)]
pub struct SessionListResponse {
    pub sessions: Vec<WebSessionInfo>,
    // Lets the Switchboard relay show which build each computer runs.
    #[serde(default)]
    pub build: BuildInfo,
}

#[derive(Serialize, Deserialize, Default)]
pub struct BuildInfo {
    pub commit: String,
    pub commit_date: String,
    #[serde(default)]
    pub commit_timestamp: String,
}

#[derive(Deserialize)]
pub struct TerminalParams {
    pub web_client_id: String,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
    pub cell_width: Option<u16>,
    pub cell_height: Option<u16>,
    /// Lines per wheel report when the browser scrolls finely (1); absent keeps 3.
    pub wheel_lines: Option<u32>,
    /// The browser shows another view, so this viewer must not size the tab.
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Deserialize)]
pub struct ControlParams {
    pub web_client_id: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub auth_token: String,
    pub remember_me: Option<bool>,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub success: bool,
    pub message: String,
}

pub const BRACKETED_PASTE_START: [u8; 6] = [27, 91, 50, 48, 48, 126]; // \u{1b}[200~
pub const BRACKETED_PASTE_END: [u8; 6] = [27, 91, 50, 48, 49, 126]; // \u{1b}[201~
