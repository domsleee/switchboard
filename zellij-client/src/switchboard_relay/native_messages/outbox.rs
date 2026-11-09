//! Durable user replies. A transport failure must never become a permanent refusal.
use super::*;
use std::collections::HashMap;
use tokio::sync::Notify;

static WAKE: Notify = Notify::const_new();

fn database(home: &Path) -> PathBuf {
    home.join(".config/switchboard/native-messages.sqlite3")
}

fn open(home: &Path) -> anyhow::Result<Connection> {
    let path = database(home);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let db = Connection::open(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    db.busy_timeout(Duration::from_secs(2))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS receipts (send_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_outbox (send_key TEXT PRIMARY KEY, thread TEXT NOT NULL, message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS user_outbox_thread ON user_outbox(thread);
        CREATE TABLE IF NOT EXISTS user_outbox_input (send_key TEXT PRIMARY KEY, session TEXT NOT NULL, pane INTEGER NOT NULL, chat TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_outbox_chat (send_key TEXT PRIMARY KEY, chat TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_outbox_completed (send_key TEXT PRIMARY KEY, completed INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS user_outbox_native (send_key TEXT PRIMARY KEY, after_message INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS user_outbox_review (send_key TEXT PRIMARY KEY, reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS user_outbox_receipt_thread (send_key TEXT PRIMARY KEY, thread TEXT NOT NULL)")?;
    Ok(db)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// Commit the payload and receipt together, before returning an acknowledgement.
fn save(home: &Path, target: &Queue) -> anyhow::Result<bool> {
    let mut db = open(home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing: Option<(String, String)> = tx
        .query_row(
            "SELECT fingerprint,status FROM receipts WHERE send_key=?1",
            [&target.send_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((fingerprint, status)) = existing {
        if fingerprint != target.fingerprint() {
            return Ok(false);
        }
        if matches!(status.as_str(), "queued" | "cancelled") {
            return Ok(true);
        }
    }
    tx.execute("INSERT INTO user_outbox (send_key,thread,message) VALUES (?1,?2,?3) ON CONFLICT(send_key) DO NOTHING", params![target.send_key,target.thread,target.message])?;
    // Preserve the exact pane binding before a restart clears the history registry.
    if let Some(chat) =
        super::super::chats::thread_info("codex", &target.thread)["chat_id"].as_str()
    {
        tx.execute(
            "INSERT OR REPLACE INTO user_outbox_chat VALUES (?1,?2)",
            params![target.send_key, chat],
        )?;
    }
    tx.execute("INSERT INTO receipts VALUES (?1,?2,'pending') ON CONFLICT(send_key) DO UPDATE SET status='pending'", params![target.send_key,target.fingerprint()])?;
    tx.commit()?;
    Ok(true)
}

pub(super) async fn accept(home: &Path, target: Queue) -> Response {
    if target
        .message
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return answer(
            StatusCode::BAD_REQUEST,
            "failed",
            &target.send_key,
            "Invalid control character in reply; your draft is kept",
        );
    }
    let key = target.send_key.clone();
    let thread = target.thread.clone();
    let home = home.to_owned();
    match tokio::task::spawn_blocking(move || {
        let saved = save(&home, &target)?;
        Ok::<_, anyhow::Error>((saved, status(&home, &thread, &target.send_key)))
    })
    .await
    {
        Ok(Ok((true, Some(review))))
            if matches!(review["status"].as_str(), Some("review" | "cancelled")) =>
        {
            Json(review).into_response()
        },
        Ok(Ok((true, _))) => {
            WAKE.notify_one();
            answer(
                StatusCode::OK,
                "queued",
                &key,
                "Saved for delivery; acceptance will be checked without replaying an uncertain submission",
            )
        },
        Ok(Ok((false, _))) => receipt("conflict", &key),
        _ => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "failed",
            &key,
            "Could not save your message. Your draft is kept; retry sending.",
        ),
    }
}

pub(super) fn status(home: &Path, thread: &str, key: &str) -> Option<Value> {
    let db = open(home).ok()?;
    let detail: Option<(String, String, String)> = db.query_row("SELECT r.reason,b.send_key,b.message FROM user_outbox a JOIN user_outbox b ON b.thread=a.thread AND b.rowid<=a.rowid JOIN user_outbox_review r ON r.send_key=b.send_key WHERE a.thread=?1 AND a.send_key=?2 ORDER BY b.rowid LIMIT 1", params![thread,key], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().ok()?;
    if let Some((detail, blocked_key, message)) = detail {
        return Some(
            json!({"status":"review","send_key":key,"detail":detail,"blocked_by":{"send_key":blocked_key,"message":message}}),
        );
    }
    let state: String = db.query_row("SELECT r.status FROM receipts r JOIN (SELECT send_key,thread FROM user_outbox UNION ALL SELECT send_key,thread FROM user_outbox_receipt_thread) a USING(send_key) WHERE r.send_key=?1 AND a.thread=?2 LIMIT 1", params![key,thread], |row| row.get(0)).ok()?;
    Some(json!({"status":state,"send_key":key}))
}

/// Only an explicit discard can release an ambiguous legacy submission. Never
/// delete a later reply merely because it is blocked by an earlier one.
pub(super) fn discard(home: &Path, thread: &str, key: &str) -> anyhow::Result<bool> {
    let mut db = open(home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let reviewed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM user_outbox a JOIN user_outbox_review r USING(send_key) WHERE a.thread=?1 AND a.send_key=?2)", params![thread,key], |row| row.get(0))?;
    if !reviewed {
        return Ok(false);
    }
    complete(&tx, key, "cancelled")?;
    tx.commit()?;
    WAKE.notify_one();
    Ok(true)
}

async fn review(home: &Path, item: &Pending, legacy: bool) {
    let (home, key) = (home.to_owned(), item.key.clone());
    let reason = if legacy {
        "Saved. An earlier terminal submission is unconfirmed; check the conversation before resending. Later messages remain in order."
    } else {
        "Saved. Codex may have accepted this message; waiting for its receipt. It will not be resent automatically. Later messages remain in order."
    };
    let _ = tokio::task::spawn_blocking(move || {
        open(&home)?
            .execute(
                "INSERT OR REPLACE INTO user_outbox_review SELECT send_key,?2 FROM user_outbox WHERE send_key=?1",
                params![key, reason],
            )
            .map_err(anyhow::Error::from)
    })
    .await;
}

#[derive(Clone)]
struct Pending {
    key: String,
    thread: String,
    message: String,
    attempts: u32,
    chat: Option<String>,
}

fn pending(home: &Path) -> anyhow::Result<Vec<Pending>> {
    pending_at(home, now())
}

fn pending_at(home: &Path, timestamp: i64) -> anyhow::Result<Vec<Pending>> {
    let db = open(home)?;
    // Keep FIFO order within a thread, including while its first message backs off.
    let mut query = db.prepare("SELECT a.send_key,thread,message,attempts,c.chat FROM user_outbox a LEFT JOIN user_outbox_chat c ON c.send_key=a.send_key WHERE next_attempt<=?1 AND NOT EXISTS (SELECT 1 FROM user_outbox b WHERE b.thread=a.thread AND b.rowid<a.rowid) ORDER BY a.rowid LIMIT 8")?;
    let rows = query.query_map([timestamp], |row| {
        Ok(Pending {
            key: row.get(0)?,
            thread: row.get(1)?,
            message: row.get(2)?,
            attempts: row.get(3)?,
            chat: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn finish(home: &Path, item: &Pending, delivered: bool) -> anyhow::Result<()> {
    let mut db = open(home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // A receipt check may finish after the user discarded this saved reply.
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM user_outbox WHERE send_key=?1)",
        [&item.key],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(());
    }
    if delivered {
        complete(&tx, &item.key, "queued")?;
    } else {
        let delay = (1_i64 << item.attempts.min(4)).min(15);
        tx.execute(
            "UPDATE user_outbox SET attempts=attempts+1,next_attempt=?2 WHERE send_key=?1",
            params![item.key, now() + delay],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn complete(tx: &rusqlite::Transaction<'_>, key: &str, status: &str) -> anyhow::Result<()> {
    tx.execute("INSERT OR REPLACE INTO user_outbox_receipt_thread SELECT send_key,thread FROM user_outbox WHERE send_key=?1", [key])?;
    tx.execute(
        "UPDATE receipts SET status=?2 WHERE send_key=?1",
        params![key, status],
    )?;
    tx.execute("DELETE FROM user_outbox WHERE send_key=?1", [key])?;
    tx.execute("DELETE FROM user_outbox_chat WHERE send_key=?1", [key])?;
    tx.execute("DELETE FROM user_outbox_input WHERE send_key=?1", [key])?;
    tx.execute("DELETE FROM user_outbox_native WHERE send_key=?1", [key])?;
    tx.execute("DELETE FROM user_outbox_review WHERE send_key=?1", [key])?;
    tx.execute(
        "INSERT OR REPLACE INTO user_outbox_completed VALUES (?1,?2)",
        params![key, now()],
    )?;
    // Retain deduplication receipts for a week; delete delivered payloads immediately.
    tx.execute("DELETE FROM receipts WHERE send_key IN (SELECT send_key FROM user_outbox_completed WHERE completed<?1)", [now()-7*86400])?;
    tx.execute("DELETE FROM user_outbox_receipt_thread WHERE send_key IN (SELECT send_key FROM user_outbox_completed WHERE completed<?1)", [now()-7*86400])?;
    tx.execute(
        "DELETE FROM user_outbox_completed WHERE completed<?1",
        [now() - 7 * 86400],
    )?;
    Ok(())
}

pub(in crate::switchboard_relay) fn start(
    home: PathBuf,
    state: RelayState,
) -> tokio::task::JoinHandle<()> {
    let sender = Arc::new(super::codex_queue::Sender::default());
    start_worker(home, move |home, item| {
        let sender = sender.clone();
        let state = state.clone();
        async move {
            let Some(host) = state
                .all_hosts()
                .into_iter()
                .find(|host| host.is_local_engine())
            else {
                return false;
            };
            submit_native_authorized(&sender, &home, &item, || writable_host(&host)).await
        }
    })
}

pub(in crate::switchboard_relay) async fn writable_host(host: &Host) -> bool {
    // Native queue delivery has no terminal HTTP request to refresh its login.
    if super::super::control::require_writable_host(host)
        .await
        .is_err()
    {
        let stale = host.cookie.lock().await.clone();
        let _ = host.login(stale.as_deref()).await;
    }
    super::super::control::require_writable_host(host)
        .await
        .is_ok()
}

#[cfg(test)]
async fn submit_native(sender: &super::codex_queue::Sender, home: &Path, item: &Pending) -> bool {
    submit_native_authorized(sender, home, item, || async { true }).await
}

async fn submit_native_authorized<F, R>(
    sender: &super::codex_queue::Sender,
    home: &Path,
    item: &Pending,
    authorize: F,
) -> bool
where
    F: FnOnce() -> R,
    R: std::future::Future<Output = bool>,
{
    let (directory, key) = (home.to_owned(), item.key.clone());
    let attempt = tokio::task::spawn_blocking(move || -> anyhow::Result<(Option<usize>, bool)> {
        let db = open(&directory)?;
        // Read existence and ownership in one snapshot: a concurrent explicit
        // discard must never turn an old uncertain send into a fresh native add.
        db.query_row("SELECT n.after_message,i.send_key IS NOT NULL FROM user_outbox a LEFT JOIN user_outbox_native n USING(send_key) LEFT JOIN user_outbox_input i USING(send_key) WHERE a.send_key=?1", [&key], |row| Ok((row.get(0)?,row.get(1)?))).map_err(Into::into)
    })
    .await;
    let Ok(Ok((after, legacy))) = attempt else {
        return false;
    };
    if legacy
        && item.chat.as_deref().is_some_and(|chat| {
            chats::thread_info("codex", &item.thread)["chat_id"].as_str() != Some(chat)
        })
    {
        return false;
    }
    // Retrying a question can create another browser key without old paste
    // ownership. Its native question-ID/answer set still identifies the answer.
    // Ordinary input without a checkpoint deliberately never matches here.
    {
        let (thread, text) = (item.thread.clone(), item.message.clone());
        if tokio::task::spawn_blocking(move || chats::user_reply_received(&thread, &text, after))
            .await
            .unwrap_or(false)
        {
            return true;
        }
        if after.is_some() || legacy {
            review(home, item, legacy).await;
        }
    }
    let key = format!("switchboard:{}", item.key);
    match sender.queued(&item.thread, &key, &item.message).await {
        Ok(true) => return true,
        Ok(false) => {},
        Err(error) => {
            delivery_log(
                item,
                &format!("native-queue-unavailable ({error:?}); reply remains saved"),
            );
            return false;
        },
    }
    // An uncertain add may already be between the native queue and transcript.
    // Keep reconciling it; never append another copy or press Enter in a draft.
    if after.is_some() || legacy {
        review(home, item, legacy).await;
        delivery_log(
            item,
            if legacy {
                "legacy-paste-unconfirmed; original input remains saved"
            } else {
                "native-add-unconfirmed; awaiting queue/transcript receipt"
            },
        );
        return false;
    }
    if !authorize().await {
        delivery_log(
            item,
            "writable-authentication-required; original message remains saved",
        );
        return false;
    }
    let thread = item.thread.clone();
    let Some(checkpoint) =
        tokio::task::spawn_blocking(move || chats::user_reply_checkpoint(&thread))
            .await
            .ok()
            .flatten()
    else {
        return false;
    };
    let (directory, receipt) = (home.to_owned(), item.key.clone());
    if !tokio::task::spawn_blocking(move || {
        open(&directory)?
            .execute(
                "INSERT INTO user_outbox_native VALUES (?1,?2)",
                params![receipt, checkpoint],
            )
            .map_err(anyhow::Error::from)
    })
    .await
    .is_ok_and(|result| result.is_ok())
    {
        return false;
    }
    match sender.add(&item.thread, &key, &item.message).await {
        Ok(()) => true,
        Err(super::codex_queue::Failure::BeforeSend | super::codex_queue::Failure::Rejected) => {
            let (directory, receipt) = (home.to_owned(), item.key.clone());
            let _ = tokio::task::spawn_blocking(move || {
                open(&directory)?
                    .execute(
                        "DELETE FROM user_outbox_native WHERE send_key=?1",
                        [receipt],
                    )
                    .map_err(anyhow::Error::from)
            })
            .await;
            delivery_log(item, "native-add-rejected; original message remains saved");
            false
        },
        Err(super::codex_queue::Failure::Unconfirmed) => {
            review(home, item, false).await;
            delivery_log(
                item,
                "native-add-unconfirmed; original message remains saved for receipt verification",
            );
            false
        },
    }
}

fn delivery_log(item: &Pending, stage: &str) {
    let reference = Sha256::digest(format!("{}\0{}", item.thread, item.key).as_bytes())[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    logs::record(
        "Messages",
        &format!(
            "Codex reply ref={reference} build={} {stage}",
            env!("SWITCHBOARD_COMMIT")
        ),
    );
}

fn start_worker<F, R>(home: PathBuf, submit: F) -> tokio::task::JoinHandle<()>
where
    F: Fn(PathBuf, Pending) -> R + Clone + Send + 'static,
    R: std::future::Future<Output = bool> + Send + 'static,
{
    tokio::spawn(async move {
        // Preview and production relays share this account. Only one drains its outbox.
        let mut worker_lock = None;
        let mut active = HashMap::new();
        let mut jobs = tokio::task::JoinSet::new();
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = WAKE.notified() => {},
                _ = tick.tick() => {},
                completed = jobs.join_next_with_id(), if !jobs.is_empty() => {
                    if let Some(completed) = completed {
                        let id = match completed {
                            Ok((id, ())) => id,
                            Err(error) => {
                                logs::record("Messages", "Reply worker stopped; saved message will be tried again");
                                error.id()
                            },
                        };
                        active.remove(&id);
                    }
                },
            }
            if worker_lock.is_none() {
                let path = database(&home).with_extension("outbox.lock");
                let _ = std::fs::create_dir_all(path.parent().unwrap());
                let Ok(lock) = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(path)
                else {
                    continue;
                };
                if lock.try_lock().is_err() {
                    continue;
                }
                worker_lock = Some(lock);
            }
            let directory = home.clone();
            let items = tokio::task::spawn_blocking(move || pending(&directory)).await;
            let Ok(Ok(items)) = items else {
                logs::record(
                    "Messages",
                    "Cannot read the durable reply outbox; saved messages remain on disk",
                );
                continue;
            };
            for item in items {
                if active.len() >= 8 {
                    break;
                }
                if active.values().any(|thread| thread == &item.thread) {
                    continue;
                }
                let thread = item.thread.clone();
                let directory = home.clone();
                let submit = submit.clone();
                let job = jobs.spawn(async move {
                    let delivered = submit(directory.clone(), item.clone()).await;
                    let saved = tokio::task::spawn_blocking(move || finish(&directory, &item, delivered)).await;
                    if !matches!(saved, Ok(Ok(()))) {
                        logs::record("Messages", "Cannot save a reply delivery result; message remains in the durable outbox");
                    }
                });
                active.insert(job.id(), thread);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[serial_test::serial]
    async fn switchboard_user_outbox_refreshes_expired_login_and_still_rejects_view_only() {
        use zellij_utils::web_authentication_tokens::{
            create_session_token, create_token, revoke_session_token, revoke_token,
        };
        let dir = tempfile::tempdir().unwrap();
        let token_path = dir.path().join("token");
        let logins = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = logins.clone();
        let upstream = Router::new().route(
            "/command/login",
            post(move |Json(body): Json<Value>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let session =
                        create_session_token(body["auth_token"].as_str().unwrap(), false).unwrap();
                    (
                        [(header::SET_COOKIE, format!("session_token={session}"))],
                        "{}",
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        for read_only in [false, true] {
            let (token, name) = create_token(
                Some(format!("outbox-test-{}", uuid::Uuid::new_v4())),
                read_only,
            )
            .unwrap();
            std::fs::write(&token_path, &token).unwrap();
            let mut config = super::super::super::tests::config(&url);
            config.token_file = token_path.to_string_lossy().into();
            let host = Host::new(config).unwrap();
            let expired = create_session_token(&token, false).unwrap();
            revoke_session_token(&expired).unwrap();
            *host.cookie.lock().await = Some(format!("session_token={expired}"));
            assert_eq!(writable_host(&host).await, !read_only);
            revoke_token(&name).unwrap();
        }
        assert_eq!(logins.load(std::sync::atomic::Ordering::SeqCst), 2);
        server.abort();
    }

    #[tokio::test]
    async fn switchboard_user_outbox_discard_legacy_blocker_preserves_followers_and_never_replays()
    {
        use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
        let dir = tempfile::tempdir().unwrap();
        let mut first = super::super::tests::target();
        first.thread = uuid::Uuid::new_v4().to_string();
        first.user_message = true;
        first.message = "Ship the earlier change".into();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let transcript = sessions.join(format!("rollout-{}.jsonl", first.thread));
        std::fs::write(&transcript, "").unwrap();
        chats::bind_receipt_fixture(dir.path().into(), &transcript);
        save(dir.path(), &first).unwrap();
        let db = open(dir.path()).unwrap();
        db.execute(
            "INSERT INTO user_outbox_input VALUES (?1,'fixture',7,'historical-chat')",
            [&first.send_key],
        )
        .unwrap();
        let second = Queue {
            send_key: "follower".into(),
            message: "Continue with the next change".into(),
            ..first.clone()
        };
        save(dir.path(), &second).unwrap();
        let item = pending(dir.path()).unwrap().remove(0);
        let (sender, provider) = super::super::codex_queue::Sender::fixture();
        let home = dir.path().to_owned();
        let active = item.clone();
        let job = tokio::spawn(async move {
            // Receipt reconciliation must work even without writable terminal authentication.
            submit_native_authorized(&sender, &home, &active, || async {
                panic!("An ambiguous submission must never be submitted again")
            })
            .await
        });
        let mut provider = BufReader::new(provider);
        let mut line = String::new();
        provider.read_line(&mut line).await.unwrap();
        let request: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "thread/queue/list");
        let review = status(dir.path(), &second.thread, &second.send_key).unwrap();
        assert_eq!(review["status"], "review");
        assert_eq!(review["blocked_by"]["send_key"], first.send_key);
        assert_eq!(review["blocked_by"]["message"], first.message);
        assert!(!discard(
            dir.path(),
            &uuid::Uuid::new_v4().to_string(),
            &first.send_key
        )
        .unwrap());
        assert!(
            !discard(dir.path(), &second.thread, &second.send_key).unwrap(),
            "A blocked follower is not itself an ambiguous submission"
        );
        let started = std::time::Instant::now();
        assert!(discard(dir.path(), &first.thread, &first.send_key).unwrap());
        eprintln!("legacy queue recovery: {}us", started.elapsed().as_micros());
        provider
            .get_mut()
            .write_all(
                format!(
                    "{}\n",
                    json!({"id":request["id"],"result":{"data":[],"nextCursor":null}})
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        assert!(!job.await.unwrap());
        let mut remaining = Vec::new();
        provider.read_to_end(&mut remaining).await.unwrap();
        assert!(
            remaining.is_empty(),
            "A concurrent discard must not cause a native add"
        );
        // Late worker completion and repeated browser requests cannot resurrect it.
        finish(dir.path(), &item, true).unwrap();
        assert!(!discard(dir.path(), &first.thread, &first.send_key).unwrap());
        assert!(save(dir.path(), &first).unwrap());
        assert_eq!(
            db.query_row("SELECT count(*) FROM user_outbox_review", [], |row| row
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            status(dir.path(), &first.thread, &first.send_key).unwrap()["status"],
            "cancelled"
        );
        assert!(status(
            dir.path(),
            &uuid::Uuid::new_v4().to_string(),
            &first.send_key
        )
        .is_none());
        let follower = pending(dir.path()).unwrap();
        assert_eq!(follower.len(), 1);
        assert_eq!(follower[0].key, second.send_key);
        assert_eq!(follower[0].message, second.message);
        assert_eq!(
            status(dir.path(), &second.thread, &second.send_key).unwrap()["status"],
            "pending"
        );
        let (sender, mut provider) = super::super::codex_queue::Sender::fixture();
        assert!(!submit_native(&sender, dir.path(), &item).await);
        drop(sender);
        let mut bytes = Vec::new();
        provider.read_to_end(&mut bytes).await.unwrap();
        assert!(
            bytes.is_empty(),
            "A discarded job cannot become a new submission"
        );
    }

    #[tokio::test]
    async fn switchboard_user_outbox_reconciles_accepted_question_under_two_browser_keys() {
        use std::io::Write;
        use tokio::io::AsyncReadExt;
        let dir = tempfile::tempdir().unwrap();
        let mut target = super::super::tests::target();
        target.thread = uuid::Uuid::new_v4().to_string();
        target.user_message = true;
        target.message = format!(
            "<send_user_message_question_reply>\n{}\n</send_user_message_question_reply>",
            json!([{"questionItemId":"question-1","question":"Shouldn’t this work?","answer":"Yes"}])
        );
        let sessions = dir.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join(format!("rollout-{}.jsonl", target.thread));
        let mut transcript = std::fs::File::create(&path).unwrap();
        writeln!(transcript, "{}", json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":target.message.replace('’', "")}]}}})).unwrap();
        transcript.flush().unwrap();
        chats::bind_receipt_fixture(dir.path().into(), &path);
        save(dir.path(), &target).unwrap();
        let second = Queue {
            send_key: "second-question-key".into(),
            ..target.clone()
        };
        save(dir.path(), &second).unwrap();
        let (sender, mut provider) = super::super::codex_queue::Sender::fixture();
        for key in [&target.send_key, &second.send_key] {
            let item = pending(dir.path()).unwrap().remove(0);
            assert_eq!(&item.key, key);
            assert!(submit_native(&sender, dir.path(), &item).await);
            finish(dir.path(), &item, true).unwrap();
        }
        assert!(pending(dir.path()).unwrap().is_empty());
        drop(sender);
        let mut bytes = Vec::new();
        provider.read_to_end(&mut bytes).await.unwrap();
        assert!(
            bytes.is_empty(),
            "Accepted question answers must never be added again, even with a second key"
        );
    }

    #[tokio::test]
    async fn switchboard_user_outbox_never_readds_after_lost_ack_and_restart() {
        use std::io::Write;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let dir = tempfile::tempdir().unwrap();
        let mut target = super::super::tests::target();
        target.thread = uuid::Uuid::new_v4().to_string();
        target.user_message = true;
        let sessions = dir.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join(format!("rollout-{}.jsonl", target.thread));
        let mut transcript = std::fs::File::create(&path).unwrap();
        chats::bind_receipt_fixture(dir.path().into(), &path);
        save(dir.path(), &target).unwrap();
        let first = pending(dir.path()).unwrap().remove(0);
        let (sender, provider) = super::super::codex_queue::Sender::fixture();
        let task = tokio::spawn(async move {
            let mut provider = BufReader::new(provider);
            for method in ["thread/queue/list", "thread/queue/add"] {
                let mut line = String::new();
                provider.read_line(&mut line).await.unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["method"], method);
                if method.ends_with("list") {
                    provider
                        .get_mut()
                        .write_all(
                            format!(
                                "{}\n",
                                json!({"id":request["id"],"result":{"data":[],"nextCursor":null}})
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
                // Consume add, then lose its acknowledgement and the connection.
            }
        });
        assert!(!submit_native(&sender, dir.path(), &first).await);
        assert_eq!(
            status(dir.path(), &first.thread, &first.key).unwrap()["status"],
            "review"
        );
        assert!(status(dir.path(), &uuid::Uuid::new_v4().to_string(), &first.key).is_none());
        task.await.unwrap();
        drop(sender);
        // Reopen both SQLite and native transport before the transcript is visible.
        let (sender, provider) = super::super::codex_queue::Sender::fixture();
        let task = tokio::spawn(async move {
            let mut provider = BufReader::new(provider);
            let mut line = String::new();
            provider.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "thread/queue/list");
            provider
                .get_mut()
                .write_all(
                    format!(
                        "{}\n",
                        json!({"id":request["id"],"result":{"data":[],"nextCursor":null}})
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            line.clear();
            // No second add may follow an empty queue, even after a restart.
            assert_eq!(provider.read_line(&mut line).await.unwrap(), 0);
        });
        let first = pending(dir.path()).unwrap().remove(0);
        let second = Queue {
            send_key: "follower".into(),
            message: "Later input".into(),
            ..target.clone()
        };
        save(dir.path(), &second).unwrap();
        assert_eq!(
            status(dir.path(), &second.thread, &second.send_key).unwrap()["status"],
            "review"
        );
        assert!(!submit_native(&sender, dir.path(), &first).await);
        writeln!(transcript, "{}", json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":target.message}]}}})).unwrap();
        transcript.flush().unwrap();
        assert!(submit_native(&sender, dir.path(), &first).await);
        finish(dir.path(), &first, true).unwrap();
        assert!(save(dir.path(), &target).unwrap());
        assert_eq!(pending(dir.path()).unwrap()[0].key, "follower");
        assert_ne!(
            status(dir.path(), &second.thread, &second.send_key).unwrap()["status"],
            "review"
        );
        drop(sender);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn switchboard_user_outbox_only_one_relay_drains_the_account() {
        let dir = tempfile::tempdir().unwrap();
        let mut target = super::super::tests::target();
        target.user_message = true;
        save(dir.path(), &target).unwrap();
        let path = database(dir.path()).with_extension("outbox.lock");
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .unwrap();
        lock.try_lock().unwrap();
        let worker = start_worker(dir.path().to_owned(), |_, _| async { true });
        // The worker is allowed to run while another relay owns the account lock.
        WAKE.notify_one();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(pending(dir.path()).unwrap().len(), 1);
        drop(lock);
        WAKE.notify_one();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if pending(dir.path()).unwrap().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test]
    async fn switchboard_user_outbox_delivers_after_failure_restart_and_duplicate_send() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let dir = tempfile::tempdir().unwrap();
        let mut target = super::super::tests::target();
        target.user_message = true;
        let elapsed = std::time::Instant::now();
        let response = accept(dir.path(), target.clone()).await;
        eprintln!(
            "durable reply acknowledgement: {}us",
            elapsed.elapsed().as_micros()
        );
        assert_eq!(response.status(), StatusCode::OK);
        let elapsed = std::time::Instant::now();
        assert_eq!(
            accept(dir.path(), target.clone()).await.status(),
            StatusCode::OK
        );
        eprintln!(
            "warm reply acknowledgement: {}us",
            elapsed.elapsed().as_micros()
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let attempts = calls.clone();
        let worker = start_worker(dir.path().to_owned(), move |_, _| {
            attempts.fetch_add(1, Ordering::SeqCst);
            async { false }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if open(dir.path())
                    .unwrap()
                    .query_row("SELECT attempts FROM user_outbox", [], |r| {
                        r.get::<_, u32>(0)
                    })
                    .unwrap()
                    > 0
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        worker.abort();
        let _ = worker.await;
        let attempts = calls.clone();
        let worker = start_worker(dir.path().to_owned(), move |_, item| {
            attempts.fetch_add(1, Ordering::SeqCst);
            assert_eq!(item.message, "Hello \"world\"; $(touch injected)\n你好");
            async { true }
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if open(dir.path())
                    .unwrap()
                    .query_row("SELECT count(*) FROM user_outbox", [], |r| {
                        r.get::<_, u32>(0)
                    })
                    .unwrap()
                    == 0
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(save(dir.path(), &target).unwrap());
        assert!(pending(dir.path()).unwrap().is_empty());
        worker.abort();
        let _ = worker.await;
    }

    #[test]
    fn switchboard_user_outbox_recovers_failed_replies_and_preserves_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = super::super::tests::target();
        first.user_message = true;
        // Reproduce a permanent unknown receipt made by the old sender.
        assert_eq!(reserve(&database(dir.path()), &first).unwrap(), None);
        assert!(save(dir.path(), &first).unwrap());
        assert!(save(dir.path(), &first).unwrap());
        let second = Queue {
            send_key: "second".into(),
            message: "Another thought".into(),
            ..first.clone()
        };
        assert!(save(dir.path(), &second).unwrap());
        assert!(!save(
            dir.path(),
            &Queue {
                message: "Different".into(),
                ..first.clone()
            }
        )
        .unwrap());
        let items = pending(dir.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].message, first.message);
        finish(dir.path(), &items[0], false).unwrap();
        let db = open(dir.path()).unwrap();
        let due = db
            .query_row(
                "SELECT next_attempt FROM user_outbox WHERE send_key=?1",
                [&first.send_key],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        // Exercise the scheduling boundary explicitly. Reading the wall clock
        // here can cross the one-second retry boundary on a loaded runner.
        assert!(pending_at(dir.path(), due - 1).unwrap().is_empty());
        assert_eq!(pending_at(dir.path(), due).unwrap()[0].key, first.send_key);
        db.execute("UPDATE user_outbox SET next_attempt=0", [])
            .unwrap();
        // Reopen after a failed attempt: the first message still precedes the second.
        let items = pending(dir.path()).unwrap();
        assert_eq!(items[0].attempts, 1);
        db.execute(
            "INSERT INTO user_outbox_chat VALUES (?1,'codex-fixture')",
            [&first.send_key],
        )
        .unwrap();
        let items = pending(dir.path()).unwrap();
        assert_eq!(items[0].chat.as_deref(), Some("codex-fixture"));
        finish(dir.path(), &items[0], true).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM user_outbox_chat", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
        assert!(save(dir.path(), &first).unwrap());
        let items = pending(dir.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "second");
        finish(dir.path(), &items[0], true).unwrap();
        assert!(pending(dir.path()).unwrap().is_empty());
        assert_eq!(
            db.query_row("SELECT count(*) FROM user_outbox", [], |r| r
                .get::<_, u32>(0))
                .unwrap(),
            0
        );
    }
}
