//! Cross-process admission lock for automatic connection-service updates.
//! Never unlink this file: viewers and the updater must lock the same inode.
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};

pub(crate) fn path(directory: &Path) -> PathBuf {
    std::env::var_os("SWITCHBOARD_VIEWER_LOCK")
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.join("viewers.lock"))
}

fn open(path: &Path) -> std::io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
}

/// Hold before accepting a WebSocket, until its connection task finishes.
pub(crate) fn viewer() -> anyhow::Result<File> {
    let home = std::env::home_dir().ok_or_else(|| anyhow::anyhow!("No home directory"))?;
    viewer_at(&path(
        &home.join(".local/share/switchboard/automatic-updates"),
    ))
}

fn viewer_at(path: &Path) -> anyhow::Result<File> {
    let lock = open(path)?;
    lock.try_lock_shared()?;
    Ok(lock)
}

/// None means a viewer is present. Holding the result prevents new attachments
/// until the replacement services are ready (or rollback has completed).
pub(crate) fn update(path: &Path) -> anyhow::Result<Option<File>> {
    let lock = open(path)?;
    match lock.try_lock() {
        Ok(()) => Ok(Some(lock)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// New viewers have a short admission lock independent of legacy lifetime locks.
/// Explicit activation bypasses legacy viewers, never this admission fence.
pub(crate) fn bootstrap() -> anyhow::Result<Vec<File>> {
    let state = std::env::home_dir()
        .ok_or_else(|| anyhow::anyhow!("No home directory"))?
        .join(".local/share/switchboard/automatic-updates");
    bootstrap_at(&path(&state), &state)
}

fn bootstrap_at(viewers: &Path, state: &Path) -> anyhow::Result<Vec<File>> {
    let mut locks = vec![viewer_at(&viewers.with_extension("attachments-lock"))?];
    // An older updater cannot take the new admission lock. It already publishes
    // this marker for its entire handoff/rollback while holding automatic.lock.
    // A stale marker after a crash is harmless because the OS releases the lock.
    if state.join("handoff.json").exists() {
        locks.push(viewer_at(&state.join("automatic.lock"))?);
    }
    Ok(locks)
}

pub(crate) fn activation(viewers: &Path) -> anyhow::Result<File> {
    let lock = open(&viewers.with_extension("attachments-lock"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(35);
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            },
            Err(error) => return Err(error.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switchboard_viewers_exclude_updates_and_release_on_disconnect() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("viewers.lock");
        let relay = viewer_at(&path).unwrap();
        let web = viewer_at(&path).unwrap();
        assert!(update(&path).unwrap().is_none());
        drop(relay);
        assert!(update(&path).unwrap().is_none());
        drop(web);
        let update = update(&path).unwrap().unwrap();
        assert!(viewer_at(&path).is_err());
        drop(update);
        assert!(viewer_at(&path).is_ok());
    }
    #[test]
    fn switchboard_attachment_admission_blocks_explicit_activation_and_legacy_migration() {
        let dir = tempfile::tempdir().unwrap();
        let viewers = dir.path().join("viewers.lock");
        let legacy = viewer_at(&viewers).unwrap();
        let activation = activation(&viewers).unwrap();
        assert!(bootstrap_at(&viewers, dir.path()).is_err());
        drop(activation);
        drop(legacy);
        let old_update = open(&dir.path().join("automatic.lock")).unwrap();
        old_update.lock().unwrap();
        std::fs::write(dir.path().join("handoff.json"), "{}").unwrap();
        assert!(bootstrap_at(&viewers, dir.path()).is_err());
        drop(old_update);
        assert!(
            bootstrap_at(&viewers, dir.path()).is_ok(),
            "Stale markers cannot block forever"
        );
    }
}
