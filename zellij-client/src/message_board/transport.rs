use super::store::Store;
use super::*;
use axum::{
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    middleware::{self, Next},
    routing::{get, post},
    Extension, Router,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    net::SocketAddr,
    path::{Path as FilePath, PathBuf},
    sync::Arc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HostConfig {
    pub listen: SocketAddr,
    pub database: Option<PathBuf>,
    pub machines: Vec<MachineCredential>,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MachineCredential {
    pub id: String,
    pub name: String,
    pub token_file: PathBuf,
}
#[derive(Clone)]
struct BoardState {
    store: Store,
    credentials: Arc<Vec<([u8; 32], Machine)>>,
}

pub(super) fn token_file(path: &FilePath) -> anyhow::Result<String> {
    let token = std::fs::read_to_string(path)
        .map_err(|_| anyhow::anyhow!("Cannot read board token file"))?;
    let token = token.trim();
    anyhow::ensure!(
        (32..=512).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_graphic()),
        "Board tokens must contain 32–512 printable bytes without spaces"
    );
    Ok(token.to_owned())
}
fn default_database() -> anyhow::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| anyhow::anyhow!("Configure an explicit board database path"))?;
    Ok(PathBuf::from(home).join(".switchboard/message-board.sqlite3"))
}
pub(super) fn resolve_path(parent: &FilePath, path: &mut PathBuf) {
    if path.is_relative() {
        *path = parent.join(&*path);
    }
}
pub(super) fn load_host(path: &FilePath) -> anyhow::Result<HostConfig> {
    let mut config: HostConfig = serde_json::from_slice(&std::fs::read(path)?)?;
    let parent = path.parent().unwrap_or_else(|| FilePath::new("."));
    for machine in &mut config.machines {
        resolve_path(parent, &mut machine.token_file);
    }
    for path in [
        &mut config.database,
        &mut config.tls_cert,
        &mut config.tls_key,
    ]
    .into_iter()
    .flatten()
    {
        resolve_path(parent, path);
    }
    Ok(config)
}
pub(super) fn router(config: &HostConfig) -> anyhow::Result<Router> {
    anyhow::ensure!(
        config.listen.ip().is_loopback() || (config.tls_cert.is_some() && config.tls_key.is_some()),
        "A LAN board listener requires a TLS certificate and key"
    );
    anyhow::ensure!(
        config.tls_cert.is_some() == config.tls_key.is_some(),
        "Configure both TLS certificate and key"
    );
    anyhow::ensure!(
        !config.machines.is_empty(),
        "Configure at least one authenticated board computer"
    );
    let mut ids = HashSet::new();
    let mut digests = HashSet::new();
    let mut credentials = vec![];
    for machine in &config.machines {
        label(&machine.id, "Computer ID").map_err(|e| anyhow::anyhow!(e.1))?;
        label(&machine.name, "Computer name").map_err(|e| anyhow::anyhow!(e.1))?;
        anyhow::ensure!(
            ids.insert(machine.id.clone()),
            "Duplicate board computer ID"
        );
        let digest: [u8; 32] = Sha256::digest(token_file(&machine.token_file)?.as_bytes()).into();
        anyhow::ensure!(
            digests.insert(digest),
            "Board computer tokens must be distinct"
        );
        credentials.push((
            digest,
            Machine {
                id: machine.id.clone(),
                name: machine.name.clone(),
            },
        ));
    }
    let state = BoardState {
        store: Store::open(
            &config
                .database
                .clone()
                .map(Ok)
                .unwrap_or_else(default_database)?,
        )?,
        credentials: Arc::new(credentials),
    };
    state
        .store
        .configure_machines(
            &state
                .credentials
                .iter()
                .map(|(_, m)| m.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(|e| anyhow::anyhow!(e.1))?;
    Ok(routes(state.clone()).layer(middleware::from_fn_with_state(state, authenticate)))
}
fn routes(state: BoardState) -> Router {
    Router::new()
        .route("/api/message-board/inboxes", get(inboxes))
        .route("/api/message-board/machines/{id}/inbox", get(machine_inbox))
        .route(
            "/api/message-board/participants/{id}/inbox",
            get(agent_inbox),
        )
        .route(
            "/api/message-board/machines/{id}/unread",
            get(machine_unread),
        )
        .route(
            "/api/message-board/machines/{id}/ack/{message}",
            post(machine_ack),
        )
        .route(
            "/api/message-board/health",
            get(|| async { Json(json!({"status":"ok","protocol":1})) }),
        )
        .route(
            "/api/message-board/participants",
            get(participants).post(register),
        )
        .route("/api/message-board/participants/{id}/retire", post(retire))
        .route("/api/message-board/messages", post(send))
        .route("/api/message-board/participants/{id}/unread", get(unread))
        .route("/api/message-board/threads/{id}", get(thread))
        .route(
            "/api/message-board/participants/{id}/ack/{message}",
            post(ack),
        )
        .layer(DefaultBodyLimit::max(MAX_BODY * 6 + 16 * 1024))
        .with_state(state)
}
async fn authenticate(
    State(state): State<BoardState>,
    mut request: Request,
    next: Next,
) -> Response {
    // No cookie authentication or CORS. Browser artifact viewers cannot mutate a board.
    if request.headers().contains_key("origin")
        || request.headers().get_all("authorization").iter().count() != 1
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Board authentication required"})),
        )
            .into_response();
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "));
    let machine = token.and_then(|token| {
        if token.len() > 512 {
            return None;
        }
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        state
            .credentials
            .iter()
            .find(|(expected, _)| *expected == digest)
            .map(|(_, machine)| machine.clone())
    });
    let Some(machine) = machine else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Board authentication required"})),
        )
            .into_response();
    };
    request.extensions_mut().insert(machine);
    next.run(request).await
}
async fn operation<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<Json<T>> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| {
            BoardError(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Board operation failed".into(),
            )
        })?
        .map(Json)
}
async fn register(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Json(request): Json<Register>,
) -> Result<Json<Participant>> {
    operation(move || state.store.register(&machine, request)).await
}
async fn participants(
    State(state): State<BoardState>,
    Query(page): Query<ReadPage>,
) -> Result<Json<Page<Participant>>> {
    operation(move || state.store.participants(page)).await
}
async fn retire(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Path(id): Path<String>,
) -> Result<Json<Participant>> {
    operation(move || state.store.retire(&machine, &id)).await
}
async fn send(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Json(request): Json<SendMessage>,
) -> Result<Json<Message>> {
    operation(move || state.store.send(&machine, request)).await
}
async fn unread(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Path(id): Path<String>,
    Query(page): Query<ReadPage>,
) -> Result<Json<Page<Message>>> {
    operation(move || state.store.unread(&machine, &id, page)).await
}
async fn thread(
    State(state): State<BoardState>,
    Path(id): Path<String>,
    Query(page): Query<ReadPage>,
) -> Result<Json<Page<Message>>> {
    operation(move || state.store.thread(&id, page)).await
}
async fn ack(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Path((id, message)): Path<(String, String)>,
) -> Result<Json<Delivery>> {
    operation(move || state.store.ack(&machine, &id, &message)).await
}
pub(super) async fn serve(config: HostConfig) -> anyhow::Result<()> {
    let app = router(&config)?;
    if let (Some(cert), Some(key)) = (config.tls_cert, config.tls_key) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
        axum_server::bind_rustls(config.listen, tls)
            .serve(app.into_make_service())
            .await?;
    } else {
        let listener = tokio::net::TcpListener::bind(config.listen).await?;
        axum::serve(listener, app).await?;
    }
    Ok(())
}

