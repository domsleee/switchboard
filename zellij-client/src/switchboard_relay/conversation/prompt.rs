//! Claude's numbered menus (permission prompts and AskUserQuestion), read from the
//! pane so Conversation can show them and answer one without opening Terminal.
use super::*;
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

#[derive(Debug, PartialEq, Serialize)]
pub(super) struct Choice {
    label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    description: String,
    /// The digit Claude answers to; `None` for an unnumbered row such as Submit.
    number: Option<u32>,
    /// A multi-select checkbox, `None` for a plain option.
    checked: Option<bool>,
    /// "Type something.": answered with text.
    text: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub(super) struct Menu {
    detail: Vec<String>,
    question: String,
    choices: Vec<Choice>,
    #[serde(skip)]
    cursor: usize,
    /// Identifies what the browser showed, so an answer never lands on a changed menu.
    token: String,
}

#[derive(Debug)]
enum Row<'a> {
    Blank,
    /// `─` separates sections; dashed `╌` frames a command inside one.
    Rule {
        solid: bool,
    },
    Text(&'a str),
}

/// A full-width rule runs into the next row in `dump-screen`, so rules split rows.
fn rows(screen: &str) -> Vec<Row<'_>> {
    static RULE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new("[─━]{8,}|╌{8,}").unwrap());
    let mut rows = Vec::new();
    for line in screen.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            rows.push(Row::Blank);
            continue;
        }
        let mut last = 0;
        for rule in RULE.find_iter(line) {
            let before = &line[last..rule.start()];
            if !before.trim().is_empty() {
                rows.push(Row::Text(before));
            }
            rows.push(Row::Rule {
                solid: !rule.as_str().starts_with('╌'),
            });
            last = rule.end();
        }
        if !line[last..].trim().is_empty() {
            rows.push(Row::Text(&line[last..]));
        }
    }
    rows
}

static OPTION: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\s*(❯)?\s*(\d{1,2})\.\s+(\S.*?)\s*$").unwrap());
static SUBMIT: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\s*(❯)?\s*Submit$").unwrap());
static CHECKBOX: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^\[([ ✔✓])\]\s+(.*)$").unwrap());
static FOOTER: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"[Ee]sc to cancel|[Ee]nter to (?:select|confirm)").unwrap()
});

