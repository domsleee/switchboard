//! The newest page of each open conversation on another computer, so selecting its
//! tab draws at once. The conversation's stream then brings anything newer.
use super::*;
use std::collections::HashSet;

const CAPACITY: usize = 128;
/// An idle conversation changes no pane state, so its page is refreshed on age too.
const REFRESH_AGE: Duration = Duration::from_secs(7 * 60);
const MAX_PAGE_BYTES: usize = 256 * 1024;
/// The page Conversation asks for first (`firstPage` in conversation.js).
const FIRST_PAGE: usize = 15;
const WARMERS: usize = 4;

type Key = (String, String);
// The pane's reported state and when it entered it: a change means a newer page exists.
type Token = (String, u64);

struct Entry {
    page: Value,
    at: std::time::Instant,
    token: Option<Token>,
}

#[derive(Default)]
struct Tails {
    entries: HashMap<Key, Entry>,
    refreshing: HashSet<Key>,
}

impl Tails {
    fn page(&self, key: &Key) -> Option<Value> {
        self.entries.get(key).map(|entry| entry.page.clone())
    }

    fn stale(&self, key: &Key, token: &Token) -> bool {
        self.stale_at(key, token, std::time::Instant::now())
    }

    fn stale_at(&self, key: &Key, token: &Token, now: std::time::Instant) -> bool {
        self.entries.get(key).is_none_or(|entry| {
            entry.token.as_ref() != Some(token) || now.duration_since(entry.at) >= REFRESH_AGE
        })
    }

    fn store(&mut self, key: Key, page: Value, token: Option<Token>) {
        let complete = page.get("error").is_none()
            && page["partial"] != true
            && page["messages"].is_array()
            && serde_json::to_vec(&page).is_ok_and(|bytes| bytes.len() <= MAX_PAGE_BYTES);
        if !complete {
            return;
        }
        let token = token.or_else(|| self.entries.get(&key).and_then(|e| e.token.clone()));
        if !self.entries.contains_key(&key) && self.entries.len() >= CAPACITY {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.at)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            Entry {
                page,
                at: std::time::Instant::now(),
                token,
            },
        );
    }
}

static TAILS: LazyLock<SyncMutex<Tails>> = LazyLock::new(Default::default);

fn key(host: &Host, id: &str) -> Key {
    (host.config.id.clone(), id.to_owned())
}

/// Only Conversation's opening request has one answer that later pages can extend.
pub(super) fn applies(p: &Params) -> bool {
    p.tail
        && p.context
        && p.limit == Some(FIRST_PAGE)
        && p.q.is_empty()
        && p.cursor == 0
        && p.before.is_none()
        && p.agent.is_none()
        && p.project.is_none()
}

fn first_page() -> Params {
    Params {
        limit: Some(FIRST_PAGE),
        tail: true,
        context: true,
        ..Default::default()
    }
}

async fn refresh_tails(tails: &SyncMutex<Tails>, host: &Host, id: &str, token: Option<Token>) {
    let key = key(host, id);
    if !tails.lock().unwrap().refreshing.insert(key.clone()) {
        return;
    }
    let (page, _) = remote_timed(host, &first_page(), Some(id)).await;
    let mut tails = tails.lock().unwrap();
    tails.refreshing.remove(&key);
    tails.store(key, page, token);
}

/// Answers from the kept page when there is one, refreshing it behind the reply.
async fn first_page_from(
    tails: &'static SyncMutex<Tails>,
    host: Arc<Host>,
    id: &str,
    p: &Params,
) -> (Value, Option<header::HeaderValue>) {
    let kept = tails.lock().unwrap().page(&key(&host, id));
    if let Some(page) = kept {
        let id = id.to_owned();
        tokio::spawn(async move { refresh_tails(tails, &host, &id, None).await });
        return (page, None);
    }
    let (page, timing) = remote_timed(&host, p, Some(id)).await;
    tails
        .lock()
        .unwrap()
        .store(key(&host, id), page.clone(), None);
    (page, timing)
}

pub(super) async fn read(
    host: Arc<Host>,
    id: &str,
    p: &Params,
) -> (Value, Option<header::HeaderValue>) {
    first_page_from(&TAILS, host, id, p).await
}

fn wanted(snapshot: &Value) -> Vec<(String, String, Token)> {
    snapshot["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|pane| {
            let id = pane["chat_id"].as_str().filter(|id| valid_id(id))?;
            Some((
                pane["host"].as_str()?.to_owned(),
                id.to_owned(),
                (
                    pane["state"].as_str().unwrap_or_default().to_owned(),
                    pane["since"].as_u64().unwrap_or_default(),
                ),
            ))
        })
        .collect()
}

async fn warm(mesh: &mesh::Mesh, snapshot: &Value) {
    let stale: Vec<_> = wanted(snapshot)
        .into_iter()
        .filter_map(|(host, id, token)| {
            let host = mesh.host(&host)?;
            TAILS
                .lock()
                .unwrap()
                .stale(&key(&host, &id), &token)
                .then_some((host, id, token))
        })
        .collect();
    futures_util::stream::iter(stale.into_iter().map(|(host, id, token)| async move {
        refresh_tails(&TAILS, &host, &id, Some(token)).await;
    }))
    .buffer_unordered(WARMERS)
    .collect::<Vec<_>>()
    .await;
}