async fn inboxes(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Query(page): Query<ReadPage>,
) -> Result<Json<serde_json::Value>> {
    operation(move || state.store.inboxes(&machine, page)).await
}
async fn machine_inbox(
    State(state): State<BoardState>,
    Path(id): Path<String>,
    Query(page): Query<ReadPage>,
) -> Result<Json<Page<Message>>> {
    operation(move || state.store.inbox(&id, true, false, page)).await
}
async fn agent_inbox(
    State(state): State<BoardState>,
    Path(id): Path<String>,
    Query(page): Query<ReadPage>,
) -> Result<Json<Page<Message>>> {
    operation(move || state.store.inbox(&id, false, false, page)).await
}
async fn machine_unread(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Path(id): Path<String>,
    Query(page): Query<ReadPage>,
) -> Result<Json<Page<Message>>> {
    if machine.id != id {
        return Err(BoardError::forbidden());
    }
    operation(move || state.store.inbox(&id, true, true, page)).await
}
async fn machine_ack(
    State(state): State<BoardState>,
    Extension(machine): Extension<Machine>,
    Path((id, message)): Path<(String, String)>,
) -> Result<Json<Delivery>> {
    operation(move || state.store.machine_ack(&machine, &id, &message)).await
}

/// Dispatch a request whose computer identity has already been authenticated by the relay mesh.
pub(crate) async fn dispatch(
    database: PathBuf,
    machine: (String, String),
    machines: Vec<(String, String)>,
    mut request: Request,
) -> Response {
    use tower::ServiceExt;
    let store = match tokio::task::spawn_blocking(move || {
        let store = Store::open(&database)?;
        let machines = machines
            .into_iter()
            .map(|(id, name)| Machine { id, name })
            .collect::<Vec<_>>();
        store
            .configure_machines(&machines)
            .map_err(|e| anyhow::anyhow!(e.1))?;
        Ok::<_, anyhow::Error>(store)
    })
    .await
    {
        Ok(Ok(store)) => store,
        _ => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"Board storage is unavailable"})),
            )
                .into_response()
        },
    };
    request.extensions_mut().insert(Machine {
        id: machine.0,
        name: machine.1,
    });
    routes(BoardState {
        store,
        credentials: Arc::new(vec![]),
    })
    .oneshot(request)
    .await
    .unwrap()
}