/// The menu that ends the screen, starting at `rows[start]` (its option 1).
/// Anything after the menu other than rules, blank rows and Claude's key hints
/// means it is not the live prompt.
fn menu_from(rows: &[Row], start: usize) -> Option<Menu> {
    let (mut choices, mut cursor, mut label_column) = (Vec::<Choice>::new(), None, 0);
    let (mut after_rule, mut footer) = (false, false);
    for row in &rows[start..] {
        let text = match row {
            Row::Blank => continue,
            Row::Rule { .. } => {
                after_rule = true;
                continue;
            },
            Row::Text(text) => *text,
        };
        if footer {
            return None;
        }
        let numbered = choices.iter().filter(|c| c.number.is_some()).count() as u32;
        if let Some(option) = OPTION.captures(text) {
            if option[2].parse::<u32>().ok()? != numbered + 1 {
                return None;
            }
            let label = option.get(3).unwrap();
            label_column = text[..label.start()].chars().count();
            let (checked, label) = match CHECKBOX.captures(label.as_str()) {
                Some(checkbox) => (Some(&checkbox[1] != " "), checkbox[2].to_string()),
                None => (None, label.as_str().to_string()),
            };
            if option.get(1).is_some() {
                cursor = cursor.xor(Some(choices.len()));
                cursor?;
            }
            choices.push(Choice {
                text: checked.is_none() && label == "Type something.",
                label,
                description: String::new(),
                number: Some(numbered + 1),
                checked,
            });
            after_rule = false;
        } else if let Some(submit) = SUBMIT
            .captures(text)
            .filter(|_| choices.iter().any(|c| c.checked.is_some()))
        {
            if submit.get(1).is_some() {
                cursor = cursor.xor(Some(choices.len()));
                cursor?;
            }
            choices.push(Choice {
                label: "Submit".into(),
                description: String::new(),
                number: None,
                checked: None,
                text: false,
            });
            after_rule = false;
        } else if FOOTER.is_match(text) {
            footer = true;
        } else if !after_rule
            && label_column > 0
            && text.chars().take_while(|c| c.is_whitespace()).count() >= label_column
        {
            // A description, or a label wrapped in a narrow pane.
            let last = choices.last_mut()?;
            if !last.description.is_empty() {
                last.description.push(' ');
            }
            last.description.push_str(text.trim());
        } else {
            return None;
        }
    }
    if choices.len() < 2 {
        return None;
    }
    let cursor = cursor?;
    // The question sits directly above the options; what Claude shows above it
    // (the tool and its command, or answers to review) runs up to a solid rule.
    // The whole dialog must be on screen and shown, since the answer approves it.
    let (mut question, mut detail, mut whole) = (None, Vec::new(), false);
    for row in rows[..start].iter().rev() {
        match row {
            Row::Blank | Row::Rule { solid: false } => {},
            Row::Rule { solid: true } => {
                whole = true;
                break;
            },
            Row::Text(text) => {
                let text = text.trim();
                if question.is_none() {
                    question = Some(text.to_string());
                } else if !text.starts_with("Tip:") && !text.starts_with(['☐', '☒', '✔', '←'])
                {
                    detail.push(text.to_string());
                }
            },
        }
    }
    if !whole || detail.len() > DETAIL_ROWS || detail.iter().any(|row| row.len() > ROW_LIMIT) {
        return None;
    }
    detail.reverse();
    let question = question.filter(|q| !q.starts_with(['☐', '☒', '✔', '←']))?;
    let token = Sha256::digest(serde_json::to_vec(&json!([detail, question, choices])).unwrap())
        [..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Some(Menu {
        detail,
        question,
        choices,
        cursor,
        token,
    })
}

/// A taller dialog, or a wider row, is left to Terminal.
const DETAIL_ROWS: usize = 80;
const ROW_LIMIT: usize = 2000;

pub(super) fn claude_menu(screen: &str) -> Option<Menu> {
    let rows = rows(screen);
    if let Some(menu) = folder_trust(&rows) {
        return Some(menu);
    }
    (0..rows.len()).rev().find_map(|start| match rows[start] {
        Row::Text(text) if OPTION.captures(text).is_some_and(|o| &o[2] == "1") => {
            menu_from(&rows, start)
        },
        _ => None,
    })
}

/// Startup has no transcript yet and uses an unnumbered menu. Keep the complete
/// workspace and warning visible, and use arrows only after an explicit answer.
fn folder_trust(rows: &[Row]) -> Option<Menu> {
    let start = rows
        .iter()
        .rposition(|row| matches!(row, Row::Rule { solid: true }))?;
    let text: Vec<_> = rows[start + 1..]
        .iter()
        .filter_map(|row| match row {
            Row::Blank => None,
            Row::Text(text) => Some(text.trim()),
            Row::Rule { .. } => Some(""),
        })
        .collect();
    let end = text.len().checked_sub(3)?;
    if text.first().copied() != Some("Accessing workspace:")
        || end < 4
        || !text[2..end]
            .iter()
            .any(|line| line.starts_with("Quick safety check:"))
        || text[end + 2] != "Enter to confirm · Esc to cancel"
    {
        return None;
    }
    let labels = ["No, exit", "Yes, I trust this folder"];
    let mut cursor = None;
    let mut choices = Vec::new();
    for (index, label) in labels.iter().enumerate() {
        let line = text[end + index];
        if let Some(selected) = line.strip_prefix('❯') {
            if selected.trim() != *label || cursor.is_some() {
                return None;
            }
            cursor = Some(index);
        } else if line != *label {
            return None;
        }
        choices.push(Choice {
            label: (*label).into(),
            description: String::new(),
            number: None,
            checked: None,
            text: false,
        });
    }
    let detail: Vec<String> = text[..end].iter().map(|line| (*line).into()).collect();
    if detail.len() > DETAIL_ROWS
        || detail
            .iter()
            .any(|line| line.is_empty() || line.len() > ROW_LIMIT)
    {
        return None;
    }
    let question = "Do you trust this folder?".to_string();
    // Without whitespace, so that a resize rewrapping the text is still the same dialog.
    let words: String = detail.concat().split_whitespace().collect();
    let token = Sha256::digest(serde_json::to_vec(&json!([words, question, choices])).unwrap())
        [..12]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Some(Menu {
        detail,
        question,
        choices,
        cursor: cursor?,
        token,
    })
}

pub(super) fn folder_trust_token(screen: &str) -> Option<String> {
    folder_trust(&rows(screen)).map(|menu| menu.token)
}

pub(super) fn folder_trust_keys(screen: &str) -> Option<Vec<String>> {
    let menu = folder_trust(&rows(screen))?;
    match keys(&menu, 1, None)?.pop()? {
        Key::Bytes(bytes) => Some(bytes),
        Key::Paste(_) => None,
    }
}

#[derive(Debug, PartialEq)]
enum Key {
    Bytes(Vec<String>),
    Paste(String),
}

/// What to type for one answer: an option's digit (plus text after "Type
/// something."), or arrows to an unnumbered row and Enter.
fn keys(menu: &Menu, choice: usize, text: Option<&str>) -> Option<Vec<Key>> {
    let selected = menu.choices.get(choice)?;
    let digit = |n: u32| (n <= 9).then(|| Key::Bytes(vec![(48 + n).to_string()]));
    match (text, selected.number) {
        (Some(text), Some(n)) if selected.text => Some(vec![
            digit(n)?,
            Key::Paste(text.into()),
            Key::Bytes(vec!["13".into()]),
        ]),
        (Some(_), _) => None,
        _ if selected.text => None,
        (None, Some(n)) if n <= 9 => Some(vec![digit(n)?]),
        (None, _) => {
            let arrow: &[&str] = if choice > menu.cursor {
                &["27", "91", "66"]
            } else {
                &["27", "91", "65"]
            };
            let mut bytes = Vec::new();
            for _ in 0..choice.abs_diff(menu.cursor) {
                bytes.extend(arrow.iter().map(|b| b.to_string()));
            }
            bytes.push("13".into());
            Some(vec![Key::Bytes(bytes)])
        },
    }
}

async fn forward(host: &Host, path: &str, body: Vec<u8>) -> Result<Response, Error> {
    let response = host
        .request(Method::POST, path, body.into(), "application/json")
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot reach the other computer"))?;
    Ok((
        response.status,
        [(header::CONTENT_TYPE, "application/json")],
        response.body,
    )
        .into_response())
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
        return forward(&host, "/switchboard/conversation/prompt", body).await;
    }
    local(&host, target).await.map(IntoResponse::into_response)
}

