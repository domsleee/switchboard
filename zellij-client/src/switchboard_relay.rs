//! Loopback Switchboard relay. Terminal engines remain independent processes.
mod artifacts;
mod attention;
mod control;
mod mesh;
pub(crate) mod peer_bridge;
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{ws::WebSocketUpgrade, Path as RoutePath, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper_util::rt::TokioIo;
use include_dir::{include_dir, Dir};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    sync::Mutex,
};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message},
    WebSocketStream,
};

static ASSETS: Dir = include_dir!("$CARGO_MANIFEST_DIR/../tools/switchboard/static");
const LIMIT: usize = 16 * 1024 * 1024;
const HELPER_PREFIX: &str = "__switchboard_control_";
const BRIDGE: &str = "<head><script src=\"/link-config.js\"></script><script src=\"/links.js\"></script><script src=\"/clipboard.js\"></script><script src=\"/chrome.js\"></script><script src=\"/bridge.js\"></script>";

#[derive(Clone, Deserialize)]
pub struct RelayConfig {
    pub hosts: Vec<HostConfig>,
    #[serde(default)]
    pub artifact_proxy: Option<artifacts::ArtifactConfig>,
}

#[derive(Clone, Deserialize)]
pub struct HostConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    pub token_file: String,
    #[serde(default)]
    pub gateway_token_file: Option<String>,
    pub tls_fingerprint: Option<String>,
    #[serde(default)]
    pub artifact_urls: Value,
    #[serde(default)]
    pub escape_transport: Option<String>,
    #[serde(default)]
    pub zellij_binary: Option<String>,
}

trait RelayIo: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> RelayIo for T {}
type Stream = Box<dyn RelayIo>;
type Error = (StatusCode, &'static str);

#[derive(Clone)]
struct RelayState {
    hosts: Arc<HashMap<String, Arc<Host>>>,
    order: Arc<Vec<String>>,
    port: u16,
    attention: Arc<Mutex<Value>>,
    mesh: Option<Arc<mesh::Mesh>>,
}

impl RelayState {
    fn host(&self, id: &str) -> Option<Arc<Host>> {
        self.hosts
            .get(id)
            .cloned()
            .or_else(|| self.mesh.as_ref().and_then(|m| m.host(id)))
    }
    fn all_hosts(&self) -> Vec<Arc<Host>> {
        let mut hosts: Vec<_> = self.order.iter().map(|id| self.hosts[id].clone()).collect();
        if let Some(mesh) = &self.mesh {
            hosts.extend(
                mesh.hosts()
                    .into_iter()
                    .filter(|h| !self.hosts.contains_key(&h.config.id)),
            );
        }
        hosts
    }
}

struct Host {
    config: HostConfig,
    origin: url::Url,
    tls: Option<Arc<rustls::ClientConfig>>,
    cookie: Mutex<Option<String>>,
    control: Mutex<control::Control>,
    idle_http: Mutex<Vec<hyper::client::conn::http1::SendRequest<Full<Bytes>>>>,
}

struct UpstreamResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: Bytes,
}

#[derive(Debug)]
struct PinnedCertificate {
    fingerprint: [u8; 32],
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl rustls::client::danger::ServerCertVerifier for PinnedCertificate {
    fn verify_server_cert(
        &self,
        certificate: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if Sha256::digest(certificate.as_ref()).as_slice() != self.fingerprint {
            return Err(rustls::Error::General(
                "Host certificate fingerprint mismatch".into(),
            ));
        }
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, certificate, signature, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, certificate, signature, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

fn fingerprint(value: &str) -> anyhow::Result<[u8; 32]> {
    anyhow::ensure!(
        value.len() == 64 && value.is_ascii(),
        "Invalid TLS fingerprint"
    );
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)?;
    }
    Ok(bytes)
}

impl Host {
    fn new(config: HostConfig) -> anyhow::Result<Self> {
        let origin = url::Url::parse(&config.url)?;
        anyhow::ensure!(
            config.gateway_token_file.is_none()
                || (origin.scheme() == "https" && config.tls_fingerprint.is_some()),
            "Peer gateway credentials require a pinned HTTPS origin"
        );
        anyhow::ensure!(
            matches!(origin.scheme(), "http" | "https")
                && origin.host_str().is_some()
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.path() == "/"
                && origin.query().is_none()
                && origin.fragment().is_none(),
            "Host URL must be an HTTP(S) origin without credentials or a path"
        );
        let tls = if origin.scheme() == "https" {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()?;
            let config = if let Some(pin) = config.tls_fingerprint.as_ref() {
                builder
                    .dangerous()
                    .with_custom_certificate_verifier(Arc::new(PinnedCertificate {
                        fingerprint: fingerprint(pin)?,
                        algorithms: provider.signature_verification_algorithms,
                    }))
                    .with_no_client_auth()
            } else {
                let mut roots = rustls::RootCertStore::empty();
                roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
                builder.with_root_certificates(roots).with_no_client_auth()
            };
            Some(Arc::new(config))
        } else {
            anyhow::ensure!(
                config.tls_fingerprint.is_none(),
                "TLS fingerprint requires HTTPS"
            );
            None
        };
        Ok(Self {
            config,
            origin,
            tls,
            cookie: Mutex::new(None),
            control: Mutex::new(control::Control::default()),
            idle_http: Mutex::new(Vec::new()),
        })
    }

