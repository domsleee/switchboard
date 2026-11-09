use super::*;
use axum::extract::Query;
use std::process::Stdio;
use std::sync::LazyLock;
use std::{collections::BTreeMap, path::PathBuf, time::Instant};
use tokio::io::AsyncBufReadExt;

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
    #[serde(default, deserialize_with = "patterns")]
    input_title: Vec<regex::Regex>,
    #[serde(deserialize_with = "groups")]
    screen: Vec<Vec<regex::Regex>>,
    #[serde(default, deserialize_with = "patterns")]
    prompt: Vec<regex::Regex>,
    #[serde(deserialize_with = "patterns")]
    footer: Vec<regex::Regex>,
    #[serde(default, deserialize_with = "patterns")]
    background: Vec<regex::Regex>,
    #[serde(default, deserialize_with = "patterns")]
    interrupted: Vec<regex::Regex>,
    #[serde(default, deserialize_with = "patterns")]
    busy_footer: Vec<regex::Regex>,
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

pub(crate) fn classify(pane: &Value, screen: &str) -> Value {
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
        // The executable (or its launcher script) precedes the prompt arguments.
        // Agent names in those arguments must not win by AGENTS' list order.
        .filter_map(|a| {
            a.command
                .iter()
                .filter_map(|pattern| pattern.find(&command))
                .map(|found| found.start())
                .min()
                .map(|position| (position, a))
        })
        .min_by_key(|(position, _)| *position)
        .map(|(_, a)| a)
        .or_else(|| {
            AGENTS
                .iter()
                .find(|a| any(&a.title, &title) || any(&a.input_title, &title))
        })
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
    // Claude can draw the box without a prompt row after Esc.
    let interrupted = any(&rules.interrupted, text) && any(&rules.footer, text);
    let normal =
        interrupted || prompt.is_some() && any(&rules.footer, after) && !NUMBER.is_match(after);
    if !normal {
        let chooser = tail(text, 1800);
        if all_of_one(&rules.approval, chooser) {
            return json!({"state":"approval","agent":agent,"token":"approval"});
        }
        if all_of_one(&rules.input, chooser) {
            return json!({"state":"input","agent":agent,"token":"question"});
        }
    }
    // Async questions can remain pending while the user returns to the main prompt.
    if any(&rules.input_title, &title) {
        return json!({"state":"input","agent":agent,"token":"question"});
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
    let mut ready = json!({"state":"ready","agent":agent,"token":token});
    if any(&rules.background, after) {
        ready["footer_tasks"] = json!(true);
    }
    if interrupted {
        ready["interrupted"] = json!(true);
    }
    ready
}

/// Whether a Claude pane has stopped once Esc has been sent to it.
pub(crate) fn stopped_after_escape(screen: &str) -> bool {
    let row = classify(&json!({"pane_command":"claude"}), screen);
    if row["interrupted"] == true {
        return true;
    }
    if matches!(
        row["state"].as_str(),
        Some("working" | "approval" | "input")
    ) {
        return false;
    }
    let Some(rules) = AGENTS.iter().find(|agent| agent.name == "claude") else {
        return false;
    };
    let text = tail(screen, 8000).to_ascii_lowercase();
    let footer = text.lines().rev().find(|line| !line.trim().is_empty());
    footer.is_some_and(|line| any(&rules.footer, line) && !any(&rules.busy_footer, line))
}

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

static SHELL: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?:^|[\\/])(?:nu|zsh|bash|fish|pwsh|powershell)(?:\.exe)?(?:\s|$)").unwrap()
});

fn quiet_shell(pane: &Value) -> bool {
    static PATH_TITLE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^(~|/|[A-Za-z]:[\\/])").unwrap());
    SHELL.is_match(
        &pane["pane_command"]
            .as_str()
            .unwrap_or("")
            .to_ascii_lowercase(),
    ) && PATH_TITLE.is_match(pane["title"].as_str().unwrap_or(""))
}

/// The program and its arguments. `pane_command` joins argv with spaces, so a Windows
/// path may hold spaces and ends at its extension.
fn split_program(command: &str) -> (&str, &str) {
    static WINDOWS: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^[a-z]:\\.*?\.(?:exe|cmd|bat|com|js|mjs)(?:\s|$)").unwrap()
    });
    match WINDOWS.find(command) {
        Some(path) => (command[..path.end()].trim_end(), &command[path.end()..]),
        None => command
            .split_once(char::is_whitespace)
            .unwrap_or((command, "")),
    }
}

/// False when the pane is running some other program, judged by the program and not its
/// arguments. A shell or no command says nothing, because Claude started from a shell is
/// reported that way; a script runner counts only if the script it runs is Claude.
pub(super) fn may_be_claude(pane: &Value) -> bool {
    static CLAUDE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"(?:^|[\\/])claude(?:\.exe|\.cmd|\.ps1)?$|[\\/]claude[\\/]versions[\\/][^\\/]+$",
        )
        .unwrap()
    });
    static SCRIPT: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[\\/]@anthropic-ai[\\/]claude-code[\\/]").unwrap());
    static RUNNER: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?:^|[\\/])(?:node|bun|cmd)(?:\.exe)?$").unwrap());
    let command = pane["pane_command"]
        .as_str()
        .unwrap_or("")
        .to_ascii_lowercase();
    let (program, mut arguments) = split_program(&command);
    if command.is_empty() || SHELL.is_match(program) || CLAUDE.is_match(program) {
        return true;
    }
    if !RUNNER.is_match(program) {
        return false;
    }
    // Skip the runner's own switches, such as `cmd /c` or `node --no-warnings`.
    loop {
        arguments = arguments.trim_start();
        match arguments.split_once(char::is_whitespace) {
            Some((flag, rest))
                if flag.starts_with('-') || flag.len() == 2 && flag.starts_with('/') =>
            {
                arguments = rest;
            },
            _ => break,
        }
    }
    // A bare runner, such as `cmd.exe` used as a shell, says nothing either.
    let (script, _) = split_program(arguments);
    script.is_empty() || CLAUDE.is_match(script) || SCRIPT.is_match(script)
}

/// The repository holding a folder, named after its main checkout so that every worktree of a
/// repository shares one name.
fn find_repo(cwd: &Path) -> Option<String> {
    let root = cwd
        .ancestors()
        .find(|dir| std::fs::metadata(dir.join(".git")).is_ok())?;
    let own = root.file_name()?.to_str()?.to_string();
    let Ok(pointer) = std::fs::read_to_string(root.join(".git")) else {
        return Some(own);
    };
    // A submodule's `.git` file also holds a gitdir, but outside any `worktrees` folder.
    Some(worktree_repo(root, &pointer).unwrap_or(own))
}

fn worktree_repo(root: &Path, pointer: &str) -> Option<String> {
    let gitdir = root
        .join(pointer.trim().strip_prefix("gitdir:")?.trim())
        .canonicalize()
        .ok()?;
    let worktrees = gitdir.parent()?;
    if worktrees.file_name()? != "worktrees" {
        return None;
    }
    let common = worktrees.parent()?;
    let main = if common.file_name()? == ".git" {
        common.parent()?
    } else {
        common
    };
    Some(
        main.file_name()?
            .to_str()?
            .trim_end_matches(".git")
            .to_string(),
    )
}

/// Status snapshots repeat every few seconds, so each folder is looked up about once a minute.
fn repo_name(cwd: &str) -> Option<String> {
    type Cache = HashMap<String, (Instant, Option<String>)>;
    static CACHE: LazyLock<std::sync::Mutex<Cache>> = LazyLock::new(Default::default);
    if let Ok(cache) = CACHE.lock() {
        if let Some((read, repo)) = cache.get(cwd) {
            if read.elapsed() < Duration::from_secs(60) {
                return repo.clone();
            }
        }
    }
    let repo = find_repo(Path::new(cwd));
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= 512 {
            cache.clear();
        }
        cache.insert(cwd.to_string(), (Instant::now(), repo.clone()));
    }
    repo
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
            tab["panes"].as_array_mut().unwrap().push(json!({"pane_id":pane["id"],"is_plugin":pane["is_plugin"],"tab_position":pane["tab_position"],"title":pane["title"].as_str().unwrap_or(""),"is_floating":pane["is_floating"] == true,"cwd":pane["pane_cwd"],"repo":pane["pane_cwd"].as_str().and_then(repo_name)}));
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
        // Lets PollState::update check that a hook's pane still runs Claude; removed there.
        status["command"] = pane["pane_command"].clone();
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
    // sudo password requests from the peer's panes, under the id this relay knows it by.
    match snapshot.get_mut("askpass").and_then(Value::as_array_mut) {
        Some(requests) => {
            requests.retain(|request| request["id"].is_string());
            for request in requests {
                request["host"] = json!(host.config.id);
            }
        },
        None => {
            snapshot.as_object_mut().unwrap().remove("askpass");
        },
    }
    Ok(snapshot)
}

pub(super) async fn scan(host: &Host, offset: usize) -> anyhow::Result<Value> {
    scan_with(host, offset, None).await
}

/// Panes whose screens decide status: terminals that are running and not a quiet shell.
fn readable(pane: &Value) -> bool {
    pane["is_plugin"] != true
        && pane["is_selectable"] != false
        && pane["exited"] != true
        && pane["is_held"] != true
        && !quiet_shell(pane)
}

async fn scan_with(
    host: &Host,
    offset: usize,
    mut live: Option<&mut Screens>,
) -> anyhow::Result<Value> {
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
    let mut catalog = Vec::new();
    // A busy engine can take several seconds to list panes; wait rather than report it unavailable.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    for (name, created) in names {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            deferred_sessions.push(name);
            continue;
        }
        let panes =
            control::list_panes(host, &name, true, remaining.min(Duration::from_secs(15))).await;
        let panes = match panes {
            Ok(panes) => panes,
            Err(error) => {
                logs::record(
                    &host.config.name,
                    &format!("Could not list panes in session '{name}': {error:#}"),
                );
                errors.push(json!({"host":host.config.id,"session":name,"message":"Session snapshots unavailable"}));
                // A failed listing is not an empty session: keep its last tabs for now.
                deferred_sessions.push(name);
                continue;
            },
        };
        let watched = live.as_deref_mut().map_or_else(HashMap::new, |live| {
            let ids = panes.iter().filter(|p| readable(p));
            live.watch(host, &name, ids.filter_map(|p| p["id"].as_u64()).collect())
        });
        let mut screens = HashMap::new();
        for index in 0..panes.len() {
            let pane = &panes[(index + offset) % panes.len()];
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            if !readable(pane) {
                continue;
            }
            if let Some(id) = pane["id"].as_u64() {
                if let Some(screen) = watched.get(&id) {
                    screens.insert(id, screen.clone());
                    continue;
                }
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
        results.push(session_snapshot(
            &name,
            created,
            &panes,
            &screens,
            tokio::time::Instant::now() >= deadline,
        ));
        catalog.push((name, created, panes));
    }
    if let Some(live) = live {
        live.sessions
            .retain(|name, _| catalog.iter().any(|(listed, ..)| listed == name));
        live.last = (catalog, errors.clone(), deferred_sessions.clone());
    }
    Ok(assemble(&results, errors, deferred_sessions))
}

fn session_snapshot(
    name: &str,
    created: Option<u64>,
    panes: &[Value],
    screens: &HashMap<u64, String>,
    deferred: bool,
) -> Value {
    let mut session = snapshot(name, panes, screens, deferred);
    // Pane IDs restart in a recreated session; its creation time tells them apart.
    if let Some(created) = created {
        for row in session["panes"].as_array_mut().unwrap() {
            row["created"] = json!(created);
        }
    }
    session
}

fn assemble(results: &[Value], errors: Vec<Value>, deferred: Vec<String>) -> Value {
    json!({"panes":results.iter().flat_map(|v|v["panes"].as_array().unwrap().clone()).collect::<Vec<_>>(),"tabs":results.iter().flat_map(|v|v["tabs"].as_array().unwrap().clone()).collect::<Vec<_>>(),"errors":errors,"deferred_sessions":deferred})
}

/// Live screens from one `zellij subscribe` per session, so status follows each
/// screen change without launching a process per pane.
#[derive(Default)]
pub(super) struct Screens {
    sessions: HashMap<String, Subscription>,
    changed: Arc<tokio::sync::Notify>,
    // The last full scan's sessions with their panes, errors and deferred sessions.
    last: (
        Vec<(String, Option<u64>, Vec<Value>)>,
        Vec<Value>,
        Vec<String>,
    ),
}

struct Subscription {
    panes: Vec<u64>,
    started: tokio::time::Instant,
    screens: Arc<std::sync::Mutex<HashMap<u64, String>>>,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        // The reader owns the child, which is killed when the reader is dropped.
        self.reader.abort();
    }
}

impl Screens {
    /// The newest screens of `panes`, (re)subscribing when the pane set changes.
    fn watch(&mut self, host: &Host, session: &str, panes: Vec<u64>) -> HashMap<u64, String> {
        // A subscription that ended (older Zellij, closed session) retries after a
        // minute; until then the scan dumps those panes as before.
        let restart = self.sessions.get(session).is_none_or(|current| {
            current.panes != panes
                || (current.reader.is_finished()
                    && current.started.elapsed() > Duration::from_secs(60))
        });
        if restart {
            self.sessions.remove(session);
            if !panes.is_empty() {
                if let Ok(subscription) = subscribe(host, session, panes, self.changed.clone()) {
                    self.sessions.insert(session.to_owned(), subscription);
                }
            }
        }
        self.sessions
            .get(session)
            .filter(|current| !current.reader.is_finished())
            .map(|current| current.screens.lock().unwrap().clone())
            .unwrap_or_default()
    }
    /// The last full scan with the newest screens, without running any terminal command.
    /// Panes without a live screen keep their previous status.
    fn rescan(&self) -> Value {
        let (catalog, errors, deferred) = &self.last;
        let results: Vec<_> = catalog
            .iter()
            .map(|(name, created, panes)| {
                let screens = self
                    .sessions
                    .get(name)
                    .filter(|current| !current.reader.is_finished())
                    .map(|current| current.screens.lock().unwrap().clone())
                    .unwrap_or_default();
                session_snapshot(name, *created, panes, &screens, true)
            })
            .collect();
        assemble(&results, errors.clone(), deferred.clone())
    }
}

/// Screen subscribers whose relay is gone. Relays built with mio before 1.2.1
/// let them inherit the listening socket, so one left running keeps the port bound.
#[cfg_attr(not(windows), allow(dead_code))]
fn orphaned_subscribers(processes: &[(u32, Option<u32>, Vec<String>)]) -> Vec<u32> {
    let alive: std::collections::HashSet<u32> = processes.iter().map(|(pid, ..)| *pid).collect();
    processes
        .iter()
        .filter(|(_, parent, command)| {
            !parent.is_some_and(|parent| alive.contains(&parent))
                && command.windows(4).any(|args| {
                    args.iter().map(String::as_str).eq([
                        "subscribe",
                        "--format",
                        "json",
                        "--pane-id",
                    ])
                })
        })
        .map(|(pid, ..)| *pid)
        .collect()
}

/// Stop orphaned subscribers; true if there were any.
#[cfg(windows)]
pub(super) fn stop_orphaned_subscribers() -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    let processes: Vec<_> = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            let command = process.cmd().iter();
            (
                pid.as_u32(),
                process.parent().map(Pid::as_u32),
                command
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect(),
            )
        })
        .collect();
    let orphans = orphaned_subscribers(&processes);
    for pid in &orphans {
        if let Some(process) = system.process(Pid::from_u32(*pid)) {
            logs::record(
                "relay",
                &format!("Stopping orphaned screen subscriber {pid}"),
            );
            process.kill();
        }
    }
    !orphans.is_empty()
}

fn subscribe(
    host: &Host,
    session: &str,
    panes: Vec<u64>,
    changed: Arc<tokio::sync::Notify>,
) -> anyhow::Result<Subscription> {
    let mut child = tokio::process::Command::new(control::binary(host)?)
        .args(["-s", session, "subscribe", "--format", "json", "--pane-id"])
        .args(panes.iter().map(u64::to_string))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let screens: Arc<std::sync::Mutex<HashMap<u64, String>>> = Default::default();
    let shared = screens.clone();
    let reader = tokio::spawn(async move {
        let _child = child;
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(update) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let id = update["pane_id"]
                .as_str()
                .and_then(|id| id.strip_prefix("terminal_"))
                .and_then(|id| id.parse::<u64>().ok());
            let (Some(id), Some(rows)) = (id, update["viewport"].as_array()) else {
                continue;
            };
            // Rows are padded to the pane width; dump-screen trims them.
            let mut screen = String::new();
            for row in rows.iter().filter_map(Value::as_str) {
                screen.push_str(row.trim_end());
                screen.push('\n');
            }
            shared.lock().unwrap().insert(id, screen);
            changed.notify_one();
        }
    });
    Ok(Subscription {
        panes,
        started: tokio::time::Instant::now(),
        screens,
        reader,
    })
}

