use super::*;
use axum::extract::Query;
use std::sync::LazyLock;
use std::{collections::BTreeMap, path::PathBuf};

fn tail(text: &str, count: usize) -> &str {
    text.char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map_or(text, |(index, _)| &text[index..])
}

/// Screen markers for one coding agent, read from `agents/<name>.toml`.
#[derive(Deserialize)]
struct Agent {
    #[serde(skip)]
    name: &'static str,
    #[serde(deserialize_with = "patterns")]
    command: Vec<regex::Regex>,
    #[serde(default, deserialize_with = "patterns")]
    title: Vec<regex::Regex>,
    #[serde(deserialize_with = "groups")]
    screen: Vec<Vec<regex::Regex>>,
    #[serde(default, deserialize_with = "patterns")]
    prompt: Vec<regex::Regex>,
    #[serde(deserialize_with = "patterns")]
    footer: Vec<regex::Regex>,
    #[serde(deserialize_with = "patterns")]
    completion: Vec<regex::Regex>,
    working: Working,
    #[serde(deserialize_with = "groups")]
    approval: Vec<Vec<regex::Regex>>,
    #[serde(deserialize_with = "groups")]
    input: Vec<Vec<regex::Regex>>,
}

#[derive(Deserialize)]
struct Working {
    #[serde(deserialize_with = "patterns")]
    title: Vec<regex::Regex>,
    #[serde(deserialize_with = "patterns")]
    above_prompt: Vec<regex::Regex>,
    #[serde(deserialize_with = "patterns")]
    below_prompt: Vec<regex::Regex>,
}

fn patterns<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<regex::Regex>, D::Error> {
    Vec::<String>::deserialize(d)?
        .iter()
        .map(|p| regex::Regex::new(p).map_err(serde::de::Error::custom))
        .collect()
}

fn groups<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Vec<regex::Regex>>, D::Error> {
    Vec::<Vec<String>>::deserialize(d)?
        .iter()
        .map(|group| {
            group
                .iter()
                .map(|p| regex::Regex::new(p).map_err(serde::de::Error::custom))
                .collect()
        })
        .collect()
}

/// Command/title identity wins over screen markers, which can appear in transcripts.
static AGENTS: LazyLock<Vec<Agent>> = LazyLock::new(|| {
    [
        ("copilot", include_str!("agents/copilot.toml")),
        ("codex", include_str!("agents/codex.toml")),
        ("claude", include_str!("agents/claude.toml")),
    ]
    .into_iter()
    .map(|(name, source)| Agent {
        name,
        ..toml::from_str(source).unwrap_or_else(|e| panic!("agents/{name}.toml: {e}"))
    })
    .collect()
});

fn any(patterns: &[regex::Regex], text: &str) -> bool {
    patterns.iter().any(|p| p.is_match(text))
}

fn all_of_one(groups: &[Vec<regex::Regex>], text: &str) -> bool {
    groups
        .iter()
        .any(|group| group.iter().all(|p| p.is_match(text)))
}

/// The match that starts last among all patterns.
fn newest<'t>(patterns: &[regex::Regex], text: &'t str) -> Option<regex::Match<'t>> {
    patterns
        .iter()
        .filter_map(|p| p.find_iter(text).last())
        .max_by_key(|m| m.start())
}

pub(super) fn classify(pane: &Value, screen: &str) -> Value {
    static PROMPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[›❯](?:[ \t\u{a0}]|\r?\n|$)").unwrap());
    static NUMBER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^\s*\d+[.)]").unwrap());
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
    let Some(rules) = AGENTS
        .iter()
        .find(|a| any(&a.command, &command) || any(&a.title, &title))
        .or_else(|| AGENTS.iter().find(|a| all_of_one(&a.screen, text)))
    else {
        return json!({"state":"unknown"});
    };
    let agent = rules.name;
    let prompt = if rules.prompt.is_empty() {
        PROMPT.find_iter(text).last()
    } else {
        newest(&rules.prompt, text)
    };
    let (before, after) = prompt.map_or((text, ""), |p| (&text[..p.start()], &text[p.end()..]));
    let completion = newest(&rules.completion, before);
    let normal = prompt.is_some() && any(&rules.footer, after) && !NUMBER.is_match(after);
    if !normal {
        let chooser = tail(text, 1800);
        if all_of_one(&rules.approval, chooser) {
            return json!({"state":"approval","agent":agent,"token":"approval"});
        }
        if all_of_one(&rules.input, chooser) {
            return json!({"state":"input","agent":agent,"token":"question"});
        }
    }
    let busy = newest(&rules.working.above_prompt, before);
    if any(&rules.working.title, &title)
        || any(&rules.working.below_prompt, after)
        || busy.is_some_and(|b| completion.is_none_or(|c| b.start() > c.start()))
    {
        return json!({"state":"working","agent":agent});
    }
    if !normal {
        return json!({"state":"unknown","agent":agent});
    }
    // "idle": no completion line on screen, e.g. scrolled away or hidden by a resize.
    let token = completion.map_or_else(
        || "idle".to_owned(),
        |m| {
            let signature = SPACE.replace_all(&original[m.range()], " ");
            Sha256::digest(signature.trim().as_bytes())[..10]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect()
        },
    );
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

