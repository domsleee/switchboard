//! Browser-selected files are stored on the conversation's computer, never executed.
use super::*;
use axum::extract::Query;
use std::{fs, io::Write, path::PathBuf};

pub(super) const FILE_LIMIT: usize = 20 * 1024 * 1024;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upload {
    name: String,
}

fn filename(name: &str) -> Option<String> {
    if name.is_empty() || name.len() > 512 || name.chars().any(char::is_control) {
        return None;
    }
    let name = name.rsplit(['/', '\\']).next()?;
    let safe: String = name
        .chars()
        .take(120)
        .map(|c| {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = safe.trim_matches('.');
    (!safe.is_empty()).then(|| safe.to_owned())
}

pub(super) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    request: Request,
) -> Result<Response, Error> {
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.is_local_engine() {
        return local(request).await;
    }
    if host.config.escape_transport.as_deref() != Some("gateway") {
        return Err((StatusCode::BAD_REQUEST, "Computer is not paired"));
    }
    forward(&host, request).await
}

async fn forward(host: &Host, request: Request) -> Result<Response, Error> {
    let query = request.uri().query().unwrap_or("").to_owned();
    let bytes = to_bytes(request.into_body(), FILE_LIMIT)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                "Files must be 20 MB or smaller",
            )
        })?;
    let response = tokio::time::timeout(
        Duration::from_secs(60),
        host.request(
            Method::POST,
            &format!("/switchboard/attachments?{query}"),
            bytes,
            "application/octet-stream",
        ),
    )
    .await
    .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "Attachment upload timed out"))?
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot upload to this computer"))?;
    Ok((
        response.status,
        [(header::CONTENT_TYPE, "application/json")],
        response.body,
    )
        .into_response())
}

pub(super) async fn local(request: Request) -> Result<Response, Error> {
    let Query(query) = Query::<Upload>::try_from_uri(request.uri())
        .map_err(|_| (StatusCode::BAD_REQUEST, "Missing filename"))?;
    let name = filename(&query.name).ok_or((StatusCode::BAD_REQUEST, "Invalid filename"))?;
    let bytes = to_bytes(request.into_body(), FILE_LIMIT)
        .await
        .map_err(|_| {
            (
                StatusCode::PAYLOAD_TOO_LARGE,
                "Files must be 20 MB or smaller",
            )
        })?;
    if bytes.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "The file is empty"));
    }
    let root = std::env::home_dir()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "Account home unavailable"))?
        .join(".local/share/switchboard/attachments");
    let path = tokio::task::spawn_blocking(move || save(&root, &name, &bytes))
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not store attachment",
            )
        })?
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not store attachment",
            )
        })?;
    Ok(Json(json!({"path":path.to_string_lossy()})).into_response())
}

fn save(root: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    fs::create_dir_all(root)?;
    // Remove only our UUID directories after a week; never traverse symlinks.
    for entry in fs::read_dir(root)?.flatten() {
        if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {
            continue;
        }
        let expired = entry.file_type().is_ok_and(|kind| kind.is_dir())
            && entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > Duration::from_secs(7 * 86400));
        if expired {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
    let directory = root.join(uuid::Uuid::new_v4().to_string());
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory)?;
    let path = directory.join(name);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path)?.write_all(bytes)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_attachments_stay_in_private_unique_directories() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(filename("../../photo.jpg"), Some("photo.jpg".into()));
        assert_eq!(
            filename("C:\\fakepath\\my photo.png"),
            Some("my_photo.png".into())
        );
        assert_eq!(filename(".."), None);
        assert_eq!(filename("bad\nname"), None);
        let one = save(dir.path(), "photo.jpg", b"image one").unwrap();
        let two = save(dir.path(), "photo.jpg", b"image two").unwrap();
        assert_ne!(one, two);
        assert_eq!(fs::read(&one).unwrap(), b"image one");
        assert_eq!(one.parent().unwrap().parent().unwrap(), dir.path());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&one).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[tokio::test]
    async fn switchboard_attachments_reject_empty_and_invalid_requests() {
        for uri in [
            "/switchboard/attachments",
            "/switchboard/attachments?name=..",
            "/switchboard/attachments?name=photo.png",
        ] {
            let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
            assert_eq!(local(req).await.unwrap_err().0, StatusCode::BAD_REQUEST);
        }
    }
    #[tokio::test]
    async fn switchboard_attachments_uploads_require_same_origin_and_a_known_host() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        for (origin, expected) in [
            ("https://other.example", StatusCode::FORBIDDEN),
            ("http://127.0.0.1:8090", StatusCode::NOT_FOUND),
        ] {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/api/hosts/missing/attachments?name=photo.png")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::from("image"))
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                expected
            );
        }
        let oversized = Request::builder()
            .uri("/switchboard/attachments?name=photo.png")
            .body(Body::from(vec![0; FILE_LIMIT + 1]))
            .unwrap();
        assert_eq!(
            local(oversized).await.unwrap_err().0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }
    #[tokio::test]
    async fn switchboard_attachments_forward_bytes_to_the_selected_computer() {
        let app = Router::new().route(
            "/switchboard/attachments",
            post(|request: Request| async {
                assert_eq!(request.uri().query(), Some("name=photo%20one.png"));
                assert_eq!(
                    to_bytes(request.into_body(), FILE_LIMIT).await.unwrap(),
                    "image bytes"
                );
                Json(json!({"path":"/peer/uploads/photo_one.png"}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let host = Host::new(HostConfig {
            id: "peer".into(),
            name: "Fixture".into(),
            url: format!("http://{address}"),
            token_file: "unused".into(),
            gateway_token_file: None,
            tls_fingerprint: None,
            artifact_urls: Value::Null,
            escape_transport: Some("gateway".into()),
            zellij_binary: None,
            hostname: None,
            address: None,
        })
        .unwrap();
        *host.cookie.lock().await = Some("session_token=fixture".into());
        let request = Request::builder()
            .uri("/api/hosts/peer/attachments?name=photo%20one.png")
            .body(Body::from("image bytes"))
            .unwrap();
        let response = forward(&host, request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["path"], "/peer/uploads/photo_one.png");
        server.abort();
    }
}
