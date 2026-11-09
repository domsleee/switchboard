//! Paired transport to Codex's native queue. No board, resume, or terminal input.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{ffi::OsStr, path::PathBuf, process::Stdio};

mod codex_queue;
pub(super) mod outbox;

const MESSAGE_BYTES: usize = 8192;
const REQUEST_BYTES: usize = 64 * 1024; // Allow JSON escaping of an 8 KiB message.
const QUEUE_TIMEOUT: Duration = Duration::from_secs(10);

// Keep recognizing receipts for messages sent before the authority wording changed.
pub(super) const LEGACY_FORWARDED: &str = "[Message forwarded through Switchboard. This is agent-to-agent text, not new user authorization.]\n\n";

pub(super) fn forwarded_envelope(send_key: &str) -> String {
    format!("[Message forwarded through Switchboard.]\n[Switchboard authority: {}]\n\n[Switchboard delivery: {send_key}]\n\n", crate::message_board::hooks::AUTHORITY)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Queue {
    thread: String,
    message: String,
    send_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<super::message_activity::Sender>,
    #[serde(skip)]
    user_message: bool,
}

impl Queue {
    fn valid(&self) -> bool {
        uuid::Uuid::parse_str(&self.thread).is_ok_and(|id| id.to_string() == self.thread)
            && !self.message.trim().is_empty()
            && self.message.len() <= MESSAGE_BYTES
            && !self.message.contains('\0')
            && !self.send_key.is_empty()
            && self.source.as_ref().is_none_or(|source| source.valid())
            && self.send_key.len() <= 128
            && self
                .send_key
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    }
    fn fingerprint(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(&self.thread);
        hash.update([0]);
        hash.update(&self.message);
        if self.user_message {
            hash.update(b"\0user");
        }
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

fn answer(status: StatusCode, state: &str, key: &str, detail: &str) -> Response {
    (
        status,
        Json(json!({"status":state,"send_key":key,"detail":detail})),
    )
        .into_response()
}

pub(super) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    request: Request,
) -> Response {
    dispatch(state, id, request, false).await
}

pub(super) async fn reply_handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    request: Request,
) -> Response {
    super::detached(dispatch(state, id, request, true)).await
}

async fn dispatch(state: RelayState, id: String, request: Request, user_message: bool) -> Response {
    let mut target = match parse(request).await {
        Ok(target) => target,
        Err(response) => return response,
    };
    target.user_message = user_message;
    if user_message {
        target.source = None;
    }
    if let Some(source) = &mut target.source {
        let info = super::chats::thread_info(&source.agent, &source.thread);
        source.chat_id = info["chat_id"].as_str().map(str::to_owned);
        source.label = info["label"].as_str().unwrap_or("Agent").to_owned();
        if let Some(mesh) = &state.mesh {
            source.host = mesh.computer_host().await.unwrap_or_default();
            source.computer = mesh.computer_name().await.unwrap_or_default();
        }
    }
    let host = if id == "local" {
        state
            .hosts
            .values()
            .find(|host| host.is_local_engine())
            .cloned()
    } else {
        state.host(&id)
    };
    let Some(host) = host else {
        return answer(
            StatusCode::NOT_FOUND,
            "failed",
            &target.send_key,
            "Unknown computer",
        );
    };
    if host.config.escape_transport.as_deref() != Some("gateway") && !host.is_local_engine() {
        return answer(
            StatusCode::BAD_REQUEST,
            "failed",
            &target.send_key,
            "Computer is not local or paired",
        );
    }
    let home = std::env::home_dir();
    let event_id = format!("native:{}:{}", host.config.id, target.send_key);
    let mut peer = if host.is_local_engine() {
        super::chats::thread_info("codex", &target.thread)
    } else {
        json!({"label":"Codex"})
    };
    peer["host"] = json!(host.config.id);
    peer["computer"] = json!(host.config.name);
    peer["thread"] = json!(target.thread);
    if let (Some(home), Some(source)) = (&home, &target.source) {
        if super::message_activity::record_async(
            home,
            &source.thread,
            &event_id,
            "sent",
            "sending",
            &target.message,
            &peer,
        )
        .await
        .is_err()
        {
            return answer(
                StatusCode::SERVICE_UNAVAILABLE,
                "failed",
                &target.send_key,
                "Cannot save message activity; nothing submitted",
            );
        }
    }
    let response = if host.config.escape_transport.as_deref() == Some("gateway") {
        forward(&host, &target).await
    } else {
        local(target.clone()).await
    };
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, REQUEST_BYTES).await.unwrap_or_default();
    if let (Some(home), Some(source)) = (&home, &target.source) {
        let result = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
        if let Some(info) = result["recipient"].as_object() {
            for (key, value) in info {
                peer[key] = value.clone();
            }
        }
        let status = result["status"].as_str().unwrap_or("unknown");
        let _ = super::message_activity::record_async(
            home,
            &source.thread,
            &event_id,
            "sent",
            status,
            &target.message,
            &peer,
        )
        .await;
    }
    Response::from_parts(parts, Body::from(bytes))
}