    /// A native engine can listen on a specific local interface instead of loopback.
    /// Ephemeral UDP binding plus route-selected source checks verify local ownership
    /// without sending traffic, even on systems that allow binding nonlocal addresses.
    fn is_local_engine(&self) -> bool {
        let address = match self.origin.host() {
            Some(url::Host::Domain("localhost")) => return true,
            Some(url::Host::Ipv4(address)) => std::net::IpAddr::V4(address),
            Some(url::Host::Ipv6(address)) => std::net::IpAddr::V6(address),
            _ => return false,
        };
        if address.is_loopback() {
            return true;
        }
        if self.origin.scheme() != "https"
            || self.config.tls_fingerprint.is_none()
            || address.is_unspecified()
            || address.is_multicast()
            || matches!(address, std::net::IpAddr::V4(ip) if ip.is_broadcast())
        {
            return false;
        }
        if std::net::UdpSocket::bind((address, 0)).is_err() {
            return false;
        }
        let unspecified = match address {
            std::net::IpAddr::V4(_) => std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
            std::net::IpAddr::V6(_) => std::net::IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED),
        };
        let Ok(route) = std::net::UdpSocket::bind((unspecified, 0)) else {
            return false;
        };
        route.connect((address, 9)).is_ok()
            && route
                .local_addr()
                .is_ok_and(|source| source.ip() == address)
    }

    async fn stream(&self) -> anyhow::Result<Stream> {
        let host = match self.origin.host().unwrap() {
            url::Host::Ipv6(address) => address.to_string(),
            other => other.to_string(),
        };
        let tcp = TcpStream::connect((host.as_str(), self.origin.port_or_known_default().unwrap()))
            .await?;
        if let Some(tls) = self.tls.as_ref() {
            let name = rustls::pki_types::ServerName::try_from(host.to_owned())?;
            Ok(Box::new(
                tokio_rustls::TlsConnector::from(tls.clone())
                    .connect(name, tcp)
                    .await?,
            ))
        } else {
            Ok(Box::new(tcp))
        }
    }

    fn authority(&self) -> String {
        self.origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned()
    }

    async fn raw_request(
        &self,
        method: Method,
        path: &str,
        body: Bytes,
        content_type: &str,
        cookie: Option<&str>,
    ) -> anyhow::Result<UpstreamResponse> {
        let mut sender = self.connection(true).await?;
        let response = self
            .send_request(&mut sender, method, path, body, content_type, cookie)
            .await?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = to_bytes(Body::new(response.into_body()), LIMIT).await?;
        // Reuse completed HTTP connections without serializing unrelated asset/control requests.
        if sender.ready().await.is_ok() {
            let mut idle = self.idle_http.lock().await;
            if idle.len() < 8 {
                idle.push(sender);
            }
        }
        Ok(UpstreamResponse {
            status,
            headers,
            body,
        })
    }

    async fn stream_request(
        &self,
        method: Method,
        path: &str,
        body: Bytes,
        content_type: &str,
        cookie: Option<&str>,
    ) -> anyhow::Result<hyper::Response<hyper::body::Incoming>> {
        let mut sender = self.connection(false).await?;
        self.send_request(&mut sender, method, path, body, content_type, cookie)
            .await
    }

    async fn connection(
        &self,
        pooled: bool,
    ) -> anyhow::Result<hyper::client::conn::http1::SendRequest<Full<Bytes>>> {
        if pooled {
            loop {
                let sender = self.idle_http.lock().await.pop();
                match sender {
                    Some(mut sender) if !sender.is_closed() => {
                        if sender.ready().await.is_ok() {
                            return Ok(sender);
                        }
                    },
                    Some(_) => {},
                    None => break,
                }
            }
        }
        let (sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(self.stream().await?)).await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(sender)
    }

