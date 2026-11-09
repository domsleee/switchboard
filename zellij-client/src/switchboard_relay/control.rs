use super::*;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Stdio;
use zellij_utils::{
    data::PaneId,
    errors::ErrorContext,
    input::actions::Action,
    ipc::{ClientToServerMsg, ExitReason, IpcReceiveError, ServerToClientMsg},
};

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
        .unwrap_or_else(|| Ok(own_executable()?))
}

/// This executable's path, for starting its own CLI.
pub(crate) fn own_executable() -> std::io::Result<PathBuf> {
    Ok(without_deleted_suffix(std::env::current_exe()?))
}

// Linux reports "<path> (deleted)" once an update renames another binary over this one
// (including a rollback that leaves services running); the path then holds that binary.
fn without_deleted_suffix(path: PathBuf) -> PathBuf {
    match path.to_str().and_then(|p| p.strip_suffix(" (deleted)")) {
        Some(live) if !path.exists() => live.into(),
        _ => path,
    }
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
    // Installed configs name the real executable, so only a unit test's fake CLI opts out.
    if !cfg!(test) || host.config.zellij_binary.is_none() {
        if let Some(action) = socket_action(args) {
            return ask_engine(session, action, args[0], timeout).await;
        }
    }
    let mut command = tokio::process::Command::new(binary(host)?);
    command
        .args(["-s", session, "action"])
        .args(args)
        .kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output()).await??;
    anyhow::ensure!(
        output.status.success(),
        "Terminal command failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Reads and input, as the engine action the CLI would send. Each CLI call is a new
/// process, which Defender can make slow on Windows.
fn socket_action(args: &[&str]) -> Option<Action> {
    let list = |show_all| Action::ListPanes {
        show_tab: false,
        show_command: false,
        show_state: false,
        show_geometry: false,
        show_all,
        output_json: true,
    };
    let dump = |pane: &str, ansi| {
        Some(Action::DumpScreen {
            file_path: None,
            include_scrollback: false,
            pane_id: Some(pane.parse::<PaneId>().ok()?),
            ansi,
        })
    };
    match args {
        ["list-panes", "--json"] => Some(list(false)),
        ["list-panes", "--json", "--all"] => Some(list(true)),
        ["dump-screen", "-p", pane] => dump(pane, false),
        ["dump-screen", "--ansi", "-p", pane] => dump(pane, true),
        ["write", "-p" | "--pane-id", pane, bytes @ ..] if !bytes.is_empty() => {
            Some(Action::WriteToPaneId {
                bytes: bytes
                    .iter()
                    .map(|byte| byte.parse::<u8>().ok())
                    .collect::<Option<Vec<u8>>>()?,
                pane_id: pane.parse::<PaneId>().ok()?,
            })
        },
        ["paste", "-p", pane, "--", text] => Some(Action::Paste {
            chars: (*text).to_owned(),
            pane_id: Some(pane.parse::<PaneId>().ok()?),
        }),
        ["close-tab", "--tab-id", tab] => Some(Action::CloseTabById {
            id: tab.parse::<u64>().ok()?,
        }),
        ["rename-pane", "--pane-id", pane, name] => Some(Action::RenamePaneByPaneId {
            pane_id: Some(pane.parse::<PaneId>().ok()?),
            name: name.as_bytes().to_vec(),
        }),
        _ => None,
    }
}

/// A reply blocked on a stuck engine cannot be cancelled the way a process can be killed, so
/// each waiting request holds a thread until the engine answers or exits. This bounds them.
const MAX_WAITING_PER_SESSION: usize = 8;

fn waiting_permit(session: &str) -> anyhow::Result<tokio::sync::OwnedSemaphorePermit> {
    static WAITING: std::sync::LazyLock<
        std::sync::Mutex<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    > = std::sync::LazyLock::new(Default::default);
    WAITING
        .lock()
        .unwrap()
        .entry(session.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(MAX_WAITING_PER_SESSION)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            anyhow::anyhow!(
                "the engine has not answered {MAX_WAITING_PER_SESSION} earlier requests"
            )
        })
}

