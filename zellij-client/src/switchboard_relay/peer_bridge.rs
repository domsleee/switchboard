//! Share the native web listener with pairing. The relay remains loopback-only.
use super::*;
use axum::extract::FromRequestParts;
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
    pub certificate: String,
    pub key: String,
}
#[derive(Serialize, Deserialize)]
pub(super) struct Ready {
    pub id: String,
    pub certificate: Option<String>,
    pub error: Option<String>,
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
    let socket: Stream =
        Box::new(TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, registration.port)).await?);
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
                Ok(certificate) => Ready { id: registration.revision.clone(), certificate: Some(certificate), error: None },
                Err(_) => Ready { id: registration.revision.clone(), certificate: None, error: Some("Cannot share port 8082. Check this computer's address and web server certificate.".into()) },
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
) -> anyhow::Result<String> {
    use base64::Engine;
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
    if listener.ip().is_unspecified() || listener.ip() == ip {
        let pem = std::fs::read(certificate.ok_or_else(|| anyhow::anyhow!("HTTPS required"))?)?;
        let cert = rustls_pemfile::certs(&mut pem.as_slice())
            .next()
            .transpose()?
            .ok_or_else(|| anyhow::anyhow!("Missing certificate"))?;
        return Ok(digest(cert.as_ref()));
    }
    anyhow::ensure!(
        listener.ip().is_loopback(),
        "Native listener uses a different address"
    );
    let cert =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&registration.certificate)?;
    let fingerprint = digest(&cert);
    let identity = format!("{}:{fingerprint}", registration.endpoint);
    if active
        .as_ref()
        .is_some_and(|(existing, _)| existing == &identity)
    {
        return Ok(fingerprint);
    }
    anyhow::ensure!(
        active.is_none(),
        "Restart the web service to change the shared address"
    );
    let socket = std::net::TcpListener::bind((ip, listener.port()))?;
    socket.set_nonblocking(true)?;
    let key = rustls_pemfile::private_key(&mut registration.key.as_bytes())?
        .ok_or_else(|| anyhow::anyhow!("Missing key"))?;
    let tls = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])?
    .with_no_client_auth()
    .with_single_cert(vec![rustls::pki_types::CertificateDer::from(cert)], key)?;
    let handle = axum_server::Handle::new();
    let server = axum_server::from_tcp_rustls(
        socket,
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls)),
    )?
    .handle(handle.clone());
    let root = directory(listener.port());
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
    *active = Some((identity, handle));
    Ok(fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;
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
            certificate: "must not replace existing TLS".into(),
            key: "unused".into(),
        };
        let mut active = None;
        let fingerprint = prepare(
            &registration,
            "0.0.0.0:8082".parse().unwrap(),
            Some(&path),
            &mut active,
        )
        .await
        .unwrap();
        assert_eq!(fingerprint, digest(cert.cert.der()));
        assert!(
            active.is_none(),
            "an existing listener is reused without binding another port"
        );
        assert!(prepare(
            &registration,
            "0.0.0.0:8093".parse().unwrap(),
            Some(&path),
            &mut active
        )
        .await
        .is_err());
        assert!(prepare(
            &registration,
            "0.0.0.0:8082".parse().unwrap(),
            None,
            &mut active
        )
        .await
        .is_err());
    }
}