    async fn send_request(
        &self,
        sender: &mut hyper::client::conn::http1::SendRequest<Full<Bytes>>,
        method: Method,
        path: &str,
        body: Bytes,
        content_type: &str,
        cookie: Option<&str>,
    ) -> anyhow::Result<hyper::Response<hyper::body::Incoming>> {
        anyhow::ensure!(
            path.starts_with('/') && !path.starts_with("//"),
            "Invalid upstream path"
        );
        let mut request = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, self.authority())
            .header(header::CONTENT_TYPE, content_type);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        if let Some(path) = &self.config.gateway_token_file {
            let token = tokio::fs::read_to_string(control::expand_path(path)?).await?;
            request = request.header(header::AUTHORIZATION, format!("Bearer {}", token.trim()));
        }
        Ok(sender.send_request(request.body(Full::new(body))?).await?)
    }

    async fn login(&self, stale: Option<&str>) -> anyhow::Result<String> {
        let mut cookie = self.cookie.lock().await;
        if let Some(current) = cookie.as_ref() {
            if Some(current.as_str()) != stale {
                return Ok(current.clone());
            }
        }
        let token_path = control::expand_path(&self.config.token_file)?;
        let token = tokio::fs::read_to_string(token_path).await?;
        let response = self
            .raw_request(
                Method::POST,
                "/command/login",
                json!({"auth_token": token.trim(), "remember_me": false})
                    .to_string()
                    .into(),
                "application/json",
                None,
            )
            .await?;
        anyhow::ensure!(response.status == StatusCode::OK, "Upstream login rejected");
        let session_cookie = response
            .headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .filter_map(|value| value.split(';').next())
            .find(|value| {
                value.starts_with("session_token=") && value.len() > "session_token=".len()
            })
            .ok_or_else(|| anyhow::anyhow!("Upstream login did not set a session cookie"))?
            .to_owned();
        *cookie = Some(session_cookie.clone());
        Ok(session_cookie)
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Bytes,
        content_type: &str,
    ) -> anyhow::Result<UpstreamResponse> {
        let cookie = self.login(None).await?;
        let response = self
            .raw_request(
                method.clone(),
                path,
                body.clone(),
                content_type,
                Some(&cookie),
            )
            .await?;
        if response.status != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        let cookie = self.login(Some(&cookie)).await?;
        self.raw_request(method, path, body, content_type, Some(&cookie))
            .await
    }

    async fn websocket(&self, path: &str) -> anyhow::Result<WebSocketStream<Stream>> {
        let cookie = self.login(None).await?;
        match self.raw_websocket(path, &cookie).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response))
                if response.status() == StatusCode::UNAUTHORIZED =>
            {
                let cookie = self.login(Some(&cookie)).await?;
                Ok(self.raw_websocket(path, &cookie).await?)
            },
            result => Ok(result?),
        }
    }

    async fn raw_websocket(
        &self,
        path: &str,
        cookie: &str,
    ) -> Result<WebSocketStream<Stream>, tokio_tungstenite::tungstenite::Error> {
        let scheme = if self.tls.is_some() { "wss" } else { "ws" };
        let mut request = format!("{scheme}://{}{path}", self.authority()).into_client_request()?;
        request
            .headers_mut()
            .insert(header::COOKIE, cookie.parse()?);
        if let Some(path) = &self.config.gateway_token_file {
            let token_path = control::expand_path(path).map_err(|_| {
                tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other(
                    "Gateway credential unavailable",
                ))
            })?;
            let token = tokio::fs::read_to_string(token_path).await.map_err(|_| {
                tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other(
                    "Gateway credential unavailable",
                ))
            })?;
            request.headers_mut().insert(
                header::AUTHORIZATION,
                format!("Bearer {}", token.trim()).parse()?,
            );
        }
        let stream = self.stream().await.map_err(|_| {
            tokio_tungstenite::tungstenite::Error::Io(std::io::Error::other(
                "Upstream connection failed",
            ))
        })?;
        let mut config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default();
        config.max_message_size = Some(LIMIT);
        config.max_frame_size = Some(LIMIT);
        let (socket, _) =
            tokio_tungstenite::client_async_with_config(request, stream, Some(config)).await?;
        Ok(socket)
    }
}

fn trusted(headers: &HeaderMap, port: u16) -> bool {
    let hosts = [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        "switchboard.localhost".into(),
        "switchboard.localhost:443".into(),
        "switchboard.localhost:80".into(),
    ];
    let origins = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        "https://switchboard.localhost".into(),
        "https://switchboard.localhost:443".into(),
        "http://switchboard.localhost".into(),
        "http://switchboard.localhost:80".into(),
    ];
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|host| {
            hosts.iter().any(|h| h == host)
                || (port == 80 && matches!(host, "127.0.0.1" | "localhost"))
        })
        && headers
            .get(header::ORIGIN)
            .map(|h| {
                h.to_str().ok().is_some_and(|origin| {
                    origins.iter().any(|o| o == origin)
                        || (port == 80 && matches!(origin, "http://127.0.0.1" | "http://localhost"))
                })
            })
            .unwrap_or(true)
        && !headers
            .get("sec-fetch-site")
            .is_some_and(|h| h == "cross-site")
}

async fn guard(State(state): State<RelayState>, request: Request, next: Next) -> Response {
    if !trusted(request.headers(), state.port) {
        return (StatusCode::FORBIDDEN, "Untrusted relay request").into_response();
    }
    let mut response = next.run(request).await;
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        for (name, value) in [
            ("cache-control", "no-store"),
            ("x-frame-options", "SAMEORIGIN"),
            ("x-content-type-options", "nosniff"),
        ] {
            response.headers_mut().insert(name, value.parse().unwrap());
        }
    }
    response
}

fn host_summary(host: &Host, configured: bool) -> Value {
    let local = host.is_local_engine();
    // Terminal configuration predates pairing. Preserve it in the computer
    // inventory without treating possession of a terminal token as mesh trust.
    let mut pairing = host.origin.clone();
    if pairing.scheme() != "https" {
        pairing.set_scheme("https").unwrap();
        pairing.set_port(Some(8082)).unwrap();
    }
    json!({
        "id": host.config.id,
        "name": host.config.name,
        "address": host.origin.as_str().trim_end_matches('/'),
        "pairing_address": pairing.as_str().trim_end_matches('/'),
        "configured": configured,
        "local": local,
    })
}

