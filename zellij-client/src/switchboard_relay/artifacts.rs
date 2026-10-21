use super::*;
use axum::http::HeaderValue;
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
            range_header(request.headers()),
        ),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Artifact server timed out"))?
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Artifact server unavailable"))?;
    let mut headers = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_DISPOSITION,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
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
    Ok((status, headers, stream(response.into_body())).into_response())
}

fn range_header(headers: &HeaderMap) -> HeaderMap {
    headers
        .get(header::RANGE)
        .map(|range| [(header::RANGE, range.clone())].into_iter().collect())
        .unwrap_or_default()
}

/// Stream an upstream body; a stalled upstream fails the download instead of hanging it.
fn stream(body: hyper::body::Incoming) -> Body {
    Body::from_stream(futures_util::stream::unfold(body, |mut body| async move {
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
    }))
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
        gateway_token_file: None,
        id: "artifact".into(),
        name: "Artifact".into(),
        url: origin,
        token_file: String::new(),
        tls_fingerprint: None,
        artifact_urls: Value::Null,
        escape_transport: None,
        zellij_binary: None,
        hostname: None,
        address: None,
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

fn app(config: Option<ArtifactConfig>, relay: RelayState) -> anyhow::Result<Router> {
    let files = Router::new()
        .route("/artifacts/{machine}/{*path}", get(serve))
        .with_state(relay);
    Ok(match config {
        Some(config) => files.merge(router(config, PORT)?),
        None => files,
    })
}

/// The artifact listener: published files, plus the legacy gallery proxy when configured.
pub(super) async fn start(
    config: Option<ArtifactConfig>,
    relay: RelayState,
) -> anyhow::Result<Option<tokio::task::JoinHandle<()>>> {
    let app = app(config, relay)?;
    // Terminals keep working if another program already holds the artifact port.
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", PORT)).await {
        Ok(listener) => listener,
        Err(error) => {
            logs::record(
                "artifacts",
                &format!("Artifact listener unavailable: {error}"),
            );
            return Ok(None);
        },
    };
    Ok(Some(tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            log::error!("Artifact relay stopped: {error}");
        }
    })))
}

// Files under ~/.switchboard/artifacts/, readable from every paired computer at
// http://127.0.0.1:8091/artifacts/<computer>/<artifact>/<file>. The separate port keeps
// artifact pages, including their scripts, on an origin the terminal relay rejects.
// Peers read through the paired gateway, with the same credential as terminals.

const PORT: u16 = 8091;
const MARKDOWN_LIMIT: usize = 4 * 1024 * 1024;
const FRAME: &str = "frame-ancestors 'self' https://switchboard.localhost http://switchboard.localhost http://127.0.0.1:8090 http://localhost:8090";
/// Rendered Markdown never runs scripts.
const DOCUMENT: &str = "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox";

pub(crate) fn root() -> anyhow::Result<std::path::PathBuf> {
    control::expand_path("~/.switchboard/artifacts")
}

/// Plain relative names only: no root, drive, `..`, backslash or alternate stream.
fn relative(path: &str) -> Option<&Path> {
    let relative = Path::new(path);
    (!path.is_empty()
        && !path.contains(['\\', ':', '\0'])
        && relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_))))
    .then_some(relative)
}

/// A regular file whose real path, after symlinks and junctions, stays in its artifact directory.
fn resolve(root: &Path, relative: &Path) -> Option<std::path::PathBuf> {
    let root = root.canonicalize().ok()?;
    let base = root
        .join(relative.components().next()?)
        .canonicalize()
        .ok()?;
    let target = root.join(relative).canonicalize().ok()?;
    (base.starts_with(&root) && target.starts_with(&base) && target.is_file()).then_some(target)
}

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "md" | "markdown" | "txt" | "log" => "text/plain; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

