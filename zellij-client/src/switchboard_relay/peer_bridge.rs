//! Share the native web listener with pairing. The relay remains loopback-only.
use super::*;
use axum::extract::FromRequestParts;
use rustls_pki_types::pem::PemObject;
use serde::Serialize;
use std::{net::SocketAddr, path::PathBuf};

const HEADER: &str = "x-switchboard-bridge";
pub(crate) fn directory(port: u16) -> PathBuf {
    zellij_utils::consts::ZELLIJ_CACHE_DIR.join(format!("switchboard-peer-{port}"))
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Registration {
    pub id: String,
    pub revision: String,
    pub port: u16,
    pub endpoint: String,
    #[serde(default)]
    pub hostname: Option<String>,
    pub certificate: String,
    pub key: String,
}
#[derive(Serialize, Deserialize)]
pub(super) struct Ready {
    pub id: String,
    pub certificate: Option<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    pub error: Option<String>,
}
/// Peers can reach this computer here: it owns the address on a running interface.
pub(super) fn local_address(ip: std::net::IpAddr) -> bool {
    hostname::usable_route_address(ip)
        && hostname::is_local_address(ip)
        && hostname::interface_running(ip)
}

async fn connection_address(hint: Option<&str>) -> anyhow::Result<std::net::IpAddr> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut names = Vec::new();
        // The chosen display name can differ from this computer's network name.
        let output = tokio::time::timeout(
            Duration::from_secs(1),
            tokio::process::Command::new("hostname")
                .kill_on_drop(true)
                .output(),
        )
        .await;
        if let Ok(Ok(output)) = output {
            if output.status.success() {
                names.push(String::from_utf8_lossy(&output.stdout).trim().to_owned());
            }
        }
        if let Some(hint) = hint {
            if !names.iter().any(|name| name.eq_ignore_ascii_case(hint)) {
                names.push(hint.to_owned());
            }
        }
        for name in names {
            if let Some(address) = single_local_address(hostname::resolve(&name, 0).await) {
                return Ok(address);
            }
        }
        // Without mDNS, or with several answers, use the default route's address.
        if let Some(address) = hostname::default_route_address().filter(|ip| local_address(*ip)) {
            return Ok(address);
        }
        anyhow::bail!("No single local address for this computer's hostname")
    })
    .await?
}
fn single_local_address(addresses: Vec<SocketAddr>) -> Option<std::net::IpAddr> {
    let mut local = Vec::new();
    for address in addresses {
        if local_address(address.ip()) && !local.contains(&address.ip()) {
            local.push(address.ip());
        }
    }
    (local.len() == 1).then(|| local[0])
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn read(root: &Path) -> anyhow::Result<Registration> {
    Ok(serde_json::from_slice(&std::fs::read(
        root.join("registration.json"),
    )?)?)
}
pub(super) fn selected(request: &Request) -> bool {
    request.uri().path().starts_with("/mesh/")
        || request.headers().contains_key(header::AUTHORIZATION)
}
pub(crate) async fn dispatch(root: PathBuf, request: Request, next: Next) -> Response {
    if selected(&request) {
        forward(root, request).await
    } else {
        next.run(request).await
    }
}
pub(super) fn relay_router(mesh: Arc<mesh::Mesh>, secret: String) -> Router {
    Router::new()
        .nest("/__switchboard_peer", mesh::transport::gateway_router(mesh))
        .layer(middleware::from_fn(move |request: Request, next: Next| {
            let secret = secret.clone();
            async move {
                if request.headers().get(HEADER).and_then(|v| v.to_str().ok())
                    != Some(secret.as_str())
                {
                    return StatusCode::FORBIDDEN.into_response();
                }
                next.run(request).await
            }
        }))
}
pub(super) async fn forward(root: PathBuf, request: Request) -> Response {
    match tokio::time::timeout(Duration::from_secs(15), proxy(root, request)).await {
        Ok(Ok(response)) => response,
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Switchboard pairing service unavailable",
        )
            .into_response(),
    }
}
async fn proxy(root: PathBuf, request: Request) -> anyhow::Result<Response> {
    let registration = read(&root)?;
    let (mut parts, body) = request.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or("/");
    let target = format!("/__switchboard_peer{path}");
    let tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, registration.port)).await?;
    tcp.set_nodelay(true)?;
    let socket: Stream = Box::new(tcp);
    let websocket = WebSocketUpgrade::from_request_parts(&mut parts, &()).await;
    if let Ok(websocket) = websocket {
        let mut upstream =
            format!("ws://127.0.0.1:{}{target}", registration.port).into_client_request()?;
        for name in [
            header::HOST,
            header::AUTHORIZATION,
            header::COOKIE,
            header::ORIGIN,
            header::SEC_WEBSOCKET_PROTOCOL,
        ] {
            if let Some(value) = parts.headers.get(&name) {
                upstream.headers_mut().insert(name, value.clone());
            }
        }
        upstream
            .headers_mut()
            .insert(HEADER, registration.id.parse()?);
        let (upstream, _) = tokio_tungstenite::client_async(upstream, socket).await?;
        return Ok(websocket
            .max_frame_size(LIMIT)
            .max_message_size(LIMIT)
            .on_upgrade(move |downstream| pump(downstream, upstream)));
    }
    let body = to_bytes(body, LIMIT).await?;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(socket)).await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut upstream = hyper::Request::builder()
        .method(parts.method)
        .uri(target)
        .body(Full::new(body))?;
    for name in [
        header::HOST,
        header::AUTHORIZATION,
        header::COOKIE,
        header::ORIGIN,
        header::CONTENT_TYPE,
        header::ACCEPT,
        header::RANGE,
    ] {
        if let Some(value) = parts.headers.get(&name) {
            upstream.headers_mut().insert(name, value.clone());
        }
    }
    upstream
        .headers_mut()
        .insert(HEADER, registration.id.parse()?);
    let response = sender.send_request(upstream).await?;
    let (mut parts, body) = response.into_parts();
    for name in [header::CONNECTION, header::TRANSFER_ENCODING] {
        parts.headers.remove(name);
    }
    Ok(Response::from_parts(parts, Body::new(body)))
}