const PEER_RESTART_GRACE: Duration = Duration::from_secs(30);

/// An engine that is slow to scan processes reports some panes without a folder. Keep each
/// pane's last known folder until a new one is read, so its project does not blink in and out.
fn keep_known_folders(previous: &Value, snapshot: &mut Value) {
    let mut known = HashMap::new();
    for tab in previous["tabs"].as_array().into_iter().flatten() {
        for pane in tab["panes"].as_array().into_iter().flatten() {
            if pane["cwd"].is_string() {
                known.insert((tab["session"].to_string(), pane["pane_id"].as_u64()), pane);
            }
        }
    }
    for tab in snapshot["tabs"].as_array_mut().unwrap() {
        let session = tab["session"].to_string();
        for pane in tab["panes"].as_array_mut().into_iter().flatten() {
            if !pane["cwd"].is_null() {
                continue;
            }
            if let Some(last) = known.get(&(session.clone(), pane["pane_id"].as_u64())) {
                pane["cwd"] = last["cwd"].clone();
                pane["repo"] = last["repo"].clone();
            }
        }
    }
}

#[derive(Default)]
pub(super) struct PollState {
    cache: HashMap<String, Value>,
    observed: HashMap<String, Value>,
    scanned: HashMap<String, tokio::time::Instant>,
    sessions_scanned: HashMap<String, tokio::time::Instant>,
    refreshed: HashMap<String, tokio::time::Instant>,
    // When each host last answered with a snapshot.
    reached: HashMap<String, tokio::time::Instant>,
    // Rises whenever a cached snapshot changes, waking peers waiting on this computer.
    pub(super) changes: tokio::sync::watch::Sender<u64>,
    // Working panes whose latest screen could not be read.
    unreadable: std::collections::HashSet<String>,
    // The latest hook status per local (session, pane); live dialogs take priority.
    hooks: HashMap<(String, u64), Hooked>,
    // Wakes the local scan loops when a hook reports.
    hooked: Arc<tokio::sync::Notify>,
    // Local panes waiting on `zellij switchboard run` (count per pane); they show "input".
    interactive: HashMap<(String, u64), usize>,
    // Background shells running at each local pane's last Claude Stop, by task ID.
    stop_shells: HashMap<(String, u64), Vec<String>>,
    // Panes whose denied approval is already queued for a settle, and that queue.
    denied: std::collections::HashSet<(String, u64)>,
    settling: Vec<(String, u32)>,
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
        snapshot.as_object_mut().unwrap().remove("askpass");
        snapshot["errors"] =
            json!([{"host":host,"message":format!("Host snapshots unavailable: {error:#}")}]);
        self.changes.send_modify(|version| *version += 1);
    }

    /// A paired computer restarts its relay on every update, which takes seconds.
    /// Until it has been silent for `PEER_RESTART_GRACE`, keep its last status and
    /// mark the error pending, so sidebars do not flip its tabs to Unavailable.
    fn peer_unavailable(&mut self, host: &str, error: &anyhow::Error) {
        let recent = self
            .reached
            .get(host)
            .is_some_and(|at| at.elapsed() < PEER_RESTART_GRACE);
        let Some(snapshot) = self.cache.get_mut(host).filter(|_| recent) else {
            return self.unavailable(host, error);
        };
        let pending = json!([{"host":host,"message":format!("Host snapshots unavailable: {error:#}"),"pending":true}]);
        if snapshot["errors"] != pending {
            snapshot["errors"] = pending;
            self.changes.send_modify(|version| *version += 1);
        }
    }

    pub(super) fn update(&mut self, host: &str, snapshot: &mut Value) -> bool {
        self.update_checked(host, snapshot, &ProcessChecks::new())
    }

    fn update_checked(&mut self, host: &str, snapshot: &mut Value, checks: &ProcessChecks) -> bool {
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
            keep_known_folders(previous, snapshot);
        }
        let mut changed = false;
        for row in snapshot["panes"].as_array_mut().unwrap() {
            if synced {
                continue;
            }
            let key = json!([host, row["session"], row["pane_id"]]).to_string();
            let mut previous = self.observed.get(&key).cloned().unwrap_or(Value::Null);
            let created = row.as_object_mut().unwrap().remove("created");
            let mut recreated = None;
            // A recreated session reuses pane IDs; its panes are new panes. Saved
            // state from before session times were recorded counts as stale too.
            if let Some(created) = created.as_ref().and_then(Value::as_u64) {
                if !previous.is_null()
                    && previous["created"]
                        .as_u64()
                        .is_none_or(|before| before.abs_diff(created) > 60)
                {
                    previous = Value::Null;
                    recreated = Some(created);
                }
            }
            // What the screen alone said, and the hook that may override it, for the change log.
            // A deferred row's screen was not read this scan. Rows reused from the previous
            // snapshot also carry no command, so their hook is not looked up either.
            let deferred = row["deferred"] == json!(true);
            let screen = if deferred {
                "unread"
            } else {
                row["state"].as_str().unwrap_or("unknown")
            }
            .to_owned();
            let mut hook = if deferred && row.get("command").is_none() {
                "unread"
            } else {
                "none"
            };
            // Only local scans list commands, so only local panes take hooks and runs.
            let mut waiting_on_run = false;
            if let Some(command) = row.as_object_mut().unwrap().remove("command") {
                if let Some(created) = recreated {
                    self.forget_hook(row, created);
                }
                self.apply_hook_checked(row, &command, checks);
                self.queue_denied_settle(row, &screen);
                // After apply_hook, which drops a hook from an agent the pane no longer runs.
                if let (Some(session), Some(pane)) =
                    (row["session"].as_str(), row["pane_id"].as_u64())
                {
                    if let Some(hooked) = self.hooks.get(&(session.to_owned(), pane)) {
                        hook = hooked.state;
                    }
                }
                waiting_on_run = self.waiting_on_run(row);
            }
            row.as_object_mut().unwrap().remove("footer_tasks");
            row.as_object_mut().unwrap().remove("interrupted");
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
            // Not a finished turn: SessionStart reports ready with no token, and a new
            // Claude's screen can flicker to an empty prompt before its first hook.
            let started = row["state"] == "ready"
                && (row["token"].is_null()
                    || row["agent"] == "claude"
                        && row["token"] == "idle"
                        && matches!(hook, "none" | "unknown")
                        && just_appeared_working(&previous));
            if row["token"] == "idle" {
                row["token"] = json!(last);
            }
            // A quick task can finish between scans; its completion line still counts.
            let new_line =
                !started && !previous.is_null() && row["token"] != "idle" && row["token"] != last;
            // Codex ends every turn with a timed "Worked for" line and briefly looks
            // ready mid-task, so only that line ends a Codex turn.
            let finished =
                !started && previous["state"] == "working" && (row["agent"] != "codex" || new_line);
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
                if started || previous.is_null() && row["state"] == "ready" {
                    // Only a finish seen happening asks for review. A pane first seen
                    // already ready (a resumed agent, a new machine) is not news.
                    observed["seen"] = json!(format!(
                        "{}:{generation}",
                        row["token"].as_str().unwrap_or("idle")
                    ));
                } else if let Some(seen) = previous.get("seen") {
                    observed["seen"] = seen.clone();
                }
                // When the pane last changed state or finished a turn: the sidebar shows its age.
                observed["since"] = match previous["since"].as_u64() {
                    Some(since)
                        if previous["state"] == row["state"]
                            && previous["generation"].as_u64() == Some(generation) =>
                    {
                        json!(since)
                    },
                    _ => json!(unix_seconds()),
                };
                if !previous.is_null() && previous["state"] != row["state"] {
                    log::info!(
                        "Switchboard pane {host} {} {}: {} -> {} (screen {screen}, hook {hook})",
                        row["session"].as_str().unwrap_or(""),
                        row["pane_id"],
                        previous["state"].as_str().unwrap_or("unknown"),
                        row["state"].as_str().unwrap_or("unknown"),
                    );
                }
                changed |= previous != observed;
                self.observed.insert(key.clone(), observed);
            }
            if let Some(since) = self.observed.get(&key).and_then(|o| o["since"].as_u64()) {
                row["since"] = json!(since);
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
            // Shown, never observed: the agent's own turn tracking carries on beneath it.
            if waiting_on_run {
                let row = row.as_object_mut().unwrap();
                row.insert("state".into(), json!("input"));
                row.insert("token".into(), json!("interactive"));
                row.remove("seen");
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
        self.reached.insert(host.into(), now);
        changed
    }
    /// Forgets panes closed more than `CLOSED_PANE_SECONDS` ago, given a full scan of
    /// this computer. Without every session listed, absence says nothing about a pane.
    pub(super) fn prune_closed(&mut self, host: &str, snapshot: &Value) {
        let complete = |field: &str| snapshot[field].as_array().is_some_and(Vec::is_empty);
        let Some(panes) = snapshot["panes"].as_array().filter(|p| !p.is_empty()) else {
            return;
        };
        if !complete("errors") || !complete("deferred_sessions") {
            return;
        }
        let listed: std::collections::HashSet<String> = panes
            .iter()
            .map(|row| json!([host, row["session"], row["pane_id"]]).to_string())
            .collect();
        let now = unix_seconds();
        let closed: Vec<(String, Value)> = self
            .observed
            .iter()
            .filter(|(key, row)| {
                !listed.contains(*key)
                    && row["since"]
                        .as_u64()
                        .is_some_and(|since| now.saturating_sub(since) > CLOSED_PANE_SECONDS)
            })
            .filter_map(|(key, _)| {
                let identity = serde_json::from_str::<Value>(key).ok()?;
                (identity[0] == host).then(|| (key.clone(), identity))
            })
            .collect();
        for (key, identity) in closed {
            self.observed.remove(&key);
            self.scanned.remove(&key);
            self.unreadable.remove(&key);
            if let (Some(session), Some(pane)) = (identity[1].as_str(), identity[2].as_u64()) {
                let pane = (session.to_owned(), pane);
                self.hooks.remove(&pane);
                self.stop_shells.remove(&pane);
                self.denied.remove(&pane);
            }
            self.dirty = true;
        }
        // Both are only read while under 30 seconds old.
        let recent = Duration::from_secs(30);
        self.scanned.retain(|_, at| at.elapsed() < recent);
        self.sessions_scanned.retain(|_, at| at.elapsed() < recent);
    }
    pub(super) fn restart_identity(
        &self,
        session: &str,
        pane: u32,
        chat: &str,
    ) -> Option<(super::restart::Identity, bool)> {
        let hook = self.hooks.get(&(session.to_string(), pane.into()))?;
        if !matches!(hook.state, "ready" | "working") || hook.chat_id.as_deref() != Some(chat) {
            return None;
        }
        let identity = hook
            .restart
            .as_ref()
            .filter(|identity| identity.resumable())?;
        Some((identity.clone(), hook.state == "working"))
    }
    /// The agent whose hooks last reported for this pane, until it ends.
    pub(super) fn hooked_agent(&self, session: &str, pane: u32) -> Option<&'static str> {
        self.hooks
            .get(&(session.to_string(), pane.into()))
            .map(|hook| hook.agent)
    }
    #[cfg(test)]
    pub(super) fn hook_claude_for_test(&mut self, session: &str, pane: u32) {
        self.hooks.insert(
            (session.to_string(), pane.into()),
            Hooked {
                agent: "claude",
                state: "ready",
                token: None,
                chat_id: None,
                restart: None,
                capturing: None,
                at: 0,
                shell_hold: false,
                idle_since: None,
            },
        );
    }
    /// A local pane started or finished waiting on `zellij switchboard run`.
    pub(super) fn run_waiting(&mut self, session: &str, pane: u64, waiting: bool) {
        let key = (session.to_owned(), pane);
        let count = self.interactive.entry(key.clone()).or_default();
        if waiting {
            *count += 1;
        } else {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.interactive.remove(&key);
            }
        }
        self.hooked.notify_one();
    }
    pub(super) fn runs_waiting(&self) -> usize {
        self.interactive.values().sum()
    }
    fn waiting_on_run(&self, row: &Value) -> bool {
        let (Some(session), Some(pane)) = (row["session"].as_str(), row["pane_id"].as_u64()) else {
            return false;
        };
        self.interactive.contains_key(&(session.to_owned(), pane))
    }
    /// A recreated session reuses pane IDs: an old hook status is not its agent's.
    /// A new pane matching a pane ID saved from an older session looks recreated on
    /// every scan until its screen is read, so a hook sent since the session started
    /// (a new agent's SessionStart) stays.
    fn forget_hook(&mut self, row: &Value, created: u64) {
        if let (Some(session), Some(pane)) = (row["session"].as_str(), row["pane_id"].as_u64()) {
            let key = (session.to_owned(), pane);
            if self
                .hooks
                .get(&key)
                .is_some_and(|hooked| hooked.at.saturating_add(60) >= created)
            {
                return;
            }
            self.stop_shells.remove(&key);
            self.dirty |= self.hooks.remove(&key).is_some();
        }
    }
    /// A shell stopped from Claude's task list ends with no hook and no new turn, so
    /// nothing else would end its wait. Claude's idle footer then stops counting it.
    /// A shell that exits by itself clears the count just before Claude wakes, so the
    /// wait ends only once the count has stayed gone for `SHELL_WAIT_GRACE`.
    fn release_ended_shell_wait(&mut self, key: &(String, u64), row: &Value) {
        let Some(hooked) = self.hooks.get_mut(key) else {
            return;
        };
        if hooked.state != "waiting" || !hooked.shell_hold || row["deferred"] == json!(true) {
            return;
        }
        if row["agent"] != hooked.agent || row["state"] != "ready" || row["footer_tasks"] == true {
            hooked.idle_since = None;
            return;
        }
        let since = *hooked
            .idle_since
            .get_or_insert_with(tokio::time::Instant::now);
        if since.elapsed() >= SHELL_WAIT_GRACE {
            hooked.state = "unknown";
            hooked.shell_hold = false;
            hooked.idle_since = None;
            self.dirty = true;
        }
    }
    /// Replaces a local pane's screen reading with its agent's hook status.
    #[cfg(test)]
    fn apply_hook(&mut self, row: &mut Value, command: &Value) {
        self.apply_hook_checked(row, command, &ProcessChecks::new());
    }

    fn apply_hook_checked(&mut self, row: &mut Value, command: &Value, checks: &ProcessChecks) {
        let (Some(session), Some(pane)) = (row["session"].as_str(), row["pane_id"].as_u64()) else {
            return;
        };
        let key = (session.to_owned(), pane);
        self.release_ended_shell_wait(&key, row);
        let Some(hooked) = self.hooks.get(&key) else {
            return;
        };
        // Foreground tools can replace the reported command while the agent is
        // still running. Drop the binding only after checking its recorded process.
        if command
            .as_str()
            .is_some_and(|c| !c.is_empty() && !c.to_ascii_lowercase().contains(hooked.agent))
            && hooked.capturing.is_none()
            && !hooked.restart.as_ref().is_some_and(|expected| {
                checks
                    .get(&key)
                    .filter(|(identity, _)| identity == expected)
                    // No matching result means capture completed after the check,
                    // or inspection failed. Keep the binding until it is checked.
                    .is_none_or(|(_, running)| *running)
            })
        {
            self.hooks.remove(&key);
            self.stop_shells.remove(&key);
            self.dirty = true;
            return;
        }
        if let Some(id) = &hooked.chat_id {
            row["chat_id"] = json!(id);
            // The screen reading can name another agent, so the chat's owner goes with its id.
            row["agent"] = json!(hooked.agent);
            row["restart_available"] = json!(
                hooked.restart.as_ref().is_some_and(|i| i.resumable())
                    && matches!(hooked.state, "ready" | "working")
            );
        }
        if hooked.state == "unknown" {
            return;
        }
        // Codex's async questions and Claude's subagent dialogs can stay open
        // while the parent works or waits. Hooks describe the turn, so a live
        // dialog takes priority until answered.
        if matches!(hooked.agent, "codex" | "claude")
            && row["agent"] == hooked.agent
            && matches!(row["state"].as_str(), Some("approval" | "input"))
        {
            row["turn_state"] = json!(hooked.state);
            return;
        }
        // Claude's next PostToolUse arrives when the approved tool finishes. Its
        // working screen can show that approval was given before that hook arrives.
        // Codex can compact a follow-up before UserPromptSubmit replaces the old Stop.
        // Keep the hook as a fallback when the screen no longer shows active work.
        if (matches!(
            (hooked.agent, hooked.state),
            ("claude", "approval") | ("codex", "ready")
        ) || (hooked.state == "ready" && hooked.token.is_none()))
            && row["agent"] == hooked.agent
            && row["state"] == "working"
        {
            return;
        }
        let row = row.as_object_mut().unwrap();
        row.remove("deferred");
        row.insert("state".into(), json!(hooked.state));
        row.insert("agent".into(), json!(hooked.agent));
        match &hooked.token {
            Some(token) => row.insert("token".into(), json!(token)),
            None => row.remove("token"),
        };
    }

    fn captured(
        &mut self,
        key: &(String, u64),
        expected: &Hooked,
        identity: Option<super::restart::Identity>,
    ) {
        // The capture token survives screen-derived state changes, but a newer
        // hook or SessionEnd invalidates it before the process check finishes.
        if expected.capturing.is_some()
            && self
                .hooks
                .get(key)
                .is_some_and(|hook| hook.capturing == expected.capturing)
        {
            let hook = self.hooks.get_mut(key).unwrap();
            let changed = hook.restart != identity;
            hook.restart = identity;
            hook.capturing = None;
            if changed {
                self.dirty = true;
                self.hooked.notify_one();
            }
        }
    }
    /// Denying a Claude approval sends no hook, only the Interrupted marker. A scan's
    /// screen can be old, so the host loop confirms it from the pane itself, once each
    /// time the marker appears under an approval.
    fn queue_denied_settle(&mut self, row: &Value, screen: &str) {
        let (Some(session), Some(pane)) = (row["session"].as_str(), row["pane_id"].as_u64()) else {
            return;
        };
        let key = (session.to_owned(), pane);
        let approval = self
            .hooks
            .get(&key)
            .is_some_and(|hook| hook.agent == "claude" && hook.state == "approval");
        if approval && row["interrupted"] == true {
            if self.denied.insert(key) {
                self.settling.push((session.to_owned(), pane as u32));
            }
        } else if !approval || !matches!(screen, "unread" | "unknown") {
            self.denied.remove(&key);
        }
    }
    /// Ends a Claude turn that Esc interrupted or an approval denial ended, which no hook
    /// reports. The next prompt's hook replaces this. "idle" because stopping a turn is
    /// not a new result to review.
    pub(super) fn settle_interrupted(&mut self, session: &str, pane: u64) {
        if let Some(hook) = self
            .hooks
            .get_mut(&(session.to_owned(), pane))
            .filter(|hook| hook.agent == "claude" && matches!(hook.state, "working" | "approval"))
        {
            hook.state = "ready";
            hook.token = Some("idle".to_owned());
            self.dirty = true;
            self.hooked.notify_one();
        }
    }
    /// Ends a wait on background shells that Switchboard has just stopped.
    pub(super) fn end_shell_wait(&mut self, session: &str, pane: u64) {
        if let Some(hook) = self
            .hooks
            .get_mut(&(session.to_owned(), pane))
            .filter(|hook| hook.state == "waiting" && hook.shell_hold)
        {
            hook.state = "unknown";
            hook.shell_hold = false;
            hook.idle_since = None;
            self.dirty = true;
            self.hooked.notify_one();
        }
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
    /// Whether an agent pane on these hosts is working, for update tasks that wait.
    pub(super) fn agents_working(&self, hosts: &[String]) -> bool {
        hosts
            .iter()
            .filter_map(|host| self.cache.get(host))
            .any(|snapshot| {
                snapshot["panes"]
                    .as_array()
                    .is_some_and(|panes| panes.iter().any(|pane| pane["state"] == "working"))
            })
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
        let mut merged = json!({"panes":[],"tabs":[],"errors":[],"askpass":[]});
        for host in order {
            if let Some(snapshot) = self.cache.get(host) {
                for field in ["panes", "tabs", "errors", "askpass"] {
                    if let Some(rows) = snapshot.get(field).and_then(Value::as_array) {
                        merged[field].as_array_mut().unwrap().extend(rows.clone());
                    }
                }
            } else {
                // Not scanned since this relay started: browsers keep its tabs
                // instead of reading the absence as every tab having closed.
                merged["errors"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"host":host,"message":"Status not scanned yet","pending":true}));
            }
        }
        merged
    }
    fn persisted(&self) -> Value {
        let mut saved: serde_json::Map<String, Value> = self
            .observed
            .iter()
            .map(|(key, value)| {
                let mut value = value.clone();
                value.as_object_mut().unwrap().remove("agent");
                (key.clone(), value)
            })
            .collect();
        // Older builds skip this row: its key is not a pane identity.
        let hooks: Vec<_> = self
            .hooks
            .iter()
            .map(|(key @ (session, pane), h)| {
                json!([
                    session,
                    pane,
                    h.agent,
                    h.state,
                    h.token,
                    h.chat_id,
                    h.restart,
                    h.at,
                    h.shell_hold,
                    self.stop_shells.get(key),
                ])
            })
            .collect();
        saved.insert("hooks".into(), json!(hooks));
        Value::Object(saved)
    }
    /// Hook statuses saved before a relay restart. "working" is not restored: the turn
    /// may have ended while no relay was listening, and the screen shows a live one.
    fn restore_hooks(&mut self, saved: &Value) {
        for row in saved.as_array().into_iter().flatten() {
            let (Some(session), Some(pane)) = (row[0].as_str(), row[1].as_u64()) else {
                continue;
            };
            let Some(agent) = ["claude", "codex", "copilot"]
                .into_iter()
                .find(|a| row[2] == *a)
            else {
                continue;
            };
            let Some(mut state) = [
                "approval", "input", "waiting", "ready", "working", "unknown",
            ]
            .into_iter()
            .find(|s| row[3] == *s) else {
                continue;
            };
            if matches!(state, "working" | "unknown") {
                if row[5].as_str().is_none() {
                    continue;
                }
                state = "unknown";
            }
            let token = row[4].as_str().map(str::to_owned);
            let key = (session.to_owned(), pane);
            // Without this list, every shell still running looks new at the next Stop.
            if let Ok(shells) = serde_json::from_value(row[9].clone()) {
                self.stop_shells.insert(key.clone(), shells);
            }
            self.hooks.insert(
                key,
                Hooked {
                    agent,
                    state,
                    token,
                    chat_id: row[5].as_str().map(str::to_owned),
                    restart: serde_json::from_value(row[6].clone()).ok(),
                    capturing: None,
                    at: row[7].as_u64().unwrap_or(0),
                    shell_hold: row[8] == true,
                    idle_since: None,
                },
            );
        }
    }
}

