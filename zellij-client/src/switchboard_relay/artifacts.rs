use super::*;
use http_body_util::BodyExt;

#[derive(Clone, Deserialize)]
pub struct ArtifactConfig {
    pub hostname: String,
    pub target: String,
}

#[derive(Clone)]
struct ArtifactState {
    config: ArtifactConfig,
    host: Arc<Host>,
    prefix: String,
    port: u16,
}

async fn proxy(State(state): State<ArtifactState>, request: Request) -> Result<Response, Error> {
    let authority = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if authority != state.config.hostname && authority != format!("127.0.0.1:{}", state.port) {
        return Err((StatusCode::FORBIDDEN, "Invalid artifact host"));
    }
    let path = format!(
        "{}{}",
        state.prefix,
        request.uri().path_and_query().map_or("/", |v| v.as_str())
    );
    // This separate listener never logs in, forwards browser cookies, or exposes terminal routes.
    let response = tokio::time::timeout(
        Duration::from_secs(30),
        state.host.stream_request(
            request.method().clone(),
            &path,
            Bytes::new(),
            "application/octet-stream",
            None,
        ),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Artifact server timed out"))?
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Artifact server unavailable"))?;
    let mut headers = HeaderMap::new();
    for name in [header::CONTENT_TYPE, header::CONTENT_DISPOSITION] {
        if let Some(value) = response.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }
    if let Some(location) = response
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
    {
        let rewritten = location
            .strip_prefix(state.config.target.trim_end_matches('/'))
            .filter(|s| s.starts_with('/') || s.is_empty())
            .unwrap_or(location);
        headers.insert(
            header::LOCATION,
            if rewritten.is_empty() { "/" } else { rewritten }
                .parse()
                .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid artifact redirect"))?,
        );
    }
    headers.insert("content-security-policy","frame-ancestors https://switchboard.localhost http://switchboard.localhost http://127.0.0.1:8090 http://localhost:8090".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    let status = response.status();
    let stream = futures_util::stream::unfold(response.into_body(), |mut body| async move {
        loop {
            match tokio::time::timeout(Duration::from_secs(30), body.frame()).await {
                Ok(Some(Ok(frame))) => {
                    if let Ok(data) = frame.into_data() {
                        return Some((Ok::<_, std::io::Error>(data), body));
                    }
                },
                Ok(None) => return None,
                _ => {
                    return Some((
                        Err(std::io::Error::other("Artifact stream interrupted")),
                        body,
                    ))
                },
            }
        }
    });
    Ok((status, headers, Body::from_stream(stream)).into_response())
}

fn router(config: ArtifactConfig, port: u16) -> anyhow::Result<Router> {
    anyhow::ensure!(
        !config.hostname.is_empty() && !config.hostname.starts_with("switchboard.localhost"),
        "Artifact hostname must have a separate origin"
    );
    let target = url::Url::parse(&config.target)?;
    anyhow::ensure!(
        target.query().is_none() && target.fragment().is_none(),
        "Artifact target cannot include a query or fragment"
    );
    let prefix = target.path().trim_end_matches('/').to_owned();
    let origin = target[..url::Position::BeforePath].to_owned();
    let host = Arc::new(Host::new(HostConfig {
        id: "artifact".into(),
        name: "Artifact".into(),
        url: origin,
        token_file: String::new(),
        tls_fingerprint: None,
        artifact_urls: Value::Null,
        escape_transport: None,
        zellij_binary: None,
    })?);
    Ok(Router::new()
        .fallback(get(proxy))
        .with_state(ArtifactState {
            config,
            host,
            prefix,
            port,
        }))
}

pub(super) async fn start(
    config: Option<ArtifactConfig>,
) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
    let Some(config) = config else {
        return Ok(None);
    };
    let app = router(config, 8091)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8091").await?;
    Ok(Some(tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            log::error!("Artifact relay stopped: {error}");
        }
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn artifacts_stream_large_files_without_terminal_credentials() {
        let upstream = Router::new()
            .route(
                "/large",
                get(|headers: HeaderMap| async move {
                    assert!(headers.get(header::COOKIE).is_none());
                    (
                        [
                            (header::CONTENT_TYPE, "application/octet-stream"),
                            (header::SET_COOKIE, "private=must-not-leak"),
                        ],
                        vec![42u8; LIMIT + 1],
                    )
                }),
            )
            .route(
                "/redirect",
                get(|| async { (StatusCode::FOUND, [(header::LOCATION, "/large")]) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = listener.local_addr().unwrap().port();
        let upstream_task = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = router(
            ArtifactConfig {
                hostname: "artifacts.localhost".into(),
                target: format!("http://127.0.0.1:{upstream_port}"),
            },
            port,
        )
        .unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = Host::new(super::super::tests::config(&format!(
            "http://127.0.0.1:{port}"
        )))
        .unwrap();
        let response = client
            .stream_request(
                Method::GET,
                "/large",
                Bytes::new(),
                "",
                Some("session_token=must-not-forward"),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(body.len(), LIMIT + 1);
        assert!(body.iter().all(|b| *b == 42));
        let response = client
            .raw_request(Method::GET, "/redirect", Bytes::new(), "", None)
            .await
            .unwrap();
        assert_eq!(response.status, StatusCode::FOUND);
        assert_eq!(response.headers[header::LOCATION], "/large");
        assert_eq!(
            client
                .raw_request(Method::GET, "/api/hosts", Bytes::new(), "", None)
                .await
                .unwrap()
                .status,
            StatusCode::NOT_FOUND
        );
        task.abort();
        upstream_task.abort();
    }
}
