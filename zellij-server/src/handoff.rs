//! Replaces a running engine with a new one while its terminals keep running.
//! See docs/SWITCHBOARD_TERMINAL_HOST.md.
use crate::os_input_output::ServerOsApi;
use crate::pty::PtyInstruction;
use crate::pty_writer::PtyWriteInstruction;
use crate::screen::ScreenInstruction;
use crate::thread_bus::ThreadSenders;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use zellij_utils::data::WebSharing;
use zellij_utils::input::actions::Action;
use zellij_utils::input::layout::{FloatingPaneLayout, Layout, TiledPaneLayout};
use zellij_utils::pane_size::Size;

/// `zellij pipe --name switchboard-handoff -- <handoff id>` starts a handoff.
/// A pipe needs no change to the protocol that older engines understand.
pub(crate) const PIPE_NAME: &str = "switchboard-handoff";
/// Makes the takeover final, after the updater has verified the new engine.
pub(crate) const COMMIT_PIPE_NAME: &str = "switchboard-handoff-commit";
/// Set for a new engine, to the manifest it should take over from.
const MANIFEST_ENV: &str = "SWITCHBOARD_HANDOFF_MANIFEST";
/// Set for a new engine that must wait for the commit pipe.
const VERIFY_ENV: &str = "SWITCHBOARD_HANDOFF_VERIFY";

const MANIFEST_VERSION: u32 = 1;
const INPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const SETTLE_TIMEOUT: Duration = Duration::from_secs(3);
const FROZEN_WAIT_LIMIT: Duration = Duration::from_secs(30);
/// Time for viewers, which poll for the marker, to stop sending input before
/// the engine starts discarding it.
const VIEWER_INPUT_GRACE: Duration = Duration::from_millis(150);

static FROZEN: AtomicBool = AtomicBool::new(false);
static HANDING_OVER: AtomicBool = AtomicBool::new(false);
static AWAITING_COMMIT: Mutex<Option<String>> = Mutex::new(None);

/// What the updater needs while it verifies a new engine; nothing else may
/// change a session in that state.
pub(crate) fn allowed_while_frozen(action: &Action) -> bool {
    match action {
        Action::ListPanes { .. } => true,
        Action::CliPipe {
            name: Some(name), ..
        } => name == COMMIT_PIPE_NAME,
        _ => false,
    }
}

/// Records which host this session uses and how to go back to this engine.
pub(crate) fn record_session(directory: &Path) {
    let recorded = zellij_utils::envs::get_session_name()
        .map_err(|error| error.to_string())
        .and_then(|session| {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let record = zellij_utils::handoff::SessionRecord {
                host_directory: directory.to_path_buf(),
                engine: env!("SWITCHBOARD_ENGINE_FINGERPRINT").to_string(),
                executable,
            };
            zellij_utils::handoff::write_session_record(&session, &record)
                .map_err(|error| error.to_string())
        });
    if let Err(error) = recorded {
        log::error!("Cannot record this session's terminal host: {error}");
    }
}

/// Lets the updater stop this engine if it fails verification.
pub(crate) fn record_engine_pid(directory: &Path, handoff_id: &str) -> std::io::Result<()> {
    fs::write(
        directory.join("handoff").join(format!("{handoff_id}.pid")),
        std::process::id().to_string(),
    )
}

/// Whether the updater will verify this engine before it becomes final.
pub(crate) fn hold_for_verification(handoff_id: &str) -> bool {
    if std::env::var_os(VERIFY_ENV).is_none() {
        return false;
    }
    *AWAITING_COMMIT.lock().unwrap() = Some(handoff_id.to_string());
    true
}

/// Admits clients and makes this engine the one that owns the terminals.
pub(crate) fn commit(os_input: &dyn ServerOsApi, senders: &ThreadSenders) -> Result<(), String> {
    let handoff_id = AWAITING_COMMIT
        .lock()
        .unwrap()
        .take()
        .ok_or("no takeover is waiting to be committed")?;
    let hosted = os_input
        .terminal_host()
        .ok_or("this session has no terminal host")?;
    hosted
        .commit_adoption(&handoff_id)
        .map_err(|error| format!("{error:#}"))?;
    hosted.release_exits();
    senders
        .send_to_screen(ScreenInstruction::EndHandoffAdoption)
        .map_err(|error| format!("{error:#}"))
}

/// While frozen, clients cannot change what is being snapshotted.
pub(crate) fn is_frozen() -> bool {
    FROZEN.load(Ordering::SeqCst)
}

/// A new engine stays frozen until every pane has its snapshot.
pub(crate) fn freeze_if_taking_over() {
    if std::env::var_os(MANIFEST_ENV).is_some() {
        FROZEN.store(true, Ordering::SeqCst);
    }
}

pub(crate) fn unfreeze() {
    if let Ok(session) = zellij_utils::envs::get_session_name() {
        zellij_utils::handoff::clear(&session);
    }
    FROZEN.store(false, Ordering::SeqCst);
}

