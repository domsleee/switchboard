//! Create tabs without attaching a browser viewer or changing terminal geometry.
use super::{authentication::IsReadOnly, types::AppState, websocket_handlers::tab_command};
use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{ffi::OsString, time::Duration};
use zellij_utils::data::WebSharing;

type Error = (StatusCode, &'static str);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    session: String,
    project: String,
    command: String,
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
        && !target.command.trim().is_empty()
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
    let mut command = tokio::process::Command::new(binary);
    command
        .arg("--config")
        .arg(&state.config_file_path)
        .args(args)
        .env_remove("ZELLIJ")
        .env_remove("ZELLIJ_SESSION_NAME")
        .env_remove("ZELLIJ_PANE_ID")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| {
            (
                StatusCode::GATEWAY_TIMEOUT,
                "Tab creation timed out; check the tab list before retrying",
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
    }
    let shell = state.config.lock().unwrap().options.default_shell.clone();
    let cwd = std::env::home_dir()
        .ok_or((StatusCode::BAD_GATEWAY, "Home directory unavailable"))?
        .join("git")
        .join(target.project.trim());
    let run = tab_command(shell, target.command, Some(cwd.clone()), target.elevated);
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
    let pane_id: u32 = cli(&state, args).await?.trim().parse().map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Tab created but its identity was not returned; check the tab list",
        )
    })?;
    Ok(Json(json!({"pane_id":pane_id})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_tab_creation_rejects_invalid_targets() {
        let mut target = Target {
            session: "main".into(),
            project: "switchboard".into(),
            command: "c".into(),
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