/// Keeps pages current for the tabs a sidebar shows, while a sidebar is open.
pub(in crate::switchboard_relay) fn start(state: RelayState) {
    let Some(mesh) = state.mesh.clone() else {
        return;
    };
    let mut changes = state.attention.subscribe();
    tokio::spawn(async move {
        while changes.changed().await.is_ok() {
            // Gathers a burst of changes, and lets a sidebar woken by this one wait again.
            tokio::time::sleep(Duration::from_secs(1)).await;
            let snapshot = changes.borrow_and_update().1.clone();
            // This watcher and the push notifier are always subscribed; a sidebar waits too.
            let idle = 1 + usize::from(state.push.is_some());
            if state.attention.receiver_count() > idle {
                warm(&mesh, &snapshot).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(text: &str) -> Value {
        json!({"messages":[{"text":text}],"start_cursor":0,"next_cursor":null})
    }

    fn key_for(id: &str) -> Key {
        ("host".into(), id.into())
    }

    #[test]
    fn switchboard_tail_cache_applies_only_to_the_opening_page() {
        assert!(applies(&first_page()));
        for changed in [
            Params {
                limit: Some(50),
                ..first_page()
            },
            Params {
                tail: false,
                ..first_page()
            },
            Params {
                before: Some(10),
                ..first_page()
            },
            Params {
                cursor: 5,
                ..first_page()
            },
            Params {
                context: false,
                ..first_page()
            },
        ] {
            assert!(!applies(&changed));
        }
    }

    #[test]
    fn switchboard_tail_cache_keeps_only_complete_bounded_pages() {
        let mut tails = Tails::default();
        for rejected in [
            json!({"error":"computer_unavailable"}),
            json!({"messages":[],"partial":true}),
            json!({"not_messages":true}),
            json!({"messages":["x".repeat(MAX_PAGE_BYTES + 1)]}),
        ] {
            tails.store(key_for("a"), rejected, None);
            assert!(tails.page(&key_for("a")).is_none());
        }
        tails.store(key_for("a"), page("kept"), None);
        tails.store(key_for("a"), json!({"error":"computer_unavailable"}), None);
        assert_eq!(tails.page(&key_for("a")).unwrap(), page("kept"));
    }

    #[test]
    fn switchboard_tail_cache_refreshes_on_new_pane_state_and_stays_bounded() {
        let mut tails = Tails::default();
        let working = ("working".to_owned(), 10);
        assert!(tails.stale(&key_for("a"), &working));
        tails.store(key_for("a"), page("first"), Some(working.clone()));
        assert!(!tails.stale(&key_for("a"), &working));
        tails.store(key_for("a"), page("second"), None);
        assert!(
            !tails.stale(&key_for("a"), &working),
            "A selection's refresh must not lose the state the warmer last saw"
        );
        assert!(tails.stale(&key_for("a"), &("ready".to_owned(), 11)));
        for n in 0..CAPACITY + 5 {
            tails.store(key_for(&n.to_string()), page("x"), None);
        }
        assert_eq!(tails.entries.len(), CAPACITY);
    }

    #[test]
    fn switchboard_tail_cache_serves_an_old_page_and_marks_it_for_refresh() {
        let mut tails = Tails::default();
        let ready = ("ready".to_owned(), 10);
        tails.store(key_for("a"), page("old"), Some(ready.clone()));
        let later = std::time::Instant::now() + REFRESH_AGE * 3;
        assert!(!tails.stale(&key_for("a"), &ready));
        assert!(tails.stale_at(&key_for("a"), &ready, later));
        assert_eq!(tails.page(&key_for("a")).unwrap(), page("old"));
    }

    #[test]
    fn switchboard_tail_cache_warms_panes_with_a_conversation() {
        let snapshot = json!({"panes":[
            {"host":"mesh-a","chat_id":"claude-1","state":"ready","since":7},
            {"host":"mesh-a","state":"unknown","since":8},
            {"host":"mesh-a","chat_id":"not valid/","state":"ready","since":9},
        ]});
        assert_eq!(
            wanted(&snapshot),
            vec![(
                "mesh-a".to_owned(),
                "claude-1".to_owned(),
                ("ready".to_owned(), 7)
            )]
        );
    }

    #[tokio::test]
    async fn switchboard_tail_cache_answers_at_once_and_refreshes_behind_the_reply() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        static FIXTURE: LazyLock<SyncMutex<Tails>> = LazyLock::new(Default::default);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(|| async {
            let call = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
            tokio::time::sleep(Duration::from_millis(400)).await;
            Json(page(&format!("call {call}")))
        });
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let host = Arc::new(
            Host::new(super::super::super::tests::config(&format!(
                "http://{address}"
            )))
            .unwrap(),
        );
        *host.cookie.lock().await = Some("session_token=fixture".into());
        let (cold, _) = first_page_from(&FIXTURE, host.clone(), "claude-1", &first_page()).await;
        assert_eq!(cold, page("call 1"));
        let started = std::time::Instant::now();
        let (kept, timing) =
            first_page_from(&FIXTURE, host.clone(), "claude-1", &first_page()).await;
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(kept, page("call 1"));
        assert!(timing.is_none(), "A kept page reports no live timings");
        let refreshed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let (current, _) = (FIXTURE.lock().unwrap().page(&key(&host, "claude-1")), ());
                if current == Some(page("call 2")) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await;
        server.abort();
        assert!(refreshed.is_ok());
    }
}