pub(super) async fn start(state: RelayState, file: PathBuf) -> Vec<tokio::task::JoinHandle<()>> {
    let mut poll = state.poll.lock().await;
    if let Ok(bytes) = tokio::fs::read(&file).await {
        if let Ok(Value::Object(rows)) = serde_json::from_slice::<Value>(&bytes) {
            for (key, value) in rows {
                if key == "hooks" {
                    poll.restore_hooks(&value);
                    continue;
                }
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
        let _ = mesh.askpass.set(state.askpass.clone());
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
                let mut live = Screens::default();
                let redrawn = live.changed.clone();
                let hooked = poll.lock().await.hooked.clone();
                let scans_here = host.config.escape_transport.as_deref() != Some("gateway");
                let shared_poll = poll.clone();
                let mut next = tokio::time::Instant::now();
                let mut process_cache = ProcessCache::new();
                loop {
                    let started = tokio::time::Instant::now();
                    // Panes and tabs are listed every few seconds; a screen change in
                    // between re-reads status from the live screens alone.
                    let full = started >= next;
                    let result = if full {
                        scan_with(&host, offset, Some(&mut live)).await
                    } else {
                        Ok(live.rescan())
                    };
                    if full {
                        offset = offset.wrapping_add(1);
                        // Every CLI call queues on the engine thread that also echoes typing.
                        // A slow scan (loaded machine, many panes) waits 3x its own duration so
                        // scanning stays under a quarter of the engine's time.
                        next = tokio::time::Instant::now()
                            + Duration::from_secs(3).max(started.elapsed() * 3);
                    }
                    let checks = match &result {
                        Ok(snapshot) => check_processes(&poll, snapshot, &mut process_cache).await,
                        Err(_) => ProcessChecks::new(),
                    };
                    let mut poll = poll.lock().await;
                    let changed = match result {
                        Ok(mut snapshot) => {
                            if full && host.is_local_engine() {
                                poll.prune_closed(&id, &snapshot);
                            }
                            poll.update_checked(&id, &mut snapshot, &checks)
                        },
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
                    let settling = std::mem::take(&mut poll.settling);
                    drop(poll);
                    for (session, pane) in settling {
                        control::settle_interrupt(
                            host.clone(),
                            shared_poll.clone(),
                            session,
                            pane,
                        );
                    }
                    tokio::select! {
                        _ = tokio::time::sleep_until(next) => {},
                        // Gather a burst of redraws into one status read.
                        _ = redrawn.notified() => tokio::time::sleep(Duration::from_millis(250)).await,
                        _ = hooked.notified(), if scans_here => {},
                    }
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
                        let (mut offset, mut after, mut failures) = (0, None, 0u32);
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
                                    failures = 0;
                                    poll.update(&id, &mut snapshot);
                                },
                                Err(error) => {
                                    failures = failures.saturating_add(1);
                                    logs::record(
                                        &host.config.name,
                                        &format!(
                                            "Status unavailable from paired computer: {error:#}"
                                        ),
                                    );
                                    poll.peer_unavailable(
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
                            // an older peer is asked every 3 s, an unreachable one up to every 24 s.
                            if after.is_none() {
                                tokio::time::sleep(Duration::from_secs(
                                    3 << failures.saturating_sub(1).min(3),
                                ))
                                .await;
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

/// A snapshot with a version that changes only when it does, so a peer waiting
/// on this computer is not woken by changes on other computers.
pub(super) fn versioned(snapshot: Value) -> (u64, Value) {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    snapshot.to_string().hash(&mut hasher);
    (hasher.finish(), snapshot)
}

pub(super) fn publish(state: &RelayState, poll: &PollState) {
    let hosts = state.all_hosts();
    let mut snapshot = poll.merged(
        &hosts
            .iter()
            .map(|h| h.config.id.clone())
            .collect::<Vec<_>>(),
    );
    // Password requests from this computer's panes join those paired computers
    // sent. Paired computers read the per-host cache, not this, so a request
    // reaches only the computers paired with the one that asked.
    if let Some(local) = hosts.iter().find(|host| host.is_local_engine()) {
        let requests = state.askpass.snapshot(&local.config.id);
        snapshot["askpass"].as_array_mut().unwrap().extend(requests);
    }
    if snapshot["askpass"].as_array().unwrap().is_empty() {
        snapshot.as_object_mut().unwrap().remove("askpass");
    }
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

type ProcessChecks = HashMap<(String, u64), (super::restart::Identity, bool)>;
type ProcessCache = HashMap<(String, u64), (super::restart::Identity, bool, tokio::time::Instant)>;

/// Copy candidates under the lock, inspect them together off-thread, then let
/// apply_hook_checked reject results for identities replaced in the meantime.
async fn check_processes(
    poll: &tokio::sync::Mutex<PollState>,
    snapshot: &Value,
    cache: &mut ProcessCache,
) -> ProcessChecks {
    let mut candidates: Vec<_> = {
        let poll = poll.lock().await;
        snapshot["panes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let key = (
                    row["session"].as_str()?.to_owned(),
                    row["pane_id"].as_u64()?,
                );
                let hook = poll.hooks.get(&key)?;
                let command = row["command"].as_str()?;
                if command.is_empty() || command.to_ascii_lowercase().contains(hook.agent) {
                    return None;
                }
                Some((key, hook.restart.clone()?))
            })
            .collect()
    };
    cache.retain(|key, (identity, _, _)| candidates.iter().any(|(k, i)| k == key && i == identity));
    let mut checks = ProcessChecks::new();
    candidates.retain(|(key, identity)| {
        if let Some((_, true, checked)) = cache.get(key) {
            if checked.elapsed() < Duration::from_secs(3) {
                checks.insert(key.clone(), (identity.clone(), true));
                return false;
            }
        }
        true
    });
    if candidates.is_empty() {
        return checks;
    }
    let fresh: ProcessChecks = tokio::task::spawn_blocking(move || {
        let identities: Vec<_> = candidates
            .iter()
            .map(|(_, identity)| identity.clone())
            .collect();
        candidates
            .into_iter()
            .zip(super::restart::running(&identities))
            .map(|((key, identity), running)| (key, (identity, running)))
            .collect()
    })
    .await
    .unwrap_or_default();
    for (key, (identity, running)) in fresh {
        cache.insert(
            key.clone(),
            (identity.clone(), running, tokio::time::Instant::now()),
        );
        checks.insert(key, (identity, running));
    }
    checks
}

fn spawn_capture(
    poll: Arc<tokio::sync::Mutex<PollState>>,
    key: (String, u64),
    expected: Hooked,
    capture: impl std::future::Future<Output = Option<super::restart::Identity>> + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let identity = capture.await;
        poll.lock().await.captured(&key, &expected, identity);
    })
}

#[derive(Clone, Debug)]
struct Hooked {
    agent: &'static str,
    state: &'static str,
    token: Option<String>,
    chat_id: Option<String>,
    restart: Option<super::restart::Identity>,
    // A foreground tool must not discard a hook while its process is being captured.
    capturing: Option<uuid::Uuid>,
    // When this agent first reported for the pane, in Unix seconds.
    at: u64,
    // Waiting only because of a background shell started this turn.
    shell_hold: bool,
    // When the idle screen first stopped counting running tasks during that wait.
    idle_since: Option<tokio::time::Instant>,
}

impl PartialEq for Hooked {
    fn eq(&self, other: &Self) -> bool {
        // Capture tokens are transient and never written to the attention file.
        (
            self.agent,
            self.state,
            &self.token,
            &self.chat_id,
            &self.restart,
            self.at,
            self.shell_hold,
            self.idle_since,
        ) == (
            other.agent,
            other.state,
            &other.token,
            &other.chat_id,
            &other.restart,
            other.at,
            other.shell_hold,
            other.idle_since,
        )
    }
}

impl Hooked {
    fn inherit_process(&mut self, old: &Self) {
        self.restart = old.restart.clone();
        self.capturing = old.capturing;
        self.at = old.at;
    }

    fn begin_capture(&mut self) -> Option<Self> {
        if self.restart.is_some() || self.capturing.is_some() || self.chat_id.is_none() {
            return None;
        }
        self.capturing = Some(uuid::Uuid::new_v4());
        Some(self.clone())
    }
}

/// How long, in seconds, a closed pane's saved state is kept.
const CLOSED_PANE_SECONDS: u64 = 30 * 24 * 3600;

/// How long Claude's footer must show no running task before a shell wait ends.
const SHELL_WAIT_GRACE: Duration = Duration::from_secs(30);

/// How long, in seconds, a pane first seen working may still be starting up.
const AGENT_START_GRACE: u64 = 15;

/// A pane that has only ever been seen working, and only for a moment.
fn just_appeared_working(previous: &Value) -> bool {
    previous["state"] == "working"
        && previous["generation"] == 0
        && previous.get("token").is_none()
        && previous["since"]
            .as_u64()
            .is_some_and(|since| unix_seconds().saturating_sub(since) < AGENT_START_GRACE)
}

/// IDs of the background shells a Stop event lists as still running.
fn running_shells(event: &Value) -> Vec<String> {
    event["background_tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|task| task["type"] == "shell" && task["status"] == "running")
        .filter_map(|task| task["id"].as_str().map(str::to_owned))
        .collect()
}

/// What a hook event says about its pane, if anything. Claude Code, Codex and
/// Copilot's PascalCase hooks share these event names and fields.
fn hook_status(agent: &'static str, event: &Value) -> Option<Hooked> {
    let state = match event["hook_event_name"].as_str()? {
        // Compaction can happen during a turn; keep its screen-derived state.
        "SessionStart" if agent == "claude" => match event["source"].as_str() {
            Some("startup" | "resume" | "clear" | "fork") => "ready",
            _ => "unknown",
        },
        "Interrupt" => "unknown",
        "UserPromptSubmit" | "PostToolUse" | "PostToolUseFailure" => "working",
        "PermissionRequest" => "approval",
        "Notification" => match event["notification_type"].as_str()? {
            "permission_prompt" => "approval",
            "elicitation_dialog" => "input",
            _ => return None,
        },
        // A running background agent or workflow will wake the turn when it finishes.
        // A shell (also what a Monitor runs) may be a dev server that outlives the reply,
        // so `hook` decides from shells new since the previous Stop.
        "Stop" | "StopFailure"
            if event["background_tasks"].as_array().is_some_and(|tasks| {
                tasks
                    .iter()
                    .any(|task| task["status"] == "running" && task["type"] != "shell")
            }) =>
        {
            "waiting"
        },
        "Stop" | "StopFailure" => "ready",
        _ => return None,
    };
    // Each turn is a new result: Claude names it with a prompt ID, Codex with a
    // turn ID, and Copilot only timestamps it.
    let token = (state == "ready" && event["hook_event_name"] != "SessionStart").then(|| {
        let turn = ["prompt_id", "turn_id", "timestamp", "session_id"]
            .iter()
            .find_map(|field| event[field].as_str());
        Sha256::digest(turn.unwrap_or("hook").as_bytes())[..10]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    });
    Some(Hooked {
        agent,
        state,
        token,
        chat_id: super::chats::hook_chat_id(agent, event),
        restart: None,
        capturing: None,
        at: unix_seconds(),
        shell_hold: false,
        idle_since: None,
    })
}

/// Receives events through `zellij agent-hook` (and older Claude HTTP hooks).
/// Command hooks name the agent in `X-Agent`; both name their session and pane in headers. Events
/// from outside Zellij carry neither and are ignored. `zellij agent-hook` drops
/// events from an agent that another agent's tool started in the same pane, so it can't
/// overwrite the pane's own status.
pub(super) async fn hook(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(event): Json<Value>,
) -> StatusCode {
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    let session = header("x-zellij-session").filter(|s| !s.is_empty());
    let pane = header("x-zellij-pane").and_then(|p| p.parse::<u64>().ok());
    let nested = header("x-claude-nested").is_some_and(|n| !n.is_empty());
    let agent = match header("x-agent").unwrap_or("claude") {
        "claude" => "claude",
        "codex" => "codex",
        "copilot" => "copilot",
        _ => return StatusCode::NO_CONTENT,
    };
    let (Some(session), Some(pane), false) = (session, pane, nested) else {
        return StatusCode::NO_CONTENT;
    };
    super::agent_setup::heard(agent);
    let key = (session.to_owned(), pane);
    let mut next = hook_status(agent, &event);
    // One lock from reading the previous Stop to installing this hook: overlapping
    // events cannot install a stale state.
    let mut poll = state.poll.lock().await;
    if let Some(hook) = &mut next {
        if let Some(old) = poll
            .hooks
            .get(&key)
            .filter(|old| old.chat_id == hook.chat_id && old.agent == agent)
        {
            hook.inherit_process(old);
        }
        // Claude resumes the turn when a background shell exits. One started this turn
        // is a wait (CI, a build, a review); one already running at the previous Stop is
        // left behind, like a dev server, and does not hold the tab open.
        if matches!(
            event["hook_event_name"].as_str(),
            Some("Stop" | "StopFailure")
        ) {
            let running = running_shells(&event);
            let before = poll
                .stop_shells
                .insert(key.clone(), running.clone())
                .unwrap_or_default();
            poll.dirty |= before != running;
            if hook.state == "ready" && running.iter().any(|id| !before.contains(id)) {
                hook.state = "waiting";
                hook.token = None;
                hook.shell_hold = true;
            }
        }
    }
    let capture = next.as_mut().and_then(Hooked::begin_capture);
    // An interrupted Codex turn has no Stop; the screen shows what it left.
    if matches!(event["hook_event_name"].as_str(), Some("SessionEnd")) {
        poll.stop_shells.remove(&key);
        poll.dirty |= poll.hooks.remove(&key).is_some();
    } else if let Some(hooked) = next {
        if hooked.state == "unknown" && hooked.chat_id.is_none() {
            poll.dirty |= poll.hooks.remove(&key).is_some();
        } else {
            poll.dirty |= poll.hooks.insert(key.clone(), hooked.clone()).as_ref() != Some(&hooked);
        }
    } else {
        return StatusCode::NO_CONTENT;
    }
    // shortcut: wakes one local scan loop, enough for the usual single local host.
    poll.hooked.notify_one();
    drop(poll);
    if let Some(expected) = capture {
        let session = session.to_string();
        // The capture must finish even if the HTTP client times out or disconnects.
        spawn_capture(state.poll.clone(), key, expected, async move {
            tokio::task::spawn_blocking(move || {
                super::restart::capture(agent, &event, &session, pane)
            })
            .await
            .ok()
            .flatten()
        });
    }
    StatusCode::NO_CONTENT
}

/// Separate route keeps older command hooks from receiving duplicate mail.
pub(super) async fn claude_http_hook(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(event): Json<Value>,
) -> Response {
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok());
    if header("x-zellij-session").is_none_or(str::is_empty)
        || header("x-zellij-pane")
            .and_then(|p| p.parse::<u32>().ok())
            .is_none()
        || crate::message_board::hooks::nested("claude", |name| {
            match name {
                "CLAUDECODE" => header("x-claudecode"),
                "CLAUDE_CODE_ENTRYPOINT" => header("x-claude-entrypoint"),
                "CODEX_THREAD_ID" => header("x-codex-thread-id"),
                _ => None,
            }
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
        })
    {
        return StatusCode::NO_CONTENT.into_response();
    }
    let mut status_headers = headers;
    status_headers.insert("x-agent", "claude".parse().unwrap());
    let status = hook(State(state.clone()), status_headers, Json(event.clone())).await;
    if status != StatusCode::NO_CONTENT {
        return status.into_response();
    }
    let relay = format!("http://127.0.0.1:{}", state.port);
    let context = tokio::task::spawn_blocking(move || {
        crate::message_board::hooks::http(&serde_json::to_vec(&event).unwrap(), &relay)
    })
    .await
    .ok()
    .flatten();
    match context {
        Some(context) => Json(context).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    }
}

/// `zellij agent-hook`: forwards status to the relay and delivers mail through
/// lifecycle context. Background --wait hooks only watch for incoming mail.
pub fn forward_hook(agent: &str, wait: bool, input: impl std::io::Read) {
    use isahc::ReadResponseExt;
    use std::io::Read;
    let mut body = Vec::new();
    if input.take(16 << 20).read_to_end(&mut body).is_err() {
        return;
    }
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let relay = crate::message_board::local_relay_url(env("SWITCHBOARD_RELAY_URL").as_deref());
    if !wait {
        if let Some(request) = hook_request(agent, body.as_slice(), env, &relay) {
            let _ = isahc::send(request).map(|mut response| response.consume());
        }
    }
    crate::message_board::hooks::run(agent, &body, wait);
}

fn hook_request(
    agent: &str,
    input: impl std::io::Read,
    env: impl Fn(&str) -> Option<String>,
    relay: &str,
) -> Option<isahc::Request<Vec<u8>>> {
    use isahc::config::Configurable;
    use std::io::Read;
    // A nested CLI shares its caller's pane, not ownership of its conversation.
    if crate::message_board::hooks::nested(agent, &env) {
        return None;
    }
    let (session, pane) = (env("ZELLIJ_SESSION_NAME")?, env("ZELLIJ_PANE_ID")?);
    let mut body = Vec::new();
    input.take(16 << 20).read_to_end(&mut body).ok()?;
    isahc::Request::post(format!("{relay}/api/agent-hook"))
        .timeout(Duration::from_secs(2))
        .header("content-type", "application/json")
        .header("x-zellij-session", session)
        .header("x-zellij-pane", pane)
        .header("x-agent", agent)
        .body(body)
        .ok()
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
    #[test]
    fn switchboard_only_claude_or_a_silent_shell_may_be_claude() {
        use super::*;
        for command in [
            "",
            "claude --resume",
            r"C:\Users\Fixture User\.local\bin\claude.exe --resume",
            "/home/fixture/.local/share/claude/versions/2.1.319 --resume",
            "nu --interactive",
            r"C:\Program Files\PowerShell\7\pwsh.exe -NoLogo",
            "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            r"node --no-warnings C:\Users\Fixture User\npm\node_modules\@anthropic-ai\claude-code\cli.js",
            r"cmd.exe /d /c C:\Users\Fixture User\npm\claude.cmd --yolo",
            "cmd.exe",
        ] {
            assert!(may_be_claude(&json!({"pane_command":command})), "{command}");
        }
        for command in [
            "vim",
            "tail -f claude-folder-trust.txt",
            "node replay.js claude-folder-trust.txt",
            r"C:\tools\claude-kit\viewer.exe",
            r"C:\bin\tail.exe C:\tmp\claude.exe",
            "ssh host claude",
        ] {
            assert!(
                !may_be_claude(&json!({"pane_command":command})),
                "{command}"
            );
        }
    }

    #[test]
    fn switchboard_claude_folder_trust_is_approval_before_a_conversation_exists() {
        use super::*;
        let screen = include_str!("fixtures/claude-folder-trust.txt");
        for pane in [json!({"pane_command":"claude"}), json!({"title":"claude"})] {
            let state = classify(&pane, screen);
            assert_eq!(state["agent"], "claude");
            assert_eq!(state["state"], "approval");
        }
        let ready = "\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
        assert_eq!(
            classify(
                &json!({"pane_command":"claude"}),
                &format!("{screen}{ready}")
            )["state"],
            "ready"
        );
    }

    #[test]
    fn switchboard_repo_name_gives_worktrees_their_main_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("sample");
        let admin = main.join(".git/worktrees/fix");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::create_dir_all(main.join("src/deep")).unwrap();
        assert_eq!(
            super::find_repo(&main.join("src/deep")).as_deref(),
            Some("sample")
        );

        let absolute = temp.path().join("sample-fix");
        std::fs::create_dir_all(&absolute).unwrap();
        std::fs::write(
            absolute.join(".git"),
            format!("gitdir: {}\n", admin.display()),
        )
        .unwrap();
        assert_eq!(super::find_repo(&absolute).as_deref(), Some("sample"));

        let relative = main.join(".claude/worktrees/fix");
        std::fs::create_dir_all(&relative).unwrap();
        std::fs::write(
            relative.join(".git"),
            "gitdir: ../../../.git/worktrees/fix\n",
        )
        .unwrap();
        assert_eq!(super::find_repo(&relative).as_deref(), Some("sample"));

        let bare = temp.path().join("bare.git/worktrees/fix");
        std::fs::create_dir_all(&bare).unwrap();
        let checkout = temp.path().join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        std::fs::write(checkout.join(".git"), format!("gitdir: {}", bare.display())).unwrap();
        assert_eq!(super::find_repo(&checkout).as_deref(), Some("bare"));
    }

    #[test]
    fn switchboard_repo_name_keeps_submodules_and_ignores_plain_folders() {
        let temp = tempfile::tempdir().unwrap();
        let modules = temp.path().join("outer/.git/modules/inner");
        std::fs::create_dir_all(&modules).unwrap();
        let inner = temp.path().join("outer/inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join(".git"), "gitdir: ../.git/modules/inner\n").unwrap();
        assert_eq!(super::find_repo(&inner).as_deref(), Some("inner"));

        let plain = temp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert_eq!(super::find_repo(&plain), None);
    }

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
            askpass: Default::default(),
            html_previews: Default::default(),
            artifact_proxies: Default::default(),
            push: None,
            browser_origin: None,
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
    #[cfg(unix)]
    #[tokio::test]
    async fn an_empty_pane_listing_keeps_the_sessions_last_tabs() {
        let upstream = Router::new()
            .route(
                "/command/login",
                post(|| async { ([(header::SET_COOKIE, "session_token=t")], "{}") }),
            )
            .route(
                "/session-list",
                get(|| async {
                    Json(json!({"sessions":[{"name":"main","web_clients_allowed":true}]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "t").unwrap();
        // A busy engine can answer list-panes with nothing and exit 0.
        let cli = dir.path().join("zellij");
        std::fs::write(&cli, "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = super::super::tests::config(&url);
        config.token_file = token.to_str().unwrap().into();
        config.zellij_binary = Some(cli.to_str().unwrap().into());
        let mut poll = PollState::default();
        let mut listed = json!({"panes":[{"session":"main","pane_id":1,"state":"working"}],"tabs":[{"session":"main","id":4}],"errors":[]});
        poll.update("mac", &mut listed);
        let mut empty = scan(&Host::new(config).unwrap(), 0).await.unwrap();
        poll.update("mac", &mut empty);
        assert_eq!(empty["tabs"][0]["id"], 4, "{empty}");
        assert_eq!(empty["panes"][0]["state"], "working");
        server.abort();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn live_screens_replace_dumps_and_update_status_between_listings() {
        let upstream = Router::new()
            .route(
                "/command/login",
                post(|| async { ([(header::SET_COOKIE, "session_token=t")], "{}") }),
            )
            .route(
                "/session-list",
                get(|| async {
                    Json(json!({"sessions":[{"name":"main","web_clients_allowed":true}]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "t").unwrap();
        let (cli, dumps) = (dir.path().join("zellij"), dir.path().join("dumps"));
        // The subscription streams a working Codex screen, padded like real rows.
        std::fs::write(&cli, format!(r#"#!/bin/sh
case "$*" in
*list-panes*) echo '[{{"id":1,"tab_id":4,"tab_position":0,"tab_name":"T","title":"x","pane_command":"codex","is_plugin":false}}]';;
*"subscribe --format json --pane-id 1") echo '{{"event":"pane_update","pane_id":"terminal_1","viewport":["(3s esc to interrupt)   ","> x   ","gpt-5 tab to queue message   "]}}'; sleep 30;;
*dump-screen*) echo dump >> {}; printf 'quiet\n';;
esac
"#, dumps.display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = super::super::tests::config(&url);
        config.token_file = token.to_str().unwrap().into();
        config.zellij_binary = Some(cli.to_str().unwrap().into());
        let host = Host::new(config).unwrap();
        let mut live = Screens::default();
        let redrawn = live.changed.clone();
        let first = scan_with(&host, 0, Some(&mut live)).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), redrawn.notified())
            .await
            .expect("the subscription delivers the screen");
        assert_eq!(live.rescan()["panes"][0]["state"], "working", "{first}");
        assert_eq!(live.rescan()["tabs"][0]["id"], 4);
        let dumped = || {
            std::fs::read_to_string(&dumps)
                .unwrap_or_default()
                .lines()
                .count()
        };
        let before = dumped();
        let second = scan_with(&host, 1, Some(&mut live)).await.unwrap();
        assert_eq!(second["panes"][0]["state"], "working");
        assert_eq!(dumped(), before, "a live screen is not dumped again");
        server.abort();
    }
    #[test]
    fn claude_hook_events_map_to_status() {
        let event = |name: &str, extra: Value| {
            let mut event = json!({"hook_event_name":name,"session_id":"s","prompt_id":"p1"});
            event
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            hook_status("claude", &event).map(|h| h.state)
        };
        assert_eq!(event("UserPromptSubmit", json!({})), Some("working"));
        assert_eq!(event("PostToolUse", json!({})), Some("working"));
        assert_eq!(event("PermissionRequest", json!({})), Some("approval"));
        assert_eq!(
            event(
                "Notification",
                json!({"notification_type":"permission_prompt"})
            ),
            Some("approval")
        );
        assert_eq!(
            event(
                "Notification",
                json!({"notification_type":"elicitation_dialog"})
            ),
            Some("input")
        );
        assert_eq!(
            event("Notification", json!({"notification_type":"idle_prompt"})),
            None
        );
        assert_eq!(event("SessionStart", json!({})), Some("unknown"));
        for source in ["startup", "resume", "clear", "fork"] {
            assert_eq!(
                event("SessionStart", json!({"source":source})),
                Some("ready")
            );
        }
        assert_eq!(
            event("SessionStart", json!({"source":"compact"})),
            Some("unknown")
        );
        // Claude Code 2.1.318: Stop lists the background tasks a finished turn left running.
        let shell =
            json!({"id":"b","type":"shell","status":"running","command":"sleep 8 && echo BG_DONE"});
        let agent =
            json!({"id":"a","type":"subagent","status":"running","agent_type":"general-purpose"});
        assert_eq!(
            event("Stop", json!({"background_tasks":[shell]})),
            Some("ready"),
            "on its own a shell does not keep the turn open; `hook` waits for new ones"
        );
        assert_eq!(
            event("Stop", json!({"background_tasks":[shell, agent]})),
            Some("waiting")
        );
        let done = json!({"id":"a","type":"subagent","status":"completed"});
        assert_eq!(
            event("Stop", json!({"background_tasks":[done]})),
            Some("ready")
        );
        assert_eq!(event("Stop", json!({"background_tasks":[]})), Some("ready"));
        let finished = |prompt: &str| {
            hook_status(
                "claude",
                &json!({"hook_event_name":"Stop","prompt_id":prompt,"background_tasks":[]}),
            )
            .unwrap()
            .token
        };
        assert_ne!(
            finished("p1"),
            finished("p2"),
            "each finished turn is a new result"
        );
    }
    #[test]
    fn switchboard_claude_subagent_dialog_overrides_parent_hooks() {
        let pane = json!({"id":21,"tab_id":21,"pane_command":"claude","title":"Cleanup PR"});
        // Captured with dump-screen on 2026-11-09: a subagent's cleanup needs
        // permission while the parent Stop hook reports a running background agent.
        let approval = include_str!("fixtures/claude-subagent-approval.txt");
        let question =
            "Which cleanup scope?\n❯ 1. Session only\n  2. Session and files\nEsc to cancel";
        let scan = |screen: &str| {
            snapshot(
                "main",
                std::slice::from_ref(&pane),
                &HashMap::from([(21, screen.to_owned())]),
                false,
            )
        };
        for event in [
            json!({"hook_event_name":"UserPromptSubmit"}),
            json!({"hook_event_name":"Stop","background_tasks":[{"type":"subagent","status":"running"}]}),
            json!({"hook_event_name":"Stop","prompt_id":"finished"}),
        ] {
            let mut poll = PollState::default();
            let mut hook = hook_status("claude", &event).unwrap();
            hook.chat_id = Some("claude-cleanup".into());
            let hook_state = hook.state;
            poll.hooks.insert(("main".into(), 21), hook);
            for (screen, expected) in [(approval, "approval"), (question, "input")] {
                assert_eq!(classify(&pane, screen)["state"], expected);
                let mut shown = scan(screen);
                poll.update("windows", &mut shown);
                assert_eq!(shown["panes"][0]["state"], expected, "{event}");
                assert_eq!(shown["panes"][0]["turn_state"], hook_state);
                assert_eq!(shown["panes"][0]["chat_id"], "claude-cleanup");
                assert_ne!(shown["panes"][0]["seen"], true);
                assert_eq!(poll.hooks[&("main".into(), 21)].state, hook_state);
            }
            // Closing the dialog exposes the parent's unchanged turn state.
            let mut resumed = scan("✻ Waiting for 1 background agent to finish");
            poll.update("windows", &mut resumed);
            assert_eq!(resumed["panes"][0]["state"], hook_state);
        }
    }

    #[test]
    fn claude_approval_does_not_hide_a_running_approved_tool() {
        let pane =
            json!({"id":21,"tab_id":21,"pane_command":"claude","title":"✳ Demo benchmark mining"});
        // Claude Code 2.1.318, excerpt captured from this pane with dump-screen.
        let running = "● Rendering each run's transcript as a readable log\n\
            · Herding… (1m 0s · ↓ 3.8k tokens)\n\
            ──────────\n\
            ❯ \n\
            ──────────\n\
              ⏵⏵ bypass permissions on (shift+tab to cycle) · ⧉ demo-video-benchmarks · esc to interrupt";
        assert_eq!(classify(&pane, running)["state"], "working");
        let scan = |screen: &str| {
            snapshot(
                "main",
                std::slice::from_ref(&pane),
                &HashMap::from([(21, screen.to_owned())]),
                false,
            )
        };
        let mut poll = PollState::default();
        poll.hooks.insert(
            ("main".into(), 21),
            hook_status("claude", &json!({"hook_event_name":"PermissionRequest"})).unwrap(),
        );
        let mut unreadable = scan("");
        poll.update("windows", &mut unreadable);
        assert_eq!(unreadable["panes"][0]["state"], "approval");

        // Approval has been given, but PostToolUse will not arrive until the tool ends.
        let mut approved = scan(running);
        poll.update("windows", &mut approved);
        assert_eq!(approved["panes"][0]["state"], "working");

        // Keep the hook as a fallback if the dialog is unreadable or appears again.
        let dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel";
        assert_eq!(classify(&pane, dialog)["state"], "approval");
        let mut awaiting = scan(dialog);
        poll.update("windows", &mut awaiting);
        assert_eq!(awaiting["panes"][0]["state"], "approval");
        let mut unreadable = scan("");
        poll.update("windows", &mut unreadable);
        assert_eq!(unreadable["panes"][0]["state"], "approval");
    }

    #[test]
    fn codex_compaction_does_not_inherit_the_previous_turns_stop() {
        let pane = json!({"id":39,"tab_id":38,"pane_command":"codex","title":"Find Muse mobile support chat | switchboard"});
        // Captured with dump-screen on 2026-11-06, while a follow-up compacted
        // context before UserPromptSubmit replaced the preceding turn's Stop.
        let compacting = "Worked for 20m 50s • 10:03 PM\n\
            › how do the terminals look on such a small screen tho? Render it.\n\
            • Compacting context (1m 07s • esc to interrupt)\n\
              └ Making room to continue.\n\
            • Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n\
              ↳ take screenshots for me but dont post it ...\n\
            › Ask Codex to do anything\n\
              GPT-6-Astra medium · ~/git/switchboard/tools/switchboard · Find Muse mobile support chat\n\
              ? for shortcuts                                            ⚠ 2 warnings · f2 to view";
        assert_eq!(classify(&pane, compacting)["state"], "working");
        let idle = "Worked for 20m 50s • 10:03 PM\n› Ask Codex to do anything\nGPT-6-Astra medium\n? for shortcuts";
        let scan = |pane: &Value, screen: Option<&str>| {
            snapshot(
                "main",
                std::slice::from_ref(pane),
                &screen
                    .map(|s| HashMap::from([(39, s.to_owned())]))
                    .unwrap_or_default(),
                screen.is_none(),
            )
        };
        let mut poll = PollState::default();
        poll.hooks.insert(
            ("main".into(), 39),
            hook_status(
                "codex",
                &json!({"hook_event_name":"Stop","turn_id":"previous"}),
            )
            .unwrap(),
        );
        let mut finished = scan(&pane, Some(idle));
        poll.update("mac", &mut finished);
        let token = finished["panes"][0]["token"].clone();
        for titled in [false, true] {
            let mut pane = pane.clone();
            if titled {
                pane["title"] = json!("⠦ Find Muse mobile support chat | switchboard");
            }
            let mut running = scan(&pane, Some(compacting));
            poll.update("mac", &mut running);
            assert_eq!(running["panes"][0]["state"], "working");
            assert!(running["panes"][0].get("token").is_none());
        }
        // Retain the completed result when no active screen is available.
        for screen in [None, Some(idle)] {
            let mut finished = scan(&pane, screen);
            poll.update("mac", &mut finished);
            assert_eq!(finished["panes"][0]["state"], "ready");
            assert_eq!(finished["panes"][0]["token"], token);
        }
    }

    #[tokio::test]
    async fn claude_stop_waits_for_a_shell_started_this_turn_only() {
        let state = RelayState {
            hosts: Default::default(),
            order: Default::default(),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: None,
            askpass: Default::default(),
            html_previews: Default::default(),
            artifact_proxies: Default::default(),
            push: None,
            browser_origin: None,
        };
        let stop = |tasks: Value| {
            let mut headers = HeaderMap::new();
            headers.insert("x-zellij-session", "main".parse().unwrap());
            headers.insert("x-zellij-pane", "3".parse().unwrap());
            let event = json!({"hook_event_name":"Stop","prompt_id":"p","background_tasks":tasks});
            let state = state.clone();
            async move {
                hook(State(state.clone()), headers, Json(event)).await;
                let poll = state.poll.lock().await;
                poll.hooks[&("main".to_owned(), 3)].state
            }
        };
        // Claude Code 2.1.318 Stop payload fields.
        let shell = |id: &str, status: &str| json!({"id":id,"type":"shell","status":status,"command":"gh pr checks 1 --watch"});
        assert_eq!(
            stop(json!([shell("ci", "running")])).await,
            "waiting",
            "a CI watch started this turn"
        );
        assert_eq!(
            stop(json!([shell("ci", "running")])).await,
            "ready",
            "still running at the next Stop, like a dev server"
        );
        assert_eq!(
            stop(json!([shell("ci", "running"), shell("build", "running")])).await,
            "waiting",
            "a new wait beside the old shell"
        );
        assert_eq!(
            stop(json!([shell("ci", "running"), shell("build", "completed")])).await,
            "ready"
        );
        assert_eq!(stop(json!([])).await, "ready");
    }

    fn shell_wait() -> Hooked {
        Hooked {
            agent: "claude",
            state: "waiting",
            token: None,
            chat_id: Some("chat".into()),
            restart: None,
            capturing: None,
            at: 0,
            shell_hold: true,
            idle_since: None,
        }
    }

    #[test]
    fn claude_idle_footer_counts_running_tasks_but_not_the_agent_hint() {
        let pane = json!({"pane_command":"claude.exe --dangerously-skip-permissions","title":"✳ Claude Code"});
        // Claude Code 2.1.319, idle with a background shell running.
        let running = "● WAITING\n\n✻ Crunched for 5s · done 23:59 · 1 shell still running\n\n\
            ────\n❯\u{a0}\n────\n  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent · ↓ to manage\n";
        let classified = classify(&pane, running);
        assert_eq!(classified["state"], "ready");
        assert_eq!(classified["footer_tasks"], true);
        // The same session after /tasks stopped the shell: no new turn, and no prompt row.
        let stopped = "❯ Run sleep 900 with the Bash tool and run_in_background true, then reply only STARTED2.\n\n\
            ● Task \"Sleep for 900 seconds in background\" was stopped by the user\n\n\
            ● Bash(sleep 900)\n  ⎿  Running in the background (↓ to manage)\n\n● STARTED2\n\n\
            ✻ Worked for 3s · done 0:00\n\n────\n────\n\
              ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent\n";
        let classified = classify(&pane, stopped);
        assert_eq!(classified["state"], "ready");
        assert!(classified.get("footer_tasks").is_none());
    }

    #[test]
    fn switchboard_chat_id_carries_the_agent_that_owns_the_chat() {
        let mut poll = PollState::default();
        poll.hooks.insert(
            ("main".to_owned(), 3),
            Hooked {
                state: "working",
                shell_hold: false,
                ..shell_wait()
            },
        );
        let mut restarted = PollState::default();
        restarted.restore_hooks(&poll.persisted()["hooks"]);
        // The launch prompt is part of the command, and it can name the other agent.
        let command = json!("claude --model claude-opus-5-5 -- continue the codex chat");
        let mut row = classify(&json!({"pane_command":command}), "");
        row["session"] = json!("main");
        row["pane_id"] = json!(3);
        restarted.apply_hook(&mut row, &command);
        assert_eq!(row["chat_id"], "chat");
        assert_eq!(row["agent"], "claude");
    }

    #[test]
    fn claude_turn_ended_by_esc_is_ready_despite_its_last_working_hook() {
        let pane = json!({"pane_command":"claude.exe","title":"✳ Claude Code"});
        let footer = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent\n";
        let working = || {
            let mut poll = PollState::default();
            let event = json!({"hook_event_name":"UserPromptSubmit"});
            poll.hooks
                .insert(("main".into(), 3), hook_status("claude", &event).unwrap());
            poll
        };
        let applied = |poll: &mut PollState, mut row: Value| {
            row["session"] = json!("main");
            row["pane_id"] = json!(3);
            poll.apply_hook(&mut row, &json!("claude.exe"));
            row["state"].clone()
        };
        // What Stop does with the pane's own screen once Esc has been sent.
        let state = |screen: String| {
            let mut poll = working();
            let row = classify(&pane, &screen);
            if row["interrupted"] == true {
                poll.settle_interrupted("main", 3);
            }
            applied(&mut poll, row)
        };
        // An unwatched pane's feed can be arbitrarily old in either direction.
        let old_marker =
            json!({"state":"ready","agent":"claude","token":"idle","interrupted":true});
        assert_eq!(applied(&mut working(), old_marker), "working");
        let mut stopped = working();
        stopped.settle_interrupted("main", 3);
        let old_frame = json!({"state":"working","agent":"claude"});
        assert_eq!(applied(&mut stopped, old_frame), "ready");

        // Claude Code 2.1.319, captured with dump-screen: Esc at "(3s · thinking)", before any
        // output, erased the prompt and drew no marker.
        let rule = "─".repeat(40);
        let idle_footer = "  ⏵⏵ auto mode on (shift+tab to cycle)\n\n";
        let busy_footer =
            "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent\n\n";
        let banner = " ▐▛███▛█   Claude Code v2.1.319\n";
        assert!(stopped_after_escape(&format!(
            "{banner}{rule}\n{rule}\n{idle_footer}"
        )));
        assert!(!stopped_after_escape(&format!(
            "{banner}· Hatching… (3s · thinking)\n{rule}\n❯ \n{rule}\n{busy_footer}"
        )));
        // Still busy with no spinner drawn, as between a tool and the next reply.
        assert!(!stopped_after_escape(&format!(
            "{banner}{rule}\n{rule}\n{busy_footer}"
        )));
        // A dialog Esc did not dismiss has no prompt footer.
        assert!(!stopped_after_escape(&format!(
            "{banner}Do you want to proceed?\n ❯ 1. Yes\n   2. No\nEsc to cancel · Enter to confirm\n"
        )));

        // Claude Code 2.1.319 after Esc, during a tool and while thinking; neither sends a hook.
        let mid_tool = "❯ run ping\n● Bash(ping -n 90 127.0.0.1)\n  ⎿\u{a0} Interrupted · What should Claude do instead?\n\n";
        let thinking = "❯ run sleep\n● The sleep didn't run.\n  ⎿\u{a0} Interrupted · What should Claude do instead?\n\n";
        assert_eq!(
            state(format!("{mid_tool}────\n❯\u{a0}\n────\n{footer}")),
            "ready"
        );
        assert_eq!(state(format!("{thinking}────\n────\n{footer}")), "ready");
        // The same box with the prompt scrolled away, so no ❯ is on screen at all.
        let scrolled = thinking.trim_start_matches("❯ run sleep\n");
        assert_eq!(state(format!("{scrolled}────\n────\n{footer}")), "ready");
        assert_eq!(
            state(format!("{mid_tool}────\n❯ a draft\n────\n{footer}")),
            "ready"
        );
        // The next turn's prompt follows the old marker, so its working hook stands again.
        assert_eq!(
            state(format!(
                "{mid_tool}❯ try again\n\n────\n❯\u{a0}\n────\n{footer}"
            )),
            "working"
        );
    }

    // Claude Code 2.1.319 after denying a Bash approval with Esc or "No"; neither sends a hook.
    const DENIED: &str = "❯ run echo\n\n● Bash(echo denial-test > out.txt)\n  ⎿  Interrupted · What should Claude do instead?\n\n✻ Brewed for 7s · done 18:27\n──────────────────────────────────────────────────❯ \n──────────────────────────────────────────────────  ⏸ manual mode on · ? for shortcuts · ← 1 agent                              ◐ medium · /effort\n";

    fn approval_poll() -> PollState {
        let mut poll = PollState::default();
        let event = json!({"hook_event_name":"PermissionRequest"});
        poll.hooks
            .insert(("main".into(), 3), hook_status("claude", &event).unwrap());
        poll
    }

    #[test]
    fn claude_denied_approval_is_ready_once_settled() {
        let pane = json!({"pane_command":"claude.exe"});
        let mut row = classify(&pane, DENIED);
        assert_eq!(row["interrupted"], true, "{row}");
        let mut poll = approval_poll();
        poll.settle_interrupted("main", 3);
        row["session"] = json!("main");
        row["pane_id"] = json!(3);
        poll.apply_hook(&mut row, &json!("claude.exe"));
        assert_eq!(row["state"], "ready");
        // The denial marker is history once a later turn's prompt follows it.
        let later = format!(
            "{}\n❯ try again\n\n──────\n❯\u{a0}\n──────\n  ⏸ manual mode on · ? for shortcuts\n",
            DENIED.split("──").next().unwrap()
        );
        assert_ne!(classify(&pane, &later)["interrupted"], true);
    }

    #[test]
    fn claude_denied_approval_queues_one_settle_until_the_marker_leaves() {
        let mut poll = approval_poll();
        let scan = |poll: &mut PollState, state: &str, interrupted: bool| {
            let mut row = json!({"session":"main","pane_id":3,"state":state,"agent":"claude","token":"idle","command":"claude.exe"});
            if interrupted {
                row["interrupted"] = json!(true);
            }
            let mut snapshot = json!({"panes":[row],"tabs":[],"errors":[]});
            poll.update("local", &mut snapshot);
            std::mem::take(&mut poll.settling)
        };
        let settle = vec![("main".to_owned(), 3)];
        assert_eq!(scan(&mut poll, "approval", false), []);
        assert_eq!(scan(&mut poll, "ready", true), settle);
        assert_eq!(scan(&mut poll, "ready", true), []);
        // A screen that no longer shows the marker arms it again.
        assert_eq!(scan(&mut poll, "approval", false), []);
        assert_eq!(scan(&mut poll, "ready", true), settle);
    }

    #[test]
    fn switchboard_prune_drops_only_panes_gone_for_30_days() {
        let old = unix_seconds() - 31 * 24 * 3600;
        let key = |host: &str, pane: u64| json!([host, "main", pane]).to_string();
        let fresh = || {
            let mut poll = PollState::default();
            let event = json!({"hook_event_name":"UserPromptSubmit"});
            let row = |since| json!({"state":"ready","generation":0,"since":since});
            for pane in [1, 3] {
                poll.observed.insert(key("local", pane), row(old));
            }
            poll.observed.insert(key("local", 2), row(unix_seconds()));
            poll.observed.insert(key("peer", 9), row(old));
            for pane in [1, 2, 3] {
                let hook = hook_status("claude", &event).unwrap();
                poll.hooks.insert(("main".into(), pane), hook);
            }
            poll.stop_shells
                .insert(("main".into(), 1), vec!["server".into()]);
            poll.unreadable.insert(key("local", 1));
            let long_ago = tokio::time::Instant::now() - Duration::from_secs(60);
            poll.scanned.insert(key("local", 7), long_ago);
            poll.sessions_scanned.insert(key("local", 7), long_ago);
            poll
        };
        let listed = json!([{"session":"main","pane_id":3}]);
        let live = json!({"panes":listed,"tabs":[],"errors":[],"deferred_sessions":[]});

        let mut poll = fresh();
        poll.prune_closed("local", &live);
        assert!(!poll.observed.contains_key(&key("local", 1)));
        assert!(!poll.hooks.contains_key(&("main".to_owned(), 1)));
        assert!(!poll.stop_shells.contains_key(&("main".to_owned(), 1)));
        assert!(!poll.unreadable.contains(&key("local", 1)));
        assert!(poll.dirty);
        assert!(poll.scanned.is_empty() && poll.sessions_scanned.is_empty());
        // Closed recently, still listed, and another computer's row all stay.
        assert!(poll.observed.contains_key(&key("local", 2)));
        assert!(poll.hooks.contains_key(&("main".to_owned(), 2)));
        assert!(poll.observed.contains_key(&key("local", 3)));
        assert!(poll.hooks.contains_key(&("main".to_owned(), 3)));
        assert!(poll.observed.contains_key(&key("peer", 9)));

        for partial in [
            json!({"panes":[],"tabs":[],"errors":[],"deferred_sessions":[]}),
            json!({"panes":listed,"tabs":[],"errors":[{"message":"x"}],"deferred_sessions":[]}),
            json!({"panes":listed,"tabs":[],"errors":[],"deferred_sessions":["main"]}),
        ] {
            let mut poll = fresh();
            poll.prune_closed("local", &partial);
            assert!(poll.observed.contains_key(&key("local", 1)), "{partial}");
            assert!(
                poll.hooks.contains_key(&("main".to_owned(), 1)),
                "{partial}"
            );
            assert!(!poll.dirty, "{partial}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn claude_shell_wait_ends_when_switchboard_stops_its_tasks() {
        let mut poll = PollState::default();
        poll.hooks.insert(("main".into(), 6), shell_wait());
        poll.end_shell_wait("main", 6);
        let hook = &poll.hooks[&("main".to_owned(), 6)];
        assert_eq!(hook.state, "unknown");
        assert!(!hook.shell_hold);
    }

    #[tokio::test(start_paused = true)]
    async fn claude_shell_wait_ends_once_the_footer_stays_clear() {
        let key = ("main".to_owned(), 3);
        let mut poll = PollState::default();
        poll.hooks.insert(key.clone(), shell_wait());
        // Seconds since the last scan, whether the footer counts a task, the state shown.
        // The count coming back restarts the wait for a clear footer.
        for (wait, tasks, expected) in [
            (0, false, "waiting"),
            (29, false, "waiting"),
            (0, true, "waiting"),
            (0, false, "waiting"),
            (29, false, "waiting"),
            (2, false, "ready"),
        ] {
            tokio::time::advance(Duration::from_secs(wait)).await;
            let mut row = json!({"session":"main","pane_id":3,"state":"ready","agent":"claude","token":"idle"});
            if tasks {
                row["footer_tasks"] = json!(true);
            }
            poll.apply_hook(&mut row, &json!("claude.exe"));
            assert_eq!(row["state"], expected);
        }
        assert_eq!(poll.hooks[&key].state, "unknown");
    }

    #[tokio::test(start_paused = true)]
    async fn claude_agent_wait_ignores_a_clear_footer() {
        let key = ("main".to_owned(), 3);
        let mut poll = PollState::default();
        poll.hooks.insert(
            key.clone(),
            Hooked {
                shell_hold: false,
                ..shell_wait()
            },
        );
        for _ in 0..2 {
            let mut row = json!({"session":"main","pane_id":3,"state":"ready","agent":"claude","token":"idle"});
            poll.apply_hook(&mut row, &json!("claude.exe"));
            assert_eq!(row["state"], "waiting");
            tokio::time::advance(Duration::from_secs(60)).await;
        }
    }

    #[test]
    fn relay_restart_keeps_shell_waits_and_the_shells_already_seen() {
        let key = ("main".to_owned(), 3);
        let mut poll = PollState::default();
        poll.hooks.insert(key.clone(), shell_wait());
        poll.stop_shells.insert(key.clone(), vec!["server".into()]);
        let mut restarted = PollState::default();
        restarted.restore_hooks(&poll.persisted()["hooks"]);
        assert_eq!(restarted.stop_shells[&key], ["server"]);
        assert!(restarted.hooks[&key].shell_hold);
    }

    #[tokio::test]
    async fn hook_status_replaces_the_screen_for_its_own_claude_pane_only() {
        let state = RelayState {
            hosts: Default::default(),
            order: Default::default(),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: None,
            askpass: Default::default(),
            html_previews: Default::default(),
            artifact_proxies: Default::default(),
            push: None,
            browser_origin: None,
        };
        let send = |event: Value, pane: Option<&str>| {
            let mut headers = HeaderMap::new();
            headers.insert("x-zellij-session", "main".parse().unwrap());
            headers.insert("x-claude-nested", "".parse().unwrap());
            if let Some(pane) = pane {
                headers.insert("x-zellij-pane", pane.parse().unwrap());
            }
            hook(State(state.clone()), headers, Json(event))
        };
        let scan = |command: &str| json!({"panes":[{"session":"main","pane_id":3,"state":"unknown","command":command}],"tabs":[],"errors":[]});
        assert_eq!(
            send(json!({"hook_event_name":"UserPromptSubmit"}), None).await,
            StatusCode::NO_CONTENT
        );
        assert!(
            state.poll.lock().await.hooks.is_empty(),
            "outside Zellij there is no pane"
        );
        send(json!({"hook_event_name":"UserPromptSubmit"}), Some("3")).await;
        let mut poll = state.poll.lock().await;
        let mut working = scan("/Users/dom/.local/bin/claude --resume");
        poll.update("mac", &mut working);
        assert_eq!(working["panes"][0]["state"], "working");
        assert!(
            working["panes"][0].get("command").is_none(),
            "the command stays on this relay"
        );
        let mut peer = json!({"panes":[{"session":"main","pane_id":3,"state":"unknown"}],"tabs":[],"errors":[]});
        poll.update("peer", &mut peer);
        assert_eq!(
            peer["panes"][0]["state"], "unknown",
            "a peer's pane 3 is another pane"
        );
        drop(poll);
        send(
            json!({"hook_event_name":"Stop","prompt_id":"p1","background_tasks":[]}),
            Some("3"),
        )
        .await;
        let mut poll = state.poll.lock().await;
        let mut ready = scan("claude");
        poll.update("mac", &mut ready);
        assert_eq!(ready["panes"][0]["state"], "ready");
        assert!(
            ready["panes"][0]["token"].as_str().unwrap().ends_with(":1"),
            "{ready}"
        );
        let mut shell = scan("nu");
        poll.update("mac", &mut shell);
        assert_eq!(
            shell["panes"][0]["state"], "unknown",
            "Claude left this pane"
        );
        assert!(poll.hooks.is_empty());
        drop(poll);
        send(json!({"hook_event_name":"UserPromptSubmit"}), Some("3")).await;
        let mut nested = HeaderMap::new();
        for (name, value) in [
            ("x-zellij-session", "main"),
            ("x-zellij-pane", "3"),
            ("x-claude-nested", "1"),
        ] {
            nested.insert(name, value.parse().unwrap());
        }
        hook(
            State(state.clone()),
            nested,
            Json(json!({"hook_event_name":"SessionEnd"})),
        )
        .await;
        assert_eq!(
            state.poll.lock().await.hooks.len(),
            1,
            "a Claude run by this pane's Claude does not end its status"
        );
        send(json!({"hook_event_name":"SessionEnd"}), Some("3")).await;
        assert!(state.poll.lock().await.hooks.is_empty());
    }
    #[tokio::test]
    async fn codex_and_copilot_hooks_report_status_for_their_own_agent() {
        let state = RelayState {
            hosts: Default::default(),
            order: Default::default(),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: None,
            askpass: Default::default(),
            html_previews: Default::default(),
            artifact_proxies: Default::default(),
            push: None,
            browser_origin: None,
        };
        let send = |agent: &str, event: Value| {
            let mut headers = HeaderMap::new();
            for (name, value) in [
                ("x-zellij-session", "main"),
                ("x-zellij-pane", "3"),
                ("x-agent", agent),
            ] {
                headers.insert(name, value.parse().unwrap());
            }
            hook(State(state.clone()), headers, Json(event))
        };
        let scan = |command: &str| json!({"panes":[{"session":"main","pane_id":3,"state":"unknown","command":command}],"tabs":[],"errors":[]});
        send("gemini", json!({"hook_event_name":"UserPromptSubmit"})).await;
        assert!(state.poll.lock().await.hooks.is_empty(), "unknown agent");
        // codex-cli 0.164: Stop names its turn, so each finished turn is a new result.
        let mut tokens = Vec::new();
        for turn in ["t1", "t2"] {
            send(
                "codex",
                json!({"hook_event_name":"UserPromptSubmit","turn_id":turn}),
            )
            .await;
            let mut working = scan("codex");
            state.poll.lock().await.update("mac", &mut working);
            assert_eq!(working["panes"][0]["state"], "working");
            assert_eq!(working["panes"][0]["agent"], "codex");
            send(
                "codex",
                json!({"hook_event_name":"Stop","session_id":"s","turn_id":turn}),
            )
            .await;
            let mut ready = scan("codex");
            state.poll.lock().await.update("mac", &mut ready);
            assert_eq!(ready["panes"][0]["state"], "ready", "{ready}");
            tokens.push(ready["panes"][0]["token"].clone());
        }
        assert_ne!(tokens[0], tokens[1]);
        assert!(tokens[1].as_str().unwrap().ends_with(":2"), "{tokens:?}");
        send(
            "codex",
            json!({"hook_event_name":"Interrupt","turn_id":"t3"}),
        )
        .await;
        assert!(
            state.poll.lock().await.hooks.is_empty(),
            "interrupt reads the screen"
        );
        // Copilot 1.0.105 PascalCase hooks: no turn ID, an ISO timestamp per event.
        let stop = |at: &str| json!({"hook_event_name":"Stop","session_id":"s","timestamp":at,"stop_reason":"end_turn"});
        let first = hook_status("copilot", &stop("2026-11-04T06:14:01.711Z")).unwrap();
        let second = hook_status("copilot", &stop("2026-11-04T06:15:00.000Z")).unwrap();
        assert_ne!(first.token, second.token);
        send(
            "copilot",
            json!({"hook_event_name":"Notification","notification_type":"permission_prompt"}),
        )
        .await;
        let mut approval = scan("/opt/homebrew/bin/copilot");
        state.poll.lock().await.update("mac", &mut approval);
        assert_eq!(approval["panes"][0]["state"], "approval");
        assert_eq!(approval["panes"][0]["agent"], "copilot");
        let mut claude = scan("claude");
        state.poll.lock().await.update("mac", &mut claude);
        assert_eq!(
            claude["panes"][0]["state"], "unknown",
            "Copilot left this pane"
        );
        assert!(state.poll.lock().await.hooks.is_empty());
    }
    #[test]
    fn switchboard_claude_start_binds_conversation_before_first_prompt() {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap().join(".claude"));
        let mut event = json!({"hook_event_name":"SessionStart", "source":"resume",
            "session_id":"6af084f2-0b7d-4ac5-9c1c-0bd11e5f577c",
            "transcript_path":root.join("projects/test/6af084f2-0b7d-4ac5-9c1c-0bd11e5f577c.jsonl")});
        for source in ["startup", "resume", "clear", "fork", "compact"] {
            event["source"] = json!(source);
            let hooked = hook_status("claude", &event).unwrap();
            let id = hooked
                .chat_id
                .clone()
                .expect("startup reports exact transcript");
            assert!(hooked.token.is_none(), "startup is not an unread reply");
            let mut poll = PollState::default();
            poll.hooks.insert(("main".into(), 80), hooked);
            let mut pane =
                json!({"session":"main","pane_id":80,"agent":"claude","state":"working"});
            poll.apply_hook(&mut pane, &json!("claude"));
            assert_eq!(pane["chat_id"], id);
            assert_eq!(
                pane["state"], "working",
                "startup must not hide active work"
            );
        }
        let config: Value = serde_json::from_str(include_str!(
            "../../../plugins/switchboard/hooks/hooks.json"
        ))
        .unwrap();
        let hooks = config["hooks"]["SessionStart"][0]["hooks"]
            .as_array()
            .unwrap();
        assert!(hooks.iter().any(|hook| hook["command"] == "zellij"
            && hook["args"] == json!(["agent-hook", "--agent", "claude"])));
        let turn = &config["hooks"]["UserPromptSubmit"][0]["hooks"][0];
        let request = hook_request(
            "claude",
            &b"{}"[..],
            |name| match name {
                "ZELLIJ_SESSION_NAME" => Some("main".into()),
                "ZELLIJ_PANE_ID" => Some("80".into()),
                _ => None,
            },
            "http://127.0.0.1:8090",
        )
        .unwrap();
        for (header, variable, expected) in [
            ("X-Zellij-Session", "ZELLIJ_SESSION_NAME", "main"),
            ("X-Zellij-Pane", "ZELLIJ_PANE_ID", "80"),
        ] {
            assert_eq!(turn["headers"][header], format!("${variable}"));
            assert_eq!(request.headers()[header], expected);
        }
    }

    #[tokio::test]
    async fn switchboard_claude_http_ignores_nested_agents_and_missing_panes() {
        let state = RelayState {
            hosts: Default::default(),
            order: Default::default(),
            port: 0,
            attention: Default::default(),
            poll: Default::default(),
            mesh: None,
            candidates: Default::default(),
            artifact: None,
            askpass: Default::default(),
            html_previews: Default::default(),
            artifact_proxies: Default::default(),
            push: None,
            browser_origin: None,
        };
        for (pane, nested, entrypoint, codex_thread, accepted) in [
            ("", "", "", "", false),
            ("bad", "", "", "", false),
            ("3", "1", "sdk-cli", "", false),
            ("3", "1", "", "", false),
            ("3", "1", "cli", "", true),
            ("4", "", "", "", true),
            ("3", "1", "cli", "parent-codex-thread", false),
            ("4", "", "", "parent-codex-thread", false),
        ] {
            let mut headers = HeaderMap::new();
            for (key, value) in [
                ("x-zellij-session", "main"),
                ("x-zellij-pane", pane),
                ("x-claudecode", nested),
                ("x-claude-entrypoint", entrypoint),
                ("x-codex-thread-id", codex_thread),
            ] {
                headers.insert(key, value.parse().unwrap());
            }
            let response = claude_http_hook(
                State(state.clone()),
                headers,
                Json(json!({"hook_event_name":"UserPromptSubmit"})),
            )
            .await;
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            let mut poll = state.poll.lock().await;
            assert_eq!(
                !poll.hooks.is_empty(),
                accepted,
                "{pane}/{nested}/{entrypoint}/{codex_thread}"
            );
            poll.hooks.clear();
        }
        let mut parent = hook_status("codex", &json!({"hook_event_name":"PostToolUse"})).unwrap();
        parent.chat_id = Some("codex-parent".into());
        let key = ("main".into(), 3);
        state
            .poll
            .lock()
            .await
            .hooks
            .insert(key.clone(), parent.clone());
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap().join(".claude"));
        for event in ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"] {
            let mut headers = HeaderMap::new();
            for (name, value) in [
                ("x-zellij-session", "main"),
                ("x-zellij-pane", "3"),
                ("x-claudecode", "1"),
                ("x-claude-entrypoint", "cli"),
                ("x-codex-thread-id", "parent-codex-thread"),
            ] {
                headers.insert(name, value.parse().unwrap());
            }
            claude_http_hook(
                State(state.clone()),
                headers,
                Json(json!({"hook_event_name":event,
                    "session_id":"00000000-0000-4000-8000-000000000002",
                    "transcript_path":root.join("projects/example/child-review.jsonl"),
                    "prompt":"Review the integrated readiness design"})),
            )
            .await;
            assert_eq!(state.poll.lock().await.hooks[&key], parent, "{event}");
        }
    }

    #[tokio::test]
    async fn switchboard_conversation_binding_survives_a_foreground_tool() {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
        let pid = Pid::from_u32(std::process::id());
        let mut processes = System::new();
        processes.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
        );
        let process = processes.process(pid).unwrap();
        let mut identity = json!({
            "agent":"claude", "session_id":"6af084f2-0b7d-4ac5-9c1c-0bd11e5f577c",
            "cwd":std::env::current_dir().unwrap(), "pid":std::process::id(),
            "started":process.start_time(), "command":[], "executable":process.exe().unwrap()
        });
        let mut hook = hook_status("claude", &json!({"hook_event_name":"PostToolUse"})).unwrap();
        hook.chat_id = Some("claude-test-transcript".into());
        let captured = serde_json::from_value(identity.clone()).unwrap();
        hook.capturing = Some(uuid::Uuid::new_v4());
        let mut poll = PollState::default();
        let key = ("main".into(), 65);
        poll.hooks.insert(key.clone(), hook.clone());
        let row = || json!({"session":"main","pane_id":65,"state":"unknown"});
        // A scan racing the asynchronous capture cannot delete the new hook.
        let mut pane = row();
        poll.apply_hook(&mut pane, &json!("cargo test"));
        assert_eq!(pane["chat_id"], "claude-test-transcript");
        // Screen-derived bookkeeping during the capture must not leave its
        // pending flag stuck after the process result arrives.
        poll.hooks.get_mut(&key).unwrap().token = Some("screen-update".into());
        poll.captured(&key, &hook, Some(captured));
        assert!(poll.hooks[&key].capturing.is_none());
        let mut pane = row();
        let mut cache = ProcessCache::new();
        let checks = check_processes(
            &tokio::sync::Mutex::new({
                let mut copy = PollState::default();
                copy.restore_hooks(&poll.persisted()["hooks"]);
                copy
            }),
            &json!({"panes":[{"session":"main","pane_id":65,"command":"cargo test"}]}),
            &mut cache,
        )
        .await;
        poll.apply_hook_checked(&mut pane, &json!("cargo test"), &checks);
        assert_eq!(pane["chat_id"], "claude-test-transcript");
        assert_eq!(pane["state"], "working");

        let cached_at = cache[&key].2;
        let cached_poll = tokio::sync::Mutex::new({
            let mut copy = PollState::default();
            copy.restore_hooks(&poll.persisted()["hooks"]);
            copy
        });
        let snapshot = json!({"panes":[{"session":"main","pane_id":65,"command":"cargo test"}],"tabs":[],"errors":[]});
        for _ in 0..10 {
            let checks = check_processes(&cached_poll, &snapshot, &mut cache).await;
            let mut snapshot = snapshot.clone();
            poll.update_checked("local", &mut snapshot, &checks);
            assert_eq!(snapshot["panes"][0]["chat_id"], "claude-test-transcript");
        }
        assert_eq!(cache[&key].2, cached_at, "Redraws reuse the process check");

        // A relay restart must retain the transcript without reviving working state.
        let mut restarted = PollState::default();
        restarted.restore_hooks(&poll.persisted()["hooks"]);
        let mut pane = row();
        restarted.apply_hook_checked(&mut pane, &json!("cargo test"), &checks);
        assert_eq!(pane["chat_id"], "claude-test-transcript");
        assert_eq!(pane["state"], "unknown");

        // A reused PID with a different start time cannot retain an old binding.
        identity["started"] = json!(process.start_time().saturating_sub(1));
        hook.capturing = None;
        hook.restart = Some(serde_json::from_value(identity).unwrap());
        poll.hooks.insert(key, hook.clone());
        let mut pane = row();
        // A result from an older identity cannot delete a newly captured one.
        poll.apply_hook_checked(&mut pane, &json!("pwsh"), &checks);
        assert_eq!(pane["chat_id"], "claude-test-transcript");
        let checks = check_processes(
            &tokio::sync::Mutex::new({
                let mut copy = PollState::default();
                copy.restore_hooks(&poll.persisted()["hooks"]);
                copy
            }),
            &json!({"panes":[{"session":"main","pane_id":65,"command":"pwsh"}]}),
            &mut cache,
        )
        .await;
        let mut pane = row();
        poll.apply_hook_checked(&mut pane, &json!("pwsh"), &checks);
        assert!(pane["chat_id"].is_null());
        assert!(poll.hooks.is_empty());
        // A late capture cannot resurrect a hook deleted by SessionEnd.
        poll.captured(&("main".into(), 65), &hook, None);
        assert!(poll.hooks.is_empty());
    }

    #[test]
    fn switchboard_conversation_capture_survives_a_newer_approval_hook() {
        let mut working = hook_status("claude", &json!({"hook_event_name":"PostToolUse"})).unwrap();
        working.chat_id = Some("claude-test-transcript".into());
        let expected = working.begin_capture().unwrap();
        assert!(
            working.begin_capture().is_none(),
            "Only one capture per conversation"
        );
        let mut approval =
            hook_status("claude", &json!({"hook_event_name":"PermissionRequest"})).unwrap();
        approval.chat_id = working.chat_id.clone();
        approval.inherit_process(&working);
        assert!(
            approval.begin_capture().is_none(),
            "Newer state keeps the pending capture"
        );
        let key = ("main".into(), 65);
        let mut poll = PollState::default();
        poll.hooks.insert(key.clone(), approval);
        let mut pane = json!({"session":"main","pane_id":65,"state":"unknown"});
        poll.apply_hook(&mut pane, &json!("cargo test"));
        assert_eq!(pane["chat_id"], "claude-test-transcript");
        assert_eq!(pane["state"], "approval");
        // Even a failed capture must clear the original pending token, without
        // overwriting the newer approval or leaving the binding immortal.
        poll.captured(&key, &expected, None);
        assert!(poll.hooks[&key].capturing.is_none());
        assert_eq!(poll.hooks[&key].state, "approval");
        assert!(
            poll.hooks.get_mut(&key).unwrap().begin_capture().is_some(),
            "Approval events can recover a missing identity too"
        );
    }

    #[tokio::test]
    async fn switchboard_conversation_capture_outlives_its_request() {
        let mut hook = hook_status("claude", &json!({"hook_event_name":"PostToolUse"})).unwrap();
        hook.chat_id = Some("claude-test-transcript".into());
        let expected = hook.begin_capture().unwrap();
        let key = ("main".into(), 65);
        let poll = Arc::new(tokio::sync::Mutex::new(PollState::default()));
        poll.lock().await.hooks.insert(key.clone(), hook);
        let (finish, captured) = tokio::sync::oneshot::channel();
        let (started, job) = tokio::sync::oneshot::channel();
        let request_poll = poll.clone();
        let request_key = key.clone();
        let request = tokio::spawn(async move {
            let capture = spawn_capture(request_poll, request_key, expected, async move {
                captured.await.unwrap()
            });
            started.send(capture).unwrap();
            std::future::pending::<()>().await;
        });
        let job = job.await.unwrap();
        request.abort();
        let _ = request.await;
        finish.send(None).unwrap();
        job.await.unwrap();
        let poll = poll.lock().await;
        assert!(poll.hooks[&key].capturing.is_none());
        assert!(
            !poll.dirty,
            "Failed capture must not rewrite unchanged persisted state"
        );
    }

    #[test]
    fn switchboard_conversation_identity_follows_hooks_and_survives_restart() {
        let root = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap().join(".codex"));
        // Fields captured from the real Codex pane 65 PostToolUse event.
        let mut event = json!({"hook_event_name":"PostToolUse",
            "session_id":"01a1b11f-09b6-75b2-aea2-e1108e1424e1",
            "transcript_path":root.join("sessions/2026/11/07/rollout-2026-11-07T00-49-23-01a1b11f-09b6-75b2-aea2-e1108e1424e1.jsonl")});
        let hooked = hook_status("codex", &event).unwrap();
        let id = hooked.chat_id.clone().expect("exact transcript ID");
        let mut poll = PollState::default();
        poll.hooks.insert(("main".into(), 65), hooked);
        let row = || json!({"session":"main","pane_id":65,"agent":"codex","state":"working"});
        let mut pane = row();
        poll.apply_hook(&mut pane, &json!("codex"));
        assert_eq!(pane["chat_id"], id);
        let mut other = json!({"session":"main","pane_id":66,"state":"unknown"});
        poll.apply_hook(&mut other, &json!("codex"));
        assert!(other["chat_id"].is_null());
        let mut restarted = PollState::default();
        restarted.restore_hooks(&poll.persisted()["hooks"]);
        let mut pane = row();
        pane["state"] = json!("ready");
        restarted.apply_hook(&mut pane, &json!("codex"));
        assert_eq!(pane["chat_id"], id);
        assert_eq!(
            pane["state"], "ready",
            "restoring identity must not restore stale working status"
        );
        for name in ["Stop", "Interrupt"] {
            event["hook_event_name"] = json!(name);
            poll.hooks
                .insert(("main".into(), 65), hook_status("codex", &event).unwrap());
            let mut pane = row();
            poll.apply_hook(&mut pane, &json!("codex"));
            assert_eq!(pane["chat_id"], id);
            assert_eq!(
                pane["state"], "working",
                "screen still controls active work"
            );
        }
        let mut pane = row();
        poll.apply_hook(&mut pane, &json!("zsh"));
        assert!(pane["chat_id"].is_null());
        assert!(poll.hooks.is_empty(), "exited agents lose their binding");
    }

    #[test]
    fn switchboard_subagent_completion_prose_does_not_finish_the_parent() {
        // Captured from a Codex pane while its council reviews were running.
        let prose = "• Completed `/root/ui_council_sol`\n\
            • Sol says the main screens are ready for your review.\n\
            Opus is still reviewing the new screens.\n";
        for title in ["Example task", "⠼ Example task"] {
            let screen = format!(
                "{prose}• Working (7m 05s • esc to interrupt)\n\n\
                 › Ask Codex to do anything\n\n\
                 GPT-6.1-Sol high · project · Example task\n\
                 ← for agents · ? for shortcuts"
            );
            assert_eq!(
                classify(&json!({"pane_command":"codex","title":title}), &screen),
                json!({"state":"working","agent":"codex"})
            );
        }
    }

    #[test]
    fn switchboard_agent_identity_ignores_other_agents_in_launch_prompt() {
        // Bottom of a working Codex 0.167 pane captured with dump-screen.
        // Its launch prompt mentions Copilot; that is not its executable.
        let screen = "• Working (11m 27s • esc to interrupt)\n\n\
            › Ask Codex to do anything\n\n\
            GPT-6.1-Sol high · C:\\project · Example task\n\
            ← for agents · ? for shortcuts";
        for command in [
            r"C:\Users\example\OpenAI\Codex\bin\codex.exe -- launch a copilot session and ask claude",
            "codex -- ask copilot and claude",
            "node /opt/codex/bin/codex.js -- ask copilot",
        ] {
            assert_eq!(
                classify(
                    &json!({"pane_command":command,"title":"⠋ Example task"}),
                    screen
                ),
                json!({"state":"working","agent":"codex"}),
                "{command}"
            );
        }
    }

    #[test]
    fn forwarded_hooks_name_their_pane_and_agent() {
        let zellij = |name: &str| match name {
            "ZELLIJ_SESSION_NAME" => Some("main".to_owned()),
            "ZELLIJ_PANE_ID" => Some("7".to_owned()),
            _ => None,
        };
        let body = br#"{"hook_event_name":"Stop"}"#;
        let request = hook_request("copilot", &body[..], zellij, "http://127.0.0.1:8181").unwrap();
        assert_eq!(request.uri(), "http://127.0.0.1:8181/api/agent-hook");
        for (name, value) in [
            ("x-zellij-session", "main"),
            ("x-zellij-pane", "7"),
            ("x-agent", "copilot"),
        ] {
            assert_eq!(request.headers()[name], value);
        }
        assert_eq!(request.body(), body);
        assert!(
            hook_request("codex", &body[..], |_| None, "http://x").is_none(),
            "outside Zellij"
        );
        let claude = |entrypoint: &'static str| {
            move |name: &str| {
                zellij(name).or(match name {
                    "CLAUDECODE" => Some("1".to_owned()),
                    "CLAUDE_CODE_ENTRYPOINT" => Some(entrypoint.to_owned()),
                    _ => None,
                })
            }
        };
        assert!(
            hook_request("codex", &body[..], claude("cli"), "http://x").is_none(),
            "started by Claude in the same pane"
        );
        assert!(
            hook_request("claude", &body[..], claude("sdk-cli"), "http://x").is_none(),
            "claude -p started by a Claude tool"
        );
        // Claude Code sets CLAUDECODE=1 for its own hooks.
        assert!(hook_request("claude", &body[..], claude("cli"), "http://x").is_some());
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
        // Browsers keep the last status shown instead of flashing "Unavailable".
        assert_eq!(cold["errors"][0]["pending"], true);
    }

    #[test]
    fn restarting_peer_keeps_its_status_until_the_grace_period_ends() {
        let mut poll = PollState::default();
        let mut snapshot = json!({"panes":[{"session":"main","pane_id":1,"state":"working"}],"tabs":[{"session":"main","id":42}],"errors":[]});
        poll.update("peer", &mut snapshot);
        poll.peer_unavailable("peer", &anyhow::anyhow!("Connection refused"));
        let merged = poll.merged(&["peer".into()]);
        assert_eq!(merged["panes"][0]["state"], "working");
        assert_eq!(merged["errors"][0]["pending"], true);
        // Silent for longer than a restart: report it unavailable as before.
        poll.reached.insert(
            "peer".into(),
            tokio::time::Instant::now() - PEER_RESTART_GRACE,
        );
        poll.peer_unavailable("peer", &anyhow::anyhow!("Connection refused"));
        let merged = poll.merged(&["peer".into()]);
        assert!(merged["panes"].as_array().unwrap().is_empty());
        assert_eq!(merged["tabs"][0]["id"], 42);
        assert!(merged["errors"][0]["pending"].is_null());
        // A peer never reached is unavailable at once.
        poll.peer_unavailable("new-peer", &anyhow::anyhow!("Connection refused"));
        assert!(poll.cache["new-peer"]["errors"][0]["pending"].is_null());
    }

    #[test]
    fn switchboard_codex_question_takes_priority_over_working() {
        let pane = json!({"id":66,"tab_id":66,"pane_command":"codex","title":"[ ! ] Action Required | Match tabs to T3 styling | switchboard"});
        // Captured with `zellij -s main action dump-screen -p 66` on 2026-11-08.
        // An async question stays open while Codex works; its old working line
        // and Yes/No choices must not turn it into working or an approval.
        let question = "Working (3m 02s • esc to interrupt)\n\
            \n\
            • Queued follow-up inputs\n\
            \n\
              I’m treating the screenshot as the style for the collapsible tab groups. Should I also rename “Hidden” to “Settled”?\n\
            \n\
                1. Yes, use Settled\n\
                2. Keep the Hidden label\n\
              › 3. Other\n\
            \n\
              enter submit   ctrl+] skip   shift+→ main prompt\n";
        let expected = json!({"state":"input","agent":"codex","token":"question"});
        assert_eq!(classify(&pane, question), expected);
        assert_eq!(classify(&pane, &question.replace('\n', "\r\n")), expected);
        let moved = question
            .replace("1. Yes", "› 1. Yes")
            .replace("› 3. Other", "  3. Other");
        assert_eq!(classify(&pane, &moved), expected);
        let wrapped = question.replace("skip   shift+→", "skip\nshift+→");
        assert_eq!(classify(&pane, &wrapped), expected);
        let titled =
            json!({"pane_command":"codex","title":"⠦ Match tabs to T3 styling | switchboard"});
        assert_eq!(classify(&titled, question), expected);
        let normal_pane =
            json!({"pane_command":"codex","title":"Match tabs to T3 styling | switchboard"});
        // An old dialog above ongoing output is not a live question either.
        let answered = format!("{question}\nWorking (4m 02s • esc to interrupt)");
        assert_eq!(classify(&normal_pane, &answered)["state"], "working");

        let running =
            "Working (3m 02s • esc to interrupt)\n› draft\nGPT-6.1-Sol high · tab to queue message";
        let ready = "Worked for 3m 51s • 8:06 PM\n› Ask Codex to do anything\nGPT-6.1-Sol high\n? for shortcuts";
        // The title still reports an unanswered request after switching back
        // to the main prompt, including when the command is unavailable.
        assert_eq!(classify(&pane, running), expected);
        assert_eq!(classify(&json!({"title":pane["title"]}), ready), expected);
        // An answered question in scrollback is no longer asking for input.
        for (screen, state) in [(running, "working"), (ready, "ready")] {
            assert_eq!(
                classify(&normal_pane, &format!("{question}\n{screen}"))["state"],
                state
            );
        }
        let approval = "Would you like to run this command?\n› 1. Yes, proceed\n2. No\nPress enter to confirm or esc to cancel\n";
        assert_eq!(classify(&pane, approval)["state"], "approval");
        assert_eq!(
            classify(&normal_pane, "The logs mention Action Required.")["state"],
            "unknown"
        );
    }

    #[test]
    fn switchboard_codex_live_dialog_overrides_turn_hooks_until_answered() {
        let pane = json!({"id":7,"tab_id":8,"pane_command":"codex"});
        let running =
            "Working (3s • esc to interrupt)\n› draft\nGPT-6.1-Sol high · tab to queue message";
        let question = "Which colour?\n  1. Red\n  2. Blue\n› 3. Other\nenter submit   ctrl+] skip   shift+→ main prompt\n";
        let approval = "Would you like to run this command?\n› 1. Yes, proceed\n2. No\nPress enter to confirm or esc to cancel\n";
        let scan = |screen: &str| {
            snapshot(
                "main",
                std::slice::from_ref(&pane),
                &HashMap::from([(7, screen.to_owned())]),
                false,
            )
        };
        for event in ["UserPromptSubmit", "PostToolUse", "Stop"] {
            let mut poll = PollState::default();
            poll.hooks.insert(
                ("main".into(), 7),
                hook_status("codex", &json!({"hook_event_name":event,"turn_id":"t1"})).unwrap(),
            );
            let mut working = scan(running);
            poll.update("windows", &mut working);
            assert_eq!(working["panes"][0]["state"], "working");
            for (screen, state, token) in [
                (question, "input", "question"),
                (approval, "approval", "approval"),
            ] {
                let mut dialog = scan(screen);
                poll.update("windows", &mut dialog);
                assert_eq!(dialog["panes"][0]["state"], state, "{event}");
                assert_eq!(dialog["panes"][0]["token"], token);
                assert_eq!(
                    dialog["panes"][0]["turn_state"],
                    if event == "Stop" { "ready" } else { "working" }
                );
                poll.acknowledge("windows", "main", 7, token);
                let mut still_open = scan(screen);
                poll.update("windows", &mut still_open);
                assert_eq!(still_open["panes"][0]["state"], state);
                assert!(still_open["panes"][0].get("seen").is_none());
            }
            // Answering removes the dialog; normal turn tracking resumes.
            let mut resumed = scan(running);
            poll.update("windows", &mut resumed);
            assert_eq!(resumed["panes"][0]["state"], "working");
            assert!(resumed["panes"][0].get("token").is_none());
        }
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
        // Claude Code 2.1.319, captured with dump-screen while a PreToolUse hook ran mid-turn.
        let hooked = busy.replace(
            "· Perambulating… (23s",
            "✽ Fermenting… (running PreToolUse hook · 9m 34s",
        );
        assert_eq!(classify(&claude, &hooked)["state"], "working");
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
    fn new_claude_tab_at_its_empty_prompt_is_ready() {
        // Claude Code 2.1.319 on Windows, a new tab before its first prompt (dump-screen).
        let rule = "─".repeat(80);
        let screen = format!(
            " ▐▛███▛█   Claude Code v2.1.319\n▝▜██████▀  Opus 5.5 with high effort · Claude Max\n ▝▝   ▝▝   ~\\git\\switchboard\n{rule}\n❯ Try \"fix lint errors\"\n{rule}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent"
        );
        for pane in [
            json!({"pane_command":"claude.exe --dangerously-skip-permissions","title":"✳ Claude Code"}),
            json!({"title":"Claude Code"}),
        ] {
            assert_eq!(classify(&pane, &screen)["state"], "ready", "{pane}");
            assert_eq!(classify(&pane, &screen)["token"], "idle");
        }
    }

    #[test]
    fn new_claude_pane_keeps_its_startup_hook_over_an_older_sessions_pane_id() {
        let root = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::home_dir().unwrap().join(".claude"));
        let event = json!({"hook_event_name":"SessionStart","source":"startup",
            "session_id":"1da2fbc0-43c6-4808-beec-63e446ce3d50",
            "transcript_path":root.join("projects/test/1da2fbc0-43c6-4808-beec-63e446ce3d50.jsonl")});
        let hooked = hook_status("claude", &event).unwrap();
        let id = hooked.chat_id.clone().unwrap();
        let created = unix_seconds() - 3600;
        let mut poll = PollState::default();
        // Pane 17 of a session closed long ago; the new session reuses the ID.
        poll.observed.insert(
            json!(["windows", "main", 17]).to_string(),
            json!({"created":created - 86400,"generation":4,"state":"ready","token":"old"}),
        );
        poll.hooks.insert(("main".into(), 17), hooked);
        // Live screens can lag the pane, so the new agent's screen still reads unknown.
        for _ in 0..2 {
            let mut snapshot = json!({"panes":[{"session":"main","pane_id":17,"state":"unknown","agent":"claude",
                "command":"claude.exe --dangerously-skip-permissions","created":created}],"tabs":[],"errors":[]});
            poll.update("windows", &mut snapshot);
            assert_eq!(snapshot["panes"][0]["state"], "ready");
            assert_eq!(snapshot["panes"][0]["chat_id"], id);
        }
    }

    fn claude_row(state: &str, token: Option<&str>) -> Value {
        let mut snapshot = json!({"panes":[{"session":"main","pane_id":5,"state":state,"agent":"claude",
            "command":"claude.exe --dangerously-skip-permissions"}],"tabs":[],"errors":[]});
        if let Some(token) = token {
            snapshot["panes"][0]["token"] = json!(token);
        }
        snapshot
    }

    #[test]
    fn claude_session_start_after_a_working_screen_is_not_a_finished_turn() {
        let mut poll = PollState::default();
        let hook = |poll: &mut PollState, event: Value| {
            let hooked = hook_status("claude", &event).unwrap();
            poll.hooks.insert(("main".into(), 5), hooked);
        };
        poll.update("windows", &mut claude_row("working", None));
        hook(
            &mut poll,
            json!({"hook_event_name":"SessionStart","source":"startup"}),
        );
        let mut started = claude_row("ready", Some("idle"));
        poll.update("windows", &mut started);
        assert_eq!(started["panes"][0]["state"], "ready");
        assert_eq!(started["panes"][0]["token"], "idle:0");
        assert_eq!(started["panes"][0]["seen"], true);

        hook(&mut poll, json!({"hook_event_name":"UserPromptSubmit"}));
        let mut working = claude_row("ready", Some("idle"));
        poll.update("windows", &mut working);
        assert_eq!(working["panes"][0]["state"], "working");

        hook(
            &mut poll,
            json!({"hook_event_name":"Stop","prompt_id":"first-turn"}),
        );
        let mut finished = claude_row("ready", Some("idle"));
        poll.update("windows", &mut finished);
        let token = finished["panes"][0]["token"].as_str().unwrap();
        assert!(token.ends_with(":1"), "the real finish counts: {token}");
        assert_eq!(finished["panes"][0]["seen"], false);
    }

    #[test]
    fn claude_screen_flicker_at_startup_is_not_a_finished_turn() {
        let mut poll = PollState::default();
        poll.update("windows", &mut claude_row("working", None));
        let mut flicker = claude_row("ready", Some("idle"));
        poll.update("windows", &mut flicker);
        assert_eq!(flicker["panes"][0]["token"], "idle:0");
        assert_eq!(flicker["panes"][0]["seen"], true);

        // Without hooks, the same change later on is how a turn's end is noticed.
        let mut poll = PollState::default();
        poll.update("windows", &mut claude_row("working", None));
        let key = json!(["windows", "main", 5]).to_string();
        poll.observed.get_mut(&key).unwrap()["since"] =
            json!(unix_seconds() - AGENT_START_GRACE - 1);
        let mut finished = claude_row("ready", Some("idle"));
        poll.update("windows", &mut finished);
        assert_eq!(finished["panes"][0]["token"], "idle:1");
        assert_eq!(finished["panes"][0]["seen"], false);
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
    fn claude_auto_and_plan_mode_footers_identify_claude_without_a_command() {
        // Claude Code 2.1.319 in auto mode, captured with dump-screen. The engine can
        // miss a pane's command under load, so the footer must identify Claude.
        let pane = json!({"title":"✳ improve-conversation-mode"});
        let working = "  ⎿  (timeout 3m 20s)  ⎿  Allowed by auto mode\n\n\
            ✽ Contemplating… (20m 34s · ↓ 57.0k tokens)\n\n\
            ──────────────────────── improve-conversation-mode ─\n❯\u{a0}\n\
            ────────────────────────────────────────────────────\n\
              ⏵⏵ auto mode on · 2 shells · esc to interrupt · ← 1 agent · ↓ to manage";
        assert_eq!(
            classify(&pane, working),
            json!({"state":"working","agent":"claude"})
        );
        let idle = working.replace(
            "✽ Contemplating… (20m 34s · ↓ 57.0k tokens)",
            "✻ Baked for 20m 34s",
        );
        assert_eq!(classify(&pane, &idle)["state"], "ready");
        let plan = idle.replace("⏵⏵ auto mode on", "⏸ plan mode on");
        assert_eq!(classify(&pane, &plan)["agent"], "claude");
        assert_eq!(classify(&pane, &plan)["state"], "ready");
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
    fn only_subscribers_whose_relay_is_gone_are_orphans() {
        let args = |line: &str| line.split(' ').map(str::to_owned).collect::<Vec<_>>();
        let processes = vec![
            (10, Some(1), args("zellij.exe serve --port 80")),
            (
                11,
                Some(10),
                args("zellij.exe -s main subscribe --format json --pane-id 5 6"),
            ),
            (
                12,
                Some(99),
                args("zellij.exe -s main subscribe --format json --pane-id 5 6"),
            ),
            (
                13,
                None,
                args("zellij.exe -s work subscribe --format json --pane-id 1"),
            ),
            (
                14,
                Some(99),
                args("zellij.exe -s main subscribe --pane-id 5"),
            ),
            (
                15,
                Some(99),
                args("zellij.exe -s main action list-panes --json"),
            ),
        ];
        assert_eq!(orphaned_subscribers(&processes), vec![12, 13]);
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
    fn hook_status_survives_a_relay_restart_except_working() {
        let hooked = |state, token: Option<&str>| Hooked {
            agent: "claude",
            state,
            token: token.map(str::to_owned),
            chat_id: None,
            restart: None,
            capturing: None,
            at: 0,
            shell_hold: false,
            idle_since: None,
        };
        let mut poll = PollState::default();
        poll.hooks
            .insert(("main".into(), 5), hooked("ready", Some("turn")));
        poll.hooks
            .insert(("main".into(), 6), hooked("waiting", None));
        poll.hooks
            .insert(("main".into(), 7), hooked("working", None));
        let mut restarted = PollState::default();
        restarted.restore_hooks(&poll.persisted()["hooks"]);
        assert_eq!(
            restarted.hooks.get(&("main".into(), 5)),
            Some(&hooked("ready", Some("turn")))
        );
        assert_eq!(
            restarted.hooks.get(&("main".into(), 6)),
            Some(&hooked("waiting", None))
        );
        assert!(
            !restarted.hooks.contains_key(&("main".into(), 7)),
            "a turn may end while no relay listens; the screen shows a live one"
        );
        // The restored status beats a screen that misreads a finished turn.
        let pane = |created: u64| json!({"panes":[{"session":"main","pane_id":5,"state":"working","agent":"claude","command":"claude","created":created}],"tabs":[],"errors":[]});
        let mut snapshot = pane(1000);
        restarted.update("linux", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["state"], "ready");
        // A session recreated with the same pane IDs runs a different agent.
        let mut snapshot = pane(5000);
        restarted.update("linux", &mut snapshot);
        assert_eq!(snapshot["panes"][0]["state"], "working");
        assert!(!restarted.hooks.contains_key(&("main".into(), 5)));
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
    fn switchboard_a_missed_folder_keeps_the_panes_last_known_project() {
        let report = |session: &str, cwd: Value, repo: Value| {
            json!({"panes":[],"errors":[],"tabs":[{"session":session,"id":4,"panes":[
                {"pane_id":1,"cwd":cwd,"repo":repo}
            ]}]})
        };
        let pane = |snapshot: &Value| snapshot["tabs"][0]["panes"][0].clone();
        let mut poll = PollState::default();
        poll.update("peer", &mut report("main", json!("/git/app"), json!("app")));
        let version = *poll.changes.borrow();

        let mut missed = report("main", Value::Null, Value::Null);
        poll.update("peer", &mut missed);
        assert_eq!(pane(&missed)["cwd"], "/git/app");
        assert_eq!(pane(&missed)["repo"], "app");
        assert_eq!(
            *poll.changes.borrow(),
            version,
            "a missed folder must not wake sidebars"
        );

        let mut other = report("other", Value::Null, Value::Null);
        poll.update("second-peer", &mut other);
        assert!(
            pane(&other)["cwd"].is_null(),
            "folders stay with their computer"
        );

        let mut moved = report("main", json!("/git/lib"), json!("lib"));
        poll.update("peer", &mut moved);
        assert_eq!(
            pane(&moved)["repo"],
            "lib",
            "a new folder replaces the old one"
        );
        let mut plain = report("main", json!("/tmp"), Value::Null);
        poll.update("peer", &mut plain);
        assert!(
            pane(&plain)["repo"].is_null(),
            "a folder outside a repository has no project"
        );
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
