//! sudo passwords typed into the sidebar.
//!
//! New panes get `SUDO_ASKPASS` pointing at a script that runs `zellij switchboard
//! askpass`, so `sudo -A` works without a terminal (an agent's shell, Claude Code's
//! `!`). The helper asks this relay and waits. The browser sees the request in the
//! attention snapshot, never a password, and answers it; the relay hands the
//! answer to the one waiting helper and keeps no copy.
//!
//! Paired computers show the request too: it rides on the snapshot this computer
//! serves them, and their answer comes back over the pinned pairing connection,
//! the same one that already carries keystrokes to this computer's terminals.
use super::{attention, RelayState};
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

/// How long a request waits for someone to answer it in the sidebar.
pub(super) const TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PENDING: usize = 16;
const MAX_PASSWORD: usize = 1024;

struct Pending {
    session: String,
    pane_id: u64,
    prompt: String,
    command: String,
    created: u64,
    answer: oneshot::Sender<Option<String>>,
}

#[derive(Default)]
pub(super) struct Prompts(Mutex<HashMap<String, Pending>>);

impl Prompts {
    /// Open requests as the browser sees them, oldest first.
    pub(super) fn snapshot(&self, host: &str) -> Vec<Value> {
        let pending = self.0.lock().unwrap();
        let mut rows: Vec<_> = pending
            .iter()
            .map(|(id, p)| {
                json!({
                    "id": id, "host": host, "session": p.session, "pane_id": p.pane_id,
                    "prompt": p.prompt, "command": p.command, "created": p.created,
                })
            })
            .collect();
        rows.sort_by_key(|row| {
            (
                row["created"].as_u64(),
                row["id"].as_str().map(str::to_owned),
            )
        });
        rows
    }

    /// Hands `password` (None cancels) to the helper waiting on request `id`.
    pub(super) fn answer(&self, id: &str, password: Option<String>) -> StatusCode {
        if password.as_ref().is_some_and(|p| p.len() > MAX_PASSWORD) {
            return StatusCode::PAYLOAD_TOO_LARGE;
        }
        let Some(pending) = self.0.lock().unwrap().remove(id) else {
            return StatusCode::NOT_FOUND;
        };
        let _ = pending.answer.send(password);
        StatusCode::NO_CONTENT
    }
}

/// Shows the change to this computer's browsers and wakes paired computers
/// waiting on its snapshot.
async fn republish(state: &RelayState) {
    let poll = state.poll.lock().await;
    poll.changes.send_modify(|version| *version += 1);
    attention::publish(state, &poll);
}

/// Removes a request when its asker stops waiting: answered, timed out, or gone
/// because sudo was interrupted and dropped the connection. It republishes even
/// when an answer already removed the request: a paired computer's answer
/// arrives through the gateway, which cannot republish.
struct Withdraw {
    state: RelayState,
    id: String,
}

impl Drop for Withdraw {
    fn drop(&mut self) {
        self.state.askpass.0.lock().unwrap().remove(&self.id);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let state = self.state.clone();
            runtime.spawn(async move { republish(&state).await });
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Ask {
    session: String,
    pane_id: u64,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    command: String,
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "error": error }))).into_response()
}

