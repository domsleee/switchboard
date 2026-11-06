use super::*;
use axum::{extract::Query, http::HeaderValue};
use http_body_util::BodyExt;
pub(super) mod html;
pub(super) mod named;

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
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin" && v != "none")
        && request
            .headers()
            .get("sec-fetch-mode")
            .is_none_or(|v| v != "navigate")
    {
        return Err((StatusCode::FORBIDDEN, "Untrusted artifact request"));
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
        header::ETAG,
        header::LAST_MODIFIED,
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
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    let status = response.status();
    Ok((status, headers, stream(response.into_body())).into_response())
}

fn range_header(headers: &HeaderMap) -> HeaderMap {
    [header::RANGE, header::IF_RANGE]
        .into_iter()
        .filter_map(|name| headers.get(&name).map(|value| (name, value.clone())))
        .collect()
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
    router_with_pin(config, port, None)
}

fn router_with_pin(
    config: ArtifactConfig,
    port: u16,
    pin: Option<String>,
) -> anyhow::Result<Router> {
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
        tls_fingerprint: pin,
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
        .route("/html/{ticket}/{*path}", get(html::serve))
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
    match relative(path).and_then(|relative| resolve(root, relative)) {
        Some(target) => send(&target, range, "Artifact not found").await,
        None => (StatusCode::NOT_FOUND, "Artifact not found").into_response(),
    }
}

/// Any regular file this account can read, by absolute or `~/` path, for the file viewer.
pub(super) async fn serve_path(path: &str, range: Option<&HeaderValue>) -> Response {
    let Some(expanded) = control::expand_path(path)
        .ok()
        .filter(|path| path.is_absolute())
    else {
        return (StatusCode::NOT_FOUND, "File not found").into_response();
    };
    let expanded = if expanded.exists() || !path.contains('\\') {
        expanded
    } else {
        restore_dropped_separators(&expanded).unwrap_or(expanded)
    };
    match expanded.canonicalize() {
        Ok(target) if target.is_file() => send(&target, range, "File not found").await,
        Ok(target) if target.is_dir() => folder_page(&expanded).await,
        _ => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

/// Markdown drops a backslash before punctuation, so an agent's `C:\Users\dom\.config\a.png`
/// reaches the screen as `C:\Users\dom.config\a.png`. Puts back the separators the disk shows.
fn restore_dropped_separators(path: &Path) -> Option<std::path::PathBuf> {
    fn walk(dir: std::path::PathBuf, rest: &[String]) -> Option<std::path::PathBuf> {
        let Some((name, rest)) = rest.split_first() else {
            return Some(dir);
        };
        let whole = dir.join(name);
        if whole.exists() {
            if let Some(found) = walk(whole, rest) {
                return Some(found);
            }
        }
        // Each split must land on a real folder, so the search stays small.
        name.char_indices()
            .skip(1)
            .filter(|(_, c)| c.is_ascii_punctuation())
            .find_map(|(i, _)| {
                let folder = dir.join(&name[..i]);
                folder.is_dir().then(|| {
                    let tail = [vec![name[i..].to_string()], rest.to_vec()].concat();
                    walk(folder, &tail)
                })?
            })
    }
    let mut root = std::path::PathBuf::new();
    let mut names = Vec::new();
    for part in path.components() {
        match part {
            std::path::Component::Normal(name) => names.push(name.to_str()?.to_string()),
            _ if names.is_empty() => root.push(part),
            _ => return None,
        }
    }
    walk(root, &names)
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A link to another path in the file viewer, relative to the viewer's own URL, so it
/// stays on whichever computer's file route showed this page.
fn viewer_href(path: &str) -> String {
    format!("?path={}", urlencoding::encode(path))
}

/// Folders listed per page; the rest are counted.
const FOLDER_ENTRIES: usize = 2000;

/// A folder's contents for the file viewer: folders first, each entry opening in place.
async fn folder_page(folder: &Path) -> Response {
    let Ok(mut reader) = tokio::fs::read_dir(folder).await else {
        return (StatusCode::FORBIDDEN, "Cannot read that folder").into_response();
    };
    let mut entries = Vec::new();
    while let Ok(Some(entry)) = reader.next_entry().await {
        let folder =
            entry.file_type().await.is_ok_and(|kind| kind.is_dir()) || entry.path().is_dir();
        entries.push((!folder, entry.file_name().to_string_lossy().into_owned()));
    }
    entries.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase()))
    });
    let shown = folder.to_string_lossy();
    let mut rows = String::new();
    if let Some(parent) = folder.parent() {
        rows += &format!(
            r#"<li><a href="{}">..</a></li>"#,
            escape_html(&viewer_href(&parent.to_string_lossy()))
        );
    }
    for (file, name) in entries.iter().take(FOLDER_ENTRIES) {
        let href = viewer_href(&folder.join(name).to_string_lossy());
        let slash = if *file { "" } else { "/" };
        rows += &format!(
            r#"<li><a href="{}">{}{slash}</a></li>"#,
            escape_html(&href),
            escape_html(name)
        );
    }
    if entries.len() > FOLDER_ENTRIES {
        rows += &format!("<li>… {} more</li>", entries.len() - FOLDER_ENTRIES);
    }
    let title = escape_html(&shown);
    let page = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>
