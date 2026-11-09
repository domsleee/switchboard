//! Marks a session as moving between engines. While its old engine exits and
//! its new one starts, the session socket does not exist, so without this a
//! reconnecting viewer would create a new session in its place.
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
