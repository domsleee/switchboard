//! The one startup dialog Conversation can complete without opening a terminal viewer.
use super::*;
use serde::Serialize;

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

pub(super) async fn local(host: &Host, target: Target) -> Result<Json<Value>, Error> {
    // Two viewers must not both confirm the same dialog.
    static PREPARING: Mutex<()> = Mutex::const_new(());
    let _guard = PREPARING.lock().await;
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
        .iter()
        .find(|pane| {
            pane["id"] == target.pane_id
                && pane["tab_id"] == target.tab_id
                && pane["is_plugin"] == false
                && pane["exited"] != true
                && pane["is_held"] != true
        })
        .ok_or((StatusCode::CONFLICT, "The selected pane changed"))?;
    let id = target.pane_id.to_string();
    let screen = control::run_local(
        host,
        &target.session,
        &["dump-screen", "-p", &id],
        Duration::from_secs(5),
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot read the selected pane"))?;
    if attention::classify(pane, &screen)["agent"] != "codex" {
        return Ok(Json(json!({"trusted":false})));
    }
    let Some(keys) = trust_keys(&screen) else {
        return Ok(Json(json!({"trusted":false})));
    };
    let mut args = vec!["write", "-p", &id];
    args.extend_from_slice(keys);
    control::run_local(host, &target.session, &args, Duration::from_secs(5))
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot confirm hook trust"))?;
    Ok(Json(json!({"trusted":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    // Captured from Codex 0.167.0 in an isolated CODEX_HOME, before any prompt.
    const REVIEW: &str = "\n  Hooks need review\n  1 hook is new or changed.\n  Hooks can run outside the sandbox after you trust them.\n\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won't run)\n\n  enter confirm · esc skip\n\n";

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
write) printf '%s\n' "$*" >> '{}'; : > '{}' ;;
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
            std::fs::read_to_string(actions).unwrap().trim(),
            "-s fixture action write -p 7 27 91 66 13"
        );
        server.abort();
    }
}
