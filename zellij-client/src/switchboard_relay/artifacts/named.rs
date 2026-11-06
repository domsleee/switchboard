//! Registered read-only app servers, each on its own loopback listener and browser origin.
use super::*;
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
pub(in crate::switchboard_relay) struct Registration {
    id: String,
    target: String,
    listen_port: u16,
    /// Explicit HTTPS origin forwarded to listen_port by a private reverse proxy.
    public_origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tls_fingerprint: Option<String>,
}

struct Running {
    registration: Registration,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct Entries {
    path: Option<PathBuf>,
    running: BTreeMap<String, Running>,
}

#[derive(Default)]
pub(in crate::switchboard_relay) struct Registry(Mutex<Entries>);

fn validate(reg: &Registration, relay: &RelayState) -> anyhow::Result<()> {
    anyhow::ensure!(
        !reg.id.is_empty()
            && reg.id.len() <= 64
            && reg
                .id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "Use a lowercase proxy id containing letters, digits or hyphens"
    );
    anyhow::ensure!(
        reg.listen_port >= 1024
            && ![relay.port, DEFAULT_PORT, PORT, 8082].contains(&reg.listen_port),
        "Use a separate unprivileged proxy port"
    );
    anyhow::ensure!(
        valid_browser_origin(&reg.public_origin),
        "public_origin must be an HTTPS origin"
    );
    let public = url::Url::parse(&reg.public_origin)?;
    anyhow::ensure!(
        relay.browser_origin.as_deref() != Some(&reg.public_origin)
            && !matches!(
                public.host_str(),
                Some("switchboard.localhost" | "localhost" | "127.0.0.1" | "[::1]")
            ),
        "Proxy must have a separate browser origin from terminals"
    );
    let target = url::Url::parse(&reg.target)?;
    anyhow::ensure!(
        matches!(target.scheme(), "http" | "https")
            && target.host_str().is_some()
            && target.username().is_empty()
            && target.password().is_none()
            && target.path() == "/"
            && target.query().is_none()
            && target.fragment().is_none(),
        "Target must be an HTTP(S) origin without credentials or a path"
    );
    anyhow::ensure!(
        target.origin() != public.origin(),
        "Proxy target cannot be its public origin"
    );
    if target
        .host_str()
        .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]"))
    {
        anyhow::ensure!(
            ![relay.port, DEFAULT_PORT, PORT, 8082, reg.listen_port]
                .contains(&target.port_or_known_default().unwrap()),
            "Target cannot be a Switchboard listener"
        );
    }
    Ok(())
}

async fn launch(reg: &Registration) -> anyhow::Result<Running> {
    let authority = reg
        .public_origin
        .strip_prefix("https://")
        .unwrap()
        .to_owned();
    let app = router_with_pin(
        ArtifactConfig {
            hostname: authority,
            target: reg.target.clone(),
        },
        reg.listen_port,
        reg.tls_fingerprint.clone(),
    )?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", reg.listen_port)).await?;
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            logs::record("artifacts", &format!("Artifact proxy stopped: {error}"));
        }
    });
    Ok(Running {
        registration: reg.clone(),
        task,
    })
}

