//! Replies must reach the server that owns the terminal's thread. `codex queue`
//! can connect to a different daemon when the TUI uses an embedded app server.
use super::*;

fn target(snapshot: &Value, chat: &str) -> Option<Target> {
    let mut panes = snapshot["panes"].as_array()?.iter().filter(|pane| {
        pane["agent"] == "codex" && pane["chat_id"] == chat && pane["state"] != "approval"
    });
    let pane = panes.next()?;
    if panes.next().is_some() {
        return None;
    }
    Some(Target {
        session: pane["session"].as_str()?.into(),
        pane_id: pane["pane_id"].as_u64()?.try_into().ok()?,
        tab_id: pane["tab_id"].as_u64()?.try_into().ok()?,
    })
}

// Only the bottom composer, followed by Codex's model footer, is an input box.
// Dim placeholder text is not a draft. Bright text, including text that happens
// to equal the placeholder, belongs to the user and must be left alone.
fn prompt(screen: &str) -> Option<String> {
    let rows = styled_rows(screen);
    let plain = |row: &Vec<(char, bool)>| row.iter().map(|cell| cell.0).collect::<String>();
    let footer = rows.iter().rposition(|row| {
        let text = plain(row);
        let text = text.trim();
        text.starts_with("GPT-") || text.starts_with("gpt-")
    })?;
    let model = plain(&rows[footer]);
    let mut hints = model.contains("for shortcuts") || model.contains("tab to queue");
    let mut tip = false;
    for row in &rows[footer + 1..] {
        let text = plain(row);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        // Codex can put its keyboard hints below the model, with warnings on
        // the same row. Other content below the footer (a shell or dialog)
        // must still keep delivery paused.
        if !hints
            && ((text.starts_with("← for agents")
                && (text.contains("for shortcuts") || text.contains("tab to queue")))
                || text.starts_with("? for shortcuts")
                || text.starts_with("tab to queue"))
        {
            hints = true;
        } else if hints && !tip && text.starts_with("└ Tip:") {
            tip = true;
        } else if !(hints
            && text.starts_with('⚠')
            && text.contains("warning")
            && text.ends_with("f2 to view"))
        {
            return None;
        }
    }
    if !hints {
        return None;
    }
    let start = rows[..footer]
        .iter()
        .rposition(|row| plain(row).trim_start().starts_with('›'))?;
    let marker = rows[start].iter().position(|cell| cell.0 == '›')?;
    let draft = std::iter::once(&rows[start][marker + 1..])
        .chain(rows[start + 1..footer].iter().map(Vec::as_slice))
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
    Some(draft)
}

pub(in crate::switchboard_relay) async fn reply(
    state: &RelayState,
    thread: &str,
    text: &str,
    bound_chat: Option<&str>,
    home: &Path,
    key: &str,
) -> bool {
    let Some(host) = state
        .all_hosts()
        .into_iter()
        .find(|host| host.is_local_engine())
    else {
        return false;
    };
    let info = chats::thread_info("codex", thread);
    let Some(chat) = bound_chat.or_else(|| info["chat_id"].as_str()) else {
        return false;
    };
    let destination = {
        let poll = state.poll.lock().await;
        let Some(snapshot) = poll.owned(&host.config.id) else {
            return false;
        };
        let Some(target) = target(&snapshot, chat) else {
            return false;
        };
        target
    };
    let result = send(
        &host,
        &state.poll,
        &destination,
        chat,
        text,
        Some((home, key)),
    )
    .await;
    if let Err((_, detail)) = &result {
        logs::record("Messages", &format!("Codex reply retained: {detail}"));
    }
    result.is_ok()
}

pub(super) async fn send(
    host: &Host,
    poll: &Arc<Mutex<attention::PollState>>,
    destination: &Target,
    chat: &str,
    text: &str,
    receipt: Option<(&Path, &str)>,
) -> Result<(), Error> {
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid control character in Codex reply",
        ));
    }
    let _guard = acting_on(&destination.session, destination.pane_id).await;
    checked_screen(host, destination, tokio::time::Instant::now()).await?;
    // A foreground build can replace the command name while Codex still owns
    // this terminal. Use the exact hook binding and the live composer below.
    let draft = read(&host, destination)
        .await?
        .ok_or((StatusCode::CONFLICT, "Waiting for Codex's composer"))?;
    let owned = if let Some((home, key)) = receipt {
        native_messages::outbox::input_ownership(
            home,
            key,
            &destination.session,
            destination.pane_id,
            chat,
            false,
        )
        .await
    } else {
        false
    };
    if !draft.is_empty() && !(owned && matches_input(&draft, text)) {
        return Err((
            StatusCode::CONFLICT,
            "Waiting for the terminal draft to be sent or cleared",
        ));
    }
    if !poll
        .lock()
        .await
        .hooked_chat(&destination.session, destination.pane_id, "codex", chat)
    {
        return Err((StatusCode::CONFLICT, "The Codex conversation changed"));
    }
    let pane = destination.pane_id.to_string();
    if draft.is_empty() {
        if let Some((home, key)) = receipt {
            if !native_messages::outbox::input_ownership(
                home,
                key,
                &destination.session,
                destination.pane_id,
                chat,
                true,
            )
            .await
            {
                return Err((
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Cannot record Codex input ownership",
                ));
            }
        }
        control::run_local(
            host,
            &destination.session,
            &["paste", "-p", &pane, "--", text],
            Duration::from_secs(5),
        )
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot paste the Codex reply"))?;
        // Codex can ignore Enter while the bracketed paste is still being read.
        // Wait for the actual composer to show this input before submitting it.
        wait_input(host, destination, |draft| matches_input(draft, text)).await?;
    }
    write_keys(host, &destination.session, &pane, "13").await?;
    wait_input(host, destination, str::is_empty).await
}

