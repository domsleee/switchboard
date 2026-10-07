//! Zellij program-wide constants.

use crate::home::find_default_config_dir;
use directories::ProjectDirs;
use include_dir::{include_dir, Dir};
use std::{
    path::PathBuf,
    sync::{LazyLock, OnceLock},
};

pub const ZELLIJ_CONFIG_FILE_ENV: &str = "ZELLIJ_CONFIG_FILE";
pub const ZELLIJ_CONFIG_DIR_ENV: &str = "ZELLIJ_CONFIG_DIR";
pub const ZELLIJ_LAYOUT_DIR_ENV: &str = "ZELLIJ_LAYOUT_DIR";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_SCROLL_BUFFER_SIZE: usize = 10_000;
pub static SCROLL_BUFFER_SIZE: OnceLock<usize> = OnceLock::new();
pub static DEBUG_MODE: OnceLock<bool> = OnceLock::new();

#[cfg(not(windows))]
pub const SYSTEM_DEFAULT_CONFIG_DIR: &str = "/etc/zellij";
#[cfg(windows)]
pub const SYSTEM_DEFAULT_CONFIG_DIR: &str = "C:\\ProgramData\\Zellij";
pub const SYSTEM_DEFAULT_DATA_DIR_PREFIX: &str = system_default_data_dir();

pub static ZELLIJ_DEFAULT_THEMES: Dir = include_dir!("$CARGO_MANIFEST_DIR/assets/themes");

pub const CLIENT_SERVER_CONTRACT_VERSION: usize = 1;

pub fn session_info_cache_file_name(session_name: &str) -> PathBuf {
    session_info_folder_for_session(session_name).join("session-metadata.kdl")
}

pub fn session_layout_cache_file_name(session_name: &str) -> PathBuf {
    session_info_folder_for_session(session_name).join("session-layout.kdl")
}

pub fn session_info_folder_for_session(session_name: &str) -> PathBuf {
    ZELLIJ_SESSION_INFO_CACHE_DIR.join(session_name)
}

pub fn create_config_and_cache_folders() {
    if let Err(e) = std::fs::create_dir_all(&ZELLIJ_CACHE_DIR.as_path()) {
        log::error!("Failed to create cache dir: {:?}", e);
    }
    if let Some(config_dir) = find_default_config_dir() {
        if let Err(e) = std::fs::create_dir_all(&config_dir.as_path()) {
            log::error!("Failed to create config dir: {:?}", e);
        }
    }
    // while session_info is a child of cache currently, it won't necessarily always be this way,
    // and so it's explicitly created here
    if let Err(e) = std::fs::create_dir_all(&ZELLIJ_SESSION_INFO_CACHE_DIR.as_path()) {
        log::error!("Failed to create session_info cache dir: {:?}", e);
    }
    prune_empty_session_info_folders();
}

fn prune_empty_session_info_folders() {
    let Ok(entries) = std::fs::read_dir(&*ZELLIJ_SESSION_INFO_CACHE_DIR) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let is_empty = std::fs::read_dir(&path)
            .ok()
            .map_or(false, |mut iter| iter.next().is_none());
        if is_empty {
            if let Err(e) = std::fs::remove_dir(&path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::debug!("Failed to prune empty session folder {:?}: {:?}", path, e);
                }
            }
        }
    }
}

const fn system_default_data_dir() -> &'static str {
    if let Some(data_dir) = std::option_env!("PREFIX") {
        data_dir
    } else if cfg!(windows) {
        "C:\\ProgramData\\Zellij"
    } else {
        "/usr"
    }
}

pub static CLIENT_SERVER_CONTRACT_DIR: LazyLock<String> =
    LazyLock::new(|| format!("contract_version_{}", CLIENT_SERVER_CONTRACT_VERSION));