/// With `after`, a paired computer holds the request until its status version differs.
pub(super) async fn peer_snapshot(
    host: &Host,
    offset: usize,
    after: Option<u64>,
) -> anyhow::Result<Value> {
    let wait = after.map_or(String::new(), |version| format!("&after={version}"));
    let response = tokio::time::timeout(
        Duration::from_secs(if after.is_some() { 45 } else { 20 }),
        host.request(
            Method::GET,
            &format!("/switchboard/attention?offset={offset}{wait}"),
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
    Ok(snapshot)
}

pub(super) async fn scan(host: &Host, offset: usize) -> anyhow::Result<Value> {
    if host.config.escape_transport.as_deref() == Some("gateway") {
        return peer_snapshot(host, offset, None).await;
    }
    let mut names = control::shared_sessions(host).await?;
    if !names.is_empty() {
        let count = names.len();
        names.rotate_left(offset % count);
    }
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut deferred_sessions = Vec::new();
    // A busy engine can take several seconds to list panes; wait rather than report it unavailable.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    for (name, created) in names {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            deferred_sessions.push(name);
            continue;
        }
        let panes = control::run_local(
            host,
            &name,
            &["list-panes", "--json", "--all"],
            remaining.min(Duration::from_secs(15)),
        )
        .await;
        let panes = panes.and_then(|text| Ok(serde_json::from_str::<Vec<Value>>(&text)?));
        let panes = match panes {
            Ok(panes) => panes,
            Err(error) => {
                logs::record(
                    &host.config.name,
                    &format!("Could not list panes in session '{name}': {error:#}"),
                );
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
        let mut session = snapshot(
            &name,
            &panes,
            &screens,
            tokio::time::Instant::now() >= deadline,
        );
        // Pane IDs restart in a recreated session; its creation time tells them apart.
        if let Some(created) = created {
            for row in session["panes"].as_array_mut().unwrap() {
                row["created"] = json!(created);
            }
        }
        results.push(session);
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
    // Rises whenever a cached snapshot changes, waking peers waiting on this computer.
    pub(super) changes: tokio::sync::watch::Sender<u64>,
    // Working panes whose latest screen could not be read.
    unreadable: std::collections::HashSet<String>,
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
        self.changes.send_modify(|version| *version += 1);
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
            let mut previous = self.observed.get(&key).cloned().unwrap_or(Value::Null);
            let created = row.as_object_mut().unwrap().remove("created");
            // A recreated session reuses pane IDs; its panes are new panes. Saved
            // state from before session times were recorded counts as stale too.
            if let Some(created) = created.as_ref().and_then(Value::as_u64) {
                if !previous.is_null()
                    && previous["created"]
                        .as_u64()
                        .is_none_or(|before| before.abs_diff(created) > 60)
                {
                    previous = Value::Null;
                }
            }
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
            // One unreadable screen mid-turn (a dump between redraws, a timed-out dump)
            // does not end the turn; a second one in a row does.
            if row["state"] != "unknown" {
                self.unreadable.remove(&key);
            } else if previous["state"] == "working" && self.unreadable.insert(key.clone()) {
                row["state"] = json!("working");
                row["agent"] = previous["agent"].clone();
            }
            // The newest completion line seen so far. A screen that no longer
            // shows one (scrolled, resized by another viewer) is not a new result.
            let last = previous["token"].as_str().unwrap_or("idle").to_owned();
            if row["token"] == "idle" {
                row["token"] = json!(last);
            }
            // A quick task can finish between scans; its completion line still counts.
            let new_line = !previous.is_null() && row["token"] != "idle" && row["token"] != last;
            // Codex ends every turn with a timed "Worked for" line and briefly looks
            // ready mid-task, so only that line ends a Codex turn.
            let finished = previous["state"] == "working" && (row["agent"] != "codex" || new_line);
            let generation = previous["generation"].as_u64().unwrap_or(0)
                + u64::from(row["state"] == "ready" && (new_line || finished));
            if row["state"] != "unknown" {
                let mut observed = json!({"state":row["state"],"generation":generation});
                for field in ["agent", "token"] {
                    if !row[field].is_null() {
                        observed[field] = row[field].clone();
                    }
                }
                if row["token"].is_null() && last != "idle" {
                    observed["token"] = json!(last);
                }
                if let Some(created) = created.as_ref().filter(|c| c.is_u64()) {
                    observed["created"] = created.clone();
                } else if let Some(created) = previous.get("created") {
                    observed["created"] = created.clone();
                }
                if let Some(seen) = previous.get("seen") {
                    observed["seen"] = seen.clone();
                } else if previous.is_null() && row["state"] == "ready" {
                    // Only a finish seen happening asks for review. A pane first seen
                    // already ready (a resumed agent, a new machine) is not news.
                    observed["seen"] = json!(format!(
                        "{}:{generation}",
                        row["token"].as_str().unwrap_or("idle")
                    ));
                }
                changed |= previous != observed;
                self.observed.insert(key.clone(), observed);
            }
            if row["state"] == "ready" {
                row["token"] = json!(format!(
                    "{}:{generation}",
                    row["token"].as_str().unwrap_or("idle")
                ));
                row["seen"] = json!(self
                    .observed
                    .get(&key)
                    .is_some_and(|o| o["seen"] == row["token"]));
            }
        }
        for field in ["panes", "tabs"] {
            for row in snapshot[field].as_array_mut().unwrap() {
                row["host"] = json!(host);
            }
        }
        if self.cache.get(host) != Some(&*snapshot) {
            self.changes.send_modify(|version| *version += 1);
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
        self.changes.send_modify(|version| *version += 1);
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
            } else {
                // Not scanned since this relay started: browsers keep its tabs
                // instead of reading the absence as every tab having closed.
                merged["errors"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"host":host,"message":"Status not scanned yet"}));
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
                    let started = tokio::time::Instant::now();
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
                    publish(&state, &poll);
                    if changed || std::mem::take(&mut poll.dirty) {
                        let _ = logs::write_private(&file, poll.persisted().to_string().as_bytes())
                            .await;
                    }
                    drop(poll);
                    // Every CLI call queues on the engine thread that also echoes typing.
                    // A slow scan (loaded machine, many panes) waits 3x its own duration so
                    // scanning stays under a quarter of the engine's time.
                    tokio::time::sleep(Duration::from_secs(3).max(started.elapsed() * 3)).await;
                }
            })
        })
        .collect();
    if let Some(mesh) = state.mesh.clone() {
        tasks.push(tokio::spawn(async move {
            // One loop per paired computer, so a slow or offline one delays only its own tabs.
            let mut peers = tokio::task::JoinSet::new();
            let mut running = HashMap::new();
            loop {
                while peers.try_join_next().is_some() {}
                running.retain(|_, task: &mut tokio::task::AbortHandle| !task.is_finished());
                for host in mesh.hosts() {
                    let id = host.config.id.clone();
                    if state.hosts.contains_key(&id) || running.contains_key(&id) {
                        continue;
                    }
                    let (state, poll, mesh) = (state.clone(), poll.clone(), mesh.clone());
                    let task = peers.spawn(async move {
                        let (mut offset, mut after) = (0, None);
                        // Re-read the catalog each time: re-pairing replaces the Host.
                        while let Some(host) = mesh.host(&id) {
                            let result = peer_snapshot(&host, offset, after).await;
                            offset = offset.wrapping_add(1);
                            let mut poll = poll.lock().await;
                            after = None;
                            match result {
                                Ok(mut snapshot) => {
                                    after = snapshot
                                        .as_object_mut()
                                        .unwrap()
                                        .remove("version")
                                        .and_then(|v| v.as_u64());
                                    poll.update(&id, &mut snapshot);
                                },
                                Err(error) => {
                                    logs::record(
                                        &host.config.name,
                                        &format!(
                                            "Status unavailable from paired computer: {error:#}"
                                        ),
                                    );
                                    poll.unavailable(
                                        &id,
                                        &anyhow::anyhow!(
                                            "Peer snapshots unavailable; check connection and retry"
                                        ),
                                    );
                                },
                            }
                            publish(&state, &poll);
                            drop(poll);
                            // A peer that waits for its next change is asked again at once;
                            // an older peer, or a failed request, is asked every 3 s.
                            if after.is_none() {
                                tokio::time::sleep(Duration::from_secs(3)).await;
                            }
                        }
                    });
                    running.insert(host.config.id.clone(), task);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }));
    }
    tasks
}

fn publish(state: &RelayState, poll: &PollState) {
    let snapshot = poll.merged(
        &state
            .all_hosts()
            .iter()
            .map(|h| h.config.id.clone())
            .collect::<Vec<_>>(),
    );
    state.attention.send_if_modified(|(version, current)| {
        if *current == snapshot {
            return false;
        }
        *version += 1;
        *current = snapshot;
        true
    });
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Wait {
    after: Option<u64>,
}

/// With `after`, holds the request until the snapshot's version differs, or 25 s,
/// so browsers see a change as soon as a scan finds it.
pub(super) async fn handler(
    State(state): State<RelayState>,
    Query(wait): Query<Wait>,
) -> Json<Value> {
    let mut changes = state.attention.subscribe();
    if let Some(after) = wait.after {
        let _ = tokio::time::timeout(
            Duration::from_secs(25),
            changes.wait_for(|(version, _)| *version != after),
        )
        .await;
    }
    let (version, mut snapshot) = changes.borrow().clone();
    snapshot["version"] = json!(version);
    Json(snapshot)
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
    publish(&state, &poll);
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_hosts_scan_with_the_cli_and_paired_hosts_through_their_gateway() {
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
        let cli = dir.path().join(if cfg!(windows) {
            "zellij.cmd"
        } else {
            "zellij"
        });
        #[cfg(unix)]
        std::fs::write(&cli, r#"#!/bin/sh
case "$*" in
*list-panes*) sleep 2.2; echo '[{"id":1,"tab_id":4,"tab_position":0,"tab_name":"T","title":"x","pane_command":"codex","is_plugin":false}]';;
*dump-screen*) printf '(3s esc to interrupt)\n> x\ngpt-5 tab to queue message\n';;
esac
"#).unwrap();
        #[cfg(windows)]
        std::fs::write(&cli, r#"@echo off
if "%~4"=="list-panes" goto catalog
echo (3s esc to interrupt)
exit /b 0
:catalog
ping -n 4 127.0.0.1 >nul
echo [{"id":1,"tab_id":4,"tab_position":0,"tab_name":"T","title":"x","pane_command":"codex","is_plugin":false}]
"#).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut local = super::super::tests::config(&url);
        local.token_file = token.to_str().unwrap().into();
        local.zellij_binary = Some(cli.to_str().unwrap().into());
        let snapshot = scan(&Host::new(local.clone()).unwrap(), 0).await.unwrap();
        assert_eq!(snapshot["errors"], json!([]), "{snapshot}");
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
    #[tokio::test]
    async fn a_waiting_browser_hears_about_a_change_without_polling() {
        let host = Arc::new(Host::new(super::super::tests::config("http://127.0.0.1:9")).unwrap());
        let state = RelayState {
            hosts: Arc::new(HashMap::from([("mac".to_owned(), host)])),
            order: Arc::new(vec!["mac".into()]),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: None,
        };
        let mut poll = PollState::default();
        publish(&state, &poll);
        let version = state.attention.borrow().0;
        let wait = |after| handler(State(state.clone()), Query(Wait { after: Some(after) }));
        let waiting = tokio::spawn(wait(version));
        tokio::time::sleep(Duration::from_millis(50)).await;
        publish(&state, &poll);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !waiting.is_finished(),
            "an unchanged snapshot does not answer"
        );
        let mut snapshot = json!({"panes":[{"session":"main","pane_id":1,"state":"working"}],"tabs":[],"errors":[]});
        poll.update("mac", &mut snapshot);
        publish(&state, &poll);
        let Json(answer) = tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(answer["version"], version + 1);
        assert_eq!(answer["panes"][0]["state"], "working");
        let Json(stale) = tokio::time::timeout(Duration::from_secs(1), wait(version))
            .await
            .unwrap();
        assert_eq!(
            stale["version"],
            version + 1,
            "a browser behind answers at once"
        );
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
        // A restarted relay has not scanned yet; that is not an empty catalog.
        let cold = PollState::default().merged(&["windows".into()]);
        assert!(cold["tabs"].as_array().unwrap().is_empty());
        assert_eq!(cold["errors"][0]["host"], "windows");
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
        // Current Claude Code spinner, below an earlier turn's finished line.
        let busy = "✻ Baked for 4m 5s\n❯ next\n⏺ Reading\n· Perambulating… (23s · ↓ 1.4k tokens · thought for 1s)\n─────\n❯ \n─────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent";
        assert_eq!(classify(&claude, busy)["state"], "working");
        let starting = busy.replace(" (23s · ↓ 1.4k tokens · thought for 1s)", "");
        assert_eq!(classify(&claude, &starting)["state"], "working");
        let waiting = busy.replace(
            "Perambulating… (23s · ↓ 1.4k tokens · thought for 1s)",
            "Waiting for 2 background agents to finish",
        );
        assert_eq!(classify(&claude, &waiting)["state"], "working");
        let idle = busy.replace(
            "· Perambulating… (23s · ↓ 1.4k tokens · thought for 1s)\n",
            "",
        );
        assert_eq!(classify(&claude, &idle)["state"], "ready");
        let agents = format!("{idle}\n\n  ⏺ main\n  ◯ fork  Writing measure.cjs freeze/reload experiment     4m 19s · ↓ 461.3k tokens");
        assert_eq!(classify(&claude, &agents)["state"], "working");
        // A Monitor keeps the turn alive after the reply ends, above or below the prompt.
        let monitor = idle.replace(
            "Baked for 4m 5s",
            "Baked for 4m 5s · 1 monitor still running",
        );
        assert_eq!(classify(&claude, &monitor)["state"], "working");
        let timed = idle.replace(
            "✻ Baked for 4m 5s",
            "✻ Brewed for 3s · done 9:05 am · 1 monitor still running",
        );
        assert_eq!(classify(&claude, &timed)["state"], "working");
        assert_eq!(
            classify(&claude, &format!("{idle} · 1 monitor still running"))["state"],
            "working"
        );
        let titled = json!({"pane_command":"claude","title":"◐ Switchboard logs review"});
        assert_eq!(classify(&titled, &idle)["state"], "working");
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
        // An MCP server asking for input shows Accept/Decline with only an Esc footer.
        let elicitation = "⏺ I'll ask the server.\n────────\n MCP server \"github\" requests your input\n\n Allow access to domsleee/switchboard?\n\n ❯ Accept\n   Decline\n\n Esc to cancel";
        assert_eq!(classify(&claude, elicitation)["state"], "input");
    }

    #[test]
    fn claude_idle_prompt_is_ready_with_a_persistent_background_shell() {
        let pane = json!({"pane_command":"claude.exe --dangerously-skip-permissions","title":"✳ Example task"});
        // Claude Code 2.1.301, sanitized from an idle pane with a dev server still running.
        let screen = "● The requested change is ready.\n\
            ✻ Sautéed for 26s · done 5:58 PM · 1 shell still running\n\
            ─────\n❯\u{a0}rename the field\n─────\n\
              ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage\
              ✔ Update installed · Restart to update\n\
              new task? /clear to save 154.6k tokens";
        assert_eq!(classify(&pane, screen)["state"], "ready");
        assert_eq!(
            classify(&json!({"title":"✳ Example task"}), screen),
            classify(&pane, screen),
            "the native pane has no command metadata, so its footer must identify Claude"
        );
        assert_ne!(
            classify(&pane, screen)["token"],
            "idle",
            "the accented finished verb must identify the completed turn"
        );
        for count in ["2 shells", "12 shells"] {
            assert_eq!(
                classify(&pane, &screen.replace("1 shell ·", &format!("{count} ·")))["state"],
                "ready",
                "{count}"
            );
        }
        for screen in [screen.to_owned(), screen.replace('\n', "\r\n")] {
            let busy = screen.replace(
                "✻ Sautéed for 26s",
                "· Perambulating… (23s · ↓ 1.4k tokens)\n✻ Sautéed for 26s",
            );
            assert_eq!(
                classify(&pane, &busy)["state"],
                "ready",
                "an older spinner cannot override the completed turn"
            );
        }
    }

    #[test]
    fn claude_background_shell_counts_do_not_override_real_agent_state() {
        let pane = json!({"pane_command":"claude.exe --dangerously-skip-permissions","title":"✳ background build"});
        // Claude Code 2.1.301: a background shell may be a long-lived dev server.
        let screen = "● The build is running in the background.\n\
            ✻ Baked for 1m 40s · done 12:34 PM · 1 shell still running\n\
            ─────\n❯ \n─────\n\
              ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage";
        assert_eq!(classify(&pane, screen)["state"], "ready");
        for count in ["2 shells", "12 shells"] {
            let screen = screen.replace("1 shell ·", &format!("{count} ·"));
            assert_eq!(classify(&pane, &screen)["state"], "ready", "{count}");
        }
        let default_permissions = screen.replace("⏵⏵ bypass permissions on", "? for shortcuts");
        assert_eq!(classify(&pane, &default_permissions)["state"], "ready");
        let idle = screen.replace(" · 1 shell · ← for agents · ↓ to manage", " · ← for agents");
        assert_eq!(
            classify(&pane, &idle)["state"],
            "ready",
            "clearing a shell count does not change the completed turn"
        );
        assert_eq!(
            classify(&pane, screen)["token"],
            classify(&pane, &idle)["token"]
        );
        assert_eq!(
            classify(&pane, &format!("{screen}\n{idle}"))["state"],
            "ready",
            "an old task footer above the current prompt is not live"
        );
        for count in ["0 shells", "1 shell finished"] {
            let screen = screen.replace("1 shell ·", &format!("{count} ·"));
            assert_eq!(classify(&pane, &screen)["state"], "ready", "{count}");
        }

        let working = screen.replace(
            "✻ Baked for 1m 40s · done 12:34 PM · 1 shell still running",
            "· Perambulating… (23s · ↓ 1.4k tokens)",
        );
        assert_eq!(classify(&pane, &working)["state"], "working");
        // A Monitor in the task footer means Claude is waiting on it, unlike a shell.
        for count in ["1 shell, 1 monitor", "1 monitor", "2 shells, 3 monitors"] {
            let screen = screen.replace("1 shell ·", &format!("{count} ·"));
            assert_eq!(classify(&pane, &screen)["state"], "working", "{count}");
        }
        let agents = format!("{screen}\n  ◯ fork  Reading files  4m 19s · ↓ 461k tokens");
        assert_eq!(classify(&pane, &agents)["state"], "working");
        let titled = json!({"pane_command":"claude.exe","title":"◐ Example task"});
        assert_eq!(classify(&titled, screen)["state"], "working");

        let mut poll = PollState::default();
        let snapshot = |screen| {
            let mut row = classify(&pane, screen);
            row["session"] = json!("main");
            row["pane_id"] = json!(10);
            json!({"panes":[row],"tabs":[],"errors":[]})
        };
        poll.update("windows", &mut snapshot(&idle));
        for _ in 0..2 {
            let mut running = snapshot(&working);
            poll.update("windows", &mut running);
            assert_eq!(running["panes"][0]["state"], "working");
            assert!(running["panes"][0].get("token").is_none());
        }
        let mut finished = snapshot(screen);
        poll.update("windows", &mut finished);
        assert!(finished["panes"][0]["token"]
            .as_str()
            .unwrap()
            .ends_with(":1"));
        assert_eq!(finished["panes"][0]["seen"], false);
    }

    #[test]
    fn copilot_uses_the_live_boxed_prompt_not_old_transcript_markers() {
        let pane = json!({
            "pane_command":r"cmd.exe /c C:\Users\user\AppData\Roaming\npm\copilot.cmd --yolo",
            "title":"Diagnose Switchboard 8585 Status - GitHub Copilot"
        });
        // Copilot CLI 1.0.98, captured from the working Diagnose Switchboard pane.
        let working = "❯ Diagnose Switchboard\n\
            ● Reading the pane\n\
             C:\\src [⎇ main]                    Session: 195.63 AIC used\n\
            ╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n\
            ┃\n\
            ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n\
             ○ Publishing paste-focus PR · 32.8 KiB esc interrupt       GPT-6.1 Sol";
        let footer = "v1.0.98 downloaded · next launch or /restart · ← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab       GPT-6.1 Sol";
        let ready = working.replace(
            "○ Publishing paste-focus PR · 32.8 KiB esc interrupt       GPT-6.1 Sol",
            footer,
        );
        assert_eq!(
            classify(&pane, working),
            json!({"state":"working","agent":"copilot"})
        );
        assert_eq!(
            classify(&pane, &ready),
            json!({"state":"ready","agent":"copilot","token":"idle"})
        );
        // A fresh or resumed pane need not have a previous user-message chevron.
        let fresh = &working[working.find('╻').unwrap()..];
        assert_eq!(classify(&pane, fresh)["state"], "working");
        assert_eq!(
            classify(&pane, &working.replace('\n', "\r\n"))["state"],
            "working"
        );
        for spinner in ["●", "◉", "◎"] {
            assert_eq!(
                classify(&pane, &working.replace('○', spinner))["state"],
                "working",
                "{spinner}"
            );
        }
        assert_eq!(
            classify(&pane, &format!("{working}\n{ready}"))["state"],
            "ready",
            "an old interrupt hint in the transcript is not live"
        );
        let typed = ready.replace("┃\n", "┃ explain esc interrupt\n");
        assert_eq!(classify(&pane, &typed)["state"], "ready");
        let dialog = working.replace(
            "○ Publishing paste-focus PR · 32.8 KiB esc interrupt       GPT-6.1 Sol",
            "Choose an option\nEsc to cancel",
        );
        assert_eq!(
            classify(&pane, &dialog)["state"],
            "unknown",
            "an unrecognized dialog must not look ready"
        );
        let shell = json!({"pane_command":"pwsh","title":"C:\\src"});
        for screen in [working, &ready] {
            assert_eq!(classify(&shell, screen)["agent"], "copilot");
        }
        let title_only = json!({"pane_command":"node","title":"Diagnose - GitHub Copilot"});
        assert_eq!(classify(&title_only, working)["agent"], "copilot");
        assert_eq!(
            classify(&pane, &format!("GPT-6 for shortcuts\n{working}"))["agent"],
            "copilot",
            "Copilot identity takes precedence over old Codex text"
        );
        for agent in ["codex", "claude"] {
            let other = json!({"pane_command":agent,"title":"Task"});
            assert_eq!(
                classify(&other, working)["agent"],
                agent,
                "Copilot text in another agent's transcript must not change its identity"
            );
        }
    }

    #[test]
    fn copilot_queued_input_does_not_hide_working_status() {
        let pane = json!({
            "pane_command":r"cmd.exe /c C:\Users\user\AppData\Roaming\npm\copilot.cmd --yolo",
            "title":"Diagnose Switchboard 8585 Status - Merging typing fix after checks pass - GitHub Copilot"
        });
        // Captured from Diagnose Switchboard with text queued during a running tool.
        let screen = "C:\\src [⎇ main]                    Session: 1446.98 AIC used\n\
            ╻▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n\
            ┃ df\n\
            ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n\
             ◎ Merging typing fix after checks pass · 4.7 KiB esc esc interrupt · ctrl+q enqueue       GPT-6.1 Sol";
        assert_eq!(
            classify(&pane, screen),
            json!({"state":"working","agent":"copilot"})
        );
    }

    #[test]
    fn copilot_question_form_needs_input_until_answered() {
        let pane = json!({
            "pane_command":r"cmd.exe /c C:\Users\user\AppData\Roaming\npm\copilot.cmd --yolo",
            "title":"switchboard - Tracing the update downtime - GitHub Copilot"
        });
        // Copilot CLI 1.0.105, captured from the tracing pane.
        let screen = "○ Asking user Waiting for response\n\
            ────────────────────────────────────────────────────────────────\n\
             Copilot needs information.\n\
             The private checks recovered in about 1 second for the services and 3 seconds for a working terminal. I haven’t reproduced the 15-second pause. What stops working during it?\n\
            \n\
              What you see   Which computer is updating?\n\
            \n\
             What you see:\n\
             ❯ The terminal stops responding\n\
               A computer says Offline, but the terminal still works\n\
               The whole Switchboard page is unavailable\n\
               Not sure\n\
               Other (type your answer)\n\
            \n\
             ↑/↓ select · enter accept · tab next · ctrl+d decline · esc cancel\n\
            ────────────────────────────────────────────────────────────────";
        for form in [
            screen.to_owned(),
            screen.replace('\n', "\r\n"),
            screen.replace(" · tab next · ", "\n tab next · "),
        ] {
            assert_eq!(
                classify(&pane, &form),
                json!({"state":"input","agent":"copilot","token":"question"})
            );
        }
        for incomplete in [
            screen.replace("Copilot needs information.", "Question answered."),
            screen.replace("enter accept", "answer accepted"),
        ] {
            assert_eq!(classify(&pane, &incomplete)["state"], "unknown");
        }
        let ready = "╻▄▄▄▄▄▄▄▄\n┃\n╹▀▀▀▀▀▀▀▀\nInteractive · Allow All · / commands · ? help";
        assert_eq!(
            classify(&pane, &format!("{screen}\n{ready}"))["state"],
            "ready",
            "an answered question in the transcript is not live"
        );
        let working = ready.replace(
            "Interactive · Allow All · / commands · ? help",
            "◉ Working · 14.8 KiB esc interrupt       GPT-6.1 Sol",
        );
        assert_eq!(
            classify(&pane, &format!("{screen}\n{working}"))["state"],
            "working"
        );
    }

    #[test]
    fn copilot_working_to_ready_notifies_once_without_a_completion_line() {
        let pane = json!({"pane_command":"copilot","title":"Task - GitHub Copilot"});
        let ready = "╻▄▄▄▄▄▄▄▄\n┃\n╹▀▀▀▀▀▀▀▀\nInteractive · Allow All · / commands · ? help";
        let working = ready.replace(
            "Interactive · Allow All · / commands · ? help",
            "◉ Working · 14.8 KiB esc interrupt       GPT-6.1 Sol",
        );
        let snapshot = |screen: &str| {
            let mut row = classify(&pane, screen);
            row["session"] = json!("main");
            row["pane_id"] = json!(23);
            json!({"panes":[row],"tabs":[],"errors":[]})
        };
        let mut poll = PollState::default();
        let mut first = snapshot(ready);
        poll.update("windows", &mut first);
        assert_eq!(first["panes"][0]["seen"], true);
        for generation in 1..=2 {
            poll.update("windows", &mut snapshot(&working));
            let token = format!("idle:{generation}");
            let mut finished = snapshot(ready);
            poll.update("windows", &mut finished);
            assert_eq!(finished["panes"][0]["token"], token);
            assert_eq!(finished["panes"][0]["seen"], false);
            poll.acknowledge("windows", "main", 23, &token);
            let mut unchanged = snapshot(ready);
            poll.update("windows", &mut unchanged);
            assert_eq!(unchanged["panes"][0]["token"], token);
            assert_eq!(unchanged["panes"][0]["seen"], true);
        }
    }

    #[test]
    fn agent_rule_files_parse() {
        assert_eq!(
            AGENTS.iter().map(|a| a.name).collect::<Vec<_>>(),
            ["copilot", "codex", "claude"]
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
    fn one_unreadable_screen_does_not_end_a_working_turn() {
        let mut poll = PollState::default();
        let mut scan = |state: &str| {
            let mut snapshot = json!({"panes":[{"session":"main","pane_id":1,"state":state,"agent":"claude"}],"tabs":[],"errors":[]});
            if state == "unknown" {
                snapshot["panes"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("agent");
            }
            poll.update("mac", &mut snapshot);
            snapshot["panes"][0]["state"].as_str().unwrap().to_owned()
        };
        assert_eq!(scan("working"), "working");
        assert_eq!(scan("unknown"), "working");
        assert_eq!(scan("working"), "working");
        assert_eq!(
            scan("unknown"),
            "working",
            "a readable screen re-arms the hold"
        );
        assert_eq!(
            scan("unknown"),
            "unknown",
            "two unreadable screens in a row"
        );
        assert_eq!(scan("ready"), "ready");
        assert_eq!(scan("unknown"), "unknown", "only a working turn is held");
    }
    #[test]
    fn reviews_persist_per_result_and_owner_snapshots_pass_through() {
        let mut poll = PollState::default();
        let ready = || json!({"panes":[{"session":"main","pane_id":1,"state":"ready","token":"result"}],"tabs":[],"errors":[]});
        poll.update("windows", &mut json!({"panes":[{"session":"main","pane_id":1,"state":"working"}],"tabs":[],"errors":[]}));
        let mut snapshot = ready();
        poll.update("windows", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["seen"], false);
        poll.acknowledge("windows", "main", 1, "result:1");
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
        assert_eq!(snapshot["panes"][0]["token"], "result:2");
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
        assert_eq!(owned["panes"][0]["token"], "result:2");
        assert_eq!(owned["panes"][0]["seen"], false);
        assert!(owned.get("synced").is_none());
    }
    #[test]
    fn only_finishes_seen_happening_ask_for_review() {
        let mut poll = PollState::default();
        let pane = |state: &str, token: Option<&str>, created: u64| {
            let mut row = json!({"session":"main","pane_id":0,"state":state,"created":created});
            if let Some(token) = token {
                row["token"] = json!(token);
            }
            json!({"panes":[row],"tabs":[],"errors":[]})
        };
        // First seen already ready: a resumed agent or a newly paired machine.
        let mut snapshot = pane("ready", Some("old"), 1_000);
        poll.update("win", &mut snapshot);
        assert_eq!(
            snapshot["panes"][0]["seen"], true,
            "first sight is not news"
        );
        // A real finish in the same session still asks for review.
        poll.update("win", &mut pane("working", None, 1_001));
        let mut snapshot = pane("ready", Some("new"), 1_002);
        poll.update("win", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["token"], "new:1");
        assert_eq!(snapshot["panes"][0]["seen"], false);
        // The session is recreated and reuses pane 0 for a resumed conversation.
        let mut snapshot = pane("ready", Some("resumed"), 90_000);
        poll.update("win", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["token"], "resumed:0");
        assert_eq!(
            snapshot["panes"][0]["seen"], true,
            "a recreated session is not news"
        );
        // Saved state from before session times were recorded is stale, not a result.
        let mut restarted = PollState::default();
        restarted.observed.insert(
            json!(["win", "main", 0]).to_string(),
            json!({"state":"ready","generation":5,"token":"before"}),
        );
        let mut snapshot = pane("ready", Some("after"), 90_000);
        restarted.update("win", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["seen"], true);
        assert!(snapshot["panes"][0].get("created").is_none());
    }
    #[test]
    fn hidden_completion_is_not_a_new_result_and_stale_owner_keeps_reviews() {
        let mut poll = PollState::default();
        let ready = |token: &str| json!({"panes":[{"session":"main","pane_id":1,"state":"ready","token":token}],"tabs":[],"errors":[]});
        poll.update("mac", &mut ready("result"));
        poll.acknowledge("mac", "main", 1, "result:0");
        // Another viewer's size scrolls the completion line off screen, then back.
        for token in ["idle", "result", "idle"] {
            let mut snapshot = ready(token);
            poll.update("mac", &mut snapshot);
            assert_eq!(snapshot["panes"][0]["token"], "result:0", "{token}");
            assert_eq!(snapshot["panes"][0]["seen"], true, "{token}");
        }
        // A quick task can finish between scans: a new completion line is a new result.
        let mut snapshot = ready("other");
        poll.update("mac", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["token"], "other:1");
        assert_eq!(snapshot["panes"][0]["seen"], false);
        poll.acknowledge("mac", "main", 1, "other:1");
        // A slow owner poll: the gateway applies the owner's state to a fresh scan.
        poll.refreshed.insert(
            "mac".into(),
            tokio::time::Instant::now() - Duration::from_secs(31),
        );
        assert!(poll.owned("mac").is_none());
        poll.update("mac", &mut ready("other"));
        let owned = poll.owned("mac").unwrap();
        assert_eq!(owned["panes"][0]["token"], "other:1");
        assert_eq!(owned["panes"][0]["seen"], true);
        // Codex looks ready mid-task; only its "Worked for" line ends the turn.
        let mut codex = |state: &str, token: Option<&str>| {
            let mut snapshot = json!({"panes":[{"session":"main","pane_id":2,"state":state,"agent":"codex"}],"tabs":[],"errors":[]});
            if let Some(token) = token {
                snapshot["panes"][0]["token"] = json!(token);
            }
            poll.update("mac", &mut snapshot);
            snapshot["panes"][0]["token"].clone()
        };
        codex("ready", Some("idle"));
        for _ in 0..3 {
            codex("working", None);
            assert_eq!(codex("ready", Some("idle")), "idle:0", "mid-task flap");
        }
        codex("working", None);
        assert_eq!(codex("ready", Some("worked")), "worked:1");
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