/// One `bytes=` range as a half-open span; `Err` means 416. Anything else gets the whole file.
fn byte_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.strip_prefix("bytes=")) else {
        return Ok(None);
    };
    // ponytail: multi-range requests get the whole file (RFC 9110 allows it); browsers seek with one range.
    let Some((start, end)) = spec.trim().split_once('-').filter(|_| !spec.contains(',')) else {
        return Ok(None);
    };
    let range = match (start.parse::<u64>(), end.parse::<u64>()) {
        (Ok(start), Ok(end)) if start <= end => (start, end.saturating_add(1).min(len)),
        (Ok(start), Err(_)) if end.is_empty() => (start, len),
        (Err(_), Ok(suffix)) if start.is_empty() => (len.saturating_sub(suffix), len),
        _ => return Ok(None),
    };
    if range.0 < range.1 {
        Ok(Some(range))
    } else {
        Err(())
    }
}

pub(super) async fn serve_file(root: &Path, path: &str, range: Option<&HeaderValue>) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, "Artifact not found").into_response();
    let Some(target) = relative(path).and_then(|relative| resolve(root, relative)) else {
        return not_found();
    };
    let Ok(mut file) = tokio::fs::File::open(&target).await else {
        return not_found();
    };
    let Ok(len) = file.metadata().await.map(|m| m.len()) else {
        return not_found();
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type(&target).parse().unwrap());
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    let (status, start, end) = match byte_range(range.and_then(|r| r.to_str().ok()), len) {
        Ok(None) => (StatusCode::OK, 0, len),
        Ok(Some((start, end))) => {
            let value = format!("bytes {start}-{}/{len}", end - 1);
            headers.insert(header::CONTENT_RANGE, value.parse().unwrap());
            (StatusCode::PARTIAL_CONTENT, start, end)
        },
        Err(()) => {
            let value = format!("bytes */{len}");
            headers.insert(header::CONTENT_RANGE, value.parse().unwrap());
            return (StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response();
        },
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return not_found();
    }
    headers.insert(header::CONTENT_LENGTH, (end - start).into());
    let body = tokio_util::io::ReaderStream::new(file.take(end - start));
    (status, headers, Body::from_stream(body)).into_response()
}

/// This computer under its host ID or name, or its paired (mesh) name; else a peer.
async fn computer(state: &RelayState, name: &str) -> Option<Arc<Host>> {
    let hosts = state.all_hosts();
    if let Some(host) = state.host(name).or_else(|| {
        hosts
            .iter()
            .find(|h| h.config.name.eq_ignore_ascii_case(name))
            .cloned()
    }) {
        return Some(host);
    }
    let local = state.mesh.as_ref()?.computer_name().await?;
    local
        .eq_ignore_ascii_case(name)
        .then(|| hosts.into_iter().find(|h| h.is_local_engine()))
        .flatten()
}

async fn remote(
    host: &Host,
    method: Method,
    path: &str,
    range: HeaderMap,
) -> Result<Response, Error> {
    let path: Vec<_> = path.split('/').map(urlencoding::encode).collect();
    let path = format!("/switchboard/artifacts/{}", path.join("/"));
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        host.stream_request(method, &path, Bytes::new(), "", None, range),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Computer timed out"))?
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Computer unavailable"))?;
    let mut headers = HeaderMap::new();
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(value) = response.headers().get(&name) {
            headers.insert(name, value.clone());
        }
    }
    Ok((response.status(), headers, stream(response.into_body())).into_response())
}

