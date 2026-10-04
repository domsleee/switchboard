//! Operator-only recovery for a pre-existing local session with no native sharing action.
//! This does not change the session's sharing policy. Disable by restarting the web service.
use std::{
    net::IpAddr,
    path::{Path, PathBuf},
};
use zellij_utils::{
    data::WebSharing,
    input::{config::Config, options::Options},
    ipc::ClientToServerMsg,
};

#[derive(Clone, Debug)]
pub struct SharingRecovery {
    session: String,
    socket_path: PathBuf,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl SharingRecovery {
    pub fn from_environment(
        ip: IpAddr,
        config: &Config,
        options: &Options,
    ) -> Result<Option<Self>, String> {
        let Some(session) = std::env::var_os("SWITCHBOARD_RECOVER_UNSHARED_SESSION") else {
            return Ok(None);
        };
        let session = session
            .into_string()
            .map_err(|_| "Recovery session must be valid UTF-8".to_owned())?;
        Self::validate_configuration(ip, config, options)?;
        zellij_utils::sessions::validate_session_name(&session)
            .map_err(|error| error.to_string())?;
        let socket_path = zellij_utils::consts::ZELLIJ_SOCK_DIR.join(&session);
        let recovery = Self::pin(session, socket_path)?;
        if let Some(expected) = std::env::var_os("SWITCHBOARD_RECOVER_UNSHARED_SOCKET_IDENTITY") {
            let expected = expected
                .into_string()
                .map_err(|_| "Recovery socket identity must be UTF-8".to_owned())?;
            if expected != recovery.socket_identity() {
                return Err(
                    "Recovery socket identity changed; refusing a replacement session".to_owned(),
                );
            }
        }
        Ok(Some(recovery))
    }

    fn validate_configuration(
        ip: IpAddr,
        config: &Config,
        options: &Options,
    ) -> Result<(), String> {
        if !ip.is_loopback() {
            return Err("Session recovery requires a loopback-only web listener".to_owned());
        }
        if options.web_sharing == Some(WebSharing::Disabled)
            || config.options.web_sharing == Some(WebSharing::Disabled)
        {
            return Err("Session recovery cannot override disabled web sharing".to_owned());
        }
        Ok(())
    }

    fn pin(session: String, socket_path: PathBuf) -> Result<Self, String> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};
            let metadata = std::fs::symlink_metadata(&socket_path).map_err(|error| {
                format!("Recovery requires an existing session socket: {error}")
            })?;
            if !metadata.file_type().is_socket() {
                return Err("Recovery target must be an existing session socket".to_owned());
            }
            let identity = (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            );
            Ok(Self {
                session,
                socket_path,
                identity,
            })
        }
        #[cfg(not(unix))]
        {
            let _ = (session, socket_path);
            Err("Temporary sharing recovery is supported only for local UNIX sockets".to_owned())
        }
    }

    pub fn socket_identity(&self) -> String {
        #[cfg(unix)]
        {
            format!(
                "{}:{}:{}:{}",
                self.identity.0, self.identity.1, self.identity.2, self.identity.3
            )
        }
        #[cfg(not(unix))]
        {
            String::new()
        }
    }

    pub fn allows(&self, session: &str, socket_path: &Path, is_read_only: bool) -> bool {
        if is_read_only || session != self.session || socket_path != self.socket_path {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};
            std::fs::symlink_metadata(socket_path)
                .map(|metadata| {
                    metadata.file_type().is_socket()
                        && (
                            metadata.dev(),
                            metadata.ino(),
                            metadata.ctime(),
                            metadata.ctime_nsec(),
                        ) == self.identity
                })
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    pub fn is_target(&self, session: &str) -> bool {
        session == self.session
    }

    pub fn connect_existing(
        &self,
        session: &str,
        socket: &Path,
        is_read_only: bool,
        connect: impl FnOnce() -> std::io::Result<()>,
        attach: impl FnOnce(),
    ) -> std::io::Result<bool> {
        if !self.allows(session, socket, is_read_only) {
            return Ok(false);
        }
        connect()?;
        if !self.allows(session, socket, is_read_only) {
            return Ok(false);
        }
        attach();
        Ok(true)
    }

    pub fn catalog_allowed(&self, session: &str, is_read_only: bool) -> bool {
        self.allows(session, &self.socket_path, is_read_only)
    }

    pub fn adapt(
        &self,
        session: &str,
        socket_path: &Path,
        is_read_only: bool,
        message: &mut ClientToServerMsg,
    ) -> bool {
        if !self.allows(session, socket_path, is_read_only) {
            return false;
        }
        if let ClientToServerMsg::AttachClient { is_web_client, .. } = message {
            *is_web_client = false;
            true
        } else {
            false
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn recovery_is_exact_and_never_available_to_read_only_clients() {
        let path = std::env::temp_dir().join(format!("sb-recovery-{}", uuid::Uuid::new_v4()));
        let socket = UnixListener::bind(&path).unwrap();
        let recovery = SharingRecovery::pin("main".to_owned(), path.clone()).unwrap();
        assert!(recovery.allows("main", &path, false));
        assert!(!recovery.allows("other", &path, false));
        assert!(!recovery.allows("main", &path, true));
        assert!(!recovery.allows("main", &path.with_extension("other"), false));
        let mut writable = ClientToServerMsg::AttachClient {
            cli_assets: Default::default(),
            tab_position_to_focus: None,
            pane_to_focus: None,
            is_web_client: true,
        };
        assert!(recovery.adapt("main", &path, false, &mut writable));
        assert!(matches!(
            writable,
            ClientToServerMsg::AttachClient {
                is_web_client: false,
                ..
            }
        ));
        let mut creating = ClientToServerMsg::FirstClientConnected {
            cli_assets: Default::default(),
            is_web_client: true,
        };
        assert!(!recovery.adapt("main", &path, false, &mut creating));
        assert!(matches!(
            creating,
            ClientToServerMsg::FirstClientConnected {
                is_web_client: true,
                ..
            }
        ));
        let mut watcher = ClientToServerMsg::AttachWatcherClient {
            terminal_size: Default::default(),
            is_web_client: true,
        };
        assert!(!recovery.adapt("main", &path, true, &mut watcher));
        assert!(matches!(
            watcher,
            ClientToServerMsg::AttachWatcherClient {
                is_web_client: true,
                ..
            }
        ));
        drop(socket);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn recovery_fails_closed_when_socket_is_replaced() {
        let path = std::env::temp_dir().join(format!("sb-recovery-{}", uuid::Uuid::new_v4()));
        let socket = UnixListener::bind(&path).unwrap();
        let recovery = SharingRecovery::pin("main".to_owned(), path.clone()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(!recovery.catalog_allowed("main", false));
        let replacement = UnixListener::bind(&path).unwrap();
        assert!(!recovery.catalog_allowed("main", false));
        drop((socket, replacement));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn recovery_refuses_non_loopback_and_disabled_configuration() {
        let loopback = "127.0.0.1".parse().unwrap();
        let public = "0.0.0.0".parse().unwrap();
        let mut config = Config::default();
        let mut options = Options::default();
        assert!(SharingRecovery::validate_configuration(loopback, &config, &options).is_ok());
        assert!(SharingRecovery::validate_configuration(public, &config, &options).is_err());
        options.web_sharing = Some(WebSharing::Disabled);
        assert!(SharingRecovery::validate_configuration(loopback, &config, &options).is_err());
        options.web_sharing = Some(WebSharing::On);
        config.options.web_sharing = Some(WebSharing::Disabled);
        assert!(SharingRecovery::validate_configuration(loopback, &config, &options).is_err());
    }

    #[test]
    fn socket_replacement_during_connect_does_not_send_attach() {
        use std::{cell::Cell, os::unix::net::UnixStream};
        let path = std::env::temp_dir().join(format!("sb-recovery-{}", uuid::Uuid::new_v4()));
        let listener = UnixListener::bind(&path).unwrap();
        let recovery = SharingRecovery::pin("main".to_owned(), path.clone()).unwrap();
        let sent_attach = Cell::new(false);
        let mut replacement = None;
        let attached = recovery.connect_existing(
            "main",
            &path,
            false,
            || {
                let _connection = UnixStream::connect(&path).unwrap();
                std::fs::remove_file(&path).unwrap();
                replacement = Some(UnixListener::bind(&path).unwrap());
                Ok(())
            },
            || sent_attach.set(true),
        );
        assert!(!attached.unwrap());
        assert!(!sent_attach.get());
        drop((listener, replacement));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn missing_or_replaced_target_never_connects_or_creates() {
        use std::cell::Cell;
        let path = std::env::temp_dir().join(format!("sb-recovery-{}", uuid::Uuid::new_v4()));
        let socket = UnixListener::bind(&path).unwrap();
        let recovery = SharingRecovery::pin("main".to_owned(), path.clone()).unwrap();
        assert!(recovery.is_target("main"));
        assert!(!recovery.is_target("other"));
        std::fs::remove_file(&path).unwrap();
        let connects = Cell::new(0);
        let attaches = Cell::new(0);
        for replaced in [false, true] {
            let replacement = if replaced {
                Some(UnixListener::bind(&path).unwrap())
            } else {
                None
            };
            let attached = recovery
                .connect_existing(
                    "main",
                    &path,
                    false,
                    || {
                        connects.set(connects.get() + 1);
                        Ok(())
                    },
                    || attaches.set(attaches.get() + 1),
                )
                .unwrap();
            assert!(!attached);
            assert_eq!(connects.get(), 0);
            assert_eq!(attaches.get(), 0);
            if replaced {
                drop(replacement);
                std::fs::remove_file(&path).unwrap();
            }
        }
        drop(socket);
    }

    #[test]
    fn failed_connection_returns_promptly_without_sending_attach() {
        use std::{
            cell::Cell,
            io::{Error, ErrorKind},
        };
        let path = std::env::temp_dir().join(format!("sb-recovery-{}", uuid::Uuid::new_v4()));
        let socket = UnixListener::bind(&path).unwrap();
        let recovery = SharingRecovery::pin("main".to_owned(), path.clone()).unwrap();
        let attaches = Cell::new(0);
        let started = std::time::Instant::now();
        let result = recovery.connect_existing(
            "main",
            &path,
            false,
            || Err(Error::new(ErrorKind::ConnectionRefused, "fixture")),
            || attaches.set(1),
        );
        assert!(result.is_err());
        assert_eq!(attaches.get(), 0);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        drop(socket);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn recovery_refuses_non_socket_targets() {
        let path = std::env::temp_dir().join(format!("sb-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "test").unwrap();
        assert!(SharingRecovery::pin("main".to_owned(), path.clone()).is_err());
        std::fs::remove_file(path).unwrap();
    }
}

/// A temporary native attachment does not receive web-only MobileState messages.
/// Query actual engine metadata on the same IPC connection, including this client's tab.
#[derive(Default)]
pub struct RecoveryMetadata {
    tabs: Option<Vec<zellij_utils::data::TabInfo>>,
    panes: Option<Vec<zellij_utils::data::PaneListEntry>>,
    current_tab: Option<zellij_utils::data::TabInfo>,
    pending: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    wake: Option<std::sync::mpsc::SyncSender<()>>,
}

impl RecoveryMetadata {
    #[cfg(test)]
    pub fn with_pending(pending: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>) -> Self {
        Self {
            pending,
            ..Default::default()
        }
    }
    pub fn with_poll(poll: Option<&RecoveryMetadataPoll>) -> Self {
        Self {
            pending: poll.map(|poll| poll.pending.clone()),
            wake: poll.map(|poll| poll.refresh.wake.clone()),
            ..Default::default()
        }
    }
    pub fn consume(&mut self, lines: &[String]) -> bool {
        if lines.len() != 1 {
            return false;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&lines[0]) else {
            return false;
        };
        if value.is_object() && value.get("tab_id").is_some() {
            if let Ok(tab) = serde_json::from_value(value) {
                self.current_tab = Some(tab);
                if let Some(pending) = self.pending.as_ref() {
                    pending.store(false, std::sync::atomic::Ordering::Release);
                }
                if let Some(wake) = self.wake.as_ref() {
                    let _ = wake.try_send(());
                }
                return true;
            }
        } else if let Some(array) = value.as_array() {
            if array.first().and_then(|entry| entry.get("id")).is_some() {
                if let Ok(panes) = serde_json::from_value(value) {
                    self.panes = Some(panes);
                    return true;
                }
            } else if array
                .first()
                .and_then(|entry| entry.get("tab_id"))
                .is_some()
            {
                if let Ok(tabs) = serde_json::from_value(value) {
                    self.tabs = Some(tabs);
                    return true;
                }
            }
        }
        false
    }

    pub fn payload(
        &self,
        name: &str,
        sessions: Vec<crate::web_client::types::WebSessionInfo>,
    ) -> Option<zellij_utils::ipc::MobileStatePayload> {
        use zellij_utils::ipc::*;
        let (Some(tabs), Some(panes), Some(current)) = (&self.tabs, &self.panes, &self.current_tab)
        else {
            return None;
        };
        let eligible: Vec<_> = panes
            .iter()
            .filter(|pane| {
                pane.tab_position == current.position
                    && pane.pane_info.is_selectable
                    && !pane.pane_info.is_suppressed
            })
            .collect();
        // Do not invent per-client focus for a multi-pane tab. Existing IPC exposes the
        // exact current tab; a single selectable pane then identifies its focus exactly.
        let active_pane = if eligible.len() == 1 {
            Some(MobileActivePanePayload {
                pane_id: eligible[0].pane_info.id,
                is_plugin: eligible[0].pane_info.is_plugin,
                tab_position: current.position,
            })
        } else {
            None
        };
        Some(MobileStatePayload {
            session_name: name.to_owned(),
            now_secs: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            is_welcome_screen: false,
            desktop_client_connected: false,
            desktop_size: None,
            active_pane,
            tabs: tabs
                .iter()
                .map(|tab| MobileTabPayload {
                    position: tab.position,
                    name: tab.name.clone(),
                    active: tab.position == current.position,
                })
                .collect(),
            panes: panes
                .iter()
                .filter(|pane| pane.pane_info.is_selectable && !pane.pane_info.is_suppressed)
                .map(|pane| MobilePanePayload {
                    tab_position: pane.tab_position,
                    pane_id: pane.pane_info.id,
                    is_plugin: pane.pane_info.is_plugin,
                    title: pane.pane_info.title.clone(),
                    is_floating: pane.pane_info.is_floating,
                    // Legacy native metadata does not expose a per-pane last-output timestamp.
                    last_activity_secs_ago: u64::MAX,
                })
                .collect(),
            sessions: sessions
                .into_iter()
                .map(|session| MobileSessionPayload {
                    name: session.name,
                    web_clients_allowed: session.web_clients_allowed,
                    tab_count: session.tab_count,
                    pane_count: session.pane_count,
                    connected_clients: session.connected_clients,
                    creation_secs_ago: session.creation_secs_ago,
                })
                .collect(),
            render_prefs: MobileRenderPrefsPayload {
                single_pane: false,
                fit: true,
                active_pane_is_fullscreen: current.is_fullscreen_active,
            },
            tab_viewport: None,
        })
    }
}

pub struct RecoveryMetadataPoll {
    active: std::sync::Arc<std::sync::atomic::AtomicBool>,
    pending: std::sync::Arc<std::sync::atomic::AtomicBool>,
    refresh: RecoveryMetadataRefresh,
}

#[derive(Clone, Debug)]
pub struct RecoveryMetadataRefresh {
    requested: std::sync::Arc<std::sync::atomic::AtomicBool>,
    wake: std::sync::mpsc::SyncSender<()>,
}
impl RecoveryMetadataRefresh {
    pub fn request(&self) {
        self.requested
            .store(true, std::sync::atomic::Ordering::Release);
        // A burst of focus changes needs one fresh batch, not an unbounded queue.
        let _ = self.wake.try_send(());
    }
}
impl RecoveryMetadataPoll {
    pub fn refresh(&self) -> RecoveryMetadataRefresh {
        self.refresh.clone()
    }

    fn start(
        allowed: impl Fn() -> bool + Send + 'static,
        send: impl Fn() + Send + 'static,
    ) -> Self {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc::sync_channel,
            Arc,
        };
        use std::time::{Duration, Instant};
        let active = Arc::new(AtomicBool::new(true));
        let pending = Arc::new(AtomicBool::new(false));
        let requested = Arc::new(AtomicBool::new(false));
        let (wake, receiver) = sync_channel(1);
        let refresh = RecoveryMetadataRefresh { requested, wake };
        let worker_active = active.clone();
        let worker_pending = pending.clone();
        let worker_refresh = refresh.clone();
        std::thread::spawn(move || {
            let mut next_poll = Instant::now();
            let mut pending_since = None;
            while worker_active.load(Ordering::Acquire) && allowed() {
                let now = Instant::now();
                let wait = if worker_pending.load(Ordering::Acquire) {
                    // Stop rather than enqueue queries behind an unresponsive engine.
                    let deadline = pending_since.unwrap_or(now) + Duration::from_secs(5);
                    if now >= deadline {
                        break;
                    }
                    deadline - now
                } else if worker_refresh.requested.swap(false, Ordering::AcqRel) || now >= next_poll
                {
                    worker_pending.store(true, Ordering::Release);
                    pending_since = Some(now);
                    next_poll = now + Duration::from_secs(1);
                    send();
                    continue;
                } else {
                    next_poll - now
                };
                let _ = receiver.recv_timeout(wait);
            }
        });
        Self {
            active,
            pending,
            refresh,
        }
    }
}
impl Drop for RecoveryMetadataPoll {
    fn drop(&mut self) {
        self.active
            .store(false, std::sync::atomic::Ordering::Release);
        let _ = self.refresh.wake.try_send(());
    }
}

impl SharingRecovery {
    pub fn poll_metadata(
        &self,
        session: String,
        socket: PathBuf,
        os_input: Box<dyn crate::os_input_output::ClientOsApi>,
    ) -> RecoveryMetadataPoll {
        use zellij_utils::input::actions::Action;
        let recovery = self.clone();
        RecoveryMetadataPoll::start(
            move || recovery.allows(&session, &socket, false),
            move || {
                let actions = [
                    Action::ListTabs {
                        show_state: false,
                        show_dimensions: false,
                        show_panes: false,
                        show_layout: false,
                        show_all: true,
                        output_json: true,
                    },
                    Action::ListPanes {
                        show_tab: false,
                        show_command: false,
                        show_state: false,
                        show_geometry: false,
                        show_all: true,
                        output_json: true,
                    },
                    Action::CurrentTabInfo { output_json: true },
                ];
                for action in actions {
                    os_input.send_to_server(ClientToServerMsg::Action {
                        action,
                        terminal_id: None,
                        client_id: None,
                        is_cli_client: false,
                    });
                }
            },
        )
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    use zellij_utils::data::{PaneInfo, PaneListEntry, TabInfo};

    #[test]
    fn metadata_uses_this_clients_tab_and_preserves_real_pane_ids() {
        let first = TabInfo {
            position: 0,
            tab_id: 12,
            name: "first".into(),
            active: true,
            ..Default::default()
        };
        let second = TabInfo {
            position: 1,
            tab_id: 23,
            name: "second".into(),
            active: true,
            ..Default::default()
        };
        let panes = vec![
            PaneListEntry {
                pane_info: PaneInfo {
                    id: 31,
                    is_selectable: true,
                    ..Default::default()
                },
                tab_id: 12,
                tab_position: 0,
                tab_name: "first".into(),
                pane_command: None,
                pane_cwd: None,
            },
            PaneListEntry {
                pane_info: PaneInfo {
                    id: 42,
                    is_selectable: true,
                    ..Default::default()
                },
                tab_id: 23,
                tab_position: 1,
                tab_name: "second".into(),
                pane_command: None,
                pane_cwd: None,
            },
        ];
        let pending = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut metadata = RecoveryMetadata::with_pending(Some(pending.clone()));
        assert!(metadata.payload("main", vec![]).is_none());
        assert!(metadata.consume(&[serde_json::to_string(&vec![first, second.clone()]).unwrap()]));
        assert!(metadata.consume(&[serde_json::to_string(&panes).unwrap()]));
        assert!(metadata.payload("main", vec![]).is_none());
        assert!(metadata.consume(&[serde_json::to_string(&second).unwrap()]));
        assert!(
            !pending.load(std::sync::atomic::Ordering::Acquire),
            "Exact current-tab response acknowledges the query batch"
        );
        let payload = metadata.payload("main", vec![]).unwrap();
        assert_eq!(payload.active_pane.unwrap().pane_id, 42);
        assert!(!payload.tabs[0].active);
        assert!(payload.tabs[1].active);
        assert_eq!(
            payload
                .panes
                .iter()
                .map(|pane| pane.pane_id)
                .collect::<Vec<_>>(),
            vec![31, 42]
        );
        assert!(
            payload.tab_viewport.is_none(),
            "Recovery does not claim unavailable web viewport ownership"
        );
        assert!(!metadata.consume(&["ordinary server log".into()]));
    }

    #[test]
    fn dropping_poll_stops_worker() {
        let poll = RecoveryMetadataPoll::start(|| true, || {});
        let active = poll.active.clone();
        drop(poll);
        assert!(!active.load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn focus_refresh_wakes_idle_poll_and_coalesces_behind_unacknowledged_queries() {
        use std::time::Duration;
        let (sent, batches) = std::sync::mpsc::channel();
        let poll = RecoveryMetadataPoll::start(
            || true,
            move || {
                sent.send(()).unwrap();
            },
        );
        let mut metadata = RecoveryMetadata::with_poll(Some(&poll));
        let current = serde_json::to_string(&zellij_utils::data::TabInfo::default()).unwrap();
        let acknowledge =
            |metadata: &mut RecoveryMetadata| assert!(metadata.consume(&[current.clone()]));
        batches.recv_timeout(Duration::from_secs(1)).unwrap();

        // A focus request during an old batch must wait for its exact current-tab
        // response. A burst stays bounded and then sends one fresh batch promptly.
        for _ in 0..100 {
            poll.refresh().request();
        }
        assert!(batches.recv_timeout(Duration::from_millis(50)).is_err());
        acknowledge(&mut metadata);
        batches
            .recv_timeout(Duration::from_millis(250))
            .expect("Focus refresh must not wait for the one-second poll");
        assert!(batches.recv_timeout(Duration::from_millis(50)).is_err());
        acknowledge(&mut metadata);
        assert!(
            batches.recv_timeout(Duration::from_millis(50)).is_err(),
            "Acknowledgment alone does not speed up background polling"
        );

        poll.refresh().request();
        batches
            .recv_timeout(Duration::from_millis(250))
            .expect("An idle poll wakes immediately for focus");
        drop(poll);
        acknowledge(&mut metadata);
        assert!(
            batches.recv_timeout(Duration::from_millis(100)).is_err(),
            "A dropped attachment stops sending queries"
        );
    }
}