async fn ask_engine(
    session: &str,
    action: Action,
    name: &str,
    timeout: Duration,
) -> anyhow::Result<String> {
    validate_session(session).map_err(|(_, message)| anyhow::anyhow!(message))?;
    let permit = waiting_permit(session)?;
    let path = zellij_utils::consts::ZELLIJ_SOCK_DIR.join(session);
    let deadline = std::time::Instant::now() + timeout;
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        ask_engine_blocking(&path, action, deadline)
    });
    tokio::time::timeout(timeout, task)
        .await
        .map_err(|_| anyhow::anyhow!("the engine did not answer {name} within {timeout:?}"))?
        .map_err(|error| anyhow::anyhow!("{name} stopped: {error}"))?
}

fn ask_engine_blocking(
    path: &std::path::Path,
    action: Action,
    deadline: std::time::Instant,
) -> anyhow::Result<String> {
    use crate::os_input_output::ClientOsApi;
    let os = crate::os_input_output::get_cli_client_os_input()?;
    os.try_connect_to_server(path)
        .map_err(|error| anyhow::anyhow!("cannot connect to the engine: {error}"))?;
    // The caller has given up by now, so input sent after this would arrive unexpected.
    anyhow::ensure!(
        std::time::Instant::now() < deadline,
        "connecting to the engine took too long"
    );
    os.send_to_server(ClientToServerMsg::Action {
        action,
        terminal_id: None,
        client_id: None,
        is_cli_client: true,
    });
    if let Some(failure) = os.send_failure() {
        anyhow::bail!("cannot send to the engine: {failure}");
    }
    let reply = engine_reply(|| os.try_recv_from_server(), deadline);
    os.send_to_server(ClientToServerMsg::ClientExited);
    reply
}

/// Reads one action's reply, ending on the same messages as `zellij action`.
fn engine_reply(
    mut next: impl FnMut() -> Result<(ServerToClientMsg, ErrorContext), IpcReceiveError>,
    deadline: std::time::Instant,
) -> anyhow::Result<String> {
    loop {
        match next() {
            Ok((ServerToClientMsg::UnblockInputThread, _)) => return Ok(String::new()),
            Ok((ServerToClientMsg::Log { lines }, _)) => {
                return Ok(lines.iter().map(|line| format!("{line}\n")).collect())
            },
            Ok((ServerToClientMsg::LogError { lines }, _)) => {
                anyhow::bail!("the engine reported: {}", lines.join("; "))
            },
            Ok((ServerToClientMsg::Exit { exit_reason }, _)) => match exit_reason {
                ExitReason::Error(error) => anyhow::bail!("the engine exited: {error}"),
                ExitReason::CustomExitStatus(status) if status != 0 => {
                    anyhow::bail!("the engine exited with status {status}")
                },
                _ => return Ok(String::new()),
            },
            Err(IpcReceiveError::Disconnected) => {
                anyhow::bail!("the session closed the connection")
            },
            _ => {},
        }
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "the engine did not answer in time"
        );
    }
}