pub(super) async fn serve(
    State(state): State<RelayState>,
    RoutePath((name, path)): RoutePath<(String, String)>,
    request: Request,
) -> Result<Response, Error> {
    let headers = request.headers();
    // Loopback names only (no DNS rebinding); other sites may open a file but not embed or read it.
    let text = |name| {
        headers
            .get(name)
            .and_then(|v: &HeaderValue| v.to_str().ok())
    };
    if !text(header::HOST).is_some_and(|host| {
        host == format!("127.0.0.1:{PORT}") || host == format!("localhost:{PORT}")
    }) || text(header::HeaderName::from_static("sec-fetch-site")) == Some("cross-site")
        && text(header::HeaderName::from_static("sec-fetch-mode")) != Some("navigate")
    {
        return Err((StatusCode::FORBIDDEN, "Untrusted artifact request"));
    }
    let host = computer(&state, &name)
        .await
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    relative(&path).ok_or((StatusCode::NOT_FOUND, "Artifact not found"))?;
    let markdown = Path::new(&path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        && !request
            .uri()
            .query()
            .is_some_and(|q| q.split('&').any(|p| p == "raw"));
    let range = if markdown {
        HeaderMap::new()
    } else {
        range_header(request.headers())
    };
    let mut response = if host.is_local_engine() {
        let root = root().map_err(|_| (StatusCode::NOT_FOUND, "Artifact not found"))?;
        serve_file(&root, &path, range.get(header::RANGE)).await
    } else {
        let method = if markdown {
            Method::GET
        } else {
            request.method().clone()
        };
        remote(&host, method, &path, range).await?
    };
    let mut csp = FRAME.to_owned();
    if markdown && response.status() == StatusCode::OK {
        let source = to_bytes(std::mem::take(response.body_mut()), MARKDOWN_LIMIT)
            .await
            .map_err(|_| {
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Markdown too large to render; add ?raw",
                )
            })?;
        let name = path.rsplit('/').next().unwrap_or(&path);
        response = (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            markdown_page(name, &String::from_utf8_lossy(&source)),
        )
            .into_response();
        csp = format!("{DOCUMENT}; {FRAME}");
    }
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, csp.parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    // Republishing keeps the URL, so revalidate instead of reusing a stale copy.
    headers.insert(header::CACHE_CONTROL, "no-cache".parse().unwrap());
    Ok(response)
}

