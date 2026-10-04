use super::store::Store;
use super::*;
use std::sync::Arc;
use tempfile::TempDir;

fn machine(id: &str) -> Machine {
    Machine {
        id: id.into(),
        name: if id == "mac" { "Mac" } else { "Windows" }.into(),
    }
}
fn fixture() -> (TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("board.sqlite3")).unwrap();
    (dir, store)
}
fn register(store: &Store, machine_id: &str, name: &str) -> Participant {
    store
        .register(
            &machine(machine_id),
            Register {
                name: name.into(),
                project: "switchboard".into(),
                resume: None,
                terminal: None,
            },
        )
        .unwrap()
}
fn request(sender: &Participant, recipient: &Participant, key: &str) -> SendMessage {
    SendMessage {
        sender: sender.id.clone(),
        send_key: key.into(),
        body: "Question 🦀\nSecond line".into(),
        to: Some(recipient.id.clone()),
        broadcast: None,
        reply_to: None,
    }
}
fn page() -> ReadPage {
    ReadPage {
        after: 0,
        limit: 25,
        project: None,
    }
}

#[test]
fn message_board_identity_duplicate_names_resume_retire_and_replacement_are_explicit() {
    let (_dir, store) = fixture();
    let a = register(&store, "mac", "backend");
    let b = register(&store, "windows", "backend");
    let c = register(&store, "windows", "backend");
    assert_ne!(b.id, c.id);
    let mut send = request(&a, &b, "ambiguous");
    send.to = Some("backend".into());
    let error = store.send(&machine("mac"), send).unwrap_err();
    assert_eq!(error.0, StatusCode::CONFLICT);
    assert!(error.1.contains(&b.id) && error.1.contains(&c.id));
    let msg = store
        .send(&machine("mac"), request(&a, &b, "original"))
        .unwrap();
    let renamed = store
        .register(
            &machine("windows"),
            Register {
                name: "reviewer".into(),
                project: b.project.clone(),
                resume: Some(b.id.clone()),
                terminal: None,
            },
        )
        .unwrap();
    assert_eq!(renamed.id, b.id);
    assert_eq!(renamed.created_at, b.created_at);
    assert_eq!(
        store
            .unread(&machine("windows"), &renamed.id, page())
            .unwrap()
            .items[0]
            .deliveries[0]
            .name,
        "backend"
    );
    assert_eq!(
        store
            .register(
                &machine("mac"),
                Register {
                    name: "stolen".into(),
                    project: b.project.clone(),
                    resume: Some(b.id.clone()),
                    terminal: None
                }
            )
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
    let retired = store.retire(&machine("windows"), &b.id).unwrap();
    assert!(!retired.active);
    let replacement = register(&store, "windows", "reviewer");
    assert!(store
        .unread(&machine("windows"), &replacement.id, page())
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store.thread(&msg.thread_id, page()).unwrap().items[0].deliveries[0].recipient,
        b.id
    );
}

#[test]
fn message_board_multiline_reply_unread_and_ack_survive_restart_without_implicit_ack() {
    let (dir, store) = fixture();
    let a = register(&store, "mac", "backend");
    let b = register(&store, "windows", "reviewer");
    let sent = store
        .send(&machine("mac"), request(&a, &b, "question"))
        .unwrap();
    for _ in 0..2 {
        let unread = store.unread(&machine("windows"), &b.id, page()).unwrap();
        assert_eq!(unread.items[0].body, "Question 🦀\nSecond line");
        assert!(unread.items[0].deliveries[0].acknowledged_at.is_none());
    }
    let reply = store
        .send(
            &machine("windows"),
            SendMessage {
                sender: b.id.clone(),
                send_key: "reply".into(),
                body: "Answer\nYes".into(),
                to: None,
                broadcast: None,
                reply_to: Some(sent.id.clone()),
            },
        )
        .unwrap();
    assert_eq!(reply.thread_id, sent.thread_id);
    assert_eq!(reply.deliveries[0].recipient, a.id);
    assert_eq!(
        store
            .unread(&machine("windows"), &b.id, page())
            .unwrap()
            .items
            .len(),
        1,
        "Reply does not acknowledge the original"
    );
    let ack = store.ack(&machine("windows"), &b.id, &sent.id).unwrap();
    assert!(ack.acknowledged_at.is_some());
    assert_eq!(
        store
            .ack(&machine("windows"), &b.id, &sent.id)
            .unwrap()
            .acknowledged_at,
        ack.acknowledged_at
    );
    drop(store);
    let restarted = Store::open(&dir.path().join("board.sqlite3")).unwrap();
    assert!(restarted
        .unread(&machine("windows"), &b.id, page())
        .unwrap()
        .items
        .is_empty());
    let history = restarted.thread(&sent.thread_id, page()).unwrap();
    assert_eq!(history.items.len(), 2);
    assert_eq!(
        history.items[0].deliveries[0].acknowledged_at,
        ack.acknowledged_at
    );
    assert_eq!(
        restarted
            .unread(&machine("mac"), &a.id, page())
            .unwrap()
            .items[0]
            .id,
        reply.id
    );
}

#[test]
fn message_board_broadcast_snapshots_membership_and_acknowledges_each_recipient_separately() {
    let (_dir, store) = fixture();
    let a = register(&store, "mac", "sender");
    let b = register(&store, "windows", "one");
    let c = register(&store, "windows", "two");
    let mut broadcast = request(&a, &b, "broadcast");
    broadcast.to = None;
    broadcast.broadcast = Some("switchboard".into());
    let sent = store.send(&machine("mac"), broadcast.clone()).unwrap();
    assert_eq!(sent.deliveries.len(), 2);
    let later = register(&store, "windows", "later");
    assert_eq!(
        store.send(&machine("mac"), broadcast).unwrap().id,
        sent.id,
        "Retry must not recalculate broadcast recipients"
    );
    assert!(store
        .unread(&machine("windows"), &later.id, page())
        .unwrap()
        .items
        .is_empty());
    store.ack(&machine("windows"), &b.id, &sent.id).unwrap();
    assert!(store
        .unread(&machine("windows"), &b.id, page())
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store
            .unread(&machine("windows"), &c.id, page())
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        store.ack(&machine("mac"), &b.id, &sent.id).unwrap_err().0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        store
            .ack(&machine("windows"), &later.id, &sent.id)
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        store
            .send(&machine("windows"), request(&a, &b, "impersonate"))
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
}

#[test]
fn message_board_concurrent_committed_retry_is_unique_and_changed_payload_conflicts() {
    let (_dir, store) = fixture();
    let a = register(&store, "mac", "sender");
    let b = register(&store, "windows", "receiver");
    let store = Arc::new(store);
    let send = request(&a, &b, "lost-response");
    let handles = (0..12)
        .map(|_| {
            let store = store.clone();
            let send = send.clone();
            std::thread::spawn(move || store.send(&machine("mac"), send).unwrap().id)
        })
        .collect::<Vec<_>>();
    let ids = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<Vec<_>>();
    assert!(ids.iter().all(|id| id == &ids[0]));
    let mut changed = send;
    changed.body.push('!');
    assert_eq!(
        store.send(&machine("mac"), changed).unwrap_err().0,
        StatusCode::CONFLICT
    );
    let handles = (0..12)
        .map(|n| {
            let store = store.clone();
            let send = request(&a, &b, &format!("different-{n}"));
            std::thread::spawn(move || store.send(&machine("mac"), send).unwrap().id)
        })
        .collect::<Vec<_>>();
    let ids = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), 12);
    assert_eq!(
        store
            .unread(&machine("windows"), &b.id, page())
            .unwrap()
            .items
            .len(),
        13
    );
}