fn matches_input(draft: &str, text: &str) -> bool {
    let compact = |value: &str| {
        value
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    };
    compact(draft) == compact(text)
        || draft == format!("[Pasted Content {} chars]", text.chars().count())
}

async fn read(host: &Host, destination: &Target) -> Result<Option<String>, Error> {
    let pane = destination.pane_id.to_string();
    let screen = control::run_local(
        host,
        &destination.session,
        &["dump-screen", "--ansi", "-p", &pane],
        READ_ATTEMPT,
    )
    .await
    .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot read Codex's composer"))?;
    Ok(prompt(&screen))
}

async fn wait_input(
    host: &Host,
    destination: &Target,
    done: impl Fn(&str) -> bool,
) -> Result<(), Error> {
    let until = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if read(host, destination)
            .await?
            .is_some_and(|draft| done(&draft))
        {
            return Ok(());
        }
        if tokio::time::Instant::now() >= until {
            return Err((StatusCode::CONFLICT, "Waiting for Codex to read the reply"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switchboard_codex_reply_recognizes_the_captured_multiline_footer() {
        // Codex 0.167, captured with dump-screen --ansi. Its model and keyboard
        // hints occupy different rows; the placeholder is dim, not a draft.
        let screen = include_str!("../fixtures/codex-multiline-composer.ansi");
        assert_eq!(prompt(screen), Some(String::new()));
        assert_eq!(
            prompt(&format!(
                "{screen}  └ Tip: Use /fork to branch the current chat.\n"
            )),
            Some(String::new())
        );
        assert!(prompt(&format!("{screen}PS C:\\project> ")).is_none());
        assert!(prompt(&format!("{screen}› 1. Yes\n2. No\nEsc to cancel")).is_none());
        for draft in [
            "Keep my draft",
            "Ask Codex to do anything",
            "First line\nsecond line",
        ] {
            let typed = screen.replace("Ask Codex to do anything", &format!("\x1b[m{draft}"));
            assert_eq!(prompt(&typed), Some(draft.into()));
        }
        assert!(prompt("› Message\nGPT-6.1-Sol high · Example task\n").is_none());
    }

    #[test]
    fn switchboard_codex_reply_matches_only_the_exact_live_chat() {
        let pane = json!({"agent":"codex","chat_id":"codex-fixture","session":"main","pane_id":7,"tab_id":3,"state":"working"});
        assert_eq!(
            target(&json!({"panes":[pane.clone()]}), "codex-fixture")
                .unwrap()
                .pane_id,
            7
        );
        assert!(target(&json!({"panes":[pane.clone()]}), "codex-other").is_none());
        assert!(target(
            &json!({"panes":[pane.clone(),pane.clone()]}),
            "codex-fixture"
        )
        .is_none());
        let mut approval = pane;
        approval["state"] = json!("approval");
        assert!(target(&json!({"panes":[approval]}), "codex-fixture").is_none());
    }

    #[test]
    fn switchboard_codex_reply_keeps_drafts_and_ignores_historical_prompts() {
        let footer =
            "\n\n  GPT-6.1-Sol medium · project · Example task  ← for agents · ? for shortcuts\n";
        // Captured from a working Codex 0.167 pane, with paths/title anonymized.
        let screen = format!("Working (3m 22s • esc to interrupt)\n\n\x1b[1m›\x1b[m \x1b[2mAsk Codex to do anything{footer}");
        assert_eq!(prompt(&screen), Some(String::new()));
        for draft in [
            "Keep my draft",
            "Ask Codex to do anything",
            "First line\nsecond line",
        ] {
            assert_eq!(prompt(&format!("› {draft}{footer}")), Some(draft.into()));
        }
        assert!(prompt("› Historical message\nAn assistant reply\n").is_none());
        assert!(
            prompt("Hooks need review\n› 2. Trust all and continue\nenter confirm · esc skip")
                .is_none()
        );
        assert!(prompt("› 1. Yes\n2. No\nEsc to cancel").is_none());
        assert!(prompt(&format!(
            "› \x1b[2mAsk Codex to do anything\x1b[m{footer}PS C:\\project> "
        ))
        .is_none());
        assert!(matches_input(
            "[Pasted Content 1000 chars]",
            &"x".repeat(1000)
        ));
        assert!(!matches_input(
            "[Pasted Content 1001 chars]",
            &"x".repeat(1000)
        ));
    }
}
