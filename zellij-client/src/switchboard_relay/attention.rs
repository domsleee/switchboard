use super::*;
use std::sync::LazyLock;
use std::{collections::BTreeMap, path::PathBuf};

fn tail(text: &str, count: usize) -> &str {
    text.char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map_or(text, |(index, _)| &text[index..])
}

pub(super) fn classify(pane: &Value, screen: &str) -> Value {
    static CODEX: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\bcodex(?:\.(?:cmd|exe))?\b").unwrap());
    static CODEX_TITLE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^codex\s*[-:]").unwrap());
    static GPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"gpt-[\w.-]+").unwrap());
    static CODEX_FOOTER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"for shortcuts|enter to send|tab to queue message").unwrap()
    });
    static CLAUDE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"\bclaude(?:\.exe)?\b").unwrap());
    static CLAUDE_FOOTER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:bypass permissions|accept edits) on|shift\+tab to cycle").unwrap()
    });
    static PROMPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[›❯](?:[ \t\u{a0}]|\r?\n|$)").unwrap());
    static COMPLETION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:worked for|[✻✽✶✳] [a-z]+ for)\s+(?:\d+\s*[hms]\s*)+(?:[•·]\s*(?:done\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?").unwrap()
    });
    static NUMBER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\s*\d+[.)]").unwrap());
    static CONTROLS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"esc(?:ape)? to cancel|enter to (?:submit|select|confirm)|press enter to confirm",
        )
        .unwrap()
    });
    static OPTIONS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:^|\s)[12][.)]\s+(?:yes|no|allow|approve|deny)").unwrap()
    });
    static QUESTION: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[❯›]\s*\d+[.)]").unwrap());
    static BUSY: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?:^|\n|[•✻✽✶✳])[^\n]{0,70}\([^\n]{0,160}esc(?:ape)? to interrupt[^\n]{0,60}\)",
        )
        .unwrap()
    });
    static SPACE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\s+").unwrap());
    let original = tail(screen, 8000);
    let text = original.to_ascii_lowercase();
    let text = text.as_str();
    let command = pane["pane_command"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    let title = pane["title"].as_str().unwrap_or("").to_ascii_lowercase();
    // ponytail: agent UI markers, replace with public status events if the CLIs expose them.
    let codex = CODEX.is_match(&command)
        || CODEX_TITLE.is_match(&title)
        || GPT.is_match(text) && CODEX_FOOTER.is_match(text);
    let claude = CLAUDE.is_match(&command) || CLAUDE_FOOTER.is_match(text);
    if !codex && !claude {
        return json!({"state":"unknown"});
    }
    let agent = if codex { "codex" } else { "claude" };
    let prompt = PROMPT.find_iter(text).last();
    let (before, after) = prompt.map_or((text, ""), |p| (&text[..p.start()], &text[p.end()..]));
    let completion = COMPLETION.find_iter(before).last();
    let footer = if codex {
        CODEX_FOOTER.is_match(after)
    } else {
        CLAUDE_FOOTER.is_match(after) || after.contains("for shortcuts")
    };
    let normal = prompt.is_some() && footer && !NUMBER.is_match(after);
    if !normal {
        let chooser = tail(text, 1800);
        if CONTROLS.is_match(chooser) && OPTIONS.is_match(chooser) {
            return json!({"state":"approval","agent":agent,"token":"approval"});
        }
        if CONTROLS.is_match(chooser) && QUESTION.is_match(chooser) {
            return json!({"state":"input","agent":agent,"token":"question"});
        }
    }
    let busy = BUSY.find_iter(before).last();
    let spinner = title
        .chars()
        .next()
        .is_some_and(|c| ('\u{2801}'..='\u{28ff}').contains(&c));
    if spinner
        || after.to_lowercase().contains("tab to queue message")
        || busy.is_some_and(|b| completion.is_none_or(|c| b.start() > c.start()))
    {
        return json!({"state":"working","agent":agent});
    }
    if !normal {
        return json!({"state":"unknown","agent":agent});
    }
    let signature = SPACE.replace_all(completion.map_or("idle", |m| &original[m.range()]), " ");
    let token: String = Sha256::digest(signature.trim().as_bytes())[..10]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    json!({"state":"ready","agent":agent,"token":token})
}

