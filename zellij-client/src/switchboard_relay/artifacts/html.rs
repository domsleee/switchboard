//! Live HTML previews on the artifact origin. A click grants a random URL access to
//! just that page's directory, so scripts and relative assets work without relay access.
use super::*;
use std::time::Instant;

#[derive(Clone)]
struct Preview {
    host: Arc<Host>,
    root: String,
    created: Instant,
}

#[derive(Clone, Default)]
pub(in crate::switchboard_relay) struct Previews(Arc<Mutex<HashMap<String, Preview>>>);

pub(in crate::switchboard_relay) async fn open(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    headers: HeaderMap,
    Json(file): Json<FilePath>,
) -> Result<Response, Error> {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin" && v != "none")
    {
        return Err((StatusCode::FORBIDDEN, "Untrusted HTML request"));
    }
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    let (root, name) = file
        .path
        .rsplit_once(['/', '\\'])
        .filter(|(_, name)| !name.is_empty())
        .ok_or((StatusCode::BAD_REQUEST, "Use an absolute HTML path"))?;
    if !name
        .rsplit_once('.')
        .is_some_and(|(_, ext)| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
    {
        return Err((StatusCode::BAD_REQUEST, "Not an HTML file"));
    }
    // Keep the trailing separator: /page.html and C:\page.html have root parents.
    let root = format!(
        "{root}{}",
        if file.path.contains('\\') { '\\' } else { '/' }
    );
    let query = ScopedFile {
        root: root.clone(),
        path: name.to_owned(),
    };
    let response = read_from(&host, &query, HeaderMap::new()).await?;
    if response.status() != StatusCode::OK {
        return Ok(response);
    }
    use mesh_rand::RngCore;
    let mut bytes = [0u8; 32];
    mesh_rand::rng().fill_bytes(&mut bytes);
    let ticket: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let mut previews = state.html_previews.0.lock().await;
    previews.retain(|_, p| p.created.elapsed() < Duration::from_secs(24 * 3600));
    if previews.len() >= 256 {
        return Err((StatusCode::TOO_MANY_REQUESTS, "Too many HTML previews open"));
    }
    previews.insert(
        ticket.clone(),
        Preview {
            host,
            root,
            created: Instant::now(),
        },
    );
    Ok(Json(json!({"url": format!("https://127.0.0.1:{PORT}/html/{ticket}/{}", urlencoding::encode(name))})).into_response())
}

#[derive(Deserialize)]
pub(in crate::switchboard_relay) struct ScopedFile {
    pub root: String,
    pub path: String,
}

/// Check containment on the computer owning the disk, including symlinks/junctions.
pub(in crate::switchboard_relay) async fn local(
    query: &ScopedFile,
    range: Option<&HeaderValue>,
) -> Response {
    let target = (|| {
        let root = control::expand_path(&query.root).ok()?;
        if !root.is_absolute() {
            return None;
        }
        let root = root.canonicalize().ok()?;
        let target = root.join(relative(&query.path)?).canonicalize().ok()?;
        (target.starts_with(&root) && target.is_file()).then_some(target)
    })();
    match target {
        Some(target) => send(&target, range, "HTML asset not found").await,
        None => (StatusCode::NOT_FOUND, "HTML asset not found").into_response(),
    }
}

async fn read_from(host: &Host, query: &ScopedFile, range: HeaderMap) -> Result<Response, Error> {
    if host.is_local_engine() {
        return Ok(local(query, range.get(header::RANGE)).await);
    }
    let path = format!(
        "/switchboard/html-file?root={}&path={}",
        urlencoding::encode(&query.root),
        urlencoding::encode(&query.path)
    );
    remote(host, Method::GET, &path, range).await
}

pub(in crate::switchboard_relay) async fn serve(
    State(state): State<RelayState>,
    RoutePath((ticket, path)): RoutePath<(String, String)>,
    request: Request,
) -> Result<Response, Error> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok());
    if !host.is_some_and(|h| h == format!("127.0.0.1:{PORT}") || h == format!("localhost:{PORT}")) {
        return Err((StatusCode::FORBIDDEN, "Untrusted HTML host"));
    }
    let preview = state
        .html_previews
        .0
        .lock()
        .await
        .get(&ticket)
        .cloned()
        .filter(|p| p.created.elapsed() < Duration::from_secs(24 * 3600))
        .ok_or((
            StatusCode::NOT_FOUND,
            "HTML preview expired; open it again from the terminal",
        ))?;
    relative(&path).ok_or((StatusCode::NOT_FOUND, "HTML asset not found"))?;
    let query = ScopedFile {
        root: preview.root,
        path,
    };
    let mut response = read_from(&preview.host, &query, range_header(request.headers())).await?;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, FRAME.parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    #[tokio::test]
    async fn switchboard_html_assets_from_a_peer_keep_the_directory_boundary_and_byte_ranges() {
        let temp = super::super::tests::fixture();
        let gateway = Router::new().route(
            "/switchboard/html-file",
            get(
                |Query(query): Query<ScopedFile>, headers: HeaderMap| async move {
                    local(&query, headers.get(header::RANGE)).await
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = crate::switchboard_relay::tests::config(&format!(
            "http://{}",
            listener.local_addr().unwrap()
        ));
        config.id = format!("mesh-{}", "ab".repeat(32));
        let host = Host::new(config).unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
        let query = ScopedFile {
            root: temp
                .path()
                .join("artifacts/clip")
                .to_string_lossy()
                .into_owned(),
            path: "clip.mp4".into(),
        };
        let (status, headers, body) = super::super::tests::read(
            read_from(
                &host,
                &query,
                [(header::RANGE, "bytes=2-5".parse().unwrap())]
                    .into_iter()
                    .collect(),
            )
            .await
            .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 2-5/100");
        assert_eq!(&body[..], &[2, 3, 4, 5]);
        let outside = ScopedFile {
            path: "../other/secret.txt".into(),
            ..query
        };
        assert_eq!(
            read_from(&host, &outside, HeaderMap::new())
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        server.abort();
    }

    #[tokio::test]
    async fn switchboard_html_previews_keep_scripts_and_assets_on_an_isolated_origin() {
        let temp = super::super::tests::fixture();
        let root = temp.path().join("artifacts/clip");
        let mut config = crate::switchboard_relay::tests::config("http://127.0.0.1:8082");
        config.escape_transport = Some("local".into());
        let state = crate::switchboard_relay::state(
            &RelayConfig {
                hosts: vec![config.clone()],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        let relay = Router::new()
            .route("/api/hosts/{host}/html", post(open))
            .with_state(state.clone());
        let req = |site| {
            Request::builder()
                .method("POST")
                .uri(format!("/api/hosts/{}/html", config.id))
                .header("content-type", "application/json")
                .header("sec-fetch-site", site)
                .body(Body::from(
                    json!({"path": root.join("page.html")}).to_string(),
                ))
                .unwrap()
        };
        assert_eq!(
            relay
                .clone()
                .oneshot(req("same-site"))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let (status, _, body) =
            super::super::tests::read(relay.oneshot(req("same-origin")).await.unwrap()).await;
        assert_eq!(status, StatusCode::OK);
        let url = url::Url::parse(
            serde_json::from_slice::<Value>(&body).unwrap()["url"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(url.port(), Some(PORT));
        let app = app(None, state).unwrap();
        let get = |path: String| {
            let app = app.clone();
            async move {
                super::super::tests::read(
                    app.oneshot(
                        Request::builder()
                            .uri(path)
                            .header("host", "127.0.0.1:8091")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap(),
                )
                .await
            }
        };
        let (status, headers, body) = get(url.path().to_owned()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(&body[..], b"<script>1</script>");
        assert!(!headers[header::CONTENT_SECURITY_POLICY]
            .to_str()
            .unwrap()
            .contains("sandbox"));
        assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
        let base = url.path().trim_end_matches("page.html");
        let (status, _, body) = get(format!("{base}clip.mp4")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.len(), 100);
        for path in [
            "../other/secret.txt",
            "images/../../other/secret.txt",
            "C:/Windows/win.ini",
            "images\\..\\secret.txt",
        ] {
            assert_eq!(
                get(format!("{base}{path}")).await.0,
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("outside.txt"), root.join("escape.txt"))
                .unwrap();
            assert_eq!(
                get(format!("{base}escape.txt")).await.0,
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(get("/api/hosts".into()).await.0, StatusCode::NOT_FOUND);
        assert_eq!(
            get("/html/unknown/page.html".into()).await.0,
            StatusCode::NOT_FOUND
        );
    }
}
