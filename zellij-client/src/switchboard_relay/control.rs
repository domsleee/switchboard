use super::*;
use serde::Deserialize;
use std::path::PathBuf;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EscapeTarget {
    session: String,
    pane_id: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CloseTarget {
    session: String,
    tab_id: u32,
}

pub(super) fn validate_session(session: &str) -> Result<(), Error> {
    if session.trim().is_empty()
        || session.chars().count() > 200
        || matches!(session, "." | "..")
        || session
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid session"));
    }
    Ok(())
}

fn binary(host: &Host) -> anyhow::Result<PathBuf> {
    host.config
        .zellij_binary
        .as_ref()
        .map(|path| expand_path(path))
        .unwrap_or_else(|| Ok(std::env::current_exe()?))
}

pub(super) fn expand_path(path: &str) -> anyhow::Result<PathBuf> {
    if let Some(tail) = path.strip_prefix("~/") {
        Ok(PathBuf::from(
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .ok_or_else(|| anyhow::anyhow!("No home directory"))?,
        )
        .join(tail))
    } else {
        Ok(path.into())
    }
}

pub(super) async fn run_local(
    host: &Host,
    session: &str,
    args: &[&str],
    timeout: Duration,
) -> anyhow::Result<String> {
    let mut command = tokio::process::Command::new(binary(host)?);
    command
        .args(["-s", session, "action"])
        .args(args)
        .kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output()).await??;
    anyhow::ensure!(output.status.success(), "Terminal command failed");
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(super) async fn sessions(host: &Host) -> anyhow::Result<Vec<String>> {
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        host.request(
            Method::GET,
            "/session-list",
            Bytes::new(),
            "application/json",
        ),
    )
    .await??;
    anyhow::ensure!(
        response.status == StatusCode::OK,
        "Cannot validate sessions"
    );
    let catalog: Value = serde_json::from_slice(&response.body)?;
    let mut names = Vec::new();
    for session in catalog["sessions"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid session catalog"))?
    {
        if session["web_clients_allowed"] == true {
            if let Some(name) = session["name"].as_str() {
                validate_session(name).map_err(|_| anyhow::anyhow!("Invalid shared session"))?;
                names.push(name.to_owned());
            }
        }
    }
    Ok(names)
}

pub(super) async fn escape(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<EscapeTarget>,
) -> Result<Json<Value>, Error> {
    execute(&state, &id, &target.session, target.pane_id, false)
        .await
        .inspect_err(|e| failed(&state, &id, "Escape", e))?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn close_tab(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<CloseTarget>,
) -> Result<Json<Value>, Error> {
    execute(&state, &id, &target.session, target.tab_id, true)
        .await
        .inspect_err(|e| failed(&state, &id, "Close tab", e))?;
    Ok(Json(json!({"ok":true})))
}

fn failed(state: &RelayState, id: &str, action: &str, (status, message): &Error) {
    // Invalid input and closed-meanwhile targets are user races, not failures to review.
    if !matches!(
        *status,
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND | StatusCode::CONFLICT
    ) {
        let name = state
            .host(id)
            .map_or(id.to_string(), |h| h.config.name.clone());
        logs::record(&name, &format!("{action} failed: {message}"));
    }
}

async fn execute(
    state: &RelayState,
    id: &str,
    session: &str,
    target: u32,
    close: bool,
) -> Result<(), Error> {
    validate_session(session)?;
    let host = state
        .host(id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown host"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = host
            .request(
                Method::POST,
                "/switchboard/control",
                json!({"session":session,"target":target,"close":close})
                    .to_string()
                    .into(),
                "application/json",
            )
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Peer control unavailable"))?;
        return if response.status == StatusCode::OK {
            Ok(())
        } else {
            Err((response.status, "Peer rejected terminal control"))
        };
    }
    execute_host(&host, session, target, close).await
}

pub(super) async fn execute_host(
    host: &Host,
    session: &str,
    target: u32,
    close: bool,
) -> Result<(), Error> {
    validate_session(session)?;
    // Only local engines reach here: configured hosts are local and peers use their gateway.
    let names = sessions(host)
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot validate session"))?;
    if !names.iter().any(|name| name == session) {
        return Err((StatusCode::NOT_FOUND, "Session is unavailable"));
    }
    let cookie = host
        .cookie
        .lock()
        .await
        .clone()
        .ok_or((StatusCode::UNAUTHORIZED, "Host is not authenticated"))?;
    let token = cookie
        .strip_prefix("session_token=")
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid host authentication"))?;
    // A local CLI has the OS user's privileges. Do not bypass a view-only
    // upstream token by invoking it on behalf of that authenticated browser.
    use zellij_utils::web_authentication_tokens::{
        is_session_token_read_only, validate_session_token,
    };
    if !validate_session_token(token).unwrap_or(false)
        || is_session_token_read_only(token).unwrap_or(true)
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Writable host authentication is required",
        ));
    }
    let all = if close {
        vec!["list-panes", "--json", "--all"]
    } else {
        vec!["list-panes", "--json"]
    };
    let panes = run_local(host, session, &all, Duration::from_secs(5))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot identify target"))?;
    let panes: Vec<Value> = serde_json::from_str(&panes)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid pane catalog"))?;
    let available = panes.iter().any(|pane| {
        if close {
            pane["tab_id"] == target
        } else {
            pane["id"] == target
                && pane["is_plugin"] == false
                && pane["exited"] != true
                && pane["is_held"] != true
        }
    });
    if !available {
        return Err((StatusCode::CONFLICT, "Target is no longer available"));
    }
    let target = target.to_string();
    let args = if close {
        vec!["close-tab", "--tab-id", &target]
    } else {
        vec!["write", "-p", &target, "27"]
    };
    run_local(host, session, &args, Duration::from_secs(5))
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Terminal command failed; delivery may be uncertain",
            )
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_and_target_boundaries() {
        for name in ["", "..", "x/y", "x\\y", "x\n"] {
            assert!(validate_session(name).is_err());
        }
        assert!(validate_session("user's session; $(anything)").is_ok());
        assert!(
            serde_json::from_value::<EscapeTarget>(json!({"session":"main","pane_id":-1})).is_err()
        );
        assert!(serde_json::from_value::<CloseTarget>(
            json!({"session":"main","tab_id":1,"extra":true})
        )
        .is_err());
    }
}