async fn forward(host: &Host, target: &Queue) -> Response {
    let path = if target.user_message {
        "/switchboard/codex/reply"
    } else {
        "/switchboard/codex/queue"
    };
    let body: Bytes = serde_json::to_vec(target).unwrap().into();
    // A connection can disappear after the destination has queued the message.
    // Its durable receipt makes this exact request safe to repeat. Keep both
    // attempts inside the original deadline, below the browser's send timeout.
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        match host
            .request(Method::POST, path, body.clone(), "application/json")
            .await
        {
            Ok(response) => Ok(response),
            Err(error) => {
                logs::record(
                    &host.config.name,
                    &format!("Message confirmation lost; retrying the same delivery: {error:#}"),
                );
                host.request(Method::POST, path, body, "application/json")
                    .await
            },
        }
    })
    .await;
    match result {
        Ok(Ok(response)) => (
            response.status,
            [(header::CONTENT_TYPE, "application/json")],
            response.body,
        )
            .into_response(),
        result => {
            let reason = match result {
                Ok(Err(error)) => format!("{error:#}"),
                Err(_) => "Timed out after 20 seconds".into(),
                Ok(Ok(_)) => unreachable!(),
            };
            logs::record(
                &host.config.name,
                &format!(
                    "Message delivery unconfirmed ({}): {reason}",
                    target.send_key
                ),
            );
            answer(
                StatusCode::BAD_GATEWAY,
                "unknown",
                &target.send_key,
                "Delivery is not confirmed. Retry to check or send this same message safely.",
            )
        },
    }
}

#[derive(Deserialize)]
pub(super) struct ReceiptQuery {
    thread: String,
    send_key: String,
}
impl ReceiptQuery {
    fn valid(&self) -> bool {
        Queue {
            thread: self.thread.clone(),
            send_key: self.send_key.clone(),
            message: "receipt".into(),
            source: None,
            user_message: false,
        }
        .valid()
    }
}
async fn receipt_status(query: ReceiptQuery, discard: bool) -> Response {
    if !query.valid() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let result = tokio::task::spawn_blocking(move || {
        let home = std::env::home_dir()?;
        if discard {
            if outbox::discard(&home, &query.thread, &query.send_key).is_err() {
                return None;
            }
            return Some(outbox::status(&home, &query.thread, &query.send_key).unwrap_or_else(|| json!({"status":"unknown"})));
        }
        if let Some(status) = outbox::status(&home, &query.thread, &query.send_key) {
            return Some(status);
        }
        let status = super::message_activity::incoming_status(&home,&query.thread,&query.send_key)?;
        Some(json!({"status":if matches!(status.as_str(),"queued"|"unknown") && super::chats::native_message_received(&query.thread,&query.send_key) {"received"} else {&status}}))
    }).await.ok().flatten().unwrap_or_else(||json!({"status":"unknown"}));
    Json(result).into_response()
}
pub(super) async fn receipt_handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    method: Method,
    axum::extract::Query(query): axum::extract::Query<ReceiptQuery>,
) -> Response {
    if !query.valid() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let host = if id == "local" {
        state
            .hosts
            .values()
            .find(|host| host.is_local_engine())
            .cloned()
    } else {
        state.host(&id)
    };
    let Some(host) = host else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let path = format!(
            "/switchboard/codex/{}?thread={}&send_key={}",
            if method == Method::DELETE {
                "reply"
            } else {
                "receipt"
            },
            query.thread,
            query.send_key
        );
        return match host
            .request(method, &path, Bytes::new(), "application/json")
            .await
        {
            Ok(response) => (
                response.status,
                [(header::CONTENT_TYPE, "application/json")],
                response.body,
            )
                .into_response(),
            Err(_) => Json(json!({"status":"unknown"})).into_response(),
        };
    }
    if !host.is_local_engine() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if method == Method::DELETE && !outbox::writable_host(&host).await {
        return StatusCode::FORBIDDEN.into_response();
    }
    receipt_status(query, method == Method::DELETE).await
}
pub(super) async fn gateway_receipt(request: Request) -> Response {
    let Ok(axum::extract::Query(query)) =
        axum::extract::Query::<ReceiptQuery>::try_from_uri(request.uri())
    else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    receipt_status(query, request.method() == Method::DELETE).await
}

