//! Loopback Switchboard relay. Terminal engines remain independent processes.
pub(crate) mod artifacts;
mod attention;
mod control;
mod hostname;
mod logs;
mod mesh;
mod output_diagnostics;
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
use futures_util::{stream::FuturesUnordered, SinkExt, StreamExt};
use http_body_util::Full;
use hyper_util::rt::TokioIo;
use include_dir::{include_dir, Dir};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap, future::Future, net::SocketAddr, path::Path, sync::Arc, time::Duration,
};
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
// Leave room inside short control/attention deadlines for a changed DHCP address.
const ROUTE_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const ROUTE_CONNECT_TIMEOUT: Duration = Duration::from_millis(1200);
const ROUTE_CACHE_TTL: Duration = Duration::from_secs(60);
const BRIDGE: &str = "<head><script src=\"/link-config.js\"></script><script src=\"/links.js\"></script><script src=\"/clipboard.js\"></script><script src=\"/chrome.js\"></script><script src=\"/terminal-diagnostics.js\"></script><script src=\"/bridge.js\"></script>";

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
    /// Mesh peers only: the system hostname the peer advertised, for `.local` fallback.
    #[serde(skip)]
    pub hostname: Option<String>,
    /// Mesh peers only: the last address where the peer's pinned TLS identity verified.
    #[serde(skip)]
    pub address: Option<SocketAddr>,
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
    poll: Arc<Mutex<attention::PollState>>,
    mesh: Option<Arc<mesh::Mesh>>,
    // Remote entries left in the hosts file, offered only as "Pair this computer".
    candidates: Arc<Vec<Value>>,
    artifact: Option<artifacts::ArtifactConfig>,
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
    idle_http: Mutex<Vec<hyper::client::conn::http1::SendRequest<Full<Bytes>>>>,
    route_hint: Mutex<Option<(SocketAddr, tokio::time::Instant)>>,
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
            idle_http: Mutex::new(Vec::new()),
            route_hint: Mutex::new(None),
        })
    }

    /// A native engine can listen on a specific local interface instead of loopback.
    /// Ephemeral UDP binding plus route-selected source checks verify local ownership
    /// without sending traffic, even on systems that allow binding nonlocal addresses.
    fn is_local_engine(&self) -> bool {
        // A paired peer remains remote even if DHCP reassigns its old address here.
        if self.is_mesh_peer() {
            return false;
        }
        let address = match self.origin.host() {
            Some(url::Host::Domain("localhost")) => return true,
            Some(url::Host::Ipv4(address)) => std::net::IpAddr::V4(address),
            Some(url::Host::Ipv6(address)) => std::net::IpAddr::V6(address),
            _ => return false,
        };
        if address.is_loopback() {
            return true;
        }
        self.origin.scheme() == "https"
            && self.config.tls_fingerprint.is_some()
            && hostname::is_local_address(address)
    }

    fn is_mesh_peer(&self) -> bool {
        let id = self
            .config
            .id
            .strip_prefix("mesh-")
            .unwrap_or(&self.config.id);
        id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
    }

    fn hostname_hint(&self) -> Option<String> {
        if !self.is_mesh_peer()
            || self.origin.scheme() != "https"
            || self.config.tls_fingerprint.is_none()
        {
            return None;
        }
        let address = match self.origin.host()? {
            url::Host::Ipv4(address) => address.into(),
            url::Host::Ipv6(address) => address.into(),
            _ => return None,
        };
        if !hostname::usable_route_address(address) {
            return None;
        }
        // Older peers do not advertise a hostname; their display name may match it.
        hostname::local_hostname(self.config.hostname.as_deref().unwrap_or(&self.config.name))
    }

    async fn stream(&self) -> anyhow::Result<Stream> {
        let port = self.origin.port_or_known_default().unwrap();
        if let Some(hint) = self.hostname_hint() {
            let address = match self.origin.host().unwrap() {
                url::Host::Ipv4(address) => address.into(),
                url::Host::Ipv6(address) => address.into(),
                _ => unreachable!("Hostname routing requires an IP origin"),
            };
            let original = SocketAddr::new(address, port);
            // A learned address replaces the dead pairing IP as the first try.
            let saved = self.config.address.unwrap_or(original);
            return self
                .stream_with_routes(saved, async {
                    let mut routes: Vec<_> = hostname::resolve(&hint, port)
                        .await
                        .into_iter()
                        .filter(|address| !hostname::is_local_address(address.ip()))
                        .collect();
                    if !routes.contains(&original) {
                        routes.push(original);
                    }
                    routes
                })
                .await;
        }
        let host = self.origin_hostname();
        self.connect_to((host.as_str(), port)).await
    }

    fn origin_hostname(&self) -> String {
        match self.origin.host().unwrap() {
            url::Host::Ipv6(address) => address.to_string(),
            other => other.to_string(),
        }
    }

    async fn connect_to(&self, address: impl tokio::net::ToSocketAddrs) -> anyhow::Result<Stream> {
        let tcp = TcpStream::connect(address).await?;
        tcp.set_nodelay(true)?;
        if let Some(tls) = self.tls.as_ref() {
            // The DNS hint changes only the TCP destination, never TLS identity.
            let name = rustls::pki_types::ServerName::try_from(self.origin_hostname())?;
            Ok(Box::new(
                tokio_rustls::TlsConnector::from(tls.clone())
                    .connect(name, tcp)
                    .await?,
            ))
        } else {
            Ok(Box::new(tcp))
        }
    }

    /// Every attempt ends at TCP/TLS. HTTP and WebSocket handshakes start only
    /// after this returns, so a command can never be replayed on another route.
    async fn stream_with_routes(
        &self,
        original: SocketAddr,
        lookup: impl Future<Output = Vec<SocketAddr>>,
    ) -> anyhow::Result<Stream> {
        let cached = {
            let mut hint = self.route_hint.lock().await;
            if hint.is_some_and(|(_, at)| at.elapsed() >= ROUTE_CACHE_TTL) {
                *hint = None;
            }
            *hint
        };
        let primary = cached.map(|(address, _)| address).unwrap_or(original);
        let primary_error =
            match tokio::time::timeout(ROUTE_PROBE_TIMEOUT, self.connect_to(primary)).await {
                Ok(Ok(stream)) => return Ok(stream),
                Ok(Err(error)) => error,
                Err(_) => anyhow::anyhow!("Paired host connection timed out"),
            };
        if cached.is_some() {
            let mut hint = self.route_hint.lock().await;
            if *hint == cached {
                *hint = None;
            }
        }
        let mut routes = lookup.await;
        if cached.is_some() && !routes.contains(&original) {
            routes.push(original);
        }
        let mut failures = std::collections::BTreeMap::new();
        let mut pending: std::collections::BTreeSet<_> = routes
            .into_iter()
            .filter(|address| *address != primary)
            .collect();
        let mut attempts = FuturesUnordered::new();
        for address in pending.iter().copied() {
            attempts.push(async move { (address, self.connect_to(address).await) });
        }
        let connected = tokio::time::timeout(ROUTE_CONNECT_TIMEOUT, async {
            while let Some((address, result)) = attempts.next().await {
                pending.remove(&address);
                match result {
                    Ok(stream) => return Some((address, stream)),
                    Err(error) => {
                        failures.insert(address, format!("{address}: {error:#}"));
                    },
                }
            }
            None
        })
        .await;
        if let Ok(Some((address, stream))) = connected {
            *self.route_hint.lock().await = Some((address, tokio::time::Instant::now()));
            return Ok(stream);
        }
        for address in pending {
            failures.insert(address, format!("{address}: connection timed out"));
        }
        // Logs keep only 240 characters. Put the hostname result before the
        // already-known stale-address failure so the useful cause survives.
        let fallback = if failures.is_empty() {
            "No alternate hostname addresses were available".into()
        } else {
            failures.into_values().collect::<Vec<_>>().join("; ")
        };
        let hint = self.hostname_hint().unwrap_or_default();
        Err(anyhow::anyhow!(
            "Hostname {hint} fallback failed: {fallback}; initial address {primary}: {primary_error:#}"
        ))
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
        extra: HeaderMap,
    ) -> anyhow::Result<hyper::Response<hyper::body::Incoming>> {
        let mut sender = self.connection(false).await?;
        self.send_request_with(&mut sender, method, path, body, content_type, cookie, extra)
            .await
    }

    /// Local gateway health checks may dial a proven current interface address
    /// while the gateway still authorizes the immutable signed Host authority.
    async fn raw_request_on_local_route(
        &self,
        address: SocketAddr,
        method: Method,
        path: &str,
        body: Bytes,
        content_type: &str,
    ) -> anyhow::Result<UpstreamResponse> {
        anyhow::ensure!(
            self.origin.scheme() == "https"
                && self.config.tls_fingerprint.is_some()
                && !self.is_mesh_peer()
                && address.port() == self.origin.port_or_known_default().unwrap()
                && hostname::is_local_address(address.ip()),
            "Local gateway routing requires a pinned HTTPS origin and a local address"
        );
        let mut sender = Self::connection_on_stream(self.connect_to(address).await?).await?;
        let response = self
            .send_request(&mut sender, method, path, body, content_type, None)
            .await?;
        Ok(UpstreamResponse {
            status: response.status(),
            headers: response.headers().clone(),
            body: to_bytes(Body::new(response.into_body()), LIMIT).await?,
        })
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
        Self::connection_on_stream(self.stream().await?).await
    }

    async fn connection_on_stream(
        stream: Stream,
    ) -> anyhow::Result<hyper::client::conn::http1::SendRequest<Full<Bytes>>> {
        let (sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
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
        let extra = HeaderMap::new();
        self.send_request_with(sender, method, path, body, content_type, cookie, extra)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_request_with(
        &self,
        sender: &mut hyper::client::conn::http1::SendRequest<Full<Bytes>>,
        method: Method,
        path: &str,
        body: Bytes,
        content_type: &str,
        cookie: Option<&str>,
        extra: HeaderMap,
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
        for (name, value) in &extra {
            request = request.header(name, value);
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
        format!("switchboard.localhost:{port}"),
        "switchboard.localhost".into(),
        "switchboard.localhost:443".into(),
        "switchboard.localhost:80".into(),
    ];
    let origins = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
        format!("http://switchboard.localhost:{port}"),
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

// Builds that predate the field report null; forward only these short strings.
fn build_version(catalog: &Value) -> Value {
    ["commit", "commit_date"]
        .into_iter()
        .map(|key| {
            let value = catalog["build"][key].as_str().filter(|v| v.len() <= 40)?;
            Some((key.to_owned(), json!(value)))
        })
        .collect::<Option<serde_json::Map<_, _>>>()
        .map_or(Value::Null, Value::Object)
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
        let catalog: Value = serde_json::from_slice(&response.body)?;
        anyhow::ensure!(catalog["sessions"].is_array(), "Invalid session catalog");
        Ok::<_, anyhow::Error>((catalog["sessions"].clone(), build_version(&catalog)))
    })
    .await;
    let mut description = host_summary(host, configured);
    match result {
        Ok(Ok((sessions, version))) => {
            description["sessions"] = json!(sessions);
            description["version"] = version;
        },
        _ => {
            logs::record(
                &host.config.name,
                "Host unavailable: sessions could not be listed",
            );
            description["error"] = json!("Host unavailable");
        },
    }
    description
}

async fn hosts(State(state): State<RelayState>, request: Request) -> Json<Value> {
    let query = request.uri().query().unwrap_or("").to_owned();
    let flag =
        |name| url::form_urlencoded::parse(query.as_bytes()).any(|(k, v)| k == name && v == "1");
    if flag("summary") {
        let mut summaries: Vec<_> = state
            .all_hosts()
            .iter()
            .map(|host| host_summary(host, state.hosts.contains_key(&host.config.id)))
            .collect();
        if flag("candidates") {
            summaries.extend(state.candidates.iter().cloned());
        }
        return Json(Value::Array(summaries));
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

// The artifact proxy serves one computer's gallery port under a local hostname;
// links from that computer's terminals to that port open through the proxy.
fn artifact_links(state: &RelayState, host: &Host) -> Value {
    if host
        .config
        .artifact_urls
        .as_object()
        .is_some_and(|links| !links.is_empty())
    {
        return host.config.artifact_urls.clone();
    }
    let Some(proxy) = &state.artifact else {
        return Value::Null;
    };
    match url::Url::parse(&proxy.target) {
        Ok(target)
            if target.host_str().is_some() && target.host_str() == host.origin.host_str() =>
        {
            match target.port_or_known_default() {
                Some(port) => json!({ port.to_string(): format!("https://{}", proxy.hostname) }),
                None => Value::Null,
            }
        },
        _ => Value::Null,
    }
}

async fn link_config(State(state): State<RelayState>) -> Response {
    let data: serde_json::Map<String, Value> = state.all_hosts().iter().map(|host| {
        let local = host.is_local_engine();
        (host.config.id.clone(), json!({"origin": host.config.url, "local": local, "artifacts": artifact_links(&state, host)}))
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
        let terminal = path
            .split('?')
            .next()
            .is_some_and(|path| path == "/ws/terminal" || path.starts_with("/ws/terminal/"));
        let source = terminal.then(|| host.config.name.clone());
        return Ok(websocket
            .max_message_size(LIMIT)
            .max_frame_size(LIMIT)
            .on_upgrade(move |downstream| {
                pump_with_output_diagnostics(downstream, upstream, source)
            }));
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
    pump_with_output_diagnostics(downstream, upstream, None).await;
}

/// A network change can leave a TCP connection open but silent. Ping both sides
/// and close the pair when one stops answering, so the browser reconnects
/// instead of typing into a dead socket.
const PING_EVERY: Duration = Duration::from_millis(if cfg!(test) { 100 } else { 10_000 });
const SILENT_LIMIT: Duration = Duration::from_millis(if cfg!(test) { 300 } else { 30_000 });

async fn pump_with_output_diagnostics(
    downstream: axum::extract::ws::WebSocket,
    upstream: WebSocketStream<Stream>,
    source: Option<String>,
) {
    let (mut downstream_tx, mut downstream_rx) = downstream.split();
    let (mut upstream_tx, mut upstream_rx) = upstream.split();
    let started = std::time::Instant::now();
    let elapsed = || started.elapsed().as_millis() as u64;
    let silent = |seen: &std::sync::atomic::AtomicU64| {
        elapsed().saturating_sub(seen.load(std::sync::atomic::Ordering::Relaxed))
            > SILENT_LIMIT.as_millis() as u64
    };
    let browser_seen = std::sync::atomic::AtomicU64::new(0);
    let host_seen = std::sync::atomic::AtomicU64::new(0);
    let ping = || tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let from_browser = async {
        let mut ping = ping();
        loop {
            let incoming = tokio::select! {
                incoming = downstream_rx.next() => incoming,
                _ = ping.tick() => {
                    if silent(&host_seen) || upstream_tx.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                    continue;
                },
            };
            let Some(Ok(message)) = incoming else { break };
            browser_seen.store(elapsed(), std::sync::atomic::Ordering::Relaxed);
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
    let mut output = output_diagnostics::OutputWindow::default();
    let from_host = async {
        let mut ping = ping();
        let mut report_tick = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(5),
            Duration::from_secs(5),
        );
        report_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let incoming = tokio::select! {
                incoming = upstream_rx.next() => incoming,
                _ = ping.tick() => {
                    if silent(&browser_seen) || downstream_tx.send(axum::extract::ws::Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                    continue;
                },
                _ = report_tick.tick(), if source.is_some() => {
                    if let Some(message) = output.report(started.elapsed()) {
                        logs::record(source.as_deref().unwrap(), &message);
                    }
                    continue;
                },
            };
            let Some(Ok(message)) = incoming else { break };
            host_seen.store(elapsed(), std::sync::atomic::Ordering::Relaxed);
            let received = started.elapsed();
            let observation = match &message {
                Message::Text(value) if source.is_some() => Some((
                    value.len(),
                    value.contains("\u{1b}[2J"),
                    value.contains("\u{1b}[?2026h"),
                )),
                Message::Binary(value) if source.is_some() => Some((value.len(), false, false)),
                _ => None,
            };
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
            let forwarding = std::time::Instant::now();
            let sent = downstream_tx.send(message).await;
            if let Some((bytes, full_clear, synchronized)) = observation {
                output.frame(
                    received,
                    bytes,
                    full_clear,
                    synchronized,
                    forwarding.elapsed(),
                );
            }
            if sent.is_err() {
                break;
            }
        }
        let _ = downstream_tx.close().await;
    };
    tokio::select! { _ = from_browser => {}, _ = from_host => {} }
    if let Some(source) = source.as_deref() {
        if let Some(message) = output.report(started.elapsed()) {
            logs::record(source, &message);
        }
    }
}

async fn asset(request: Request) -> Response {
    let name = request.uri().path().trim_start_matches('/');
    let name = if name.is_empty() { "index.html" } else { name };
    let mime = match name {
        "index.html" | "computers.html" | "messages.html" => "text/html; charset=utf-8",
        "style.css" | "messages.css" => "text/css; charset=utf-8",
        "app.js"
        | "startup-cache.js"
        | "bridge.js"
        | "chrome.js"
        | "clipboard.js"
        | "close.js"
        | "links.js"
        | "titles.js"
        | "computers.js"
        | "pairing-notice.js"
        | "messages.js"
        | "terminal-diagnostics.js" => "application/javascript",
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
    let mut candidates = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for config in config.hosts.clone() {
        anyhow::ensure!(
            !config.id.is_empty() && ids.insert(config.id.clone()),
            "Duplicate or empty host ID"
        );
        let host = Host::new(config)?;
        // Other computers exist only through pairing; this file holds the local engine.
        if host.config.escape_transport.as_deref() == Some("local") || host.is_local_engine() {
            order.push(host.config.id.clone());
            hosts.insert(host.config.id.clone(), Arc::new(host));
        } else {
            log::warn!(
                "Ignoring remote host '{}' in the hosts file: pair this computer in Computers",
                host.config.id
            );
            candidates.push(host_summary(&host, true));
        }
    }
    Ok(RelayState {
        hosts: Arc::new(hosts),
        order: Arc::new(order),
        port,
        // Until the first scan, report every host unavailable rather than tabless.
        attention: Arc::new(Mutex::new(
            json!({"panes": [], "tabs": [], "errors": [{"host": "Switchboard", "message": "Status starting"}]}),
        )),
        poll: Default::default(),
        mesh: None,
        candidates: Arc::new(candidates),
        artifact: config.artifact_proxy.clone(),
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
        .route("/api/attention/ack", post(attention::acknowledge))
        .route("/api/logs", get(logs::handler))
        .route(
            "/api/diagnostics/browser-resume",
            post(logs::browser_resume),
        )
        .route(
            "/api/diagnostics/terminal-switch",
            post(logs::terminal_switch),
        )
        .route("/api/diagnostics/new-tab", post(logs::new_tab))
        .route(
            "/api/diagnostics/modified-enter",
            post(logs::modified_enter),
        )
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
            Err(_) => logs::record(
                "pairing",
                "Switchboard pairing unavailable; local relay continues",
            ),
        }
    }
    let pairing = mesh::discovery::start(state.clone());
    let artifact = artifacts::start(config.artifact_proxy, state.clone()).await?;
    let failures_file = config_path.with_extension("logs.json");
    let failures = logs::start(failures_file.clone()).await;
    let polling =
        attention::start(state.clone(), config_path.with_extension("attention.json")).await;
    // Keystrokes and echoes are tiny writes; Nagle plus delayed ACK can hold each one back.
    let listener = axum::serve::ListenerExt::tap_io(listener, |stream| {
        let _ = stream.set_nodelay(true);
    });
    let result = axum::serve(listener, app(state.clone()))
        .with_graceful_shutdown(shutdown())
        .await;
    pairing.abort();
    failures.abort();
    logs::save(&failures_file).await;
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
            hostname: None,
            address: None,
        }
    }

    struct TlsFixture {
        address: SocketAddr,
        pin: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TlsFixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn tls_fixture(app: Router) -> TlsFixture {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let pin = Sha256::digest(cert.der().as_ref())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem(
            cert.pem().into_bytes(),
            signing_key.serialize_pem().into_bytes(),
        )
        .await
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum_server::from_tcp_rustls(listener, tls)
                .unwrap()
                .serve(app.into_make_service())
                .await
                .unwrap();
        });
        TlsFixture { address, pin, task }
    }

    fn paired_config(port: u16, pin: &str) -> HostConfig {
        let mut configured = config(&format!("https://192.0.2.123:{port}"));
        configured.id = format!("mesh-{}", "ab".repeat(32));
        configured.name = "1WN9PD4".into();
        configured.tls_fingerprint = Some(pin.into());
        configured
    }

    #[test]
    fn hostname_fallback_requires_a_paired_pinned_ip_origin() {
        let good = paired_config(8082, &"00".repeat(32));
        for id in [good.id.clone(), "ab".repeat(32)] {
            let mut configured = good.clone();
            configured.id = id;
            assert_eq!(
                Host::new(configured).unwrap().hostname_hint().as_deref(),
                Some("1WN9PD4.local")
            );
        }
        let mut variants = Vec::new();
        let mut unpaired = good.clone();
        unpaired.id = "windows".into();
        variants.push(unpaired);
        let mut unpinned = good.clone();
        unpinned.tls_fingerprint = None;
        variants.push(unpinned);
        let mut http = good.clone();
        http.url = "http://192.0.2.123:8082".into();
        http.tls_fingerprint = None;
        variants.push(http);
        for url in [
            "https://127.0.0.1:8082",
            "https://[::1]:8082",
            "https://[::ffff:127.0.0.1]:8082",
            "https://localhost:8082",
            "https://peer.example:8082",
            "https://0.0.0.0:8082",
        ] {
            let mut configured = good.clone();
            configured.url = url.into();
            variants.push(configured);
        }
        let mut invalid_name = good;
        invalid_name.name = "Friendly Windows Computer".into();
        variants.push(invalid_name);
        for configured in variants {
            assert!(Host::new(configured).unwrap().hostname_hint().is_none());
        }
    }

    #[test]
    fn a_paired_peer_stays_remote_when_its_saved_ip_is_now_local() {
        let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        route.connect("192.0.2.1:9").unwrap();
        let address = route.local_addr().unwrap().ip();
        assert!(hostname::is_local_address(address));
        let mut configured = paired_config(8082, &"00".repeat(32));
        configured.url = format!("https://{address}:8082");
        let host = Host::new(configured).unwrap();
        assert!(!host.is_local_engine());
        assert_eq!(host_summary(&host, false)["local"], false);
        if hostname::usable_route_address(address) {
            assert_eq!(host.hostname_hint().as_deref(), Some("1WN9PD4.local"));
        }
    }

    #[tokio::test]
    async fn hostname_route_rejects_wrong_pin_then_preserves_http_and_websocket_identity() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let wrong_requests = Arc::new(AtomicUsize::new(0));
        let counter = wrong_requests.clone();
        let wrong = tls_fixture(Router::new().fallback(any(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                "wrong peer"
            }
        })))
        .await;
        let captured = Arc::new(Mutex::new(Vec::new()));
        let requests = captured.clone();
        let websocket_requests = captured.clone();
        let correct = tls_fixture(
            Router::new()
                .route(
                    "/command/test",
                    post(move |headers: HeaderMap, body: Bytes| {
                        let requests = requests.clone();
                        async move {
                            requests.lock().await.push((headers, body));
                            "ok"
                        }
                    }),
                )
                .route(
                    "/ws",
                    any(move |headers: HeaderMap, websocket: WebSocketUpgrade| {
                        let requests = websocket_requests.clone();
                        async move {
                            requests.lock().await.push((headers, Bytes::new()));
                            websocket.on_upgrade(|mut socket| async move {
                                if let Some(Ok(message)) = socket.next().await {
                                    let _ = socket.send(message).await;
                                }
                            })
                        }
                    }),
                ),
        )
        .await;
        let token = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(token.path(), "synthetic-gateway-token\n").unwrap();
        let mut configured = paired_config(wrong.address.port(), &correct.pin);
        configured.gateway_token_file = Some(token.path().to_str().unwrap().into());
        let host = Host::new(configured).unwrap();
        let original_origin = host.origin.clone();
        let stream = host
            .stream_with_routes(wrong.address, std::future::ready(vec![correct.address]))
            .await
            .unwrap();
        let mut sender = Host::connection_on_stream(stream).await.unwrap();
        let response = host
            .send_request(
                &mut sender,
                Method::POST,
                "/command/test",
                Bytes::from_static(b"synthetic-command"),
                "text/plain",
                Some("session_token=synthetic-cookie"),
            )
            .await
            .unwrap();
        assert_eq!(
            to_bytes(Body::new(response.into_body()), LIMIT)
                .await
                .unwrap(),
            "ok"
        );
        assert_eq!(wrong_requests.load(Ordering::SeqCst), 0);
        assert_eq!(host.route_hint.lock().await.unwrap().0, correct.address);

        // The ordinary WebSocket path must reuse the authenticated routing hint,
        // while preserving the original URL and gateway/cookie credentials.
        let mut socket = host
            .raw_websocket("/ws", "session_token=synthetic-cookie")
            .await
            .unwrap();
        socket
            .send(Message::Text("synthetic input".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Text("synthetic input".into())
        );
        assert_eq!(host.origin, original_origin);
        assert_eq!(
            host.config.url,
            format!("https://192.0.2.123:{}", wrong.address.port())
        );
        let requests = captured.lock().await;
        assert_eq!(requests.len(), 2);
        for (headers, _) in requests.iter() {
            assert_eq!(headers[header::HOST], host.authority());
            assert_eq!(
                headers[header::AUTHORIZATION],
                "Bearer synthetic-gateway-token"
            );
            assert_eq!(headers[header::COOKIE], "session_token=synthetic-cookie");
        }
        assert_eq!(requests[0].1, "synthetic-command");
        socket.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn hostname_routes_with_wrong_pins_receive_no_application_requests() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let requests = Arc::new(AtomicUsize::new(0));
        let app = |counter: Arc<AtomicUsize>| {
            Router::new().fallback(any(move || {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    "unexpected"
                }
            }))
        };
        let first = tls_fixture(app(requests.clone())).await;
        let second = tls_fixture(app(requests.clone())).await;
        let host = Host::new(paired_config(first.address.port(), &"00".repeat(32))).unwrap();
        let error = host
            .stream_with_routes(first.address, std::future::ready(vec![second.address]))
            .await
            .err()
            .unwrap();
        assert!(format!("{error:#}").contains("fingerprint mismatch"));
        assert!(host.route_hint.lock().await.is_none());
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn hostname_route_errors_report_the_resolved_address_and_its_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let original = listener.local_addr().unwrap();
        let stall = tokio::spawn(async move {
            let (_tcp, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let resolved = closed.local_addr().unwrap();
        drop(closed);
        let host = Host::new(paired_config(original.port(), &"00".repeat(32))).unwrap();
        let error = host
            .stream_with_routes(original, std::future::ready(vec![resolved]))
            .await
            .err()
            .unwrap();
        stall.abort();
        let message = format!("{error:#}");
        assert!(message.contains("1WN9PD4.local"), "{message}");
        assert!(message.contains(&original.to_string()), "{message}");
        assert!(message.contains(&resolved.to_string()), "{message}");
        assert!(message.contains("timed out"), "{message}");
        assert!(
            message.to_ascii_lowercase().contains("refused"),
            "{message}"
        );
        assert!(host.route_hint.lock().await.is_none());
    }

    #[tokio::test]
    async fn hostname_route_errors_distinguish_missing_alternate_addresses() {
        let original = tls_fixture(Router::new()).await;
        let host = Host::new(paired_config(original.address.port(), &"00".repeat(32))).unwrap();
        let error = host
            .stream_with_routes(original.address, std::future::ready(Vec::new()))
            .await
            .err()
            .unwrap();
        let message = format!("{error:#}");
        assert!(
            message.contains("No alternate hostname addresses"),
            "{message}"
        );
        assert!(message.contains("fingerprint mismatch"), "{message}");
    }

    #[tokio::test]
    async fn hostname_cached_route_failure_retries_original_without_dns() {
        let original = tls_fixture(Router::new()).await;
        let cached = tls_fixture(Router::new()).await;
        let host = Host::new(paired_config(original.address.port(), &original.pin)).unwrap();
        *host.route_hint.lock().await = Some((cached.address, tokio::time::Instant::now()));
        let stream = host
            .stream_with_routes(original.address, std::future::ready(Vec::new()))
            .await
            .unwrap();
        assert_eq!(host.route_hint.lock().await.unwrap().0, original.address);
        drop(stream);
    }

    #[test]
    fn hostname_hint_prefers_the_advertised_hostname_over_the_display_name() {
        let mut configured = paired_config(8082, &"00".repeat(32));
        configured.name = "Windows".into();
        let host = Host::new(configured.clone()).unwrap();
        assert_eq!(host.hostname_hint().as_deref(), Some("Windows.local"));
        configured.hostname = Some("DESKTOP-ABC123.local".into());
        let host = Host::new(configured).unwrap();
        assert_eq!(
            host.hostname_hint().as_deref(),
            Some("DESKTOP-ABC123.local")
        );
    }

    #[tokio::test]
    async fn learned_address_replaces_the_dead_pairing_ip_but_keeps_the_pin() {
        let correct = tls_fixture(Router::new()).await;
        let wrong = tls_fixture(Router::new()).await;
        // The pairing IP is unroutable and the name never resolves.
        let mut configured = paired_config(correct.address.port(), &correct.pin);
        configured.name = "switchboard-test-unresolvable".into();
        configured.address = Some(correct.address);
        let host = Host::new(configured.clone()).unwrap();
        assert!(host.stream().await.is_ok());
        assert!(host.route_hint.lock().await.is_none());
        configured.address = Some(wrong.address);
        let host = Host::new(configured).unwrap();
        assert!(host.stream().await.is_err());
        assert!(host.route_hint.lock().await.is_none());
    }

    #[tokio::test]
    async fn hostname_dead_ip_tls_probe_leaves_time_for_fallback() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let original = listener.local_addr().unwrap();
        let stall = tokio::spawn(async move {
            let (_tcp, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let correct = tls_fixture(Router::new()).await;
        let host = Host::new(paired_config(original.port(), &correct.pin)).unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            host.stream_with_routes(original, std::future::ready(vec![correct.address])),
        )
        .await;
        stall.abort();
        assert!(result.unwrap().is_ok());
        assert_eq!(host.route_hint.lock().await.unwrap().0, correct.address);
    }

    #[tokio::test]
    async fn hostname_route_never_replays_a_command_after_http_starts() {
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let pin: String = Sha256::digest(cert.der().as_ref())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der()).into(),
        )
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let received = commands.clone();
        let task = tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let acceptor = acceptor.clone();
                let received = received.clone();
                tokio::spawn(async move {
                    let stream = acceptor.accept(tcp).await.unwrap();
                    let service = hyper::service::service_fn(
                        move |request: hyper::Request<hyper::body::Incoming>| {
                            let received = received.clone();
                            async move {
                                let body = to_bytes(Body::new(request.into_body()), LIMIT)
                                    .await
                                    .unwrap();
                                received.lock().await.push(body);
                                // Deliberately close after receiving the command, before
                                // a response; retrying now would perform it twice.
                                Err::<hyper::Response<Full<Bytes>>, _>(std::io::Error::other(
                                    "synthetic response lost",
                                ))
                            }
                        },
                    );
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        let fixture = TlsFixture { address, pin, task };
        let host = Host::new(paired_config(fixture.address.port(), &fixture.pin)).unwrap();
        *host.route_hint.lock().await = Some((fixture.address, tokio::time::Instant::now()));
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            host.raw_request(
                Method::POST,
                "/command/test",
                Bytes::from_static(b"execute-once"),
                "text/plain",
                None,
            ),
        )
        .await
        .unwrap();
        assert!(result.is_err());
        assert_eq!(
            *commands.lock().await,
            vec![Bytes::from_static(b"execute-once")]
        );
    }

    #[tokio::test]
    async fn local_route_request_rejects_unpinned_remote_or_changed_port_targets() {
        let host = Host::new(config("http://127.0.0.1:8082")).unwrap();
        async fn request(host: &Host, address: SocketAddr) -> anyhow::Result<UpstreamResponse> {
            host.raw_request_on_local_route(address, Method::GET, "/", Bytes::new(), "text/plain")
                .await
        }
        assert!(request(&host, "127.0.0.1:8082".parse().unwrap())
            .await
            .is_err());
        let mut configured = config("https://192.0.2.123:8082");
        configured.tls_fingerprint = Some("00".repeat(32));
        let host = Host::new(configured).unwrap();
        assert!(request(&host, "192.0.2.123:8082".parse().unwrap())
            .await
            .is_err());
        assert!(request(&host, "127.0.0.1:8083".parse().unwrap())
            .await
            .is_err());
        let peer = Host::new(paired_config(8082, &"00".repeat(32))).unwrap();
        assert!(request(&peer, "127.0.0.1:8082".parse().unwrap())
            .await
            .is_err());
    }

    #[test]
    fn artifact_proxy_target_computer_gets_gallery_links() {
        let state = RelayState {
            hosts: Default::default(),
            order: Default::default(),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: Some(artifacts::ArtifactConfig {
                hostname: "zellij-gallery.localhost".into(),
                target: "http://192.0.2.69:8765".into(),
            }),
        };
        let paired = Host::new(config("https://192.0.2.69:8082")).unwrap();
        assert_eq!(
            artifact_links(&state, &paired),
            json!({"8765": "https://zellij-gallery.localhost"})
        );
        let other = Host::new(config("https://192.0.2.15:8082")).unwrap();
        assert_eq!(artifact_links(&state, &other), Value::Null);
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

    #[tokio::test]
    async fn remote_hosts_file_entries_are_pair_candidates_not_hosts() {
        use tower::ServiceExt;
        let mut remote = config("https://192.0.2.69:8082");
        remote.id = "windows".into();
        remote.name = "Windows".into();
        remote.tls_fingerprint = Some("ab".repeat(32));
        let mut declared = config("https://192.0.2.70:8082");
        declared.id = "declared".into();
        declared.escape_transport = Some("local".into());
        let config = RelayConfig {
            hosts: vec![config("http://127.0.0.1:8082"), remote, declared],
            artifact_proxy: None,
        };
        let relay = state(&config, 8090).await.unwrap();
        let ids: Vec<_> = relay
            .all_hosts()
            .iter()
            .map(|h| h.config.id.clone())
            .collect();
        assert_eq!(ids, ["mac", "declared"]);
        assert!(relay.host("windows").is_none());
        let app = app(relay);
        let get = |path: &str| {
            app.clone().oneshot(
                hyper::Request::builder()
                    .uri(path)
                    .header(header::HOST, "127.0.0.1:8090")
                    .body(Body::empty())
                    .unwrap(),
            )
        };
        let body = |response: Response| async move {
            serde_json::from_slice::<Value>(&to_bytes(response.into_body(), 65536).await.unwrap())
                .unwrap()
        };
        let summary = body(get("/api/hosts?summary=1").await.unwrap()).await;
        assert_eq!(summary.as_array().unwrap().len(), 2);
        let candidates = body(get("/api/hosts?summary=1&candidates=1").await.unwrap()).await;
        assert_eq!(candidates[2]["id"], "windows");
        assert_eq!(candidates[2]["configured"], true);
        assert_eq!(candidates[2]["local"], false);
        assert_eq!(candidates[2]["pairing_address"], "https://192.0.2.69:8082");
        assert_eq!(
            get("/api/hosts/windows").await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        let links = get("/link-config.js").await.unwrap().into_body();
        assert!(
            !String::from_utf8_lossy(&to_bytes(links, 65536).await.unwrap()).contains("windows")
        );
    }

    #[tokio::test]
    async fn silent_upstream_closes_the_browser_socket() {
        // A host behind a dead route: the handshake completes, then nothing is read or answered.
        let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let silent_address = silent.local_addr().unwrap();
        tokio::spawn(async move {
            let (tcp, _) = silent.accept().await.unwrap();
            let _socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            std::future::pending::<()>().await;
        });
        let relay = Router::new().route(
            "/ws",
            any(move |websocket: WebSocketUpgrade| async move {
                let tcp = TcpStream::connect(silent_address).await.unwrap();
                let (upstream, _) = tokio_tungstenite::client_async(
                    format!("ws://{silent_address}/"),
                    Box::new(tcp) as Stream,
                )
                .await
                .unwrap();
                websocket.on_upgrade(move |downstream| pump(downstream, upstream))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
        let (mut browser, _) = tokio_tungstenite::connect_async(format!("ws://{address}/ws"))
            .await
            .unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(message)) = browser.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "the browser must see the silent host's socket end"
        );
    }

    #[tokio::test]
    async fn paired_host_control_goes_only_through_its_gateway() {
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let upstream = Router::new()
            .route(
                "/command/login",
                post(|| async {
                    (
                        [(header::SET_COOKIE, "session_token=peer; Path=/")],
                        Json(json!({})),
                    )
                }),
            )
            .route(
                "/switchboard/control",
                post({
                    let received = received.clone();
                    move |Json(body): Json<Value>| async move {
                        received.lock().await.push(body);
                        Json(json!({"ok": true}))
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let token = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(token.path(), "peer-token").unwrap();
        let mut peer = config(&url);
        peer.id = "mesh-peer".into();
        peer.token_file = token.path().to_str().unwrap().into();
        peer.escape_transport = Some("gateway".into());
        let mut relay = state(
            &RelayConfig {
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        relay.hosts = Arc::new([("mesh-peer".into(), Arc::new(Host::new(peer).unwrap()))].into());
        let response = control::close_tab(
            State(relay.clone()),
            RoutePath("mesh-peer".into()),
            Json(serde_json::from_value(json!({"session":"main","tab_id":7})).unwrap()),
        )
        .await;
        assert!(response.is_ok());
        let response = control::close_tab(
            State(relay),
            RoutePath("mesh-peer".into()),
            Json(serde_json::from_value(json!({"session":"main","pane_id":17})).unwrap()),
        )
        .await;
        assert!(response.is_ok());
        assert_eq!(
            *received.lock().await,
            [
                json!({"session":"main","target":7,"close":true}),
                json!({"session":"main","pane_id":17,"close":true}),
            ]
        );
        server.abort();
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
    fn named_relay_url_accepts_only_its_configured_port() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "switchboard.localhost:8123".parse().unwrap());
        headers.insert(
            header::ORIGIN,
            "http://switchboard.localhost:8123".parse().unwrap(),
        );
        assert!(trusted(&headers, 8123));
        assert!(!trusted(&headers, 8090));
        headers.insert(
            header::ORIGIN,
            "http://switchboard.localhost:8124".parse().unwrap(),
        );
        assert!(!trusted(&headers, 8123));
        headers.insert(
            header::ORIGIN,
            "http://switchboard.localhost:8123".parse().unwrap(),
        );
        headers.insert("sec-fetch-site", "cross-site".parse().unwrap());
        assert!(!trusted(&headers, 8123));
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
            ("/terminal-diagnostics.js", "application/javascript"),
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
    fn build_version_is_null_for_older_hosts() {
        assert_eq!(build_version(&json!({"sessions": []})), Value::Null);
        assert_eq!(
            build_version(&json!({"build": {"commit": "abc1234"}})),
            Value::Null
        );
        assert_eq!(
            build_version(&json!({"build": {"commit": "x".repeat(41), "commit_date": "d"}})),
            Value::Null
        );
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
                        json!({"sessions": [{"name":"main", "web_clients_allowed":true}],
                    "build": {"commit":"abc1234", "commit_date":"2026-10-07", "extra":"dropped"}}),
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
        assert_eq!(
            catalog["version"],
            json!({"commit":"abc1234", "commit_date":"2026-10-07"})
        );
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
            json!({"panes": [], "tabs": [], "errors": [{"host": "Switchboard", "message": "Status starting"}]})
        );
        assert_eq!(
            client
                .raw_request(
                    Method::POST,
                    "/api/attention/ack",
                    json!({"host":"unknown","session":"main","pane_id":1,"token":"result:0"})
                        .to_string()
                        .into(),
                    "application/json",
                    None
                )
                .await
                .unwrap()
                .status,
            StatusCode::NOT_FOUND,
            "reviews reach the relay and name a known computer"
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