fn id() -> String {
    use mesh_rand::RngCore;
    let mut bytes = [0u8; 16];
    mesh_rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Holds the helper's request until the sidebar answers it, it is cancelled, or
/// [`TIMEOUT`] passes. Answers `{"password": ...}` only to this caller.
pub(super) async fn ask(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(ask): Json<Ask>,
) -> Response {
    // A program on this computer asks; a web page never raises a password prompt.
    if headers.contains_key(header::ORIGIN) || headers.contains_key("sec-fetch-mode") {
        return refuse(StatusCode::FORBIDDEN, "Only the askpass helper can ask");
    }
    if ask.session.is_empty()
        || ask.session.len() > 256
        || ask.prompt.len() > 256
        || ask.command.len() > 4096
    {
        return refuse(StatusCode::BAD_REQUEST, "Invalid password request");
    }
    let id = id();
    let (answer, answered) = oneshot::channel();
    {
        let mut pending = state.askpass.0.lock().unwrap();
        if pending.len() >= MAX_PENDING {
            return refuse(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many password requests are open",
            );
        }
        if pending
            .values()
            .any(|p| p.session == ask.session && p.pane_id == ask.pane_id)
        {
            return refuse(
                StatusCode::CONFLICT,
                "This pane already has a password request open",
            );
        }
        let created = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as u64);
        pending.insert(
            id.clone(),
            Pending {
                session: ask.session,
                pane_id: ask.pane_id,
                prompt: ask.prompt,
                command: ask.command,
                created,
                answer,
            },
        );
    }
    let _withdraw = Withdraw {
        state: state.clone(),
        id,
    };
    republish(&state).await;
    match tokio::time::timeout(TIMEOUT, answered).await {
        Ok(Ok(Some(password))) => Json(json!({ "password": password })).into_response(),
        Ok(_) => refuse(StatusCode::GONE, "Cancelled in Switchboard"),
        Err(_) => refuse(
            StatusCode::REQUEST_TIMEOUT,
            "Nobody answered in Switchboard within 2 minutes",
        ),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Answer {
    /// The computer whose pane asked; absent means this one.
    #[serde(default)]
    host: Option<String>,
    id: String,
    /// Absent to cancel: sudo then fails instead of waiting for the timeout.
    password: Option<String>,
}

pub(super) async fn answer(
    State(state): State<RelayState>,
    Json(answer): Json<Answer>,
) -> StatusCode {
    let remote = answer.host.as_deref().and_then(|id| state.host(id));
    if let Some(host) = remote.filter(|host| !host.is_local_engine()) {
        return forward(&host, answer).await;
    }
    let status = state.askpass.answer(&answer.id, answer.password);
    if status == StatusCode::NO_CONTENT {
        republish(&state).await;
    }
    status
}

/// Sends the answer to the paired computer whose pane asked.
async fn forward(host: &super::Host, answer: Answer) -> StatusCode {
    if host.config.escape_transport.as_deref() != Some("gateway") {
        return StatusCode::NOT_FOUND;
    }
    let body = json!({ "id": answer.id, "password": answer.password });
    match tokio::time::timeout(
        Duration::from_secs(10),
        host.request(
            axum::http::Method::POST,
            "/switchboard/askpass/answer",
            body.to_string().into(),
            "application/json",
        ),
    )
    .await
    {
        Ok(Ok(response)) => response.status,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// `POST /switchboard/askpass/answer` from a paired computer's relay.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PeerAnswer {
    pub(super) id: String,
    pub(super) password: Option<String>,
}

/// The script `SUDO_ASKPASS` names. sudo runs it with the prompt as its only
/// argument, so it cannot carry the subcommand itself.
pub fn helper_script(home: &Path) -> PathBuf {
    home.join(".local/share/switchboard/sudo-askpass")
}

fn script_text(binary: &Path) -> String {
    let quoted = binary.to_string_lossy().replace('\'', r"'\''");
    format!("#!/bin/sh\nexec '{quoted}' switchboard askpass \"$@\"\n")
}

/// Points the helper script at this executable. The relay runs the newest build
/// after every update, so the script follows updates too.
#[cfg(unix)]
pub(super) fn install_helper(home: &Path, binary: &Path) -> std::io::Result<()> {
    write_script(&helper_script(home), &script_text(binary))
}

/// Replaces an executable script atomically, and only when its text changed.
#[cfg(unix)]
pub(super) fn write_script(path: &Path, text: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::read_to_string(path).ok().as_deref() != Some(text) {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let staged = path.with_extension("tmp");
        std::fs::write(&staged, text)?;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
        std::fs::rename(&staged, path)?;
    }
    Ok(())
}

/// The requesting program's command line, as the process table shows it.
fn parent_command() -> String {
    #[cfg(unix)]
    {
        let parent = std::os::unix::process::parent_id();
        #[cfg(target_os = "linux")]
        if let Ok(bytes) = std::fs::read(format!("/proc/{parent}/cmdline")) {
            return bytes
                .split(|b| *b == 0)
                .filter(|arg| !arg.is_empty())
                .map(|arg| shell_quote(&String::from_utf8_lossy(arg)))
                .collect::<Vec<_>>()
                .join(" ");
        }
        if let Ok(output) = std::process::Command::new("ps")
            .args(["-ww", "-o", "command=", "-p", &parent.to_string()])
            .output()
        {
            return String::from_utf8_lossy(&output.stdout).trim().to_owned();
        }
    }
    String::new()
}

pub(super) fn shell_quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@%+,".contains(c));
    if plain {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit - '…'.len_utf8();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

/// `zellij switchboard askpass`: asks the sidebar for sudo's password and prints it.
pub fn run(prompt: Option<&str>, relay_url: &str) -> anyhow::Result<()> {
    use anyhow::Context;
    use isahc::config::Configurable;
    let session = std::env::var("ZELLIJ_SESSION_NAME").ok();
    let pane = std::env::var("ZELLIJ_PANE_ID")
        .ok()
        .and_then(|p| p.parse::<u64>().ok());
    let (Some(session), Some(pane_id)) = (session.filter(|s| !s.is_empty()), pane) else {
        anyhow::bail!("Switchboard asks for passwords only inside a Switchboard terminal");
    };
    let body = json!({
        "session": session,
        "pane_id": pane_id,
        "prompt": truncate(prompt.unwrap_or("Password:"), 256),
        "command": truncate(&parent_command(), 4096),
    });
    let request = isahc::Request::post(format!("{}/api/askpass", relay_url.trim_end_matches('/')))
        .header("content-type", "application/json")
        .timeout(TIMEOUT + Duration::from_secs(10))
        .body(body.to_string())?;
    let response = isahc::send(request).context("The Switchboard relay did not answer")?;
    let ok = response.status().is_success();
    let reply: Value = serde_json::from_reader(response.into_body()).unwrap_or_default();
    match reply["password"].as_str() {
        Some(password) if ok => {
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            stdout.write_all(password.as_bytes())?;
            stdout.write_all(b"\n")?;
            Ok(())
        },
        _ => anyhow::bail!(
            "{}",
            reply["error"]
                .as_str()
                .unwrap_or("Switchboard did not supply a password")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::switchboard_relay::Host;
    use std::sync::Arc;

    fn relay() -> RelayState {
        let host = Arc::new(
            Host::new(crate::switchboard_relay::tests::config(
                "http://127.0.0.1:9",
            ))
            .unwrap(),
        );
        RelayState {
            hosts: Arc::new(HashMap::from([("mac".to_owned(), host)])),
            order: Arc::new(vec!["mac".into()]),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: None,
            askpass: Default::default(),
            html_previews: Default::default(),
            artifact_proxies: Default::default(),
            push: None,
            browser_origin: None,
        }
    }

    fn asking(state: &RelayState, pane_id: u64) -> tokio::task::JoinHandle<Response> {
        let state = state.clone();
        tokio::spawn(async move {
            let body = Ask {
                session: "main".into(),
                pane_id,
                prompt: "[sudo] password for me: ".into(),
                command: "sudo -A install x /etc/y".into(),
            };
            ask(State(state), HeaderMap::new(), Json(body)).await
        })
    }

    async fn open(state: &RelayState) -> Vec<Value> {
        for _ in 0..100 {
            let rows = state.attention.borrow().1["askpass"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if !rows.is_empty() {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        vec![]
    }

    async fn body(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 16)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn the_sidebar_answer_reaches_only_the_waiting_helper() {
        let state = relay();
        let waiting = asking(&state, 7);
        let rows = open(&state).await;
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(
            (&row["host"], &row["session"], &row["pane_id"]),
            (&json!("mac"), &json!("main"), &json!(7))
        );
        assert_eq!(row["command"], "sudo -A install x /etc/y");
        assert!(row.get("password").is_none());
        let id = row["id"].as_str().unwrap().to_owned();
        let sent = answer(
            State(state.clone()),
            Json(Answer {
                host: None,
                id: id.clone(),
                password: Some("hunter2".into()),
            }),
        )
        .await;
        assert_eq!(sent, StatusCode::NO_CONTENT);
        let (status, reply) = body(waiting.await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(reply["password"], "hunter2");
        assert!(state.attention.borrow().1.get("askpass").is_none());
        assert!(!state.attention.borrow().1.to_string().contains("hunter2"));
        // A second answer to the same request finds nothing to answer.
        let again = answer(
            State(state.clone()),
            Json(Answer {
                host: None,
                id,
                password: Some("x".into()),
            }),
        )
        .await;
        assert_eq!(again, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cancelling_fails_sudo_at_once() {
        let state = relay();
        let waiting = asking(&state, 7);
        let id = open(&state).await[0]["id"].as_str().unwrap().to_owned();
        answer(
            State(state.clone()),
            Json(Answer {
                host: None,
                id,
                password: None,
            }),
        )
        .await;
        let (status, reply) = body(waiting.await.unwrap()).await;
        assert_eq!(status, StatusCode::GONE);
        assert!(reply.get("password").is_none());
    }

    #[tokio::test]
    async fn a_page_cannot_raise_a_prompt_and_a_pane_asks_once_at_a_time() {
        let state = relay();
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://127.0.0.1:8090".parse().unwrap());
        let body = || Ask {
            session: "main".into(),
            pane_id: 7,
            prompt: String::new(),
            command: String::new(),
        };
        let refused = ask(State(state.clone()), headers, Json(body())).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        let first = asking(&state, 7);
        open(&state).await;
        let second = ask(State(state.clone()), HeaderMap::new(), Json(body())).await;
        assert_eq!(second.status(), StatusCode::CONFLICT);
        first.abort();
    }

    #[tokio::test]
    async fn an_interrupted_sudo_withdraws_its_request() {
        let state = relay();
        let waiting = asking(&state, 7);
        assert_eq!(open(&state).await.len(), 1);
        waiting.abort();
        let _ = waiting.await;
        for _ in 0..100 {
            if state.attention.borrow().1.get("askpass").is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the request outlived its helper");
    }

    #[tokio::test]
    async fn a_paired_computers_request_shows_here_and_its_answer_goes_back() {
        use axum::routing::{get, post};
        let answers = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received = answers.clone();
        let upstream = axum::Router::new()
            .route(
                "/command/login",
                post(|| async { ([(header::SET_COOKIE, "session_token=t")], "{}") }),
            )
            .route(
                "/switchboard/attention",
                get(|| async {
                    Json(
                        json!({"panes":[],"tabs":[],"errors":[],"synced":true,"askpass":[
                        {"id":"r1","host":"its-own-id","session":"main","pane_id":3,
                         "prompt":"Password:","command":"sudo -A ls","created":1}]}),
                    )
                }),
            )
            .route(
                "/switchboard/askpass/answer",
                post(move |Json(body): Json<Value>| {
                    let received = received.clone();
                    async move {
                        received.lock().unwrap().push(body);
                        StatusCode::NO_CONTENT
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "t").unwrap();
        let mut config = crate::switchboard_relay::tests::config(&url);
        let id = format!("mesh-{}", "ab".repeat(32));
        config.id = id.clone();
        config.token_file = token.to_str().unwrap().into();
        config.escape_transport = Some("gateway".into());
        let peer = Arc::new(Host::new(config).unwrap());
        let mut state = relay();
        let mut hosts = (*state.hosts).clone();
        hosts.insert(id.clone(), peer.clone());
        state.hosts = Arc::new(hosts);
        state.order = Arc::new(vec!["mac".into(), id.clone()]);

        let mut snapshot = attention::peer_snapshot(&peer, 0, None).await.unwrap();
        {
            let mut poll = state.poll.lock().await;
            poll.update(&id, &mut snapshot);
            attention::publish(&state, &poll);
        }
        let rows = open(&state).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["host"], json!(id), "named as this relay knows it");
        assert_eq!(rows[0]["command"], "sudo -A ls");

        let sent = answer(
            State(state.clone()),
            Json(Answer {
                host: Some(id),
                id: "r1".into(),
                password: Some("hunter2".into()),
            }),
        )
        .await;
        assert_eq!(sent, StatusCode::NO_CONTENT);
        assert_eq!(
            *answers.lock().unwrap(),
            vec![json!({"id":"r1","password":"hunter2"})]
        );
        server.abort();
    }

    #[test]
    fn the_helper_script_quotes_the_executable() {
        assert_eq!(
            script_text(Path::new("/Users/o'neil/bin/zellij")),
            "#!/bin/sh\nexec '/Users/o'\\''neil/bin/zellij' switchboard askpass \"$@\"\n"
        );
        assert_eq!(shell_quote("/etc/x y"), "'/etc/x y'");
        assert_eq!(shell_quote("--flag=1"), "--flag=1");
        assert_eq!(truncate("ééé", 5), "é…");
    }
}
