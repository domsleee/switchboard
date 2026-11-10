use super::*;
use anyhow::{bail, Context};
use axum::{extract::Request, middleware::Next};
use isahc::{config::Configurable, prelude::*};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WireMessage};
use zellij_utils::input::{config::Config, options::Options};

const WORKER_ENV: &str = "SWITCHBOARD_ATTACHMENT_WORKER";
#[derive(Clone, Deserialize, Serialize)]
struct Endpoint {
    port: u16,
    secret: String,
    protocol: u8,
    pid: u32,
    build: String,
}
fn directory() -> Result<PathBuf> {
    Ok(std::env::var_os("SWITCHBOARD_ATTACHMENT_DIRECTORY")
        .map(PathBuf::from)
        .unwrap_or(
            std::env::home_dir()
                .context("No home directory")?
                .join(".local/share/switchboard/attachments"),
        ))
}
fn recovery_identity(
    recovery: Option<&super::super::sharing_recovery::SharingRecovery>,
    session: &str,
) -> String {
    recovery
        .filter(|r| r.is_target(session))
        .map(|r| r.socket_identity())
        .unwrap_or_default()
}
fn endpoint_path(config: &Path, session: &str, recovery: &str) -> Result<PathBuf> {
    let key = format!("{}\0{session}\0{recovery}", config.display());
    Ok(directory()?.join(format!(
        "{}.json",
        Sha256::digest(key.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )))
}
fn open_private(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn call(endpoint: &Endpoint, path: &str, body: Option<Vec<u8>>) -> Result<serde_json::Value> {
    let url = format!("http://127.0.0.1:{}{path}", endpoint.port);
    let request = if body.is_some() {
        isahc::Request::post(url)
    } else {
        isahc::Request::get(url)
    }
    .header("x-switchboard-worker", &endpoint.secret)
    .header("content-type", "application/json")
    .proxy(None::<isahc::http::Uri>)
    .timeout(Duration::from_secs(5))
    .body(body.unwrap_or_default())?;
    let mut response = isahc::send(request)?;
    ensure!(
        response.status().is_success(),
        "Attachment worker rejected request ({})",
        response.status()
    );
    Ok(serde_json::from_slice(&response.bytes()?)?)
}
fn find(config: &Path, session: &str, recovery: &str) -> Result<Endpoint> {
    let endpoint: Endpoint =
        serde_json::from_slice(&fs::read(endpoint_path(config, session, recovery)?)?)?;
    ensure!(endpoint.protocol == 1, "Unsupported attachment protocol");
    Ok(endpoint)
}
fn launch(config: &Path, session: &str, recovery: &str) -> Result<Endpoint> {
    let path = endpoint_path(config, session, recovery)?;
    fs::create_dir_all(path.parent().unwrap())?;
    let lock = open_private(&path.with_extension("launch-lock"))?;
    lock.lock()?;
    if let Ok(endpoint) = find(config, session, recovery) {
        if call(&endpoint, "/health", None).is_ok() {
            return Ok(endpoint);
        }
    }
    let mut command = Command::new(std::env::current_exe()?);
    command
        .args(["--config"])
        .arg(config)
        .args(["attachment-worker", "--session", session])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                nix::unistd::setsid().map_err(std::io::Error::from)?;
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    let mut child = command.spawn()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(status) = child.try_wait()? {
            bail!("Attachment worker exited: {status}");
        }
        if let Ok(endpoint) = find(config, session, recovery) {
            if call(&endpoint, "/health", None).is_ok() {
                // Reap a later Unix exit without tying the worker to the service's lifetime.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(endpoint);
            }
        }
        ensure!(Instant::now() < deadline, "Attachment worker did not start");
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub(in crate::web_client) async fn bootstrap(
    app: AppState,
    token: String,
    read_only: bool,
    session: String,
    may_create_session: bool,
) -> Result<CreateClientIdResponse> {
    // Block new retained viewers during activation, including first-upgrade rollback.
    let _admission = crate::switchboard_viewers::bootstrap()?;
    let welcome =
        super::super::types::take_pending_welcome_session(&app.pending_welcome_sessions, &session);
    let recovery = recovery_identity(app.sharing_recovery.as_ref(), &session);
    let config = app.config_file_path.clone();
    let worker_session = session.clone();
    let reply = tokio::task::spawn_blocking(move || {
        let endpoint = launch(&config, &worker_session, &recovery)?;
        call(
            &endpoint,
            "/attach",
            Some(serde_json::to_vec(&Attach {
                token,
                welcome,
                may_create_session,
            })?),
        )
    })
    .await??;
    Ok(CreateClientIdResponse {
        web_client_id: reply["web_client_id"]
            .as_str()
            .context("Invalid worker response")?
            .into(),
        is_read_only: read_only,
        config: super::super::control_message::SetConfigPayload::from(&*app.config.lock().unwrap()),
        session_name: session.clone(),
        resumable: Some(ResumeInfo {
            protocol: 1,
            session,
        }),
    })
}

pub(in crate::web_client) async fn proxy(
    State(app): State<AppState>,
    Query(query): Query<ResumeQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    // This route is protected by the ordinary web authentication middleware.
    // Never create a new worker on resume. The browser alone knows whether it
    // has unacknowledged input, and must explicitly bootstrap a clean viewer.
    let endpoint = match find(
        &app.config_file_path,
        &query.session,
        &recovery_identity(app.sharing_recovery.as_ref(), &query.session),
    ) {
        Ok(e) => e,
        Err(_) => return expired(ws),
    };
    let encoded = match serde_json::to_value(&query) {
        Ok(v) => v,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    let pairs = encoded
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| {
            let value = v
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string());
            format!("{}={}", urlencoding::encode(k), urlencoding::encode(&value))
        })
        .collect::<Vec<_>>()
        .join("&");
    let mut request =
        match format!("ws://127.0.0.1:{}/resume?{pairs}", endpoint.port).into_client_request() {
            Ok(r) => r,
            Err(_) => return StatusCode::BAD_REQUEST.into_response(),
        };
    request
        .headers_mut()
        .insert("x-switchboard-worker", endpoint.secret.parse().unwrap());
    if let Some(cookie) = headers.get("cookie") {
        request.headers_mut().insert("cookie", cookie.clone());
    }
    let upstream = match tokio::time::timeout(
        Duration::from_secs(5),
        tokio_tungstenite::connect_async(request),
    )
    .await
    {
        Ok(Ok((socket, _))) => socket,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
            if response.status() == StatusCode::GONE {
                return expired(ws);
            }
            return (response.status(), "Attachment cannot resume").into_response();
        },
        Ok(Err(tokio_tungstenite::tungstenite::Error::Io(error)))
            if error.kind() == std::io::ErrorKind::ConnectionRefused =>
        {
            return expired(ws);
        },
        _ => return StatusCode::BAD_GATEWAY.into_response(),
    };
    ws.max_message_size(8 * 1024 * 1024)
        .on_upgrade(move |downstream| async move {
            let (mut browser_tx, mut browser_rx) = downstream.split();
            let (mut worker_tx, mut worker_rx) = upstream.split();
            let outbound = async {
                while let Some(Ok(message)) = browser_rx.next().await {
                    let message = match message {
                        Message::Text(t) => WireMessage::Text(t.to_string().into()),
                        Message::Binary(b) => WireMessage::Binary(b),
                        Message::Ping(b) => WireMessage::Ping(b),
                        Message::Pong(b) => WireMessage::Pong(b),
                        Message::Close(_) => break,
                    };
                    if worker_tx.send(message).await.is_err() {
                        break;
                    }
                }
            };
            let inbound = async {
                while let Some(Ok(message)) = worker_rx.next().await {
                    let message = match message {
                        WireMessage::Text(t) => Message::Text(t.to_string().into()),
                        WireMessage::Binary(b) => Message::Binary(b),
                        WireMessage::Ping(b) => Message::Ping(b),
                        WireMessage::Pong(b) => Message::Pong(b),
                        WireMessage::Close(_) => break,
                        _ => continue,
                    };
                    if browser_tx.send(message).await.is_err() {
                        break;
                    }
                }
            };
            tokio::select! {_=outbound=>{},_=inbound=>{}}
        })
}

fn expired(ws: WebSocketUpgrade) -> Response {
    // HTTP upgrade errors are opaque to browser WebSockets. Send the loss of
    // the retained owner explicitly, so it is distinct from a network outage.
    ws.on_upgrade(|mut socket| async move {
        let _ = socket
            .send(Message::Text(json!({"type":"expired"}).to_string().into()))
            .await;
    })
}

pub(in crate::web_client) fn run_worker(
    config: Config,
    options: Options,
    config_path: Option<PathBuf>,
) -> bool {
    let Some(session) = std::env::var_os(WORKER_ENV) else {
        return false;
    };
    // Prevent session engines or their children accidentally inheriting worker mode.
    std::env::remove_var(WORKER_ENV);
    let result = (|| -> Result<()> {
        let config_path = config_path
            .or_else(Config::default_config_file_path)
            .context("No configuration")?;
        let session = session.to_string_lossy().into_owned();
        let sharing_recovery = super::super::sharing_recovery::SharingRecovery::from_environment(
            Ipv4Addr::LOCALHOST.into(),
            &config,
            &options,
        )
        .map_err(anyhow::Error::msg)?;
        let path = endpoint_path(
            &config_path,
            &session,
            &recovery_identity(sharing_recovery.as_ref(), &session),
        )?;
        fs::create_dir_all(path.parent().unwrap())?;
        let lifetime = open_private(&path.with_extension("worker-lock"))?;
        lifetime.try_lock()?;
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = Endpoint {
            port: listener.local_addr()?.port(),
            secret: Uuid::new_v4().to_string(),
            protocol: 1,
            pid: std::process::id(),
            build: env!("SWITCHBOARD_COMMIT").into(),
        };
        let app = AppState {
            connection_table: Arc::new(Mutex::new(super::super::types::ConnectionTable::default())),
            config: Arc::new(Mutex::new(config)),
            config_options: options,
            config_file_path: config_path,
            session_manager: Arc::new(super::super::types::RealSessionManager),
            client_os_api_factory: Arc::new(super::super::types::RealClientOsApiFactory),
            is_https: false,
            pending_welcome_sessions: Default::default(),
            sharing_recovery,
        };
        let worker = Worker {
            app,
            session,
            views: Default::default(),
        };
        let runtime = tokio::runtime::Runtime::new()?;
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::from_std(listener)?;
            let secret = endpoint.secret.clone();
            let router = Router::new()
                .route("/health", get(|| async { Json(json!({"protocol":1})) }))
                .route("/attach", post(create))
                .route("/resume", get(resume))
                .with_state(worker.clone())
                .layer(axum::middleware::from_fn(
                    move |request: Request, next: Next| {
                        let secret = secret.clone();
                        async move {
                            if request
                                .headers()
                                .get("x-switchboard-worker")
                                .and_then(|h| h.to_str().ok())
                                != Some(secret.as_str())
                            {
                                return StatusCode::FORBIDDEN.into_response();
                            }
                            next.run(request).await
                        }
                    },
                ));
            let staging = path.with_extension("tmp");
            let mut file = open_private(&staging)?;
            file.set_len(0)?;
            file.write_all(&serde_json::to_vec(&endpoint)?)?;
            drop(file);
            fs::rename(&staging, &path)?;
            let shutdown = async move {
                let mut empty_since = Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    worker.views.lock().unwrap().retain(|_, view| {
                        view.incoming.lock().unwrap().is_none()
                            || view.touched.lock().unwrap().elapsed() <= DETACHED_TTL
                    });
                    if !worker.views.lock().unwrap().is_empty() {
                        empty_since = Instant::now();
                    }
                    if empty_since.elapsed() > DETACHED_TTL {
                        break;
                    }
                }
            };
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(shutdown)
                .await;
            let _ = fs::remove_file(&path);
            result?;
            Ok::<(), anyhow::Error>(())
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("Attachment worker: {error:#}");
        std::process::exit(1);
    }
    true
}

/// Diagnostics exclude private worker capabilities. A descriptor alone does not
/// establish liveness: its lifetime lock must still be held by the worker.
pub(crate) fn worker_status() -> Vec<serde_json::Value> {
    let Ok(directory) = directory() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                return None;
            }
            let endpoint: Endpoint = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
            let lock = open_private(&path.with_extension("worker-lock")).ok()?;
            match lock.try_lock() {
                Err(std::fs::TryLockError::WouldBlock) => Some(
                    json!({"pid":endpoint.pid,"build":endpoint.build,"protocol":endpoint.protocol}),
                ),
                _ => None,
            }
        })
        .collect()
}