#[test]
fn message_board_keyset_pagination_remains_bounded_when_previous_pages_are_acknowledged() {
    let (_dir, store) = fixture();
    let a = register(&store, "mac", "sender");
    let b = register(&store, "windows", "receiver");
    let sent = (0..7)
        .map(|n| {
            store
                .send(&machine("mac"), request(&a, &b, &format!("page-{n}")))
                .unwrap()
        })
        .collect::<Vec<_>>();
    let mut query = page();
    query.limit = 2;
    let mut ids = vec![];
    loop {
        let batch = store
            .unread(&machine("windows"), &b.id, query.clone())
            .unwrap();
        assert!(batch.items.len() <= 2);
        for msg in batch.items {
            ids.push(msg.id.clone());
            store.ack(&machine("windows"), &b.id, &msg.id).unwrap();
        }
        if let Some(next) = batch.next_cursor {
            query.after = next;
        } else {
            break;
        }
    }
    assert_eq!(ids, sent.iter().map(|m| m.id.clone()).collect::<Vec<_>>());
    let mut invalid = page();
    invalid.limit = 101;
    assert_eq!(
        store
            .unread(&machine("windows"), &b.id, invalid)
            .unwrap_err()
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut invalid = page();
    invalid.after = u64::MAX;
    assert_eq!(
        store.participants(invalid).unwrap_err().0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn message_board_authenticated_transport_never_exposes_terminals_or_artifacts() {
    use isahc::prelude::*;
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::write(&token, "0123456789abcdef0123456789abcdef").unwrap();
    let config = transport::HostConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        database: Some(dir.path().join("board.db")),
        machines: vec![transport::MachineCredential {
            id: "mac".into(),
            name: "Mac".into(),
            token_file: token,
        }],
        tls_cert: None,
        tls_key: None,
    };
    let app = transport::router(&config).unwrap();
    let listener = tokio::net::TcpListener::bind(config.listen).await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let checks = tokio::task::spawn_blocking(move || {
        let request = |path: &str, token: Option<&str>, origin: Option<&str>| {
            let mut builder = isahc::Request::get(format!("http://{address}{path}"));
            if let Some(token) = token {
                builder = builder.header("Authorization", format!("Bearer {token}"));
            }
            if let Some(origin) = origin {
                builder = builder.header("Origin", origin);
            }
            let mut response = isahc::send(builder.body(()).unwrap()).unwrap();
            let status = response.status().as_u16();
            let text = response.text().unwrap();
            (status, text)
        };
        assert_eq!(request("/api/message-board/health", None, None).0, 401);
        assert_eq!(
            request("/api/message-board/health", Some("wrong"), None).0,
            401
        );
        let token = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            request(
                "/api/message-board/health",
                Some(token),
                Some("http://artifact.invalid")
            )
            .0,
            401
        );
        let (status, body) = request("/api/message-board/health", Some(token), None);
        assert_eq!(status, 200);
        assert!(!body.contains(token));
        for path in [
            "/api/hosts",
            "/hosts/mac/ws/terminal/main",
            "/artifacts/file",
            "/login",
        ] {
            assert_eq!(request(path, Some(token), None).0, 404);
        }
        assert_eq!(
            request(
                "/api/message-board/participants?limit=101",
                Some(token),
                None
            )
            .0,
            400
        );
    })
    .await;
    server.abort();
    checks.unwrap();
}

#[test]
fn message_board_lan_listener_requires_tls_and_unique_machine_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let token = dir.path().join("token");
    std::fs::write(&token, "0123456789abcdef0123456789abcdef").unwrap();
    let mut config = transport::HostConfig {
        listen: "0.0.0.0:8098".parse().unwrap(),
        database: Some(dir.path().join("board.db")),
        machines: vec![transport::MachineCredential {
            id: "mac".into(),
            name: "Mac".into(),
            token_file: token.clone(),
        }],
        tls_cert: None,
        tls_key: None,
    };
    assert!(transport::router(&config)
        .unwrap_err()
        .to_string()
        .contains("requires a TLS"));
    config.listen = "127.0.0.1:0".parse().unwrap();
    config.machines.push(transport::MachineCredential {
        id: "windows".into(),
        name: "Windows".into(),
        token_file: token,
    });
    assert!(transport::router(&config)
        .unwrap_err()
        .to_string()
        .contains("tokens must be distinct"));
}