/// Markdown without raw HTML or script links, in a small reading template.
// ponytail: no heading anchors or Mermaid yet; a mermaid fence shows as code.
fn markdown_page(name: &str, source: &str) -> String {
    use pulldown_cmark::{CowStr, Event, Options, Parser, Tag};
    fn safe(url: CowStr<'_>) -> CowStr<'_> {
        match url::Url::parse(&url) {
            Ok(absolute) if !matches!(absolute.scheme(), "http" | "https" | "mailto") => "#".into(),
            Ok(_) | Err(url::ParseError::RelativeUrlWithoutBase) => url,
            Err(_) => "#".into(),
        }
    }
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES;
    let events = Parser::new_ext(source, options).map(|event| match event {
        Event::Html(html) | Event::InlineHtml(html) => Event::Text(html),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: safe(dest_url),
            title,
            id,
        }),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: safe(dest_url),
            title,
            id,
        }),
        event => event,
    });
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, events);
    let title = name
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>
:root{{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--code:#f6f8fa;--link:#0969da}}
@media (prefers-color-scheme:dark){{:root{{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--code:#151b23;--link:#4493f8}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}}
nav,main{{max-width:52rem;margin:0 auto;padding:0 1rem}}
nav{{padding-top:.75rem;color:var(--muted);font-size:.85rem;display:flex;justify-content:space-between}}
main{{padding-bottom:4rem}}a{{color:var(--link)}}nav a{{color:inherit}}
h1,h2{{border-bottom:1px solid var(--line);padding-bottom:.3em}}
code,pre{{font:.875em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);border-radius:6px}}
code{{padding:.15em .35em}}pre{{padding:1rem;overflow:auto}}pre code{{padding:0;background:none}}
table{{border-collapse:collapse;display:block;overflow:auto}}th,td{{border:1px solid var(--line);padding:.35rem .75rem}}
blockquote{{margin:0;padding:0 1em;color:var(--muted);border-left:.25em solid var(--line)}}
img,video{{max-width:100%}}li input{{margin-right:.4em}}
</style></head><body><nav><span>{title}</span><a href="?raw">Raw</a></nav><main>{body}</main></body></html>"#
    )
}

/// `zellij switchboard artifact`: copy files into ~/.switchboard/artifacts/<id>/ and print
/// the URL. Later files keep their paths relative to the first file's directory.
pub(crate) fn publish(
    files: &[std::path::PathBuf],
    id: Option<&str>,
    relay: &str,
) -> anyhow::Result<()> {
    use anyhow::Context;
    let first = files
        .first()
        .context("Name a file to publish")?
        .canonicalize()
        .context("Cannot read the file to publish")?;
    let base = first.parent().context("Cannot publish a root directory")?;
    let id = id.map(str::to_owned).unwrap_or_else(|| {
        let stem = first.file_stem().unwrap_or_default().to_string_lossy();
        stem.chars()
            .map(|c| match c {
                'a'..='z' | '0'..='9' | '-' | '_' => c,
                'A'..='Z' => c.to_ascii_lowercase(),
                _ => '-',
            })
            .collect()
    });
    anyhow::ensure!(
        !id.starts_with('.') && relative(&id).is_some_and(|p| p.components().count() == 1),
        "Use an artifact ID without slashes, for example --id my-report"
    );
    let directory = root()?.join(&id);
    let mut sources = Vec::new();
    for file in files {
        let source = file
            .canonicalize()
            .with_context(|| format!("Cannot read {}", file.display()))?;
        anyhow::ensure!(source.is_file(), "{} is not a file", file.display());
        let path = source
            .strip_prefix(base)
            .with_context(|| {
                format!(
                    "{} must be inside {}, the first file's directory",
                    file.display(),
                    base.display()
                )
            })?
            .to_owned();
        sources.push((source, path));
    }
    let mut paths = Vec::new();
    for (source, path) in sources {
        let target = directory.join(&path);
        std::fs::create_dir_all(target.parent().unwrap())?;
        // Copy beside the target, then rename, so a viewer never reads half a file.
        let partial = target.with_extension("switchboard-partial");
        std::fs::copy(&source, &partial)?;
        std::fs::rename(&partial, &target)?;
        paths.push(path.to_string_lossy().replace('\\', "/"));
    }
    let computer = local_name(relay).with_context(|| {
        format!(
            "Published to {}, but the Switchboard relay did not answer, so the URL is unknown",
            directory.display()
        )
    })?;
    let file: Vec<_> = paths[0].split('/').map(urlencoding::encode).collect();
    println!(
        "http://127.0.0.1:{PORT}/artifacts/{}/{}/{}",
        urlencoding::encode(&computer),
        urlencoding::encode(&id),
        file.join("/")
    );
    Ok(())
}

/// The name paired computers know this one by, or the local host ID when unpaired.
fn local_name(relay: &str) -> anyhow::Result<String> {
    use isahc::config::Configurable;
    let get = |path: &str| -> anyhow::Result<Value> {
        let request = isahc::Request::get(format!("{}{path}", relay.trim_end_matches('/')))
            .timeout(Duration::from_secs(5))
            .body(())?;
        Ok(serde_json::from_reader(isahc::send(request)?.into_body())?)
    };
    if let Some(name) = get("/api/mesh")
        .ok()
        .and_then(|mesh| mesh["computer"]["name"].as_str().map(str::to_owned))
    {
        return Ok(name);
    }
    get("/api/hosts")?
        .as_array()
        .and_then(|hosts| hosts.iter().find(|h| h["local"] == true))
        .and_then(|h| h["id"].as_str().map(str::to_owned))
        .ok_or_else(|| anyhow::anyhow!("No local computer"))
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
                HeaderMap::new(),
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

    async fn read(response: Response) -> (StatusCode, HeaderMap, Bytes) {
        let (parts, body) = response.into_parts();
        let body = to_bytes(body, LIMIT).await.unwrap();
        (parts.status, parts.headers, body)
    }

    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("artifacts");
        std::fs::create_dir_all(root.join("clip/images")).unwrap();
        std::fs::create_dir_all(root.join("other")).unwrap();
        std::fs::write(root.join("clip/clip.mp4"), (0u8..100).collect::<Vec<_>>()).unwrap();
        std::fs::write(root.join("clip/page.html"), "<script>1</script>").unwrap();
        std::fs::write(
            root.join("clip/notes.md"),
            "# Notes\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [next](other.md)\n\n![shot](images/a.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        )
        .unwrap();
        std::fs::write(root.join("other/secret.txt"), "other artifact").unwrap();
        std::fs::write(temp.path().join("outside.txt"), "outside").unwrap();
        temp
    }

    #[test]
    fn artifact_ranges_follow_rfc_9110() {
        assert_eq!(byte_range(None, 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Ok(Some((10, 20))));
        assert_eq!(byte_range(Some("bytes=90-"), 100), Ok(Some((90, 100))));
        assert_eq!(byte_range(Some("bytes=95-500"), 100), Ok(Some((95, 100))));
        assert_eq!(byte_range(Some("bytes=-5"), 100), Ok(Some((95, 100))));
        assert_eq!(byte_range(Some("bytes=-500"), 100), Ok(Some((0, 100))));
        assert_eq!(byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=-0"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=0-"), 0), Err(()));
        // Invalid or multi-range requests get the whole file.
        assert_eq!(byte_range(Some("bytes=5-3"), 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-1,5-6"), 100), Ok(None));
        assert_eq!(byte_range(Some("items=0-1"), 100), Ok(None));
    }

    #[tokio::test]
    async fn artifact_files_stay_inside_their_artifact_directory() {
        let temp = fixture();
        let root = temp.path().join("artifacts");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("other/secret.txt"), root.join("clip/peer.txt"))
                .unwrap();
            std::os::unix::fs::symlink(temp.path().join("outside.txt"), root.join("clip/out.txt"))
                .unwrap();
            std::os::unix::fs::symlink(temp.path(), root.join("linked")).unwrap();
            std::fs::write(root.join("clip/real.txt"), "inside").unwrap();
            std::os::unix::fs::symlink(root.join("clip/real.txt"), root.join("clip/alias.txt"))
                .unwrap();
            let (status, _, body) = read(serve_file(&root, "clip/alias.txt", None).await).await;
            assert_eq!((status, &body[..]), (StatusCode::OK, &b"inside"[..]));
        }
        for path in [
            "",
            "clip",
            "clip/",
            "../outside.txt",
            "clip/../other/secret.txt",
            "/etc/passwd",
            "clip\\..\\other\\secret.txt",
            "C:/Windows/win.ini",
            "clip/clip.mp4:stream",
            "clip/missing.png",
            "clip/peer.txt",
            "clip/out.txt",
            "linked/outside.txt",
        ] {
            let (status, _, _) = read(serve_file(&root, path, None).await).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
        let (status, headers, body) = read(serve_file(&root, "clip/clip.mp4", None).await).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(headers[header::ACCEPT_RANGES], "bytes");
        assert_eq!(body.len(), 100);
        let range: HeaderValue = "bytes=10-19".parse().unwrap();
        let (status, headers, body) =
            read(serve_file(&root, "clip/clip.mp4", Some(&range)).await).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(headers[header::CONTENT_LENGTH], "10");
        assert_eq!(&body[..], &(10u8..20).collect::<Vec<_>>()[..]);
        let range: HeaderValue = "bytes=100-".parse().unwrap();
        let (status, headers, body) =
            read(serve_file(&root, "clip/clip.mp4", Some(&range)).await).await;
        assert_eq!(status, StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(headers[header::CONTENT_RANGE], "bytes */100");
        assert!(body.is_empty());
    }

    #[test]
    fn artifact_content_types_follow_the_extension() {
        for (name, expected) in [
            ("a.html", "text/html; charset=utf-8"),
            ("a.PNG", "image/png"),
            ("a.mp4", "video/mp4"),
            ("a.pdf", "application/pdf"),
            ("a.md", "text/plain; charset=utf-8"),
            ("a.svg", "image/svg+xml"),
            ("a", "application/octet-stream"),
        ] {
            assert_eq!(content_type(Path::new(name)), expected);
        }
    }

    #[test]
    fn markdown_renders_without_raw_html_or_script_links() {
        let page = markdown_page(
            "<notes>.md",
            "# Notes\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[a](javascript:alert(1)) [b](java\tscript:alert(1)) [c](data:text/html,x) [d](other.md) [e](https://example.com/x) [f](#notes)\n\n![shot](images/a.png)\n\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        );
        assert!(!page.contains("<script>alert"));
        assert!(!page.contains("<img src=x"));
        assert!(page.contains("&lt;script&gt;"));
        assert!(!page.contains("javascript:") && !page.contains("data:text"));
        assert!(!page.contains("<notes>"));
        for expected in [
            "<h1>Notes</h1>",
            r#"href="other.md""#,
            r#"href="https://example.com/x""#,
            r##"href="#notes""##,
            r#"src="images/a.png""#,
            "<table>",
            "checkbox",
            r#"href="?raw""#,
        ] {
            assert!(page.contains(expected), "{expected}");
        }
    }

    #[tokio::test]
    async fn paired_computer_artifacts_stream_through_its_gateway_on_their_own_origin() {
        use tower::ServiceExt;
        let temp = fixture();
        let root = temp.path().join("artifacts");
        // Stands in for the peer's gateway branch, which calls serve_file the same way.
        let gateway = Router::new().route(
            "/switchboard/artifacts/{*path}",
            get(
                move |RoutePath(path): RoutePath<String>, headers: HeaderMap| async move {
                    assert!(headers.get(header::COOKIE).is_none());
                    serve_file(&root, &path, headers.get(header::RANGE)).await
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut peer =
            super::super::tests::config(&format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
        peer.id = format!("mesh-{}", "ab".repeat(32));
        peer.name = "1WN9PD4".into();
        let mut relay = super::super::state(
            &RelayConfig {
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        relay.order = Arc::new(vec![peer.id.clone()]);
        relay.hosts = Arc::new([(peer.id.clone(), Arc::new(Host::new(peer).unwrap()))].into());
        let app = app(None, relay).unwrap();
        let send = |method: Method, path: &str, headers: &[(&str, &str)]| {
            let mut request = Request::builder().method(method).uri(path);
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let mut request = request.body(Body::empty()).unwrap();
            if !request.headers().contains_key(header::HOST) {
                let host = "127.0.0.1:8091".parse().unwrap();
                request.headers_mut().insert(header::HOST, host);
            }
            let app = app.clone();
            async move { read(app.oneshot(request).await.unwrap()).await }
        };

        let (status, headers, body) = send(
            Method::GET,
            "/artifacts/1wn9pd4/clip/clip.mp4",
            &[("range", "bytes=2-5")],
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 2-5/100");
        assert_eq!(headers[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], FRAME);
        assert_eq!(&body[..], &[2, 3, 4, 5]);

        let (status, headers, body) =
            send(Method::HEAD, "/artifacts/1WN9PD4/clip/clip.mp4", &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_LENGTH], "100");
        assert!(body.is_empty());

        let (status, headers, body) =
            send(Method::GET, "/artifacts/1WN9PD4/clip/notes.md", &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            format!("{DOCUMENT}; {FRAME}").as_str()
        );
        assert!(String::from_utf8_lossy(&body).contains("<h1>Notes</h1>"));
        let (_, headers, body) =
            send(Method::GET, "/artifacts/1WN9PD4/clip/notes.md?raw", &[]).await;
        assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
        assert!(body.starts_with(b"# Notes"));

        for path in [
            "/artifacts/1WN9PD4/clip/%2e%2e/other/secret.txt",
            "/artifacts/1WN9PD4/..%2fother/secret.txt",
            "/artifacts/1WN9PD4/clip",
            "/artifacts/unknown/clip/clip.mp4",
        ] {
            let (status, _, _) = send(Method::GET, path, &[]).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }

        // Other sites may open a file in a tab, but not embed or fetch it; rebound names fail.
        let cross = ("sec-fetch-site", "cross-site");
        let file = "/artifacts/1WN9PD4/clip/page.html";
        let (status, _, _) =
            send(Method::GET, file, &[cross, ("sec-fetch-mode", "navigate")]).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = send(Method::GET, file, &[cross, ("sec-fetch-mode", "no-cors")]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = send(Method::GET, file, &[("host", "attacker.example:8091")]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // Scripts in an artifact page cannot drive the terminal relay from this origin.
        let mut page = HeaderMap::new();
        page.insert(header::HOST, "127.0.0.1:8090".parse().unwrap());
        page.insert(header::ORIGIN, "http://127.0.0.1:8091".parse().unwrap());
        assert!(!super::super::trusted(&page, 8090));
        server.abort();
    }
}
