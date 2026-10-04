use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{collections::BTreeMap, path::PathBuf};

fn tail(text: &str, count: usize) -> &str {
    text.char_indices()
        .rev()
        .nth(count.saturating_sub(1))
        .map_or(text, |(index, _)| &text[index..])
}

pub(super) fn classify(pane: &Value, screen: &str) -> Value {
    lazy_static::lazy_static! {
        static ref CODEX: regex::Regex = regex::Regex::new(r"\bcodex(?:\.(?:cmd|exe))?\b").unwrap();
        static ref CODEX_TITLE: regex::Regex = regex::Regex::new(r"^codex\s*[-:]").unwrap();
        static ref GPT: regex::Regex = regex::Regex::new(r"gpt-[\w.-]+").unwrap();
        static ref CODEX_FOOTER: regex::Regex = regex::Regex::new(r"for shortcuts|enter to send|tab to queue message").unwrap();
        static ref CLAUDE: regex::Regex = regex::Regex::new(r"\bclaude(?:\.exe)?\b").unwrap();
        static ref CLAUDE_FOOTER: regex::Regex = regex::Regex::new(r"(?:bypass permissions|accept edits) on|shift\+tab to cycle").unwrap();
        static ref PROMPT: regex::Regex = regex::Regex::new(r"[›❯](?:[ \t\u{a0}]|\r?\n|$)").unwrap();
        static ref COMPLETION: regex::Regex = regex::Regex::new(r"(?:worked for|[✻✽✶✳] [a-z]+ for)\s+(?:\d+\s*[hms]\s*)+(?:[•·]\s*(?:done\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?").unwrap();
        static ref NUMBER: regex::Regex = regex::Regex::new(r"^\s*\d+[.)]").unwrap();
        static ref CONTROLS: regex::Regex = regex::Regex::new(r"esc(?:ape)? to cancel|enter to (?:submit|select|confirm)|press enter to confirm").unwrap();
        static ref OPTIONS: regex::Regex = regex::Regex::new(r"(?:^|\s)[12][.)]\s+(?:yes|no|allow|approve|deny)").unwrap();
        static ref QUESTION: regex::Regex = regex::Regex::new(r"[❯›]\s*\d+[.)]").unwrap();
        static ref BUSY: regex::Regex = regex::Regex::new(r"(?:^|\n|[•✻✽✶✳])[^\n]{0,70}\([^\n]{0,160}esc(?:ape)? to interrupt[^\n]{0,60}\)").unwrap();
        static ref SPACE: regex::Regex = regex::Regex::new(r"\s+").unwrap();
    }
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
    lazy_static::lazy_static! {
        static ref SHELL: regex::Regex = regex::Regex::new(r"(?:^|[\\/])(?:nu|zsh|bash|fish|pwsh|powershell)(?:\.exe)?(?:\s|$)").unwrap();
        static ref PATH_TITLE: regex::Regex = regex::Regex::new(r"^(~|/|[A-Za-z]:[\\/])").unwrap();
    }
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
    if control::local(host) {
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
            let panes: Vec<Value> = match panes
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
            {
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
    } else if !names.is_empty() {
        // Keep the complete command comfortably below cmd.exe's line limit.
        let mut batch = Vec::new();
        for name in &names {
            if serde_json::to_vec(&batch)?.len() + name.len() + 4 > 1000 {
                deferred_sessions.push(name.clone());
            } else {
                batch.push(name.clone());
            }
        }
        let mut helper = host.control.lock().await;
        control::ensure_helper(host, &mut helper).await?;
        // Run existing native read-only commands on old Windows hosts. No uploaded Python scanner.
        let script=format!("$names=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}'))) | ConvertFrom-Json; $offset={offset}; {WINDOWS_SCAN}",STANDARD.encode(serde_json::to_vec(&batch)?));
        let result = helper.as_mut().unwrap().json(&script).await;
        let data = match result {
            Ok(Value::Array(data)) => data,
            Err(error) => {
                control::discard(&mut helper).await;
                return Err(error.context("Remote snapshots unavailable"));
            },
            Ok(_) => {
                control::discard(&mut helper).await;
                anyhow::bail!("Invalid remote snapshot");
            },
        };
        for session in data {
            let name = session["name"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("Invalid snapshot session"))?;
            anyhow::ensure!(
                names.iter().any(|n| n == name),
                "Unexpected snapshot session"
            );
            if session["missing_session"] == true {
                continue;
            }
            if session["deferred_session"] == true {
                deferred_sessions.push(name.to_owned());
                continue;
            }
            if !session["error"].is_null() {
                errors.push(json!({"host":host.config.id,"session":name,"message":"Session snapshots unavailable"}));
                continue;
            }
            let panes = session["panes"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("Invalid panes"))?;
            anyhow::ensure!(
                panes
                    .iter()
                    .all(|pane| pane.is_object() && pane["id"].is_u64() && pane["tab_id"].is_u64()),
                "Invalid native pane catalog"
            );
            let screens = session["screens"]
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Invalid screens"))?
                .iter()
                .filter_map(|(id, text)| Some((id.parse().ok()?, text.as_str()?.to_owned())))
                .collect();
            results.push(snapshot(name, panes, &screens, session["deferred"] == true));
        }
    }
    Ok(
        json!({"panes":results.iter().flat_map(|v|v["panes"].as_array().unwrap().clone()).collect::<Vec<_>>(),"tabs":results.iter().flat_map(|v|v["tabs"].as_array().unwrap().clone()).collect::<Vec<_>>(),"errors":errors,"deferred_sessions":deferred_sessions}),
    )
}

const WINDOWS_SCAN: &str = r#"
$data=@(); $deadline=[DateTime]::UtcNow.AddSeconds(8)
# Old Windows web catalogs can retain marker files after an engine exits.
# Native listing checks the marker PID and removes stale entries.
$live=Invoke-SB @('list-sessions','--no-formatting','--short') 2000
if($live.code -ne 0){throw 'Cannot validate live sessions'}
$alive=@($live.output -split '[\r\n]+' | Where-Object {$_ -ne ''})
foreach($name in $names) {
    if($alive -notcontains $name){$data+=@{name=$name;missing_session=$true};continue}
    $remaining=($deadline-[DateTime]::UtcNow).TotalMilliseconds
    if($remaining -le 0){$data+=@{name=$name;deferred_session=$true};continue}
    try {
        $result=Invoke-SB @('-s',$name,'action','list-panes','--json','--all') ([int][Math]::Max(100,[Math]::Min(2000,$remaining)))
        if($result.code -ne 0){throw 'Cannot list panes'}
        # PowerShell 5 emits the JSON array as one pipeline object. Assign first,
        # then enumerate it, otherwise @(... | ConvertFrom-Json) nests panes.
        $panes=$result.output | ConvertFrom-Json; $panes=@($panes); $screens=@{}
        for($i=0;$i -lt $panes.Count;$i++) {
            $p=$panes[($i+$offset)%$panes.Count];$remaining=($deadline-[DateTime]::UtcNow).TotalMilliseconds
            if($remaining -le 0){break}
            if($p.is_plugin -or $p.is_selectable -eq $false -or $p.exited -or $p.is_held){continue}
            if($p.pane_command -match '(?:^|[\\/])(?:nu|zsh|bash|fish|pwsh|powershell)(?:\.exe)?(?:\s|$)' -and $p.title -match '^(~|/|[A-Za-z]:[\\/])'){continue}
            try {
                $result=Invoke-SB @('-s',$name,'action','dump-screen','-p',[string]$p.id) ([int][Math]::Max(100,[Math]::Min(3000,$remaining)))
                if($result.code -eq 0){$screens[[string]$p.id]=$result.output}
            } catch {}
        }
        $data+=@{name=$name;panes=@($panes);screens=$screens;deferred=([DateTime]::UtcNow -ge $deadline)}
    } catch {$data+=@{name=$name;error='Session snapshots unavailable'}}
}
$json=ConvertTo-Json -InputObject @($data) -Depth 12 -Compress
"#;

#[derive(Default)]
struct PollState {
    cache: HashMap<String, Value>,
    observed: HashMap<String, Value>,
    scanned: HashMap<String, tokio::time::Instant>,
    sessions_scanned: HashMap<String, tokio::time::Instant>,
}

impl PollState {
    fn update(&mut self, host: &str, snapshot: &mut Value) -> bool {
        let now = tokio::time::Instant::now();
        let deferred = snapshot
            .as_object_mut()
            .unwrap()
            .remove("deferred_sessions")
            .unwrap_or(json!([]));
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
                changed |= previous != observed;
                self.observed.insert(key, observed);
            }
            if row["state"] == "ready" {
                row["token"] = json!(format!(
                    "{}:{generation}",
                    row["token"].as_str().unwrap_or("idle")
                ));
            }
        }
        for field in ["panes", "tabs"] {
            for row in snapshot[field].as_array_mut().unwrap() {
                row["host"] = json!(host);
            }
        }
        self.cache.insert(host.into(), snapshot.clone());
        changed
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
    let mut poll = PollState::default();
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
    let poll = Arc::new(Mutex::new(poll));
    let mut tasks: Vec<_> = state.order.iter().map(|id| {
        let host=state.hosts[id].clone(); let state=state.clone(); let poll=poll.clone(); let file=file.clone(); let id=id.clone();
        tokio::spawn(async move {
            let mut offset=0;
            loop {
                let result=scan(&host,offset).await; offset=offset.wrapping_add(1);
                let mut poll=poll.lock().await;
                let changed=match result {
                    Ok(mut snapshot)=>poll.update(&id,&mut snapshot),
                    Err(error)=>{poll.cache.insert(id.clone(),json!({"panes":[],"tabs":[],"errors":[{"host":id,"message":format!("Host snapshots unavailable: {error:#}")}]}));false}
                };
                *state.attention.lock().await=poll.merged(&state.all_hosts().iter().map(|h| h.config.id.clone()).collect::<Vec<_>>());
                if changed {
                    let temp=file.with_extension("attention.json.tmp");
                    let data=poll.persisted().to_string();
                    let _=async {
                        if let Some(parent)=file.parent() {tokio::fs::create_dir_all(parent).await?;}
                        tokio::fs::write(&temp,data).await?;
                        #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;tokio::fs::set_permissions(&temp,std::fs::Permissions::from_mode(0o600)).await?;}
                        tokio::fs::rename(&temp,&file).await
                    }.await;
                }
                drop(poll);
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        })
    }).collect();
    if state.mesh.is_some() {
        tasks.push(tokio::spawn(async move {
            let mut offset = 0;
            loop {
                let hosts = state.mesh.as_ref().unwrap().hosts();
                let results = futures_util::future::join_all(hosts.iter().map(|host| scan(host, offset))).await;
                offset = offset.wrapping_add(1);
                let mut poll = poll.lock().await;
                for (host, result) in hosts.iter().zip(results) {
                    match result {
                        Ok(mut snapshot) => { poll.update(&host.config.id, &mut snapshot); },
                        Err(_) => { poll.cache.insert(host.config.id.clone(),json!({"panes":[],"tabs":[],"errors":[{"host":host.config.id,"message":"Peer snapshots unavailable; check connection and retry"}]})); },
                    }
                }
                *state.attention.lock().await = poll.merged(&state.all_hosts().iter().map(|h| h.config.id.clone()).collect::<Vec<_>>());
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

#[cfg(test)]
mod tests {
    use super::*;
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