fn quiet_shell(pane: &Value) -> bool {
    static SHELL: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?:^|[\\/])(?:nu|zsh|bash|fish|pwsh|powershell)(?:\.exe)?(?:\s|$)")
            .unwrap()
    });
    static PATH_TITLE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^(~|/|[A-Za-z]:[\\/])").unwrap());
    SHELL.is_match(
        &pane["pane_command"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase(),
    ) && PATH_TITLE.is_match(pane["title"].as_str().unwrap_or(""))
}

fn snapshot(name: &str, panes: &[Value], screens: &HashMap<u64, String>, deferred: bool) -> Value {
    let mut tabs: BTreeMap<u64, Value> = BTreeMap::new();
    let mut records = Vec::new();
    for pane in panes {
        let Some(tab_id) = pane["tab_id"].as_u64() else {
            continue;
        };
        let tab = tabs.entry(tab_id).or_insert_with(||json!({"session":name,"id":tab_id,"position":pane["tab_position"],"name":pane["tab_name"],"panes":[]}));
        if pane["is_selectable"] != false && pane["is_suppressed"] != true {
            tab["panes"].as_array_mut().unwrap().push(json!({"pane_id":pane["id"],"is_plugin":pane["is_plugin"],"tab_position":pane["tab_position"],"title":pane["title"].as_str().unwrap_or(""),"is_floating":pane["is_floating"] == true}));
        }
        if pane["is_plugin"] == true || pane["is_selectable"] == false {
            continue;
        }
        let mut status = screens
            .get(&pane["id"].as_u64().unwrap_or(u64::MAX))
            .map_or_else(
                || json!({"state":"unknown","deferred":deferred}),
                |screen| classify(pane, screen),
            );
        status["session"] = json!(name);
        status["pane_id"] = pane["id"].clone();
        status["tab_id"] = json!(tab_id);
        records.push(status);
    }
    let mut tabs: Vec<_> = tabs.into_values().collect();
    tabs.sort_by_key(|tab| tab["position"].as_u64().unwrap_or(0));
    json!({"panes":records,"tabs":tabs,"errors":[]})
}

pub(super) async fn scan(host: &Host, offset: usize) -> anyhow::Result<Value> {
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = tokio::time::timeout(
            Duration::from_secs(20),
            host.request(
                Method::GET,
                &format!("/switchboard/attention?offset={offset}"),
                Bytes::new(),
                "application/json",
            ),
        )
        .await??;
        anyhow::ensure!(
            response.status == StatusCode::OK,
            "Peer attention unavailable"
        );
        let mut snapshot: Value = serde_json::from_slice(&response.body)?;
        anyhow::ensure!(
            snapshot["panes"].is_array()
                && snapshot["tabs"].is_array()
                && snapshot["errors"].is_array(),
            "Invalid peer snapshot"
        );
        for error in snapshot["errors"].as_array_mut().unwrap() {
            error["host"] = json!(host.config.id);
        }
        return Ok(snapshot);
    }
    let mut names = control::sessions(host).await?;
    if !names.is_empty() {
        let count = names.len();
        names.rotate_left(offset % count);
    }
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut deferred_sessions = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    for name in names {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            deferred_sessions.push(name);
            continue;
        }
        let panes = control::run_local(
            host,
            &name,
            &["list-panes", "--json", "--all"],
            remaining.min(Duration::from_secs(2)),
        )
        .await;
        let panes: Vec<Value> = match panes.ok().and_then(|text| serde_json::from_str(&text).ok()) {
            Some(panes) => panes,
            None => {
                errors.push(json!({"host":host.config.id,"session":name,"message":"Session snapshots unavailable"}));
                continue;
            },
        };
        let mut screens = HashMap::new();
        for index in 0..panes.len() {
            let pane = &panes[(index + offset) % panes.len()];
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            if pane["is_plugin"] == true
                || pane["is_selectable"] == false
                || pane["exited"] == true
                || pane["is_held"] == true
                || quiet_shell(pane)
            {
                continue;
            }
            if let Some(id) = pane["id"].as_u64() {
                if let Ok(screen) = control::run_local(
                    host,
                    &name,
                    &["dump-screen", "-p", &id.to_string()],
                    remaining.min(Duration::from_secs(3)),
                )
                .await
                {
                    screens.insert(id, screen);
                }
            }
        }
        results.push(snapshot(
            &name,
            &panes,
            &screens,
            tokio::time::Instant::now() >= deadline,
        ));
    }
    Ok(
        json!({"panes":results.iter().flat_map(|v|v["panes"].as_array().unwrap().clone()).collect::<Vec<_>>(),"tabs":results.iter().flat_map(|v|v["tabs"].as_array().unwrap().clone()).collect::<Vec<_>>(),"errors":errors,"deferred_sessions":deferred_sessions}),
    )
}

