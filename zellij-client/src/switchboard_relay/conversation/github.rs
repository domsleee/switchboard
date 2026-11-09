//! Resolve references using the checkout and credentials on the conversation's computer.
use super::*;
use std::sync::LazyLock;
use tokio::time::Instant;

// The same TLS validation and bounded HTTP pool as the relay transport. This
// client never follows redirects, so GitHub credentials cannot leave this origin.
static API: tokio::sync::OnceCell<Host> = tokio::sync::OnceCell::const_new();
static TOKEN: LazyLock<Mutex<Option<(Instant, String)>>> = LazyLock::new(Default::default);
const ACCESS_ERROR: Error = (
    StatusCode::BAD_GATEWAY,
    "Cannot read GitHub. Check repository access and gh login on this computer.",
);
const QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{title body state url author{login}} ... on PullRequest{title body state url isDraft additions deletions changedFiles baseRefName headRefName reviewDecision mergeStateStatus author{login}}}}}";

async fn api() -> Result<&'static Host, Error> {
    API.get_or_try_init(|| async {
        Host::new(HostConfig {
            id: "github-api".into(),
            name: "GitHub API".into(),
            url: "https://api.github.com".into(),
            token_file: String::new(),
            gateway_token_file: None,
            tls_fingerprint: None,
            artifact_urls: Value::Null,
            escape_transport: None,
            zellij_binary: None,
            hostname: None,
            address: None,
        })
        .map_err(|_| ACCESS_ERROR)
    })
    .await
}

async fn token() -> Result<String, Error> {
    // Coalesce credential discovery too: hovering several links must not start
    // several CLI processes. gh handles environment tokens and the OS keychain.
    let mut cached = TOKEN.lock().await;
    if let Some((at, token)) = cached.as_ref() {
        if at.elapsed() < Duration::from_secs(300) {
            return Ok(token.clone());
        }
    }
    *cached = None;
    let bytes = output(
        tokio::process::Command::new("gh")
            .env("GH_DEBUG", "")
            .args(["auth", "token", "--hostname", "github.com"]),
    )
    .await?;
    let token = String::from_utf8(bytes).map_err(|_| ACCESS_ERROR)?;
    let token = token.trim().to_owned();
    if token.is_empty() {
        return Err(ACCESS_ERROR);
    }
    *cached = Some((Instant::now(), token.clone()));
    Ok(token)
}

async fn graphql(api: &Host, token: &str, query: Value) -> Result<Value, Error> {
    let read = async {
        let mut sender = api.connection(true).await?;
        let mut headers = HeaderMap::new();
        let mut authorization = header::HeaderValue::from_str(&format!("Bearer {token}"))?;
        authorization.set_sensitive(true);
        headers.insert(header::AUTHORIZATION, authorization);
        headers.insert(
            header::USER_AGENT,
            header::HeaderValue::from_static("Switchboard"),
        );
        let response = api
            .send_request_with(
                &mut sender,
                Method::POST,
                "/graphql",
                serde_json::to_vec(&query)?.into(),
                "application/json",
                None,
                headers,
            )
            .await?;
        let status = response.status();
        let body = to_bytes(Body::new(response.into_body()), LIMIT).await?;
        if sender.ready().await.is_ok() {
            let mut idle = api.idle_http.lock().await;
            if idle.len() < 8 {
                idle.push(sender);
            }
        }
        anyhow::Ok((status, body))
    };
    let (status, body) = tokio::time::timeout(Duration::from_secs(12), read)
        .await
        .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "GitHub request timed out"))?
        .map_err(|_| ACCESS_ERROR)?;
    if status == StatusCode::UNAUTHORIZED {
        let mut cached = TOKEN.lock().await;
        if cached.as_ref().is_some_and(|(_, value)| value == token) {
            *cached = None;
        }
    }
    if !status.is_success() {
        return Err(ACCESS_ERROR);
    }
    let data: Value = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid GitHub response"))?;
    if data.get("errors").is_some() {
        return Err(ACCESS_ERROR);
    }
    Ok(data)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    cwd: Option<String>,
    repo: Option<String>,
    number: Option<u32>,
}

pub(crate) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(request): Json<Request>,
) -> Result<Response, Error> {
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = host
            .request(
                Method::POST,
                "/switchboard/conversation/github",
                serde_json::to_vec(&request).unwrap().into(),
                "application/json",
            )
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot reach the other computer"))?;
        return Ok((
            response.status,
            [(header::CONTENT_TYPE, "application/json")],
            response.body,
        )
            .into_response());
    }
    local(&host, request).await.map(IntoResponse::into_response)
}

fn repository(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote.strip_prefix("https://github.com/"))?;
    let repo = path.trim_end_matches('/').trim_end_matches(".git");
    valid_repo(repo).then(|| repo.to_owned())
}

fn valid_repo(repo: &str) -> bool {
    let parts: Vec<_> = repo.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
}

async fn output(command: &mut tokio::process::Command) -> Result<Vec<u8>, Error> {
    command
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let result = tokio::time::timeout(Duration::from_secs(12), command.output())
        .await
        .map_err(|_| (StatusCode::GATEWAY_TIMEOUT, "GitHub request timed out"))?
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Git or GitHub CLI unavailable on this computer",
            )
        })?;
    if !result.status.success() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "Cannot read GitHub. Check repository access and gh login on this computer.",
        ));
    }
    Ok(result.stdout)
}