/// The native server owns the public listener, including its TLS identity. A
/// loopback recovery listener stays private; its LAN sibling serves peers only.
pub(crate) fn start(
    listener: SocketAddr,
    certificate: Option<PathBuf>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let root = directory(listener.port());
        let mut active: Option<(String, axum_server::Handle<SocketAddr>)> = None;
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let Ok(registration) = read(&root) else {
                continue;
            };
            if registration.revision == last {
                continue;
            }
            let result =
                prepare(&registration, listener, certificate.as_deref(), &mut active).await;
            let ready = match result {
                Ok((certificate, endpoint)) => Ready { id: registration.revision.clone(), certificate: Some(certificate), endpoint: Some(endpoint), error: None },
                Err(_) => Ready { id: registration.revision.clone(), certificate: None, endpoint: None, error: Some("Cannot share port 8082. Check this computer's address and web server certificate.".into()) },
            };
            if let Ok(bytes) = serde_json::to_vec(&ready) {
                // No private material in the acknowledgement. Atomic replacement
                // prevents the relay observing a partially written certificate.
                use std::io::Write;
                if let Ok(mut file) = tempfile::NamedTempFile::new_in(&root) {
                    if file.write_all(&bytes).is_ok() {
                        let _ = file.persist(root.join("ready.json"));
                    }
                }
            }
            last = registration.revision;
        }
    })
}
async fn prepare(
    registration: &Registration,
    listener: SocketAddr,
    certificate: Option<&Path>,
    active: &mut Option<(String, axum_server::Handle<SocketAddr>)>,
) -> anyhow::Result<(String, String)> {
    let url = url::Url::parse(&registration.endpoint)?;
    let ip: std::net::IpAddr = url
        .host_str()
        .unwrap_or("")
        .trim_matches(['[', ']'])
        .parse()?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.port() == Some(listener.port())
            && !ip.is_loopback()
            && !ip.is_unspecified()
            && !ip.is_multicast(),
        "Use the native web server port"
    );
    let ip = if local_address(ip) {
        ip
    } else {
        anyhow::ensure!(
            registration.hostname.is_some(),
            "Configured address is not local"
        );
        connection_address(registration.hostname.as_deref()).await?
    };
    prepare_at(
        registration,
        listener,
        certificate,
        active,
        ip,
        directory(listener.port()),
    )
    .await
}

