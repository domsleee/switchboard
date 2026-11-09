//! Resolve references using the checkout and credentials on the conversation's computer.
use super::*;

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
        // One authenticated read per click; no CLI polling and no credentials in the browser.
        let query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{title body state url author{login}} ... on PullRequest{title body state url isDraft additions deletions changedFiles baseRefName headRefName reviewDecision mergeStateStatus author{login}}}}}";
        let bytes = output(tokio::process::Command::new("gh").args([
            "api",
            "--hostname",
            "github.com",
            "graphql",
            "-f",
            &format!("query={query}"),
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-F",
            &format!("number={}", request.number.unwrap()),
        ]))
        .await?;
        let data: Value = serde_json::from_slice(&bytes)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid GitHub response"))?;
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