/// A session's panes. Closing a pane or tab tells every client of the session to unblock, so a
/// listing that overlaps a close can exit successfully before it prints anything. A real answer
/// is never empty (a session without panes prints `[]`), so an empty one is asked again.
pub(super) async fn list_panes(
    host: &Host,
    session: &str,
    all: bool,
    timeout: Duration,
) -> anyhow::Result<Vec<Value>> {
    let args: &[&str] = if all {
        &["list-panes", "--json", "--all"]
    } else {
        &["list-panes", "--json"]
    };
    let deadline = tokio::time::Instant::now() + timeout;
    for attempt in 1.. {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let text = run_local(host, session, args, remaining).await?;
        if !text.trim().is_empty() || attempt == 3 {
            return Ok(serde_json::from_str(&text)?);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    unreachable!()
}

pub(super) async fn sessions(host: &Host) -> anyhow::Result<Vec<String>> {
    Ok(shared_sessions(host)
        .await?
        .into_iter()
        .map(|(name, _)| name)
        .collect())
}

/// Every session the engine lists, shared or not.
pub(super) async fn session_catalog(host: &Host) -> anyhow::Result<Vec<Value>> {
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
    let mut catalog: Value = serde_json::from_slice(&response.body)?;
    match catalog["sessions"].take() {
        Value::Array(sessions) => Ok(sessions),
        _ => anyhow::bail!("Invalid session catalog"),
    }
}

/// Shared sessions with their creation time in Unix seconds, when the engine reports it.
pub(super) async fn shared_sessions(host: &Host) -> anyhow::Result<Vec<(String, Option<u64>)>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let mut names = Vec::new();
    for session in session_catalog(host).await? {
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

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Browser {
    Chrome,
    Chromium,
    Edge,
    Brave,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OpenBrowserPage {
    url: String,
    browser: Browser,
}

/// Pages a browser lets only its own address bar or command line open. Pages
/// that crash, hang or quit the browser are left out.
const BROWSER_PAGES: &[&str] = &[
    "about",
    "accessibility",
    "apps",
    "bookmarks",
    "components",
    "downloads",
    "extensions",
    "flags",
    "gpu",
    "history",
    "inspect",
    "management",
    "media-internals",
    "net-internals",
    "password-manager",
    "policy",
    "sandbox",
    "settings",
    "system",
    "version",
    "webrtc-internals",
];

/// Accepts chrome://, edge:// and brave:// pages from `BROWSER_PAGES`, in
/// characters that need no quoting on any platform's command line.
fn checked_browser_page(url: &str) -> Result<&str, Error> {
    let refused = (
        StatusCode::BAD_REQUEST,
        "Switchboard opens only browser pages such as settings and flags",
    );
    let (scheme, rest) = url.split_once("://").ok_or(refused)?;
    if !matches!(scheme, "chrome" | "edge" | "brave")
        || url.len() > 200
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._#-".contains(c))
    {
        return Err(refused);
    }
    let page = rest.split(['/', '#']).next().unwrap_or_default();
    if !BROWSER_PAGES.contains(&page) {
        return Err(refused);
    }
    Ok(url)
}

/// Programs to try for each browser, most specific first.
fn browser_commands(browser: Browser) -> Vec<Vec<&'static str>> {
    if cfg!(target_os = "macos") {
        let app = match browser {
            Browser::Chrome => "Google Chrome",
            Browser::Chromium => "Chromium",
            Browser::Edge => "Microsoft Edge",
            Browser::Brave => "Brave Browser",
        };
        vec![vec!["open", "-a", app]]
    } else if cfg!(windows) {
        // `start` finds browsers through App Paths, which Command alone does not.
        let program = match browser {
            Browser::Chrome | Browser::Chromium => "chrome",
            Browser::Edge => "msedge",
            Browser::Brave => "brave",
        };
        vec![vec!["cmd", "/C", "start", "", program]]
    } else {
        let programs: &[&str] = match browser {
            Browser::Chrome => &["google-chrome-stable", "google-chrome"],
            Browser::Chromium => &["chromium", "chromium-browser"],
            Browser::Edge => &["microsoft-edge-stable", "microsoft-edge"],
            Browser::Brave => &["brave-browser", "brave"],
        };
        programs.iter().map(|program| vec![*program]).collect()
    }
}

/// Opens a browser's own page, such as chrome://settings, which web pages may
/// not open themselves. The relay only serves pages viewed on this computer.
pub(super) async fn open_browser_page(
    Json(page): Json<OpenBrowserPage>,
) -> Result<Json<Value>, Error> {
    let url = checked_browser_page(&page.url)?;
    for command in browser_commands(page.browser) {
        let spawned = tokio::process::Command::new(command[0])
            .args(&command[1..])
            .arg(url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        // A browser that was not yet running keeps this process until it quits,
        // so the relay does not wait for it. Tokio reaps it when it exits.
        if spawned.is_ok() {
            return Ok(Json(json!({"ok":true})));
        }
    }
    Err((
        StatusCode::BAD_GATEWAY,
        "That browser is not installed on this computer",
    ))
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
    execute_host(&host, session, action).await?;
    if let ControlAction::Escape(pane) = action {
        settle_interrupt(host, state.poll.clone(), session.to_owned(), pane);
    }
    Ok(())
}

/// After Esc, ends the turn if Claude shows it was interrupted. Claude sends no hook for
/// that, and an unwatched pane's screen feed can be arbitrarily old, so read the pane.
pub(super) fn settle_interrupt(
    host: Arc<Host>,
    poll: Arc<Mutex<attention::PollState>>,
    session: String,
    pane: u32,
) {
    tokio::spawn(async move {
        let id = pane.to_string();
        let args = ["dump-screen", "-p", id.as_str()];
        for _ in 0..8 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let Ok(screen) = run_local(&host, &session, &args, Duration::from_secs(2)).await else {
                continue;
            };
            let row = attention::classify(&json!({"pane_command":"claude"}), &screen);
            if row["interrupted"] == true {
                poll.lock().await.settle_interrupted(&session, pane.into());
                return;
            }
        }
    });
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

pub(super) async fn require_writable_host(host: &Host) -> Result<(), Error> {
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
    Ok(())
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
    require_writable_host(host).await?;
    let close = !matches!(action, ControlAction::Escape(_));
    let panes = list_panes(host, session, close, Duration::from_secs(5))
        .await
        .map_err(|error| {
            if error.is::<serde_json::Error>() {
                (StatusCode::BAD_GATEWAY, "Invalid pane catalog")
            } else {
                (StatusCode::BAD_GATEWAY, "Cannot identify target")
            }
        })?;
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
    fn a_replaced_executable_resolves_to_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("zellij");
        let replaced = dir.path().join("zellij (deleted)");
        assert_eq!(without_deleted_suffix(replaced.clone()), live);
        assert_eq!(without_deleted_suffix(live.clone()), live);
        // A file really named that way is left alone.
        std::fs::write(&replaced, "").unwrap();
        assert_eq!(without_deleted_suffix(replaced.clone()), replaced);
    }

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

    #[test]
    fn only_harmless_browser_pages_open() {
        for good in [
            "chrome://settings/system",
            "chrome://flags/#ignore-gpu-blocklist",
            "edge://settings/system",
            "brave://gpu",
        ] {
            assert_eq!(checked_browser_page(good), Ok(good));
        }
        for bad in [
            "chrome://quit",
            "chrome://crash",
            "chrome://settings&calc",
            "chrome://settings/ x",
            "chrome://settings\"",
            "edge://settings/?search=x",
            "firefox://settings",
            "https://claude.ai",
            "javascript:alert(1)",
            "chrome:settings",
        ] {
            assert_eq!(
                checked_browser_page(bad).unwrap_err().0,
                StatusCode::BAD_REQUEST,
                "{bad}"
            );
        }
        assert!(serde_json::from_value::<OpenBrowserPage>(
            json!({"url":"chrome://gpu","browser":"brave"})
        )
        .is_ok_and(|page| page.browser == Browser::Brave));
        assert!(serde_json::from_value::<OpenBrowserPage>(
            json!({"url":"chrome://gpu","browser":"/bin/sh"})
        )
        .is_err());
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
    async fn a_pane_list_cut_short_by_a_concurrent_close_is_asked_again() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (fake, log) = (dir.path().join("zellij"), dir.path().join("calls"));
        // The first listing exits 0 with nothing, as when another tab's close unblocks it.
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\necho \"$*\" >> '{0}'\n[ $(wc -l < '{0}') -gt 1 ] && echo '[{{\"id\":1,\"tab_id\":4}}]'\nexit 0\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut config = super::super::tests::config("http://127.0.0.1:9");
        config.zellij_binary = Some(fake.to_str().unwrap().into());
        let host = Host::new(config).unwrap();
        let panes = list_panes(&host, "main", true, Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(panes, vec![json!({"id":1,"tab_id":4})]);
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "-s main action list-panes --json --all\n".repeat(2)
        );
        // An engine that never answers still fails, after three tries.
        std::fs::write(
            &fake,
            format!("#!/bin/sh\necho \"$*\" >> '{0}'\n", log.display()),
        )
        .unwrap();
        std::fs::remove_file(&log).unwrap();
        assert!(list_panes(&host, "main", false, Duration::from_secs(5))
            .await
            .unwrap_err()
            .is::<serde_json::Error>());
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 3);
    }

    #[test]
    fn switchboard_socket_handles_only_the_frequent_reads() {
        assert!(matches!(
            socket_action(&["list-panes", "--json", "--all"]),
            Some(Action::ListPanes {
                show_all: true,
                output_json: true,
                ..
            })
        ));
        assert!(matches!(
            socket_action(&["list-panes", "--json"]),
            Some(Action::ListPanes {
                show_all: false,
                output_json: true,
                ..
            })
        ));
        assert!(matches!(
            socket_action(&["dump-screen", "--ansi", "-p", "87"]),
            Some(Action::DumpScreen {
                file_path: None,
                include_scrollback: false,
                ansi: true,
                pane_id: Some(PaneId::Terminal(87))
            })
        ));
        assert!(matches!(
            socket_action(&["dump-screen", "-p", "87"]),
            Some(Action::DumpScreen {
                ansi: false,
                pane_id: Some(PaneId::Terminal(87)),
                ..
            })
        ));
        assert!(socket_action(&["dump-screen", "-p", "not a pane"]).is_none());
        assert!(socket_action(&["new-pane", "--", "cmd"]).is_none());
    }

    #[test]
    fn switchboard_socket_sends_input_as_the_cli_would() {
        assert!(matches!(
            socket_action(&["write", "-p", "87", "27", "13"]),
            Some(Action::WriteToPaneId { bytes, pane_id: PaneId::Terminal(87) }) if bytes == [27, 13]
        ));
        assert!(matches!(
            socket_action(&["write", "--pane-id", "87", "13"]),
            Some(Action::WriteToPaneId { bytes, pane_id: PaneId::Terminal(87) }) if bytes == [13]
        ));
        assert!(matches!(
            socket_action(&["paste", "-p", "87", "--", "-starts with a dash"]),
            Some(Action::Paste { chars, pane_id: Some(PaneId::Terminal(87)) }) if chars == "-starts with a dash"
        ));
        assert!(matches!(
            socket_action(&["close-tab", "--tab-id", "5"]),
            Some(Action::CloseTabById { id: 5 })
        ));
        assert!(matches!(
            socket_action(&["rename-pane", "--pane-id", "87", "Worker"]),
            Some(Action::RenamePaneByPaneId { pane_id: Some(PaneId::Terminal(87)), name }) if name == b"Worker"
        ));
        // Input the CLI would have refused is left for the CLI to refuse.
        assert!(socket_action(&["write", "-p", "87", "300"]).is_none());
        assert!(socket_action(&["write", "-p", "87"]).is_none());
        assert!(socket_action(&["write", "-p", "not a pane", "13"]).is_none());
    }

    #[test]
    fn switchboard_engine_reply_matches_the_cli() {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let reply = |message: Result<ServerToClientMsg, IpcReceiveError>| {
            let mut message = Some(message);
            engine_reply(
                || {
                    message
                        .take()
                        .unwrap()
                        .map(|m| (m, ErrorContext::default()))
                },
                deadline,
            )
        };
        let log = ServerToClientMsg::Log {
            lines: vec!["one".into(), "two".into()],
        };
        assert_eq!(reply(Ok(log)).unwrap(), "one\ntwo\n");
        // A close elsewhere unblocks every client, so the caller sees an empty answer.
        assert_eq!(
            reply(Ok(ServerToClientMsg::UnblockInputThread)).unwrap(),
            ""
        );
        let error = ServerToClientMsg::LogError {
            lines: vec!["No pane".into()],
        };
        assert!(reply(Ok(error))
            .unwrap_err()
            .to_string()
            .contains("No pane"));
        let exit = ServerToClientMsg::Exit {
            exit_reason: ExitReason::Error("boom".into()),
        };
        assert!(reply(Ok(exit)).unwrap_err().to_string().contains("boom"));
        assert!(reply(Err(IpcReceiveError::Disconnected))
            .unwrap_err()
            .to_string()
            .contains("closed"));
    }

    #[test]
    fn switchboard_engine_reply_gives_up_at_its_deadline() {
        let deadline = std::time::Instant::now();
        let error = engine_reply(|| Err(IpcReceiveError::Undecodable), deadline).unwrap_err();
        assert!(error.to_string().contains("in time"));
    }

    #[tokio::test]
    async fn switchboard_socket_refuses_a_session_name_that_leaves_the_socket_folder() {
        let host = Host::new(super::super::tests::config("http://127.0.0.1:9")).unwrap();
        for session in ["..", "a/b", "a\\b"] {
            let error = run_local(
                &host,
                session,
                &["list-panes", "--json"],
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
            assert!(
                error.to_string().contains("Invalid session"),
                "{session}: {error}"
            );
        }
    }

    #[tokio::test]
    async fn switchboard_socket_reports_a_session_with_no_engine() {
        let host = Host::new(super::super::tests::config("http://127.0.0.1:9")).unwrap();
        let error = run_local(
            &host,
            "no-such-engine-here",
            &["list-panes", "--json"],
            Duration::from_secs(5),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("cannot connect"), "{error}");
    }

    #[tokio::test]
    async fn switchboard_socket_limits_requests_waiting_on_one_session() {
        let held: Vec<_> = (0..MAX_WAITING_PER_SESSION)
            .map(|_| waiting_permit("stuck-engine").unwrap())
            .collect();
        assert!(waiting_permit("stuck-engine")
            .unwrap_err()
            .to_string()
            .contains("not answered"));
        assert!(
            waiting_permit("healthy-engine").is_ok(),
            "one stuck session must not block others"
        );
        drop(held);
        assert!(waiting_permit("stuck-engine").is_ok());
    }

    /// Opt-in timing against a real private session:
    /// SB_TIMING_SESSION=name SB_TIMING_PANE=id SB_TIMING_CLI=path, with ZELLIJ_SOCKET_DIR set.
    #[tokio::test]
    #[ignore]
    async fn switchboard_socket_timing_against_a_real_engine() {
        let session = std::env::var("SB_TIMING_SESSION").unwrap();
        let pane = std::env::var("SB_TIMING_PANE").unwrap();
        let mut socket = super::super::tests::config("http://127.0.0.1:9");
        socket.zellij_binary = None;
        let mut cli = socket.clone();
        cli.zellij_binary = Some(std::env::var("SB_TIMING_CLI").unwrap());
        let list = ["list-panes", "--json", "--all"];
        let dump = ["dump-screen", "--ansi", "-p", pane.as_str()];
        let commands: [(&str, &[&str]); 2] = [("list-panes", &list), ("dump-screen", &dump)];
        for (route, config) in [("socket", socket), ("cli", cli)] {
            let host = Host::new(config).unwrap();
            for (name, args) in commands {
                let mut times = Vec::new();
                let mut answer = String::new();
                for _ in 0..30 {
                    let start = std::time::Instant::now();
                    answer = run_local(&host, &session, args, Duration::from_secs(20))
                        .await
                        .unwrap();
                    times.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                times.sort_by(f64::total_cmp);
                println!(
                    "{route} {name}: p50 {:.1}ms p95 {:.1}ms max {:.1}ms, answer {} bytes",
                    times[15],
                    times[28],
                    times[29],
                    answer.len()
                );
                assert!(!answer.is_empty(), "{route} {name} returned nothing");
            }
        }
    }

    /// Opt-in: a Conversation reply is a paste then Enter, now milliseconds apart.
    /// SB_INPUT_SESSION=name SB_INPUT_PANE=id, on a private session only.
    #[tokio::test]
    #[ignore]
    async fn switchboard_socket_paste_then_enter_stays_in_order() {
        let session = std::env::var("SB_INPUT_SESSION").unwrap();
        let pane = std::env::var("SB_INPUT_PANE").unwrap();
        let host = Host::new(super::super::tests::config("http://127.0.0.1:9")).unwrap();
        let wait = Duration::from_secs(20);
        let (mut ran, mut slowest) = (0, Duration::ZERO);
        const ROUNDS: usize = 40;
        for round in 0..ROUNDS {
            let marker = format!("sborder{round}x{}", std::process::id());
            let padding = "y".repeat(if round % 2 == 0 { 20 } else { 1500 });
            let text = format!("echo {marker} {padding}");
            run_local(&host, &session, &["paste", "-p", &pane, "--", &text], wait)
                .await
                .unwrap();
            run_local(&host, &session, &["write", "-p", &pane, "13"], wait)
                .await
                .unwrap();
            let start = std::time::Instant::now();
            let mut screen = String::new();
            let mut done = false;
            while start.elapsed() < Duration::from_secs(8) {
                screen = run_local(&host, &session, &["dump-screen", "-p", &pane], wait)
                    .await
                    .unwrap();
                if screen
                    .lines()
                    .any(|line| line.contains(&marker) && !line.contains("echo "))
                {
                    done = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            if done {
                ran += 1;
                slowest = slowest.max(start.elapsed());
            } else {
                println!("order round {round} did not run; last screen:\n{screen}");
            }
        }
        println!("order: {ran} of {ROUNDS} ran; slowest output {slowest:?}");
        assert_eq!(ran, ROUNDS);
    }

    /// Opt-in input check against a real private session: never point this at a session in use.
    /// SB_INPUT_SESSION=name SB_INPUT_PANE=id SB_INPUT_CLOSE_TAB=id SB_TIMING_CLI=path.
    #[tokio::test]
    #[ignore]
    async fn switchboard_socket_input_against_a_real_engine() {
        let session = std::env::var("SB_INPUT_SESSION").unwrap();
        let pane = std::env::var("SB_INPUT_PANE").unwrap();
        let socket = super::super::tests::config("http://127.0.0.1:9");
        let mut cli = socket.clone();
        cli.zellij_binary = Some(std::env::var("SB_TIMING_CLI").unwrap());
        let wait = Duration::from_secs(20);
        for (route, config) in [("socket", socket.clone()), ("cli", cli)] {
            let host = Host::new(config).unwrap();
            let marker = format!("sbmark{route}{}", std::process::id());
            let text = format!("echo {marker} caf\u{e9}");
            run_local(&host, &session, &["paste", "-p", &pane, "--", &text], wait)
                .await
                .unwrap();
            let mut times = Vec::new();
            for _ in 0..30 {
                let start = std::time::Instant::now();
                run_local(&host, &session, &["write", "-p", &pane, "32"], wait)
                    .await
                    .unwrap();
                times.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            times.sort_by(f64::total_cmp);
            run_local(&host, &session, &["write", "-p", &pane, "13"], wait)
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let screen = run_local(&host, &session, &["dump-screen", "-p", &pane], wait)
                .await
                .unwrap();
            // A brand-new shell may not draw the typed line, so check the command's output.
            let ran = screen
                .lines()
                .any(|line| line.contains(&marker) && !line.contains("echo "));
            let accented = screen
                .lines()
                .any(|line| line.contains(&marker) && line.contains("caf\u{e9}"));
            println!("{route} write: p50 {:.1}ms p95 {:.1}ms max {:.1}ms; command ran {ran}; accented text intact {accented}", times[15], times[28], times[29]);
            assert!(ran, "{route}: the command did not run:\n{screen}");
            assert!(accented, "{route}: text changed in transit");
        }
        let host = Host::new(socket).unwrap();
        run_local(
            &host,
            &session,
            &["rename-pane", "--pane-id", &pane, "Renamed over socket"],
            wait,
        )
        .await
        .unwrap();
        let panes = list_panes(&host, &session, true, wait).await.unwrap();
        let renamed = panes.iter().any(|p| p["title"] == "Renamed over socket");
        let tab = std::env::var("SB_INPUT_CLOSE_TAB").unwrap();
        run_local(&host, &session, &["close-tab", "--tab-id", &tab], wait)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(800)).await;
        let panes = list_panes(&host, &session, true, wait).await.unwrap();
        let closed = !panes.iter().any(|p| p["tab_id"].to_string() == tab);
        println!("socket rename applied {renamed}; tab closed {closed}");
        assert!(renamed && closed);
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