pub(in crate::switchboard_relay) async fn local(
    host: &Host,
    target: Target,
) -> Result<Json<Value>, Error> {
    let (pane, screen) = checked_screen(host, &target, tokio::time::Instant::now()).await?;
    let menu = (attention::classify(&pane, &screen)["agent"] == "claude")
        .then(|| claude_menu(&screen))
        .flatten();
    Ok(Json(json!({ "prompt": menu })))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::switchboard_relay) struct Answer {
    session: String,
    pane_id: u32,
    tab_id: u32,
    token: String,
    choice: usize,
    #[serde(default)]
    text: Option<String>,
}

pub(in crate::switchboard_relay) async fn answer_handler(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(answer): Json<Answer>,
) -> Result<Response, Error> {
    control::validate_session(&answer.session)?;
    let host = state
        .host(&id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown computer"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let body = serde_json::to_vec(&answer).unwrap();
        return forward(&host, "/switchboard/conversation/answer", body).await;
    }
    answer_local(&host, answer)
        .await
        .map(IntoResponse::into_response)
}

pub(in crate::switchboard_relay) const ANSWER_LIMIT: usize = 4000;

pub(in crate::switchboard_relay) async fn answer_local(
    host: &Host,
    answer: Answer,
) -> Result<Json<Value>, Error> {
    // A typed answer is one line: Enter submits it.
    if answer.text.as_ref().is_some_and(|text| {
        text.trim().is_empty() || text.len() > ANSWER_LIMIT || text.chars().any(char::is_control)
    }) {
        return Err((StatusCode::BAD_REQUEST, "Invalid answer"));
    }
    let _guard = acting_on(&answer.session, answer.pane_id).await;
    let target = Target {
        session: answer.session.clone(),
        pane_id: answer.pane_id,
        tab_id: answer.tab_id,
    };
    let (pane, screen) = checked_screen(host, &target, tokio::time::Instant::now()).await?;
    let changed = (
        StatusCode::CONFLICT,
        "The question changed. Check it and choose again.",
    );
    if attention::classify(&pane, &screen)["agent"] != "claude" {
        return Err(changed);
    }
    let menu = claude_menu(&screen)
        .filter(|menu| menu.token == answer.token)
        .ok_or(changed)?;
    let keys = keys(&menu, answer.choice, answer.text.as_deref())
        .ok_or((StatusCode::BAD_REQUEST, "Invalid answer"))?;
    if folder_trust_token(&screen).is_some_and(|token| {
        !claim_trust_answer(
            &answer.session,
            answer.pane_id,
            &token,
            Some(TRUST_MANUAL_WAIT),
        )
    }) {
        return Err(changed);
    }
    let id = answer.pane_id.to_string();
    for key in keys {
        let mut args = vec!["write".to_string(), "-p".into(), id.clone()];
        match key {
            Key::Bytes(bytes) => args.extend(bytes),
            // `--` keeps an answer that starts with `-` from reading as an option.
            Key::Paste(text) => {
                args = vec!["paste".into(), "-p".into(), id.clone(), "--".into(), text]
            },
        }
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        control::run_local(host, &answer.session, &args, Duration::from_secs(5))
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot answer in the terminal"))?;
    }
    Ok(Json(json!({"ok":true})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switchboard_conversation_folder_trust_shows_workspace_and_answers_with_arrows() {
        let screen = include_str!("../fixtures/claude-folder-trust.txt");
        let menu = claude_menu(screen).unwrap();
        assert_eq!(
            folder_trust_keys(screen),
            Some(["27", "91", "66", "13"].map(String::from).into())
        );
        assert_eq!(labels(&menu), ["No, exit", "Yes, I trust this folder"]);
        assert!(menu
            .detail
            .iter()
            .any(|line| line == r"C:\git\GitHub\acme\sample-project"));
        assert!(menu
            .detail
            .iter()
            .any(|line| line.contains("read, edit, and execute")));
        assert_eq!(
            keys(&menu, 1, None),
            Some(vec![Key::Bytes(
                ["27", "91", "66", "13"].map(String::from).into()
            )])
        );
        assert_eq!(
            keys(&menu, 0, None),
            Some(vec![Key::Bytes(vec!["13".into()])])
        );
        let moved = screen
            .replace("❯ No, exit", "No, exit")
            .replace("   Yes, I trust", " ❯ Yes, I trust");
        let moved = claude_menu(&moved).unwrap();
        assert_eq!(moved.token, menu.token);
        assert_eq!(
            keys(&moved, 0, None),
            Some(vec![Key::Bytes(
                ["27", "91", "65", "13"].map(String::from).into()
            )])
        );
        assert_ne!(
            claude_menu(&screen.replace("sample-project", "OtherProject"))
                .unwrap()
                .token,
            menu.token
        );
        assert_eq!(
            folder_trust_token(&screen.replace("check: Is this", "check:\n Is this")),
            Some(menu.token.clone()),
            "rewrapping after a resize is the same dialog"
        );
        for invalid in [
            format!("{screen}\n❯ \n  bypass permissions on (shift+tab to cycle)"),
            screen.replace("❯ No, exit", "No, exit"),
            screen.replace("   Yes, I trust", " ❯ Yes, I trust"),
            screen.replace("Enter to confirm · Esc to cancel", ""),
            screen.replace("Accessing workspace:", ""),
        ] {
            assert_eq!(claude_menu(&invalid), None);
            assert_eq!(folder_trust_keys(&invalid), None);
        }
        assert_eq!(folder_trust_keys(&permission()), None);
        assert_eq!(folder_trust_keys(&question()), None);
    }

    const RULE: &str = "─────────────────────────────────────────────────────────────";
    const DASH: &str = "╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌";

    // Claude Code 2.1.319 screens captured with dump-screen. A full-width rule runs
    // into the next row, as in the captures.
    fn permission() -> String {
        format!(
            "❯ Run this exact Bash command: echo hello > out.txt\n\n● Bash(echo hello > out.txt)\n  ⎿  Waiting…\n\n{RULE} Bash command\n\n Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below\n\n Write hello to out.txt in the working directory\n\n{DASH} echo hello > out.txt\n{DASH}\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow access to C:\\Users\\user\\caps from this project\n   3. Yes, and switch to auto mode · auto mode handles these prompts for you\n   4. No\n\n Esc to cancel · Tab to amend\n\n\n"
        )
    }
    fn question() -> String {
        format!(
            "❯ Ask me which colour.\n{RULE} ☐ Colour\n\nWhich colour?\n\n❯ 1. Red\n     Warm\n  2. Blue\n     Cool\n  3. Type something.\n{RULE}\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel\n"
        )
    }
    fn toppings() -> String {
        format!(
            "{RULE}←  ☒ Size  ☐ Toppings  ✔ Submit  →\n\nWhich toppings?\n\n❯ 1. [✔] Cheese\n         Cheese topping\n  2. [ ] Ham\n         Ham topping\n  3. [✔] Olives\n         Olives topping\n  4. [ ] Type something\n     Submit\n{RULE}\n  5. Chat about this\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n"
        )
    }
    fn review() -> String {
        format!(
            "✻ Baked for 5s · done 12:06❯ Use AskUserQuestion once.\n{RULE}←  ☒ Size  ☒ Toppings  ✔ Submit  →\n\nReview your answers\n\n ● Which size?\n   → Large\n ● Which toppings?\n   → Cheese, Olives\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n\n\n\n"
        )
    }
    fn labels(menu: &Menu) -> Vec<&str> {
        menu.choices.iter().map(|c| c.label.as_str()).collect()
    }

    #[test]
    fn switchboard_conversation_reads_a_claude_permission_prompt() {
        let menu = claude_menu(&permission()).unwrap();
        assert_eq!(menu.question, "Do you want to proceed?");
        assert_eq!(
            menu.detail,
            [
                "Bash command",
                "Write hello to out.txt in the working directory",
                "echo hello > out.txt"
            ]
        );
        assert_eq!(labels(&menu)[0], "Yes");
        assert_eq!(labels(&menu)[3], "No");
        assert_eq!(menu.cursor, 0);
        assert_eq!(
            keys(&menu, 3, None),
            Some(vec![Key::Bytes(vec!["52".into()])])
        );

        // A long command is shown whole, and every line of it is part of the token.
        let script = |first: &str| {
            let lines = (0..40)
                .map(|i| format!("echo {i}"))
                .collect::<Vec<_>>()
                .join("\n");
            permission().replace("echo hello > out.txt\n", &format!("{first}\n{lines}\n"))
        };
        let long = claude_menu(&script("rm -rf build")).unwrap();
        assert_eq!(long.detail.len(), 43);
        assert_eq!(long.detail[2], "rm -rf build");
        assert_ne!(
            long.token,
            claude_menu(&script("rm -rf src")).unwrap().token
        );
        // A dialog taller than the limit, or cut off above, is left to Terminal.
        let lines = (0..DETAIL_ROWS)
            .map(|i| format!("echo {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(claude_menu(&script(&lines)), None);
        let cut = permission();
        assert_eq!(claude_menu(&cut[cut.find("Write hello").unwrap()..]), None);
    }

    #[test]
    fn switchboard_conversation_reads_claude_questions() {
        let menu = claude_menu(&question()).unwrap();
        assert_eq!(
            (menu.question.as_str(), menu.detail.len()),
            ("Which colour?", 0)
        );
        assert_eq!(
            labels(&menu),
            ["Red", "Blue", "Type something.", "Chat about this"]
        );
        assert_eq!(menu.choices[1].description, "Cool");
        assert!(menu.choices[2].text && !menu.choices[1].text);
        assert_eq!(
            keys(&menu, 1, None),
            Some(vec![Key::Bytes(vec!["50".into()])])
        );
        // Claude Code takes "Type something." as its digit, the text, then Enter.
        assert_eq!(
            keys(&menu, 2, Some("A goldfish")),
            Some(vec![
                Key::Bytes(vec!["51".into()]),
                Key::Paste("A goldfish".into()),
                Key::Bytes(vec!["13".into()])
            ])
        );
        assert_eq!(keys(&menu, 2, None), None);
        assert_eq!(keys(&menu, 1, Some("text")), None);
        assert_eq!(keys(&menu, 9, None), None);

        let menu = claude_menu(&toppings()).unwrap();
        assert_eq!(menu.question, "Which toppings?");
        assert_eq!(
            labels(&menu),
            [
                "Cheese",
                "Ham",
                "Olives",
                "Type something",
                "Submit",
                "Chat about this"
            ]
        );
        let checked: Vec<_> = menu.choices.iter().map(|c| c.checked).collect();
        assert_eq!(
            checked,
            [Some(true), Some(false), Some(true), Some(false), None, None]
        );
        assert_eq!(menu.choices[5].number, Some(5));
        // Digits toggle a checkbox without moving the cursor; Submit has no digit.
        assert_eq!(
            keys(&menu, 4, None),
            Some(vec![Key::Bytes(
                ["27", "91", "66"]
                    .repeat(4)
                    .into_iter()
                    .chain(["13"])
                    .map(String::from)
                    .collect()
            )])
        );
        let moved = toppings()
            .replace("❯ 1. [✔]", "  1. [✔]")
            .replace("     Submit", "❯    Submit");
        let menu = claude_menu(&moved).unwrap();
        assert_eq!(
            keys(&menu, 4, None),
            Some(vec![Key::Bytes(vec!["13".into()])])
        );

        let menu = claude_menu(&review()).unwrap();
        assert_eq!(menu.question, "Ready to submit your answers?");
        assert_eq!(
            menu.detail,
            [
                "Review your answers",
                "● Which size?",
                "→ Large",
                "● Which toppings?",
                "→ Cheese, Olives"
            ]
        );
        assert_eq!(labels(&menu), ["Submit answers", "Cancel"]);
    }

    #[test]
    fn switchboard_conversation_menu_token_follows_what_is_shown() {
        let menu = claude_menu(&toppings()).unwrap();
        let moved = toppings()
            .replace("❯ 1. [✔]", "  1. [✔]")
            .replace("  2. [ ]", "❯ 2. [ ]");
        assert_eq!(claude_menu(&moved).unwrap().token, menu.token);
        let toggled = toppings().replace("2. [ ] Ham", "2. [✔] Ham");
        assert_ne!(claude_menu(&toggled).unwrap().token, menu.token);
        let other = permission().replace("echo hello", "rm -rf build");
        assert_ne!(
            claude_menu(&other).unwrap().token,
            claude_menu(&permission()).unwrap().token
        );
    }

    #[test]
    fn switchboard_conversation_ignores_menus_that_are_not_live() {
        let idle =
            format!("{RULE}\n❯\u{a0}\n{RULE}\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n");
        for screen in [
            // An answered prompt still in the scrollback, above the idle prompt.
            format!("{}{idle}", permission()),
            // A numbered list typed as a message.
            format!("❯ 1. first\n  2. second\n{idle}"),
            // No selected option, or two.
            permission().replace(" ❯ 1. Yes", "   1. Yes"),
            permission().replace("   2. Yes,", " ❯ 2. Yes,"),
            // Numbers out of order, or a single option.
            permission().replace("3. Yes", "5. Yes"),
            "Proceed?\n❯ 1. Yes\n\nEsc to cancel\n".into(),
            // Text after the key hints.
            format!("{}PS C:\\repo>", question()),
            // Claude's folder trust dialog has no numbers to answer with.
            " Is this a project you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n".into(),
        ] {
            assert_eq!(claude_menu(&screen), None, "{screen}");
        }
    }
}
