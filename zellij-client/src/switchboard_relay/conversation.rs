//! What Conversation does to a pane without opening a terminal viewer: complete
//! Codex's startup hooks review and Claude's folder trust, type a reply into Claude's empty prompt, and
//! answer Claude's numbered menus (see `prompt`).
use super::*;
use serde::Serialize;
use std::path::PathBuf;
pub(super) mod background;
mod claude_skills;
pub(super) mod codex;
pub(super) mod github;
pub(super) mod prompt;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Target {
    session: String,
    pane_id: u32,
    tab_id: u32,
}

// Codex 0.167's startup hooks review. Match the entire menu and its selected
// option; a historical mention, shell prompt or permission dialog must never
// receive Enter. Choose exactly "Trust all and continue", as requested in
// Conversation, and let Codex persist the trust hashes itself.
fn trust_keys(screen: &str) -> Option<&'static [&'static str]> {
    static MENU: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
        r"^Hooks need review \d+ hooks? (?:is|are) new or changed\. Hooks can run outside the sandbox after you trust them\. (?<review>› )?1\. Review hooks (?<trust>› )?2\. Trust all and continue (?<skip>› )?3\. Continue without trusting \(hooks won't run\) enter confirm · esc skip$"
    ).unwrap()
    });
    // Text wraps in narrow terminals; the complete menu must still be the last
    // thing on screen, with exactly one selected option.
    let screen = screen.split_whitespace().collect::<Vec<_>>().join(" ");
    let start = screen.rfind("Hooks need review")?;
    let selected = MENU.captures(&screen[start..])?;
    let review = selected.name("review").is_some();
    let trust = selected.name("trust").is_some();
    let skip = selected.name("skip").is_some();
    match (review, trust, skip) {
        (true, false, false) => Some(&["27", "91", "66", "13"]), // Down, Enter.
        (false, true, false) => Some(&["13"]),
        // Leave an explicitly selected skip option to the user.
        _ => None,
    }
}

pub(super) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<Target>,
) -> Result<Response, Error> {
    control::validate_session(&target.session)?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = host
            .request(
                Method::POST,
                "/switchboard/conversation/prepare",
                serde_json::to_vec(&target).unwrap().into(),
                "application/json",
            )
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot reach the other computer"))?;
        return Ok((response.status, response.body).into_response());
    }
    local(&host, target).await.map(IntoResponse::into_response)
}

const READ_ATTEMPT: Duration = Duration::from_secs(5);
/// How long a reply keeps retrying failed reads.
const REPLY_RETRY_WINDOW: Duration = Duration::from_secs(9);
/// A paired computer's gateway stops waiting after 15 seconds and the browser
/// after 20, so a reply must not be typed once the shorter of those is close.
const TYPE_WITHIN: Duration = Duration::from_secs(13);
const NOT_RESPONDING: &str = "The terminal did not respond, so nothing was sent. Try again.";
/// Claude shows no input box, so nothing was typed. Conversation matches this text,
/// keeps the message on its way and tries again.
const AWAITING_PROMPT: &str = "Waiting for Claude's input box.";
const NOT_CLAUDE: &str = "The selected pane is not Claude";
/// How long a pane that cannot be identified yet is read again. A busy computer
/// leaves out a pane's command, and a redraw can hide Claude's footer.
const IDENTIFY_WITHIN: Duration = Duration::from_secs(2);

/// Whether Claude runs in this pane, or `None` while this read cannot say.
fn is_claude(pane: &Value, screen: &str) -> Option<bool> {
    let agent = attention::classify(pane, screen);
    if agent["agent"] == "claude" {
        return Some(true);
    }
    let command = pane["pane_command"].as_str().unwrap_or("").trim();
    if agent["agent"].is_string() || !command.is_empty() {
        return Some(false);
    }
    None
}

/// Repeats a read that failed. Reading changes nothing, and a busy computer can
/// time out or fail one `zellij action` that works moments later. The cause
/// goes to the Logs view because the browser only gets a plain message.
async fn retry_read<T, F>(
    what: &str,
    retry_until: tokio::time::Instant,
    mut read: impl FnMut() -> F,
) -> anyhow::Result<T>
where
    F: std::future::Future<Output = anyhow::Result<T>>,
{
    loop {
        match read().await {
            Ok(value) => return Ok(value),
            Err(error) => {
                logs::record("Conversation", &format!("{what} failed: {error:#}"));
                if tokio::time::Instant::now() >= retry_until {
                    return Err(error);
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            },
        }
    }
}

/// Reads the selected pane after checking it is still the one the browser chose.
/// Failed reads are repeated until `retry_until`; each is tried at least once.
async fn checked_screen(
    host: &Host,
    target: &Target,
    retry_until: tokio::time::Instant,
) -> Result<(Value, String), Error> {
    control::validate_session(&target.session)?;
    if !control::sessions(host)
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot check shared sessions"))?
        .contains(&target.session)
    {
        return Err((StatusCode::CONFLICT, "Session is not shared"));
    }
    control::require_writable_host(host).await?;
    let panes = retry_read("list-panes", retry_until, || {
        control::list_panes(host, &target.session, true, READ_ATTEMPT)
    })
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, NOT_RESPONDING))?;
    let pane = panes
        .into_iter()
        .find(|pane| {
            pane["id"] == target.pane_id
                && pane["tab_id"] == target.tab_id
                && pane["is_plugin"] == false
                && pane["exited"] != true
                && pane["is_held"] != true
        })
        .ok_or((StatusCode::CONFLICT, "The selected pane changed"))?;
    let pane_id = target.pane_id.to_string();
    let args = ["dump-screen", "-p", &pane_id];
    let screen = retry_read("dump-screen", retry_until, || {
        control::run_local(host, &target.session, &args, READ_ATTEMPT)
    })
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, NOT_RESPONDING))?;
    Ok((pane, screen))
}

// Two viewers must not both act on the same screen, but one slow pane must not hold
// up another.
static ACTING: std::sync::LazyLock<std::sync::Mutex<HashMap<(String, u32), Arc<Mutex<()>>>>> =
    std::sync::LazyLock::new(Default::default);

async fn acting_on(session: &str, pane_id: u32) -> tokio::sync::OwnedMutexGuard<()> {
    let pane = {
        let mut panes = ACTING.lock().unwrap();
        panes.retain(|_, lock| Arc::strong_count(lock) > 1);
        panes
            .entry((session.to_owned(), pane_id))
            .or_default()
            .clone()
    };
    pane.lock_owned().await
}

// Zellij accepts input before the agent redraws, and a write that times out may still
// arrive. While an answered dialog is on screen, answering again would send its keys to
// whatever dialog comes next. So automatic acceptance gets one send per dialog; if those
// keys were lost, the person answers the card, once the first send has had time to land.
// A relay restart clears these; a pane only ever answers a handful of dialogs.
pub(super) const TRUST_MANUAL_WAIT: Duration = Duration::from_secs(10);
static TRUST_SENT: std::sync::LazyLock<
    std::sync::Mutex<HashMap<(String, u32, String), std::time::Instant>>,
> = std::sync::LazyLock::new(Default::default);

/// Call under `acting_on`, before writing. False if this dialog was already answered:
/// within `within` when given, otherwise at any time.
pub(super) fn claim_trust_answer(
    session: &str,
    pane_id: u32,
    token: &str,
    within: Option<Duration>,
) -> bool {
    let mut sent = TRUST_SENT.lock().unwrap();
    let dialog = (session.to_owned(), pane_id, token.to_owned());
    if sent
        .get(&dialog)
        .is_some_and(|at| within.is_none_or(|w| at.elapsed() < w))
    {
        return false;
    }
    sent.insert(dialog, std::time::Instant::now());
    true
}

