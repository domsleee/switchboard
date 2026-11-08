//! Conversation-visible receipts, separate from provider history and its cursors.
use super::*;
use rusqlite::{params, Connection};
use std::sync::{LazyLock, Mutex as SyncMutex};
use std::{path::PathBuf, time::Instant};

#[derive(Clone, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Sender {
    pub agent: String,
    pub thread: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub computer: String,
    #[serde(default)]
    pub host: String,
}
impl Sender {
    pub fn valid(&self) -> bool {
        matches!(self.agent.as_str(), "codex" | "claude" | "copilot")
            && uuid::Uuid::parse_str(&self.thread).is_ok_and(|id| id.to_string() == self.thread)
            && self.label.len() <= 512
            && self.computer.len() <= 512
            && self.host.len() <= 256
            && self.chat_id.as_ref().is_none_or(|id| id.len() <= 256)
    }
}

fn database(home: &Path) -> PathBuf {
    home.join(".config/switchboard/message-activity.sqlite3")
}

pub(super) fn record(
    home: &Path,
    thread: &str,
    id: &str,
    direction: &str,
    status: &str,
    text: &str,
    peer: &Value,
) -> anyhow::Result<()> {
    let path = database(home);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let db = Connection::open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    db.busy_timeout(Duration::from_secs(2))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS activity (thread TEXT NOT NULL, id TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL, peer TEXT NOT NULL, timestamp INTEGER NOT NULL, PRIMARY KEY(thread,id)); CREATE INDEX IF NOT EXISTS activity_thread_time ON activity(thread,timestamp)")?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    let changed = db.execute("INSERT INTO activity VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(thread,id) DO UPDATE SET status=CASE WHEN activity.status='received' THEN activity.status ELSE excluded.status END,peer=excluded.peer WHERE activity.text=excluded.text AND json_extract(activity.peer,'$.thread') IS json_extract(excluded.peer,'$.thread')", params![thread,id,direction,status,text,peer.to_string(),timestamp])?;
    anyhow::ensure!(
        changed == 1,
        "Message activity key already belongs to different content"
    );
    Ok(())
}

