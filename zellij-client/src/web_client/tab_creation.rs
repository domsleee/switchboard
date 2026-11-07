//! Create tabs without attaching a browser viewer or changing terminal geometry.
use super::{
    authentication::IsReadOnly,
    types::AppState,
    websocket_handlers::{prompt_command, tab_command},
};
use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{ffi::OsString, process::Stdio, time::Duration};
use zellij_utils::data::WebSharing;

type Error = (StatusCode, &'static str);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    session: String,
    project: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    images: Vec<String>,
    #[serde(default)]
    elevated: bool,
}

fn valid(target: &Target) -> bool {
    !target.session.trim().is_empty()
        && target.session.len() <= 200
        && !matches!(target.session.as_str(), "." | "..")
        && !target
            .session
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
        && !target.project.trim().is_empty()
        && target.project.len() <= 4096
        && !target.project.contains('\0')
        && (target.prompt.is_some() || !target.command.trim().is_empty())
        && target
            .prompt
            .as_ref()
            .is_none_or(|text| text.len() <= 16000 && !text.contains('\0'))
        && target.images.len() <= 8
        && target.images.iter().all(|path| {
            !path.is_empty() && path.len() <= 4096 && !path.chars().any(char::is_control)
        })
        && target.command.len() <= 16000
        && !target.command.contains('\0')
}

async fn cli(state: &AppState, args: Vec<OsString>) -> Result<String, Error> {
    let binary = crate::switchboard_relay::own_executable().map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Terminal executable unavailable",
        )
    })?;
    let background = args.iter().any(|arg| arg == "--create-background");
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("--config")
        .arg(&state.config_file_path)
        .args(args)
        .env_remove("ZELLIJ")
        .env_remove("ZELLIJ_SESSION_NAME")
        .env_remove("ZELLIJ_PANE_ID")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    if background {
        // The background engine can inherit these handles on Windows. Waiting
        // for EOF would keep the creation request open for the session's life.
        command.stdout(Stdio::null()).stderr(Stdio::null());
    } else {
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
    }
    // Command::output replaces configured stdout/stderr with pipes. Spawn
    // explicitly so background startup keeps its null handles.
    let child = command
        .spawn()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?;
    let output = tokio::time::timeout(Duration::from_secs(15), child.wait_with_output())
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                if background {
                    "Session startup timed out; check the tab list before retrying"
                } else {
                    "Tab creation timed out; check the tab list before retrying"
                },
            )
        })?
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot run terminal command"))?;
    if !output.status.success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Terminal command failed; check the tab list before retrying",
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn panes(state: &AppState, session: &str) -> Result<Vec<Value>, Error> {
    let catalog = cli(
        state,
        vec![
            "-s".into(),
            session.into(),
            "action".into(),
            "list-panes".into(),
            "--json".into(),
            "--all".into(),
        ],
    )
    .await?;
    // A simultaneous close can unblock a successful CLI before it prints.
    if catalog.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&catalog).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Cannot identify the created terminal; check the tab list",
        )
    })
}

