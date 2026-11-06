//! Explicit terminal operations, authenticated before opening an engine connection.
use super::*;
use serde::Serialize;
use zellij_utils::{data::PaneId, input::actions::Action, web_authentication_tokens};

#[derive(Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Operation {
    List {
        session: String,
    },
    Read {
        session: String,
        pane_id: u32,
    },
    Close {
        session: String,
        pane_id: u32,
    },
    Input {
        session: String,
        pane_id: u32,
        text: String,
    },
    Key {
        session: String,
        pane_id: u32,
        key: Key,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Key {
    Enter,
    Escape,
    Tab,
    Backspace,
    Interrupt,
}

impl Operation {
    fn session(&self) -> &str {
        match self {
            Self::Close { session, .. }
            | Self::List { session }
            | Self::Read { session, .. }
            | Self::Input { session, .. }
            | Self::Key { session, .. } => session,
        }
    }
    fn writes(&self) -> bool {
        matches!(
            self,
            Self::Close { .. } | Self::Input { .. } | Self::Key { .. }
        )
    }
}

fn authorize(
    headers: &HeaderMap,
    writes: bool,
    lookup: impl FnOnce(&str) -> Option<bool>,
) -> Result<(), Error> {
    // Bearer only: a browser cookie must never grant ambient terminal API access.
    if headers.contains_key(header::ORIGIN) {
        return Err((
            StatusCode::FORBIDDEN,
            "Terminal API does not accept browser requests",
        ));
    }
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "Terminal credential required"))?;
    let read_only =
        lookup(token).ok_or((StatusCode::UNAUTHORIZED, "Invalid terminal credential"))?;
    if read_only && writes {
        return Err((
            StatusCode::FORBIDDEN,
            "Writable terminal credential required",
        ));
    }
    Ok(())
}

pub(super) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
    Json(operation): Json<Operation>,
) -> Result<Response, Error> {
    authorize(&headers, operation.writes(), |token| {
        web_authentication_tokens::token_read_only(token)
            .ok()
            .flatten()
    })?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    control::validate_session(operation.session())?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let body = serde_json::to_vec(&operation)
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid terminal operation"))?;
        let response = host
            .request(
                Method::POST,
                "/switchboard/terminal",
                body.into(),
                "application/json",
            )
            .await
            .map_err(|_| {
                (
                    StatusCode::BAD_GATEWAY,
                    "Terminal delivery uncertain; do not retry input automatically",
                )
            })?;
        return Ok((
            response.status,
            [(header::CONTENT_TYPE, "application/json")],
            response.body,
        )
            .into_response());
    }
    local(&host, operation).await
}

pub(super) async fn gateway(host: &Host, request: Request) -> Result<Response, Error> {
    // Reached only through peer_terminal's authenticated and revocation-checked gateway.
    let bytes = to_bytes(request.into_body(), 64 * 1024)
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "Terminal request too large"))?;
    let operation = serde_json::from_slice(&bytes)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid terminal operation"))?;
    local(host, operation).await
}