async fn parse(request: Request) -> Result<Queue, Response> {
    let bytes = to_bytes(request.into_body(), REQUEST_BYTES)
        .await
        .map_err(|_| {
            answer(
                StatusCode::BAD_REQUEST,
                "failed",
                "",
                "Request is too large",
            )
        })?;
    serde_json::from_slice::<Queue>(&bytes).ok().filter(Queue::valid)
        .ok_or_else(|| answer(StatusCode::BAD_REQUEST, "failed", "", "Expected a canonical thread UUID, 1–8192 message bytes without NUL, and a 1–128 character send_key (letters, numbers, dash, underscore or dot)"))
}

pub(super) async fn gateway(request: Request) -> Response {
    match parse(request).await {
        Ok(target) => local(target).await,
        Err(response) => response,
    }
}

pub(super) async fn gateway_reply(request: Request) -> Response {
    match parse(request).await {
        Ok(mut target) => {
            target.user_message = true;
            local(target).await
        },
        Err(response) => response,
    }
}

async fn local(target: Queue) -> Response {
    let Some(home) = std::env::home_dir() else {
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "failed",
            &target.send_key,
            "Account home unavailable",
        );
    };
    if target.user_message {
        return outbox::accept(&home, target).await;
    }
    let (program, path) = agent_setup::codex_queue_program()
        .map(|(program, path)| (Some(program), path))
        .unwrap_or_default();
    local_with_program(&home, program, &path, target).await
}

async fn local_with_program(
    home: &Path,
    program: Option<PathBuf>,
    path: &OsStr,
    target: Queue,
) -> Response {
    let receipt_path = home.join(".config/switchboard/native-messages.sqlite3");
    let response = deliver(receipt_path, program, path, home, target.clone()).await;
    let (parts, body) = response.into_parts();
    let bytes = to_bytes(body, REQUEST_BYTES).await.unwrap_or_default();
    let mut result = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
    if !result.is_null() {
        result["recipient"] = super::chats::thread_info("codex", &target.thread);
    }
    if !target.user_message && matches!(result["status"].as_str(), Some("queued" | "unknown")) {
        let peer = target
            .source
            .as_ref()
            .map(|source| serde_json::to_value(source).unwrap())
            .unwrap_or_else(|| json!({"label":"Agent"}));
        let event_id = format!("native:{}", target.send_key);
        if super::message_activity::record_async(
            &home,
            &target.thread,
            &event_id,
            "received",
            result["status"].as_str().unwrap(),
            &target.message,
            &peer,
        )
        .await
        .is_err()
        {
            logs::record("Messages", "Could not save incoming message activity");
        }
    }
    Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&result).unwrap_or(bytes.to_vec())),
    )
}

// A committed reservation precedes the external side effect. A crash between queueing
// and storing its result remains unknown, never automatically resubmitted. Store only
// a payload hash and outcome, not messages or Codex output. Receipts survive restarts.
fn reserve(path: &Path, target: &Queue) -> anyhow::Result<Option<String>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(2))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS receipts (send_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL)")?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT fingerprint, status FROM receipts WHERE send_key=?1",
            [&target.send_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((fingerprint, status)) = existing {
        return Ok(Some(if fingerprint == target.fingerprint() {
            status
        } else {
            "conflict".into()
        }));
    }
    tx.execute(
        "INSERT INTO receipts VALUES (?1, ?2, 'unknown')",
        params![target.send_key, target.fingerprint()],
    )?;
    tx.commit()?;
    Ok(None)
}

fn receipt(state: &str, key: &str) -> Response {
    match state {
        "queued" => answer(StatusCode::OK, state, key, "Accepted by Codex's native queue; not confirmation that the agent read it"),
        "conflict" => answer(StatusCode::CONFLICT, state, key, "This send_key was already used with different content"),
        "failed" => answer(StatusCode::BAD_GATEWAY, state, key, "Could not start Codex; check the destination installation (standalone codex.exe required on Windows)"),
        _ => answer(StatusCode::CONFLICT, "unknown", key, "Queue outcome is uncertain or still in progress; this key will not submit again. Check the destination conversation and Codex queue support"),
    }
}