fn read(home: &Path, thread: &str) -> anyhow::Result<Vec<Value>> {
    let path = database(home);
    if !path.exists() {
        return Ok(vec![]);
    }
    let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_millis(100))?;
    let mut query = db.prepare("SELECT id,direction,status,text,peer,timestamp FROM activity WHERE thread=?1 ORDER BY timestamp DESC,id DESC LIMIT 201")?;
    let mut events = query.query_map([thread], |row| {
        let peer: String = row.get(4)?;
        Ok(json!({"id":row.get::<_,String>(0)?,"direction":row.get::<_,String>(1)?,"status":row.get::<_,String>(2)?,"text":row.get::<_,String>(3)?,"peer":serde_json::from_str::<Value>(&peer).unwrap_or(Value::Null),"timestamp":row.get::<_,u64>(5)?}))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    events.reverse();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    for event in &mut events {
        if event["status"] == "sending"
            && now.saturating_sub(event["timestamp"].as_u64().unwrap_or(now)) > 30000
        {
            event["status"] = json!("unknown");
        }
    }
    Ok(events)
}

pub(super) fn incoming_status(home: &Path, thread: &str, key: &str) -> Option<String> {
    let db =
        Connection::open_with_flags(database(home), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    db.busy_timeout(Duration::from_millis(100)).ok()?;
    db.query_row(
        "SELECT status FROM activity WHERE thread=?1 AND id=?2 AND direction='received'",
        params![thread, format!("native:{key}")],
        |row| row.get(0),
    )
    .ok()
}

fn poll_native(home: &Path, thread: &str, events: &[Value], offset: usize) {
    let Ok(client) = crate::message_board::cli::Client::activity_relay() else {
        return;
    };
    poll_native_with_client(home, thread, events, &client, offset);
}
fn poll_native_with_client(
    home: &Path,
    thread: &str,
    events: &[Value],
    client: &crate::message_board::cli::Client,
    offset: usize,
) {
    // GET can inspect an uncertain send without submitting it again.
    let pending: Vec<_> = events
        .iter()
        .rev()
        .filter(|event| {
            event["direction"] == "sent"
                && matches!(event["status"].as_str(), Some("queued" | "unknown"))
        })
        .collect();
    if pending.is_empty() {
        return;
    }
    // Rotate batches so offline destinations cannot starve another receipt.
    for event in pending
        .iter()
        .cycle()
        .skip(offset % pending.len())
        .take(pending.len().min(4))
    {
        let (Some(host), Some(target), Some(id)) = (
            event["peer"]["host"].as_str(),
            event["peer"]["thread"].as_str(),
            event["id"].as_str(),
        ) else {
            continue;
        };
        let key = id.rsplit(':').next().unwrap_or_default();
        let path = format!(
            "api/hosts/{}/codex/receipt?thread={}&send_key={}",
            urlencoding::encode(host),
            urlencoding::encode(target),
            urlencoding::encode(key)
        );
        if let Ok((200, result)) = client.request_path("GET", &path, None) {
            if result["status"] == "received" {
                let _ = record(
                    home,
                    thread,
                    id,
                    "sent",
                    "received",
                    event["text"].as_str().unwrap_or_default(),
                    &event["peer"],
                );
            }
        }
    }
}

pub(super) async fn record_async(
    home: &Path,
    thread: &str,
    id: &str,
    direction: &str,
    status: &str,
    text: &str,
    peer: &Value,
) -> anyhow::Result<()> {
    let (home, thread, id, direction, status, text, peer) = (
        home.to_path_buf(),
        thread.to_owned(),
        id.to_owned(),
        direction.to_owned(),
        status.to_owned(),
        text.to_owned(),
        peer.clone(),
    );
    tokio::task::spawn_blocking(move || {
        record(&home, &thread, &id, &direction, &status, &text, &peer)
    })
    .await?
}

#[derive(Default)]
struct Cached {
    checked: Option<Instant>,
    pending: bool,
    value: Value,
    unavailable: bool,
    receipt_offset: usize,
}
static BOARD: LazyLock<SyncMutex<HashMap<String, Cached>>> = LazyLock::new(Default::default);

/// Outside the transcript index cache: receipts update even while history is idle.
pub(super) fn enrich(page: &mut Value) {
    let (Some(agent), Some(thread)) = (page["agent"].as_str(), page["session_id"].as_str()) else {
        return;
    };
    let (agent, thread) = (agent.to_owned(), thread.to_owned());
    let mut events = std::env::home_dir()
        .and_then(|home| read(&home, &thread).ok())
        .unwrap_or_default();
    let native_partial = events.len() > 200;
    if native_partial {
        events.remove(0);
    }
    let native_count = events.len();
    let key = format!("{agent}:{thread}");
    let mut cache = BOARD.lock().unwrap();
    if cache.len() >= 32 && !cache.contains_key(&key) {
        cache.retain(|_, value| value.pending);
    }
    let entry = cache.entry(key.clone()).or_default();
    if let Some(items) = entry.value["items"].as_array() {
        events.extend(items.iter().cloned());
    }
    let partial = native_partial || entry.value["truncated"] == true;
    let unavailable = entry.unavailable;
    if !entry.pending
        && entry
            .checked
            .is_none_or(|at| at.elapsed() >= Duration::from_secs(2))
    {
        let native_events = events[..native_count].to_vec();
        let receipt_offset = entry.receipt_offset;
        entry.receipt_offset = entry.receipt_offset.wrapping_add(4);
        entry.pending = true;
        tokio::task::spawn_blocking(move || {
            let result = crate::message_board::conversation_activity(&agent, &thread);
            {
                let mut cache = BOARD.lock().unwrap();
                let entry = cache.entry(key.clone()).or_default();
                entry.unavailable = result.is_err();
                if let Ok(value) = result {
                    entry.value = value;
                }
            }
            if let Some(home) = std::env::home_dir() {
                poll_native(&home, &thread, &native_events, receipt_offset);
            }
            let mut cache = BOARD.lock().unwrap();
            let entry = cache.entry(key).or_default();
            entry.pending = false;
            entry.checked = Some(Instant::now());
        });
    }
    drop(cache);
    events.sort_by_key(|event| event["timestamp"].as_u64().unwrap_or(0));
    page["message_activity"] = json!(events);
    page["message_activity_partial"] = json!(partial);
    page["message_activity_unavailable"] = json!(unavailable);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_message_activity_follows_confirmed_receipts_with_get_and_never_requeues() {
        use std::io::{BufRead, BufReader, Write};
        let home = tempfile::tempdir().unwrap();
        let peer = json!({"host":"fixture","thread":"00000000-0000-4000-8000-000000000001"});
        record(
            home.path(),
            "source",
            "native:fixture:confirmed",
            "sent",
            "queued",
            "Hello",
            &peer,
        )
        .unwrap();
        record(
            home.path(),
            "source",
            "native:fixture:uncertain",
            "sent",
            "unknown",
            "Maybe",
            &peer,
        )
        .unwrap();
        for key in ["extra-1", "extra-2", "extra-3"] {
            record(
                home.path(),
                "source",
                &format!("native:fixture:{key}"),
                "sent",
                "queued",
                "Waiting",
                &peer,
            )
            .unwrap();
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..8 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                assert!(first.starts_with("GET /api/hosts/fixture/codex/receipt?thread=00000000-0000-4000-8000-000000000001&send_key="));
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                let body = if first.contains("send_key=confirmed ") {
                    r#"{"status":"received"}"#
                } else {
                    r#"{"status":"unknown"}"#
                };
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
            }
        });
        let client =
            crate::message_board::cli::Client::relay(&format!("http://{address}")).unwrap();
        poll_native_with_client(
            home.path(),
            "source",
            &read(home.path(), "source").unwrap(),
            &client,
            0,
        );
        // The first batch contains newer pending sends. The next must reach the older one.
        poll_native_with_client(
            home.path(),
            "source",
            &read(home.path(), "source").unwrap(),
            &client,
            4,
        );
        server.join().unwrap();
        let events = read(home.path(), "source").unwrap();
        assert_eq!(
            events
                .iter()
                .find(|event| event["id"] == "native:fixture:confirmed")
                .unwrap()["status"],
            "received"
        );
        assert_eq!(
            events
                .iter()
                .find(|event| event["id"] == "native:fixture:uncertain")
                .unwrap()["status"],
            "unknown"
        );
    }
    #[test]
    fn switchboard_message_activity_retries_update_without_duplicate_or_reordering() {
        let home = tempfile::tempdir().unwrap();
        let peer = json!({"label":"Remote task","computer":"Work PC"});
        record(
            home.path(),
            "thread",
            "native:peer:key",
            "sent",
            "sending",
            "Hello\nworld",
            &peer,
        )
        .unwrap();
        let first = read(home.path(), "thread").unwrap();
        record(
            home.path(),
            "thread",
            "native:peer:key",
            "sent",
            "queued",
            "Hello\nworld",
            &peer,
        )
        .unwrap();
        let events = read(home.path(), "thread").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["timestamp"], first[0]["timestamp"]);
        assert_eq!(events[0]["status"], "queued");
        assert_eq!(events[0]["text"], "Hello\nworld");
        assert!(record(
            home.path(),
            "thread",
            "native:peer:key",
            "sent",
            "sending",
            "Changed body",
            &peer
        )
        .is_err());
        assert_eq!(read(home.path(), "thread").unwrap()[0]["status"], "queued");
        record(
            home.path(),
            "thread",
            "native:peer:key",
            "sent",
            "received",
            "Hello\nworld",
            &peer,
        )
        .unwrap();
        record(
            home.path(),
            "thread",
            "native:peer:key",
            "sent",
            "queued",
            "Hello\nworld",
            &peer,
        )
        .unwrap();
        assert_eq!(
            read(home.path(), "thread").unwrap()[0]["status"],
            "received"
        );
        assert!(read(home.path(), "another-thread").unwrap().is_empty());
        record(
            home.path(),
            "thread",
            "native:other:key",
            "sent",
            "failed",
            "Different peer",
            &peer,
        )
        .unwrap();
        assert_eq!(read(home.path(), "thread").unwrap().len(), 2);
    }
}