async fn local(host: &Host, operation: Operation) -> Result<Response, Error> {
    let session = operation.session();
    control::validate_session(session)?;
    // Refresh authentication and shared-session visibility before using OS-level IPC.
    let sessions = control::sessions(host)
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot validate session"))?;
    if !sessions.iter().any(|s| s == session) {
        return Err((StatusCode::NOT_FOUND, "Session is not shared"));
    }
    let cookie = host
        .cookie
        .lock()
        .await
        .clone()
        .ok_or((StatusCode::UNAUTHORIZED, "Engine authentication required"))?;
    let token = cookie
        .strip_prefix("session_token=")
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid engine authentication"))?;
    if !web_authentication_tokens::validate_session_token(token).unwrap_or(false) {
        return Err((StatusCode::UNAUTHORIZED, "Engine authentication expired"));
    }
    if operation.writes()
        && web_authentication_tokens::is_session_token_read_only(token).unwrap_or(true)
    {
        return Err((StatusCode::FORBIDDEN, "Engine credential is read-only"));
    }
    if let Operation::Close { pane_id, .. } = &operation {
        control::execute_host(
            host,
            session,
            control::ControlAction::ClosePaneTab(*pane_id),
        )
        .await?;
        return Ok(Json(json!({"ok":true})).into_response());
    }
    let panes = control::list_panes(host, session, true, Duration::from_secs(5))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot read pane catalog"))?;
    let pane_id = match &operation {
        Operation::List { .. } => return Ok(Json(json!({"panes":panes})).into_response()),
        Operation::Close { pane_id, .. }
        | Operation::Read { pane_id, .. }
        | Operation::Input { pane_id, .. }
        | Operation::Key { pane_id, .. } => *pane_id,
    };
    if !panes
        .iter()
        .any(|p| p["id"] == pane_id && p["is_plugin"] == false && p["exited"] != true)
    {
        return Err((StatusCode::CONFLICT, "Pane is no longer available"));
    }
    let target = PaneId::Terminal(pane_id);
    let action = match &operation {
        Operation::Read { .. } => Action::DumpScreen {
            file_path: None,
            include_scrollback: false,
            pane_id: Some(target),
            ansi: false,
        },
        Operation::Input { text, .. } => {
            if text.len() > 32 * 1024 {
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "Input too large"));
            }
            Action::Paste {
                chars: text.clone(),
                pane_id: Some(target),
            }
        },
        Operation::Key { key, .. } => Action::WriteToPaneId {
            pane_id: target,
            bytes: vec![match key {
                Key::Enter => 13,
                Key::Escape => 27,
                Key::Tab => 9,
                Key::Backspace => 127,
                Key::Interrupt => 3,
            }],
        },
        Operation::List { .. } | Operation::Close { .. } => unreachable!(),
    };
    let result = engine::action(session, action, Duration::from_secs(5))
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Terminal delivery uncertain; do not retry input automatically",
            )
        })?;
    Ok(Json(if matches!(operation, Operation::Read { .. }) {
        json!({"screen":result})
    } else {
        json!({"ok":true})
    })
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_credentials_reject_missing_invalid_revoked_readonly_and_browser_access() {
        let lookup = |token: &str| match token {
            "reader" => Some(true),
            "writer" => Some(false),
            _ => None,
        };
        let mut headers = HeaderMap::new();
        assert_eq!(
            authorize(&headers, false, lookup).unwrap_err().0,
            StatusCode::UNAUTHORIZED
        );
        headers.insert(header::COOKIE, "session_token=writer".parse().unwrap());
        assert!(authorize(&headers, false, lookup).is_err());
        for token in ["invalid", "revoked"] {
            headers.insert(
                header::AUTHORIZATION,
                format!("Bearer {token}").parse().unwrap(),
            );
            assert_eq!(
                authorize(&headers, false, lookup).unwrap_err().0,
                StatusCode::UNAUTHORIZED
            );
        }
        headers.insert(header::AUTHORIZATION, "Bearer reader".parse().unwrap());
        assert!(authorize(&headers, false, lookup).is_ok());
        assert_eq!(
            authorize(&headers, true, lookup).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        headers.insert(header::AUTHORIZATION, "Bearer writer".parse().unwrap());
        assert!(authorize(&headers, true, lookup).is_ok());
        headers.insert(header::ORIGIN, "https://attacker.invalid".parse().unwrap());
        assert_eq!(
            authorize(&headers, true, lookup).unwrap_err().0,
            StatusCode::FORBIDDEN
        );
    }
    #[test]
    fn terminal_operations_require_explicit_targets_and_fixed_actions() {
        for body in [
            json!({"action":"input","session":"main","text":"hello"}),
            json!({"action":"key","session":"main","pane_id":1,"key":"shell"}),
            json!({"action":"read","session":"main","pane_id":1,"command":"whoami"}),
        ] {
            assert!(serde_json::from_value::<Operation>(body).is_err());
        }
    }
}
