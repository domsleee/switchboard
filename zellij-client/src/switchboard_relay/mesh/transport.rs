use super::*;

pub(in crate::switchboard_relay) fn routes() -> Router<RelayState> {
    Router::new()
        .route("/api/mesh", get(status))
        .route("/api/mesh/invitations", post(create))
        .route("/api/mesh/cancel", post(cancel))
        .route("/api/mesh/preview", post(preview))
        .route("/api/mesh/join", post(join))
        .route("/api/mesh/retry", post(retry))
        .route("/api/mesh/retry-gateway", post(retry_gateway))
        .route("/api/mesh/approve", post(approve))
}
type MeshResult = Result<Json<Value>, Error>;
fn unavailable() -> Error {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        "Pairing requires a configured local loopback terminal engine",
    )
}
fn rejected(error: anyhow::Error) -> Error {
    // Error chains can contain a request URI or TLS diagnostic. Return only the bounded operation error.
    log::debug!("Switchboard mesh operation rejected (details redacted)");
    let reason = error.to_string();
    if reason.contains("expired")
        || reason.contains("cancelled")
        || reason.contains("consumed")
        || reason.contains("Invitation unavailable")
    {
        return (StatusCode::GONE, "Invitation expired, cancelled or consumed. Ask the administrator for a new invitation.");
    }
    if reason.contains("Verification code") || reason.contains("Pairing identity verification") {
        return (
            StatusCode::FORBIDDEN,
            "The verification codes do not match. Deny the request and ask for a new invitation.",
        );
    }
    if reason.contains("Cannot listen")
        || reason.contains("Cannot reach")
        || reason.contains("Inviter unavailable")
    {
        return (StatusCode::BAD_GATEWAY, "Cannot reach the computer's gateway. Check its fixed address, firewall and private network, then retry.");
    }
    (StatusCode::BAD_REQUEST, "Pairing could not continue. Check the address, verification code and invitation expiry; retry or ask for a new invitation.")
}
async fn status(State(state): State<RelayState>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    Ok(Json(mesh.status().await))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    computer_name: String,
    address: String,
}
async fn create(State(state): State<RelayState>, Json(input): Json<Create>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    mesh.configure(input.computer_name, input.address)
        .await
        .map_err(rejected)?;
    Ok(Json(
        mesh.create(input.name, now()).await.map_err(rejected)?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    invitation: String,
}
async fn cancel(State(state): State<RelayState>, Json(input): Json<Cancel>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    let mut committed = mesh.database.lock().await;
    let mut db = committed.clone();
    let local = db.local.as_ref().ok_or_else(unavailable)?;
    if !db
        .membership
        .as_ref()
        .is_some_and(|m| m.value.administrator == local.id)
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Only the administrator can cancel an invitation",
        ));
    }
    let record = db
        .invitations
        .get_mut(&input.invitation)
        .ok_or((StatusCode::NOT_FOUND, "Unknown invitation"))?;
    if record.approved.is_some() {
        return Err((StatusCode::CONFLICT, "Invitation is already consumed"));
    }
    record.cancelled = true;
    mesh.save(&db).map_err(rejected)?;
    *committed = db;
    Ok(Json(json!({"cancelled":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Preview {
    link: String,
}
async fn preview(Json(input): Json<Preview>) -> MeshResult {
    let invite = Invitation::parse(&input.link, now()).map_err(rejected)?;
    // Local parsing only: pasting or opening a link never contacts or consumes the invitation.
    Ok(Json(
        json!({"mesh":invite.mesh_name,"computer":invite.administrator.name,"address":invite.administrator.endpoint,"expires":invite.expires}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Join {
    link: String,
    computer_name: String,
    address: String,
}
async fn join(State(state): State<RelayState>, Json(input): Json<Join>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    let invitation = Invitation::parse(&input.link, now()).map_err(rejected)?;
    mesh.configure(input.computer_name, input.address)
        .await
        .map_err(rejected)?;
    {
        let mut committed = mesh.database.lock().await;
        let mut db = committed.clone();
        if db.membership.is_some() {
            return Err((
                StatusCode::CONFLICT,
                "This computer already belongs to a mesh",
            ));
        }
        if let Some(existing) = &db.joining {
            if existing.invitation.id != invitation.id {
                return Err((
                    StatusCode::CONFLICT,
                    "A pairing is already pending; retry that invitation",
                ));
            }
        } else {
            let member = db.local.clone().ok_or_else(unavailable)?;
            let request = mesh
                .identity
                .sign(JoinRequest {
                    invitation: invitation.id.clone(),
                    request: secret(),
                    member,
                })
                .map_err(rejected)?;
            db.joining = Some(Joining {
                attempt: JoinAttempt {
                    secret: invitation.secret.clone(),
                    request,
                },
                invitation,
            });
            mesh.save(&db).map_err(rejected)?;
            *committed = db;
        }
    }
    Ok(Json(mesh.resume().await.map_err(rejected)?))
}
async fn retry(State(state): State<RelayState>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    Ok(Json(mesh.resume().await.map_err(rejected)?))
}
async fn retry_gateway(State(state): State<RelayState>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    mesh.start_gateway().await.map_err(rejected)?;
    Ok(Json(json!({"started":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approve {
    invitation: String,
    request: String,
    code: String,
    allow: bool,
}
async fn approve(State(state): State<RelayState>, Json(input): Json<Approve>) -> MeshResult {
    let mesh = state.mesh.as_ref().ok_or_else(unavailable)?;
    mesh.approve(
        &input.invitation,
        &input.request,
        &input.code,
        input.allow,
        now(),
    )
    .await
    .map_err(rejected)?;
    Ok(Json(json!({"approved":input.allow})))
}

impl Mesh {
    pub async fn start_gateway(self: &Arc<Self>) -> anyhow::Result<()> {
        let member = match self.database.lock().await.local.clone() {
            Some(member) => member,
            None => return Ok(()),
        };
        let mut gateway = self.gateway.lock().await;
        if let Some((existing, _)) = &*gateway {
            anyhow::ensure!(
                existing == &member.endpoint,
                "Gateway address changed; restart the relay to apply it"
            );
            return Ok(());
        }
        let url = endpoint(&member.endpoint)?;
        let address: std::net::IpAddr = url.host_str().unwrap().trim_matches(['[', ']']).parse()?;
        let socket = std::net::TcpListener::bind((address, url.port().unwrap()))
            .map_err(|_| anyhow::anyhow!("Cannot listen on the gateway address; check that it belongs to this computer and the port is available"))?;
        socket.set_nonblocking(true)?;
        let tls = self.tls()?;
        let handle = axum_server::Handle::new();
        let server = axum_server::from_tcp_rustls(
            socket,
            axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls)),
        )?
        .handle(handle.clone());
        let app = gateway_router(self.clone());
        let mesh = self.clone();
        tokio::spawn(async move {
            if server.serve(app.into_make_service()).await.is_err() {
                log::error!("Switchboard peer gateway stopped; retry it from Computers");
            }
            mesh.gateway.lock().await.take();
        });
        *gateway = Some((member.endpoint, handle));
        Ok(())
    }
    pub(super) fn tls(&self) -> anyhow::Result<rustls::ServerConfig> {
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let certificates = vec![rustls::pki_types::CertificateDer::from(crypto::decode(
            &self.identity.certificate,
        )?)];
        let key = rustls_pemfile::private_key(&mut self.identity.tls_key.as_bytes())
            .map_err(|_| anyhow::anyhow!("Invalid gateway identity"))?
            .ok_or_else(|| anyhow::anyhow!("Missing gateway identity"))?;
        Ok(rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])?
            .with_no_client_auth()
            .with_single_cert(certificates, key)?)
    }
    pub async fn stop_gateway(&self) {
        if let Some((_, handle)) = self.gateway.lock().await.take() {
            handle.graceful_shutdown(Some(Duration::from_secs(2)));
        }
    }
    async fn resume(&self) -> anyhow::Result<Value> {
        let joining = self
            .database
            .lock()
            .await
            .joining
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No pending enrollment"))?;
        let reply: anyhow::Result<Decision> = self
            .remote(
                &joining.invitation.administrator,
                "/mesh/request",
                &joining.attempt,
            )
            .await;
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                if error.to_string() == "Invitation expired, cancelled or consumed" {
                    let mut committed = self.database.lock().await;
                    let mut db = committed.clone();
                    db.joining = None;
                    self.save(&db)?;
                    *committed = db;
                }
                return Err(error);
            },
        };
        match reply {
            Decision::Pending { code } => {
                anyhow::ensure!(
                    code == verification(&joining.invitation, &joining.attempt.request.value)?,
                    "Pairing identity verification failed"
                );
                Ok(json!({"state":"awaiting_approval","code":code}))
            },
            Decision::Denied => {
                let mut committed = self.database.lock().await;
                let mut db = committed.clone();
                db.joining = None;
                self.save(&db)?;
                *committed = db;
                Ok(json!({"state":"denied"}))
            },
            Decision::Approved { approved } => {
                let envelope = self.install(approved, &joining.invitation).await?;
                let _: Value = self
                    .remote(
                        &joining.invitation.administrator,
                        "/mesh/complete",
                        &envelope,
                    )
                    .await?;
                let mut committed = self.database.lock().await;
                let mut db = committed.clone();
                db.joining = None;
                self.save(&db)?;
                *committed = db;
                Ok(
                    json!({"state":"paired","next":"Check authenticated terminal availability in the computer list"}),
                )
            },
        }
    }
    async fn remote<T: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        member: &Member,
        path: &str,
        body: &T,
    ) -> anyhow::Result<R> {
        let host = Host::new(HostConfig {
            id: member.id.clone(),
            name: member.name.clone(),
            url: member.endpoint.clone(),
            token_file: String::new(),
            tls_fingerprint: Some(member.certificate.clone()),
            gateway_token_file: None,
            artifact_urls: Value::Null,
            escape_transport: None,
            zellij_binary: None,
        })?;
        let response = tokio::time::timeout(Duration::from_secs(15), host.raw_request(Method::POST, path, serde_json::to_vec(body)?.into(), "application/json", None)).await
            .map_err(|_| anyhow::anyhow!("Inviter unavailable; check the network and retry"))?
            .map_err(|_| anyhow::anyhow!("Cannot reach the intended computer; check its address, TLS identity and private network"))?;
        if response.status == StatusCode::GONE {
            anyhow::bail!("Invitation expired, cancelled or consumed");
        }
        anyhow::ensure!(
            response.status == StatusCode::OK,
            "Inviter rejected pairing; check expiry or request a new invitation"
        );
        Ok(serde_json::from_slice(&response.body)?)
    }
    async fn authorized(&self, authorization: &str) -> Option<(String, Arc<Host>)> {
        let bearer = authorization.strip_prefix("Bearer ")?;
        let db = self.database.lock().await;
        let membership = &db.membership.as_ref()?.value;
        for (peer, credential) in &db.outgoing {
            if !membership.members.contains_key(peer) {
                continue;
            }
            if crypto::same(bearer, &credential.gateway) {
                return self
                    .issued
                    .read()
                    .unwrap()
                    .get(peer)
                    .cloned()
                    .map(|host| (peer.clone(), host));
            }
        }
        None
    }
}

pub(super) fn gateway_router(mesh: Arc<Mesh>) -> Router {
    Router::new()
        .route("/mesh/request", post(peer_request))
        .route("/mesh/complete", post(peer_complete))
        .fallback(peer_terminal)
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn_with_state(mesh.clone(), gateway_guard))
        .with_state(mesh)
}
async fn gateway_guard(State(mesh): State<Arc<Mesh>>, request: Request, next: Next) -> Response {
    let db = mesh.database.lock().await;
    let authority = db
        .local
        .as_ref()
        .and_then(|m| endpoint(&m.endpoint).ok())
        .map(|url| url[url::Position::BeforeHost..url::Position::AfterPort].to_string());
    drop(db);
    // Machine gateway has no browser control path and no public invitation landing page.
    if request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        != authority.as_deref()
        || request.headers().contains_key(header::ORIGIN)
    {
        return (StatusCode::FORBIDDEN, "Untrusted peer gateway request").into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
async fn peer_request(
    State(mesh): State<Arc<Mesh>>,
    Json(attempt): Json<JoinAttempt>,
) -> Result<Json<Decision>, Error> {
    Ok(Json(mesh.request(attempt, now()).await.map_err(rejected)?))
}
async fn peer_complete(
    State(mesh): State<Arc<Mesh>>,
    Json(envelope): Json<Envelope>,
) -> MeshResult {
    mesh.complete(envelope).await.map_err(rejected)?;
    Ok(Json(json!({"installed":true})))
}
async fn peer_terminal(
    State(mesh): State<Arc<Mesh>>,
    websocket: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request,
) -> Result<Response, Error> {
    let authorization = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let (_peer, host) = mesh
        .authorized(&authorization)
        .await
        .ok_or((StatusCode::UNAUTHORIZED, "Peer authorization required"))?;
    let response = terminal_response(
        mesh.clone(),
        host,
        authorization.clone(),
        websocket,
        request,
    );
    tokio::pin!(response);
    loop {
        tokio::select! {
            result = &mut response => {
                if mesh.authorized(&authorization).await.is_none() { return Err((StatusCode::UNAUTHORIZED,"Peer authorization revoked")); }
                return result;
            },
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if mesh.authorized(&authorization).await.is_none() { return Err((StatusCode::UNAUTHORIZED,"Peer authorization revoked")); }
            }
        }
    }
}
async fn terminal_response(
    mesh: Arc<Mesh>,
    host: Arc<Host>,
    authorization: String,
    websocket: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request,
) -> Result<Response, Error> {
    let path = request
        .uri()
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or("/")
        .to_string();
    if path.starts_with("/api/") || path.starts_with("/mesh/") {
        return Err((
            StatusCode::FORBIDDEN,
            "Gateway exposes terminal access only",
        ));
    }
    if let Ok(websocket) = websocket {
        let upstream = tokio::time::timeout(Duration::from_secs(15), host.websocket(&path))
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Terminal connection timed out"))?
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Terminal unavailable"))?;
        return Ok(websocket.max_frame_size(LIMIT).max_message_size(LIMIT).on_upgrade(move |downstream| async move {
            let connection = pump(downstream, upstream);
            tokio::pin!(connection);
            // Every active socket remains derived from a currently authorized peer credential.
            loop {
                tokio::select! { _ = &mut connection => break, _ = tokio::time::sleep(Duration::from_secs(1)) => { if mesh.authorized(&authorization).await.is_none() { break; } } }
            }
        }));
    }
    if path.split('?').next() == Some("/switchboard/attention") && request.method() == Method::GET {
        let offset = request
            .uri()
            .query()
            .and_then(|q| {
                url::form_urlencoded::parse(q.as_bytes())
                    .find(|(k, _)| k == "offset")
                    .and_then(|(_, v)| v.parse::<usize>().ok())
            })
            .unwrap_or(0);
        let snapshot = attention::scan(&host, offset)
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Peer snapshots unavailable"))?;
        return Ok(Json(snapshot).into_response());
    }
    if path == "/switchboard/control" && request.method() == Method::POST {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Control {
            session: String,
            target: u32,
            close: bool,
        }
        let bytes = to_bytes(request.into_body(), 2048)
            .await
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid peer control request"))?;
        let target: Control = serde_json::from_slice(&bytes)
            .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid peer control request"))?;
        control::execute_host(&host, &target.session, target.target, target.close).await?;
        return Ok(Json(json!({"ok":true})).into_response());
    }
    // Login replies contain only native session cookies. Native peer tokens never leave storage.
    if path == "/command/login" {
        let cookie = host.login(None).await.map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Terminal authentication unavailable",
            )
        })?;
        return Ok((
            [(
                header::SET_COOKIE,
                format!("{cookie}; HttpOnly; Secure; SameSite=Strict"),
            )],
            Json(json!({"success":true})),
        )
            .into_response());
    }
    let method = request.method().clone();
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let body = to_bytes(request.into_body(), LIMIT)
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "Terminal request too large"))?;
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        host.request(method, &path, body, &content_type),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Terminal connection timed out"))?
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Terminal unavailable"))?;
    let mime = response
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    Ok((
        response.status,
        [(header::CONTENT_TYPE, mime)],
        response.body,
    )
        .into_response())
}
