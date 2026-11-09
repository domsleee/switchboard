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
        CREATE TABLE IF NOT EXISTS user_outbox_completed (send_key TEXT PRIMARY KEY, completed INTEGER NOT NULL)")?;
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
        if status == "queued" {
            return Ok(true);
        }
    }
    tx.execute("INSERT INTO user_outbox (send_key,thread,message) VALUES (?1,?2,?3) ON CONFLICT(send_key) DO NOTHING", params![target.send_key,target.thread,target.message])?;
    tx.execute("INSERT INTO receipts VALUES (?1,?2,'pending') ON CONFLICT(send_key) DO UPDATE SET status='pending'", params![target.send_key,target.fingerprint()])?;
    tx.commit()?;
    Ok(true)
}

pub(super) async fn accept(home: &Path, target: Queue) -> Response {
    let key = target.send_key.clone();
    let home = home.to_owned();
    match tokio::task::spawn_blocking(move || save(&home, &target)).await {
        Ok(Ok(true)) => {
            WAKE.notify_one();
            answer(
                StatusCode::OK,
                "queued",
                &key,
                "Saved for delivery; Switchboard will keep trying until Codex accepts it",
            )
        },
        Ok(Ok(false)) => receipt("conflict", &key),
        _ => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "failed",
            &key,
            "Could not save your message. Your draft is kept; retry sending.",
        ),
    }
}

#[derive(Clone)]
struct Pending {
    key: String,
    thread: String,
    message: String,
    attempts: u32,
}

fn pending(home: &Path) -> anyhow::Result<Vec<Pending>> {
    let db = open(home)?;
    // Keep FIFO order within a thread, including while its first message backs off.
    let mut query = db.prepare("SELECT send_key,thread,message,attempts FROM user_outbox a WHERE next_attempt<=?1 AND NOT EXISTS (SELECT 1 FROM user_outbox b WHERE b.thread=a.thread AND b.rowid<a.rowid) ORDER BY rowid LIMIT 8")?;
    let rows = query.query_map([now()], |row| {
        Ok(Pending {
            key: row.get(0)?,
            thread: row.get(1)?,
            message: row.get(2)?,
            attempts: row.get(3)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn finish(home: &Path, item: &Pending, delivered: bool) -> anyhow::Result<()> {
    let mut db = open(home)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if delivered {
        tx.execute(
            "UPDATE receipts SET status='queued' WHERE send_key=?1",
            [&item.key],
        )?;
        tx.execute("DELETE FROM user_outbox WHERE send_key=?1", [&item.key])?;
        tx.execute(
            "INSERT OR REPLACE INTO user_outbox_completed VALUES (?1,?2)",
            params![item.key, now()],
        )?;
        // Retain deduplication receipts for a week; delete delivered payloads immediately.
        tx.execute("DELETE FROM receipts WHERE send_key IN (SELECT send_key FROM user_outbox_completed WHERE completed<?1)", [now()-7*86400])?;
        tx.execute(
            "DELETE FROM user_outbox_completed WHERE completed<?1",
            [now() - 7 * 86400],
        )?;
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

async fn submit(home: &Path, item: &Pending) -> bool {
    let Some((program, path)) = agent_setup::codex_queue_program() else {
        return false;
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args([
            "queue",
            "--thread",
            &item.thread,
            &format!("--message={}", item.message),
        ])
        .env("PATH", path)
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in [
        "CODEX_THREAD_ID",
        "ZELLIJ_SESSION_NAME",
        "ZELLIJ_PANE_ID",
        "CLAUDECODE",
    ] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let started = std::time::Instant::now();
    let result = match command.spawn() {
        Ok(mut child) => tokio::time::timeout(Duration::from_secs(60), child.wait())
            .await
            .ok()
            .and_then(Result::ok),
        Err(_) => None,
    };
    let delivered = result.is_some_and(|exit| exit.success());
    if !delivered {
        logs::record(
            "Messages",
            &format!(
                "Codex reply retained for retry: attempt={} elapsed_ms={} exit={:?}",
                item.attempts + 1,
                started.elapsed().as_millis(),
                result.and_then(|exit| exit.code())
            ),
        );
    }
    delivered
}

pub(in crate::switchboard_relay) fn start(home: PathBuf) -> tokio::task::JoinHandle<()> {
    start_worker(home, |home, item| async move { submit(&home, &item).await })
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
        assert!(pending(dir.path()).unwrap().is_empty());
        let db = open(dir.path()).unwrap();
        db.execute("UPDATE user_outbox SET next_attempt=0", [])
            .unwrap();
        // Reopen after a failed attempt: the first message still precedes the second.
        let items = pending(dir.path()).unwrap();
        assert_eq!(items[0].attempts, 1);
        finish(dir.path(), &items[0], true).unwrap();
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
