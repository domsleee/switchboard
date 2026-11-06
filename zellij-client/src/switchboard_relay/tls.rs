//! One private, persistent TLS identity for this computer's loopback services.
use super::*;
use rustls_pki_types::pem::PemObject;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize, Deserialize)]
struct Identity {
    certificate: String,
    authority: String,
    key: String,
}

pub(crate) fn directory() -> anyhow::Result<PathBuf> {
    #[allow(deprecated)]
    Ok(std::env::home_dir()
        .ok_or_else(|| anyhow::anyhow!("No home directory"))?
        .join(".config/switchboard/tls"))
}

pub(crate) fn certificate_path() -> anyhow::Result<PathBuf> {
    Ok(directory()?.join("ca.pem"))
}

pub(crate) fn ensure() -> anyhow::Result<(PathBuf, PathBuf)> {
    ensure_at(&directory()?)
}

pub(super) fn ensure_at(root: &Path) -> anyhow::Result<(PathBuf, PathBuf)> {
    let start = std::time::Instant::now();
    let storage = loop {
        match mesh::storage::Storage::open(root) {
            Ok(storage) => break storage,
            Err(error)
                if error.to_string() == "Mesh state is already in use"
                    && start.elapsed() < Duration::from_secs(2) =>
            {
                std::thread::sleep(Duration::from_millis(25))
            },
            Err(error) => return Err(error),
        }
    };
    let identity = match storage.read::<Identity>("identity.json")? {
        Some(identity) => identity,
        None => {
            let mut authority = rcgen::CertificateParams::new(Vec::<String>::new())?;
            authority.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Constrained(0));
            authority
                .distinguished_name
                .push(rcgen::DnType::CommonName, "Switchboard local services");
            authority.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
            let signing_key = rcgen::KeyPair::generate()?;
            let ca = authority.self_signed(&signing_key)?;
            let issuer = rcgen::Issuer::new(authority, signing_key);
            let mut params = rcgen::CertificateParams::new(vec![
                "localhost".into(),
                "switchboard.localhost".into(),
                "127.0.0.1".into(),
                "::1".into(),
            ])?;
            params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
            let key = rcgen::KeyPair::generate()?;
            let certificate = params.signed_by(&key, &issuer)?;
            // Discard the CA signing key: only this fixed localhost leaf can be served.
            let identity = Identity {
                certificate: certificate.pem(),
                authority: ca.pem(),
                key: key.serialize_pem(),
            };
            storage.write("identity.json", &identity)?;
            identity
        },
    };
    // The single identity file is authoritative if a previous install stopped between writes.
    storage.bytes("ca.pem", identity.authority.as_bytes())?;
    storage.bytes("localhost.pem", identity.certificate.as_bytes())?;
    storage.bytes("localhost-key.pem", identity.key.as_bytes())?;
    Ok((root.join("localhost.pem"), root.join("localhost-key.pem")))
}

pub(super) fn client_with_ca(certificates: &[u8]) -> anyhow::Result<Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_pki_types::CertificateDer::pem_slice_iter(certificates) {
        roots.add(cert?)?;
    }
    Ok(Arc::new(
        rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth(),
    ))
}

pub(crate) async fn server() -> anyhow::Result<axum_server::tls_rustls::RustlsConfig> {
    let (cert, key) = ensure()?;
    Ok(axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?)
}

pub(crate) fn http_client() -> anyhow::Result<isahc::HttpClient> {
    use isahc::config::Configurable;
    Ok(isahc::HttpClient::builder()
        .proxy(None::<isahc::http::Uri>)
        .timeout(Duration::from_secs(15))
        .redirect_policy(isahc::config::RedirectPolicy::None)
        .ssl_ca_certificate(isahc::config::CaCertificate::file(certificate_path()?))
        .build()?)
}

pub(super) async fn serve(
    listener: tokio::net::TcpListener,
    app: Router,
    handle: axum_server::Handle<SocketAddr>,
    config: axum_server::tls_rustls::RustlsConfig,
) -> anyhow::Result<()> {
    let acceptor = axum_server::tls_rustls::RustlsAcceptor::new(config)
        .acceptor(axum_server::accept::NoDelayAcceptor);
    axum_server::from_tcp(listener.into_std()?)?
        .acceptor(acceptor)
        .handle(handle)
        .serve(app.into_make_service())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn local_tls_persists_identity_and_rejects_plaintext_wrong_authority_and_wrong_name() {
        let dir = tempfile::tempdir().unwrap();
        let (cert, key) = ensure_at(dir.path()).unwrap();
        let original = std::fs::read(&cert).unwrap();
        ensure_at(dir.path()).unwrap();
        assert_eq!(original, std::fs::read(&cert).unwrap());
        let ca = std::fs::read(dir.path().join("ca.pem")).unwrap();
        let identity: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("identity.json")).unwrap())
                .unwrap();
        assert!(identity.get("ca_key").is_none());
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = axum_server::Handle::new();
        let server = tokio::spawn(serve(
            listener,
            Router::new().route("/", get(|| async { "secure" })),
            handle.clone(),
            config,
        ));
        handle.listening().await.unwrap();

        let connector = tokio_rustls::TlsConnector::from(client_with_ca(&ca).unwrap());
        let mut stream = connector
            .connect(
                "localhost".try_into().unwrap(),
                TcpStream::connect(address).await.unwrap(),
            )
            .await
            .unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(response.contains("secure"));
        assert!(connector
            .connect(
                "attacker.invalid".try_into().unwrap(),
                TcpStream::connect(address).await.unwrap()
            )
            .await
            .is_err());

        let other = tempfile::tempdir().unwrap();
        ensure_at(other.path()).unwrap();
        let wrong = client_with_ca(&std::fs::read(other.path().join("ca.pem")).unwrap()).unwrap();
        assert!(tokio_rustls::TlsConnector::from(wrong)
            .connect(
                "localhost".try_into().unwrap(),
                TcpStream::connect(address).await.unwrap()
            )
            .await
            .is_err());
        let mut plaintext = TcpStream::connect(address).await.unwrap();
        plaintext
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut bytes = [0; 128];
        if let Ok(Ok(length)) =
            tokio::time::timeout(Duration::from_secs(2), plaintext.read(&mut bytes)).await
        {
            assert!(!String::from_utf8_lossy(&bytes[..length]).contains("200"));
        }
        handle.shutdown();
        server.await.unwrap().unwrap();
    }
}