pub static ZELLIJ_PROJ_DIR: LazyLock<ProjectDirs> = LazyLock::new(|| {
    if cfg!(windows) {
        ProjectDirs::from("", "", "Zellij").unwrap()
    } else {
        ProjectDirs::from("org", "Zellij Contributors", "Zellij").unwrap()
    }
});
pub static ZELLIJ_CACHE_DIR: LazyLock<PathBuf> =
    LazyLock::new(|| ZELLIJ_PROJ_DIR.cache_dir().to_path_buf());
pub static ZELLIJ_SESSION_INFO_CACHE_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
    ZELLIJ_CACHE_DIR
        .join(CLIENT_SERVER_CONTRACT_DIR.clone())
        .join("session_info")
});

pub const FEATURES: &[&str] = &[];

pub const BUILTIN_PLUGIN_NAMES: &[&str] = &[
    "compact-bar",
    "status-bar",
    "tab-bar",
    "strider",
    "session-manager",
    "configuration",
    "plugin-manager",
    "about",
    "share",
    "multiple-select",
    "layout-manager",
    "link",
];

#[cfg(unix)]
pub fn is_ipc_socket(file_type: &std::fs::FileType) -> bool {
    use std::os::unix::fs::FileTypeExt;
    file_type.is_socket()
}

#[cfg(not(unix))]
pub fn is_ipc_socket(file_type: &std::fs::FileType) -> bool {
    file_type.is_file()
}

#[cfg(unix)]
pub fn ipc_connect(path: &std::path::Path) -> std::io::Result<interprocess::local_socket::Stream> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, Stream as LocalSocketStream};
    let fs_name = path.to_fs_name::<GenericFilePath>()?;
    LocalSocketStream::connect(fs_name)
}

#[cfg(windows)]
pub fn ipc_connect(path: &std::path::Path) -> std::io::Result<interprocess::local_socket::Stream> {
    use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream as LocalSocketStream};
    let name = path.to_string_lossy().to_string();
    let ns_name = name.to_ns_name::<GenericNamespaced>()?;
    LocalSocketStream::connect(ns_name)
}

#[cfg(unix)]
pub fn ipc_bind(path: &std::path::Path) -> std::io::Result<interprocess::local_socket::Listener> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let fs_name = path.to_fs_name::<GenericFilePath>()?;
    ListenerOptions::new().name(fs_name).create_sync()
}

#[cfg(windows)]
pub fn ipc_bind(path: &std::path::Path) -> std::io::Result<interprocess::local_socket::Listener> {
    use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
    let name = path.to_string_lossy().to_string();
    let ns_name = name.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(ns_name).create_sync()?;
    std::fs::write(path, std::process::id().to_string())?;
    Ok(listener)
}

#[cfg(unix)]
pub fn ipc_bind_async(
    path: &std::path::Path,
) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let fs_name = path.to_fs_name::<GenericFilePath>()?;
    ListenerOptions::new().name(fs_name).create_tokio()
}

#[cfg(windows)]
pub fn ipc_bind_async(
    path: &std::path::Path,
) -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
    let name = path.to_string_lossy().to_string();
    let ns_name = name.to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(ns_name).create_tokio()?;
    std::fs::write(path, std::process::id().to_string())?;
    Ok(listener)
}

#[cfg(windows)]
pub fn ipc_connect_reply(
    path: &std::path::Path,
) -> std::io::Result<interprocess::local_socket::Stream> {
    use interprocess::local_socket::{prelude::*, GenericNamespaced, Stream as LocalSocketStream};
    let name = format!("{}-reply", path.to_string_lossy());
    let ns_name = name.to_ns_name::<GenericNamespaced>()?;
    LocalSocketStream::connect(ns_name)
}

#[cfg(windows)]
pub fn ipc_bind_reply(
    path: &std::path::Path,
) -> std::io::Result<interprocess::local_socket::Listener> {
    use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
    let name = format!("{}-reply", path.to_string_lossy());
    let ns_name = name.to_ns_name::<GenericNamespaced>()?;
    ListenerOptions::new().name(ns_name).create_sync()
}

