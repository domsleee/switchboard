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
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
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
        to_machine: None,
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
                to_machine: None,
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

#[test]
fn message_board_computer_inbox_is_durable_independent_and_retry_safe() {
    let (dir, store) = fixture();
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
    let sender = register(&store, "mac", "sender");
    let mut send = request(&sender, &sender, "computer-delivery");
    send.to = None;
    send.to_machine = Some("windows".into());
    let sent = store.send(&machine("mac"), send.clone()).unwrap();
    assert_eq!(sent.deliveries[0].recipient_kind, "computer");
    assert_eq!(sent.deliveries[0].recipient, "windows");
    assert_eq!(
        store.send(&machine("mac"), send.clone()).unwrap().id,
        sent.id
    );
    let listing = store.inboxes(&machine("mac"), page()).unwrap();
    let windows = listing["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "windows")
        .unwrap();
    assert_eq!(windows["unread_count"], 1);
    assert!(windows["participants"].as_array().unwrap().is_empty());
    for _ in 0..2 {
        assert_eq!(
            store
                .inbox("windows", true, false, page())
                .unwrap()
                .items
                .len(),
            1
        );
        assert!(
            store.thread(&sent.thread_id, page()).unwrap().items[0].deliveries[0]
                .acknowledged_at
                .is_none()
        );
    }
    assert_eq!(
        store
            .machine_ack(&machine("mac"), "windows", &sent.id)
            .unwrap_err()
            .0,
        StatusCode::FORBIDDEN
    );
    let receiver = register(&store, "windows", "receiver");
    assert!(store
        .unread(&machine("windows"), &receiver.id, page())
        .unwrap()
        .items
        .is_empty());
    let mut reply = request(&receiver, &sender, "reply-computer");
    reply.to = None;
    reply.reply_to = Some(sent.id.clone());
    assert_eq!(
        store.send(&machine("windows"), reply).unwrap().thread_id,
        sent.thread_id
    );
    let personal = store
        .send(&machine("mac"), request(&sender, &receiver, "personal"))
        .unwrap();
    let ack = store
        .machine_ack(&machine("windows"), "windows", &sent.id)
        .unwrap();
    assert_eq!(
        store
            .machine_ack(&machine("windows"), "windows", &sent.id)
            .unwrap()
            .acknowledged_at,
        ack.acknowledged_at
    );
    assert_eq!(
        store
            .unread(&machine("windows"), &receiver.id, page())
            .unwrap()
            .items[0]
            .id,
        personal.id
    );
    drop(store);
    let store = Store::open(&dir.path().join("board.sqlite3")).unwrap();
    assert!(store
        .inbox("windows", true, true, page())
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store.inbox("windows", true, false, page()).unwrap().items[0].deliveries[0].acknowledged_at,
        ack.acknowledged_at
    );
    assert_eq!(
        store.send(&machine("mac"), send.clone()).unwrap().id,
        sent.id
    );
    send.to_machine = Some("mac".into());
    assert_eq!(
        store.send(&machine("mac"), send).unwrap_err().0,
        StatusCode::CONFLICT
    );
}

#[test]
fn message_board_history_is_paginated_and_filters_project_without_ack() {
    let (_dir, store) = fixture();
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
    let sender = register(&store, "mac", "sender");
    let receiver = register(&store, "windows", "receiver");
    for n in 0..3 {
        store
            .send(
                &machine("mac"),
                request(&sender, &receiver, &format!("history-{n}")),
            )
            .unwrap();
    }
    let mut query = page();
    query.limit = 2;
    let first = store
        .inbox(&receiver.id, false, false, query.clone())
        .unwrap();
    assert_eq!(first.items.len(), 2);
    query.after = first.next_cursor.unwrap();
    assert_eq!(
        store
            .inbox(&receiver.id, false, false, query)
            .unwrap()
            .items
            .len(),
        1
    );
    let mut query = page();
    query.project = Some("other".into());
    assert!(store
        .inbox(&receiver.id, false, false, query)
        .unwrap()
        .items
        .is_empty());
    assert_eq!(
        store
            .unread(&machine("windows"), &receiver.id, page())
            .unwrap()
            .items
            .len(),
        3
    );
    store.retire(&machine("windows"), &receiver.id).unwrap();
    assert_eq!(
        store
            .inbox(&receiver.id, false, false, page())
            .unwrap()
            .items
            .len(),
        3
    );
    let listing = store.inboxes(&machine("mac"), page()).unwrap();
    let windows = listing["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "windows")
        .unwrap();
    assert_eq!(windows["participants"][0]["active"], false);
    assert_eq!(windows["participants"][0]["unread_count"], 3);
}

#[test]
fn message_board_v1_migration_keeps_original_request_retry_hash() {
    let (dir, store) = fixture();
    let sender = register(&store, "mac", "sender");
    let receiver = register(&store, "windows", "receiver");
    let send = request(&sender, &receiver, "old-key");
    assert!(serde_json::to_value(&send)
        .unwrap()
        .get("to_machine")
        .is_none());
    let sent = store.send(&machine("mac"), send.clone()).unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("board.sqlite3")).unwrap();
    conn.execute_batch(
        "DROP TABLE machine_deliveries; DROP TABLE machines; PRAGMA user_version=1;",
    )
    .unwrap();
    drop(conn);
    drop(store);
    let store = Store::open(&dir.path().join("board.sqlite3")).unwrap();
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
    assert_eq!(store.send(&machine("mac"), send).unwrap().id, sent.id);
    assert_eq!(
        store
            .inbox(&receiver.id, false, false, page())
            .unwrap()
            .items[0]
            .id,
        sent.id
    );
}

#[tokio::test]
async fn message_board_dispatch_enforces_computer_ownership_and_never_acks_history() {
    let (dir, store) = fixture();
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
    let sender = register(&store, "mac", "sender");
    let mut send = request(&sender, &sender, "mesh-machine");
    send.to = None;
    send.to_machine = Some("windows".into());
    let sent = store.send(&machine("mac"), send).unwrap();
    for (caller, path, method, status) in [
        ("mac", "machines/windows/inbox".to_string(), "GET", 200),
        ("mac", "machines/windows/unread".to_string(), "GET", 403),
        (
            "mac",
            format!("machines/windows/ack/{}", sent.id),
            "POST",
            403,
        ),
        ("windows", "machines/windows/unread".to_string(), "GET", 200),
        ("mac", "machines/unknown/inbox".to_string(), "GET", 404),
    ] {
        let req = axum::http::Request::builder()
            .method(method)
            .uri(format!("/api/message-board/{path}"))
            .body(axum::body::Body::empty())
            .unwrap();
        let response = dispatch(
            dir.path().join("board.sqlite3"),
            (caller.into(), caller.into()),
            vec![
                ("mac".into(), "Mac".into()),
                ("windows".into(), "Windows".into()),
            ],
            req,
        )
        .await;
        assert_eq!(response.status().as_u16(), status, "{method} {path}");
    }
    assert!(
        store.inbox("windows", true, false, page()).unwrap().items[0].deliveries[0]
            .acknowledged_at
            .is_none()
    );
}

#[test]
fn message_board_directory_keeps_cross_project_history_reachable_after_resume() {
    let (_dir, store) = fixture();
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
    let sender = register(&store, "mac", "sender");
    let receiver = register(&store, "windows", "receiver");
    store
        .register(
            &machine("windows"),
            Register {
                name: "renamed".into(),
                project: "different-project".into(),
                resume: Some(receiver.id.clone()),
                terminal: None,
            },
        )
        .unwrap();
    let sent = store
        .send(
            &machine("mac"),
            request(&sender, &receiver, "cross-project"),
        )
        .unwrap();
    let mut query = page();
    query.project = Some("switchboard".into());
    let directory = store.inboxes(&machine("mac"), query.clone()).unwrap();
    let windows = directory["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "windows")
        .unwrap();
    assert_eq!(windows["participants"][0]["id"], receiver.id);
    assert_eq!(windows["participants"][0]["name"], "renamed");
    assert_eq!(windows["participants"][0]["project"], "different-project");
    assert_eq!(windows["participants"][0]["unread_count"], 1);
    assert_eq!(
        store
            .inbox(&receiver.id, false, false, query.clone())
            .unwrap()
            .items[0]
            .id,
        sent.id
    );
    store
        .ack(&machine("windows"), &receiver.id, &sent.id)
        .unwrap();
    let directory = store.inboxes(&machine("mac"), query).unwrap();
    let windows = directory["machines"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "windows")
        .unwrap();
    assert_eq!(windows["participants"][0]["id"], receiver.id);
    assert_eq!(windows["participants"][0]["unread_count"], 0);
}

#[test]
fn message_board_removed_computers_stop_new_deliveries_without_replacing_identity() {
    let (_dir, store) = fixture();
    let sender = register(&store, "mac", "sender");
    let survivor = register(&store, "mac", "survivor");
    let receiver = register(&store, "windows", "receiver");
    let retired = register(&store, "windows", "retired");
    store.retire(&machine("windows"), &retired.id).unwrap();
    let old = store
        .send(
            &machine("mac"),
            request(&sender, &receiver, "before-removal"),
        )
        .unwrap();
    let question = store
        .send(
            &machine("windows"),
            request(&receiver, &sender, "question-before-removal"),
        )
        .unwrap();
    store.configure_machines(&[machine("mac")]).unwrap();
    assert_eq!(
        store
            .send(&machine("mac"), request(&sender, &receiver, "removed-id"))
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
    let mut named = request(&sender, &receiver, "removed-name");
    named.to = Some(receiver.name.clone());
    assert_eq!(
        store.send(&machine("mac"), named).unwrap_err().0,
        StatusCode::NOT_FOUND
    );
    let mut reply = request(&sender, &receiver, "removed-reply");
    reply.to = None;
    reply.reply_to = Some(question.id);
    assert_eq!(
        store.send(&machine("mac"), reply).unwrap_err().0,
        StatusCode::CONFLICT
    );
    let mut broadcast = request(&sender, &receiver, "removed-broadcast");
    broadcast.to = None;
    broadcast.broadcast = Some("switchboard".into());
    let sent = store.send(&machine("mac"), broadcast).unwrap();
    assert_eq!(sent.deliveries.len(), 1);
    assert_eq!(sent.deliveries[0].recipient, survivor.id);
    assert_eq!(
        store
            .inbox(&receiver.id, false, false, page())
            .unwrap()
            .items[0]
            .id,
        old.id
    );
    assert_eq!(
        store
            .send(
                &machine("mac"),
                request(&sender, &receiver, "before-removal")
            )
            .unwrap()
            .id,
        old.id,
        "Committed retries survive membership changes"
    );
    store
        .configure_machines(&[machine("mac"), machine("windows")])
        .unwrap();
    assert_eq!(
        store
            .send(&machine("mac"), request(&sender, &receiver, "after-readd"))
            .unwrap()
            .deliveries[0]
            .recipient,
        receiver.id
    );
    assert_eq!(
        store
            .send(&machine("mac"), request(&sender, &retired, "still-retired"))
            .unwrap_err()
            .0,
        StatusCode::CONFLICT
    );
}