pub(super) async fn local(host: &Host, target: Target) -> Result<Json<Value>, Error> {
    let _guard = acting_on(&target.session, target.pane_id).await;
    let (pane, screen) = checked_screen(host, &target, tokio::time::Instant::now()).await?;
    let keys = match attention::classify(&pane, &screen)["agent"].as_str() {
        Some("codex") => {
            trust_keys(&screen).map(|keys| keys.iter().map(|key| (*key).to_string()).collect())
        },
        Some("claude") if attention::may_be_claude(&pane) => prompt::folder_trust_keys(&screen),
        _ => None,
    };
    let Some(keys) = keys else {
        return Ok(Json(json!({"trusted":false})));
    };
    if prompt::folder_trust_token(&screen)
        .is_some_and(|token| !claim_trust_answer(&target.session, target.pane_id, &token, None))
    {
        return Ok(Json(json!({"trusted":true})));
    }
    let id = target.pane_id.to_string();
    let mut args = vec!["write", "-p", &id];
    args.extend(keys.iter().map(String::as_str));
    control::run_local(host, &target.session, &args, Duration::from_secs(5))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot confirm startup trust"))?;
    Ok(Json(json!({"trusted":true})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reply {
    session: String,
    pane_id: u32,
    tab_id: u32,
    text: String,
}

/// Rows of a `dump-screen --ansi` capture as cells, each flagged when Claude
/// drew it dim (SGR 2). A run of `─` is its own row: `dump-screen` joins a
/// full-width rule with the row after it, and sometimes with the row before.
fn styled_rows(screen: &str) -> Vec<Vec<(char, bool)>> {
    let (mut rows, mut row, mut dim) = (Vec::new(), Vec::new(), false);
    let mut chars = screen.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' if chars.peek() == Some(&'[') => {
                chars.next();
                let mut params = String::new();
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        if c == 'm' {
                            let codes: Vec<&str> = params.split(';').collect();
                            let mut i = 0;
                            while i < codes.len() {
                                match codes[i] {
                                    "" | "0" | "22" => dim = false,
                                    "2" => dim = true,
                                    // Colours carry their own parameters, such as
                                    // 38;2;136;136;136, whose 2 is not dim.
                                    "38" | "48" | "58" => {
                                        i += match codes.get(i + 1) {
                                            Some(&"5") => 2,
                                            Some(&"2") => 4,
                                            _ => 0,
                                        }
                                    },
                                    _ => {},
                                }
                                i += 1;
                            }
                        }
                        break;
                    }
                    params.push(c);
                }
            },
            '\n' => rows.push(std::mem::take(&mut row)),
            '\r' => {},
            c => row.push((c, dim)),
        }
    }
    rows.push(row);
    let rule = |c: char| matches!(c, '─' | '━');
    let mut split = Vec::new();
    for row in rows {
        let mut start = 0;
        let mut i = 0;
        while i < row.len() {
            let run = row[i..].iter().take_while(|cell| rule(cell.0)).count();
            let mut taken = run;
            if run >= 8 {
                // A renamed session's box shows its name in the top rule:
                // `──── name ─`. The name is part of the rule, not a row.
                let rest = &row[i + run..];
                let label = rest.iter().take_while(|cell| !rule(cell.0)).count();
                let tail = rest[label..].iter().take_while(|cell| rule(cell.0)).count();
                if label > 2
                    && tail > 0
                    && rest[0].0 == ' '
                    && rest[label - 1].0 == ' '
                    && rest[1..label - 1]
                        .iter()
                        .any(|cell| !cell.0.is_whitespace())
                {
                    taken += label + tail;
                }
                if row[start..i].iter().any(|cell| !cell.0.is_whitespace()) {
                    split.push(row[start..i].to_vec());
                }
                split.push(row[i..i + run].to_vec());
                start = i + taken;
            }
            i += taken.max(1);
        }
        if start == 0 || row[start..].iter().any(|cell| !cell.0.is_whitespace()) {
            split.push(row[start..].to_vec());
        }
    }
    split
}

/// Claude Code's input box as it appears on screen.
#[derive(Debug, PartialEq)]
struct ClaudePrompt {
    /// What the input holds. Claude draws its placeholder, a suggested next
    /// prompt and the queued-message hint dim, and typed text never, so only
    /// undimmed cells count.
    draft: String,
    /// Claude holds a stashed prompt: its footer says `› stashed`.
    stashed: bool,
    /// Shell mode (`!`): Enter runs the input as a command.
    shell: bool,
}

/// The last input box on screen: a rule, a row starting with `❯` (or `!` in
/// shell mode), any continuation rows, and a closing rule. `None` when Claude
/// shows no input, such as while a permission dialog replaces it.
/// The terminal bridge reads its xterm buffer the same way.
fn claude_prompt(screen: &str) -> Option<ClaudePrompt> {
    let rows = styled_rows(screen);
    let is_rule =
        |row: &Vec<(char, bool)>| !row.is_empty() && row.iter().all(|c| matches!(c.0, '─' | '━'));
    for start in (1..rows.len()).rev() {
        let Some(marker) = rows[start].iter().position(|c| !c.0.is_whitespace()) else {
            continue;
        };
        if !matches!(rows[start][marker].0, '❯' | '!') || !is_rule(&rows[start - 1]) {
            continue;
        }
        let Some(end) = rows[start + 1..].iter().position(is_rule) else {
            continue;
        };
        let end = start + 1 + end;
        let draft = std::iter::once(&rows[start][marker + 1..])
            .chain(rows[start + 1..end].iter().map(Vec::as_slice))
            .map(|row| {
                row.iter()
                    .map(|&(c, dim)| if dim { ' ' } else { c })
                    .collect::<String>()
                    .trim()
                    .to_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_owned();
        let stashed = rows[end + 1..].iter().any(|row| {
            row.iter()
                .map(|c| c.0)
                .collect::<String>()
                .contains("› stashed")
        });
        let shell = rows[start][marker].0 == '!';
        return Some(ClaudePrompt {
            draft,
            stashed,
            shell,
        });
    }
    None
}

pub(super) async fn reply_handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(reply): Json<Reply>,
) -> Result<Response, Error> {
    control::validate_session(&reply.session)?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    super::detached(async move {
        if host.config.escape_transport.as_deref() == Some("gateway") {
            let response = host
                .request(
                    Method::POST,
                    "/switchboard/conversation/reply",
                    serde_json::to_vec(&reply).unwrap().into(),
                    "application/json",
                )
                .await
                .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot reach the other computer"))?;
            return Ok((response.status, response.body).into_response());
        }
        reply_local(&host, Some(&state.poll), reply)
            .await
            .map(IntoResponse::into_response)
    })
    .await
}

pub(super) const REPLY_LIMIT: usize = 16000;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Skills {
    cwd: String,
    /// `claude` lists Claude Code's skills. Absent means Codex, which older computers expect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
}

pub(super) async fn skills_handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(request): Json<Skills>,
) -> Result<Response, Error> {
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = host
            .request(
                Method::POST,
                "/switchboard/conversation/skills",
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
    skills_local(&host, request)
        .await
        .map(IntoResponse::into_response)
}

pub(super) async fn skills_local(host: &Host, request: Skills) -> Result<Json<Value>, Error> {
    let cwd = skills_dir(&request.cwd)?;
    if !matches!(request.agent.as_deref(), None | Some("claude")) {
        return Err((StatusCode::BAD_REQUEST, "Unknown agent"));
    }
    control::require_writable_host(host).await?;
    if request.agent.is_some() {
        let config = claude_skills::config_dir(&skills_home()?);
        let skills =
            tokio::task::spawn_blocking(move || claude_skills::choices(&config, cwd.as_deref()))
                .await
                .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot list Claude skills"))?;
        return Ok(Json(json!({ "skills": skills })));
    }
    let cwds: Vec<String> = cwd
        .iter()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .collect();
    let result = codex_app_server(cwd.as_deref(), "skills/list", json!({"cwds":cwds}))
        .await
        .ok_or((StatusCode::BAD_GATEWAY, "Cannot list Codex skills"))?;
    Ok(Json(json!({"skills":skill_choices(&result)})))
}

fn skills_home() -> Result<PathBuf, Error> {
    std::env::home_dir().ok_or((StatusCode::BAD_GATEWAY, "Home directory unavailable"))
}

/// A full path, or a project name in ~/git as New tab takes it. A folder that does
/// not exist yet, as while a project name is being typed, lists personal skills.
fn skills_dir(cwd: &str) -> Result<Option<PathBuf>, Error> {
    const INVALID: Error = (StatusCode::BAD_REQUEST, "Invalid project directory");
    if cwd.len() > 4096 || cwd.contains('\0') {
        return Err(INVALID);
    }
    if cwd.is_empty() {
        return Ok(None);
    }
    let path = Path::new(cwd);
    let path = if path.is_absolute() {
        path.to_owned()
    } else if path
        .components()
        .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        skills_home()?.join("git").join(path)
    } else {
        return Err(INVALID);
    };
    Ok(path.is_dir().then_some(path))
}

