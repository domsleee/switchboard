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
}