async fn describe(host: &Host, configured: bool) -> Value {
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let response = host
            .request(
                Method::GET,
                "/session-list",
                Bytes::new(),
                "application/json",
            )
            .await?;
        anyhow::ensure!(response.status == StatusCode::OK, "Cannot query sessions");
        let mut catalog: Value = serde_json::from_slice(&response.body)?;
        let sessions = catalog["sessions"]
            .as_array_mut()
            .ok_or_else(|| anyhow::anyhow!("Invalid session catalog"))?;
        sessions.retain(|session| {
            session["name"]
                .as_str()
                .is_some_and(|name| !name.starts_with(HELPER_PREFIX))
        });
        Ok::<_, anyhow::Error>(sessions.clone())
    })
    .await;
    let mut description = host_summary(host, configured);
    match result {
        Ok(Ok(sessions)) => description["sessions"] = json!(sessions),
        _ => description["error"] = json!("Host unavailable"),
    }
    description
}

async fn hosts(State(state): State<RelayState>, request: Request) -> Json<Value> {
    if request.uri().query().is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes()).any(|(k, v)| k == "summary" && v == "1")
    }) {
        return Json(Value::Array(
            state
                .all_hosts()
                .iter()
                .map(|host| host_summary(host, state.hosts.contains_key(&host.config.id)))
                .collect(),
        ));
    }
    Json(Value::Array(
        futures_util::future::join_all(
            state
                .all_hosts()
                .iter()
                .map(|host| describe(host, state.hosts.contains_key(&host.config.id))),
        )
        .await,
    ))
}

async fn host(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
) -> Result<Json<Value>, Error> {
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown host"))?;
    Ok(Json(describe(&host, state.hosts.contains_key(&id)).await))
}

async fn link_config(State(state): State<RelayState>) -> Response {
    let data: serde_json::Map<String, Value> = state.all_hosts().iter().map(|host| {
        let local = host.is_local_engine();
        (host.config.id.clone(), json!({"origin": host.config.url, "local": local, "artifacts": host.config.artifact_urls}))
    }).collect();
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        format!(
            "window.__switchboardLinkHosts={};",
            Value::Object(data).to_string().replace('<', "\\u003c")
        ),
    )
        .into_response()
}

fn upstream_path(raw: &str) -> Result<&str, Error> {
    let path = raw
        .splitn(4, '/')
        .nth(3)
        .ok_or((StatusCode::BAD_REQUEST, "Missing upstream path"))?;
    let raw_path = path.split('?').next().unwrap_or(path);
    let decoded = urlencoding::decode(raw_path)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid upstream path"))?;
    if decoded.trim_start_matches('/').trim_end_matches('/') == "command/login" {
        return Err((StatusCode::FORBIDDEN, "Use the host token file"));
    }
    if path.starts_with('/') {
        return Err((StatusCode::BAD_REQUEST, "Invalid upstream path"));
    }
    Ok(path)
}

async fn proxy(
    State(state): State<RelayState>,
    RoutePath((id, _)): RoutePath<(String, String)>,
    websocket: Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>,
    request: Request,
) -> Result<Response, Error> {
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown host"))?
        .clone();
    let path = format!(
        "/{}",
        upstream_path(
            request
                .uri()
                .path_and_query()
                .map(|p| p.as_str())
                .unwrap_or("")
        )?
    );
    if let Ok(websocket) = websocket {
        let upstream = tokio::time::timeout(Duration::from_secs(20), host.websocket(&path))
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Host connection timed out"))?
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Host WebSocket unavailable"))?;
        return Ok(websocket
            .max_message_size(LIMIT)
            .max_frame_size(LIMIT)
            .on_upgrade(|downstream| pump(downstream, upstream)));
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
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "Relay body too large"))?;
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        host.request(method, &path, body, &content_type),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Host connection timed out"))?
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Host HTTP unavailable"))?;
    let content_type = response
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let body = if response.status == StatusCode::OK && content_type.contains("text/html") {
        String::from_utf8_lossy(&response.body)
            .replacen("<head>", BRIDGE, 1)
            .into_bytes()
            .into()
    } else {
        response.body
    };
    Ok((
        response.status,
        [(header::CONTENT_TYPE, content_type)],
        body,
    )
        .into_response())
}