/// The models this computer's Codex offers, as `{id, name, default, efforts, default_effort}`,
/// in Codex's order. Empty when Codex is missing or does not answer.
pub(crate) async fn codex_models() -> Vec<Value> {
    let Some(result) = codex_app_server(None, "model/list", json!({})).await else {
        return vec![];
    };
    model_choices(&result)
}

fn model_choices(result: &Value) -> Vec<Value> {
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["hidden"] != true)
        .filter_map(|model| {
            let id = model["model"].as_str().or_else(|| model["id"].as_str())?;
            let name = model["displayName"].as_str().unwrap_or(id);
            // Each model's own effort levels, so New tab offers only what it accepts.
            let efforts: Vec<Value> = model["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|effort| {
                    let id = effort["reasoningEffort"].as_str()?;
                    let description = effort["description"].as_str().unwrap_or("");
                    Some(json!({"id":id,"description":description}))
                })
                .collect();
            Some(
                json!({"id":id,"name":name,"default":model["isDefault"] == true,
                "efforts":efforts,"default_effort":model["defaultReasoningEffort"].as_str()}),
            )
        })
        .collect()
}

/// Claude's SDK initialization reports the current catalog without submitting a prompt.
/// Disable hooks, MCP servers and transcript persistence for this short-lived query.
/// ModelInfo: https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo
pub(crate) async fn claude_models() -> Vec<Value> {
    let Some((program, path)) = agent_setup::agent_program("claude") else {
        return vec![];
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--settings",
            r#"{"disableAllHooks":true}"#,
        ])
        .env("PATH", path)
        .env_remove("CLAUDECODE")
        .env_remove("ZELLIJ_SESSION_NAME")
        .env_remove("ZELLIJ_PANE_ID")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Some(home) = std::env::home_dir() {
        command.current_dir(home);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let Ok(mut child) = command.spawn() else {
        return vec![];
    };
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let mut input = child.stdin.take()?;
        let mut output = BufReader::new(child.stdout.take()?).lines();
        input.write_all(b"{\"type\":\"control_request\",\"request_id\":\"models\",\"request\":{\"subtype\":\"initialize\"}}\n").await.ok()?;
        while let Some(line) = output.next_line().await.ok()? {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue; };
            if message["type"] == "control_response" && message["response"]["request_id"] == "models" {
                return (message["response"]["subtype"] == "success")
                    .then(|| claude_model_choices(&message["response"]["response"]));
            }
        }
        None
    }).await;
    let _ = child.kill().await;
    result.ok().flatten().unwrap_or_default()
}

fn claude_model_choices(result: &Value) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    result["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|model| {
            // The default row duplicates an alias with the useful model name. Pin aliases to
            // their resolved ID so a saved favourite keeps naming the model it launches.
            if model["value"] == "default" {
                return None;
            }
            let id = model["resolvedModel"]
                .as_str()
                .or_else(|| model["value"].as_str())?;
            if !seen.insert(id) {
                return None;
            }
            let efforts = model["supportedEffortLevels"].as_array().map(|levels| {
                levels
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|id| json!({"id":id}))
                    .collect::<Vec<_>>()
            });
            let mut choice = json!({"id":id,"name":model["displayName"].as_str().unwrap_or(id)});
            if let Some(efforts) = efforts {
                choice["efforts"] = json!(efforts);
            } else if model["supportsEffort"] == false {
                choice["efforts"] = json!([]);
            }
            Some(choice)
        })
        .collect()
}