#[derive(Default)]
pub(super) struct PollState {
    cache: HashMap<String, Value>,
    observed: HashMap<String, Value>,
    scanned: HashMap<String, tokio::time::Instant>,
    sessions_scanned: HashMap<String, tokio::time::Instant>,
    refreshed: HashMap<String, tokio::time::Instant>,
    dirty: bool,
}

impl PollState {
    fn unavailable(&mut self, host: &str, error: &anyhow::Error) {
        // A failed connection is not an authoritative empty tab catalog.
        self.refreshed
            .insert(host.into(), tokio::time::Instant::now());
        let snapshot = self
            .cache
            .entry(host.into())
            .or_insert_with(|| json!({"panes":[],"tabs":[],"errors":[]}));
        snapshot["panes"] = json!([]);
        snapshot["errors"] =
            json!([{"host":host,"message":format!("Host snapshots unavailable: {error:#}")}]);
    }

    pub(super) fn update(&mut self, host: &str, snapshot: &mut Value) -> bool {
        let now = tokio::time::Instant::now();
        let object = snapshot.as_object_mut().unwrap();
        let deferred = object.remove("deferred_sessions").unwrap_or(json!([]));
        // The owner already applied its generations and acknowledgements.
        let synced = object.remove("synced") == Some(json!(true));
        for tab in snapshot["tabs"].as_array().unwrap() {
            self.sessions_scanned
                .insert(json!([host, tab["session"]]).to_string(), now);
        }
        if let Some(previous) = self.cache.get(host) {
            for name in deferred.as_array().unwrap() {
                let key = json!([host, name]).to_string();
                if !self
                    .sessions_scanned
                    .get(&key)
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
                {
                    continue;
                }
                for field in ["panes", "tabs"] {
                    let reused = previous[field]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|row| row["session"] == *name)
                        .cloned()
                        .map(|mut row| {
                            if field == "panes" {
                                row["deferred"] = json!(true);
                            }
                            row
                        })
                        .collect::<Vec<_>>();
                    snapshot[field].as_array_mut().unwrap().extend(reused);
                }
            }
        }
        let mut changed = false;
        for row in snapshot["panes"].as_array_mut().unwrap() {
            if synced {
                continue;
            }
            let key = json!([host, row["session"], row["pane_id"]]).to_string();
            let previous = self.observed.get(&key).cloned().unwrap_or(Value::Null);
            if row.as_object_mut().unwrap().remove("deferred") == Some(json!(true))
                && self
                    .scanned
                    .get(&key)
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(30))
            {
                for field in ["state", "agent", "token"] {
                    if !previous[field].is_null() {
                        row[field] = previous[field].clone();
                    }
                }
            } else {
                self.scanned
                    .insert(key.clone(), tokio::time::Instant::now());
            }
            let generation = previous["generation"].as_u64().unwrap_or(0)
                + u64::from(row["state"] == "ready" && previous["state"] == "working");
            if row["state"] != "unknown" {
                let mut observed = json!({"state":row["state"],"generation":generation});
                for field in ["agent", "token"] {
                    if !row[field].is_null() {
                        observed[field] = row[field].clone();
                    }
                }
                if let Some(seen) = previous.get("seen") {
                    observed["seen"] = seen.clone();
                }
                changed |= previous != observed;
                self.observed.insert(key, observed);
            }
            if row["state"] == "ready" {
                row["token"] = json!(format!(
                    "{}:{generation}",
                    row["token"].as_str().unwrap_or("idle")
                ));
                row["seen"] = json!(previous["seen"] == row["token"]);
            }
        }
        for field in ["panes", "tabs"] {
            for row in snapshot[field].as_array_mut().unwrap() {
                row["host"] = json!(host);
            }
        }
        self.cache.insert(host.into(), snapshot.clone());
        self.refreshed.insert(host.into(), now);
        changed
    }
    /// Records that a viewer reviewed this exact ready result.
    pub(super) fn acknowledge(&mut self, host: &str, session: &str, pane: u64, token: &str) {
        if let Some(observed) = self
            .observed
            .get_mut(&json!([host, session, pane]).to_string())
        {
            observed["seen"] = json!(token);
            self.dirty = true;
        }
        if let Some(snapshot) = self.cache.get_mut(host) {
            for row in snapshot["panes"].as_array_mut().unwrap() {
                if row["session"] == session && row["pane_id"] == pane && row["token"] == token {
                    row["seen"] = json!(true);
                }
            }
        }
    }
    /// What the owner of `host` tells peers, so every relay shows the same state.
    /// None while the owner's poll is stale, so peers fall back to scanning.
    pub(super) fn owned(&self, host: &str) -> Option<Value> {
        if self.refreshed.get(host)?.elapsed() > Duration::from_secs(30) {
            return None;
        }
        let mut snapshot = self.cache.get(host)?.clone();
        snapshot["synced"] = json!(true);
        for error in snapshot["errors"].as_array_mut().unwrap() {
            error["message"] = json!("Peer snapshots unavailable");
        }
        Some(snapshot)
    }
    fn merged(&self, order: &[String]) -> Value {
        let mut merged = json!({"panes":[],"tabs":[],"errors":[]});
        for host in order {
            if let Some(snapshot) = self.cache.get(host) {
                for field in ["panes", "tabs", "errors"] {
                    merged[field]
                        .as_array_mut()
                        .unwrap()
                        .extend(snapshot[field].as_array().unwrap().clone());
                }
            }
        }
        merged
    }
    fn persisted(&self) -> Value {
        Value::Object(
            self.observed
                .iter()
                .map(|(key, value)| {
                    let mut value = value.clone();
                    value.as_object_mut().unwrap().remove("agent");
                    (key.clone(), value)
                })
                .collect(),
        )
    }
}

