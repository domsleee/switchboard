use super::*;
use std::io::Write;
#[cfg(windows)]
#[path = "storage_windows.rs"]
mod windows;

pub(in crate::switchboard_relay) struct Storage {
    pub root: std::path::PathBuf,
    _lock: std::fs::File,
}
impl Storage {
    pub fn open(root: &Path) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !root.components().any(|c| c.as_os_str() == "artifacts"),
            "Mesh credentials must be outside artifacts"
        );
        std::fs::create_dir_all(root)?;
        anyhow::ensure!(
            !std::fs::symlink_metadata(root)?.file_type().is_symlink(),
            "Mesh directory must not be a symlink"
        );
        anyhow::ensure!(
            !std::fs::canonicalize(root)?
                .components()
                .any(|c| c.as_os_str() == "artifacts"),
            "Mesh credentials must be outside artifacts"
        );
        if let Ok(metadata) = std::fs::symlink_metadata(root.join("lock")) {
            anyhow::ensure!(
                !metadata.file_type().is_symlink(),
                "Mesh lock must not be a symlink"
            );
        }
        private(root, true)?;
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("lock"))?;
        lock.try_lock()
            .map_err(|_| anyhow::anyhow!("Mesh state is already in use"))?;
        private(&root.join("lock"), false)?;
        Ok(Self {
            root: root.to_owned(),
            _lock: lock,
        })
    }
    pub fn read<T: serde::de::DeserializeOwned>(&self, name: &str) -> anyhow::Result<Option<T>> {
        let path = self.root.join(name);
        if !path.exists() {
            return Ok(None);
        }
        anyhow::ensure!(
            !std::fs::symlink_metadata(&path)?.file_type().is_symlink(),
            "Mesh file must not be a symlink"
        );
        private(&path, false)?;
        Ok(Some(serde_json::from_slice(&std::fs::read(path)?)?))
    }
    pub fn write<T: Serialize>(&self, name: &str, value: &T) -> anyhow::Result<()> {
        self.bytes(name, &serde_json::to_vec(value)?)
    }
    pub fn bytes(&self, name: &str, bytes: &[u8]) -> anyhow::Result<()> {
        anyhow::ensure!(!name.contains(['/', '\\']), "Invalid mesh filename");
        let mut temp = tempfile::NamedTempFile::new_in(&self.root)?;
        private(temp.path(), false)?;
        temp.write_all(bytes)?;
        temp.as_file().sync_all()?;
        temp.persist(self.root.join(name))?;
        #[cfg(unix)]
        std::fs::File::open(&self.root)?.sync_all()?;
        Ok(())
    }
}
fn private(path: &Path, directory: bool) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        windows::private(path, directory)?;
    }
    Ok(())
}