:root{{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--link:#0969da}}
@media (prefers-color-scheme:dark){{:root{{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--link:#4493f8}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}}
main{{max-width:60rem;margin:0 auto;padding:.75rem 1rem 4rem}}h1{{font-size:1rem;color:var(--muted);font-weight:normal;word-break:break-all}}
ul{{list-style:none;padding:0}}a{{color:var(--link);text-decoration:none}}a:hover{{text-decoration:underline}}
</style></head><body><main><h1>{title}</h1><ul>{rows}</ul></main></body></html>"#
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response()
}

#[derive(Deserialize)]
pub(super) struct SessionPath {
    session: String,
    path: String,
}

/// A path printed relative to one of a session's panes, as `{"path": absolute}`.
/// The browser cannot tell which pane printed it, so the directories of focused panes
/// are tried first and the first that holds the file wins.
pub(super) async fn resolve_local(host: &Host, query: &SessionPath) -> Response {
    // Drive-relative (C:x) and rooted paths already go to the file route as they are.
    let relative = !query.path.is_empty()
        && !query.path.starts_with(['/', '\\', '~'])
        && !query.path.contains(':')
        && Path::new(&query.path).is_relative();
    if control::validate_session(&query.session).is_err() || !relative {
        return (StatusCode::BAD_REQUEST, "Not a relative path").into_response();
    }
    let Ok(panes) = control::list_panes(host, &query.session, true, Duration::from_secs(5)).await
    else {
        return (StatusCode::BAD_GATEWAY, "Cannot list panes").into_response();
    };
    match find_in_panes(&panes, &query.path) {
        Some(path) => Json(json!({ "path": path })).into_response(),
        None => (StatusCode::NOT_FOUND, "File not found").into_response(),
    }
}

/// `path` under the first pane directory that holds it as a regular file, focused panes first.
fn find_in_panes(panes: &[Value], path: &str) -> Option<String> {
    let mut dirs: Vec<&str> = Vec::new();
    for focused in [true, false] {
        for pane in panes {
            if pane["is_plugin"] == true || (pane["is_focused"] == true) != focused {
                continue;
            }
            match pane["pane_cwd"].as_str() {
                Some(dir) if !dirs.contains(&dir) => dirs.push(dir),
                _ => {},
            }
        }
    }
    // Joined rather than canonicalized, which on Windows would add a \\?\ prefix.
    dirs.into_iter()
        .map(|dir| Path::new(dir).join(path))
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().into_owned())
}

/// `GET /api/hosts/{host}/resolve-file?session=&path=`: see [`resolve_local`].
pub(super) async fn resolve_file(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Query(query): Query<SessionPath>,
    request: Request,
) -> Result<Response, Error> {
    same_origin(&request)?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.is_local_engine() {
        return Ok(resolve_local(&host, &query).await);
    }
    let path = format!(
        "/switchboard/resolve-file?session={}&path={}",
        urlencoding::encode(&query.session),
        urlencoding::encode(&query.path)
    );
    remote(&host, Method::GET, &path, HeaderMap::new()).await
}

// Sibling origins, such as published artifact pages on 127.0.0.1:8091, are same-site.
fn same_origin(request: &Request) -> Result<(), Error> {
    if request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|site| site != "same-origin" && site != "none")
    {
        return Err((StatusCode::FORBIDDEN, "Untrusted file request"));
    }
    Ok(())
}

async fn send(target: &Path, range: Option<&HeaderValue>, missing: &'static str) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, missing).into_response();
    let Ok(mut file) = tokio::fs::File::open(target).await else {
        return not_found();
    };
    let Ok(len) = file.metadata().await.map(|m| m.len()) else {
        return not_found();
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, content_type(target).parse().unwrap());
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
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        host.stream_request(method, path, Bytes::new(), "", None, range),
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
        let path: Vec<_> = path.split('/').map(urlencoding::encode).collect();
        let path = format!("/switchboard/artifacts/{}", path.join("/"));
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
            markdown_page(name, &String::from_utf8_lossy(&source), "?raw", &|url| {
                url.to_owned()
            }),
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

#[derive(Deserialize)]
pub(super) struct FilePath {
    path: String,
}

/// `GET /api/hosts/{host}/file?path=`: a file from that computer's disk for the in-page viewer.
pub(super) async fn file(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Query(file): Query<FilePath>,
    request: Request,
) -> Result<Response, Error> {
    same_origin(&request)?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    let markdown = is_markdown(&file.path)
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
        serve_path(&file.path, range.get(header::RANGE)).await
    } else {
        let path = format!(
            "/switchboard/files?path={}",
            urlencoding::encode(&file.path)
        );
        let method = if markdown {
            Method::GET
        } else {
            request.method().clone()
        };
        remote(&host, method, &path, range).await?
    };
    if markdown && response.status() == StatusCode::OK {
        let source = to_bytes(std::mem::take(response.body_mut()), MARKDOWN_LIMIT)
            .await
            .map_err(|_| {
                (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Markdown too large to render; add &raw",
                )
            })?;
        // The file's computer may use either separator, whatever this one uses.
        let split = file.path.rfind(['/', '\\']).map_or(0, |i| i + 1);
        let (folder, name) = file.path.split_at(split);
        let raw = format!("{}&raw", viewer_href(&file.path));
        response = (
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            markdown_page(name, &String::from_utf8_lossy(&source), &raw, &|url| {
                let (target, fragment) = url.split_once('#').map_or((url, ""), |(t, f)| (t, f));
                let target =
                    urlencoding::decode(target).map_or(target.to_owned(), |t| t.into_owned());
                let joined = if target.starts_with(['/', '\\']) || target.contains(':') {
                    target
                } else {
                    format!("{folder}{target}")
                };
                let fragment = if fragment.is_empty() {
                    String::new()
                } else {
                    format!("#{fragment}")
                };
                format!("{}{fragment}", viewer_href(&joined))
            }),
        )
            .into_response();
    }
    // The relay's origin holds terminal access, so a viewed page never runs scripts. Media,
    // PDF and plain text run none, and Chrome will not play or render them in a sandbox.
    let kind = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let inert = ["video/", "audio/", "application/pdf", "text/plain"]
        .iter()
        .any(|prefix| kind.starts_with(prefix))
        || kind.starts_with("image/") && !kind.contains("svg");
    if !inert {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, "sandbox".parse().unwrap());
    }
    Ok(response)
}

fn is_markdown(path: &str) -> bool {
    Path::new(path)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
}

/// Markdown without raw HTML or script links, in a small reading template.
// ponytail: no heading anchors or Mermaid yet; a mermaid fence shows as code.
/// `raw` links to the source, and `relative` rewrites links and images relative to it.
fn markdown_page(name: &str, source: &str, raw: &str, relative: &dyn Fn(&str) -> String) -> String {
    use pulldown_cmark::{CowStr, Event, Options, Parser, Tag};
    fn safe<'a>(url: CowStr<'a>, relative: &dyn Fn(&str) -> String) -> CowStr<'a> {
        match url::Url::parse(&url) {
            Ok(absolute) if !matches!(absolute.scheme(), "http" | "https" | "mailto") => "#".into(),
            Ok(_) => url,
            Err(url::ParseError::RelativeUrlWithoutBase) if url.starts_with('#') => url,
            Err(url::ParseError::RelativeUrlWithoutBase) => relative(&url).into(),
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
            dest_url: safe(dest_url, relative),
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
            dest_url: safe(dest_url, relative),
            title,
            id,
        }),
        event => event,
    });
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, events);
    let title = escape_html(name);
    let raw = escape_html(raw);
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>
:root{{color-scheme:dark;--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#3d444d;--code:#151b23;--link:#4493f8}}
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
</style></head><body><nav><span>{title}</span><a href="{raw}">Raw</a></nav><main>{body}</main></body></html>"#
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

    pub(super) async fn read(response: Response) -> (StatusCode, HeaderMap, Bytes) {
        let (parts, body) = response.into_parts();
        let body = to_bytes(body, LIMIT).await.unwrap();
        (parts.status, parts.headers, body)
    }

    pub(super) fn fixture() -> tempfile::TempDir {
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
            "?raw",
            &|url| url.to_owned(),
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
    async fn paired_computer_files_stream_into_a_sandboxed_viewer() {
        use tower::ServiceExt;
        let temp = fixture();
        // Stands in for the peer's gateway branch, which calls serve_path the same way.
        let gateway = Router::new().route(
            "/switchboard/files",
            get(
                |Query(file): Query<FilePath>, headers: HeaderMap| async move {
                    serve_path(&file.path, headers.get(header::RANGE)).await
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut peer =
            super::super::tests::config(&format!("http://{}", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
        peer.id = format!("mesh-{}", "ab".repeat(32));
        let mut relay = super::super::state(
            &RelayConfig {
                browser_origin: None,
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        relay.order = Arc::new(vec![peer.id.clone()]);
        relay.hosts =
            Arc::new([(peer.id.clone(), Arc::new(Host::new(peer.clone()).unwrap()))].into());
        let app = Router::new()
            .route("/api/hosts/{host}/file", get(file))
            .with_state(relay);
        let send = |path: &str, headers: &[(&str, &str)]| {
            let uri = format!(
                "/api/hosts/{}/file?path={}",
                peer.id,
                urlencoding::encode(path)
            );
            let mut request = Request::builder().uri(uri);
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let request = request.body(Body::empty()).unwrap();
            let app = app.clone();
            async move { read(app.oneshot(request).await.unwrap()).await }
        };

        let clip = temp.path().join("artifacts/clip/clip.mp4");
        let clip = clip.to_str().unwrap();
        let (status, headers, body) = send(clip, &[("range", "bytes=2-5")]).await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[header::CONTENT_TYPE], "video/mp4");
        assert!(headers.get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(&body[..], &[2, 3, 4, 5]);
        let page = temp.path().join("artifacts/clip/page.html");
        let (status, headers, _) = send(page.to_str().unwrap(), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");

        // Only absolute paths; the terminal's working directory is unknown.
        for path in ["artifacts/clip/clip.mp4", "/no/such/file"] {
            let (status, _, _) = send(path, &[]).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
        }
        // A folder lists its contents, folders first, each opening in the same viewer.
        let folder = temp.path().join("artifacts/clip");
        let (status, headers, body) = send(folder.to_str().unwrap(), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");
        let listing = String::from_utf8_lossy(&body);
        let href = |path: &Path| format!("?path={}", urlencoding::encode(path.to_str().unwrap()));
        let images = listing.find(">images/<").unwrap();
        assert!(images < listing.find(">clip.mp4<").unwrap(), "{listing}");
        assert!(
            listing.contains(&href(&folder.join("notes.md"))),
            "{listing}"
        );
        assert!(
            listing.contains(&href(&temp.path().join("artifacts"))),
            "parent: {listing}"
        );
        // Markdown renders, with relative links kept on this computer's file route.
        let notes = folder.join("notes.md");
        let (status, headers, body) = send(notes.to_str().unwrap(), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");
        let page = String::from_utf8_lossy(&body);
        assert!(
            page.contains("<table>") && !page.contains("<script>alert"),
            "{page}"
        );
        assert!(page.contains(&href(&folder.join("other.md"))), "{page}");
        assert!(page.contains(&href(&folder.join("images/a.png"))), "{page}");
        assert!(
            page.contains(&format!("{}&amp;raw", href(&notes))),
            "{page}"
        );
        // Published artifact pages share the relay's site but not its origin.
        let (status, _, _) = send(clip, &[("sec-fetch-site", "same-site")]).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = send(clip, &[("sec-fetch-site", "same-origin")]).await;
        assert_eq!(status, StatusCode::OK);
        server.abort();
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
                browser_origin: None,
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

    #[test]
    fn paths_find_separators_that_markdown_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let shot = temp.path().join("Dominic.Slee/.cwinspector/.a/shot.png");
        std::fs::create_dir_all(shot.parent().unwrap()).unwrap();
        std::fs::write(&shot, "png").unwrap();
        let restore = |seen: &str| restore_dropped_separators(&temp.path().join(seen));
        assert_eq!(
            restore("Dominic.Slee.cwinspector/.a/shot.png"),
            Some(shot.clone())
        );
        assert_eq!(
            restore("Dominic.Slee.cwinspector.a/shot.png"),
            Some(shot.clone())
        );
        assert_eq!(restore("Dominic.Slee/.cwinspector/.a/shot.png"), Some(shot));
        assert_eq!(restore("Dominic.Slee.cwinspector/missing.png"), None);
    }

    #[test]
    fn relative_paths_resolve_in_focused_panes_first() {
        let temp = tempfile::tempdir().unwrap();
        let (focused, other) = (temp.path().join("focused"), temp.path().join("other"));
        for dir in [&focused, &other] {
            std::fs::create_dir_all(dir.join("out")).unwrap();
            std::fs::write(dir.join("out/shot.png"), "png").unwrap();
        }
        std::fs::write(other.join("only.png"), "png").unwrap();
        let pane = |dir: &Path, focused: bool| json!({"is_plugin":false,"is_focused":focused,"pane_cwd":dir.to_str().unwrap()});
        let panes = [
            pane(&other, false),
            json!({"is_plugin":true,"is_focused":true}),
            pane(&focused, true),
        ];
        let found = |path| find_in_panes(&panes, path).map(std::path::PathBuf::from);
        assert_eq!(found("out/shot.png"), Some(focused.join("out/shot.png")));
        assert_eq!(found("only.png"), Some(other.join("only.png")));
        // Folders resolve too, and nothing is found without a pane directory.
        assert_eq!(found("out/"), Some(focused.join("out/")));
        assert_eq!(found("missing/"), None);
        assert_eq!(
            find_in_panes(&[json!({"is_focused":true})], "only.png"),
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relative_paths_resolve_through_the_session_pane_list() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("project/out")).unwrap();
        std::fs::write(temp.path().join("project/out/shot.png"), "png").unwrap();
        let cli = temp.path().join("zellij");
        let catalog = json!([{"id":1,"is_plugin":false,"is_focused":true,
            "pane_cwd":temp.path().join("project").to_str().unwrap()}]);
        std::fs::write(
            &cli,
            format!("#!/bin/sh\n[ \"$1 $2 $3 $4\" = \"-s main action list-panes\" ] && echo '{catalog}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = super::super::tests::config("http://127.0.0.1:9");
        config.zellij_binary = Some(cli.to_str().unwrap().into());
        let host = Host::new(config).unwrap();
        let resolve = |session: &str, path: &str| {
            let query = SessionPath {
                session: session.into(),
                path: path.into(),
            };
            let host = &host;
            async move { read(resolve_local(host, &query).await).await }
        };
        let (status, _, body) = resolve("main", "out/shot.png").await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            body["path"],
            temp.path().join("project/out/shot.png").to_str().unwrap()
        );
        assert_eq!(
            resolve("main", "out/none.png").await.0,
            StatusCode::NOT_FOUND
        );
        // Rooted paths take the file route as they are, and sessions are validated.
        for path in ["/etc/shot.png", "~/shot.png", "C:shot.png", ""] {
            assert_eq!(
                resolve("main", path).await.0,
                StatusCode::BAD_REQUEST,
                "{path}"
            );
        }
        assert_eq!(
            resolve("../x", "out/shot.png").await.0,
            StatusCode::BAD_REQUEST
        );
    }
}
