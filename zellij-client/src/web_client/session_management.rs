use crate::os_input_output::ClientOsApi;
use crate::spawn_server;

use std::{
    fs,
    path::{Path, PathBuf},
};
use zellij_utils::{
    consts::session_layout_cache_file_name,
    data::{ConnectToSession, LayoutInfo, LayoutMetadata, WebSharing},
    envs,
    input::{cli_assets::CliAssets, config::Config, layout::Layout, options::Options},
    ipc::{ClientAttributes, ClientToServerMsg},
    sessions::generate_unique_session_name,
};

// The engine falls back to a fresh default layout when the saved one cannot
// load, and its next save replaces the only copy of the old tabs. Check the
// save here with the engine's loader and move an unreadable one aside.
fn restorable_layout(saved_layout: &Path) -> Option<LayoutInfo> {
    if !saved_layout.is_file() {
        return None;
    }
    let layout_info = LayoutInfo::File(
        saved_layout.display().to_string(),
        LayoutMetadata::default(),
    );
    let error = match Layout::from_layout_info_with_config(
        &None,
        &layout_info,
        Some(Config::from_default_assets().unwrap_or_default()),
    ) {
        Ok(_) => return Some(layout_info),
        Err(error) => error,
    };
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let kept = saved_layout.with_file_name(format!("session-layout.unreadable-{seconds}.kdl"));
    match fs::rename(saved_layout, &kept) {
        Ok(()) => log::error!(
            "Cannot restore saved layout {}: {error}. Kept it as {} and started a new session.",
            saved_layout.display(),
            kept.display()
        ),
        Err(rename_error) => log::error!(
            "Cannot restore saved layout {}: {error}. Cannot keep a copy: {rename_error}",
            saved_layout.display()
        ),
    }
    None
}

pub fn build_initial_connection(
    session_name: Option<String>,
    is_welcome_session: bool,
    config: &Config,
) -> Result<Option<ConnectToSession>, &'static str> {
    let default_layout_from_config =
        LayoutInfo::from_config(&config.options.layout_dir, &config.options.default_layout);
    if is_welcome_session {
        let Some(initial_session_name) = session_name.clone().or_else(generate_unique_session_name)
        else {
            return Err("Failed to generate unique session name, bailing.");
        };
        Ok(Some(ConnectToSession {
            name: Some(initial_session_name.clone()),
            layout: Some(LayoutInfo::BuiltIn("welcome".to_owned())),
            ..Default::default()
        }))
    } else if let Some(session_name) = session_name {
        Ok(Some(ConnectToSession {
            name: Some(session_name.clone()),
            layout: default_layout_from_config,
            ..Default::default()
        }))
    } else if default_layout_from_config.is_some() {
        Ok(Some(ConnectToSession {
            layout: default_layout_from_config,
            ..Default::default()
        }))
    } else {
        Ok(None)
    }
}

pub fn spawn_new_session(
    session_name: &str,
    mut os_input: Box<dyn ClientOsApi>,
    zellij_ipc_pipe: &PathBuf,
) {
    let debug = false;
    envs::set_session_name(session_name.to_owned());
    os_input.update_session_name(session_name.to_owned());
    spawn_server(&*zellij_ipc_pipe, debug).unwrap();
}

pub fn create_first_message(
    is_read_only: bool,
    config_file_path: Option<PathBuf>,
    client_attributes: ClientAttributes,
    mut config_opts: Options,
    should_create_session: bool,
    session_name: &str,
    initial_layout: Option<LayoutInfo>,
) -> ClientToServerMsg {
    let resurrection_layout = if should_create_session && !is_read_only {
        restorable_layout(&session_layout_cache_file_name(session_name))
    } else {
        None
    };

    let layout_info = if resurrection_layout.is_some() {
        resurrection_layout
    } else {
        initial_layout
    };

    config_opts.web_server = Some(true);
    config_opts.web_sharing = Some(WebSharing::On);

    let is_web_client = true;
    if is_read_only {
        // read only clients attach as watchers
        ClientToServerMsg::AttachWatcherClient {
            terminal_size: client_attributes.size,
            is_web_client,
        }
    } else if should_create_session {
        config_opts.web_server = Some(true);
        config_opts.web_sharing = Some(WebSharing::On);
        let cli_assets = CliAssets {
            config_file_path,
            config_dir: None,
            should_ignore_config: false,
            configuration_options: Some(config_opts),
            layout: layout_info,
            terminal_window_size: client_attributes.size,
            data_dir: None,
            is_debug: false,
            max_panes: None,
            force_run_layout_commands: false,
            cwd: None,
            host_terminal_env: Default::default(),
            initial_panes: None,
        };

        ClientToServerMsg::FirstClientConnected {
            cli_assets,
            is_web_client,
        }
    } else {
        let cli_assets = CliAssets {
            config_file_path,
            config_dir: None,
            should_ignore_config: false,
            configuration_options: Some(config_opts),
            layout: None,
            terminal_window_size: client_attributes.size,
            data_dir: None,
            is_debug: false,
            max_panes: None,
            force_run_layout_commands: false,
            cwd: None,
            host_terminal_env: Default::default(),
            initial_panes: None,
        };
        let is_web_client = true;

        ClientToServerMsg::AttachClient {
            cli_assets,
            tab_position_to_focus: None,
            pane_to_focus: None,
            is_web_client,
        }
    }
}

pub fn create_ipc_pipe(session_name: &str) -> PathBuf {
    if let Err(e) = zellij_utils::sessions::validate_session_name(session_name) {
        log::error!("Invalid session name: {}", e);
        panic!("Invalid session name: {}", e);
    }
    let zellij_ipc_pipe: PathBuf = {
        let sock_dir = &*zellij_utils::consts::ZELLIJ_SOCK_DIR;
        fs::create_dir_all(sock_dir).unwrap();
        zellij_utils::shared::set_permissions(sock_dir, 0o700).unwrap();
        zellij_utils::consts::session_socket_path(session_name)
    };
    crate::check_ipc_pipe_length(&zellij_ipc_pipe);
    zellij_ipc_pipe
}

#[cfg(test)]
mod restart_tests {
    use super::*;

    #[test]
    fn restart_restores_a_readable_save_and_keeps_an_unreadable_one() {
        let directory = tempfile::tempdir().unwrap();
        let saved = directory.path().join("session-layout.kdl");
        assert!(restorable_layout(&saved).is_none(), "No save, new session");

        fs::write(&saved, "layout {\n tab name=\"Fix startup\" { pane; }\n}\n").unwrap();
        assert!(
            matches!(restorable_layout(&saved), Some(LayoutInfo::File(path, _)) if Path::new(&path) == saved)
        );

        fs::write(&saved, "layout { corrupt").unwrap();
        assert!(restorable_layout(&saved).is_none());
        assert!(
            !saved.exists(),
            "The new session cannot replace the unreadable save"
        );
        let kept: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(kept.len(), 1);
        assert!(kept[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("session-layout.unreadable-"));
        assert_eq!(fs::read_to_string(&kept[0]).unwrap(), "layout { corrupt");
    }
}
