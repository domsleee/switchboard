use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

async fn board_call(mesh: &Mesh, method: Method, path: &str, body: Value) -> (StatusCode, Value) {
    let response = mesh
        .board(
            Request::builder()
                .method(method)
                .uri(format!("/api/message-board/{path}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), LIMIT).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"error":String::from_utf8_lossy(&bytes)})),
    )
}

#[tokio::test]
async fn shared_board_routes_three_computers_to_one_durable_authenticated_host() {
    use tower::ServiceExt;
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let ip = route.local_addr().unwrap().ip();
    let temp = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind((ip, 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("https://{}", listener.local_addr().unwrap());
    let mac = machine(&temp.path().join("mac"), "Mac", &endpoint).await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let laptop = machine(
        &temp.path().join("laptop"),
        "Laptop",
        "https://192.0.2.3:8091",
    )
    .await;
    assert_eq!(
        board_call(&windows, Method::GET, "inboxes", Value::Null)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    for peer in [&windows, &laptop] {
        let invite = invitation(&mac, 1000).await;
        let (_, approval) = approved(&mac, peer, &invite, 1000).await;
        mac.complete(peer.install(approval, &invite).await.unwrap())
            .await
            .unwrap();
    }
    let mac_id = mac.database.lock().await.local.as_ref().unwrap().id.clone();
    let windows_id = windows
        .database
        .lock()
        .await
        .local
        .as_ref()
        .unwrap()
        .id
        .clone();
    let laptop_id = laptop
        .database
        .lock()
        .await
        .local
        .as_ref()
        .unwrap()
        .id
        .clone();
    // Windows' stale two-computer roster is reconciled without changing the host.
    windows
        .exchange(mac.prepare_sync(&windows_id).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        windows
            .database
            .lock()
            .await
            .membership
            .as_ref()
            .unwrap()
            .value
            .administrator,
        mac_id
    );
    let tls = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(mac.tls().unwrap()));
    let handle = axum_server::Handle::new();
    let server = axum_server::from_tcp_rustls(listener, tls)
        .unwrap()
        .handle(handle.clone());
    let router = transport::gateway_router(mac.clone());
    let task = tokio::spawn(async move { server.serve(router.into_make_service()).await.unwrap() });
    windows.select_board_host(&mac_id).await.unwrap();
    laptop
        .exchange(mac.prepare_sync(&laptop_id).await.unwrap())
        .await
        .unwrap();
    let (status, sender) = board_call(
        &windows,
        Method::POST,
        "participants",
        json!({"name":"worker","project":"switchboard"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sender}");
    assert_eq!(sender["machine_id"], windows_id);
    let (status, recipient) = board_call(
        &laptop,
        Method::POST,
        "participants",
        json!({"name":"reviewer","project":"switchboard"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{recipient}");
    let (status, message) = board_call(&windows, Method::POST, "messages", json!({"sender":sender["id"],"send_key":"mesh-message","body":"Review this","to":recipient["id"]})).await;
    assert_eq!(status, StatusCode::OK, "{message}");
    let path = format!(
        "participants/{}/unread?limit=1",
        recipient["id"].as_str().unwrap()
    );
    let (status, inbox) = board_call(&laptop, Method::GET, &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{inbox}");
    assert_eq!(inbox["items"][0]["id"], message["id"]);
    // The host independently sees the same durable record.
    let (_, inbox) = board_call(
        &mac,
        Method::GET,
        &format!("participants/{}/inbox", recipient["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(inbox["items"][0]["id"], message["id"]);
    let (status, _) = board_call(
        &laptop,
        Method::POST,
        "messages",
        json!({"sender":sender["id"],"send_key":"spoof","body":"Forged","to_machine":mac_id}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, machine_message) = board_call(&windows, Method::POST, "messages", json!({"sender":sender["id"],"send_key":"machine-message","body":"Machine handoff","to_machine":laptop_id})).await;
    assert_eq!(status, StatusCode::OK, "{machine_message}");
    let (_, inbox) = board_call(
        &laptop,
        Method::GET,
        &format!("machines/{laptop_id}/unread"),
        Value::Null,
    )
    .await;
    assert_eq!(inbox["items"][0]["id"], machine_message["id"]);
    // JSON escaping can grow a valid 64 KiB message sixfold on the wire.
    let (status, large) = board_call(&windows, Method::POST, "messages", json!({"sender":sender["id"],"send_key":"escaped-message","body":"\u{1}".repeat(64 * 1024),"to_machine":laptop_id})).await;
    assert_eq!(status, StatusCode::OK, "{large}");
    let bearer = mac.database.lock().await.outgoing[&windows_id]
        .gateway
        .clone();
    let authority = endpoint.strip_prefix("https://").unwrap();
    for (token, origin, expected) in [
        ("invalid", false, StatusCode::UNAUTHORIZED),
        (&bearer, true, StatusCode::FORBIDDEN),
    ] {
        let mut request = Request::builder()
            .uri("/mesh/board/inboxes")
            .header(header::HOST, authority)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        if origin {
            request = request.header(header::ORIGIN, "http://localhost");
        }
        let response = transport::gateway_router(mac.clone())
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
    }
    // Revoked membership cannot access the board, even with its old credential.
    {
        let mut db = mac.database.lock().await;
        db.membership
            .as_mut()
            .unwrap()
            .value
            .members
            .remove(&windows_id);
    }
    assert_eq!(
        board_call(&windows, Method::GET, "inboxes", Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    handle.shutdown();
    task.await.unwrap();
    assert_eq!(
        board_call(&laptop, Method::GET, "inboxes", Value::Null)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    for peer in [&windows, &laptop] {
        assert!(
            !std::fs::read_dir(&peer.storage.root).unwrap().any(|p| p
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("board-")),
            "A non-host must never create a competing board"
        );
    }
    assert!(std::fs::read_dir(&mac.storage.root).unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".sqlite3")));
}

#[derive(Default)]
struct FakeIssuer(AtomicUsize);
impl TokenIssuer for FakeIssuer {
    fn issue(&self, _peer: &str) -> anyhow::Result<String> {
        Ok(format!(
            "isolated-terminal-{}",
            self.0.fetch_add(1, Ordering::SeqCst)
        ))
    }
}
async fn machine(root: &Path, label: &str, address: &str) -> Arc<Mesh> {
    let engine = Arc::new(Host::new(super::super::tests::config("http://127.0.0.1:1")).unwrap());
    let mesh = Mesh::with_issuer(root.to_owned(), engine, Arc::new(FakeIssuer::default()))
        .await
        .unwrap();
    let mut db = mesh.database.lock().await;
    db.local = Some(mesh.identity.member(label.into(), address.into()).unwrap());
    mesh.save(&db).unwrap();
    drop(db);
    mesh
}
async fn invitation(mac: &Mesh, time: u64) -> Invitation {
    let response = mac.create("Isolated mesh".into(), time).await.unwrap();
    Invitation::parse(response["link"].as_str().unwrap(), time).unwrap()
}
async fn attempt(client: &Mesh, invitation: &Invitation) -> JoinAttempt {
    let member = client.database.lock().await.local.clone().unwrap();
    JoinAttempt {
        secret: invitation.secret.clone(),
        request: client
            .identity
            .sign(JoinRequest {
                invitation: invitation.id.clone(),
                request: secret(),
                member,
            })
            .unwrap(),
    }
}
async fn approved(
    mac: &Mesh,
    client: &Mesh,
    invitation: &Invitation,
    time: u64,
) -> (JoinAttempt, Approved) {
    let attempt = attempt(client, invitation).await;
    let code = match mac.request(attempt.clone(), time).await.unwrap() {
        Decision::Pending { code } => code,
        _ => panic!("approval must be explicit"),
    };
    assert_eq!(
        code,
        verification(invitation, &attempt.request.value).unwrap()
    );
    mac.approve(
        &invitation.id,
        &attempt.request.value.request,
        &code,
        true,
        time,
    )
    .await
    .unwrap();
    let approval = match mac.request(attempt.clone(), time).await.unwrap() {
        Decision::Approved { approved } => approved,
        _ => panic!("approval expected"),
    };
    (attempt, approval)
}

#[tokio::test]
async fn explicit_approval_installs_bilateral_credentials_and_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invitation = invitation(&mac, 1000).await;
    assert_eq!(
        mac.database
            .lock()
            .await
            .membership
            .as_ref()
            .unwrap()
            .value
            .members
            .len(),
        1
    );
    assert!(mac.hosts().is_empty());
    let (request, approval) = approved(&mac, &windows, &invitation, 1000).await;
    let envelope = windows
        .install(approval.clone(), &invitation)
        .await
        .unwrap();
    mac.complete(envelope.clone()).await.unwrap();
    mac.complete(envelope).await.unwrap();
    windows.install(approval, &invitation).await.unwrap();
    assert_eq!(mac.hosts().len(), 1);
    assert_eq!(windows.hosts().len(), 1);
    let config = &windows.hosts()[0].config;
    assert_eq!(config.url, "https://192.0.2.1:8091");
    assert!(config
        .token_file
        .starts_with(temp.path().join("windows").to_str().unwrap()));
    assert!(!config.token_file.contains("/mac/"));
    assert!(config.zellij_binary.is_none());
    assert_ne!(
        config.token_file,
        config.gateway_token_file.as_ref().unwrap().as_str()
    );
    assert!(
        matches!(
            mac.request(request, 1800).await.unwrap(),
            Decision::Approved { .. }
        ),
        "the approved identity can resume after expiry"
    );
    let before = windows.database.lock().await.local.clone().unwrap();
    let member_status = windows.status().await;
    let admin_status = mac.status().await;
    assert_eq!(member_status["can_invite"], true);
    assert_eq!(admin_status["can_invite"], true);
    let status = member_status.to_string();
    assert!(!status.contains("isolated-terminal") && !status.contains(&invitation.secret));
    let mac_id = invitation.administrator.id;
    let db = windows.database.lock().await;
    assert!(!status.contains(&db.incoming[&mac_id].credential.gateway));
    drop(db);
    drop(windows);
    let engine = Arc::new(Host::new(super::super::tests::config("http://127.0.0.1:1")).unwrap());
    let restarted = Mesh::with_issuer(
        temp.path().join("windows"),
        engine,
        Arc::new(FakeIssuer::default()),
    )
    .await
    .unwrap();
    assert!(restarted.database.lock().await.local.as_ref() == Some(&before));
    assert_eq!(restarted.hosts().len(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(temp.path().join("windows"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        for file in std::fs::read_dir(temp.path().join("windows")).unwrap() {
            assert_eq!(
                file.unwrap().metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}

#[tokio::test]
async fn invitation_preview_expiry_cancel_and_denial_never_issue_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    assert!(Invitation::parse(&invite.link().unwrap(), 1600).is_err());
    assert!(Invitation::parse(
        &invite.link().unwrap().replace("switchboard:", "https:"),
        1000
    )
    .is_err());
    for _ in 0..3 {
        Invitation::parse(&invite.link().unwrap(), 1000).unwrap();
    }
    // An inviter whose clock runs a few seconds ahead still works.
    Invitation::parse(&invite.link().unwrap(), 998).unwrap();
    assert!(mac.database.lock().await.invitations[&invite.id]
        .requests
        .is_empty());
    let request = attempt(&windows, &invite).await;
    assert!(mac.request(request.clone(), 1600).await.is_err());
    let code = verification(&invite, &request.request.value).unwrap();
    mac.request(request.clone(), 1000).await.unwrap();
    assert!(mac
        .approve(
            &invite.id,
            &request.request.value.request,
            "WRONG",
            true,
            1000
        )
        .await
        .is_err());
    mac.approve(
        &invite.id,
        &request.request.value.request,
        &code,
        false,
        1000,
    )
    .await
    .unwrap();
    assert!(matches!(
        mac.request(request.clone(), 1000).await.unwrap(),
        Decision::Denied
    ));
    assert!(mac
        .approve(
            &invite.id,
            &request.request.value.request,
            &code,
            true,
            1000
        )
        .await
        .is_err());
    mac.database
        .lock()
        .await
        .invitations
        .get_mut(&invite.id)
        .unwrap()
        .cancelled = true;
    assert!(mac.request(request, 1000).await.is_err());
    assert!(mac.database.lock().await.outgoing.is_empty());
    assert_eq!(
        mac.database
            .lock()
            .await
            .membership
            .as_ref()
            .unwrap()
            .value
            .members
            .len(),
        1
    );
}

#[tokio::test]
async fn concurrent_approval_consumes_an_invitation_once_and_binds_the_exact_request() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let a = machine(&temp.path().join("a"), "A", "https://192.0.2.2:8091").await;
    let b = machine(&temp.path().join("b"), "B", "https://192.0.2.3:8091").await;
    let invite = invitation(&mac, 1000).await;
    let ra = attempt(&a, &invite).await;
    let rb = attempt(&b, &invite).await;
    mac.request(ra.clone(), 1000).await.unwrap();
    mac.request(rb.clone(), 1000).await.unwrap();
    let ca = verification(&invite, &ra.request.value).unwrap();
    let cb = verification(&invite, &rb.request.value).unwrap();
    let (first, second) = tokio::join!(
        mac.approve(&invite.id, &ra.request.value.request, &ca, true, 1000),
        mac.approve(&invite.id, &rb.request.value.request, &cb, true, 1000)
    );
    assert_ne!(first.is_ok(), second.is_ok());
    assert_eq!(
        mac.database
            .lock()
            .await
            .membership
            .as_ref()
            .unwrap()
            .value
            .members
            .len(),
        2
    );
    let approved_request = if first.is_ok() { ra } else { rb };
    let mut replaced = approved_request.request.value.clone();
    replaced.member = b.database.lock().await.local.clone().unwrap();
    replaced.member.name = "Changed".into();
    let substituted = JoinAttempt {
        secret: invite.secret.clone(),
        request: b.identity.sign(replaced).unwrap(),
    };
    assert!(mac.request(substituted, 1000).await.is_err());
}

#[tokio::test]
async fn hpke_rejects_tampering_wrong_recipient_issuer_and_stale_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let other = machine(
        &temp.path().join("other"),
        "Other",
        "https://192.0.2.3:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invite, 1000).await;
    let local = windows.database.lock().await.local.clone().unwrap();
    let mut altered = approval.clone();
    altered.credential.header.version += 1;
    assert!(windows.install(altered, &invite).await.is_err());
    let mut altered = approval.clone();
    altered.credential.ciphertext.replace_range(..1, "!");
    assert!(windows.install(altered, &invite).await.is_err());
    let wrong = other.database.lock().await.local.clone().unwrap();
    assert!(other
        .identity
        .open(&invite.administrator, &wrong, &approval.credential)
        .is_err());
    assert!(windows
        .identity
        .open(&wrong, &local, &approval.credential)
        .is_err());
    let mut altered = approval.clone();
    altered.membership.value.name = "Substituted".into();
    assert!(windows.install(altered, &invite).await.is_err());
    windows.install(approval.clone(), &invite).await.unwrap();
    let credential = mac.database.lock().await.outgoing[&local.id].clone();
    let newer = mac
        .identity
        .seal(&invite.administrator, &local, 2, &credential)
        .unwrap();
    let mut newer_approval = approval.clone();
    newer_approval.credential = newer;
    windows.install(newer_approval, &invite).await.unwrap();
    assert!(windows.install(approval, &invite).await.is_err());
    let envelope = other
        .identity
        .seal(
            &wrong,
            &invite.administrator,
            1,
            &Credential {
                terminal: "isolated".into(),
                gateway: secret(),
            },
        )
        .unwrap();
    assert!(mac.complete(envelope).await.is_err());
}

#[tokio::test]
async fn every_member_can_invite_and_duplicate_names_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invite, 1000).await;
    windows.install(approval, &invite).await.unwrap();
    assert!(windows.create("Isolated mesh".into(), 1000).await.is_ok());
    let duplicate = machine(
        &temp.path().join("duplicate"),
        "windows",
        "https://192.0.2.3:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let request = attempt(&duplicate, &invite).await;
    mac.request(request.clone(), 1000).await.unwrap();
    let code = verification(&invite, &request.request.value).unwrap();
    assert!(mac
        .approve(
            &invite.id,
            &request.request.value.request,
            &code,
            true,
            1000
        )
        .await
        .is_err());
}

#[tokio::test]
async fn failed_atomic_commit_does_not_authorize_a_peer_in_memory() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let request = attempt(&windows, &invite).await;
    mac.request(request.clone(), 1000).await.unwrap();
    let path = mac.storage.root.join("state.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let code = verification(&invite, &request.request.value).unwrap();
    assert!(mac
        .approve(
            &invite.id,
            &request.request.value.request,
            &code,
            true,
            1000
        )
        .await
        .is_err());
    let db = mac.database.lock().await;
    assert!(db.outgoing.is_empty());
    assert!(db.invitations[&invite.id].approved.is_none());
    assert_eq!(db.membership.as_ref().unwrap().value.members.len(), 1);
}

#[test]
fn credentials_reject_public_artifact_storage_and_invalid_endpoints() {
    let temp = tempfile::tempdir().unwrap();
    assert!(storage::Storage::open(&temp.path().join("artifacts/mesh")).is_err());
    for value in [
        "http://192.0.2.1:8091",
        "https://127.0.0.1:8091",
        "https://192.0.2.1",
        "https://example.org:8091",
        "https://u:p@192.0.2.1:8091",
        "https://192.0.2.1:8091/private",
    ] {
        assert!(endpoint(value).is_err(), "{value}");
    }
    assert!(endpoint("https://192.0.2.1:8091").is_ok());
    assert!(endpoint("https://[fd00::1]:8091").is_ok());
}

#[tokio::test]
async fn unavailable_first_gateway_does_not_lock_in_an_incorrect_address() {
    let temp = tempfile::tempdir().unwrap();
    let engine = Arc::new(Host::new(super::super::tests::config("http://127.0.0.1:1")).unwrap());
    let mesh = Mesh::with_issuer(
        temp.path().join("mesh"),
        engine,
        Arc::new(FakeIssuer::default()),
    )
    .await
    .unwrap();
    assert!(mesh
        .configure("Mac".into(), "https://192.0.2.99:8091".into())
        .await
        .is_err());
    assert!(mesh.database.lock().await.local.is_none());
    assert!(mesh.database.lock().await.outgoing.is_empty());
    assert!(mesh.gateway.lock().await.is_none());
}

#[tokio::test]
async fn tls_gateway_authenticates_http_websocket_and_revokes_an_open_socket() {
    gateway_roundtrip(false).await;
}
#[tokio::test]
async fn shared_native_server_pairs_and_authenticates_http_websocket_with_revocation() {
    gateway_roundtrip(true).await;
}
async fn gateway_roundtrip(shared: bool) {
    let temp = tempfile::tempdir().unwrap();
    let logins = Arc::new(AtomicUsize::new(0));
    let count = logins.clone();
    let slow_started = Arc::new(tokio::sync::Notify::new());
    let started = slow_started.clone();
    let native = Router::new()
        .route(
            "/command/login",
            post(move |Json(body): Json<Value>| {
                let count = count.clone();
                async move {
                    assert_eq!(body["auth_token"], "isolated-terminal-0");
                    count.fetch_add(1, Ordering::SeqCst);
                    (
                        [(
                            header::SET_COOKIE,
                            "session_token=isolated-session; HttpOnly",
                        )],
                        Json(json!({"ok":true})),
                    )
                }
            }),
        )
        .route(
            "/slow",
            get(move || {
                let started = started.clone();
                async move {
                    started.notify_one();
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    "delayed isolated response"
                }
            }),
        )
        .route(
            "/session-list",
            get(|headers: HeaderMap| async move {
                assert_eq!(
                    headers.get(header::COOKIE).unwrap(),
                    "session_token=isolated-session"
                );
                Json(json!({"sessions":[{"name":"isolated","web_clients_allowed":true}]}))
            }),
        )
        .route(
            "/ws",
            get(|headers: HeaderMap, ws: WebSocketUpgrade| async move {
                assert_eq!(
                    headers.get(header::COOKIE).unwrap(),
                    "session_token=isolated-session"
                );
                ws.on_upgrade(|mut socket| async move {
                    while let Some(Ok(message)) = socket.recv().await {
                        if socket.send(message).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
    let native_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let native_address = native_listener.local_addr().unwrap();
    let native_task = tokio::spawn(async move {
        axum::serve(native_listener, native).await.unwrap();
    });
    let local = Arc::new(
        Host::new(super::super::tests::config(&format!(
            "http://{native_address}"
        )))
        .unwrap(),
    );
    let mac = Mesh::with_issuer(
        temp.path().join("mac"),
        local,
        Arc::new(FakeIssuer::default()),
    )
    .await
    .unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let authority = format!("192.0.2.1:{}", address.port());
    {
        let mut db = mac.database.lock().await;
        db.local = Some(
            mac.identity
                .member("Mac".into(), format!("https://{authority}"))
                .unwrap(),
        );
        mac.save(&db).unwrap();
    }
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invite, 1000).await;
    let envelope = windows.install(approval, &invite).await.unwrap();
    mac.complete(envelope).await.unwrap();
    let peer = windows
        .database
        .lock()
        .await
        .local
        .as_ref()
        .unwrap()
        .id
        .clone();
    let bearer = mac.database.lock().await.outgoing[&peer].gateway.clone();
    let tls = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(mac.tls().unwrap()));
    let handle = axum_server::Handle::new();
    let server = axum_server::from_tcp_rustls(listener, tls)
        .unwrap()
        .handle(handle.clone());
    let mut bridge_task = None;
    let router = if shared {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let registration = peer_bridge::Registration {
            id: secret(),
            revision: secret(),
            port,
            endpoint: format!("https://{authority}"),
            certificate: mac.identity.certificate.clone(),
            key: mac.identity.tls_key.clone(),
        };
        let storage = storage::Storage::open(&temp.path().join("bridge")).unwrap();
        storage.write("registration.json", &registration).unwrap();
        let internal = peer_bridge::relay_router(mac.clone(), registration.id);
        bridge_task = Some(tokio::spawn(async move {
            axum::serve(listener, internal).await.unwrap();
        }));
        let root = storage.root.clone();
        Router::new()
            .route(
                "/native-test",
                get(|| async { "native cookie routes still work" }),
            )
            .fallback(|| async { StatusCode::UNAUTHORIZED })
            .layer(middleware::from_fn(move |request: Request, next: Next| {
                let root = root.clone();
                async move {
                    if peer_bridge::selected(&request) {
                        peer_bridge::forward(root, request).await
                    } else {
                        next.run(request).await
                    }
                }
            }))
    } else {
        transport::gateway_router(mac.clone())
    };
    let gateway_task = tokio::spawn(async move {
        server.serve(router.into_make_service()).await.unwrap();
    });
    let mut config = super::super::tests::config(&format!("https://{address}"));
    config.tls_fingerprint = Some(invite.administrator.certificate.clone());
    let client = Host::new(config.clone()).unwrap();
    config.tls_fingerprint = Some("0".repeat(64));
    assert!(
        Host::new(config).unwrap().stream().await.is_err(),
        "a substituted certificate is rejected"
    );
    async fn request(
        client: &Host,
        authority: &str,
        bearer: Option<&str>,
        origin: bool,
        method: Method,
        path: &str,
        body: Bytes,
    ) -> StatusCode {
        let mut sender = client.connection(false).await.unwrap();
        let mut request = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, authority)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(bearer) = bearer {
            request = request.header(header::AUTHORIZATION, format!("Bearer {bearer}"));
        }
        if origin {
            request = request.header(header::ORIGIN, "https://attacker.example");
        }
        sender
            .send_request(request.body(Full::new(body)).unwrap())
            .await
            .unwrap()
            .status()
    }
    if shared {
        assert_eq!(
            request(
                &client,
                &authority,
                None,
                false,
                Method::GET,
                "/native-test",
                Bytes::new()
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            request(
                &client,
                &authority,
                None,
                false,
                Method::GET,
                "/mesh/health",
                Bytes::new()
            )
            .await,
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request(
                &client,
                &authority,
                Some(&bearer),
                false,
                Method::GET,
                "/api/mesh",
                Bytes::new()
            )
            .await,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        request(
            &client,
            &authority,
            None,
            false,
            Method::GET,
            "/session-list",
            Bytes::new()
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &client,
            "wrong.example",
            Some(&bearer),
            false,
            Method::GET,
            "/session-list",
            Bytes::new()
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &client,
            &authority,
            Some(&bearer),
            true,
            Method::GET,
            "/session-list",
            Bytes::new()
        )
        .await,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &client,
            &authority,
            Some(&bearer),
            false,
            Method::GET,
            "/session-list",
            Bytes::new()
        )
        .await,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &client,
            &authority,
            None,
            false,
            Method::GET,
            "/mesh/request",
            Bytes::new()
        )
        .await,
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert!(
        mac.database.lock().await.invitations[&invite.id]
            .requests
            .len()
            == 1
    );
    assert_eq!(
        logins.load(Ordering::SeqCst),
        1,
        "the dedicated native credential remains cached"
    );
    let mut ws = format!("wss://{address}/ws").into_client_request().unwrap();
    ws.headers_mut()
        .insert(header::HOST, authority.parse().unwrap());
    ws.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {bearer}").parse().unwrap(),
    );
    let (mut socket, _) = tokio_tungstenite::client_async(ws, client.stream().await.unwrap())
        .await
        .unwrap();
    socket
        .send(Message::Text("isolated input/output".into()))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap().into_text().unwrap(),
        "isolated input/output"
    );
    let slow_host = Host::new(client.config.clone()).unwrap();
    let slow_authority = authority.clone();
    let slow_bearer = bearer.clone();
    let slow = tokio::spawn(async move {
        request(
            &slow_host,
            &slow_authority,
            Some(&slow_bearer),
            false,
            Method::GET,
            "/slow",
            Bytes::new(),
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(3), slow_started.notified())
        .await
        .unwrap();
    {
        let mut db = mac.database.lock().await;
        db.outgoing.remove(&peer);
        mac.save(&db).unwrap();
    }
    assert_eq!(
        request(
            &client,
            &authority,
            Some(&bearer),
            false,
            Method::GET,
            "/session-list",
            Bytes::new()
        )
        .await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), slow)
            .await
            .unwrap()
            .unwrap(),
        StatusCode::UNAUTHORIZED,
        "in-flight HTTP work stops when authorization is removed"
    );
    let closed = tokio::time::timeout(Duration::from_secs(3), socket.next()).await;
    assert!(
        closed.is_ok(),
        "open sockets stop when their credential is removed"
    );
    handle.shutdown();
    gateway_task.await.unwrap();
    if let Some(task) = bridge_task {
        task.abort();
    }
    native_task.abort();
}

#[tokio::test]
async fn direct_delivery_requires_local_approval_and_matching_codes_before_credentials() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8082").await;
    let work = machine(
        &temp.path().join("work"),
        "work (fast)",
        "https://192.0.2.2:8082",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let request = work.receive_offer(invite.clone(), 1000).await.unwrap();
    let code = verification(&invite, &request.value).unwrap();
    assert!(
        request.value
            == work
                .receive_offer(invite.clone(), 1000)
                .await
                .unwrap()
                .value
    );
    assert!(work.database.lock().await.joining.is_none());
    assert!(mac.database.lock().await.outgoing.is_empty());
    assert!(work.database.lock().await.outgoing.is_empty());
    assert!(work
        .answer_offer(&invite.id, "WRONG", true, 1000)
        .await
        .is_err());
    assert!(work.database.lock().await.joining.is_none());
    work.answer_offer(&invite.id, &code, true, 1000)
        .await
        .unwrap();
    let joining = work.database.lock().await.joining.clone().unwrap();
    assert!(matches!(
        mac.request(joining.attempt.clone(), 1000).await.unwrap(),
        Decision::Pending { .. }
    ));
    assert!(
        mac.database.lock().await.outgoing.is_empty(),
        "Receiving computer's approval alone does not trust a discovered certificate"
    );
    mac.approve(&invite.id, &request.value.request, &code, true, 1000)
        .await
        .unwrap();
    let approved = match mac.request(joining.attempt, 1000).await.unwrap() {
        Decision::Approved { approved } => approved,
        _ => panic!("both approvals required"),
    };
    let envelope = work.install(approved, &invite).await.unwrap();
    mac.complete(envelope).await.unwrap();
    assert_eq!(mac.hosts().len(), 1);
    assert_eq!(work.hosts().len(), 1);
}

#[tokio::test]
async fn direct_requests_are_bounded_expire_and_cannot_revive_after_denial() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8082").await;
    let work = machine(&temp.path().join("work"), "Work", "https://192.0.2.2:8082").await;
    let invite = invitation(&mac, 1000).await;
    let request = work.receive_offer(invite.clone(), 1000).await.unwrap();
    let code = verification(&invite, &request.value).unwrap();
    work.answer_offer(&invite.id, &code, false, 1000)
        .await
        .unwrap();
    assert!(work.receive_offer(invite.clone(), 1000).await.is_err());
    assert!(work
        .answer_offer(&invite.id, &code, true, 1000)
        .await
        .is_err());
    for _ in 0..7 {
        work.receive_offer(invitation(&mac, 1000).await, 1000)
            .await
            .unwrap();
    }
    assert!(work
        .receive_offer(invitation(&mac, 1000).await, 1000)
        .await
        .is_err());
    assert!(direct::incoming(&*work.database.lock().await, 1601).is_empty());
    work.receive_offer(invitation(&mac, 1601).await, 1601)
        .await
        .unwrap();
    assert!(work.database.lock().await.outgoing.is_empty());
    let pending = direct::incoming(&*work.database.lock().await, 1601);
    let encoded = serde_json::to_string(&pending).unwrap();
    assert!(
        !encoded.contains("secret")
            && !encoded.contains("signing")
            && !encoded.contains("switchboard://")
    );
}

#[tokio::test]
async fn address_pairing_delivers_over_tls_and_completes_without_copying_secrets() {
    // Choose this host's route address without transmitting any external packet.
    let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
    route.connect("192.0.2.1:9").unwrap();
    let ip = route.local_addr().unwrap().ip();
    let temp = tempfile::tempdir().unwrap();
    let mut handles = Vec::new();
    let mut tasks = Vec::new();
    let mut machines = Vec::new();
    let mut endpoints = Vec::new();
    let mut clients = Vec::new();
    for label in ["Mac", "work (fast)", "Laptop"] {
        let listener = std::net::TcpListener::bind((ip, 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("https://{}", listener.local_addr().unwrap());
        let mesh = machine(&temp.path().join(label), label, &endpoint).await;
        *mesh.gateway.lock().await = Some(endpoint.clone());
        let handle = axum_server::Handle::new();
        let server = axum_server::from_tcp_rustls(
            listener,
            axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(mesh.tls().unwrap())),
        )
        .unwrap()
        .handle(handle.clone());
        let router = transport::gateway_router(mesh.clone());
        tasks.push(tokio::spawn(async move {
            server.serve(router.into_make_service()).await.unwrap();
        }));
        handles.push(handle);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut state = super::super::state(
            &RelayConfig {
                hosts: vec![],
                artifact_proxy: None,
            },
            port,
        )
        .await
        .unwrap();
        state.mesh = Some(mesh.clone());
        let router = super::super::app(state);
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
        clients.push(
            Host::new(super::super::tests::config(&format!(
                "http://127.0.0.1:{port}"
            )))
            .unwrap(),
        );
        machines.push(mesh);
        endpoints.push(endpoint);
    }
    async fn call(client: &Host, path: &str, body: Value) -> UpstreamResponse {
        client
            .raw_request(
                Method::POST,
                path,
                serde_json::to_vec(&body).unwrap().into(),
                "application/json",
                None,
            )
            .await
            .unwrap()
    }
    let script = clients[0]
        .raw_request(Method::GET, "/pairing-notice.js", Bytes::new(), "", None)
        .await
        .unwrap();
    assert_eq!(script.status, StatusCode::OK);
    // Creating an invitation leaves a one-computer group that must not block joining.
    let own = call(
        &clients[1],
        "/api/mesh/invitations",
        json!({"name":"Own group","computer_name":"work (fast)","address":endpoints[1]}),
    )
    .await;
    assert_eq!(own.status, StatusCode::OK);
    let sent=call(&clients[0],"/api/mesh/add",json!({"target":endpoints[1],"name":"Direct test","computer_name":"Mac","address":endpoints[0]})).await;
    assert_eq!(
        sent.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&sent.body)
    );
    let sent: Value = serde_json::from_slice(&sent.body).unwrap();
    assert!(sent.get("link").is_none());
    let pending = machines[1].status().await;
    assert_eq!(pending["incoming"][0]["code"], sent["code"]);
    assert_eq!(pending["incoming"][0]["computer"], "Mac");
    assert!(machines[0].status().await["requests"]
        .as_array()
        .unwrap()
        .is_empty());
    for mesh in &machines {
        assert!(mesh.database.lock().await.outgoing.is_empty());
    }
    let wrong = call(
        &clients[1],
        "/api/mesh/answer",
        json!({"invitation":sent["invitation"],"code":"WRONG","allow":true}),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::BAD_REQUEST);
    let allowed = call(
        &clients[1],
        "/api/mesh/answer",
        json!({"invitation":sent["invitation"],"code":sent["code"],"allow":true}),
    )
    .await;
    assert_eq!(allowed.status, StatusCode::OK);
    // The computer that chose Add computer does not approve a second time.
    assert!(machines[0].status().await["requests"]
        .as_array()
        .unwrap()
        .is_empty());
    // Accepting completes pairing without a further step on either computer.
    for _ in 0..50 {
        if machines[1].hosts().len() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(machines[0].hosts().len(), 1);
    assert_eq!(machines[1].hosts().len(), 1);
    // Add from a joined computer, not the computer that started the group.
    let sent = call(
        &clients[1],
        "/api/mesh/add",
        json!({
            "target":endpoints[2], "name":"Direct test",
            "computer_name":"work (fast)", "address":endpoints[1]
        }),
    )
    .await;
    assert_eq!(
        sent.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&sent.body)
    );
    let sent: Value = serde_json::from_slice(&sent.body).unwrap();
    let allowed = call(
        &clients[2],
        "/api/mesh/answer",
        json!({
            "invitation":sent["invitation"], "code":sent["code"], "allow":true
        }),
    )
    .await;
    assert_eq!(
        allowed.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&allowed.body)
    );
    // The first computer was offline during enrollment. Ordinary background sync
    // must discover the new member and exchange credentials in all directions.
    for _ in 0..3 {
        futures_util::future::join_all(machines.iter().map(|m| m.synchronize())).await;
    }
    for mesh in &machines {
        assert_eq!(mesh.hosts().len(), 2);
        assert_eq!(mesh.status().await["members"].as_array().unwrap().len(), 3);
        let db = mesh.database.lock().await;
        assert_eq!(db.outgoing.len(), 2);
        assert_eq!(db.incoming.len(), 2);
        for other in &machines {
            if Arc::ptr_eq(mesh, other) {
                continue;
            }
            let other_db = other.database.lock().await;
            let local_id = &db.local.as_ref().unwrap().id;
            let other_id = &other_db.local.as_ref().unwrap().id;
            assert_eq!(
                db.incoming[other_id].credential.gateway,
                other_db.outgoing[local_id].gateway
            );
            assert_eq!(
                db.incoming[other_id].credential.terminal,
                other_db.outgoing[local_id].terminal
            );
        }
    }
    // Repeated sync is idempotent, and persisted state restores the full catalog.
    let before: Vec<_> = machines
        .iter()
        .map(|m| std::fs::read(m.storage.root.join("state.json")).unwrap())
        .collect();
    for mesh in &machines {
        mesh.synchronize().await;
    }
    for (index, mesh) in machines.iter().enumerate() {
        assert_eq!(
            before[index],
            std::fs::read(mesh.storage.root.join("state.json")).unwrap()
        );
        let db: Database = mesh.storage.read("state.json").unwrap().unwrap();
        mesh.catalog(&db).unwrap();
        assert_eq!(mesh.hosts().len(), 2);
    }
    for handle in handles {
        handle.shutdown();
    }
    for task in tasks {
        task.abort();
    }
}

#[tokio::test]
async fn group_sync_merges_concurrent_additions_and_rejects_untrusted_updates() {
    let temp = tempfile::tempdir().unwrap();
    let mut machines = Vec::new();
    for (i, label) in ["A", "B", "C", "D", "E", "Outsider"].iter().enumerate() {
        machines.push(
            machine(
                &temp.path().join(label),
                label,
                &format!("https://192.0.2.{}:8082", i + 1),
            )
            .await,
        );
    }
    for (from, to) in [(0, 1), (0, 2), (1, 3), (2, 4)] {
        let invite = invitation(&machines[from], 1000).await;
        let (_, approval) = approved(&machines[from], &machines[to], &invite, 1000).await;
        let envelope = machines[to].install(approval, &invite).await.unwrap();
        machines[from].complete(envelope).await.unwrap();
    }
    let a = &machines[0];
    let b = &machines[1];
    let a_id = a.database.lock().await.local.as_ref().unwrap().id.clone();
    let update = b.prepare_sync(&a_id).await.unwrap();
    let original = std::fs::read(a.storage.root.join("state.json")).unwrap();
    let mut tampered = serde_json::to_value(&update).unwrap();
    tampered["membership"]["value"]["name"] = json!("Different group");
    assert!(a
        .exchange(serde_json::from_value(tampered).unwrap())
        .await
        .is_err());
    let mut forged = serde_json::to_value(&update).unwrap();
    let value: Membership = serde_json::from_value(forged["membership"]["value"].clone()).unwrap();
    forged["membership"] = serde_json::to_value(machines[5].identity.sign(value).unwrap()).unwrap();
    assert!(a
        .exchange(serde_json::from_value(forged).unwrap())
        .await
        .is_err());
    let mut corrupt = serde_json::to_value(&update).unwrap();
    corrupt["credential"]["ciphertext"] = json!("broken");
    assert!(a
        .exchange(serde_json::from_value(corrupt).unwrap())
        .await
        .is_err());
    assert_eq!(
        original,
        std::fs::read(a.storage.root.join("state.json")).unwrap(),
        "Rejected updates cannot change saved membership or credentials"
    );
    // Reconcile two independently approved additions, including stale rosters.
    for _ in 0..3 {
        for source in &machines[..5] {
            let ids: Vec<_> = source
                .database
                .lock()
                .await
                .membership
                .as_ref()
                .unwrap()
                .value
                .members
                .keys()
                .cloned()
                .collect();
            for target in &machines[..5] {
                if Arc::ptr_eq(source, target) {
                    continue;
                }
                let target_id = target
                    .database
                    .lock()
                    .await
                    .local
                    .as_ref()
                    .unwrap()
                    .id
                    .clone();
                if !ids.contains(&target_id) {
                    continue;
                }
                let response = target
                    .exchange(source.prepare_sync(&target_id).await.unwrap())
                    .await;
                if let Ok(response) = response {
                    source.exchange(response).await.unwrap();
                }
            }
        }
    }
    for mesh in &machines[..5] {
        assert_eq!(mesh.hosts().len(), 4);
        assert_eq!(
            mesh.database
                .lock()
                .await
                .membership
                .as_ref()
                .unwrap()
                .value
                .members
                .len(),
            5
        );
    }
    // Replaying the earlier valid roster must not remove the concurrent addition.
    a.exchange(update).await.unwrap();
    assert_eq!(a.hosts().len(), 4);
}

#[tokio::test]
async fn explicit_board_host_is_independent_of_administrator_and_syncs_to_new_members() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invite, 1000).await;
    mac.complete(windows.install(approval, &invite).await.unwrap())
        .await
        .unwrap();
    let mac_id = mac.database.lock().await.local.as_ref().unwrap().id.clone();
    let windows_id = windows
        .database
        .lock()
        .await
        .local
        .as_ref()
        .unwrap()
        .id
        .clone();
    assert_eq!(
        board_call(&mac, Method::GET, "inboxes", Value::Null)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
    let stale = windows.prepare_sync(&mac_id).await.unwrap();
    assert_eq!(
        windows.select_board_host(&windows_id).await.unwrap()["host_id"],
        windows_id
    );
    mac.exchange(windows.prepare_sync(&mac_id).await.unwrap())
        .await
        .unwrap();
    mac.exchange(stale).await.unwrap(); // Older peers cannot erase an explicit selection.
    assert_eq!(
        Mesh::board_host_id(&*mac.database.lock().await),
        Some(windows_id.as_str())
    );
    assert_eq!(
        mac.database
            .lock()
            .await
            .membership
            .as_ref()
            .unwrap()
            .value
            .administrator,
        mac_id
    );
    assert!(mac.select_board_host(&mac_id).await.is_err());
    assert_eq!(
        windows.select_board_host(&windows_id).await.unwrap()["state"],
        "selected"
    );
    assert_eq!(
        board_call(
            &windows,
            Method::POST,
            "participants",
            json!({"name":"worker","project":"p"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let group = mac
        .database
        .lock()
        .await
        .membership
        .as_ref()
        .unwrap()
        .value
        .id
        .clone();
    assert!(!mac.board_database(&group).exists());
    let laptop = machine(
        &temp.path().join("laptop"),
        "Laptop",
        "https://192.0.2.3:8091",
    )
    .await;
    let invite = invitation(&mac, 1001).await;
    let (_, approval) = approved(&mac, &laptop, &invite, 1001).await;
    mac.complete(laptop.install(approval, &invite).await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        Mesh::board_host_id(&*laptop.database.lock().await),
        Some(windows_id.as_str())
    );
    let persisted: Database =
        serde_json::from_slice(&std::fs::read(temp.path().join("windows/state.json")).unwrap())
            .unwrap();
    assert_eq!(Mesh::board_host_id(&persisted), Some(windows_id.as_str()));
}

#[tokio::test]
async fn board_host_selection_rejects_existing_database_and_signed_conflicts_fail_closed() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invite, 1000).await;
    mac.complete(windows.install(approval, &invite).await.unwrap())
        .await
        .unwrap();
    let mac_id = mac.database.lock().await.local.as_ref().unwrap().id.clone();
    let windows_id = windows
        .database
        .lock()
        .await
        .local
        .as_ref()
        .unwrap()
        .id
        .clone();
    let group = mac
        .database
        .lock()
        .await
        .membership
        .as_ref()
        .unwrap()
        .value
        .id
        .clone();
    let database = mac.board_database(&group);
    std::fs::write(&database, "existing database must not be overwritten").unwrap();
    assert!(mac
        .select_board_host(&mac_id)
        .await
        .unwrap_err()
        .to_string()
        .contains("migration"));
    let (status, body) = board_call(&mac, Method::GET, "inboxes", Value::Null).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["board_host"]["state"], "legacy_database");
    assert_eq!(
        std::fs::read_to_string(&database).unwrap(),
        "existing database must not be overwritten"
    );
    std::fs::remove_file(database).unwrap();
    // Two initial decisions made while disconnected cannot overwrite each other on sync.
    mac.select_board_host(&mac_id).await.unwrap();
    windows.select_board_host(&windows_id).await.unwrap();
    assert_eq!(
        board_call(
            &mac,
            Method::POST,
            "participants",
            json!({"name":"preserved","project":"p"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let before = std::fs::read(mac.board_database(&group)).unwrap();
    let reply = mac
        .exchange(windows.prepare_sync(&mac_id).await.unwrap())
        .await
        .unwrap();
    windows.exchange(reply).await.unwrap();
    for mesh in [&mac, &windows] {
        assert_eq!(
            mesh.board_host_status(&*mesh.database.lock().await)["state"],
            "conflict"
        );
        assert_eq!(
            board_call(mesh, Method::GET, "inboxes", Value::Null)
                .await
                .0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let persisted: Database =
            serde_json::from_slice(&std::fs::read(mesh.storage.root.join("state.json")).unwrap())
                .unwrap();
        assert_eq!(persisted.board_hosts.len(), 2);
    }
    assert_eq!(std::fs::read(mac.board_database(&group)).unwrap(), before);
    assert!(!windows.board_database(&group).exists());
}

#[tokio::test]
async fn board_host_approval_rejects_forgery_unpaired_host_and_cross_group_replay() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invite = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invite, 1000).await;
    mac.complete(windows.install(approval, &invite).await.unwrap())
        .await
        .unwrap();
    let db = windows.database.lock().await;
    let windows_id = db.local.as_ref().unwrap().id.clone();
    let membership = &db.membership.as_ref().unwrap().value;
    let mac_id = membership.administrator.clone();
    let choice: board_host::Choice = serde_json::from_value(
        json!({"group_id":membership.id,"host_id":windows_id,"selector_id":mac_id}),
    )
    .unwrap();
    drop(db);
    assert!(windows
        .approve_board_host(windows.identity.sign(choice.clone()).unwrap())
        .await
        .is_err());
    let mut wrong_group = serde_json::to_value(&choice).unwrap();
    wrong_group["group_id"] = json!("another group");
    assert!(windows
        .approve_board_host(
            mac.identity
                .sign(serde_json::from_value(wrong_group).unwrap())
                .unwrap()
        )
        .await
        .is_err());
    assert!(mac.select_board_host("unpaired-legacy-host").await.is_err());
    windows
        .approve_board_host(mac.identity.sign(choice).unwrap())
        .await
        .unwrap();
    let mut forged = serde_json::to_value(windows.prepare_sync(&mac_id).await.unwrap()).unwrap();
    forged["board_hosts"][0]["approval"]["signature"] = json!("forged");
    assert!(mac
        .exchange(serde_json::from_value(forged).unwrap())
        .await
        .is_err());
    assert!(mac.database.lock().await.board_hosts.is_empty());

    assert_eq!(
        Mesh::board_host_id(&*windows.database.lock().await),
        Some(windows_id.as_str())
    );
}

#[tokio::test]
async fn pairing_a_configured_computer_lists_it_once_and_controls_it_through_the_gateway() {
    let temp = tempfile::tempdir().unwrap();
    let mac = machine(&temp.path().join("mac"), "Mac", "https://192.0.2.1:8091").await;
    let windows = machine(
        &temp.path().join("windows"),
        "Windows",
        "https://192.0.2.2:8091",
    )
    .await;
    let invitation = invitation(&mac, 1000).await;
    let (_, approval) = approved(&mac, &windows, &invitation, 1000).await;
    let envelope = windows.install(approval, &invitation).await.unwrap();
    mac.complete(envelope).await.unwrap();
    let mut configured = super::super::tests::config("https://192.0.2.2:8091/");
    configured.id = "windows".into();
    let configured = Arc::new(Host::new(configured).unwrap());
    let state = super::super::RelayState {
        hosts: Arc::new([("windows".to_string(), configured.clone())].into()),
        order: Arc::new(vec!["windows".into()]),
        port: 0,
        attention: Default::default(),
        mesh: Some(mac.clone()),
    };
    let listed: Vec<_> = state
        .all_hosts()
        .iter()
        .map(|h| h.config.id.clone())
        .collect();
    assert_eq!(
        listed,
        ["windows"],
        "the paired twin must not duplicate tabs"
    );
    let twin = state
        .paired_twin(&configured)
        .expect("control routes through the gateway");
    assert_eq!(twin.config.escape_transport.as_deref(), Some("gateway"));
    assert!(state.paired_twin(&twin).is_none());
    assert!(
        state.host(&twin.config.id).is_some(),
        "board routes still resolve the peer"
    );
}
