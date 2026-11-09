//! Marks a session as moving between engines. While its old engine exits and
//! its new one starts, the session socket does not exist, so without this a
//! reconnecting viewer would create a new session in its place.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const ROOT_OVERRIDE: &str = "SWITCHBOARD_TERMINAL_HOST_ROOT";
/// An engine that died mid-handoff must not hold its session's name forever.
const STALE_AFTER: Duration = Duration::from_secs(10 * 60);
const NEW_ENGINE_WAIT: Duration = Duration::from_secs(60);

/// Where terminal hosts keep their directories.
pub fn hosts_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os(ROOT_OVERRIDE) {
        return Some(root.into());
    }
    #[allow(deprecated)]
    let home = std::env::home_dir()?;
    Some(home.join(".local/share/switchboard/terminal-hosts"))
}

fn marker(session: &str) -> Option<PathBuf> {
    Some(hosts_root()?.join("in-progress").join(session))
}

pub fn mark(session: &str) -> io::Result<()> {
    let path = marker(session)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    fs::write(path, [])
}

pub fn clear(session: &str) {
    if let Some(path) = marker(session) {
        let _ = fs::remove_file(path);
    }
}

pub fn in_progress(session: &str) -> bool {
    marker(session)
        .and_then(|path| fs::metadata(path).ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age < STALE_AFTER)
}

/// Whether a move has not finished, however long ago it started. Only a commit
/// or a failed handover clears the marker.
pub fn marked(session: &str) -> bool {
    marker(session).is_some_and(|path| path.exists())
}

/// What the updater needs to know to move a session to a new engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionRecord {
    pub host_directory: PathBuf,
    /// The fingerprint of the running engine's build inputs.
    pub engine: String,
    /// The executable to go back to if a new engine fails.
    pub executable: PathBuf,
}

fn record_path(session: &str) -> Option<PathBuf> {
    Some(
        hosts_root()?
            .join("sessions")
            .join(format!("{session}.json")),
    )
}

pub fn write_session_record(session: &str, record: &SessionRecord) -> io::Result<()> {
    let path = record_path(session)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)?;
    }
    let partial = path.with_extension("partial");
    fs::write(&partial, serde_json::to_vec(record)?)?;
    fs::rename(partial, path)
}

pub fn read_session_record(session: &str) -> Option<SessionRecord> {
    serde_json::from_slice(&fs::read(record_path(session)?).ok()?).ok()
}

pub fn remove_session_record(session: &str) {
    if let Some(path) = record_path(session) {
        let _ = fs::remove_file(path);
    }
}

/// Every session that has recorded a terminal host.
pub fn session_records() -> Vec<(String, SessionRecord)> {
    let Some(folder) = hosts_root().map(|root| root.join("sessions")) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "json" {
                return None;
            }
            let session = path.file_stem()?.to_string_lossy().into_owned();
            let record = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            Some((session, record))
        })
        .collect()
}

/// Waits for the new engine to open the session. Attaching before then would
/// create a new session in its place.
pub fn wait_for_new_engine(mut session_exists: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + NEW_ENGINE_WAIT;
    while Instant::now() < deadline {
        if session_exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}
