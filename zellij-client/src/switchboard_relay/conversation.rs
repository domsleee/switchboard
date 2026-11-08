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

/// Splits a `dump-screen --ansi` capture into lines of plain text, each paired
/// with the same text minus anything drawn dim (SGR 2). Other escapes are dropped.
fn screen_lines(screen: &str) -> Vec<(String, String)> {
    let mut lines = Vec::new();
    let (mut plain, mut bright, mut dim) = (String::new(), String::new(), false);
    let mut chars = screen.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' if chars.peek() == Some(&'[') => {
                chars.next();
                let mut params = String::new();
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        if c == 'm' {
                            for code in params.split(';') {
                                match code {
                                    "" | "0" | "22" => dim = false,
                                    "2" => dim = true,
                                    _ => {},
                                }
                            }
                        }
                        break;
                    }
                    params.push(c);
                }
            },
            '\n' => lines.push((std::mem::take(&mut plain), std::mem::take(&mut bright))),
            '\r' => {},
            c => {
                plain.push(c);
                if !dim {
                    bright.push(c);
                }
            },
        }
    }
    if !plain.is_empty() {
        lines.push((plain, bright));
    }
    lines
}

/// Claude's prompt box is empty: the last `❯` line holds nothing but its
/// placeholder or a dim suggested prompt, and only blank lines sit between it
/// and the box's lower rule. `screen` may carry ANSI styling, which is how a
/// suggestion (drawn dim) is told apart from a typed draft.
/// The same check the terminal bridge makes before pasting a reply.
fn claude_prompt_empty(screen: &str) -> bool {
    let lines = screen_lines(screen);
    let Some(index) = lines
        .iter()
        .rposition(|(line, _)| line.trim_start().starts_with('❯'))
    else {
        return false;
    };
    let bright = lines[index].1.trim_start();
    let prompt = bright.strip_prefix('❯').unwrap_or("").trim();
    // Narrow panes cut the placeholder short with an ellipsis.
    let placeholder = prompt.len() > 5
        && prompt.starts_with("Try \"")
        && (prompt.ends_with('"') || prompt.ends_with('…'));
    if !prompt.is_empty() && !placeholder {
        return false;
    }
    for (line, _) in &lines[index + 1..] {
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        return text.chars().all(|c| matches!(c, '─' | '━' | ' '));
    }
    true
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
    let (program, path) = agent_setup::codex_queue_program()
        .ok_or((StatusCode::SERVICE_UNAVAILABLE, "Codex is unavailable"))?;
    let mut command = tokio::process::Command::new(program);
    command
        .arg("app-server")
        .env("PATH", path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if request.cwd.is_empty() {
        if let Some(home) = std::env::home_dir() {
            command.current_dir(home);
        }
    } else {
        command.current_dir(&request.cwd);
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
    let mut child = command
        .spawn()
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot list Codex skills"))?;
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let mut input = child.stdin.take().ok_or(())?;
        let mut output = BufReader::new(child.stdout.take().ok_or(())?).lines();
        let cwds: Vec<&str> = if request.cwd.is_empty() {
            vec![]
        } else {
            vec![&request.cwd]
        };
        for (id, method, params) in [
            (
                1,
                "initialize",
                json!({"clientInfo":{"name":"switchboard","version":env!("SWITCHBOARD_COMMIT")}}),
            ),
            (2, "skills/list", json!({"cwds":cwds})),
        ] {
            input
                .write_all(
                    format!("{}\n", json!({"id":id,"method":method,"params":params})).as_bytes(),
                )
                .await
                .map_err(|_| ())?;
            if id == 1 {
                input
                    .write_all(b"{\"method\":\"initialized\"}\n")
                    .await
                    .map_err(|_| ())?;
            }
            loop {
                let line = output.next_line().await.map_err(|_| ())?.ok_or(())?;
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message["id"] != id {
                    continue;
                }
                if message.get("error").is_some() {
                    return Err(());
                }
                if id == 2 {
                    return Ok(skill_choices(&message["result"]));
                }
                break;
            }
        }
        Err(())
    })
    .await;
    let _ = child.kill().await;
    let skills = result
        .ok()
        .and_then(Result::ok)
        .ok_or((StatusCode::BAD_GATEWAY, "Cannot list Codex skills"))?;
    Ok(Json(json!({"skills":skills})))
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
    // Styling tells a dim suggested prompt from a typed draft.
    let styled = control::run_local(
        host,
        &target.session,
        &["dump-screen", "--ansi", "-p", &target.pane_id.to_string()],
        Duration::from_secs(5),
    )
    .await
    .unwrap_or(screen);
    if !claude_prompt_empty(&styled) {
        return Err((
            StatusCode::CONFLICT,
            "Clear the terminal prompt before sending.",
        ));
    }
    let id = reply.pane_id.to_string();
    let session = &reply.session;
    // `--` keeps a reply that starts with `-` from reading as an option.
    control::run_local(
        host,
        session,
        &["paste", "-p", &id, "--", text],
        Duration::from_secs(5),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot type the reply"))?;
    control::run_local(
        host,
        session,
        &["write", "-p", &id, "13"],
        Duration::from_secs(5),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot submit the reply"))?;
    Ok(Json(json!({"ok":true})))
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
    fn switchboard_conversation_types_only_into_an_empty_claude_prompt() {
        assert!(claude_prompt_empty(CLAUDE_IDLE));
        assert!(claude_prompt_empty(
            &CLAUDE_IDLE.replace("❯\u{a0}", "❯ Try \"fix lint errors\"")
        ));
        // Captured from a 25-column Claude Code 2.1.319 pane.
        assert!(claude_prompt_empty(
            &CLAUDE_IDLE.replace("❯\u{a0}", "❯ Try \"write a test for …")
        ));
        // Claude Code 2.1.319 suggests a next prompt in dim text once a turn ends;
        // captured with `dump-screen --ansi` (styling trimmed to what it sets).
        let suggested = "\x1b[m❯\u{a0}\x1b[39m\x1b[49m\x1b[22m\x1b[24m\x1b[2m\x1b[23mok waiting";
        assert!(claude_prompt_empty(
            &CLAUDE_IDLE.replace("❯\u{a0}", suggested)
        ));
        assert!(claude_prompt_empty(&format!(
            "\x1b[38;2;136;136;136m{RULE}\r\n{suggested}\x1b[m\r\n\x1b[38;2;136;136;136m{RULE}\r\n"
        )));
        for screen in [
            CLAUDE_IDLE.replace("❯\u{a0}", "\x1b[m❯\u{a0}\x1b[39m\x1b[22mok waiting"),
            CLAUDE_IDLE.replace("❯\u{a0}", "\x1b[m❯\u{a0}\x1b[2mok \x1b[0mwaiting"),
            CLAUDE_IDLE.replace("❯\u{a0}", "❯\u{a0}[Pasted text #1 +3 lines]"),
            CLAUDE_IDLE.replace("❯\u{a0}", "❯ draft"),
            CLAUDE_IDLE.replace("❯\u{a0}\n", "❯\u{a0}first line\n  second line\n"),
            CLAUDE_IDLE.replace("❯\u{a0}\n", "❯\u{a0}\n  second line\n"),
            "Do you want to proceed?\n❯ 1. Yes\n  2. No\n".into(),
            "dom@mac ~ %".into(),
        ] {
            assert!(!claude_prompt_empty(&screen), "{screen}");
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
type "{}"
exit /b 0
:screen
type "{}"
exit /b 0
:write
echo %*>>"{}"
type nul >"{}"
"#,
                catalog.display(),
                screen.display(),
                actions.display(),
                screen.display()
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
list-panes) cat '{}' ;;
dump-screen) cat '{}' ;;
write|paste) printf '%s\n' "$*" >> '{}'; : > '{}' ;;
*) exit 1 ;;
esac
"#,
                    catalog.display(),
                    screen.display(),
                    actions.display(),
                    screen.display()
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
        std::fs::write(&screen, format!("{RULE}\n❯ half typed\n{RULE}\n")).unwrap();
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

        // Claude's menus are answered only while the menu the browser showed is on screen.
        std::fs::remove_file(&actions).unwrap();
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
