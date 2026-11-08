//! What Conversation does to a pane without opening a terminal viewer: complete
//! Codex's startup hooks review, type a reply into Claude's empty prompt, and
//! answer Claude's numbered menus (see `prompt`).
use super::*;
use serde::Serialize;
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

/// Reads the selected pane after checking it is still the one the browser chose.
async fn checked_screen(host: &Host, target: &Target) -> Result<(Value, String), Error> {
    control::validate_session(&target.session)?;
    if !control::sessions(host)
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot check shared sessions"))?
        .contains(&target.session)
    {
        return Err((StatusCode::CONFLICT, "Session is not shared"));
    }
    control::require_writable_host(host).await?;
    let panes = control::list_panes(host, &target.session, true, Duration::from_secs(5))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot read terminal panes"))?;
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
    let screen = control::run_local(
        host,
        &target.session,
        &["dump-screen", "-p", &target.pane_id.to_string()],
        Duration::from_secs(5),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot read the selected pane"))?;
    Ok((pane, screen))
}

// Two viewers must not both act on the same screen.
static ACTING: Mutex<()> = Mutex::const_new(());

pub(super) async fn local(host: &Host, target: Target) -> Result<Json<Value>, Error> {
    let _guard = ACTING.lock().await;
    let (pane, screen) = checked_screen(host, &target).await?;
    if attention::classify(&pane, &screen)["agent"] != "codex" {
        return Ok(Json(json!({"trusted":false})));
    }
    let Some(keys) = trust_keys(&screen) else {
        return Ok(Json(json!({"trusted":false})));
    };
    let id = target.pane_id.to_string();
    let mut args = vec!["write", "-p", &id];
    args.extend_from_slice(keys);
    control::run_local(host, &target.session, &args, Duration::from_secs(5))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot confirm hook trust"))?;
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
            if run >= 8 {
                if row[start..i].iter().any(|cell| !cell.0.is_whitespace()) {
                    split.push(row[start..i].to_vec());
                }
                split.push(row[i..i + run].to_vec());
                start = i + run;
            }
            i += run.max(1);
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
        return Some(ClaudePrompt { draft, stashed });
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
    reply_local(&host, reply)
        .await
        .map(IntoResponse::into_response)
}

pub(super) const REPLY_LIMIT: usize = 16000;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Skills {
    cwd: String,
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
    if request.cwd.len() > 4096
        || (!request.cwd.is_empty() && !Path::new(&request.cwd).is_absolute())
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid project directory"));
    }
    control::require_writable_host(host).await?;
    let cwds: Vec<&str> = if request.cwd.is_empty() {
        vec![]
    } else {
        vec![&request.cwd]
    };
    let cwd = (!request.cwd.is_empty()).then(|| Path::new(&request.cwd));
    let result = codex_app_server(cwd, "skills/list", json!({"cwds":cwds}))
        .await
        .ok_or((StatusCode::BAD_GATEWAY, "Cannot list Codex skills"))?;
    Ok(Json(json!({"skills":skill_choices(&result)})))
}

/// The models this computer's Codex offers, as `{id, name, default}`, in Codex's order.
/// Empty when Codex is missing or does not answer.
pub(crate) async fn codex_models() -> Vec<Value> {
    let Some(result) = codex_app_server(None, "model/list", json!({})).await else {
        return vec![];
    };
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["hidden"] != true)
        .filter_map(|model| {
            let id = model["model"].as_str().or_else(|| model["id"].as_str())?;
            let name = model["displayName"].as_str().unwrap_or(id);
            Some(json!({"id":id,"name":name,"default":model["isDefault"] == true}))
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

pub(super) async fn reply_local(host: &Host, reply: Reply) -> Result<Json<Value>, Error> {
    let text = &reply.text;
    if text.trim().is_empty()
        || text.len() > REPLY_LIMIT
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid reply"));
    }
    let _guard = ACTING.lock().await;
    let target = Target {
        session: reply.session.clone(),
        pane_id: reply.pane_id,
        tab_id: reply.tab_id,
    };
    let (pane, screen) = checked_screen(host, &target).await?;
    if attention::classify(&pane, &screen)["agent"] != "claude" {
        return Err((StatusCode::CONFLICT, "The selected pane is not Claude"));
    }
    let id = reply.pane_id.to_string();
    let session = &reply.session;
    let prompt = read_prompt(host, session, &id)
        .await
        .or_else(|| claude_prompt(&screen))
        .ok_or((
            StatusCode::CONFLICT,
            "Claude is not at its prompt. Open Terminal to see what it needs.",
        ))?;
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
        wait_for_prompt(host, session, &id, |now| {
            now.draft.is_empty() && now.stashed
        })
        .await
        .ok_or((
            StatusCode::CONFLICT,
            "Claude did not set the terminal draft aside. Open Terminal to send.",
        ))?;
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
        !now.stashed && now.draft == prompt.draft
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
async fn read_prompt(host: &Host, session: &str, pane: &str) -> Option<ClaudePrompt> {
    let screen = control::run_local(
        host,
        session,
        &["dump-screen", "--ansi", "-p", pane],
        Duration::from_secs(5),
    )
    .await
    .ok()?;
    claude_prompt(&screen)
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
        if let Some(prompt) = read_prompt(host, session, pane).await {
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
        let captures = include_str!("conversation/claude_prompt.ansi");
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
        // that key leads to.
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
type "{catalog}"
exit /b 0
:screen
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
list-panes) cat '{catalog}' ;;
dump-screen) cat '{screen}' ;;
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
                    skills_local(&host, Skills { cwd: String::new() })
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

        // Claude replies type into an empty prompt only.
        std::fs::remove_file(&actions).unwrap();
        std::fs::write(
            &catalog,
            r#"[{"id":7,"tab_id":8,"pane_command":"claude","is_plugin":false}]"#,
        )
        .unwrap();
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
            reply_local(&host, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        for bad in ["", "  ", "a\x1b[201~b", &"x".repeat(REPLY_LIMIT + 1)] {
            assert_eq!(
                reply_local(&host, reply(bad)).await.unwrap_err().0,
                StatusCode::BAD_REQUEST
            );
        }
        assert!(!actions.exists());
        std::fs::write(&screen, CLAUDE_IDLE).unwrap();
        assert_eq!(reply_local(&host, reply("-v")).await.unwrap().0["ok"], true);
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
            reply_local(&host, reply("hi")).await.unwrap().0,
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
        let sent = reply_local(&host, reply("hi")).await.unwrap().0;
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
            reply_local(&host, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert!(!actions.exists());
        // A stash that does not happen leaves the draft alone and types nothing.
        std::fs::remove_file(after("19")).unwrap();
        std::fs::write(&screen, &typed).unwrap();
        assert_eq!(
            reply_local(&host, reply("hi")).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        assert_eq!(recorded(), ["-s fixture action write -p 7 19"]);

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
        server.abort();
    }
}