impl Registry {
    pub(in crate::switchboard_relay) async fn restore(&self, path: PathBuf, relay: &RelayState) {
        let mut entries = self.0.lock().await;
        entries.path = Some(path.clone());
        let data = match tokio::fs::read(&path).await {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                logs::record(
                    "artifacts",
                    &format!("Cannot read artifact proxies: {error}"),
                );
                return;
            },
        };
        let registrations: Vec<Registration> = match serde_json::from_slice(&data) {
            Ok(value) => value,
            Err(error) => {
                logs::record(
                    "artifacts",
                    &format!("Cannot parse artifact proxies: {error}"),
                );
                return;
            },
        };
        for reg in registrations {
            let result = async {
                validate(&reg, relay)?;
                check_unique(&entries, &reg)?;
                launch(&reg).await
            }
            .await;
            match result {
                Ok(running) => {
                    entries.running.insert(reg.id.clone(), running);
                },
                Err(error) => logs::record(
                    "artifacts",
                    &format!("Proxy {} unavailable: {error}", reg.id),
                ),
            }
        }
    }

    async fn add(&self, reg: Registration, relay: &RelayState) -> anyhow::Result<()> {
        validate(&reg, relay)?;
        let mut entries = self.0.lock().await;
        if let Some(existing) = entries.running.get(&reg.id) {
            anyhow::ensure!(
                existing.registration == reg,
                "Proxy id already registered with different settings"
            );
            anyhow::ensure!(
                !existing.task.is_finished(),
                "Proxy listener stopped; restart the relay to restore it"
            );
            return Ok(());
        }
        check_unique(&entries, &reg)?;
        let path = entries
            .path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Proxy registry not started"))?;
        // Read the saved list too: an unavailable listener must not silently lose its registration.
        let mut saved: Vec<Registration> = match tokio::fs::read(path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        for old in &saved {
            anyhow::ensure!(
                old == &reg
                    || (old.id != reg.id
                        && old.listen_port != reg.listen_port
                        && old.public_origin != reg.public_origin
                        && old.target != reg.target),
                "Proxy settings conflict with a saved registration"
            );
        }
        let running = launch(&reg).await?;
        if !saved.contains(&reg) {
            saved.push(reg.clone());
        }
        let result = async {
            // Same-directory rename preserves the previous registry if writing fails.
            let temporary = path.with_extension("json.tmp");
            tokio::fs::write(&temporary, serde_json::to_vec_pretty(&saved)?).await?;
            tokio::fs::rename(&temporary, path).await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            running.task.abort();
            return Err(error);
        }
        entries.running.insert(reg.id.clone(), running);
        Ok(())
    }

    pub(in crate::switchboard_relay) async fn links(&self) -> Value {
        let entries = self.0.lock().await;
        Value::Object(
            entries
                .running
                .values()
                .filter(|r| !r.task.is_finished())
                .map(|r| {
                    (
                        r.registration.target.trim_end_matches('/').to_owned(),
                        Value::String(r.registration.public_origin.clone()),
                    )
                })
                .collect(),
        )
    }

    pub(in crate::switchboard_relay) async fn stop(&self) {
        for (_, running) in std::mem::take(&mut self.0.lock().await.running) {
            running.task.abort();
        }
    }
}

fn check_unique(entries: &Entries, reg: &Registration) -> anyhow::Result<()> {
    anyhow::ensure!(
        entries.running.values().all(|r| r.registration.id != reg.id
            && r.registration.listen_port != reg.listen_port
            && r.registration.public_origin != reg.public_origin
            && r.registration.target != reg.target),
        "Proxy id, port, public origin and target must be unique"
    );
    Ok(())
}

pub(in crate::switchboard_relay) async fn list(State(state): State<RelayState>) -> Response {
    let entries = state.artifact_proxies.0.lock().await;
    Json(
        entries
            .running
            .values()
            .map(|r| {
                json!({
                    "id": r.registration.id, "target": r.registration.target,
                    "url": format!("{}/", r.registration.public_origin),
                    "local_url": format!("http://127.0.0.1:{}/", r.registration.listen_port),
                    "running": !r.task.is_finished(),
                })
            })
            .collect::<Vec<_>>(),
    )
    .into_response()
}