pub(super) async fn start(state: RelayState, file: PathBuf) -> Vec<tokio::task::JoinHandle<()>> {
    let mut poll = state.poll.lock().await;
    if let Ok(bytes) = tokio::fs::read(&file).await {
        if let Ok(Value::Object(rows)) = serde_json::from_slice::<Value>(&bytes) {
            for (key, value) in rows {
                if let Ok(Value::Array(identity)) = serde_json::from_str::<Value>(&key) {
                    if identity.len() == 3 && value["generation"].as_u64().is_some() {
                        poll.observed
                            .insert(Value::Array(identity).to_string(), value);
                    }
                }
            }
        }
    }
    drop(poll);
    let poll = state.poll.clone();
    if let Some(mesh) = &state.mesh {
        let _ = mesh.attention.set(poll.clone());
    }
    let mut tasks: Vec<_> = state
        .order
        .iter()
        .map(|id| {
            let host = state.hosts[id].clone();
            let state = state.clone();
            let poll = poll.clone();
            let file = file.clone();
            let id = id.clone();
            tokio::spawn(async move {
                let mut offset = 0;
                loop {
                    let result = scan(&host, offset).await;
                    offset = offset.wrapping_add(1);
                    let mut poll = poll.lock().await;
                    let changed = match result {
                        Ok(mut snapshot) => poll.update(&id, &mut snapshot),
                        Err(error) => {
                            logs::record(
                                &host.config.name,
                                &format!("Status unavailable: {error}"),
                            );
                            poll.unavailable(&id, &error);
                            false
                        },
                    };
                    *state.attention.lock().await = poll.merged(
                        &state
                            .all_hosts()
                            .iter()
                            .map(|h| h.config.id.clone())
                            .collect::<Vec<_>>(),
                    );
                    if changed || std::mem::take(&mut poll.dirty) {
                        let temp = file.with_extension("attention.json.tmp");
                        let data = poll.persisted().to_string();
                        let _ = async {
                            if let Some(parent) = file.parent() {
                                tokio::fs::create_dir_all(parent).await?;
                            }
                            tokio::fs::write(&temp, data).await?;
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                tokio::fs::set_permissions(
                                    &temp,
                                    std::fs::Permissions::from_mode(0o600),
                                )
                                .await?;
                            }
                            tokio::fs::rename(&temp, &file).await
                        }
                        .await;
                    }
                    drop(poll);
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            })
        })
        .collect();
    if state.mesh.is_some() {
        tasks.push(tokio::spawn(async move {
            let mut offset = 0;
            loop {
                let hosts: Vec<_> = state
                    .mesh
                    .as_ref()
                    .unwrap()
                    .hosts()
                    .into_iter()
                    .filter(|h| state.all_hosts().iter().any(|l| l.config.id == h.config.id))
                    .collect();
                let results =
                    futures_util::future::join_all(hosts.iter().map(|host| scan(host, offset)))
                        .await;
                offset = offset.wrapping_add(1);
                let mut poll = poll.lock().await;
                for (host, result) in hosts.iter().zip(results) {
                    match result {
                        Ok(mut snapshot) => {
                            poll.update(&host.config.id, &mut snapshot);
                        },
                        Err(_) => {
                            logs::record(
                                &host.config.name,
                                "Status unavailable from paired computer",
                            );
                            poll.unavailable(
                                &host.config.id,
                                &anyhow::anyhow!(
                                    "Peer snapshots unavailable; check connection and retry"
                                ),
                            );
                        },
                    }
                }
                *state.attention.lock().await = poll.merged(
                    &state
                        .all_hosts()
                        .iter()
                        .map(|h| h.config.id.clone())
                        .collect::<Vec<_>>(),
                );
                drop(poll);
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }));
    }
    tasks
}

pub(super) async fn handler(State(state): State<RelayState>) -> Json<Value> {
    Json(state.attention.lock().await.clone())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Ack {
    host: String,
    session: String,
    pane_id: u64,
    token: String,
}

/// Sends a review to the computer running the tab, so every relay sees it.
pub(super) async fn acknowledge(
    State(state): State<RelayState>,
    Json(ack): Json<Ack>,
) -> StatusCode {
    let Some(host) = state.host(&ack.host) else {
        return StatusCode::NOT_FOUND;
    };
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let body = json!({"session":ack.session,"pane_id":ack.pane_id,"token":ack.token});
        // Offline or older peers keep the review on this relay only.
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            host.request(
                Method::POST,
                "/switchboard/attention/ack",
                body.to_string().into(),
                "application/json",
            ),
        )
        .await;
    }
    let mut poll = state.poll.lock().await;
    poll.acknowledge(&ack.host, &ack.session, ack.pane_id, &ack.token);
    *state.attention.lock().await = poll.merged(
        &state
            .all_hosts()
            .iter()
            .map(|h| h.config.id.clone())
            .collect::<Vec<_>>(),
    );
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn local_hosts_scan_with_the_cli_and_paired_hosts_through_their_gateway() {
        use std::os::unix::fs::PermissionsExt;
        let upstream = Router::new()
            .route(
                "/command/login",
                post(|| async { ([(header::SET_COOKIE, "session_token=t")], "{}") }),
            )
            .route(
                "/session-list",
                get(|| async { Json(json!({"sessions":[{"name":"main","web_clients_allowed":true}]})) }),
            )
            .route(
                "/switchboard/attention",
                get(|| async {
                    Json(json!({"panes":[],"tabs":[{"session":"peer","id":9}],"errors":[{"message":"x"}]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "t").unwrap();
        let cli = dir.path().join("zellij");
        std::fs::write(&cli, r#"#!/bin/sh
case "$*" in
*list-panes*) echo '[{"id":1,"tab_id":4,"tab_position":0,"tab_name":"T","title":"x","pane_command":"codex","is_plugin":false}]';;
*dump-screen*) printf '(3s esc to interrupt)\n> x\ngpt-5 tab to queue message\n';;
esac
"#).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut local = super::super::tests::config(&url);
        local.token_file = token.to_str().unwrap().into();
        local.zellij_binary = Some(cli.to_str().unwrap().into());
        let snapshot = scan(&Host::new(local.clone()).unwrap(), 0).await.unwrap();
        assert_eq!(snapshot["tabs"][0]["id"], 4);
        assert_eq!(snapshot["panes"][0]["state"], "working");
        local.id = "mesh-peer".into();
        local.zellij_binary = Some("/nonexistent".into());
        local.escape_transport = Some("gateway".into());
        let snapshot = scan(&Host::new(local).unwrap(), 0).await.unwrap();
        assert_eq!(snapshot["tabs"][0]["session"], "peer");
        assert_eq!(snapshot["errors"][0]["host"], "mesh-peer");
        server.abort();
    }
    #[test]
    fn failed_hosts_keep_tab_identity_without_stale_attention_and_recover() {
        let mut poll = PollState::default();
        let mut snapshot = json!({"panes":[{"session":"main","pane_id":1,"state":"ready","token":"result"}],"tabs":[{"session":"main","id":42}],"errors":[]});
        poll.update("windows", &mut snapshot);
        for _ in 0..2 {
            poll.unavailable("windows", &anyhow::anyhow!("Connection timed out"));
            let merged = poll.merged(&["windows".into()]);
            assert_eq!(merged["tabs"][0]["id"], 42);
            assert!(merged["panes"].as_array().unwrap().is_empty());
            assert_eq!(merged["errors"][0]["host"], "windows");
        }
        poll.unavailable("new-host", &anyhow::anyhow!("Connection timed out"));
        assert!(poll.cache["new-host"]["tabs"]
            .as_array()
            .unwrap()
            .is_empty());
        let mut recovered = json!({"panes":[],"tabs":[],"errors":[]});
        poll.update("windows", &mut recovered);
        let merged = poll.merged(&["windows".into()]);
        assert!(merged["tabs"].as_array().unwrap().is_empty());
        assert!(merged["errors"].as_array().unwrap().is_empty());
    }

    #[test]
    fn states_match_existing_agent_ui_and_survive_reflow() {
        let pane = json!({"pane_command":"cmd.exe /c codex.cmd resume","title":"ssb orchestrator"});
        let idle="• Result ready\nWorked for 3m 51s • 8:06 PM\n› Ask Codex to do anything\nGPT-6.1-Sol high · Main\n? for shortcuts";
        assert_eq!(classify(&pane, idle)["state"], "ready");
        assert_eq!(classify(&pane,"• Working (3m 26s • esc to interrupt)\n› draft\nGPT-6.1-Sol high · tab to queue message")["state"],"working");
        let old="Would you like to run this command?\n› 1. Yes, proceed\n2. No\nPress enter to confirm or esc to cancel\n";
        assert_eq!(classify(&pane, old)["state"], "approval");
        assert_eq!(
            classify(&pane, &format!("{old}{idle}"))["token"],
            classify(&pane, idle)["token"]
        );
        let claude = json!({"pane_command":"claude.exe --resume","title":"✳ work"});
        assert_eq!(
            classify(
                &claude,
                "● Result\n✻ Baked for 4m 5s\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)"
            )["state"],
            "ready"
        );
        assert_eq!(
            classify(&json!({"pane_command":"nu","title":"~"}), "quiet shell")["state"],
            "unknown"
        );
    }

    #[test]
    fn deferred_scans_preserve_seen_generation_until_expired() {
        let mut poll = PollState::default();
        let mut first = json!({"panes":[{"session":"main","pane_id":1,"state":"working"}],"tabs":[{"session":"main","id":4}],"errors":[]});
        poll.update("mac", &mut first);
        first["panes"][0]["state"] = json!("ready");
        first["panes"][0]["token"] = json!("result");
        poll.update("mac", &mut first);
        let mut deferred = json!({"panes":[],"tabs":[],"errors":[],"deferred_sessions":["main"]});
        poll.update("mac", &mut deferred);
        assert_eq!(deferred["panes"][0]["token"], "result:1");
        assert_eq!(deferred["tabs"][0]["id"], 4);
        let key = json!(["mac", "main"]).to_string();
        poll.sessions_scanned
            .insert(key, tokio::time::Instant::now() - Duration::from_secs(31));
        let mut expired = json!({"panes":[],"tabs":[],"errors":[],"deferred_sessions":["main"]});
        poll.update("mac", &mut expired);
        assert!(expired["panes"].as_array().unwrap().is_empty());
    }
    #[test]
    fn reviews_persist_per_result_and_owner_snapshots_pass_through() {
        let mut poll = PollState::default();
        let ready = || json!({"panes":[{"session":"main","pane_id":1,"state":"ready","token":"result"}],"tabs":[],"errors":[]});
        let mut snapshot = ready();
        poll.update("windows", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["seen"], false);
        poll.acknowledge("windows", "main", 1, "result:0");
        assert!(std::mem::take(&mut poll.dirty), "reviews are saved");
        assert_eq!(poll.merged(&["windows".into()])["panes"][0]["seen"], true);
        let mut restarted = PollState::default();
        restarted.observed = serde_json::from_value(poll.persisted()).unwrap();
        let mut snapshot = ready();
        restarted.update("windows", &mut snapshot);
        assert_eq!(
            snapshot["panes"][0]["seen"], true,
            "reviews survive restarts"
        );
        let mut working = json!({"panes":[{"session":"main","pane_id":1,"state":"working"}],"tabs":[],"errors":[]});
        restarted.update("windows", &mut working);
        let mut snapshot = ready();
        restarted.update("windows", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["token"], "result:1");
        assert_eq!(
            snapshot["panes"][0]["seen"], false,
            "a new result needs review"
        );
        let mut owned = restarted.owned("windows").unwrap();
        assert_eq!(owned["synced"], true);
        restarted.refreshed.insert(
            "windows".into(),
            tokio::time::Instant::now() - Duration::from_secs(31),
        );
        assert!(
            restarted.owned("windows").is_none(),
            "a stalled poll is not served"
        );
        let mut viewer = PollState::default();
        viewer.update("peer", &mut owned);
        assert_eq!(owned["panes"][0]["token"], "result:1");
        assert_eq!(owned["panes"][0]["seen"], false);
        assert!(owned.get("synced").is_none());
    }
    #[test]
    fn stable_tabs_and_notification_generations() {
        let panes = vec![
            json!({"id":8,"tab_id":42,"tab_position":1,"tab_name":"Original","title":"Task","is_plugin":false}),
            json!({"id":7,"tab_id":90,"tab_position":0,"tab_name":"Other","is_plugin":true}),
        ];
        let mut snapshot = snapshot("main", &panes, &HashMap::new(), false);
        assert_eq!(snapshot["tabs"][0]["id"], 90);
        assert_eq!(snapshot["tabs"][1]["panes"][0]["pane_id"], 8);
        let mut poll = PollState::default();
        snapshot["panes"][0]["state"] = json!("working");
        poll.update("mac", &mut snapshot);
        snapshot["panes"][0]["state"] = json!("ready");
        snapshot["panes"][0]["token"] = json!("result");
        poll.update("mac", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["token"], "result:1");
        let saved = poll.persisted();
        let mut restarted = PollState::default();
        restarted.observed = serde_json::from_value(saved).unwrap();
        snapshot["panes"][0]["token"] = json!("result");
        restarted.update("mac", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["token"], "result:1");
        assert_eq!(
            restarted.merged(&["mac".into()])["tabs"][1]["name"],
            "Original"
        );
    }
}
