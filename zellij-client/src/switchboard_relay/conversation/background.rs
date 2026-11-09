//! Stops the background tasks a finished Claude turn is waiting on. Esc does nothing once
//! the turn has ended, so this drives Claude's Background dialog, rereading the pane before
//! each key so that a key never lands on a screen it was not meant for.
use super::*;

const DOWN: &[&str] = &["27", "91", "66"];
const ENTER: &[&str] = &["13"];
const ESCAPE: &[&str] = &["27"];
const STOP: &[&str] = &["120"];

/// Bounds the rounds if Claude keeps listing tasks.
const MAX_TASKS: usize = 32;
/// Claude can take a moment to end a task's process.
const SCREEN_WAIT: Duration = Duration::from_secs(3);
const FAILED: &str = "Claude did not stop its background tasks. Open Terminal to stop them.";

#[derive(Debug, PartialEq)]
enum View {
    /// The idle prompt, with running tasks counted in its footer.
    Tasks,
    /// The footer's task count is selected, so Enter opens the dialog.
    Selected,
    /// The Background list, or the detail view Claude opens when one task runs.
    Dialog,
    Other,
}

/// The lines under Claude's last horizontal rule. A usage notice can follow the footer,
/// and a rule that fills a narrow pane can share its line with the text after it.
fn below_rule(screen: &str) -> Vec<&str> {
    let lines = screen.lines().map(str::trim).collect::<Vec<_>>();
    let Some(rule) = lines.iter().rposition(|line| line.contains("───")) else {
        return lines.into_iter().filter(|line| !line.is_empty()).collect();
    };
    let tail = lines[rule].rsplit('─').next().unwrap_or_default().trim();
    std::iter::once(tail)
        .chain(lines[rule + 1..].iter().copied())
        .filter(|line| !line.is_empty())
        .collect()
}

/// Whether a line ends with `hint`, allowing for Claude cutting it short in a narrow pane.
fn ends_with_hint(line: &str, hint: &str) -> bool {
    line.ends_with(hint)
        || line.strip_suffix('…').is_some_and(|line| {
            hint.char_indices()
                .skip(3)
                .any(|(end, _)| line.ends_with(&hint[..end]))
        })
}

fn view_of(line: &str) -> View {
    if ends_with_hint(line, "Enter to view tasks") {
        View::Selected
    } else if ends_with_hint(line, "↓ to manage") && !line.contains("esc to interrupt") {
        View::Tasks
    } else {
        View::Other
    }
}

/// The footer line that decides the view, which also carries the running-task count.
fn footer(screen: &str) -> &str {
    let lines = below_rule(screen);
    lines
        .iter()
        .copied()
        .find(|line| view_of(line) != View::Other)
        .or(lines.first().copied())
        .unwrap_or_default()
}

fn view(screen: &str) -> View {
    // A narrow pane can wrap the dialog's hints over two lines.
    if below_rule(screen).join(" ").contains("x to stop") {
        View::Dialog
    } else {
        view_of(footer(screen))
    }
}

/// The dialog's own lines, which change when a task leaves the list.
fn dialog(screen: &str) -> Vec<&str> {
    let lines = screen.lines().map(str::trim).collect::<Vec<_>>();
    let start = lines
        .iter()
        .rposition(|line| *line == "Background")
        .unwrap_or(0);
    lines[start..].to_vec()
}

async fn press(host: &Host, session: &str, pane: &str, key: &[&str]) -> Result<(), Error> {
    let args = [&["write", "-p", pane][..], key].concat();
    control::run_local(host, session, &args, Duration::from_secs(5))
        .await
        .map(|_| ())
        .map_err(|_| (StatusCode::BAD_GATEWAY, FAILED))
}

async fn read(host: &Host, session: &str, pane: &str) -> Option<String> {
    control::run_local(host, session, &["dump-screen", "-p", pane], READ_ATTEMPT)
        .await
        .ok()
}

/// Rereads the pane until `done` holds.
async fn wait(
    host: &Host,
    session: &str,
    pane: &str,
    done: impl Fn(&str) -> bool,
) -> Option<String> {
    let deadline = tokio::time::Instant::now() + SCREEN_WAIT;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(screen) = read(host, session, pane).await {
            if done(&screen) {
                return Some(screen);
            }
        }
    }
    None
}

/// Opens the dialog, stops its selected task and returns to the prompt.
/// Returns the screen once the footer differs from `tasks`.
async fn stop_one(host: &Host, session: &str, pane: &str, tasks: &str) -> Result<String, Error> {
    let failed = (StatusCode::BAD_GATEWAY, FAILED);
    press(host, session, pane, DOWN).await?;
    wait(host, session, pane, |screen| view(screen) == View::Selected)
        .await
        .ok_or(failed)?;
    press(host, session, pane, ENTER).await?;
    let open = wait(host, session, pane, |screen| view(screen) == View::Dialog)
        .await
        .ok_or(failed)?;
    press(host, session, pane, STOP).await?;
    let before = dialog(&open);
    wait(host, session, pane, |screen| {
        view(screen) != View::Dialog || dialog(screen) != before
    })
    .await;
    // The detail view closes itself; the list stays open, and also drops a quick second x.
    if read(host, session, pane)
        .await
        .is_some_and(|screen| view(&screen) == View::Dialog)
    {
        press(host, session, pane, ESCAPE).await?;
    }
    wait(host, session, pane, |screen| {
        view(screen) != View::Dialog && footer(screen) != tasks
    })
    .await
    .ok_or(failed)
}