pub(in crate::switchboard_relay) async fn register(
    State(state): State<RelayState>,
    request: Request,
) -> Response {
    // Registrations are a local agent operation. A browser cannot make this a general URL proxy.
    if request.headers().contains_key(header::ORIGIN)
        || request.headers().contains_key("sec-fetch-mode")
    {
        return (StatusCode::FORBIDDEN, "Register proxies from a local CLI").into_response();
    }
    if !trusted(request.headers(), state.port) {
        return (
            StatusCode::FORBIDDEN,
            "Register proxies on the loopback relay",
        )
            .into_response();
    }
    let reg: Registration = match to_bytes(request.into_body(), 8192)
        .await
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
    {
        Some(reg) => reg,
        None => return (StatusCode::BAD_REQUEST, "Invalid proxy registration").into_response(),
    };
    match state.artifact_proxies.add(reg.clone(), &state).await {
        Ok(()) => Json(json!({"id": reg.id, "url": format!("{}/", reg.public_origin), "local_url": format!("http://127.0.0.1:{}/", reg.listen_port)})).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    async fn relay() -> RelayState {
        super::super::super::state(
            &RelayConfig {
                browser_origin: Some("https://workstation.example.ts.net".into()),
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap()
    }

    async fn free_port() -> u16 {
        tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn registration(port: u16, target: &str) -> Registration {
        Registration {
            id: "race-control".into(),
            target: target.into(),
            listen_port: port,
            public_origin: format!("https://workstation.example.ts.net:{port}"),
            tls_fingerprint: None,
        }
    }

    #[tokio::test]
    async fn switchboard_named_proxy_streams_root_assets_ranges_and_survives_restart() {
        let upstream = Router::new().fallback(get(|request: Request| async move {
            assert!(!request.headers().contains_key(header::COOKIE));
            assert!(!request.headers().contains_key(header::AUTHORIZATION));
            match request.uri().path() {
                "/" => (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, "text/html")],
                    "<script src='/app.js'></script>",
                )
                    .into_response(),
                "/app.js" => {
                    assert_eq!(request.uri().query(), Some("v=2"));
                    (
                        [
                            (header::CONTENT_TYPE, "text/javascript"),
                            (header::SET_COOKIE, "session=private"),
                        ],
                        "fetch('/data.json')",
                    )
                        .into_response()
                },
                "/clip.mp4" => {
                    assert_eq!(request.headers()[header::RANGE], "bytes=2-5");
                    assert_eq!(request.headers()[header::IF_RANGE], "version-one");
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_RANGE, "bytes 2-5/100"),
                            (header::ACCEPT_RANGES, "bytes"),
                        ],
                        "2345",
                    )
                        .into_response()
                },
                "/redirect" => {
                    (StatusCode::FOUND, [(header::LOCATION, "/app.js?v=2")]).into_response()
                },
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}", listener.local_addr().unwrap());
        let upstream = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let state = relay().await;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("proxies.json");
        state.artifact_proxies.restore(path.clone(), &state).await;
        let reg = registration(free_port().await, &target);
        state
            .artifact_proxies
            .add(reg.clone(), &state)
            .await
            .unwrap();
        // Repeating a registration is idempotent and never needs a relay restart.
        state
            .artifact_proxies
            .add(reg.clone(), &state)
            .await
            .unwrap();
        let client = Host::new(super::super::super::tests::config(&format!(
            "http://127.0.0.1:{}",
            reg.listen_port
        )))
        .unwrap();
        let response = client
            .raw_request(Method::GET, "/", Bytes::new(), "", None)
            .await
            .unwrap();
        assert!(response.body.starts_with(b"<script src='/app.js'"));
        let response = client
            .raw_request(
                Method::GET,
                "/app.js?v=2",
                Bytes::new(),
                "",
                Some("terminal=secret"),
            )
            .await
            .unwrap();
        assert_eq!(response.body, "fetch('/data.json')");
        assert!(!response.headers.contains_key(header::SET_COOKIE));
        assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
        let response = client
            .stream_request(
                Method::GET,
                "/clip.mp4",
                Bytes::new(),
                "",
                None,
                [
                    (header::RANGE, "bytes=2-5".parse().unwrap()),
                    (header::IF_RANGE, "version-one".parse().unwrap()),
                    (header::AUTHORIZATION, "Bearer private".parse().unwrap()),
                ]
                .into_iter()
                .collect(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/100");
        assert_eq!(
            response.into_body().collect().await.unwrap().to_bytes(),
            "2345"
        );
        let response = client
            .raw_request(Method::HEAD, "/app.js?v=2", Bytes::new(), "", None)
            .await
            .unwrap();
        assert_eq!(response.status, StatusCode::OK);
        assert!(response.body.is_empty());
        let response = client
            .raw_request(Method::POST, "/", Bytes::new(), "", None)
            .await
            .unwrap();
        assert_eq!(response.status, StatusCode::METHOD_NOT_ALLOWED);
        let response = client
            .raw_request(Method::GET, "/redirect", Bytes::new(), "", None)
            .await
            .unwrap();
        assert_eq!(response.headers[header::LOCATION], "/app.js?v=2");
        assert_eq!(
            state.artifact_proxies.links().await[&target],
            reg.public_origin
        );
        // A second registration uses its own root, not a path prefix or shared cookie origin.
        let mut second = registration(free_port().await, "http://127.0.0.1:1");
        second.id = "other-app".into();
        state.artifact_proxies.add(second, &state).await.unwrap();
        assert_eq!(state.artifact_proxies.0.lock().await.running.len(), 2);
        // A restarted process drops its connections too. Do not reuse a pooled
        // connection to the old listener when checking the restored proxy.
        drop(client);
        // Abort and await the listeners so their ports are free before restoring.
        for (_, running) in std::mem::take(&mut state.artifact_proxies.0.lock().await.running) {
            running.task.abort();
            let _ = running.task.await;
        }
        state.artifact_proxies.restore(path, &state).await;
        let client = Host::new(super::super::super::tests::config(&format!(
            "http://127.0.0.1:{}",
            reg.listen_port
        )))
        .unwrap();
        assert_eq!(
            state.artifact_proxies.0.lock().await.running.len(),
            2,
            "{}",
            logs::local()
        );
        assert_eq!(
            client
                .raw_request(Method::GET, "/", Bytes::new(), "", None)
                .await
                .unwrap()
                .status,
            StatusCode::OK
        );
        state.artifact_proxies.stop().await;
        upstream.abort();
    }

    #[tokio::test]
    async fn switchboard_proxy_registration_rejects_browser_writes_conflicts_and_terminal_origins()
    {
        let state = relay().await;
        let temp = tempfile::tempdir().unwrap();
        state
            .artifact_proxies
            .restore(temp.path().join("proxies.json"), &state)
            .await;
        let reg = registration(free_port().await, "http://127.0.0.1:8767");
        for public in [
            "http://app.example",
            "https://workstation.example.ts.net",
            "https://app.example/path",
            "https://switchboard.localhost",
            "https://localhost:8443",
        ] {
            let mut bad = reg.clone();
            bad.public_origin = public.into();
            assert!(validate(&bad, &state).is_err(), "{public}");
        }
        for target in [
            "file:///etc/passwd",
            "http://user:password@example.com",
            "http://127.0.0.1:8090",
            "http://127.0.0.1:8091",
            "http://example.test/path",
        ] {
            let mut bad = reg.clone();
            bad.target = target.into();
            assert!(validate(&bad, &state).is_err(), "{target}");
        }
        let app = super::super::super::app(state.clone());
        for headers in [
            vec![
                ("host", "127.0.0.1:8090"),
                ("origin", "http://127.0.0.1:8090"),
            ],
            vec![("host", "127.0.0.1:8090"), ("sec-fetch-mode", "cors")],
            vec![("host", "workstation.example.ts.net")],
        ] {
            let mut req = Request::builder()
                .method("POST")
                .uri("/api/artifact-proxies");
            for (key, value) in headers {
                req = req.header(key, value);
            }
            let response = app
                .clone()
                .oneshot(
                    req.body(Body::from(serde_json::to_vec(&reg).unwrap()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let req = Request::builder()
            .method("POST")
            .uri("/api/artifact-proxies")
            .header("host", "127.0.0.1:8090")
            .body(Body::from(serde_json::to_vec(&reg).unwrap()))
            .unwrap();
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::OK);
        let mut conflict = reg.clone();
        conflict.target = "http://127.0.0.1:8768".into();
        assert!(state.artifact_proxies.add(conflict, &state).await.is_err());
        // Root origin isolation includes same-site GET fetches without an Origin header.
        let headers = [
            (header::HOST, "workstation.example.ts.net".parse().unwrap()),
            (
                header::HeaderName::from_static("sec-fetch-site"),
                "same-site".parse().unwrap(),
            ),
        ]
        .into_iter()
        .collect();
        assert!(!trusted_browser_origin(
            &headers,
            state.browser_origin.as_deref().unwrap()
        ));
        let proxy = router_with_pin(
            ArtifactConfig {
                hostname: reg.public_origin[8..].into(),
                target: reg.target,
            },
            reg.listen_port,
            None,
        )
        .unwrap();
        for headers in [
            vec![("host", "evil.example")],
            vec![
                ("host", reg.public_origin[8..].as_ref()),
                ("sec-fetch-site", "cross-site"),
                ("sec-fetch-mode", "no-cors"),
            ],
        ] {
            let mut req = Request::builder().uri("/");
            for (key, value) in headers {
                req = req.header(key, value);
            }
            assert_eq!(
                proxy
                    .clone()
                    .oneshot(req.body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        state.artifact_proxies.stop().await;
    }
}
