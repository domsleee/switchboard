use super::*;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Stdio;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EscapeTarget {
    session: String,
    pane_id: u32,
}
#[derive(Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum CloseTarget {
    Tab { session: String, tab_id: u32 },
    Pane { session: String, pane_id: u32 },
}

#[derive(Clone, Copy)]
pub(super) enum ControlAction {
    Escape(u32),
    CloseTab(u32),
    ClosePaneTab(u32),
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

pub(super) fn binary(host: &Host) -> anyhow::Result<PathBuf> {
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
    Ok(shared_sessions(host)
        .await?
        .into_iter()
        .map(|(name, _)| name)
        .collect())
}

/// Shared sessions with their creation time in Unix seconds, when the engine reports it.
pub(super) async fn shared_sessions(host: &Host) -> anyhow::Result<Vec<(String, Option<u64>)>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
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
                let created = session["creation_secs_ago"]
                    .as_u64()
                    .map(|ago| now.saturating_sub(ago));
                names.push((name.to_owned(), created));
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
    execute(
        &state,
        &id,
        &target.session,
        ControlAction::Escape(target.pane_id),
    )
    .await
    .inspect_err(|e| failed(&state, &id, "Escape", e))?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn close_tab(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<CloseTarget>,
) -> Result<Json<Value>, Error> {
    let (session, action) = match target {
        CloseTarget::Tab { session, tab_id } => (session, ControlAction::CloseTab(tab_id)),
        CloseTarget::Pane { session, pane_id } => (session, ControlAction::ClosePaneTab(pane_id)),
    };
    execute(&state, &id, &session, action)
        .await
        .inspect_err(|e| failed(&state, &id, "Close tab", e))?;
    Ok(Json(json!({"ok":true})))
}

#[derive(Deserialize)]
pub(super) struct OpenLink {
    url: String,
    app: String,
}

/// Opens a link in another browser on this computer, such as the one signed into
/// a work account. The relay only serves pages viewed on this computer.
pub(super) async fn open_link(Json(link): Json<OpenLink>) -> Result<Json<Value>, Error> {
    let url = checked_link(&link)?;
    if !cfg!(target_os = "macos") {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            "Opening links in another browser needs macOS",
        ));
    }
    let status = tokio::process::Command::new("open")
        .arg("-a")
        .arg(link.app.trim())
        .arg(url.as_str())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match status {
        Ok(status) if status.success() => Ok(Json(json!({"ok":true}))),
        _ => Err((
            StatusCode::BAD_GATEWAY,
            "That browser could not be opened; check its name in Settings",
        )),
    }
}

#[derive(Deserialize)]
pub(super) struct OpenFile {
    path: String,
}

/// Opens a file shown in this computer's terminal in its default app.
pub(super) async fn open_file(Json(file): Json<OpenFile>) -> Result<Json<Value>, Error> {
    let path = expand_path(&file.path)
        .ok()
        .filter(|path| path.is_absolute() && path.exists())
        .ok_or((StatusCode::NOT_FOUND, "File not found"))?;
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    let status = tokio::process::Command::new(program)
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match status {
        // Explorer exits with 1 even after opening the file.
        Ok(status) if status.success() || cfg!(windows) => Ok(Json(json!({"ok":true}))),
        _ => Err((
            StatusCode::BAD_GATEWAY,
            "No app on this computer could open that file",
        )),
    }
}

fn checked_link(link: &OpenLink) -> Result<url::Url, Error> {
    let url = url::Url::parse(&link.url).map_err(|_| (StatusCode::BAD_REQUEST, "Invalid link"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Only web links can open in another browser",
        ));
    }
    if link.app.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "Choose a browser in Settings"));
    }
    Ok(url)
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
    action: ControlAction,
) -> Result<(), Error> {
    validate_session(session)?;
    let host = state
        .host(id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown host"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let body = match action {
            ControlAction::Escape(target) => {
                json!({"session":session,"target":target,"close":false})
            },
            ControlAction::CloseTab(target) => {
                json!({"session":session,"target":target,"close":true})
            },
            // Omit target so older peers reject this instead of treating a pane ID as a tab ID.
            ControlAction::ClosePaneTab(pane_id) => {
                json!({"session":session,"pane_id":pane_id,"close":true})
            },
        };
        let response = host
            .request(
                Method::POST,
                "/switchboard/control",
                body.to_string().into(),
                "application/json",
            )
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Peer control unavailable"))?;
        return if response.status == StatusCode::OK {
            Ok(())
        } else {
            Err((response.status, peer_failure(response.status)))
        };
    }
    execute_host(&host, session, action).await
}

// Peers answer with execute_host's fixed statuses; say what each means here.
fn peer_failure(status: StatusCode) -> &'static str {
    match status {
        StatusCode::BAD_REQUEST => {
            "The other computer does not support this tab action; update Switchboard there"
        },
        StatusCode::CONFLICT => "That tab or pane no longer exists on the other computer",
        StatusCode::NOT_FOUND => "That session is not shared on the other computer",
        StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED => {
            "The other computer refused this computer's access; pair them again"
        },
        StatusCode::BAD_GATEWAY => {
            "The other computer could not read or control its terminal; check its Logs"
        },
        _ => "The other computer rejected the terminal command",
    }
}