pub(super) async fn prepare_at(
    registration: &Registration,
    listener: SocketAddr,
    certificate: Option<&Path>,
    active: &mut Option<(String, axum_server::Handle<SocketAddr>)>,
    ip: std::net::IpAddr,
    root: PathBuf,
) -> anyhow::Result<(String, String)> {
    use base64::Engine;
    let configured = url::Url::parse(&registration.endpoint)?;
    anyhow::ensure!(
        configured.scheme() == "https" && configured.port() == Some(listener.port()),
        "Use the native web server port"
    );
    anyhow::ensure!(
        local_address(ip),
        "Shared address must belong to this computer"
    );
    let endpoint = format!("https://{}", SocketAddr::new(ip, listener.port()));
    if listener.ip().is_unspecified() || listener.ip() == ip {
        let pem = std::fs::read(certificate.ok_or_else(|| anyhow::anyhow!("HTTPS required"))?)?;
        let cert = rustls_pki_types::CertificateDer::pem_slice_iter(&pem)
            .next()
            .transpose()?
            .ok_or_else(|| anyhow::anyhow!("Missing certificate"))?;
        return Ok((digest(cert.as_ref()), endpoint));
    }
    anyhow::ensure!(
        listener.ip().is_loopback(),
        "Native listener uses a different address"
    );
    let cert =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&registration.certificate)?;
    let fingerprint = digest(&cert);
    let identity = format!("{endpoint}:{fingerprint}");
    if active
        .as_ref()
        .is_some_and(|(existing, _)| existing == &identity)
    {
        return Ok((fingerprint, endpoint));
    }
    let socket = std::net::TcpListener::bind((ip, listener.port()))?;
    socket.set_nonblocking(true)?;
    let key = rustls_pki_types::PrivateKeyDer::from_pem_slice(registration.key.as_bytes())?;
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])?
    .with_no_client_auth()
    .with_single_cert(vec![rustls::pki_types::CertificateDer::from(cert)], key)?;
    let handle = axum_server::Handle::new();
    let acceptor = axum_server::tls_rustls::RustlsAcceptor::new(
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls)),
    )
    .acceptor(axum_server::accept::NoDelayAcceptor);
    let server = axum_server::from_tcp(socket)?
        .acceptor(acceptor)
        .handle(handle.clone());
    tokio::spawn(async move {
        let public = move |request: Request| {
            let root = root.clone();
            async move {
                if selected(&request) {
                    forward(root, request).await
                } else {
                    (StatusCode::NOT_FOUND, "Peer endpoint").into_response()
                }
            }
        };
        let _ = server
            .serve(Router::new().fallback(public).into_make_service())
            .await;
    });
    if !matches!(
        tokio::time::timeout(Duration::from_secs(1), handle.listening()).await,
        Ok(Some(_))
    ) {
        handle.shutdown();
        anyhow::bail!("Replacement shared listener unavailable");
    }
    if let Some((_, previous)) = active.replace((identity, handle)) {
        previous.graceful_shutdown(Some(Duration::from_secs(5)));
    }
    Ok((fingerprint, endpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn local_interface() -> std::net::IpAddr {
        let route = std::net::UdpSocket::bind("0.0.0.0:0").unwrap();
        route.connect("192.0.2.1:9").unwrap();
        route.local_addr().unwrap().ip()
    }
    #[test]
    fn older_bridge_metadata_keeps_working_without_hostname_or_endpoint() {
        let registration: Registration = serde_json::from_value(json!({
            "id":"isolated", "revision":"first", "port":8090,
            "endpoint":"https://192.0.2.1:8082", "certificate":"pin", "key":"key"
        }))
        .unwrap();
        assert!(registration.hostname.is_none());
        let ready: Ready = serde_json::from_value(json!({
            "id":"first", "certificate":"pin", "error":null
        }))
        .unwrap();
        assert!(ready.endpoint.is_none());
    }
    #[test]
    fn hostname_candidates_cannot_bind_another_computers_address() {
        let local = SocketAddr::new(local_interface(), 8082);
        let remote = "192.0.2.254:8082".parse().unwrap();
        let loopback = "127.0.0.1:8082".parse().unwrap();
        assert_eq!(single_local_address(vec![remote, loopback]), None);
        assert_eq!(
            single_local_address(vec![remote, local, local]),
            Some(local.ip())
        );
    }
    #[tokio::test]
    async fn gateway_rebind_preserves_the_tls_identity_and_rejects_nonlocal_addresses() {
        use base64::Engine;
        let temp = tempfile::tempdir().unwrap();
        let ip = local_interface();
        let port = std::net::TcpListener::bind((ip, 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let cert = rcgen::generate_simple_self_signed(vec!["native.test".into()]).unwrap();
        let registration = Registration {
            id: "isolated".into(),
            revision: "moved".into(),
            port: 8090,
            endpoint: format!("https://192.0.2.1:{port}"),
            hostname: None,
            certificate: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(cert.cert.der()),
            key: cert.signing_key.serialize_pem(),
        };
        let mut active = Some(("previous-address".into(), axum_server::Handle::new()));
        let listener = SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), port);
        assert!(prepare(&registration, listener, None, &mut active)
            .await
            .is_err());
        assert!(prepare_at(
            &registration,
            listener,
            None,
            &mut active,
            "192.0.2.254".parse().unwrap(),
            temp.path().to_path_buf(),
        )
        .await
        .is_err());
        assert_eq!(active.as_ref().unwrap().0, "previous-address");
        let occupied = std::net::TcpListener::bind((ip, port)).unwrap();
        assert!(prepare_at(
            &registration,
            listener,
            None,
            &mut active,
            ip,
            temp.path().to_path_buf()
        )
        .await
        .is_err());
        assert_eq!(active.as_ref().unwrap().0, "previous-address");
        drop(occupied);
        let (fingerprint, endpoint) = prepare_at(
            &registration,
            listener,
            None,
            &mut active,
            ip,
            temp.path().to_path_buf(),
        )
        .await
        .unwrap();
        let handle = active.as_ref().unwrap().1.clone();
        assert_eq!(fingerprint, digest(cert.cert.der()));
        assert_eq!(endpoint, format!("https://{}", SocketAddr::new(ip, port)));
        tokio::time::timeout(Duration::from_secs(2), handle.listening())
            .await
            .unwrap()
            .unwrap();
        let mut config = super::super::tests::config(&endpoint);
        config.tls_fingerprint = Some(fingerprint);
        let host = Host::new(config).unwrap();
        let response = host
            .raw_request(
                Method::GET,
                "/private-fixture",
                Bytes::new(),
                "text/plain",
                None,
            )
            .await;
        handle.shutdown();
        assert_eq!(response.unwrap().status, StatusCode::NOT_FOUND);
        assert_eq!(registration.endpoint, format!("https://192.0.2.1:{port}"));
    }
    #[tokio::test]
    async fn existing_tls_listener_keeps_its_certificate_and_port() {
        let temp = tempfile::tempdir().unwrap();
        let cert = rcgen::generate_simple_self_signed(vec!["native.test".into()]).unwrap();
        let path = temp.path().join("native.pem");
        std::fs::write(&path, cert.cert.pem()).unwrap();
        let registration = Registration {
            id: "isolated".into(),
            revision: "first".into(),
            port: 8090,
            endpoint: "https://192.0.2.1:8082".into(),
            hostname: None,
            certificate: "must not replace existing TLS".into(),
            key: "unused".into(),
        };
        let mut active = None;
        let (fingerprint, _) = prepare_at(
            &registration,
            "0.0.0.0:8082".parse().unwrap(),
            Some(&path),
            &mut active,
            local_interface(),
            temp.path().to_path_buf(),
        )
        .await
        .unwrap();
        assert_eq!(fingerprint, digest(cert.cert.der()));
        assert!(
            active.is_none(),
            "an existing listener is reused without binding another port"
        );
        assert!(prepare_at(
            &registration,
            "0.0.0.0:8093".parse().unwrap(),
            Some(&path),
            &mut active,
            local_interface(),
            temp.path().to_path_buf(),
        )
        .await
        .is_err());
        assert!(prepare_at(
            &registration,
            "0.0.0.0:8082".parse().unwrap(),
            None,
            &mut active,
            local_interface(),
            temp.path().to_path_buf(),
        )
        .await
        .is_err());
    }
}