async fn deliver(
    db_path: PathBuf,
    program: Option<PathBuf>,
    path: &OsStr,
    home: &Path,
    target: Queue,
) -> Response {
    let db = db_path.clone();
    let request = target.clone();
    match tokio::task::spawn_blocking(move || reserve(&db, &request)).await {
        Ok(Ok(Some(status))) => return receipt(&status, &target.send_key),
        Ok(Ok(None)) => {},
        _ => {
            return answer(
                StatusCode::SERVICE_UNAVAILABLE,
                "failed",
                &target.send_key,
                "Cannot reserve delivery receipt; nothing submitted",
            )
        },
    }
    let status = if let Some(program) = program {
        let mut command = tokio::process::Command::new(program);
        let message = if target.user_message {
            target.message.clone()
        } else {
            format!("{}{}", forwarded_envelope(&target.send_key), target.message)
        };
        // One argument, so a reply starting with "-" is not parsed as a flag.
        let message = format!("--message={message}");
        command
            .args(["queue", "--thread", &target.thread, &message])
            .env("PATH", path)
            .current_dir(home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Do not inherit the sending agent's identity into a child launched by the relay.
        for key in [
            "CODEX_THREAD_ID",
            "ZELLIJ_SESSION_NAME",
            "ZELLIJ_PANE_ID",
            "CLAUDECODE",
        ] {
            command.env_remove(key);
        }
        match command.spawn() {
            Err(_) => "failed",
            Ok(mut child) => match tokio::time::timeout(QUEUE_TIMEOUT, child.wait()).await {
                Ok(Ok(exit)) if exit.success() => "queued",
                _ => "unknown", // A nonzero exit or timeout does not prove absence of a side effect.
            },
        }
    } else {
        "failed"
    };
    let key = target.send_key.clone();
    let stored = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let db = Connection::open(db_path)?;
        db.busy_timeout(Duration::from_secs(2))?;
        db.execute(
            "UPDATE receipts SET status=?1 WHERE send_key=?2",
            params![status, key],
        )?;
        Ok(())
    })
    .await;
    if !matches!(stored, Ok(Ok(()))) {
        return receipt("unknown", &target.send_key);
    }
    receipt(status, &target.send_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn target() -> Queue {
        Queue {
            thread: "00000000-0000-4000-8000-000000000001".into(),
            message: "Hello \"world\"; $(touch injected)\n你好".into(),
            send_key: "fixture-1".into(),
            source: None,
            user_message: false,
        }
    }

    async fn value(response: Response) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap()
    }

    #[test]
    fn switchboard_native_messages_validate_before_execution() {
        assert!(target().valid());
        for thread in ["--help", "codex-opaque", "friendly name", "../session"] {
            assert!(!Queue {
                thread: thread.into(),
                ..target()
            }
            .valid());
        }
        for message in [
            "".into(),
            "  \n".into(),
            "x\0y".into(),
            "x".repeat(MESSAGE_BYTES + 1),
        ] {
            assert!(!Queue {
                message,
                ..target()
            }
            .valid());
        }
        for send_key in ["", "../key", "space key"] {
            assert!(!Queue {
                send_key: send_key.into(),
                ..target()
            }
            .valid());
        }
        assert!(Queue {
            message: "x".repeat(MESSAGE_BYTES),
            ..target()
        }
        .valid());
    }

    #[test]
    fn switchboard_native_messages_reservation_survives_reopen_and_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("receipts.sqlite3");
        assert_eq!(reserve(&db, &target()).unwrap(), None);
        assert_eq!(reserve(&db, &target()).unwrap().as_deref(), Some("unknown"));
        assert_eq!(
            reserve(
                &db,
                &Queue {
                    message: "different".into(),
                    ..target()
                }
            )
            .unwrap()
            .as_deref(),
            Some("conflict")
        );
        assert_eq!(
            reserve(
                &db,
                &Queue {
                    thread: uuid::Uuid::new_v4().to_string(),
                    ..target()
                }
            )
            .unwrap()
            .as_deref(),
            Some("conflict")
        );
    }

    #[tokio::test]
    async fn switchboard_native_messages_receipt_activity_survives_retry_without_resubmitting() {
        let home = tempfile::tempdir().unwrap();
        let db = home
            .path()
            .join(".config/switchboard/native-messages.sqlite3");
        let mut request = target();
        request.source = Some(super::super::message_activity::Sender {
            agent: "codex".into(),
            thread: "00000000-0000-4000-8000-000000000002".into(),
            label: "Project setup".into(),
            computer: "Laptop".into(),
            host: "mesh-fixture".into(),
            ..Default::default()
        });
        // Attribution is metadata: upgrading a CLI must still recover an older receipt.
        assert_eq!(request.fingerprint(), target().fingerprint());
        assert!(request.valid());
        assert_eq!(reserve(&db, &target()).unwrap(), None);
        Connection::open(&db)
            .unwrap()
            .execute("UPDATE receipts SET status='queued'", [])
            .unwrap();
        for _ in 0..2 {
            let result =
                value(local_with_program(home.path(), None, OsStr::new(""), request.clone()).await)
                    .await;
            assert_eq!(result["status"], "queued");
        }
        let activity = Connection::open(
            home.path()
                .join(".config/switchboard/message-activity.sqlite3"),
        )
        .unwrap();
        let (count, body, peer): (u64, String, String) = activity
            .query_row("SELECT count(*),text,peer FROM activity", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(body, request.message);
        assert_eq!(
            serde_json::from_str::<Value>(&peer).unwrap()["label"],
            "Project setup"
        );
        request.source.as_mut().unwrap().thread = "../outside".into();
        assert!(!request.valid());
    }

    #[cfg(unix)]
    fn fake_codex(dir: &Path, exit: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("codex");
        std::fs::write(
            &program,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> calls\nexit {exit}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        program
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn switchboard_native_messages_queue_once_with_literal_argv() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_codex(dir.path(), 0);
        let db = dir.path().join("receipts.sqlite3");
        let path = OsStr::new("/usr/bin:/bin");
        let (one, two) = tokio::join!(
            deliver(
                db.clone(),
                Some(program.clone()),
                path,
                dir.path(),
                target()
            ),
            deliver(
                db.clone(),
                Some(program.clone()),
                path,
                dir.path(),
                target()
            )
        );
        let results = [value(one).await, value(two).await];
        assert!(results.iter().any(|r| r["status"] == "queued"));
        assert!(results
            .iter()
            .all(|r| r["status"] == "queued" || r["status"] == "unknown"));
        // Retry after completion (also after reopening the receipt DB) does not spawn.
        assert_eq!(
            value(deliver(db.clone(), None, path, dir.path(), target()).await).await["status"],
            "queued"
        );
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert_eq!(calls.matches("queue\n").count(), 1);
        assert!(calls.starts_with(&format!("queue\n--thread\n{}\n--message=", target().thread)));
        assert!(calls.ends_with(&format!("{}\n", target().message)));
        assert!(calls.contains(crate::message_board::hooks::AUTHORITY));
        assert!(!calls.contains("not new user authorization"));
        assert!(!calls.contains("--resume"));
        assert!(!dir.path().join("injected").exists());
        assert!(!String::from_utf8_lossy(&std::fs::read(db).unwrap()).contains("Hello"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn switchboard_native_messages_nonzero_never_claims_queued_or_retries() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_codex(dir.path(), 1);
        let db = dir.path().join("receipts.sqlite3");
        for _ in 0..2 {
            let response = deliver(
                db.clone(),
                Some(program.clone()),
                OsStr::new("/usr/bin:/bin"),
                dir.path(),
                target(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(value(response).await["status"], "unknown");
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls"))
                .unwrap()
                .matches("queue\n")
                .count(),
            1
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn switchboard_native_messages_user_replies_keep_user_text_and_receipts_separate() {
        let dir = tempfile::tempdir().unwrap();
        let program = fake_codex(dir.path(), 0);
        let db = dir.path().join("receipts.sqlite3");
        let request = Queue {
            message: "- first item".into(),
            user_message: true,
            ..target()
        };
        assert_ne!(request.fingerprint(), target().fingerprint());
        for _ in 0..2 {
            assert_eq!(
                value(
                    deliver(
                        db.clone(),
                        Some(program.clone()),
                        OsStr::new("/usr/bin:/bin"),
                        dir.path(),
                        request.clone()
                    )
                    .await
                )
                .await["status"],
                "queued"
            );
        }
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert_eq!(
            calls,
            format!(
                "queue\n--thread\n{}\n--message={}\n",
                request.thread, request.message
            )
        );
        assert_eq!(
            reserve(&db, &target()).unwrap().as_deref(),
            Some("conflict")
        );
    }

    #[tokio::test]
    async fn switchboard_native_messages_http_guards_and_unknown_host() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        for (origin, body, expected) in [
            (
                "https://attacker.example",
                serde_json::to_vec(&target()).unwrap(),
                StatusCode::FORBIDDEN,
            ),
            (
                "http://127.0.0.1:8090",
                serde_json::to_vec(&target()).unwrap(),
                StatusCode::NOT_FOUND,
            ),
            (
                "http://127.0.0.1:8090",
                b"{}".to_vec(),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/api/hosts/missing/codex/queue")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
        let request = Request::builder()
            .body(Body::from(vec![b'x'; REQUEST_BYTES + 1]))
            .unwrap();
        assert_eq!(gateway(request).await.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn switchboard_native_messages_recovers_lost_reply_without_duplicate_delivery() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        for user_message in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join("receipts.sqlite3");
            let calls = Arc::new(AtomicUsize::new(0));
            let deliveries = Arc::new(AtomicUsize::new(0));
            let (requests, submitted) = (calls.clone(), deliveries.clone());
            let expected = Queue {
                user_message,
                ..target()
            };
            let original = expected.clone();
            let path = if user_message {
                "/switchboard/codex/reply"
            } else {
                "/switchboard/codex/queue"
            };
            let app = Router::new().route(
                path,
                post(move |Json(mut actual): Json<Queue>| {
                    let (db, calls, deliveries, expected) = (
                        db.clone(),
                        calls.clone(),
                        deliveries.clone(),
                        expected.clone(),
                    );
                    async move {
                        actual.user_message = user_message;
                        assert_eq!(
                            serde_json::to_value(&actual).unwrap(),
                            serde_json::to_value(&expected).unwrap()
                        );
                        let status = reserve(&db, &actual).unwrap();
                        if status.is_none() {
                            deliveries.fetch_add(1, Ordering::SeqCst);
                            Connection::open(&db)
                                .unwrap()
                                .execute(
                                    "UPDATE receipts SET status='queued' WHERE send_key=?1",
                                    [&actual.send_key],
                                )
                                .unwrap();
                        }
                        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            // The destination accepted the message, but its HTTP response is lost.
                            Body::from_stream(futures_util::stream::once(async {
                                Err::<Bytes, _>(std::io::Error::other("lost confirmation"))
                            }))
                            .into_response()
                        } else {
                            receipt(status.as_deref().unwrap(), &actual.send_key)
                        }
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let host = Host::new(HostConfig {
                id: "peer".into(),
                name: "Fixture".into(),
                url: format!("http://{address}"),
                token_file: "unused".into(),
                gateway_token_file: None,
                tls_fingerprint: None,
                artifact_urls: Value::Null,
                escape_transport: Some("gateway".into()),
                zellij_binary: None,
                hostname: None,
                address: None,
            })
            .unwrap();
            *host.cookie.lock().await = Some("session_token=fixture".into());
            let response = forward(&host, &original).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(value(response).await["status"], "queued");
            assert_eq!(requests.load(Ordering::SeqCst), 2);
            assert_eq!(submitted.load(Ordering::SeqCst), 1);
            server.abort();
        }
    }

    #[tokio::test]
    async fn switchboard_native_messages_forwards_to_destination() {
        let expected = target();
        let app = Router::new().route(
            "/switchboard/codex/queue",
            post(move |Json(actual): Json<Queue>| {
                let expected = expected.clone();
                async move {
                    assert_eq!(actual.thread, expected.thread);
                    assert_eq!(actual.message, expected.message);
                    assert_eq!(actual.send_key, expected.send_key);
                    receipt("queued", &actual.send_key)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let host = Host::new(HostConfig {
            id: "peer".into(),
            name: "Fixture".into(),
            url: format!("http://{address}"),
            token_file: "unused".into(),
            gateway_token_file: None,
            tls_fingerprint: None,
            artifact_urls: Value::Null,
            escape_transport: Some("gateway".into()),
            zellij_binary: None,
            hostname: None,
            address: None,
        })
        .unwrap();
        *host.cookie.lock().await = Some("session_token=fixture".into());
        let response = forward(&host, &target()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(value(response).await["status"], "queued");
        server.abort();
        let response = forward(&host, &target()).await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(value(response).await["status"], "unknown");
    }
}