/// Ask a short-lived `codex app-server` one question, in `cwd` or the home folder.
async fn codex_app_server(cwd: Option<&Path>, method: &str, params: Value) -> Option<Value> {
    let (program, path) = agent_setup::codex_queue_program()?;
    let mut command = tokio::process::Command::new(program);
    command
        .arg("app-server")
        .env("PATH", path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    match cwd {
        Some(cwd) => {
            command.current_dir(cwd);
        },
        None => {
            if let Some(home) = std::env::home_dir() {
                command.current_dir(home);
            }
        },
    }
    for key in [
        "CODEX_THREAD_ID",
        "ZELLIJ_SESSION_NAME",
        "ZELLIJ_PANE_ID",
        "CLAUDECODE",
    ] {
        command.env_remove(key);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().ok()?;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let mut input = child.stdin.take()?;
        let mut output = BufReader::new(child.stdout.take()?).lines();
        for (id, method, params) in [
            (
                1,
                "initialize",
                json!({"clientInfo":{"name":"switchboard","version":env!("SWITCHBOARD_COMMIT")}}),
            ),
            (2, method, params),
        ] {
            input
                .write_all(
                    format!(
                        "{}
",
                        json!({"id":id,"method":method,"params":params})
                    )
                    .as_bytes(),
                )
                .await
                .ok()?;
            if id == 1 {
                input
                    .write_all(
                        b"{\"method\":\"initialized\"}
",
                    )
                    .await
                    .ok()?;
            }
            loop {
                let line = output.next_line().await.ok()??;
                let Ok(mut message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message["id"] != id {
                    continue;
                }
                if message.get("error").is_some() {
                    return None;
                }
                if id == 2 {
                    return Some(message["result"].take());
                }
                break;
            }
        }
        None
    })
    .await;
    let _ = child.kill().await;
    result.ok().flatten()
}

fn skill_choices(result: &Value) -> Vec<Value> {
    let mut choices = std::collections::BTreeMap::new();
    for entry in result["data"].as_array().into_iter().flatten() {
        for skill in entry["skills"].as_array().into_iter().flatten() {
            let Some(name) = skill["name"].as_str() else {
                continue;
            };
            if skill["enabled"] != true || name.is_empty() {
                continue;
            }
            let description = skill["interface"]["shortDescription"]
                .as_str()
                .or_else(|| skill["shortDescription"].as_str())
                .or_else(|| skill["description"].as_str())
                .unwrap_or("");
            choices
                .entry(name.to_owned())
                .or_insert_with(|| json!({"name":name,"description":description}));
        }
    }
    choices.into_values().collect()
}

pub(super) async fn reply_local(
    host: &Host,
    poll: Option<&Arc<Mutex<attention::PollState>>>,
    reply: Reply,
) -> Result<Json<Value>, Error> {
    let text = &reply.text;
    if text.trim().is_empty()
        || text.len() > REPLY_LIMIT
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid reply"));
    }
    let started = tokio::time::Instant::now();
    let retry_until = started + REPLY_RETRY_WINDOW;
    let _guard = acting_on(&reply.session, reply.pane_id).await;
    let target = Target {
        session: reply.session.clone(),
        pane_id: reply.pane_id,
        tab_id: reply.tab_id,
    };
    // Counted from the first read, which is slowest when the computer is busy.
    let mut identify_until = None;
    loop {
        let (pane, screen) = checked_screen(host, &target, retry_until).await?;
        match is_claude(&pane, &screen) {
            Some(true) => break,
            Some(false) => return Err((StatusCode::CONFLICT, NOT_CLAUDE)),
            None => {},
        }
        let now = tokio::time::Instant::now();
        if now < *identify_until.get_or_insert(now + IDENTIFY_WITHIN) {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        // Claude's hooks say it is there, but they outlive a crash, so they only
        // keep the message waiting. A later read must still identify the pane.
        let hooked = match poll {
            Some(poll) => {
                let poll = poll.lock().await;
                poll.hooked_agent(&reply.session, reply.pane_id)
            },
            None => None,
        };
        return Err(if hooked == Some("claude") {
            (StatusCode::CONFLICT, AWAITING_PROMPT)
        } else {
            (StatusCode::CONFLICT, NOT_CLAUDE)
        });
    }
    let id = reply.pane_id.to_string();
    let session = &reply.session;
    // Only a fresh read counts: a dialog may have replaced the box since `screen`.
    // A resize redraws the whole screen, so a missing box often returns at once.
    let prompt = match read_prompt(host, session, &id, retry_until).await? {
        Some(prompt) => prompt,
        None => wait_for_prompt(host, session, &id, |_| true)
            .await
            .ok_or((StatusCode::CONFLICT, AWAITING_PROMPT))?,
    };
    // A draft typed in Terminal goes into Claude's stash (Ctrl+S), which keeps its
    // cursor, shell mode and pasted blocks; Claude puts it back once the reply is
    // submitted, whether it runs now or waits in the queue. Ctrl+S never
    // interrupts a turn, unlike Escape.
    let stashed = !prompt.draft.is_empty();
    if stashed {
        // Stashing again would replace the prompt the user stashed earlier.
        if prompt.stashed {
            return Err((
                StatusCode::CONFLICT,
                "Claude already holds a stashed prompt and a new draft in Terminal. Send or clear the draft there first.",
            ));
        }
        write_keys(host, session, &id, "19").await?;
        // Stashing also leaves shell mode.
        wait_for_prompt(host, session, &id, |now| {
            now.draft.is_empty() && now.stashed && !now.shell
        })
        .await
        .ok_or((
            StatusCode::CONFLICT,
            "Claude did not set the terminal draft aside. Open Terminal to send.",
        ))?;
    } else if prompt.shell {
        // An empty shell-mode box would run the reply as a command. Ctrl+S has
        // nothing to stash there; Backspace returns it to chat mode.
        write_keys(host, session, &id, "127").await?;
        wait_for_prompt(host, session, &id, |now| now.draft.is_empty() && !now.shell)
            .await
            .ok_or((
                StatusCode::CONFLICT,
                "Claude stayed in shell mode. Open Terminal to send.",
            ))?;
    }
    if started.elapsed() > TYPE_WITHIN {
        return Err((
            StatusCode::GATEWAY_TIMEOUT,
            if stashed {
                "The terminal did not respond, so nothing was sent. Your terminal draft is in Claude's stash: press Ctrl+S on its empty prompt to bring it back."
            } else {
                NOT_RESPONDING
            },
        ));
    }
    // `--` keeps a reply that starts with `-` from reading as an option.
    control::run_local(
        host,
        session,
        &["paste", "-p", &id, "--", text],
        Duration::from_secs(5),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot type the reply"))?;
    write_keys(host, session, &id, "13").await?;
    if !stashed {
        return Ok(Json(json!({"ok":true})));
    }
    let restored = wait_for_prompt(host, session, &id, |now| {
        !now.stashed && now.draft == prompt.draft && now.shell == prompt.shell
    })
    .await
    .is_some();
    Ok(Json(if restored {
        json!({"ok":true,"draft":"restored"})
    } else {
        json!({"ok":true,"draft":"stashed","notice":"Your terminal draft is in Claude's stash. Press Ctrl+S on its empty prompt to bring it back."})
    }))
}

/// Reads Claude's input box with styling, which tells hints from typed text.
async fn read_prompt(
    host: &Host,
    session: &str,
    pane: &str,
    retry_until: tokio::time::Instant,
) -> Result<Option<ClaudePrompt>, Error> {
    let args = ["dump-screen", "--ansi", "-p", pane];
    let screen = retry_read("dump-screen --ansi", retry_until, || {
        control::run_local(host, session, &args, READ_ATTEMPT)
    })
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, NOT_RESPONDING))?;
    Ok(claude_prompt(&screen))
}

/// Rereads the input box until `done` holds, for up to two seconds.
async fn wait_for_prompt(
    host: &Host,
    session: &str,
    pane: &str,
    done: impl Fn(&ClaudePrompt) -> bool,
) -> Option<ClaudePrompt> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(Some(prompt)) =
            read_prompt(host, session, pane, tokio::time::Instant::now()).await
        {
            if done(&prompt) {
                return Some(prompt);
            }
        }
    }
    None
}

async fn write_keys(host: &Host, session: &str, pane: &str, key: &str) -> Result<(), Error> {
    control::run_local(
        host,
        session,
        &["write", "-p", pane, key],
        Duration::from_secs(5),
    )
    .await
    .map(|_| ())
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot type into the terminal"))
}

#[cfg(test)]
mod tests {

    #[test]
    fn switchboard_folder_trust_claim_remembers_every_dialog_without_expiry() {
        let claim = |token, within| claim_trust_answer("claim-test", 1, token, within);
        assert!(claim("folder-a", None));
        assert!(claim("folder-b", None));
        assert!(!claim("folder-a", None), "a later dialog does not erase it");
        assert!(!claim("folder-a", Some(Duration::from_secs(60))));
        assert!(
            claim("folder-a", Some(Duration::ZERO)),
            "a manual answer may follow once its wait has passed"
        );
        assert!(!claim("folder-a", None), "only a manual wait can end");
    }

    #[tokio::test]
    async fn switchboard_acting_on_a_pane_only_waits_for_that_pane() {
        let wait = Duration::from_millis(100);
        let held = acting_on("lock-test", 1).await;
        assert!(
            tokio::time::timeout(wait, acting_on("lock-test", 2))
                .await
                .is_ok(),
            "another pane proceeds"
        );
        assert!(
            tokio::time::timeout(wait, acting_on("other-session", 1))
                .await
                .is_ok(),
            "the same pane number in another session proceeds"
        );
        assert!(
            tokio::time::timeout(wait, acting_on("lock-test", 1))
                .await
                .is_err(),
            "the same pane waits"
        );
        drop(held);
        assert!(tokio::time::timeout(wait, acting_on("lock-test", 1))
            .await
            .is_ok());
    }
    #[tokio::test]
    #[ignore = "Requires an installed Claude Code; queries its catalog without sending a prompt"]
    async fn switchboard_claude_models_from_installed_cli() {
        let models = super::claude_models().await;
        assert!(
            !models.is_empty(),
            "Claude initialization returned no models"
        );
        assert!(models
            .iter()
            .all(|model| model["id"].is_string() && model["name"].is_string()));
    }

