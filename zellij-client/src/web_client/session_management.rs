use crate::os_input_output::ClientOsApi;
use crate::spawn_server;

use std::{fs, path::PathBuf};
use zellij_utils::{
    consts::session_layout_cache_file_name,
    data::{ConnectToSession, LayoutInfo, LayoutMetadata, WebSharing},
    envs,
    input::{cli_assets::CliAssets, config::Config, options::Options},
    ipc::{ClientAttributes, ClientToServerMsg},
    sessions::{generate_unique_session_name, resurrection_layout},
};

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
    let resurrection_layout = resurrection_layout(&session_name).ok().flatten();

    let mut layout_info = if resurrection_layout.is_some() {
        Some(LayoutInfo::File(
            session_layout_cache_file_name(&session_name)
                .display()
                .to_string(),
            LayoutMetadata::default(),
        ))
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
        // Private relay helpers must not inherit interactive shell startup hooks
        // or layouts that launch user applications.
        if cfg!(windows) && session_name.starts_with("__switchboard_control_") {
            layout_info = Some(LayoutInfo::Stringified(
                "layout {\n pane command=\"powershell.exe\" {\n args \"-NoLogo\" \"-NoProfile\"\n }\n}\n"
                    .into(),
            ));
        }
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
        let mut sock_dir = zellij_utils::consts::ZELLIJ_SOCK_DIR.clone();
        fs::create_dir_all(&sock_dir).unwrap();
        zellij_utils::shared::set_permissions(&sock_dir, 0o700).unwrap();
        sock_dir.push(session_name);
        sock_dir
    };
    crate::check_ipc_pipe_length(&zellij_ipc_pipe);
    zellij_ipc_pipe
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use zellij_utils::input::layout::Layout;

    #[test]
    fn private_helper_uses_plain_powershell_without_changing_user_sessions() {
        for (name, private) in [
            ("__switchboard_control_test", true),
            ("ordinary-test", false),
        ] {
            let options = Options {
                default_shell: Some("nu".into()),
                ..Default::default()
            };
            let message = create_first_message(
                false,
                None,
                ClientAttributes::default(),
                options,
                true,
                name,
                Some(LayoutInfo::BuiltIn("default".into())),
            );
            let ClientToServerMsg::FirstClientConnected { cli_assets, .. } = message else {
                panic!("Expected new session")
            };
            assert_eq!(
                cli_assets.configuration_options.unwrap().default_shell,
                Some("nu".into())
            );
            if private {
                let Some(LayoutInfo::Stringified(layout)) = cli_assets.layout else {
                    panic!("Expected private layout")
                };
                assert!(Layout::from_kdl(&layout, None, None, None).is_ok());
                assert!(layout.contains("powershell.exe"));
                assert!(layout.contains("-NoProfile"));
            } else {
                assert!(matches!(cli_assets.layout, Some(LayoutInfo::BuiltIn(_))));
            }
        }
    }
}