async fn pump(downstream: axum::extract::ws::WebSocket, upstream: WebSocketStream<Stream>) {
    let (mut downstream_tx, mut downstream_rx) = downstream.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let from_browser = async {
        while let Some(Ok(message)) = downstream_rx.next().await {
            let message = match message {
                axum::extract::ws::Message::Text(value) => {
                    Message::Text(value.as_str().to_owned().into())
                },
                axum::extract::ws::Message::Binary(value) => Message::Binary(value),
                axum::extract::ws::Message::Close(frame) => {
                    let frame =
                        frame.map(
                            |frame| tokio_tungstenite::tungstenite::protocol::CloseFrame {
                                code: frame.code.into(),
                                reason: frame.reason.as_str().to_owned().into(),
                            },
                        );
                    let _ = upstream_tx.send(Message::Close(frame)).await;
                    break;
                },
                _ => continue,
            };
            if upstream_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = upstream_tx.close().await;
    };
    let from_host = async {
        while let Some(Ok(message)) = upstream_rx.next().await {
            let message = match message {
                Message::Text(value) => {
                    axum::extract::ws::Message::Text(value.as_str().to_owned().into())
                },
                Message::Binary(value) => axum::extract::ws::Message::Binary(value),
                Message::Close(frame) => {
                    let frame = frame.map(|frame| axum::extract::ws::CloseFrame {
                        code: frame.code.into(),
                        reason: frame.reason.as_str().to_owned().into(),
                    });
                    let _ = downstream_tx
                        .send(axum::extract::ws::Message::Close(frame))
                        .await;
                    break;
                },
                _ => continue,
            };
            if downstream_tx.send(message).await.is_err() {
                break;
            }
        }
        let _ = downstream_tx.close().await;
    };
    tokio::select! { _ = from_browser => {}, _ = from_host => {} }
}

async fn asset(request: Request) -> Response {
    let name = request.uri().path().trim_start_matches('/');
    let name = if name.is_empty() { "index.html" } else { name };
    let mime = match name {
        "index.html" | "computers.html" | "messages.html" => "text/html; charset=utf-8",
        "style.css" | "messages.css" => "text/css; charset=utf-8",
        "app.js" | "bridge.js" | "chrome.js" | "clipboard.js" | "close.js" | "links.js"
        | "titles.js" | "computers.js" | "pairing-notice.js" | "messages.js" => {
            "application/javascript"
        },
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    match ASSETS.get_file(name) {
        Some(file) => ([(header::CONTENT_TYPE, mime)], file.contents()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn state(config: &RelayConfig, port: u16) -> anyhow::Result<RelayState> {
    let mut hosts = HashMap::new();
    let mut order = Vec::new();
    for config in config.hosts.clone() {
        anyhow::ensure!(
            !config.id.is_empty() && !hosts.contains_key(&config.id),
            "Duplicate or empty host ID"
        );
        order.push(config.id.clone());
        hosts.insert(config.id.clone(), Arc::new(Host::new(config)?));
    }
    Ok(RelayState {
        hosts: Arc::new(hosts),
        order: Arc::new(order),
        port,
        attention: Arc::new(Mutex::new(json!({"panes": [], "tabs": [], "errors": []}))),
        mesh: None,
    })
}

async fn message_board(State(state): State<RelayState>, request: Request) -> Response {
    // Humans inspect inboxes without acknowledging on an agent's behalf.
    // CLI mutations arrive without browser headers and still pass the loopback guard.
    if request.method() != Method::GET
        && (request.headers().contains_key(header::ORIGIN)
            || request.headers().contains_key("sec-fetch-mode"))
    {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"The Messages view is read-only. Agents send and acknowledge through the CLI."}))).into_response();
    }
    match state.mesh {
        Some(mesh) => mesh.board(request).await,
        None => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"configured":false,"error":"Pair your computers in Manage computers to use a shared message board."}))).into_response(),
    }
}

fn app(state: RelayState) -> Router {
    let peer = state.mesh.as_ref().and_then(|mesh| {
        mesh.bridge
            .read()
            .unwrap()
            .as_ref()
            .map(|(_, _, secret)| peer_bridge::relay_router(mesh.clone(), secret.clone()))
    });
    let app = Router::new()
        .merge(mesh::transport::routes())
        .route(
            "/api/health",
            get(|| async {
                Json(json!({
                    "relay":"rust", "version":zellij_utils::consts::VERSION,
                    "commit":env!("SWITCHBOARD_COMMIT"),
                    "commit_date":env!("SWITCHBOARD_COMMIT_DATE"),
                    "commit_timestamp":env!("SWITCHBOARD_COMMIT_TIMESTAMP")
                }))
            }),
        )
        .route("/api/hosts", get(self::hosts))
        .route("/api/hosts/{host}", get(host))
        .route("/api/attention", get(attention::handler))
        .route("/api/message-board/{*path}", any(message_board))
        .route("/api/hosts/{host}/close-tab", post(control::close_tab))
        .route("/api/hosts/{host}/escape", post(control::escape))
        .route("/link-config.js", get(link_config))
        .route("/hosts/{host}/{*path}", any(proxy))
        .fallback(asset)
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state);
    if let Some(peer) = peer {
        app.merge(peer)
    } else {
        app
    }
}

pub async fn router(config: RelayConfig, port: u16) -> anyhow::Result<Router> {
    Ok(app(state(&config, port).await?))
}