pub(crate) async fn local(host: &Host, request: Request) -> Result<Json<Value>, Error> {
    control::require_writable_host(host).await?;
    if let Some(repo) = request.repo {
        if !valid_repo(&repo) || !matches!(request.number, Some(1..=2147483647)) {
            return Err((StatusCode::BAD_REQUEST, "Invalid GitHub reference"));
        }
        let (owner, name) = repo.split_once('/').unwrap();
        // Direct HTTPS reads reuse connections and credentials; gh is only used
        // to discover the local credential, never spawned for individual reads.
        let data = graphql(
            api().await?,
            &token().await?,
            json!({"query": QUERY, "variables": {"owner": owner, "name": name, "number": request.number}}),
        )
        .await?;
        let item = &data["data"]["repository"]["issueOrPullRequest"];
        if !item.is_object() {
            return Err((StatusCode::NOT_FOUND, "GitHub reference unavailable"));
        }
        let mut item = item.clone();
        item["markdown"] = json!(chats::markdown_events(item["body"].as_str().unwrap_or("")));
        return Ok(Json(item));
    }
    let cwd = skills_dir(request.cwd.as_deref().unwrap_or(""))?
        .ok_or((StatusCode::BAD_REQUEST, "Project directory required"))?;
    let bytes = output(
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(["config", "--get", "remote.origin.url"]),
    )
    .await?;
    Ok(Json(
        json!({"repo": repository(&String::from_utf8_lossy(&bytes))}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires gh login and SWITCHBOARD_GITHUB_BENCH_REPO / SWITCHBOARD_GITHUB_BENCH_NUMBER; reads the real API"]
    async fn switchboard_github_live_benchmark() {
        let repo = std::env::var("SWITCHBOARD_GITHUB_BENCH_REPO").unwrap();
        let number: u32 = std::env::var("SWITCHBOARD_GITHUB_BENCH_NUMBER")
            .unwrap()
            .parse()
            .unwrap();
        let (owner, name) = repo.split_once('/').unwrap();
        for mode in ["cli", "native"] {
            for sample in 0..3 {
                let start = Instant::now();
                let data = if mode == "cli" {
                    let bytes = output(tokio::process::Command::new("gh").args([
                        "api",
                        "--hostname",
                        "github.com",
                        "graphql",
                        "-f",
                        &format!("query={QUERY}"),
                        "-f",
                        &format!("owner={owner}"),
                        "-f",
                        &format!("name={name}"),
                        "-F",
                        &format!("number={number}"),
                    ]))
                    .await
                    .unwrap();
                    serde_json::from_slice::<Value>(&bytes).unwrap()
                } else {
                    graphql(api().await.unwrap(), &token().await.unwrap(), json!({"query":QUERY,"variables":{"owner":owner,"name":name,"number":number}})).await.unwrap()
                };
                assert!(data["data"]["repository"]["issueOrPullRequest"].is_object());
                println!("{mode} sample {sample}: {} ms", start.elapsed().as_millis());
            }
        }
    }

    #[tokio::test]
    async fn switchboard_github_reuses_http_and_rejects_api_errors() {
        use axum::extract::ConnectInfo;
        let connections = Arc::new(Mutex::new(Vec::new()));
        let seen = connections.clone();
        let router = Router::new().route(
            "/graphql",
            post(
                move |ConnectInfo(address): ConnectInfo<SocketAddr>,
                      headers: HeaderMap,
                      Json(body): Json<Value>| {
                    let seen = seen.clone();
                    async move {
                        assert_eq!(headers[header::AUTHORIZATION], "Bearer fixture-token");
                        assert_eq!(headers[header::USER_AGENT], "Switchboard");
                        seen.lock().await.push(address);
                        match body["query"].as_str().unwrap() {
                            "denied" => (StatusCode::UNAUTHORIZED, Json(json!({}))),
                            "error" => (
                                StatusCode::OK,
                                Json(json!({"errors":[{"message":"denied"}]})),
                            ),
                            "redirect" => (StatusCode::TEMPORARY_REDIRECT, Json(json!({}))),
                            _ => (StatusCode::OK, Json(json!({"data":{"ok":true}}))),
                        }
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let api = Host::new(HostConfig {
            url: format!("http://{address}"),
            ..api().await.unwrap().config.clone()
        })
        .unwrap();
        for _ in 0..2 {
            assert_eq!(
                graphql(&api, "fixture-token", json!({"query":"ok"}))
                    .await
                    .unwrap()["data"]["ok"],
                true
            );
            assert_eq!(api.idle_http.lock().await.len(), 1);
        }
        let addresses = connections.lock().await;
        assert_eq!(addresses.len(), 2);
        assert_eq!(
            addresses[0], addresses[1],
            "reads reuse the same TCP connection"
        );
        drop(addresses);
        *TOKEN.lock().await = Some((Instant::now(), "fixture-token".into()));
        let (first, second) = tokio::join!(token(), token());
        assert_eq!(first.unwrap(), "fixture-token");
        assert_eq!(second.unwrap(), "fixture-token");
        for query in ["denied", "error", "redirect"] {
            assert!(graphql(&api, "fixture-token", json!({"query":query}))
                .await
                .is_err());
        }
        assert!(
            TOKEN.lock().await.is_none(),
            "a rejected credential is discarded"
        );
        server.abort();
    }
    #[test]
    fn switchboard_github_remotes_and_untrusted_references() {
        for remote in [
            "git@github.com:example/project.git",
            "https://github.com/example/project",
            "ssh://git@github.com/example/project.git",
        ] {
            assert_eq!(repository(remote).as_deref(), Some("example/project"));
        }
        for remote in [
            "https://github.com.evil/example/project",
            "https://token@github.com/example/project",
            "git@gitlab.com:example/project",
            "https://github.com/a/b/c",
        ] {
            assert_eq!(repository(remote), None);
        }
        for repo in [
            "../project",
            "example/..",
            "-f",
            "example/project?x",
            "a/b/c",
        ] {
            assert!(!valid_repo(repo));
        }
    }
}