pub(super) async fn create(
    State(state): State<AppState>,
    Extension(IsReadOnly(read_only)): Extension<IsReadOnly>,
    Json(target): Json<Target>,
) -> Result<Json<Value>, Error> {
    if read_only {
        return Err((StatusCode::FORBIDDEN, "Writable access is required"));
    }
    if !valid(&target) {
        return Err((StatusCode::BAD_REQUEST, "Invalid tab request"));
    }
    let sessions = state.session_manager.list_sessions();
    if let Some(session) = sessions.iter().find(|s| s.name == target.session) {
        if !session.web_clients_allowed
            && !state
                .sharing_recovery
                .as_ref()
                .is_some_and(|r| r.catalog_allowed(&target.session, false))
        {
            return Err((StatusCode::FORBIDDEN, "Session is not shared"));
        }
    } else {
        if !sessions.is_empty() {
            return Err((StatusCode::NOT_FOUND, "Session is unavailable"));
        }
        if state.config.lock().unwrap().options.web_sharing == Some(WebSharing::Disabled) {
            return Err((StatusCode::FORBIDDEN, "Web sharing is disabled"));
        }
        cli(
            &state,
            vec![
                "attach".into(),
                "--create-background".into(),
                target.session.clone().into(),
                "options".into(),
                "--web-sharing".into(),
                "on".into(),
            ],
        )
        .await?;
        // Background creation returns before the engine accepts actions.
        // Wait on a read before issuing the one mutating new-tab request.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if panes(&state, &target.session)
                .await
                .is_ok_and(|panes| !panes.is_empty())
            {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err((
                    StatusCode::GATEWAY_TIMEOUT,
                    "Session is still starting; check the tab list before retrying",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    let shell = state.config.lock().unwrap().options.default_shell.clone();
    let cwd = std::env::home_dir()
        .ok_or((StatusCode::BAD_GATEWAY, "Home directory unavailable"))?
        .join("git")
        .join(target.project.trim());
    let command = target
        .prompt
        .map(|text| prompt_command(shell.clone(), &text, &target.images))
        .unwrap_or(target.command);
    let run = tab_command(shell, command, Some(cwd.clone()), target.elevated);
    let mut args: Vec<OsString> = vec![
        "-s".into(),
        target.session.clone().into(),
        "action".into(),
        "new-tab".into(),
        "--no-focus".into(),
        "--cwd".into(),
        cwd.into_os_string(),
    ];
    if target.elevated {
        args.extend(["--name".into(), "Administrator".into()]);
    }
    args.push("--".into());
    args.push(run.command.into_os_string());
    args.extend(run.args.into_iter().map(OsString::from));
    // `new-tab` prints a stable tab ID. Pane IDs diverge as soon as a tab has
    // multiple panes, so resolve the command's terminal from that tab's catalog.
    let tab_id: u32 = cli(&state, args).await?.trim().parse().map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Tab created but its identity was not returned; check the tab list",
        )
    })?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let panes = panes(&state, &target.session).await?;
        if let Some(pane_id) = created_pane(&panes, tab_id) {
            return Ok(Json(json!({"pane_id":pane_id,"tab_id":tab_id})));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err((
                StatusCode::BAD_GATEWAY,
                "The created terminal is not ready; check the tab list before retrying",
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn created_pane(panes: &[Value], tab_id: u32) -> Option<u32> {
    panes
        .iter()
        .filter(|pane| {
            pane["tab_id"] == tab_id && pane["is_plugin"] == false && pane["is_suppressed"] != true
        })
        .max_by_key(|pane| pane["is_focused"] == true)
        .and_then(|pane| pane["id"].as_u64()?.try_into().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_tab_creation_resolves_the_terminal_from_the_returned_tab_id() {
        let panes = vec![
            json!({"id":8,"tab_id":3,"is_plugin":false}),
            json!({"id":2,"tab_id":8,"is_plugin":true,"is_focused":true}),
            json!({"id":15,"tab_id":8,"is_plugin":false,"is_suppressed":true}),
            json!({"id":16,"tab_id":8,"is_plugin":false}),
            json!({"id":17,"tab_id":8,"is_plugin":false,"is_focused":true}),
        ];
        assert_eq!(created_pane(&panes, 8), Some(17));
        assert_eq!(created_pane(&panes, 3), Some(8));
        assert_eq!(created_pane(&panes, 17), None);
    }
    #[test]
    fn switchboard_tab_creation_rejects_invalid_targets() {
        let mut target = Target {
            session: "main".into(),
            project: "switchboard".into(),
            command: "c".into(),
            prompt: None,
            images: vec![],
            elevated: false,
        };
        assert!(valid(&target));
        for name in ["", "..", "../main", "a\\b", "main\n"] {
            target.session = name.into();
            assert!(!valid(&target));
        }
        target.session = "main".into();
        target.command = "\0".into();
        assert!(!valid(&target));
        target.command = "c".into();
        target.project = "".into();
        assert!(!valid(&target));
    }
}