/// Holds a new viewer back until the session can accept it. An engine that
/// hands over exits, which ends the wait by closing the connection. Returns
/// whether the session can accept the viewer.
pub(crate) fn wait_while_frozen() -> bool {
    let deadline = std::time::Instant::now() + FROZEN_WAIT_LIMIT;
    while is_frozen() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    !is_frozen()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffTerminal {
    pub snapshot: String,
    pub pid: Option<u32>,
    /// The output position the snapshot describes. Held panes have none.
    pub position: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffTab {
    pub id: usize,
    pub name: String,
    /// Tabs can have different sizes, and snapshots describe this one.
    pub size: Size,
    pub tiled: TiledPaneLayout,
    pub floating: Vec<FloatingPaneLayout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandoffManifest {
    pub version: u32,
    pub id: String,
    pub size: Size,
    pub focused_tab_index: usize,
    pub next_tab_id: usize,
    pub next_terminal_id: u32,
    pub tabs: Vec<HandoffTab>,
    pub terminals: BTreeMap<u32, HandoffTerminal>,
    /// Sharing can be changed at runtime, away from what the configuration says.
    #[serde(default)]
    pub web_sharing: Option<WebSharing>,
}

/// What Screen knows about the session once every pane has settled.
#[derive(Debug, Clone)]
pub struct ScreenHandoff {
    pub size: Size,
    pub focused_tab_index: usize,
    pub next_tab_id: usize,
    pub tabs: Vec<HandoffTab>,
    /// Terminal ID, its snapshot, and whether a child is running in it.
    pub terminals: BTreeMap<u32, (String, bool)>,
}

impl HandoffManifest {
    pub fn into_layout(&self) -> Layout {
        Layout {
            tabs: self
                .tabs
                .iter()
                .map(|tab| {
                    (
                        Some(tab.name.clone()),
                        tab.tiled.clone(),
                        tab.floating.clone(),
                    )
                })
                .collect(),
            focused_tab_index: Some(self.focused_tab_index),
            ..Default::default()
        }
    }
}

/// The manifest this engine was started to take over from, and the terminal
/// host it belongs to.
pub(crate) fn requested_manifest() -> Option<Result<(HandoffManifest, PathBuf), String>> {
    let path = PathBuf::from(std::env::var_os(MANIFEST_ENV)?);
    Some(read_manifest(&path))
}

fn read_manifest(path: &Path) -> Result<(HandoffManifest, PathBuf), String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
    let manifest: HandoffManifest =
        serde_json::from_str(&text).map_err(|error| format!("invalid manifest: {error}"))?;
    if manifest.version != MANIFEST_VERSION {
        return Err(format!("unsupported manifest {}", manifest.version));
    }
    let directory = path
        .parent()
        .and_then(Path::parent)
        .ok_or("the manifest is not in a host directory")?
        .to_path_buf();
    Ok((manifest, directory))
}

fn write_manifest(directory: &Path, manifest: &HandoffManifest) -> Result<PathBuf, String> {
    let describe = |error: std::io::Error| format!("cannot write the manifest: {error}");
    let folder = directory.join("handoff");
    fs::create_dir_all(&folder).map_err(describe)?;
    let path = folder.join(format!("{}.json", manifest.id));
    let partial = folder.join(format!("{}.partial", manifest.id));
    let text = serde_json::to_string(manifest).map_err(|error| error.to_string())?;
    fs::write(&partial, text).map_err(describe)?;
    fs::rename(&partial, &path).map_err(describe)?;
    Ok(path)
}

/// Rejects anything that could become a path outside the host directory.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn flush_writes(senders: &ThreadSenders) -> Result<(), String> {
    let (done, finished) = mpsc::channel();
    senders
        .send_to_pty_writer(PtyWriteInstruction::Flush(done))
        .map_err(|error| format!("{error:#}"))?;
    finished
        .recv_timeout(INPUT_DRAIN_TIMEOUT)
        .map_err(|_| "typed input did not reach its terminal in time".to_string())
}

/// Prepares this session for a new engine. On success the engine must exit
/// without touching its terminals; on failure the session carries on.
pub(crate) fn hand_over(
    os_input: &dyn ServerOsApi,
    senders: &ThreadSenders,
    handoff_id: &str,
    web_sharing: WebSharing,
) -> Result<(), String> {
    if !valid_id(handoff_id) {
        return Err(format!("invalid handoff id {handoff_id:?}"));
    }
    let hosted = os_input
        .terminal_host()
        .ok_or("this session has no terminal host")?;
    if HANDING_OVER.swap(true, Ordering::SeqCst) {
        return Err("a handoff is already in progress".to_string());
    }
    let marked = zellij_utils::envs::get_session_name()
        .map_err(|error| error.to_string())
        .and_then(|session| {
            zellij_utils::handoff::mark(&session).map_err(|error| error.to_string())
        });
    if let Err(error) = marked {
        HANDING_OVER.store(false, Ordering::SeqCst);
        return Err(format!("cannot mark the handoff: {error}"));
    }
    std::thread::sleep(VIEWER_INPUT_GRACE);
    FROZEN.store(true, Ordering::SeqCst);
    hosted.hold_exits();
    let prepared = (|| {
        flush_writes(senders)?;
        let ends = hosted
            .pause_output(SETTLE_TIMEOUT)
            .map_err(|error| format!("{error:#}"))?;
        if !hosted.wait_until_delivered(&ends, SETTLE_TIMEOUT) {
            return Err("output did not reach the screen in time".to_string());
        }
        let (reply, screen) = mpsc::channel();
        senders
            .send_to_screen(ScreenInstruction::PrepareHandoff(reply))
            .map_err(|error| format!("{error:#}"))?;
        let screen = screen
            .recv_timeout(SETTLE_TIMEOUT)
            .map_err(|_| "the screen did not settle in time".to_string())??;
        // Settling can answer queries, whose replies go to the programs.
        flush_writes(senders)?;
        let (reply, pids) = mpsc::channel();
        senders
            .send_to_pty(PtyInstruction::HandoffPids(reply))
            .map_err(|error| format!("{error:#}"))?;
        let pids: HashMap<u32, u32> = pids
            .recv_timeout(SETTLE_TIMEOUT)
            .map_err(|_| "the terminal list did not arrive in time".to_string())?;
        let mut terminals = BTreeMap::new();
        for (id, (snapshot, running)) in screen.terminals {
            let position = if running {
                Some(
                    hosted
                        .resume_position(id)
                        .ok_or_else(|| format!("terminal {id} cannot be resumed at this moment"))?,
                )
            } else {
                None
            };
            let pid = pids.get(&id).copied();
            terminals.insert(
                id,
                HandoffTerminal {
                    snapshot,
                    pid,
                    position,
                },
            );
        }
        let manifest = HandoffManifest {
            version: MANIFEST_VERSION,
            id: handoff_id.to_string(),
            size: screen.size,
            focused_tab_index: screen.focused_tab_index,
            next_tab_id: screen.next_tab_id,
            next_terminal_id: terminals
                .keys()
                .last()
                .map_or(0, |id| id + 1)
                .max(hosted_next_id(os_input)),
            tabs: screen.tabs,
            terminals,
            web_sharing: Some(web_sharing),
        };
        let directory = hosted
            .directory()
            .ok_or("the terminal host has no directory")?;
        write_manifest(directory, &manifest)?;
        let retain_from = manifest
            .terminals
            .iter()
            .filter_map(|(id, terminal)| Some((*id, terminal.position?)))
            .collect();
        hosted
            .begin_handoff(handoff_id, retain_from)
            .map_err(|error| format!("{error:#}"))
    })();
    if prepared.is_err() {
        let _ = hosted.resume_output();
        hosted.release_exits();
        unfreeze();
        HANDING_OVER.store(false, Ordering::SeqCst);
        return prepared;
    }
    hosted.detach();
    Ok(())
}

/// Reserving an ID shows how far allocation has reached, including IDs of
/// panes that have since closed. The one consumed here is never used.
fn hosted_next_id(os_input: &dyn ServerOsApi) -> u32 {
    os_input
        .reserve_terminal_id()
        .map(|id| {
            let _ = os_input.clear_terminal_id(id);
            id + 1
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_id_cannot_leave_the_handoff_folder() {
        assert!(valid_id("update-1_a"));
        for id in ["", "../escape", "a/b", "a\\b", "a.b", &"x".repeat(65)] {
            assert!(!valid_id(id), "{id:?} was accepted");
        }
    }

    #[test]
    fn a_manifest_round_trips_through_its_host_directory() {
        let directory = tempfile::tempdir().unwrap();
        let manifest = HandoffManifest {
            version: MANIFEST_VERSION,
            id: "h1".to_string(),
            size: Size { rows: 24, cols: 80 },
            focused_tab_index: 0,
            next_tab_id: 8,
            next_terminal_id: 12,
            tabs: vec![HandoffTab {
                id: 7,
                name: "Tab #8".to_string(),
                size: Size { rows: 10, cols: 40 },
                tiled: TiledPaneLayout::default(),
                floating: Vec::new(),
            }],
            terminals: BTreeMap::from([(
                11,
                HandoffTerminal {
                    snapshot: "screen\u{1b}[m".to_string(),
                    pid: Some(42),
                    position: Some(1234),
                },
            )]),
            web_sharing: Some(WebSharing::Off),
        };
        let path = write_manifest(directory.path(), &manifest).unwrap();
        let (read, host_directory) = read_manifest(&path).unwrap();
        assert_eq!(host_directory, directory.path());
        assert_eq!(read.next_tab_id, 8);
        assert_eq!(read.tabs[0].id, 7);
        assert_eq!(read.terminals[&11].position, Some(1234));
        assert_eq!(read.terminals[&11].snapshot, "screen\u{1b}[m");
        assert_eq!(read.into_layout().tabs.len(), 1);
    }

    #[test]
    fn a_manifest_from_a_newer_engine_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let mut manifest = serde_json::json!({"version": MANIFEST_VERSION + 1});
        manifest["id"] = "h1".into();
        let folder = directory.path().join("handoff");
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("h1.json");
        fs::write(&path, manifest.to_string()).unwrap();
        assert!(read_manifest(&path).is_err());
    }
}