/// Start the relay on loopback. Never restarts user terminal engines.
pub async fn serve(config_path: &Path, port: u16) -> anyhow::Result<()> {
    let config: RelayConfig = serde_json::from_slice(&tokio::fs::read(config_path).await?)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let mut state = state(&config, port).await?;
    if let Some(local) = state
        .all_hosts()
        .into_iter()
        .find(|host| host.is_local_engine())
    {
        match mesh::Mesh::open(config_path.with_file_name("mesh"), local).await {
            Ok(mesh) => {
                mesh.attach_bridge(port)?;
                state.mesh = Some(mesh);
            },
            Err(_) => log::warn!(
                "Switchboard pairing unavailable; local relay continues (details redacted)"
            ),
        }
    }
    let pairing = mesh::discovery::start(state.clone());
    let artifact = artifacts::start(config.artifact_proxy).await?;
    let polling =
        attention::start(state.clone(), config_path.with_extension("attention.json")).await;
    let result = axum::serve(listener, app(state.clone()))
        .with_graceful_shutdown(shutdown())
        .await;
    pairing.abort();
    for task in polling {
        task.abort();
        let _ = task.await;
    }
    if let Some(task) = artifact {
        task.abort();
    }
    if let Some(mesh) = &state.mesh {
        mesh.stop_gateway().await;
    }
    for host in state.all_hosts() {
        control::cleanup(&host).await;
    }
    result?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        if let Ok(mut termination) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            tokio::select! { _ = termination.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn config(url: &str) -> HostConfig {
        HostConfig {
            id: "mac".into(),
            name: "Mac".into(),
            url: url.into(),
            token_file: "/secret/token".into(),
            gateway_token_file: None,
            tls_fingerprint: None,
            artifact_urls: json!({}),
            escape_transport: None,
            zellij_binary: None,
        }
    }

    #[test]
    fn configured_computer_inventory_preserves_safe_pairing_addresses() {
        let mut configured = config("https://172.20.10.69:8082");
        configured.id = "windows".into();
        configured.name = "Windows".into();
        let host = Host::new(configured).unwrap();
        let summary = host_summary(&host, true);
        assert_eq!(summary["address"], "https://172.20.10.69:8082");
        assert_eq!(summary["pairing_address"], summary["address"]);
        assert_eq!(summary["configured"], true);
        assert_eq!(summary["local"], false);
        assert!(!summary.to_string().contains("token"));
        let local = Host::new(config("http://127.0.0.1:8082")).unwrap();
        assert_eq!(host_summary(&local, true)["local"], true);
        let http = Host::new(config("http://172.20.10.69:9000")).unwrap();
        assert_eq!(
            host_summary(&http, true)["pairing_address"],
            "https://172.20.10.69:8082"
        );
        let ipv6 = Host::new(config("https://[fd00::69]:8091")).unwrap();
        assert_eq!(
            host_summary(&ipv6, false)["pairing_address"],
            "https://[fd00::69]:8091"
        );
        assert_eq!(host_summary(&ipv6, false)["configured"], false);
    }

    #[test]
    fn local_engine_accepts_pinned_local_interfaces_without_trusting_remote_or_dns_hosts() {
        let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        route.connect("192.0.2.1:9").unwrap();
        let local_ip = route.local_addr().unwrap().ip();
        assert!(!local_ip.is_unspecified());
        let mut pinned = config(&format!("https://{local_ip}:8082"));
        pinned.tls_fingerprint = Some("ab".repeat(32));
        let local = Host::new(pinned).unwrap();
        assert!(local.is_local_engine());
        assert_eq!(host_summary(&local, true)["local"], true);
        if !local_ip.is_loopback() {
            assert!(!Host::new(config(&format!("https://{local_ip}:8082")))
                .unwrap()
                .is_local_engine());
            assert!(!Host::new(config(&format!("http://{local_ip}:8082")))
                .unwrap()
                .is_local_engine());
        }
        for origin in [
            "https://192.0.2.254:8082",
            "https://example.invalid:8082",
            "https://0.0.0.0:8082",
            "https://224.0.0.1:8082",
            "https://255.255.255.255:8082",
            "https://[::]:8082",
            "https://[ff02::1]:8082",
        ] {
            let mut configured = config(origin);
            configured.tls_fingerprint = Some("ab".repeat(32));
            assert!(
                !Host::new(configured).unwrap().is_local_engine(),
                "{origin}"
            );
        }
        for origin in [
            "http://127.0.0.1:8082",
            "http://localhost:8082",
            "http://[::1]:8082",
        ] {
            assert!(
                Host::new(config(origin)).unwrap().is_local_engine(),
                "{origin}"
            );
        }
    }

    #[test]
    fn default_http_port_accepts_normalized_loopback_authority_only_on_port_80() {
        for host in ["127.0.0.1", "localhost"] {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            assert!(trusted(&headers, 80));
            assert!(!trusted(&headers, 8090));
            headers.insert(header::ORIGIN, format!("http://{host}").parse().unwrap());
            assert!(trusted(&headers, 80));
            headers.insert(header::ORIGIN, "https://127.0.0.1".parse().unwrap());
            assert!(!trusted(&headers, 80));
            headers.remove(header::ORIGIN);
            headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
            assert!(!trusted(&headers, 80));
        }
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "attacker.example".parse().unwrap());
        assert!(!trusted(&headers, 80));
    }

    #[test]
    fn trust_boundary_rejects_cross_site_and_wrong_hosts() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "switchboard.localhost".parse().unwrap());
        assert!(trusted(&headers, 8090));
        headers.insert(header::ORIGIN, "https://attacker.example".parse().unwrap());
        assert!(!trusted(&headers, 8090));
        headers.remove(header::ORIGIN);
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(!trusted(&headers, 8090));
        headers.remove("sec-fetch-site");
        headers.insert(header::HOST, "attacker.example".parse().unwrap());
        assert!(!trusted(&headers, 8090));
    }

    #[tokio::test]
    async fn board_view_is_available_without_pairing_and_cannot_ack_for_agents() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        let request = |method: Method, path: &str| {
            hyper::Request::builder()
                .method(method)
                .uri(path)
                .header(header::HOST, "127.0.0.1:8090")
        };
        for (path, mime) in [
            ("/messages.html", "text/html; charset=utf-8"),
            ("/messages.js", "application/javascript"),
            ("/messages.css", "text/css; charset=utf-8"),
        ] {
            let response = app
                .clone()
                .oneshot(request(Method::GET, path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()[header::CONTENT_TYPE], mime);
        }
        let response = app
            .clone()
            .oneshot(
                request(Method::GET, "/api/message-board/inboxes")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let value: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(value["configured"], false);
        for (name, value) in [
            ("origin", "http://127.0.0.1:8090"),
            ("sec-fetch-mode", "same-origin"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    request(Method::POST, "/api/message-board/machines/mac/ack/example")
                        .header(name, value)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let response = app
            .oneshot(
                request(Method::GET, "/api/message-board/inboxes")
                    .header(header::ORIGIN, "https://attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn raw_paths_preserve_query_and_forbid_browser_login() {
        assert_eq!(
            upstream_path("/hosts/mac/a%20b?rows=40&x=%2F").unwrap(),
            "a%20b?rows=40&x=%2F"
        );
        for path in [
            "/hosts/mac/command/login",
            "/hosts/mac/%63ommand/login?x=1",
            "/hosts/mac//evil",
        ] {
            assert!(upstream_path(path).is_err());
        }
    }

    #[test]
    fn host_origins_do_not_allow_credentials_or_paths() {
        for url in [
            "file:///secret/token",
            "http://u:p@localhost",
            "http://localhost/path",
            "http://localhost?x=1",
        ] {
            assert!(Host::new(config(url)).is_err());
        }
        assert!(Host::new(config("http://127.0.0.1:8082")).is_ok());
    }

    #[test]
    fn certificate_pins_are_exact_sha256_values() {
        assert_eq!(fingerprint(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        for value in ["invalid".to_owned(), "aa".repeat(31), "gg".repeat(32)] {
            assert!(fingerprint(&value).is_err());
        }
    }

    #[tokio::test]
    async fn duplicate_hosts_are_rejected() {
        let host = config("http://127.0.0.1:8082");
        assert!(router(
            RelayConfig {
                hosts: vec![host.clone(), host],
                artifact_proxy: None,
            },
            8090
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn real_http_reauthenticates_and_keeps_tokens_and_cookies_private() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let logins = Arc::new(AtomicUsize::new(0));
        let upstream = Router::new()
            .route(
                "/command/login",
                axum::routing::post({
                    let logins = logins.clone();
                    move |Json(body): Json<Value>| {
                        let logins = logins.clone();
                        async move {
                            assert_eq!(body["auth_token"], "test-secret");
                            assert_eq!(body["remember_me"], false);
                            let count = logins.fetch_add(1, Ordering::SeqCst);
                            let cookie = if count == 0 {
                                "session_token=expired; HttpOnly; Path=/"
                            } else {
                                "session_token=fresh; HttpOnly; Path=/"
                            };
                            ([(header::SET_COOKIE, cookie)], Json(json!({"ok": true})))
                        }
                    }
                }),
            )
            .route(
                "/session-list",
                get(|headers: HeaderMap| async move {
                    if headers.get(header::COOKIE).and_then(|h| h.to_str().ok())
                        != Some("session_token=fresh")
                    {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    Json(
                        json!({"sessions": [{"name":"main", "web_clients_allowed":true},
                    {"name":"__switchboard_control_private", "web_clients_allowed":true}]}),
                    )
                    .into_response()
                }),
            )
            .route(
                "/main",
                get(|headers: HeaderMap| async move {
                    assert_eq!(headers.get(header::COOKIE).unwrap(), "session_token=fresh");
                    (
                        [
                            (header::CONTENT_TYPE, "text/html"),
                            (header::SET_COOKIE, "secret=upstream"),
                        ],
                        "<!doctype html><html><head></head><body>terminal</body></html>",
                    )
                }),
            )
            .route(
                "/ws/echo",
                any(
                    |websocket: WebSocketUpgrade, headers: HeaderMap| async move {
                        assert_eq!(headers.get(header::COOKIE).unwrap(), "session_token=fresh");
                        websocket.on_upgrade(|mut socket| async move {
                            while let Some(Ok(message)) = socket.next().await {
                                if message
                                    == axum::extract::ws::Message::Text("close-with-code".into())
                                {
                                    let _ = socket
                                        .send(axum::extract::ws::Message::Close(Some(
                                            axum::extract::ws::CloseFrame {
                                                code: 4001,
                                                reason: "Do not reconnect".into(),
                                            },
                                        )))
                                        .await;
                                    break;
                                }
                                if socket.send(message).await.is_err() {
                                    break;
                                }
                            }
                        })
                    },
                ),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let token = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(token.path(), "test-secret\n").unwrap();
        let mut upstream_config = config(&format!("http://127.0.0.1:{upstream_port}"));
        upstream_config.token_file = token.path().to_str().unwrap().to_owned();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_port = listener.local_addr().unwrap().port();
        let mut windows_config = upstream_config.clone();
        windows_config.id = "windows".into();
        windows_config.name = "Windows".into();
        let relay = router(
            RelayConfig {
                hosts: vec![upstream_config, windows_config],
                artifact_proxy: None,
            },
            relay_port,
        )
        .await
        .unwrap();
        let relay_task = tokio::spawn(async move {
            axum::serve(listener, relay).await.unwrap();
        });
        let client = Host::new(config(&format!("http://127.0.0.1:{relay_port}"))).unwrap();
        let summary = client
            .raw_request(
                Method::GET,
                "/api/hosts?summary=1",
                Bytes::new(),
                "application/json",
                None,
            )
            .await
            .unwrap();
        let summary: Value = serde_json::from_slice(&summary.body).unwrap();
        assert_eq!(summary[0]["id"], "mac");
        assert_eq!(summary[1]["id"], "windows");
        assert_eq!(summary[1]["configured"], true);
        assert!(summary[1]["address"].as_str().is_some());
        assert!(!summary.to_string().contains("secret"));
        let response = client
            .raw_request(
                Method::GET,
                "/api/hosts/mac",
                Bytes::new(),
                "application/json",
                Some("browser=must-not-forward"),
            )
            .await
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(logins.load(Ordering::SeqCst), 2);
        assert!(response.headers.get(header::SET_COOKIE).is_none());
        assert!(!String::from_utf8_lossy(&response.body).contains("secret"));
        let catalog: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(catalog["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(catalog["sessions"][0]["name"], "main");
        let response = client
            .raw_request(
                Method::GET,
                "/hosts/mac/main",
                Bytes::new(),
                "text/html",
                Some("browser=must-not-forward"),
            )
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&response.body).contains(BRIDGE));
        assert!(response.headers.get(header::SET_COOKIE).is_none());
        assert_eq!(response.headers.get("cache-control").unwrap(), "no-store");
        let attention = client
            .raw_request(
                Method::GET,
                "/api/attention",
                Bytes::new(),
                "application/json",
                None,
            )
            .await
            .unwrap();
        assert_eq!(attention.status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&attention.body).unwrap(),
            json!({"panes": [], "tabs": [], "errors": []})
        );
        for path in ["/api/hosts/mac/close-tab", "/api/hosts/mac/escape"] {
            assert_eq!(
                client
                    .raw_request(Method::GET, path, Bytes::new(), "application/json", None)
                    .await
                    .unwrap()
                    .status,
                StatusCode::METHOD_NOT_ALLOWED
            );
        }
        assert_eq!(
            client
                .raw_request(
                    Method::POST,
                    "/hosts/mac/command/login",
                    "{}".into(),
                    "application/json",
                    None
                )
                .await
                .unwrap()
                .status,
            StatusCode::FORBIDDEN
        );
        // A cookie accepted by a remote HTTP server is not automatically a
        // locally validated writable token. Local privileged CLI calls fail closed.
        let rejected = client
            .raw_request(
                Method::POST,
                "/api/hosts/mac/escape",
                json!({"session":"main","pane_id":1}).to_string().into(),
                "application/json",
                None,
            )
            .await
            .unwrap();
        assert_eq!(rejected.status, StatusCode::FORBIDDEN);
        assert_eq!(
            client.idle_http.lock().await.len(),
            1,
            "Completed HTTP responses reuse the connection"
        );
        let mut socket = client
            .raw_websocket("/hosts/mac/ws/echo", "browser=must-not-forward")
            .await
            .unwrap();
        for message in [
            Message::Text("terminal text".into()),
            Message::Binary(vec![0, 1, 27, 255].into()),
        ] {
            socket.send(message.clone()).await.unwrap();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(3), socket.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
                message
            );
        }
        socket.close(None).await.unwrap();
        let mut closing = client
            .raw_websocket("/hosts/mac/ws/echo", "browser=must-not-forward")
            .await
            .unwrap();
        closing
            .send(Message::Text("close-with-code".into()))
            .await
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(3), closing.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match closed {
            Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 4001);
                assert_eq!(frame.reason.as_str(), "Do not reconnect");
            },
            other => panic!("Expected original upstream close frame, got {other:?}"),
        }
        upstream_task.abort();
        relay_task.abort();
    }

    #[tokio::test]
    async fn fingerprint_tls_policy_applies_to_http_and_websockets() {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(
            cert.pem().into_bytes(),
            signing_key.serialize_pem().into_bytes(),
        )
        .await
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/ok", get(|| async { "ok" })).route(
            "/ws",
            any(|websocket: WebSocketUpgrade| async {
                websocket.on_upgrade(|mut socket| async move {
                    if let Some(Ok(message)) = socket.next().await {
                        let _ = socket.send(message).await;
                    }
                })
            }),
        );
        let task = tokio::spawn(async move {
            axum_server::from_tcp_rustls(listener, tls)
                .unwrap()
                .serve(app.into_make_service())
                .await
                .unwrap();
        });
        let mut good = config(&format!("https://127.0.0.1:{port}"));
        good.tls_fingerprint = Some(
            Sha256::digest(cert.der().as_ref())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect(),
        );
        let good = Host::new(good).unwrap();
        assert_eq!(
            good.raw_request(Method::GET, "/ok", Bytes::new(), "text/plain", None)
                .await
                .unwrap()
                .body,
            "ok"
        );
        let mut socket = good.raw_websocket("/ws", "test=cookie").await.unwrap();
        socket
            .send(Message::Text("pinned socket".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Text("pinned socket".into())
        );
        let mut wrong = config(&format!("https://127.0.0.1:{port}"));
        wrong.tls_fingerprint = Some("00".repeat(32));
        let wrong = Host::new(wrong).unwrap();
        assert!(wrong
            .raw_request(Method::GET, "/ok", Bytes::new(), "text/plain", None)
            .await
            .is_err());
        assert!(wrong.raw_websocket("/ws", "test=cookie").await.is_err());
        task.abort();
    }
}