    #[test]
    fn switchboard_claude_model_choices_resolve_aliases_and_keep_model_efforts() {
        let result = serde_json::json!({"models":[
            {"value":"default","resolvedModel":"claude-current","displayName":"Default"},
            {"value":"opus","resolvedModel":"claude-current","displayName":"Current model",
             "supportsEffort":true,"supportedEffortLevels":["high","max"]},
            {"value":"claude-current","displayName":"Duplicate"},
            {"value":"claude-quick","displayName":"Quick model","supportsEffort":false},
            {"value":"custom","supportsEffort":true},
            {"displayName":"Invalid"}
        ]});
        assert_eq!(
            super::claude_model_choices(&result),
            vec![
                serde_json::json!({"id":"claude-current","name":"Current model","efforts":[{"id":"high"},{"id":"max"}]}),
                serde_json::json!({"id":"claude-quick","name":"Quick model","efforts":[]}),
                serde_json::json!({"id":"custom","name":"custom"}),
            ]
        );
    }

    #[test]
    fn switchboard_codex_model_choices_carry_each_models_effort_levels() {
        let result = serde_json::json!({"data":[
            {"id":"gpt-6.1-sol","model":"gpt-6.1-sol","displayName":"GPT-6.1-Sol","isDefault":true,
             "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Fast"},{"reasoningEffort":"xhigh"}],
             "defaultReasoningEffort":"low"},
            {"id":"old","model":"old","hidden":true},
            {"id":"bare"}
        ]});
        assert_eq!(
            super::model_choices(&result),
            vec![
                serde_json::json!({"id":"gpt-6.1-sol","name":"GPT-6.1-Sol","default":true,
                    "efforts":[{"id":"low","description":"Fast"},{"id":"xhigh","description":""}],
                    "default_effort":"low"}),
                serde_json::json!({"id":"bare","name":"bare","default":false,"efforts":[],"default_effort":null}),
            ]
        );
    }

    use super::*;
    #[test]
    fn switchboard_conversation_skill_suggestions_hide_disabled_skills_and_paths() {
        let listed = json!({"data":[{"skills":[
            {"name":"bro","enabled":true,"description":"Long description","path":"/private/skills/bro/SKILL.md","interface":{"shortDescription":"Review together"}},
            {"name":"disabled","enabled":false,"description":"Hidden"},
            {"name":"legacy","enabled":true,"description":"Long description","shortDescription":"Legacy summary"}
        ]},{"skills":[
            {"name":"bro","enabled":true,"description":"Duplicate"},
            {"name":"plain","enabled":true,"description":"Fallback description"}
        ]}]});
        assert_eq!(
            skill_choices(&listed),
            vec![
                json!({"name":"bro","description":"Review together"}),
                json!({"name":"legacy","description":"Legacy summary"}),
                json!({"name":"plain","description":"Fallback description"}),
            ]
        );
    }
    // Captured from Codex 0.167.0 in an isolated CODEX_HOME, before any prompt.
    const REVIEW: &str = "\n  Hooks need review\n  1 hook is new or changed.\n  Hooks can run outside the sandbox after you trust them.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\n  enter confirm · esc skip\n\n";

    const RULE: &str = "────────────────────────────────────────";
    // Claude Code 2.1.318 idle prompt, captured with dump-screen; ❯ is followed by U+00A0.
    const CLAUDE_IDLE: &str = "● Done.\n\n────────────────────────────────────────\n❯\u{a0}\n────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";

    #[test]
    fn switchboard_conversation_reads_only_typed_text_as_a_claude_draft() {
        // Claude Code 2.1.319 captured with `dump-screen --ansi`; see the fixture's headers.
        // Checkouts may turn the fixture's line endings into CRLF.
        let captures = include_str!("conversation/claude_prompt.ansi").replace('\r', "");
        let capture = |name: &str| {
            let start = captures.find(&format!("## {name}\n")).unwrap() + name.len() + 4;
            let end = captures[start..]
                .find("\n## ")
                .map_or(captures.len(), |end| start + end);
            &captures[start..end]
        };
        let read = |screen: &str| claude_prompt(screen).map(|p| (p.draft, p.stashed));
        let draft = |text: &str| Some((text.to_string(), false));
        // Claude draws its placeholder, a queued-message hint and a suggested next
        // prompt dim; none of them is a draft.
        for name in [
            "idle placeholder",
            "queued hint while working",
            "working, empty",
        ] {
            assert_eq!(read(capture(name)), draft(""), "{name}");
        }
        let suggested = "\x1b[m❯\u{a0}\x1b[39m\x1b[49m\x1b[22m\x1b[24m\x1b[2m\x1b[23mok waiting";
        assert_eq!(
            read(&format!(
                "\x1b[38;2;136;136;136m{RULE}\r\n{suggested}\x1b[m\r\n\x1b[38;2;136;136;136m{RULE}\r\n"
            )),
            draft("")
        );
        assert_eq!(read(CLAUDE_IDLE), draft(""));
        // Typed text is drawn without styling.
        assert_eq!(read(capture("typed draft")), draft("hello draft words"));
        assert_eq!(
            read(capture("multi-line draft")),
            draft("line one\nline two")
        );
        assert_eq!(
            read(capture("pasted block in draft")),
            draft("before [Pasted text #1 +5 lines]")
        );
        assert_eq!(read(capture("shell-mode draft")), draft("echo hi"));
        // Shell mode runs whatever Enter submits, even from an empty box.
        let shell = |name: &str| claude_prompt(capture(name)).map(|p| (p.draft, p.shell));
        assert_eq!(shell("shell mode, empty"), Some((String::new(), true)));
        assert_eq!(shell("shell-mode draft"), Some(("echo hi".into(), true)));
        // A renamed session shows its name in the box's top rule.
        assert_eq!(
            read(capture("named session, typed draft")),
            draft("this is")
        );
        assert_eq!(read(&format!("{RULE} main ─❯ x\n{RULE}\n")), draft("x"));
        assert_eq!(shell("idle placeholder"), Some((String::new(), false)));
        assert_eq!(read(capture("stashed, empty")), Some((String::new(), true)));
        assert_eq!(
            read(capture("stashed, with a new draft")),
            Some(("second draft".into(), true))
        );
        // Only dim cells are hints; a true-colour foreground's 2 is not dim.
        for (screen, text) in [
            ("\x1b[m❯\u{a0}\x1b[2mok \x1b[0mwaiting", "waiting"),
            ("\x1b[m❯\u{a0}\x1b[38;2;200;200;200mtyped", "typed"),
            ("\x1b[m❯\u{a0}\x1b[38;5;2mtyped", "typed"),
        ] {
            assert_eq!(
                read(&format!("{RULE}\n{screen}\x1b[m\n{RULE}\n")),
                draft(text),
                "{screen}"
            );
        }
        // `dump-screen` can join a rule to the rows on either side.
        assert_eq!(
            read(&format!(
                "{RULE}❯ line one\n  line two{RULE}  ⏵⏵ auto mode on   › stashed\n"
            )),
            Some(("line one\nline two".into(), true))
        );
        // A transcript line after the box is not the footer.
        assert_eq!(
            read(&format!("› stashed\n{RULE}\n❯ x\n{RULE}\n")),
            draft("x")
        );
        // No input box: a dialog, a transcript line, a shell.
        for screen in [
            format!("{RULE} Bash command\n echo hi\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel\n"),
            "❯ an earlier message\n● Done.\n".into(),
            format!("{RULE}\n❯ unfinished box\n"),
            "dom@mac ~ %".into(),
        ] {
            assert_eq!(read(&screen), None, "{screen}");
        }
    }

    #[test]
    fn switchboard_conversation_confirms_only_the_startup_hook_menu() {
        assert_eq!(
            trust_keys(REVIEW),
            Some(["27", "91", "66", "13"].as_slice())
        );
        assert_eq!(trust_keys(&REVIEW.replace(' ', "\n")), trust_keys(REVIEW));
        let trusted = REVIEW.replace("› 1.", "  1.").replace("  2.", "› 2.");
        assert_eq!(trust_keys(&trusted), Some(["13"].as_slice()));
        for screen in [
            REVIEW.replace("› 1.", "  1.").replace("  3.", "› 3."),
            format!("{REVIEW}\n› Ask Codex to do anything\nGPT-6 · ? for shortcuts"),
            format!("{REVIEW}\nPS C:\\repo>"),
            REVIEW.replace("Hooks need review", "Would you like to run this command?"),
            REVIEW.replace("Trust all and continue", "Allow and continue"),
            REVIEW.replace("› 1.", "  1."),
            REVIEW.replace("  2.", "› 2."),
        ] {
            assert_eq!(trust_keys(&screen), None, "{screen}");
        }
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn switchboard_conversation_preparation_checks_the_pane_and_confirms_once() {
        let upstream = Router::new()
            .route(
                "/command/login",
                post(|| async { ([(header::SET_COOKIE, "session_token=t")], "{}") }),
            )
            .route(
                "/session-list",
                get(|| async {
                    Json(json!({"sessions":[{"name":"fixture","web_clients_allowed":true}]}))
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        let screen = dir.path().join("screen");
        let catalog = dir.path().join("panes.json");
        let actions = dir.path().join("actions");
        let cli = dir.path().join(if cfg!(windows) {
            "zellij.cmd"
        } else {
            "zellij"
        });
        std::fs::write(&token, "t").unwrap();
        std::fs::write(
            &catalog,
            r#"[{"id":7,"tab_id":8,"pane_command":"codex","is_plugin":false}]"#,
        )
        .unwrap();
        // Input clears the fake screen, unless `after-<first key>` holds the screen
        // that key leads to. `ansi`, when present, is what a styled dump reads.
        // `fail-list`, `fail-plain` and `fail-ansi` each fail that read once. `slow-list`
        // makes one list take longer than the identify wait, then installs `after-list`.
        #[cfg(windows)]
        std::fs::write(
            &cli,
            format!(
                r#"@echo off
if "%~4"=="list-panes" goto catalog
if "%~4"=="dump-screen" goto screen
if "%~4"=="write" goto write
if "%~4"=="paste" goto write
exit /b 1
:catalog
if exist "{dir}\fail-list" (del "{dir}\fail-list" & exit /b 2)
if exist "{dir}\slow-list" (del "{dir}\slow-list" & ping -n 4 127.0.0.1 >nul & type "{catalog}" & move /y "{dir}\after-list" "{catalog}" >nul & exit /b 0)
type "{catalog}"
exit /b 0
:screen
if "%~5"=="--ansi" if exist "{dir}\fail-ansi" (del "{dir}\fail-ansi" & exit /b 2)
if not "%~5"=="--ansi" if exist "{dir}\fail-plain" (del "{dir}\fail-plain" & exit /b 2)
if "%~5"=="--ansi" if exist "{dir}\ansi" (type "{dir}\ansi" & exit /b 0)
type "{screen}"
exit /b 0
:write
echo %*>>"{actions}"
if exist "{dir}\after-%~7" (copy /y "{dir}\after-%~7" "{screen}" >nul) else (type nul >"{screen}")
"#,
                catalog = catalog.display(),
                screen = screen.display(),
                actions = actions.display(),
                dir = dir.path().display(),
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(
                &cli,
                format!(
                    r#"#!/bin/sh
case "$4" in
list-panes) if [ -f '{dir}/fail-list' ]; then rm '{dir}/fail-list'; exit 2; fi
  if [ -f '{dir}/slow-list' ]; then rm '{dir}/slow-list'; sleep 3; cat '{catalog}'; mv '{dir}/after-list' '{catalog}'; exit 0; fi
  cat '{catalog}' ;;
dump-screen) if [ "$5" = --ansi ]; then fail='{dir}/fail-ansi'; else fail='{dir}/fail-plain'; fi
  if [ -f "$fail" ]; then rm "$fail"; exit 2; fi
  if [ "$5" = --ansi ] && [ -f '{dir}/ansi' ]; then cat '{dir}/ansi'; else cat '{screen}'; fi ;;
write|paste) printf '%s\n' "$*" >> '{actions}'
  if [ -f '{dir}/after-'"$7" ]; then cp '{dir}/after-'"$7" '{screen}'; else : > '{screen}'; fi ;;
*) exit 1 ;;
esac
"#,
                    catalog = catalog.display(),
                    screen = screen.display(),
                    actions = actions.display(),
                    dir = dir.path().display(),
                ),
            )
            .unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut config = super::super::tests::config(&url);
        config.token_file = token.to_string_lossy().into();
        config.zellij_binary = Some(cli.to_string_lossy().into());
        let host = Host::new(config).unwrap();
        let target = || Target {
            session: "fixture".into(),
            pane_id: 7,
            tab_id: 8,
        };
        std::fs::write(&screen, REVIEW).unwrap();
        assert_eq!(
            local(&host, target()).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        assert!(
            !actions.exists(),
            "An invalid host token must not write to the pane"
        );
        use zellij_utils::web_authentication_tokens::{
            create_session_token, create_token, revoke_token,
        };
        struct Tokens(Vec<String>);
        impl Drop for Tokens {
            fn drop(&mut self) {
                for name in &self.0 {
                    let _ = revoke_token(name);
                }
            }
        }
        let mut tokens = Tokens(Vec::new());
        for read_only in [true, false] {
            let (auth, name) = create_token(
                Some(format!("conversation-test-{}", uuid::Uuid::new_v4())),
                read_only,
            )
            .unwrap();
            tokens.0.push(name);
            let session = create_session_token(&auth, false).unwrap();
            *host.cookie.lock().await = Some(format!("session_token={session}"));
            if read_only {
                assert_eq!(
                    skills_local(
                        &host,
                        Skills {
                            cwd: String::new(),
                            agent: None,
                        },
                    )
                    .await
                    .unwrap_err()
                    .0,
                    StatusCode::FORBIDDEN
                );
                assert_eq!(
                    local(&host, target()).await.unwrap_err().0,
                    StatusCode::FORBIDDEN
                );
                assert!(
                    !actions.exists(),
                    "A view-only host must not confirm hook trust"
                );
            }
        }
        assert!(local(
            &host,
            Target {
                tab_id: 9,
                ..target()
            }
        )
        .await
        .is_err());
        assert!(!actions.exists());
        for other in [
            "Would you like to run this command?\n› 1. Yes\n2. No\nenter confirm · esc skip",
            "PS C:\\repo>",
        ] {
            std::fs::write(&screen, other).unwrap();
            assert_eq!(local(&host, target()).await.unwrap().0["trusted"], false);
            assert!(!actions.exists());
        }
        std::fs::write(&screen, REVIEW).unwrap();
        assert_eq!(local(&host, target()).await.unwrap().0["trusted"], true);
        assert_eq!(local(&host, target()).await.unwrap().0["trusted"], false);
        assert_eq!(
            std::fs::read_to_string(&actions).unwrap().trim(),
            "-s fixture action write -p 7 27 91 66 13"
        );

        // Claude's startup trust uses the same checked pane and writable host.
        std::fs::remove_file(&actions).unwrap();
        std::fs::write(&screen, include_str!("fixtures/claude-folder-trust.txt")).unwrap();
        for command in ["vim", "tail -f claude-folder-trust.txt"] {
            std::fs::write(
                &catalog,
                json!([{"id":7,"tab_id":8,"pane_command":command,"is_plugin":false}]).to_string(),
            )
            .unwrap();
            assert_eq!(local(&host, target()).await.unwrap().0["trusted"], false);
            assert!(!actions.exists(), "another program's dialog gets no keys");
        }
        std::fs::write(
            &catalog,
            r#"[{"id":7,"tab_id":8,"pane_command":"claude","is_plugin":false}]"#,
        )
        .unwrap();
        // The dialog stays on screen after the keys are accepted, as it does until
        // Claude redraws.
        let retained = dir.path().join("after-27");
        std::fs::write(&retained, include_str!("fixtures/claude-folder-trust.txt")).unwrap();
        assert_eq!(local(&host, target()).await.unwrap().0["trusted"], true);
        assert_eq!(local(&host, target()).await.unwrap().0["trusted"], true);
        let token =
            prompt::folder_trust_token(include_str!("fixtures/claude-folder-trust.txt")).unwrap();
        let answer: prompt::Answer = serde_json::from_value(
            json!({"session":"fixture","pane_id":7,"tab_id":8,"token":token,"choice":1}),
        )
        .unwrap();
        assert_eq!(
            prompt::answer_local(&host, answer).await.unwrap_err().0,
            StatusCode::CONFLICT,
            "a card answered just after automatic acceptance sends nothing more"
        );
        assert_eq!(
            std::fs::read_to_string(&actions).unwrap().trim(),
            "-s fixture action write -p 7 27 91 66 13"
        );
        std::fs::remove_file(&retained).unwrap();
        std::fs::write(&screen, "").unwrap();
        assert_eq!(local(&host, target()).await.unwrap().0["trusted"], false);
        std::fs::remove_file(&actions).unwrap();

        // Claude replies type into an empty prompt only.
        let reply = |text: &str| Reply {
            session: "fixture".into(),
            pane_id: 7,
            tab_id: 8,
            text: text.into(),
        };
        // A dialog in place of the input box is never typed into.
        std::fs::write(
            &screen,
            format!(
                "{RULE} Bash command\n echo hi\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"
            ),
        )
        .unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap_err(),
            (StatusCode::CONFLICT, AWAITING_PROMPT)
        );
        assert!(!actions.exists());
        // A box that returns during the wait, as after a resize redraw, takes the reply.
        let (sent, ()) = tokio::join!(reply_local(&host, None, reply("hi")), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::write(&screen, CLAUDE_IDLE).unwrap();
        });
        assert_eq!(sent.unwrap().0["ok"], true);
        std::fs::remove_file(&actions).unwrap();
        for bad in ["", "  ", "a\x1b[201~b", &"x".repeat(REPLY_LIMIT + 1)] {
            assert_eq!(
                reply_local(&host, None, reply(bad)).await.unwrap_err().0,
                StatusCode::BAD_REQUEST
            );
        }
        assert!(!actions.exists());
        // A busy computer leaves out the command, and Claude's default footer names no
        // mode: only another read can identify the pane.
        let default_idle = format!("{RULE}\n❯\u{a0}\n{RULE}\n  ? for shortcuts\n");
        let no_command = r#"[{"id":7,"tab_id":8,"is_plugin":false}]"#;
        let claude_command = r#"[{"id":7,"tab_id":8,"pane_command":"claude","is_plugin":false}]"#;
        std::fs::write(&catalog, no_command).unwrap();
        std::fs::write(&screen, &default_idle).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap_err(),
            (StatusCode::CONFLICT, NOT_CLAUDE),
            "nothing identifies this pane, so nothing is typed"
        );
        assert!(!actions.exists());
        // The command comes back on a later read.
        let (sent, ()) = tokio::join!(reply_local(&host, None, reply("hi")), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::write(&catalog, claude_command).unwrap();
        });
        assert_eq!(sent.unwrap().0["ok"], true);
        std::fs::remove_file(&actions).unwrap();
        // Claude's hooks keep the message waiting, but never type by themselves.
        let poll: Arc<Mutex<attention::PollState>> = Default::default();
        poll.lock().await.hook_claude_for_test("fixture", 7);
        std::fs::write(&catalog, no_command).unwrap();
        std::fs::write(&screen, &default_idle).unwrap();
        assert_eq!(
            reply_local(&host, Some(&poll), reply("hi"))
                .await
                .unwrap_err(),
            (StatusCode::CONFLICT, AWAITING_PROMPT)
        );
        assert!(!actions.exists());
        // A first read slower than the whole wait still gets a second read.
        std::fs::write(dir.path().join("slow-list"), "").unwrap();
        std::fs::write(dir.path().join("after-list"), claude_command).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap().0["ok"],
            true
        );
        std::fs::remove_file(&actions).unwrap();
        // The report is stale once the pane runs something else.
        std::fs::write(
            &catalog,
            r#"[{"id":7,"tab_id":8,"pane_command":"vim","is_plugin":false}]"#,
        )
        .unwrap();
        std::fs::write(&screen, &default_idle).unwrap();
        assert_eq!(
            reply_local(&host, Some(&poll), reply("hi"))
                .await
                .unwrap_err(),
            (StatusCode::CONFLICT, NOT_CLAUDE)
        );
        assert!(!actions.exists());
        std::fs::write(&catalog, claude_command).unwrap();
        std::fs::write(&screen, CLAUDE_IDLE).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("-v")).await.unwrap().0["ok"],
            true
        );
        // cmd's echo writes CRLF; compare the recorded actions, not their line endings.
        assert_eq!(
            std::fs::read_to_string(&actions)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [
                "-s fixture action paste -p 7 -- -v",
                "-s fixture action write -p 7 13"
            ]
        );

        // A draft typed in Terminal goes into Claude's stash while the reply is sent,
        // and Claude puts it back.
        let typed = format!("{RULE}\n❯ half typed\n{RULE}\n");
        let after = |key: &str| dir.path().join(format!("after-{key}"));
        let recorded = || {
            let recorded = std::fs::read_to_string(&actions).unwrap();
            std::fs::remove_file(&actions).unwrap();
            recorded.lines().map(str::to_owned).collect::<Vec<_>>()
        };
        recorded();
        std::fs::write(&screen, &typed).unwrap();
        std::fs::write(
            after("19"),
            format!("{RULE}\n❯\u{a0}\n{RULE}\n  ⏵⏵ auto mode on   › stashed\n"),
        )
        .unwrap();
        std::fs::write(after("13"), &typed).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap().0,
            json!({"ok":true,"draft":"restored"})
        );
        assert_eq!(
            recorded(),
            [
                "-s fixture action write -p 7 19",
                "-s fixture action paste -p 7 -- hi",
                "-s fixture action write -p 7 13"
            ]
        );
        // If the draft does not come back, the browser says where it is.
        std::fs::remove_file(after("13")).unwrap();
        std::fs::write(&screen, &typed).unwrap();
        let sent = reply_local(&host, None, reply("hi")).await.unwrap().0;
        assert_eq!(sent["draft"], "stashed");
        assert!(sent["notice"].as_str().unwrap().contains("Ctrl+S"));
        assert_eq!(recorded().len(), 3);
        // Stashing over the user's own stash would lose it.
        std::fs::write(
            &screen,
            format!("{RULE}\n❯ new draft\n{RULE}\n  ⏵⏵ auto mode on   › stashed\n"),
        )
        .unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert!(!actions.exists());
        // A stash that does not happen leaves the draft alone and types nothing.
        std::fs::remove_file(after("19")).unwrap();
        std::fs::write(&screen, &typed).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(recorded(), ["-s fixture action write -p 7 19"]);
        // An empty shell-mode box would run the reply as a command: Backspace
        // returns it to chat mode first, and nothing is typed if it stays.
        let shell = format!("{RULE}\n! \n{RULE}\n  ! for shell mode\n");
        std::fs::write(&screen, &shell).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(recorded(), ["-s fixture action write -p 7 127"]);
        std::fs::write(after("127"), CLAUDE_IDLE).unwrap();
        std::fs::write(&screen, &shell).unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap().0,
            json!({"ok":true})
        );
        assert_eq!(
            recorded(),
            [
                "-s fixture action write -p 7 127",
                "-s fixture action paste -p 7 -- hi",
                "-s fixture action write -p 7 13"
            ]
        );
        std::fs::remove_file(after("127")).unwrap();
        // The fresh styled read decides: a dialog that replaced the box since the
        // first read is never typed into.
        std::fs::write(&screen, CLAUDE_IDLE).unwrap();
        std::fs::write(
            dir.path().join("ansi"),
            format!("{RULE} Bash command\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n"),
        )
        .unwrap();
        assert_eq!(
            reply_local(&host, None, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert!(!actions.exists());
        std::fs::remove_file(dir.path().join("ansi")).unwrap();

        // A read that fails once is repeated, and the reply is still typed once.
        for fail in ["fail-list", "fail-plain", "fail-ansi"] {
            std::fs::write(&screen, CLAUDE_IDLE).unwrap();
            std::fs::write(dir.path().join(fail), "").unwrap();
            assert_eq!(
                reply_local(&host, None, reply("hi")).await.unwrap().0,
                json!({"ok":true}),
                "{fail}"
            );
            assert!(!dir.path().join(fail).exists(), "{fail}");
            assert_eq!(
                recorded(),
                [
                    "-s fixture action paste -p 7 -- hi",
                    "-s fixture action write -p 7 13"
                ],
                "{fail}"
            );
        }

        // Claude's menus are answered only while the menu the browser showed is on screen.
        let permission = format!("● Bash(echo hi)\n{RULE} Bash command\n echo hi\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n");
        std::fs::write(&screen, &permission).unwrap();
        let shown = prompt::local(&host, target()).await.unwrap().0;
        assert_eq!(shown["prompt"]["question"], "Do you want to proceed?");
        assert_eq!(
            shown["prompt"]["detail"],
            json!(["Bash command", "echo hi"])
        );
        let token = shown["prompt"]["token"].as_str().unwrap().to_owned();
        let answer = |value: Value| {
            let mut answer = json!({"session":"fixture","pane_id":7,"tab_id":8});
            answer
                .as_object_mut()
                .unwrap()
                .extend(value.as_object().unwrap().clone());
            serde_json::from_value::<prompt::Answer>(answer).unwrap()
        };
        for (wrong, status) in [
            (json!({"token":"stale","choice":1}), StatusCode::CONFLICT),
            (json!({"token":token,"choice":5}), StatusCode::BAD_REQUEST),
            (
                json!({"token":token,"choice":0,"text":"yes"}),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            assert_eq!(
                prompt::answer_local(&host, answer(wrong))
                    .await
                    .unwrap_err()
                    .0,
                status
            );
        }
        assert!(!actions.exists());
        let no = || answer(json!({"token":token,"choice":1}));
        assert_eq!(
            prompt::answer_local(&host, no()).await.unwrap().0["ok"],
            true
        );
        // The fake terminal clears its screen on input, so the menu is gone.
        assert_eq!(
            prompt::answer_local(&host, no()).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            prompt::local(&host, target()).await.unwrap().0["prompt"],
            Value::Null
        );
        std::fs::write(
            &screen,
            format!("{RULE}\nWhich pet?\n\n❯ 1. Cat\n  2. Dog\n  3. Type something.\n\nEnter to select · Esc to cancel\n"),
        )
        .unwrap();
        let token = prompt::local(&host, target()).await.unwrap().0["prompt"]["token"].clone();
        assert_eq!(
            prompt::answer_local(
                &host,
                answer(json!({"token":token,"choice":2,"text":"a\x1b[201~"}))
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::BAD_REQUEST
        );
        let typed = answer(json!({"token":token,"choice":2,"text":"-goldfish"}));
        assert_eq!(
            prompt::answer_local(&host, typed).await.unwrap().0["ok"],
            true
        );
        assert_eq!(
            std::fs::read_to_string(&actions)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [
                "-s fixture action write -p 7 50",
                "-s fixture action write -p 7 51",
                "-s fixture action paste -p 7 -- -goldfish",
                "-s fixture action write -p 7 13"
            ]
        );
        std::fs::write(&screen, &permission).unwrap();
        std::fs::write(
            &catalog,
            r#"[{"id":7,"tab_id":8,"pane_command":"codex","is_plugin":false}]"#,
        )
        .unwrap();
        assert_eq!(
            prompt::local(&host, target()).await.unwrap().0["prompt"],
            Value::Null
        );
        // Codex replies must reach the actual TUI, including embedded servers
        // that the shared daemon reports as not loaded.
        if actions.exists() {
            recorded();
        }
        let chat = "codex-fixture";
        poll.lock().await.hook_codex_for_test("fixture", 7, chat);
        std::fs::write(
            &catalog,
            r#"[{"id":7,"tab_id":8,"pane_command":"powershell -Command build","is_plugin":false}]"#,
        )
        .unwrap();
        let footer = "\n\n  GPT-6.1-Sol medium · project · ? for shortcuts\n";
        let codex_empty = format!(
            "Working (1s • esc to interrupt)\n\n› \x1b[2mAsk Codex to do anything\x1b[m{footer}"
        );
        std::fs::write(&screen, &codex_empty).unwrap();
        std::fs::write(
            dir.path().join("after---"),
            format!("› followup\n\n  GPT-6.1-Sol medium · project · tab to queue message\n"),
        )
        .unwrap();
        std::fs::write(dir.path().join("after-13"), &codex_empty).unwrap();
        codex::send(&host, &poll, &target(), chat, "followup", None)
            .await
            .unwrap();
        assert_eq!(
            recorded(),
            [
                "-s fixture action paste -p 7 -- followup",
                "-s fixture action write -p 7 13"
            ]
        );
        std::fs::write(&screen, &codex_empty).unwrap();
        assert!(
            codex::send(&host, &poll, &target(), "codex-other", "wrong thread", None)
                .await
                .is_err()
        );
        assert!(!actions.exists());
        for draft in ["Keep this draft", "Ask Codex to do anything", "hi"] {
            std::fs::write(&screen, format!("› {draft}{footer}")).unwrap();
            assert!(codex::send(&host, &poll, &target(), chat, "hi", None)
                .await
                .is_err());
            assert!(!actions.exists(), "A terminal draft must not receive Enter");
        }
        std::fs::write(&screen, REVIEW).unwrap();
        assert!(codex::send(&host, &poll, &target(), chat, "hi", None)
            .await
            .is_err());
        assert!(!actions.exists(), "A dialog must not receive a reply");
        // An input owned before a restart can finish with Enter alone.
        let key = "resumed-input";
        assert!(
            native_messages::outbox::input_ownership(dir.path(), key, "fixture", 7, chat, true)
                .await
        );
        assert!(
            !native_messages::outbox::input_ownership(dir.path(), key, "fixture", 9, chat, false)
                .await
        );
        std::fs::write(&screen, format!("› followup{footer}")).unwrap();
        codex::send(
            &host,
            &poll,
            &target(),
            chat,
            "followup",
            Some((dir.path(), key)),
        )
        .await
        .unwrap();
        assert_eq!(recorded(), ["-s fixture action write -p 7 13"]);
        server.abort();
    }
}