pub(super) async fn execute_host(
    host: &Host,
    session: &str,
    action: ControlAction,
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
    let close = !matches!(action, ControlAction::Escape(_));
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
    let target = resolve_target(&panes, action)?;
    let final_tab = close && panes.iter().all(|pane| pane["tab_id"] == target);
    let target = target.to_string();
    let args = if close {
        vec!["close-tab", "--tab-id", &target]
    } else {
        vec!["write", "-p", &target, "27"]
    };
    let delivered = run_local(host, session, &args, Duration::from_secs(5)).await;
    // Closing the final tab ends the session, and its server can exit before the
    // CLI reads the reply. A session that is gone afterwards was closed.
    if delivered.is_err() && !(final_tab && session_ended(host, session).await) {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Terminal command failed; delivery may be uncertain",
        ));
    }
    log::info!(
        "Closed tab {target} in session {session} on {}{}",
        host.config.name,
        if final_tab {
            " (last tab; session ended)"
        } else {
            ""
        }
    );
    if final_tab {
        // Visible in Logs: the session is gone, not crashed.
        logs::record(
            &host.config.name,
            &format!("Closed the last tab of session '{session}'; the session ended"),
        );
        if let Ok(binary) = binary(host) {
            tokio::spawn(forget_closed_session(binary, session.to_owned()));
        }
    }
    Ok(())
}

fn resolve_target(panes: &[Value], action: ControlAction) -> Result<u32, Error> {
    let target = match action {
        ControlAction::ClosePaneTab(id) => panes
            .iter()
            .find(|pane| pane["id"] == id && pane["is_plugin"] == false)
            .and_then(|pane| pane["tab_id"].as_u64())
            .and_then(|id| u32::try_from(id).ok()),
        ControlAction::CloseTab(id) => panes.iter().any(|pane| pane["tab_id"] == id).then_some(id),
        ControlAction::Escape(id) => panes
            .iter()
            .any(|pane| {
                pane["id"] == id
                    && pane["is_plugin"] == false
                    && pane["exited"] != true
                    && pane["is_held"] != true
            })
            .then_some(id),
    };
    target.ok_or((StatusCode::CONFLICT, "Target is no longer available"))
}

async fn session_ended(host: &Host, session: &str) -> bool {
    for _ in 0..20 {
        if let Ok(names) = sessions(host).await {
            if !names.iter().any(|name| name == session) {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    false
}

/// Closing a session's final tab ends it, but Zellij keeps its last layout, so the next start
/// of that name (Switchboard auto-starts `main`) resurrected the very tab just closed.
/// Plain `delete-session` refuses while the engine runs, so a tab opened meanwhile keeps it.
async fn forget_closed_session(binary: PathBuf, session: String) {
    for _ in 0..20 {
        let deleted = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::process::Command::new(&binary)
                .args(["delete-session", &session])
                .kill_on_drop(true)
                .output(),
        )
        .await;
        // 0: deleted; 2: nothing was kept to resurrect. 1 means the engine is still running.
        if let Ok(Ok(output)) = deleted {
            if matches!(output.status.code(), Some(0 | 2)) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_open_in_another_browser() {
        let link = |url: &str, app: &str| OpenLink {
            url: url.into(),
            app: app.into(),
        };
        assert!(checked_link(&link("https://claude.ai/new", "Google Chrome Canary")).is_ok());
        for bad in [
            link("javascript:alert(1)", "Safari"),
            link("file:///etc/passwd", "Safari"),
            link("not a url", "Safari"),
            link("https://claude.ai", " "),
        ] {
            assert_eq!(checked_link(&bad).unwrap_err().0, StatusCode::BAD_REQUEST);
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_missing_browser_is_reported() {
        let link = OpenLink {
            url: "https://claude.ai/new".into(),
            app: "Switchboard Missing Browser".into(),
        };
        let (status, message) = open_link(Json(link)).await.unwrap_err();
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert!(message.contains("Settings"));
    }

    #[test]
    fn peer_refusals_explain_the_cause() {
        assert!(peer_failure(StatusCode::CONFLICT).contains("no longer exists"));
        assert!(peer_failure(StatusCode::NOT_FOUND).contains("not shared"));
        assert!(peer_failure(StatusCode::FORBIDDEN).contains("pair them again"));
        assert!(peer_failure(StatusCode::BAD_GATEWAY).contains("Logs"));
    }

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
        for target in [
            json!({"session":"main"}),
            json!({"session":"main","pane_id":-1}),
            json!({"session":"main","tab_id":1,"pane_id":2}),
        ] {
            assert!(serde_json::from_value::<CloseTarget>(target).is_err());
        }
    }

    #[test]
    fn provisional_close_resolves_the_pane_to_its_tab_not_the_matching_tab_id() {
        let panes = vec![
            json!({"id":17,"tab_id":42,"is_plugin":false,"is_held":true}),
            json!({"id":90,"tab_id":17,"is_plugin":false}),
            json!({"id":18,"tab_id":99,"is_plugin":true}),
        ];
        assert_eq!(
            resolve_target(&panes, ControlAction::ClosePaneTab(17)),
            Ok(42)
        );
        assert_eq!(resolve_target(&panes, ControlAction::CloseTab(17)), Ok(17));
        assert!(resolve_target(&panes, ControlAction::ClosePaneTab(18)).is_err());
        assert!(resolve_target(&panes, ControlAction::ClosePaneTab(42)).is_err());
        assert!(resolve_target(&panes, ControlAction::Escape(17)).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn closed_final_tab_is_forgotten_only_after_its_engine_exits() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (fake, log) = (dir.path().join("zellij"), dir.path().join("calls"));
        // Mimics `delete-session`: refuses (1) twice while the engine still runs, then deletes.
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{0}'\n[ $(wc -l < '{0}') -gt 2 ]\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        forget_closed_session(fake, "main".into()).await;
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "delete-session main\n".repeat(3),
            "never forces a running engine, and stops once deleted"
        );
    }
}