#[cfg(unix)]
pub use unix_only::*;

#[cfg(unix)]
mod unix_only {
    use super::*;
    use crate::envs;
    pub use crate::shared::set_permissions;
    use nix::unistd::Uid;
    use std::env::temp_dir;

    // Maximum sockaddr_un.sun_path length: 104 on macOS/BSD, 108 on Linux/Android/Solaris.
    #[cfg(target_os = "macos")]
    pub const ZELLIJ_SOCK_MAX_LENGTH: usize = 104;
    #[cfg(not(target_os = "macos"))]
    pub const ZELLIJ_SOCK_MAX_LENGTH: usize = 108;

    static UID: LazyLock<Uid> = LazyLock::new(|| Uid::current());
    pub static ZELLIJ_TMP_DIR: LazyLock<PathBuf> =
        LazyLock::new(|| temp_dir().join(format!("zellij-{}", *UID)));
    pub static ZELLIJ_TMP_LOG_DIR: LazyLock<PathBuf> =
        LazyLock::new(|| ZELLIJ_TMP_DIR.join("zellij-log"));
    pub static ZELLIJ_TMP_LOG_FILE: LazyLock<PathBuf> =
        LazyLock::new(|| ZELLIJ_TMP_LOG_DIR.join("zellij.log"));
    pub static ZELLIJ_SOCK_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
        let mut ipc_dir = envs::get_socket_dir().map_or_else(
            |_| {
                ZELLIJ_PROJ_DIR
                    .runtime_dir()
                    .map_or_else(|| ZELLIJ_TMP_DIR.clone(), |p| p.to_owned())
            },
            PathBuf::from,
        );
        ipc_dir.push(CLIENT_SERVER_CONTRACT_DIR.clone());
        ipc_dir
    });
    pub static WEBSERVER_SOCKET_PATH: LazyLock<PathBuf> =
        LazyLock::new(|| ZELLIJ_SOCK_DIR.join("web_server_bus"));
}

#[cfg(not(unix))]
pub use not_unix::*;

#[cfg(not(unix))]
mod not_unix {
    use super::*;
    use crate::envs;
    pub use crate::shared::set_permissions;
    #[cfg(windows)]
    use dunce;
    use std::env::temp_dir;

    #[cfg(windows)]
    fn canonicalize_path(path: PathBuf) -> PathBuf {
        dunce::canonicalize(&path).unwrap_or(path)
    }

    #[cfg(not(windows))]
    fn canonicalize_path(path: PathBuf) -> PathBuf {
        path
    }

    pub const ZELLIJ_SOCK_MAX_LENGTH: usize = 256;

    pub static ZELLIJ_TMP_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
        let tmp_dir = canonicalize_path(temp_dir());
        tmp_dir.join("zellij")
    });
    pub static ZELLIJ_TMP_LOG_DIR: LazyLock<PathBuf> =
        LazyLock::new(|| ZELLIJ_TMP_DIR.join("zellij-log"));
    pub static ZELLIJ_TMP_LOG_FILE: LazyLock<PathBuf> =
        LazyLock::new(|| ZELLIJ_TMP_LOG_DIR.join("zellij.log"));
    pub static ZELLIJ_SOCK_DIR: LazyLock<PathBuf> = LazyLock::new(|| {
        let mut ipc_dir = canonicalize_path(envs::get_socket_dir().map_or_else(
            |_| {
                ZELLIJ_PROJ_DIR
                    .runtime_dir()
                    .map_or_else(|| ZELLIJ_TMP_DIR.clone(), |p| p.to_owned())
            },
            PathBuf::from,
        ));
        ipc_dir.push(CLIENT_SERVER_CONTRACT_DIR.clone());
        ipc_dir
    });
    pub static WEBSERVER_SOCKET_PATH: LazyLock<PathBuf> =
        LazyLock::new(|| ZELLIJ_SOCK_DIR.join("web_server_bus"));
}