pub(in crate::switchboard_relay) async fn handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<Target>,
) -> Result<Response, Error> {
    control::validate_session(&target.session)?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let body = serde_json::to_vec(&target).unwrap();
        return prompt::forward(&host, "/switchboard/conversation/stop-background", body).await;
    }
    local(&host, target, Some(&state.poll))
        .await
        .map(IntoResponse::into_response)
}

pub(in crate::switchboard_relay) async fn local(
    host: &Host,
    target: Target,
    poll: Option<&Arc<Mutex<attention::PollState>>>,
) -> Result<Json<Value>, Error> {
    let _guard = acting_on(&target.session, target.pane_id).await;
    let (pane, screen) = checked_screen(host, &target, tokio::time::Instant::now()).await?;
    let none = (StatusCode::CONFLICT, "No background task is running.");
    if attention::classify(&pane, &screen)["agent"] != "claude" || view(&screen) != View::Tasks {
        return Err(none);
    }
    stop_all(host, &target.session, &target.pane_id.to_string(), screen).await?;
    if let Some(poll) = poll {
        poll.lock()
            .await
            .end_shell_wait(&target.session, target.pane_id.into());
    }
    Ok(Json(json!({"ok":true})))
}

async fn stop_all(host: &Host, session: &str, pane: &str, mut screen: String) -> Result<(), Error> {
    for _ in 0..MAX_TASKS {
        match stop_one(host, session, pane, footer(&screen)).await {
            Ok(next) if view(&next) != View::Tasks => return Ok(()),
            Ok(next) => screen = next,
            Err(error) => {
                // Hand the terminal back as it was found.
                if read(host, session, pane)
                    .await
                    .is_some_and(|screen| view(&screen) == View::Dialog)
                {
                    let _ = press(host, session, pane, ESCAPE).await;
                }
                return Err(error);
            },
        }
    }
    Err((StatusCode::BAD_GATEWAY, FAILED))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from Claude Code 2.1.319 on Windows.
    const IDLE: &str = "● STARTED\n\n✻ Baked for 9s · done 16:56 · 2 shells still running\n\n────\n❯ \n────\n  ⏵⏵ bypass permissions on · 2 shells · ↓ to manage\n\n";
    const SELECTED: &str =
        "❯ \n────\n  ⏵⏵ bypass permissions on · 2 shells · Enter to view tasks\n";
    const LIST: &str = "● STARTED\n\n  Background\n  2 active shells\n\n  ❯ ● sleep 400   running\n    ● sleep 400   running\n\n  ↑/↓ to select · Enter to view · x to stop · Esc to close\n";
    const ONE_LEFT: &str = "● STARTED\n\n  Background\n  1 active shell\n\n  ❯ ● sleep 400   running\n\n  ↑/↓ to select · Enter to view · x to stop · Esc to close\n";
    const DETAIL: &str = "  Runtime:  2m 38s\n  Command:  sleep 400\n  Output:\n  No output available\n\n  ← to go back · Esc/Enter/Space to close · x to stop\n";
    const CLEAR: &str = "✻ Baked for 9s · done 16:56\n\n────\n❯ \n────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";

    #[test]
    fn switchboard_background_stop_recognizes_each_claude_screen() {
        assert_eq!(view(IDLE), View::Tasks);
        assert_eq!(view(SELECTED), View::Selected);
        assert_eq!(view(LIST), View::Dialog);
        assert_eq!(view(DETAIL), View::Dialog);
        assert_eq!(view(CLEAR), View::Other);
        // A usage notice can follow the footer, and a narrow pane cuts the hint short.
        let notice = "❯ 
────
  ⏵⏵ bypass permissions on · 3 shells · ↓ to ma…
  You've used 79% of your weekly limit · resets…
";
        assert_eq!(view(notice), View::Tasks);
        assert_eq!(
            footer(notice),
            "⏵⏵ bypass permissions on · 3 shells · ↓ to ma…"
        );
        // A rule that fills a narrow pane shares a line with the text after it.
        let joined = "done · 3 shells still running────────❯
────────
  ⏵⏵ on · 3 shells · ↓ to ma…
";
        assert_eq!(view(joined), View::Tasks);
        assert_eq!(
            view(
                "  Output:
  ← to go back · Esc/Enter/Space to close · x to
  stop
"
            ),
            View::Dialog
        );
        // A transcript hint above the input box is not the footer.
        let hint = "⎿  Running in the background (↓ to manage)
────
❯ 
────
  ⏵⏵ bypass permissions on
";
        assert_eq!(view(hint), View::Other);
        // A running turn also counts its tasks, and Esc belongs to that turn.
        let working = "  ⏵⏵ auto mode on · 2 shells · esc to interrupt · ← 1 agent · ↓ to manage\n";
        assert_eq!(view(working), View::Other);
    }

    #[test]
    fn switchboard_background_stop_sees_a_task_leave_the_list() {
        assert_ne!(dialog(LIST), dialog(ONE_LEFT));
        assert_eq!(dialog(ONE_LEFT)[0], "Background");
    }
}
