//! Read-only, bounded history access. Never launches an agent or resumes a session.
use super::*;
use axum::extract::Query;
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, ErrorKind, Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{LazyLock, Mutex as SyncMutex},
};

const AGENTS: &[&str] = &["claude", "codex", "muse", "copilot", "opencode"];
const FILE_BYTES: u64 = 64 * 1024 * 1024;
const SCAN_BYTES: u64 = 128 * 1024 * 1024;
const LINE_BYTES: u64 = 8 * 1024 * 1024;
const PAGE_FILES: usize = 100;

// Only selected transcripts are indexed. Offsets keep memory independent of tool output
// and message size; subsequent reads scan just the bytes appended by the agent.
#[derive(Clone)]
struct MessageOffset {
    start: u64,
    bytes: usize,
    item: usize,
    model: Option<String>,
    reasoning_effort: Option<String>,
    assistant: bool,
    commentary: bool,
    tool: bool,
}
struct HistoryIndex {
    path: PathBuf,
    chat: Chat,
    messages: Vec<MessageOffset>,
    offset: u64,
    observed: Option<(u64, std::time::SystemTime)>,
    provisional: usize,
    provisional_state: Option<Chat>,
    page_cache: Option<(usize, usize, bool, Option<usize>, bool, Value)>,
    /// Claude's API usage, including its subagents' transcripts and how far each was read.
    usage: super::chat_cost::Usage,
    subagents: HashMap<PathBuf, u64>,
    subagents_checked: Option<std::time::Instant>,
}
static HISTORY: LazyLock<SyncMutex<HashMap<String, Arc<SyncMutex<HistoryIndex>>>>> =
    LazyLock::new(Default::default);
static TRANSCRIPTS: LazyLock<SyncMutex<HashMap<String, (String, PathBuf, PathBuf)>>> =
    LazyLock::new(Default::default);

impl HistoryIndex {
    fn new(agent: &str, root: &Path, path: &Path) -> Self {
        Self {
            path: path.into(),
            chat: Chat {
                id: file_id(agent, root, path),
                agent: agent.into(),
                ..Chat::default()
            },
            messages: Vec::new(),
            offset: 0,
            observed: None,
            provisional: 0,
            provisional_state: None,
            page_cache: None,
            usage: Default::default(),
            subagents: HashMap::new(),
            subagents_checked: None,
        }
    }
    /// Claude Code keeps each subagent's transcript in `<session>/subagents/`. Their usage is
    /// part of the chat's cost, so read what they appended, at most every two seconds.
    fn update_subagents(&mut self) -> bool {
        if self.chat.agent != "claude"
            || self
                .subagents_checked
                .is_some_and(|checked| checked.elapsed() < Duration::from_secs(2))
        {
            return false;
        }
        self.subagents_checked = Some(std::time::Instant::now());
        let Ok(entries) = fs::read_dir(self.path.with_extension("").join("subagents")) else {
            return false;
        };
        let mut changed = false;
        for entry in entries.flatten().take(1000) {
            let path = entry.path();
            let length = entry.metadata().map_or(0, |metadata| metadata.len());
            let offset = self.subagents.get(&path).copied().unwrap_or(0);
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
                || length <= offset
            {
                continue;
            }
            let Ok(mut file) = fs::File::open(&path) else {
                continue;
            };
            if file.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut reader = BufReader::new(file);
            let mut read = offset;
            loop {
                let mut line = Vec::new();
                let Ok(bytes) = reader
                    .by_ref()
                    .take(LINE_BYTES + 1)
                    .read_until(b'\n', &mut line)
                else {
                    break;
                };
                // Stop before an unfinished write or an oversized record.
                if bytes == 0 || line.last() != Some(&b'\n') {
                    break;
                }
                read += bytes as u64;
                if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                    self.usage.record(&value);
                    changed = true;
                }
            }
            self.subagents.insert(path, read);
        }
        changed
    }
    fn update(&mut self) -> std::io::Result<()> {
        let mut file = match fs::File::open(&self.path) {
            // Claude writes a new session's transcript with its first message.
            Err(error) if error.kind() == ErrorKind::NotFound && self.observed.is_none() => {
                return Ok(())
            },
            file => file?,
        };
        let metadata = file.metadata()?;
        let stamp = (metadata.len(), metadata.modified()?);
        if self.observed == Some(stamp) {
            return Ok(());
        }
        if self
            .observed
            .is_some_and(|old| stamp.0 < old.0 || (stamp.0 == old.0 && stamp.1 != old.1))
        {
            self.offset = 0;
            self.messages.clear();
            self.provisional = 0;
            self.provisional_state = None;
            self.usage.clear();
            self.subagents.clear();
            self.subagents_checked = None;
            self.chat = Chat {
                id: self.chat.id.clone(),
                agent: self.chat.agent.clone(),
                ..Chat::default()
            };
        }
        self.messages
            .truncate(self.messages.len().saturating_sub(self.provisional));
        self.provisional = 0;
        if let Some(chat) = self.provisional_state.take() {
            self.chat = chat;
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file);
        loop {
            let start = self.offset;
            let mut line = Vec::new();
            let bytes = reader
                .by_ref()
                .take(LINE_BYTES + 1)
                .read_until(b'\n', &mut line)?;
            if bytes == 0 {
                break;
            }
            if bytes as u64 > LINE_BYTES {
                self.chat.incomplete("record_limit");
                while line.last() != Some(&b'\n') {
                    let buffer = reader.fill_buf()?;
                    if buffer.is_empty() {
                        break;
                    }
                    let newline = buffer.iter().position(|b| *b == b'\n');
                    let count = newline.map_or(buffer.len(), |n| n + 1);
                    reader.consume(count);
                    if newline.is_some() {
                        break;
                    }
                }
                self.offset = reader.stream_position()?;
                continue;
            }
            let complete = line.last() == Some(&b'\n');
            if !complete {
                self.provisional_state = Some(self.chat.clone());
            }
            match serde_json::from_slice::<Value>(&line) {
                Ok(value) => {
                    if self.chat.agent == "claude" {
                        self.usage.record(&value);
                    }
                    // Parse each record independently too, so offsets remain correct for
                    // providers whose envelopes contain several or deduplicated messages.
                    let mut record = Chat {
                        agent: self.chat.agent.clone(),
                        project: self.chat.project.clone(),
                        model: self.chat.model.clone(),
                        reasoning_effort: self.chat.reasoning_effort.clone(),
                        ..Chat::default()
                    };
                    record.record(&value, 0);
                    self.chat.embedded_bytes = 0;
                    self.chat.record(&value, 0);
                    // Messages are drained per record, so mark the indexed one instead.
                    if self.chat.used_tool && self.chat.messages.iter().all(is_tool) {
                        let last = self.messages.iter_mut().rev().find(|m| !m.tool);
                        if let Some(last) = last.filter(|m| m.assistant) {
                            last.commentary = true;
                        }
                    }
                    for message in self.chat.messages.drain(..) {
                        if let Some(item) = record
                            .messages
                            .iter()
                            .position(|candidate| *candidate == message)
                        {
                            self.messages.push(MessageOffset {
                                start,
                                bytes,
                                item,
                                model: self.chat.model.clone(),
                                reasoning_effort: self.chat.reasoning_effort.clone(),
                                assistant: message["role"] == "assistant",
                                commentary: false,
                                tool: is_tool(&message),
                            });
                            if !complete {
                                self.provisional += 1;
                            }
                        }
                    }
                },
                Err(_) if complete => self.chat.incomplete("malformed_record"),
                Err(_) => (), // Retry an unfinished live write from the same offset.
            }
            if !complete {
                break;
            }
            self.offset = start + bytes as u64;
        }
        self.observed = Some(stamp);
        Ok(())
    }
    fn page(&mut self, p: &Params) -> std::io::Result<Value> {
        let previous = self.observed;
        self.update()?;
        if self.update_subagents() {
            self.page_cache = None;
        }
        if previous == self.observed {
            if let Some((cursor, limit, tail, before, context, page)) = &self.page_cache {
                if (*cursor, *limit, *tail, *before, *context)
                    == (p.cursor, p.limit(), p.tail, p.before, p.context)
                {
                    return Ok(page.clone());
                }
            }
        }
        let end = p
            .before
            .unwrap_or(self.messages.len())
            .min(self.messages.len());
        let start = if p.tail || p.before.is_some() {
            end.saturating_sub(p.limit())
        } else {
            p.cursor.min(end)
        };
        let mut chat = Chat {
            id: self.chat.id.clone(),
            agent: self.chat.agent.clone(),
            title: self.chat.title.clone(),
            session_id: self.chat.session_id.clone(),
            project: self.chat.project.clone(),
            model: self.chat.model.clone(),
            reasoning_effort: self.chat.reasoning_effort.clone(),
            partial: self.chat.partial,
            partial_reasons: self.chat.partial_reasons.clone(),
            background: self.chat.background.clone(),
            ..Chat::default()
        };
        let mut opened = None;
        for entry in self.messages[start..end].iter().take(p.limit()) {
            let file = match &mut opened {
                Some(file) => file,
                None => opened.insert(fs::File::open(&self.path)?),
            };
            file.seek(SeekFrom::Start(entry.start))?;
            let mut bytes = vec![0; entry.bytes];
            file.read_exact(&mut bytes)?;
            let value: Value = serde_json::from_slice(&bytes)?;
            let mut record = Chat {
                agent: chat.agent.clone(),
                project: chat.project.clone(),
                model: entry.model.clone(),
                reasoning_effort: entry.reasoning_effort.clone(),
                ..Chat::default()
            };
            record.record(&value, 0);
            if let Some(message) = record.messages.get(entry.item) {
                let mut message = message.clone();
                if entry.commentary {
                    message["phase"] = json!("commentary");
                }
                for attachment in message["attachments"].as_array_mut().into_iter().flatten() {
                    if let Some(url) = attachment["url"]
                        .as_str()
                        .filter(|url| url.starts_with("data:"))
                    {
                        chat.embedded_bytes += url.len();
                        if chat.embedded_bytes > 2 * 1024 * 1024 {
                            attachment.as_object_mut().unwrap().remove("url");
                            attachment["unavailable"] =
                                json!("Embedded attachment exceeds preview limits");
                        }
                    }
                }
                chat.messages.push(message);
            }
        }
        let mut page = read_page(
            &chat,
            &Params {
                limit: p.limit,
                context: p.context,
                ..Params::default()
            },
        );
        let next = start + chat.messages.len();
        page["start_cursor"] = json!(start);
        page["message_count"] = json!(self.messages.len());
        if self.chat.agent == "claude" {
            page["usage"] = self.usage.summary();
        }
        page["previous_cursor"] = if start > 0 { json!(start) } else { Value::Null };
        page["next_cursor"] = if next < end { json!(next) } else { Value::Null };
        self.page_cache = Some((
            p.cursor,
            p.limit(),
            p.tail,
            p.before,
            p.context,
            page.clone(),
        ));
        Ok(page)
    }
}

fn indexed_page(agent: &str, root: &Path, path: &Path, p: &Params) -> Value {
    let id = file_id(agent, root, path);
    let index = {
        let mut cache = HISTORY.lock().unwrap();
        if cache.len() >= 16 && !cache.contains_key(&id) {
            // Active readers keep their Arc; only idle indexes are evicted.
            cache.retain(|_, index| Arc::strong_count(index) > 1);
        }
        cache
            .entry(id)
            .or_insert_with(|| Arc::new(SyncMutex::new(HistoryIndex::new(agent, root, path))))
            .clone()
    };
    let result = index
        .lock()
        .unwrap()
        .page(p)
        .unwrap_or_else(|_| json!({"error":"unreadable"}));
    result
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Params {
    #[serde(default)]
    q: String,
    agent: Option<String>,
    host: Option<String>,
    #[serde(default)]
    cursor: usize,
    limit: Option<usize>,
    #[serde(default)]
    tail: bool,
    before: Option<usize>,
    project: Option<String>,
    #[serde(default)]
    context: bool,
}
impl Params {
    fn valid(&self) -> bool {
        self.q.len() <= 512
            && self.project.as_ref().is_none_or(|p| p.len() <= 4096)
            && self
                .agent
                .as_ref()
                .is_none_or(|a| AGENTS.contains(&a.as_str()))
            && self.before.is_none_or(|n| n <= 10_000_000)
            && self.cursor <= 10_000_000
            && self.limit.is_none_or(|n| (1..=50).contains(&n))
    }
    fn limit(&self) -> usize {
        self.limit.unwrap_or(10)
    }
}
#[derive(Default, Clone)]
struct Chat {
    id: String,
    session_id: String,
    agent: String,
    title: String,
    project: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    messages: Vec<Value>,
    partial: bool,
    partial_reasons: Vec<&'static str>,
    muse_deliveries: std::collections::HashSet<String>,
    embedded_bytes: usize,
    /// The last Claude record called a tool, so the text before it was a progress note.
    used_tool: bool,
    /// Claude background agents launched and not yet reported finished, oldest first.
    background: Vec<BackgroundAgent>,
}
#[derive(Clone)]
struct BackgroundAgent {
    tool_use_id: String,
    agent_id: String,
    description: String,
    model: Option<String>,
    started: Value,
}
/// The text of the first `<name>…</name>` element in `text`.
fn tag_text<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let (_, rest) = text.split_once(&format!("<{name}>"))?;
    Some(rest.split_once(&format!("</{name}>"))?.0.trim())
}
fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn content(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_owned();
    }
    v.as_array()
        .map(|a| {
            a.iter()
                .filter(|p| {
                    matches!(
                        p["type"].as_str(),
                        Some("text" | "input_text" | "output_text")
                    )
                })
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
/// Split text that is only `<name …>inner</name>` elements into (name, inner) pairs.
fn tags(text: &str) -> Option<Vec<(&str, &str)>> {
    let mut rest = text.trim();
    let mut found = Vec::new();
    while !rest.is_empty() {
        let open = rest.strip_prefix('<')?;
        let (head, after) = open.split_once('>')?;
        let name = head.split(' ').next().filter(|name| {
            !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })?;
        let (inner, after) = after.split_once(&format!("</{name}>"))?;
        found.push((name, inner.trim()));
        rest = after.trim_start();
    }
    (!found.is_empty()).then_some(found)
}
// Claude Code records slash commands, `!` commands, their output and interrupts
// as user records without a prompt source. Some(display) replaces the text;
// an empty display hides the record.
fn claude_command(text: &str) -> Option<String> {
    let text = text.trim();
    // Prefixes of Claude Code's interruption notices (`ERe` in its 2.1.319 bundle).
    if [
        "[Request interrupted",
        "[Agent call interrupted",
        "[Tool call ",
        "The user doesn't want to take this action right now.",
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
        && text.ends_with([']', '.'])
    {
        return Some(String::new());
    }
    let tags = tags(text)?;
    let only = |names: &[&str]| tags.iter().all(|(name, _)| names.contains(name));
    let get = |key| tags.iter().find(|(name, _)| *name == key).map(|(_, v)| *v);
    if only(&["command-name", "command-message", "command-args"]) {
        let name = get("command-name")?;
        return Some(
            format!("{name} {}", get("command-args").unwrap_or(""))
                .trim_end()
                .into(),
        );
    }
    if only(&["bash-input"]) {
        return Some(format!("!{}", get("bash-input")?));
    }
    only(&[
        "local-command-stdout",
        "local-command-stderr",
        "bash-stdout",
        "bash-stderr",
    ])
    .then(String::new)
}
// Codex records the user's answers to its questions as a user message holding JSON.
fn codex_question_reply(text: &str) -> Option<String> {
    let [("send_user_message_question_reply", inner)] = tags(text)?[..] else {
        return None;
    };
    let answers = serde_json::from_str::<Vec<Value>>(inner).ok()?;
    Some(
        answers
            .iter()
            .map(|a| {
                let answer = a["answer"].as_str().unwrap_or_default();
                match a["question"].as_str().filter(|q| !q.is_empty()) {
                    Some(question) => format!("> {question}\n\n{answer}"),
                    None => answer.into(),
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}
fn is_tool(message: &Value) -> bool {
    message["kind"] == "tool"
}
// Tool steps show what the agent ran, so blank values that look like credentials:
// assignments and flags named like secrets, auth headers, URL passwords and known
// token formats.
static SECRETS: LazyLock<Vec<(regex::Regex, &'static str)>> = LazyLock::new(|| {
    let name =
        r"[A-Za-z0-9_.-]*(?i-u:key|token|secret|passw(?:or)?d|credential|cookie)[A-Za-z0-9_.-]*";
    // Header and JSON field names also cover auth (authorization, auth_token…).
    let field = r"[A-Za-z0-9_.-]*(?i-u:key|token|secret|passw(?:or)?d|credential|cookie|auth)[A-Za-z0-9_.-]*";
    [
        (format!(r#"({name})(\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s&;|"']+)"#), "$1$2***"),
        (format!(r#"(^|\s)(--?{name})(\s+)(?:"[^"]*"|'[^']*'|[^\s\-"'][^\s"']*)"#), "$1$2$3***"),
        // Headers named like credentials, and quoted JSON fields, as in curl -H or --data.
        (format!(r#"\b({field})(\s*:\s*)[^"'\r\n]+"#), "$1$2***"),
        (format!(r#"(\\?"{field}\\?"\s*:\s*)(?:\\?"(?:[^"\\]|\\[^"])*\\?"|[^\s,}}"]+)"#), "$1\"***\""),
        (r"\b((?i-u:bearer|basic))(\s+)[A-Za-z0-9._~+/=-]{8,}".into(), "$1$2***"),
        (r"(://)[^/\s:@]+:[^/\s@]+@".into(), "$1***@"),
        (r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})".into(), "***"),
    ]
    .map(|(pattern, replacement)| (regex::Regex::new(&pattern).unwrap(), replacement))
    .into()
});
/// The first non-empty line, redacted and clipped, marking any text left out.
fn one_line(text: &str) -> String {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let mut line: String = lines
        .next()
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    for (pattern, replacement) in SECRETS.iter() {
        line = pattern.replace_all(&line, *replacement).into_owned();
    }
    if line.chars().count() > 120 {
        format!("{}…", clip(&line, 119))
    } else if lines.next().is_some() {
        format!("{line} …")
    } else {
        line
    }
}
/// A path relative to the project when inside it; a long path keeps its file name.
fn short_path(path: &str, project: &str) -> String {
    let root = project.trim_end_matches(['/', '\\']);
    let inside = path
        .get(..root.len())
        .filter(|head| {
            !root.is_empty()
                && head
                    .replace('\\', "/")
                    .eq_ignore_ascii_case(&root.replace('\\', "/"))
        })
        .and_then(|_| path[root.len()..].strip_prefix(['/', '\\']))
        .filter(|rest| !rest.is_empty());
    let line: String = inside
        .unwrap_or(path)
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    let count = line.chars().count();
    if count > 120 {
        format!("…{}", line.chars().skip(count - 119).collect::<String>())
    } else {
        line
    }
}
fn tool_name(name: &str) -> String {
    clip(
        &name
            .strip_prefix("mcp__")
            .unwrap_or(name)
            .replace("__", " "),
        80,
    )
}
fn command_line(command: &Value) -> String {
    match command {
        Value::String(command) => command.clone(),
        Value::Array(argv) => {
            let argv: Vec<&str> = argv.iter().filter_map(Value::as_str).collect();
            // The script given to a shell wrapper is the command the agent wrote.
            let flag = argv.iter().position(|arg| {
                matches!(
                    arg.to_ascii_lowercase().as_str(),
                    "-c" | "-lc" | "-command" | "/c"
                )
            });
            match flag {
                Some(flag) if flag + 2 == argv.len() => argv[flag + 1].into(),
                _ => argv.join(" "),
            }
        },
        _ => String::new(),
    }
}
/// The files a Codex patch touches, never its body.
fn patch_files(patch: &str, project: &str) -> (&'static str, String) {
    let (mut files, mut added) = (Vec::new(), true);
    for line in patch.lines() {
        for (prefix, add) in [
            ("*** Add File: ", true),
            ("*** Update File: ", false),
            ("*** Delete File: ", false),
        ] {
            if let Some(path) = line.strip_prefix(prefix) {
                files.push(short_path(path, project));
                added &= add;
            }
        }
    }
    let detail = match &files[..] {
        [] => String::new(),
        [first] => first.clone(),
        [first, rest @ ..] => format!("{first} (+{} more)", rest.len()),
    };
    (
        if added && !files.is_empty() {
            "write"
        } else {
            "edit"
        },
        detail,
    )
}
/// The code with the contents of strings, templates and comments blanked, keeping byte
/// offsets, so a patch body or other string is never read as a call.
fn code_only(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    let blank = |out: &mut String, c: char| out.extend(std::iter::repeat_n(' ', c.len_utf8()));
    let mut chars = code.chars().peekable();
    // A quote character, or '/' and '*' for line and block comments.
    let mut inside: Option<char> = None;
    while let Some(c) = chars.next() {
        match (inside, c) {
            (None, '"' | '\'' | '`') => {
                inside = Some(c);
                out.push(c);
            },
            (None, '/') if matches!(chars.peek(), Some('/' | '*')) => {
                inside = chars.next();
                out.push_str("  ");
            },
            (None, _) => out.push(c),
            (Some('/'), '\n') => {
                inside = None;
                out.push(c);
            },
            (Some('*'), '*') if chars.peek() == Some(&'/') => {
                chars.next();
                inside = None;
                out.push_str("  ");
            },
            (Some('/' | '*'), _) => blank(&mut out, c),
            (Some(_), '\\') => {
                blank(&mut out, c);
                if let Some(next) = chars.next() {
                    blank(&mut out, next);
                }
            },
            (Some(quote), _) if c == quote => {
                inside = None;
                out.push(c);
            },
            (Some(_), _) => blank(&mut out, c),
        }
    }
    out
}
// Codex code mode runs JavaScript that calls its tools, usually `exec_command`. Only a
// command given as the first argument field of an exec call counts as one.
static CODE_CALLS: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"\btools\.(\w+)\s*\(\s*(\{\s*(?:cmd|command)\s*:\s*")?"#).unwrap()
});
fn code_mode(code: &str) -> (&'static str, String) {
    let masked = code_only(code);
    let (mut names, mut commands) = (Vec::new(), Vec::<String>::new());
    for call in CODE_CALLS.captures_iter(&masked) {
        names.push(tool_name(&call[1]));
        if let (Some(argument), "exec_command" | "shell_command") = (call.get(2), &call[1]) {
            let open = argument.end() - 1;
            let literal = masked[open + 1..]
                .find('"')
                .map(|close| &code[open..open + close + 2]);
            commands.extend(literal.and_then(|literal| serde_json::from_str(literal).ok()));
        }
    }
    if let Some(first) = commands.first() {
        let line = one_line(first);
        return match commands.len() {
            1 => ("run", line),
            n => ("run", format!("{line} (+{} more)", n - 1)),
        };
    }
    names.dedup();
    ("tool", clip(&names.join(", "), 120))
}
/// A short summary of a tool call: its kind and the command, path, pattern, URL or
/// description it acts on. File contents, edit bodies, prompts beyond one line and
/// tool results are never read.
fn tool_step(name: &str, input: &Value, project: &str) -> (&'static str, String) {
    let text = |key: &str| input[key].as_str().map(one_line).unwrap_or_default();
    let path = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| input[*key].as_str())
            .map(|path| short_path(path, project))
            .unwrap_or_default()
    };
    let (tool, detail) = match name {
        "Bash" | "PowerShell" | "shell" | "shell_command" | "exec_command" | "local_shell"
        | "container.exec" => {
            let command = if input["command"].is_null() {
                &input["cmd"]
            } else {
                &input["command"]
            };
            ("run", one_line(&command_line(command)))
        },
        "Read" | "NotebookRead" | "view_image" => {
            ("read", path(&["file_path", "notebook_path", "path"]))
        },
        "Edit" | "MultiEdit" | "NotebookEdit" => ("edit", path(&["file_path", "notebook_path"])),
        "Write" => ("write", path(&["file_path"])),
        "apply_patch" => patch_files(
            input
                .as_str()
                .or(input["input"].as_str())
                .unwrap_or_default(),
            project,
        ),
        "exec" if input.is_string() => code_mode(input.as_str().unwrap_or_default()),
        "Grep" | "Glob" => ("search", text("pattern")),
        "WebSearch" | "web_search" | "ToolSearch" | "tool_search" => ("search", text("query")),
        "WebFetch" => ("fetch", text("url")),
        "web_search_call" => match input["type"].as_str() {
            Some("open_page") => ("fetch", text("url")),
            Some("find_in_page") => ("search", text("pattern")),
            _ => (
                "search",
                Some(text("query"))
                    .filter(|q| !q.is_empty())
                    .unwrap_or("the web".into()),
            ),
        },
        "Task" | "Agent" => ("agent", text("description")),
        // Its message is the delegated prompt; show only a name the agent gave the task.
        "spawn_agent" => (
            "agent",
            ["description", "task_name", "name"]
                .into_iter()
                .map(text)
                .find(|name| !name.is_empty())
                .unwrap_or("a task".into()),
        ),
        "TodoWrite" | "update_plan" => ("plan", String::new()),
        "Skill" => (
            "tool",
            Some(text("skill"))
                .filter(|s| !s.is_empty())
                .map(|s| format!("skill {s}"))
                .unwrap_or_default(),
        ),
        _ => ("tool", String::new()),
    };
    match tool {
        "plan" => (tool, detail),
        _ if detail.is_empty() => (tool, tool_name(name)),
        _ => (tool, detail),
    }
}
impl Chat {
    fn incomplete(&mut self, reason: &'static str) {
        self.partial = true;
        if !self.partial_reasons.contains(&reason) {
            self.partial_reasons.push(reason);
        }
    }
    fn push(&mut self, role: &str, text: String, timestamp: Value) {
        if !matches!(role, "user" | "assistant") || text.trim().is_empty() {
            return;
        }
        if self.title.is_empty() && role == "user" {
            self.title = clip(&text, 120);
        }
        // Bound memory even for unusually dense transcripts. Coverage reports this loss.
        if self.messages.len() == 50_000 {
            self.incomplete("message_limit");
            return;
        }
        self.messages
            .push(json!({"role":role,"text":text,"timestamp":timestamp}));
        if role == "assistant" {
            let message = self.messages.last_mut().unwrap();
            if let Some(model) = &self.model {
                message["model"] = json!(model);
            }
            if let Some(effort) = &self.reasoning_effort {
                message["reasoning_effort"] = json!(effort);
            }
        }
    }
    /// A tool call becomes a one-line progress step. Older browsers read `phase` and show
    /// it as a progress note; newer ones read `kind`, `tool` and `detail`.
    fn push_tool(&mut self, name: &str, input: &Value, timestamp: Value) {
        if self.messages.len() == 50_000 {
            self.incomplete("message_limit");
            return;
        }
        let (tool, detail) = tool_step(name, input, &self.project);
        let verb = match tool {
            "run" => "Ran",
            "read" => "Read",
            "edit" => "Edited",
            "write" => "Wrote",
            "search" => "Searched",
            "fetch" => "Fetched",
            "agent" => "Delegated",
            "plan" => "Updated the plan",
            _ => "Used",
        };
        let text = format!("{verb} {detail}").trim_end().to_owned();
        self.messages.push(
            json!({"role":"assistant","phase":"commentary","kind":"tool","tool":tool,
            "detail":detail,"text":text,"timestamp":timestamp}),
        );
    }
    // Only explicit user/assistant content parts, never tool output or reasoning.
    fn push_parts(&mut self, role: &str, parts: &Value, timestamp: Value) {
        if !matches!(role, "user" | "assistant") {
            return;
        }
        let mut attachments = Vec::new();
        for part in parts.as_array().into_iter().flatten() {
            let kind = part["type"].as_str().unwrap_or_default();
            if !matches!(
                kind,
                "image" | "input_image" | "image_url" | "local_image" | "video" | "input_video"
            ) {
                continue;
            }
            if attachments.len() == 8 {
                self.partial = true;
                break;
            }
            let mut item = json!({"kind":if kind.contains("video") {"video"} else {"image"},"name":clip(part["name"].as_str().unwrap_or("Attachment"),120)});
            let source = &part["source"];
            let reference = part["path"]
                .as_str()
                .or_else(|| part["image_url"].as_str())
                .or_else(|| part["image_url"]["url"].as_str())
                .or_else(|| part["video_url"].as_str())
                .or_else(|| source["url"].as_str());
            let embedded = if source["type"] == "base64" {
                Some(format!(
                    "data:{};base64,{}",
                    source["media_type"].as_str().unwrap_or(""),
                    source["data"].as_str().unwrap_or("")
                ))
            } else {
                reference
                    .filter(|r| r.starts_with("data:"))
                    .map(str::to_owned)
            };
            if let Some(data) = embedded {
                let supported = ["image/png", "image/jpeg", "image/webp", "image/gif"]
                    .iter()
                    .any(|mime| data.starts_with(&format!("data:{mime};base64,")));
                if supported && self.embedded_bytes + data.len() <= 2 * 1024 * 1024 {
                    use base64::Engine;
                    let valid = data.split_once(',').is_some_and(|(_, body)| {
                        base64::engine::general_purpose::STANDARD
                            .decode(body)
                            .is_ok()
                    });
                    if valid {
                        self.embedded_bytes += data.len();
                        item["url"] = json!(data);
                    } else {
                        item["unavailable"] = json!("Invalid embedded image");
                    }
                } else {
                    item["unavailable"] = json!(
                        "Embedded attachment exceeds preview limits or uses an unsupported format"
                    );
                }
            } else if let Some(reference) = reference.filter(|r| r.len() <= 4096) {
                item["url"] = json!(reference);
            } else {
                item["unavailable"] =
                    json!("The transcript did not retain a previewable attachment");
            }
            attachments.push(item);
        }
        let text = content(parts);
        let before = self.messages.len();
        self.push(
            role,
            if text.trim().is_empty() && !attachments.is_empty() {
                "[Attachment]".into()
            } else {
                text
            },
            timestamp,
        );
        if self.messages.len() > before && !attachments.is_empty() {
            self.messages.last_mut().unwrap()["attachments"] = json!(attachments);
        }
    }
    /// Follows Claude's background agents (2.1.319): an Agent result with status
    /// `async_launched` starts one; a task notification for its tool call or agent id,
    /// queued or delivered, or a TaskStop of that id ends it. A new Claude process
    /// (SessionStart on startup or resume) leaves none running.
    fn track_background(&mut self, v: &Value) {
        let finished = |agents: &mut Vec<BackgroundAgent>, text: &str| {
            if !text.contains("<task-notification>") {
                return;
            }
            let call = tag_text(text, "tool-use-id");
            let task = tag_text(text, "task-id");
            agents.retain(|agent| {
                call != Some(agent.tool_use_id.as_str()) && task != Some(agent.agent_id.as_str())
            });
        };
        match v["type"].as_str() {
            Some("attachment") => {
                let attachment = &v["attachment"];
                if attachment["hookEvent"] == "SessionStart"
                    && matches!(
                        attachment["hookName"].as_str(),
                        Some("SessionStart:startup" | "SessionStart:resume")
                    )
                {
                    self.background.clear();
                }
            },
            Some("queue-operation") if v["operation"] == "enqueue" => {
                finished(
                    &mut self.background,
                    v["content"].as_str().unwrap_or_default(),
                );
            },
            Some("user") => {
                let result = &v["toolUseResult"];
                if result["status"] == "async_launched" {
                    let call = v["message"]["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find_map(|part| part["tool_use_id"].as_str());
                    if let (Some(call), Some(agent_id)) = (call, result["agentId"].as_str()) {
                        if !self.background.iter().any(|a| a.tool_use_id == call)
                            && self.background.len() < 32
                        {
                            self.background.push(BackgroundAgent {
                                tool_use_id: clip(call, 128),
                                agent_id: clip(agent_id, 128),
                                description: clip(
                                    one_line(result["description"].as_str().unwrap_or_default())
                                        .as_str(),
                                    120,
                                ),
                                model: result["resolvedModel"]
                                    .as_str()
                                    .filter(|model| !model.is_empty())
                                    .map(|model| clip(model, 128)),
                                started: v["timestamp"].clone(),
                            });
                        }
                    }
                }
                finished(&mut self.background, &content(&v["message"]["content"]));
            },
            Some("assistant") => {
                for part in v["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] == "tool_use" && part["name"] == "TaskStop" {
                        let id = part["input"]["task_id"].as_str().unwrap_or_default();
                        self.background.retain(|agent| agent.agent_id != id);
                    }
                }
            },
            _ => (),
        }
    }
    fn record(&mut self, v: &Value, depth: usize) {
        if depth > 2 {
            self.partial = true;
            return;
        }
        if self.agent == "muse" {
            if let Some(children) = v["children"].as_array() {
                for child in children {
                    match child["record_json"]
                        .as_str()
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                    {
                        Some(record) => self.record(&record, depth + 1),
                        None => self.partial = true,
                    }
                }
                return;
            }
            let p = &v["payload"];
            if v["stream"]["kind"] == "session" {
                if let Some(id) = v["stream"]["id"].as_str() {
                    self.session_id = id.into();
                }
            }
            if let Some(root) = p["record"]["workspace_root"].as_str() {
                self.project = root.into();
            }
            if v["payload_type"] == "session.name.changed" {
                if let Some(name) = p["new_name"].as_str() {
                    self.title = clip(name, 120);
                }
            }
            if p["kind"] == "run" {
                let e = &p["event"];
                match e["kind"].as_str() {
                    Some("started") => {
                        self.push("user", content(&e["prompt"]), v["recorded_at"].clone())
                    },
                    // Accepted intents and queued records describe the same input;
                    // include only its delivered copy in the conversation.
                    Some("inbox_item_drained")
                        if e["delivery_snapshot"]["source"]["source"] == "user_steer" =>
                    {
                        let item = e["item_id"].as_str();
                        if item.is_none_or(|id| self.muse_deliveries.insert(id.to_owned())) {
                            self.push(
                                "user",
                                content(&e["delivery_snapshot"]["payload"]["prompt"]),
                                v["recorded_at"].clone(),
                            );
                        }
                    },
                    Some("assistant_message_committed") => {
                        self.push("assistant", content(&e["text"]), v["recorded_at"].clone())
                    },
                    _ => (),
                }
            }
            return;
        }
        match self.agent.as_str() {
            "claude" => {
                self.track_background(v);
                if v["type"] == "assistant" {
                    if let Some(model) = v["message"]["model"]
                        .as_str()
                        .filter(|model| !model.is_empty() && *model != "<synthetic>")
                    {
                        self.model = Some(clip(model, 128));
                        // Claude Code records the turn's effort beside the message.
                        self.reasoning_effort = v["effort"]
                            .as_str()
                            .or_else(|| v["perTurnEffort"].as_str())
                            .filter(|effort| !effort.is_empty())
                            .map(|effort| clip(effort, 32));
                    }
                }
                if let Some(id) = v["sessionId"].as_str() {
                    self.session_id = id.into();
                }
                if let Some(cwd) = v["cwd"].as_str() {
                    self.project = cwd.into();
                }
                if let Some(title) = v["customTitle"].as_str() {
                    self.title = clip(title, 120);
                }
                // Claude Code's own test for "the human typed this" (`Q5`/`Cl` in its
                // 2.1.319 bundle): no meta, compaction or transcript-only flag, and an
                // origin that is absent (older records) or human. Task notifications,
                // peer messages, skill bodies and summaries all fail it, while text a
                // human pastes still passes because it carries the human origin.
                let origin = match &v["origin"]["kind"] {
                    Value::Null if v["commandMode"] == "task-notification" => {
                        Some("task-notification")
                    },
                    kind => kind.as_str(),
                };
                let human = v["type"] != "user"
                    || (v["isMeta"] != true
                        && v["isCompactSummary"] != true
                        && v["isVisibleInTranscriptOnly"] != true
                        && origin.is_none_or(|kind| kind == "human"));
                let command = (v["type"] == "user" && v["promptSource"].is_null())
                    .then(|| claude_command(&content(&v["message"]["content"])))
                    .flatten();
                if matches!(v["type"].as_str(), Some("user" | "assistant")) && human {
                    if let Some(command) = command {
                        self.push("user", command, v["timestamp"].clone());
                    } else {
                        self.push_parts(
                            v["type"].as_str().unwrap(),
                            &v["message"]["content"],
                            v["timestamp"].clone(),
                        );
                    }
                }
                // Claude marks no phase. Text followed by a tool call is a progress
                // note, which Codex reports as commentary; the turn's last text is the answer.
                let calls = || {
                    v["message"]["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|part| {
                            matches!(part["type"].as_str(), Some("tool_use" | "server_tool_use"))
                        })
                };
                self.used_tool = v["type"] == "assistant" && calls().next().is_some();
                if self.used_tool {
                    let last = self.messages.iter_mut().rev().find(|m| !is_tool(m));
                    if let Some(last) = last.filter(|message| message["role"] == "assistant") {
                        last["phase"] = json!("commentary");
                    }
                    for call in calls() {
                        if let Some(name) = call["name"].as_str() {
                            self.push_tool(name, &call["input"], v["timestamp"].clone());
                        }
                    }
                }
            },
            "codex" => {
                let p = &v["payload"];
                if v["type"] == "turn_context" {
                    self.model = p["model"]
                        .as_str()
                        .filter(|model| !model.is_empty())
                        .map(|model| clip(model, 128));
                    self.reasoning_effort = p["effort"]
                        .as_str()
                        .or_else(|| p["reasoning_effort"].as_str())
                        .filter(|effort| !effort.is_empty())
                        .map(|effort| clip(effort, 32));
                }
                // A forked sub-agent copies its parent's session_meta after its own.
                if v["type"] == "session_meta" && self.session_id.is_empty() {
                    self.session_id = p["id"].as_str().unwrap_or_default().into();
                    self.project = p["cwd"].as_str().unwrap_or_default().into();
                }
                // Read what Codex's own history shows (app-server-protocol thread_history.rs):
                // user_message/agent_message events in legacy rollouts, completed
                // UserMessage/AgentMessage items in paginated ones. Codex leaves injected
                // context, compaction summaries and a fork's copied history out of both;
                // response_item messages are model input and include all of them.
                // Tool calls are model output, so they appear only as response items.
                // Their outputs (function_call_output and friends) are never read.
                if v["type"] == "response_item" {
                    let (name, input) = match p["type"].as_str() {
                        Some("function_call") => {
                            let name = p["name"].as_str().unwrap_or_default();
                            let namespace = p["namespace"].as_str().unwrap_or_default();
                            let arguments = p["arguments"].as_str().unwrap_or_default();
                            (
                                if namespace.starts_with("mcp__") {
                                    format!("{namespace}{name}")
                                } else {
                                    name.into()
                                },
                                serde_json::from_str(arguments).unwrap_or(Value::Null),
                            )
                        },
                        Some("custom_tool_call") => (
                            p["name"].as_str().unwrap_or_default().into(),
                            p["input"].clone(),
                        ),
                        Some("local_shell_call") => ("local_shell".into(), p["action"].clone()),
                        Some("web_search_call") => ("web_search_call".into(), p["action"].clone()),
                        Some("tool_search_call") => ("tool_search".into(), p["arguments"].clone()),
                        _ => return,
                    };
                    if !name.is_empty() {
                        self.push_tool(&name, &input, v["timestamp"].clone());
                    }
                    return;
                }
                let item = &p["item"];
                let (role, parts, phase) = match (v["type"].as_str(), p["type"].as_str()) {
                    (Some("event_msg"), Some("user_message")) => {
                        let mut parts = vec![json!({"type":"text","text":p["message"]})];
                        for url in p["images"].as_array().into_iter().flatten() {
                            parts.push(json!({"type":"input_image","image_url":url}));
                        }
                        for path in p["local_images"].as_array().into_iter().flatten() {
                            parts.push(json!({"type":"local_image","path":path}));
                        }
                        ("user", Value::Array(parts), &Value::Null)
                    },
                    (Some("event_msg"), Some("agent_message")) => (
                        "assistant",
                        json!([{"type":"text","text":p["message"]}]),
                        &p["phase"],
                    ),
                    (Some("event_msg"), Some("item_completed"))
                        if item["type"] == "UserMessage" =>
                    {
                        ("user", item["content"].clone(), &Value::Null)
                    },
                    // AgentMessage content parts are typed "Text".
                    (Some("event_msg"), Some("item_completed"))
                        if item["type"] == "AgentMessage" =>
                    {
                        let text = item["content"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|part| part["text"].as_str())
                            .collect::<String>();
                        (
                            "assistant",
                            json!([{"type":"text","text":text}]),
                            &item["phase"],
                        )
                    },
                    _ => return,
                };
                let parts = match parts.as_array() {
                    Some(list) if role == "user" => list
                        .iter()
                        .map(
                            |part| match part["text"].as_str().and_then(codex_question_reply) {
                                Some(text) => json!({"type":"text","text":text}),
                                None => part.clone(),
                            },
                        )
                        .collect(),
                    _ => parts,
                };
                let before = self.messages.len();
                self.push_parts(role, &parts, v["timestamp"].clone());
                if self.messages.len() > before && phase == "commentary" {
                    self.messages.last_mut().unwrap()["phase"] = json!("commentary");
                }
            },
            "copilot" => {
                let p = &v["data"];
                if v["type"] == "session.start" {
                    self.session_id = p["sessionId"].as_str().unwrap_or_default().into();
                    self.project = p["context"]["cwd"].as_str().unwrap_or_default().into();
                }
                match v["type"].as_str() {
                    Some("user.message") => {
                        self.push("user", content(&p["content"]), v["timestamp"].clone())
                    },
                    Some("assistant.message") => {
                        self.push("assistant", content(&p["content"]), v["timestamp"].clone())
                    },
                    _ => (),
                }
            },
            _ => (),
        }
    }
    fn summary(&self) -> Value {
        json!({"id":self.id,"session_id":clip(&self.session_id,256),"agent":self.agent,"title":self.title,
            "project":clip(&self.project,4096),"model":self.model,"reasoning_effort":self.reasoning_effort,
            "timestamp":self.messages.last().map(|m| &m["timestamp"]),"partial":self.partial,"partial_reasons":self.partial_reasons,
            "background_agents":self.background.iter().map(|a| json!({"description":a.description,"model":a.model,"started":a.started})).collect::<Vec<_>>()})
    }
}
fn roots() -> Vec<(&'static str, PathBuf)> {
    let home = std::env::home_dir().unwrap_or_default();
    let env = |name, fallback: PathBuf| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .unwrap_or(fallback)
    };
    let data = env("XDG_DATA_HOME", home.join(".local/share"));
    vec![
        (
            "claude",
            env("CLAUDE_CONFIG_DIR", home.join(".claude")).join("projects"),
        ),
        ("codex", env("CODEX_HOME", home.join(".codex"))),
        ("muse", data.join("muse/sessions")),
        (
            "copilot",
            env("COPILOT_HOME", home.join(".copilot")).join("session-state"),
        ),
        ("opencode", data.join("opencode/opencode.db")),
    ]
}
fn discover(root: &Path, agent: &str) -> (Vec<PathBuf>, bool) {
    let mut files = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut partial = false;
    let mut entries = 0;
    while let Some((dir, depth)) = stack.pop() {
        if depth > 12 {
            partial = true;
            continue;
        }
        let Ok(rd) = fs::read_dir(dir) else {
            partial = true;
            continue;
        };
        for e in rd {
            entries += 1;
            if entries > 100_000 {
                return (files, true);
            }
            let Ok(e) = e else {
                partial = true;
                continue;
            };
            let Ok(t) = e.file_type() else {
                partial = true;
                continue;
            };
            if t.is_symlink() {
                partial = true;
                continue;
            }
            let p = e.path();
            if t.is_dir() {
                stack.push((p, depth + 1));
            } else if t.is_file()
                && p.extension().is_some_and(|x| x == "jsonl")
                && (agent != "muse" || p.file_name().is_some_and(|n| n == "session.jsonl"))
                && (agent != "copilot" || p.file_name().is_some_and(|n| n == "events.jsonl"))
            {
                files.push(p);
            }
        }
    }
    files.sort();
    (files, partial)
}
fn file_id(agent: &str, root: &Path, file: &Path) -> String {
    let path = file
        .strip_prefix(root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    let hash: String = Sha256::digest(path.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{agent}-{hash}")
}

// Use only paths within the history roots already exposed by the read-only API.
// The ID is computed without reading the transcript or spawning a provider process.
pub(super) fn hook_chat_id(agent: &str, event: &Value) -> Option<String> {
    let (_, root) = roots().into_iter().find(|(a, _)| *a == agent)?;
    let path = Path::new(event["transcript_path"].as_str()?);
    bind_transcript(agent, root, path)
}

fn bind_transcript(agent: &str, root: PathBuf, path: &Path) -> Option<String> {
    transcript_id(agent, &root, path)?;
    // Windows accepts different casing for the same file. Hash the spelling
    // discovery will see, so the ID still resolves after the hook cache is lost.
    // Keep missing paths for new sessions, and never resolve through a symlink.
    #[cfg(windows)]
    let normalized = (|| {
        for ancestor in path.ancestors().take_while(|p| *p != root) {
            if fs::symlink_metadata(ancestor)
                .ok()?
                .file_type()
                .is_symlink()
            {
                return None;
            }
        }
        let disk_root = fs::canonicalize(&root).ok()?;
        let disk_path = fs::canonicalize(path).ok()?;
        Some(root.join(disk_path.strip_prefix(disk_root).ok()?))
    })();
    #[cfg(windows)]
    let path = normalized.as_deref().unwrap_or(path);
    let id = transcript_id(agent, &root, path)?;
    TRANSCRIPTS
        .lock()
        .unwrap()
        .insert(id.clone(), (agent.into(), root, path.into()));
    Some(id)
}

fn transcript_id(agent: &str, root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    if relative
        .components()
        .any(|c| !matches!(c, std::path::Component::Normal(_)))
        || path.extension().is_none_or(|e| e != "jsonl")
    {
        return None;
    }
    if agent == "codex"
        && !relative.starts_with("sessions")
        && !relative.starts_with("archived_sessions")
    {
        return None;
    }
    Some(file_id(agent, root, path))
}

fn read_file(agent: &str, root: &Path, path: &Path) -> std::io::Result<Chat> {
    let mut chat = Chat {
        id: file_id(agent, root, path),
        agent: agent.into(),
        ..Chat::default()
    };
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > FILE_BYTES {
        chat.incomplete("file_limit");
    }
    let mut reader = BufReader::new(file.take(FILE_BYTES));
    loop {
        let mut line = Vec::new();
        let n = reader
            .by_ref()
            .take(LINE_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if n as u64 > LINE_BYTES {
            chat.incomplete("record_limit");
            // Skip this oversized record without hiding all later messages.
            if line.last() != Some(&b'\n') {
                loop {
                    let buffer = reader.fill_buf()?;
                    if buffer.is_empty() {
                        break;
                    }
                    let newline = buffer.iter().position(|b| *b == b'\n');
                    let count = newline.map_or(buffer.len(), |n| n + 1);
                    reader.consume(count);
                    if newline.is_some() {
                        break;
                    }
                }
            }
            continue;
        }
        // An incomplete final line may still be being written by the agent.
        if line.last() != Some(&b'\n') {
            // Accept a complete final record without a newline. An unfinished live
            // write is retried on the next poll, not reported as lost history.
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                chat.record(&value, 0);
            }
            break;
        }
        match serde_json::from_slice::<Value>(&line) {
            Ok(v) => chat.record(&v, 0),
            Err(_) => chat.incomplete("malformed_record"),
        }
    }
    Ok(chat)
}
fn excerpt(text: &str, q: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lower = text.to_lowercase();
    let at = lower
        .find(q)
        .map(|byte_offset| {
            // Lowercasing can expand a character (İ becomes i + combining dot).
            // Map the matched lowercase byte back to its original character.
            let mut lowered_bytes = 0;
            chars
                .iter()
                .position(|c| {
                    lowered_bytes += c.to_lowercase().map(char::len_utf8).sum::<usize>();
                    lowered_bytes > byte_offset
                })
                .unwrap_or(chars.len())
        })
        .unwrap_or(0)
        .min(chars.len());
    let start = at.saturating_sub(80);
    format!(
        "{}{}",
        if start > 0 { "…" } else { "" },
        chars[start..].iter().take(400).collect::<String>()
    )
}
fn add_result(chat: &Chat, p: &Params, results: &mut Vec<Value>) {
    if p.project
        .as_ref()
        .is_some_and(|q| !chat.project.contains(q))
    {
        return;
    }
    let q = p.q.to_lowercase();
    let matched = chat.messages.iter().enumerate().find(|(_, m)| {
        !is_tool(m)
            && m["text"]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
                .contains(&q)
    });
    if matched.is_none() && !chat.title.to_lowercase().contains(&q) {
        return;
    }
    let mut v = chat.summary();
    if let Some((index, m)) = matched {
        v["excerpt"] = json!(excerpt(m["text"].as_str().unwrap_or_default(), &q));
        v["message_cursor"] = json!(index);
    }
    results.push(v);
}
// A small, inert Markdown event stream. The browser creates allowlisted DOM nodes;
// neither transcript HTML nor provider-controlled attributes are inserted as HTML.
fn markdown_events(source: &str) -> Vec<Value> {
    use pulldown_cmark::{Event, Options, Parser, Tag};
    Parser::new_ext(source, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS).map(|event| match event {
        Event::Start(tag) => match tag {
            Tag::Link { dest_url, .. } => json!({"type":"start","tag":"a","url":dest_url.as_ref()}),
            Tag::Image { dest_url, .. } => json!({"type":"start","tag":"image","url":dest_url.as_ref()}),
            Tag::Heading { level, .. } => json!({"type":"start","tag":format!("{level}")}),
            Tag::List(start) => json!({"type":"start","tag":if start.is_some(){"ol"}else{"ul"},"start":start}),
            // The fence's language labels the code card and picks its highlighting.
            Tag::CodeBlock(pulldown_cmark::CodeBlockKind::Fenced(info)) => json!({"type":"start","tag":"pre","lang":info.split(|c: char| c.is_whitespace() || c == ',').next().unwrap_or("")}),
            tag => json!({"type":"start","tag":match tag {
                Tag::Paragraph=>"p",Tag::BlockQuote(_)=>"blockquote",Tag::CodeBlock(_)=>"pre",
                Tag::Item=>"li",Tag::Emphasis=>"em",Tag::Strong=>"strong",Tag::Strikethrough=>"del",
                Tag::Table(_)=>"table",Tag::TableHead=>"thead",Tag::TableRow=>"tr",Tag::TableCell=>"td",_=>"span"
            }}),
        },
        Event::End(_)=>json!({"type":"end"}),
        Event::Text(text)|Event::Html(text)|Event::InlineHtml(text)=>json!({"type":"text","text":text.as_ref()}),
        Event::Code(text)=>json!({"type":"code","text":text.as_ref()}),
        Event::SoftBreak=>json!({"type":"text","text":"\n"}),
        Event::HardBreak=>json!({"type":"break"}),
        Event::Rule=>json!({"type":"rule"}),
        Event::TaskListMarker(done)=>json!({"type":"text","text":if done {"☑ "}else{"☐ "}}),
        _=>json!({"type":"text","text":""}),
    }).collect()
}

// The composer sends uploaded paths as a text suffix so terminal agents can
// read them. Keep the raw text for delivery reconciliation, but display those
// files as attachments in history too. Only recognize our upload directory.
fn uploaded_attachments(text: &str) -> Option<(String, Vec<Value>)> {
    let mut body = text.replace("\r\n", "\n");
    let mut attachments = Vec::new();
    // New tab sends Claude "Attached files:" then "Attached images:"; the composer sends "Attached files:".
    // Take the last suffix first.
    while let Some((rest, files)) = ["Attached files:\n", "Attached images:\n"]
        .into_iter()
        .filter_map(|header| {
            body.rsplit_once(&format!("\n\n{header}"))
                .or_else(|| body.strip_prefix(header).map(|files| ("", files)))
        })
        .max_by_key(|(rest, _)| rest.len())
    {
        let lines = files.lines().collect::<Vec<_>>();
        if lines.is_empty() || lines.len() > 8 {
            break;
        }
        let Some(mut found) = lines
            .into_iter()
            .map(uploaded_file)
            .collect::<Option<Vec<_>>>()
        else {
            break;
        };
        found.append(&mut attachments);
        attachments = found;
        body = rest.into();
    }
    // A New tab handover (handover.js `prompt`) wraps the request in instructions.
    if let Some((path, request)) = body
        .strip_prefix("Read the context handover file at ")
        .and_then(|rest| rest.split_once(" before acting. "))
        .and_then(|(path, rest)| Some((path, rest.split_once("\n\nCurrent user request:\n")?.1)))
    {
        if let Some(file) = serde_json::from_str::<String>(path)
            .ok()
            .as_deref()
            .and_then(uploaded_file)
        {
            attachments.insert(0, file);
            body = request.into();
        }
    }
    (!attachments.is_empty()).then_some((body, attachments))
}
/// Claude Code turns an attached image path into an image block and leaves
/// `[Image #3]` in the text, so the composer's "Attached files:" header can end
/// up with nothing under it. The image shows as an attachment; drop both.
fn without_image_placeholders(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("[Image #") {
        let tail = &rest[start + "[Image #".len()..];
        let digits = tail.chars().take_while(char::is_ascii_digit).count();
        out.push_str(&rest[..start]);
        if digits > 0 && tail[digits..].starts_with(']') {
            rest = &tail[digits + 1..];
        } else {
            out.push_str("[Image #");
            rest = tail;
        }
    }
    out.push_str(rest);
    let mut lines: Vec<&str> = out.lines().collect();
    while lines
        .last()
        .is_some_and(|line| matches!(line.trim(), "" | "Attached files:" | "Attached images:"))
    {
        lines.pop();
    }
    let cleaned = lines.join("\n").trim().to_owned();
    (cleaned != text).then_some(cleaned)
}
fn uploaded_file(path: &str) -> Option<Value> {
    if path.len() > 4096 || path.chars().any(char::is_control) {
        return None;
    }
    let normalized = path.replace('\\', "/");
    let absolute = normalized.starts_with('/')
        || normalized.starts_with("~/")
        || (normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && normalized.as_bytes().get(1..3) == Some(b":/"));
    let (directory, name) = normalized.rsplit_once('/')?;
    let (root, id) = directory.rsplit_once('/')?;
    if !absolute
        || normalized.starts_with("//")
        || !root.ends_with("/.local/share/switchboard/attachments")
        || id.len() != 36
        || uuid::Uuid::parse_str(id).is_err()
        || matches!(name, "" | "." | "..")
    {
        return None;
    }
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let kind = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "svg" => "image",
        "mp4" | "webm" | "mov" | "m4v" => "video",
        _ => "file",
    };
    Some(json!({"kind":kind,"name":clip(name,120),"url":path}))
}

fn read_page(chat: &Chat, p: &Params) -> Value {
    let mut result = chat.summary();
    let end = p
        .before
        .unwrap_or(chat.messages.len())
        .min(chat.messages.len());
    let start = if p.tail || p.before.is_some() {
        end.saturating_sub(p.limit())
    } else {
        p.cursor.min(end)
    };
    // Search and agent reads get a bounded preview. Conversation and handovers
    // ask with `context` and receive every message in full.
    let shown = if p.context { usize::MAX } else { 4000 };
    let mut page:Vec<_>=chat.messages[start..end].iter().take(p.limit()).map(|m| {
        let text=m["text"].as_str().unwrap_or_default();
        json!({"role":m["role"],"timestamp":m["timestamp"],"text":clip(text,shown),"truncated":text.chars().count()>shown,"phase":m["phase"],"model":m["model"],"reasoning_effort":m["reasoning_effort"],"attachments":m["attachments"],"markdown":markdown_events(&clip(text,shown))})
    }).collect();
    for (message, source) in page.iter_mut().zip(&chat.messages[start..end]) {
        if is_tool(source) {
            for key in ["kind", "tool", "detail"] {
                message[key] = source[key].clone();
            }
            // Older browsers render this as a progress note with the detail as code.
            let (text, detail) = (
                source["text"].as_str().unwrap_or_default(),
                source["detail"].as_str().unwrap_or_default(),
            );
            if let Some(verb) = text.strip_suffix(detail).filter(|_| !detail.is_empty()) {
                message["markdown"] = json!([{"type":"start","tag":"p"},{"type":"text","text":verb},{"type":"code","text":detail},{"type":"end"}]);
            }
        }
        if p.context {
            // Portable handovers need complete attributed text, not the display
            // preview. Bound each record and explicitly mark anything too long.
            let text = source["text"].as_str().unwrap_or_default();
            message["context_text"] = json!(clip(text, 64000));
            message["context_truncated"] = json!(text.chars().count() > 64000);
        }
        if source["role"] == "user" {
            // Display stays clipped; receipt matching must cover every message
            // accepted by the composer, including an attached-file suffix.
            if message["truncated"] == true {
                if let Some(text) = source["text"].as_str().filter(|text| text.len() <= 16_000) {
                    message["receipt_text"] = json!(text);
                }
            }
            // What the bubble shows. `text` stays raw for delivery reconciliation.
            let mut display = None;
            if let Some((body, files)) = source["text"].as_str().and_then(uploaded_attachments) {
                let mut attachments = message["attachments"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                for file in files {
                    if attachments.len() < 8
                        && !attachments.iter().any(|existing| {
                            existing["url"]
                                .as_str()
                                .zip(file["url"].as_str())
                                .is_some_and(|(one, two)| {
                                    one.replace('\\', "/") == two.replace('\\', "/")
                                })
                        })
                    {
                        attachments.push(file);
                    }
                }
                message["attachments"] = json!(attachments);
                display = Some(body);
            }
            if message["attachments"]
                .as_array()
                .is_some_and(|files| !files.is_empty())
            {
                let shown = display
                    .clone()
                    .unwrap_or_else(|| source["text"].as_str().unwrap_or_default().to_owned());
                if let Some(clean) = without_image_placeholders(&shown) {
                    display = Some(clean);
                }
            }
            if let Some(body) = display {
                message["markdown"] = json!(markdown_events(&clip(&body, shown)));
            }
        }
    }
    let next = start.saturating_add(page.len());
    result["start_cursor"] = json!(start);
    result["message_count"] = json!(chat.messages.len());
    result["previous_cursor"] = if start > 0 { json!(start) } else { Value::Null };
    result["messages"] = json!(page);
    result["next_cursor"] = if next < end { json!(next) } else { Value::Null };
    result
}

fn local(roots: Vec<(&str, PathBuf)>, p: &Params, id: Option<&str>) -> Value {
    if let Some((agent, root, path)) =
        id.and_then(|id| TRANSCRIPTS.lock().unwrap().get(id).cloned())
    {
        // A hook-provided path must obey the same no-symlinks rule as discovery.
        // It may not exist yet: a new Claude session has no transcript until its first message.
        if p.agent.as_ref().is_none_or(|a| *a == agent)
            && roots.iter().any(|(a, r)| *a == agent && *r == root)
            && path
                .ancestors()
                .take_while(|path| *path != root)
                .all(|path| {
                    fs::symlink_metadata(path).map_or_else(
                        |error| error.kind() == ErrorKind::NotFound,
                        |m| !m.file_type().is_symlink(),
                    )
                })
        {
            return indexed_page(&agent, &root, &path, p);
        }
    }
    let mut sources = Vec::new();
    for (agent, root) in roots {
        if p.agent.as_ref().is_some_and(|a| a != agent)
            || id.is_some_and(|id| !id.starts_with(&format!("{agent}-")))
        {
            continue;
        }
        if agent == "opencode" {
            if id.is_some() {
                return opencode(&root, p, id);
            }
            sources.push(opencode(&root, p, id));
            continue;
        }
        let exists = root.exists();
        let (mut files, mut partial) = if agent == "codex" {
            let (mut a, pa) = discover(&root.join("sessions"), agent);
            let archive = root.join("archived_sessions");
            let (b, pb) = if archive.exists() {
                discover(&archive, agent)
            } else {
                (vec![], false)
            };
            a.extend(b);
            (a, pa || pb)
        } else {
            discover(&root, agent)
        };
        files.sort();
        if let Some(id) = id {
            if let Some(path) = files.iter().find(|path| file_id(agent, &root, path) == id) {
                TRANSCRIPTS
                    .lock()
                    .unwrap()
                    .insert(id.into(), (agent.into(), root.clone(), path.clone()));
                return indexed_page(agent, &root, path, p);
            }
            return json!({"error":if partial{"discovery_incomplete"}else{"not_found"}});
        }
        let mut results = Vec::new();
        let mut bytes = 0;
        let mut next = p.cursor;
        let mut errors = 0;
        for path in files.iter().skip(p.cursor).take(PAGE_FILES) {
            if bytes >= SCAN_BYTES || results.len() >= p.limit() {
                break;
            }
            next += 1;
            bytes += fs::metadata(path)
                .map(|m| m.len().min(FILE_BYTES))
                .unwrap_or(0);
            match read_file(agent, &root, path) {
                Ok(chat) => {
                    partial |= chat.partial;
                    add_result(&chat, p, &mut results)
                },
                Err(_) => {
                    errors += 1;
                    partial = true;
                },
            }
        }
        sources.push(json!({"agent":agent,"status":if !exists{"missing"}else if partial{"partial"}else{"ok"},
            "results":results,"files_scanned":next.saturating_sub(p.cursor),"unreadable_files":errors,
            "next_cursor":if next<files.len(){Some(next)}else{None}}));
    }
    if id.is_some() {
        json!({"error":"not_found"})
    } else {
        json!({"sources":sources})
    }
}

fn opencode(path: &Path, p: &Params, id: Option<&str>) -> Value {
    let run = || -> anyhow::Result<Value> {
        let db = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.busy_timeout(Duration::from_millis(200))?;
        // Newer storage families must never silently look like an empty legacy database.
        let newer: i64 = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='session_v2'",
            [],
            |r| r.get(0),
        )?;
        let mut newer_storage = newer > 0;
        let has_messages: i64 = db.query_row(
            "SELECT count(*) FROM sqlite_master WHERE name='session_message'",
            [],
            |r| r.get(0),
        )?;
        if has_messages > 0 {
            let has_new: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM session_message LIMIT 1)",
                [],
                |r| r.get(0),
            )?;
            newer_storage |= has_new;
        }
        let mut stmt =
            db.prepare("SELECT id,title,directory FROM session WHERE (?3 IS NULL OR id=?3) ORDER BY id LIMIT ?1 OFFSET ?2")?;
        let sessions = stmt.query_map(
            rusqlite::params![
                if id.is_some() {
                    100_000
                } else {
                    PAGE_FILES as i64
                },
                if id.is_some() { 0 } else { p.cursor as i64 },
                id.and_then(|id| id.strip_prefix("opencode-"))
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?;
        let mut results = Vec::new();
        let mut count = 0;
        let mut partial = newer_storage;
        let mut scanned_bytes = 0usize;
        for row in sessions {
            let (sid, title, project) = row?;
            let cid = format!("opencode-{sid}");
            if id.is_some_and(|id| id != cid) {
                continue;
            }
            count += 1;
            let mut chat = Chat {
                id: cid,
                session_id: sid.clone(),
                agent: "opencode".into(),
                title: clip(&title, 120),
                project,
                partial: newer_storage,
                ..Chat::default()
            };
            let mut messages=db.prepare("SELECT json_extract(m.data,'$.role'),substr(json_extract(p.data,'$.text'),1,1048576),m.time_created,length(json_extract(p.data,'$.text')) FROM message m JOIN part p ON p.message_id=m.id WHERE m.session_id=?1 AND json_extract(p.data,'$.type')='text' AND coalesce(json_extract(p.data,'$.synthetic'),0)=0 AND coalesce(json_extract(p.data,'$.ignored'),0)=0 AND json_extract(m.data,'$.role') IN ('user','assistant') ORDER BY m.time_created,m.id,p.time_created,p.id LIMIT 50001")?;
            let rows = messages.query_map([&sid], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, usize>(3)?,
                ))
            })?;
            for (index, row) in rows.enumerate() {
                let (role, text, time, len) = row?;
                scanned_bytes += text.len();
                if index == 50_000 || scanned_bytes > SCAN_BYTES as usize {
                    chat.partial = true;
                    break;
                }
                chat.partial |= len > 1_048_576;
                chat.push(&role, text, json!(time));
            }
            partial |= chat.partial;
            if id.is_some() {
                return Ok(read_page(&chat, p));
            }
            add_result(&chat, p, &mut results);
            if results.len() >= p.limit() || scanned_bytes > SCAN_BYTES as usize {
                break;
            }
        }
        if id.is_some() {
            return Ok(
                json!({"error":if newer_storage {"unsupported_storage"} else {"not_found"}}),
            );
        }
        let total: i64 = db.query_row("SELECT count(*) FROM session", [], |r| r.get(0))?;
        let next = p.cursor + count;
        Ok(
            json!({"agent":"opencode","status":if partial{"partial"}else{"ok"},"results":results,
            "next_cursor":if next<(total as usize){Some(next)}else{None}}),
        )
    };
    if !path.exists() {
        return json!({"agent":"opencode","status":"missing","results":[]});
    }
    run().unwrap_or_else(|_| {
        if id.is_some() {
            json!({"error":"unreadable_or_unsupported_schema"})
        } else {
            json!({"agent":"opencode","status":"unreadable_or_unsupported_schema","results":[]})
        }
    })
}

async fn local_async(p: Params, id: Option<String>) -> Value {
    // Limit concurrent disk scans without blocking Tokio's runtime threads.
    static SCANS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let Ok(permit) = SCANS.acquire().await else {
        return json!({"error":"unavailable"});
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        local(roots(), &p, id.as_deref())
    })
    .await
    .unwrap_or_else(|_| json!({"error":"history_reader_failed"}));
    result
}
async fn remote(host: &Host, p: &Params, id: Option<&str>) -> Value {
    let mut p = p.clone();
    p.host = None;
    let query = {
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("q", &p.q)
            .append_pair("cursor", &p.cursor.to_string());
        if let Some(a) = &p.agent {
            query.append_pair("agent", a);
        }
        if let Some(n) = p.limit {
            query.append_pair("limit", &n.to_string());
        }
        if p.tail {
            query.append_pair("tail", "true");
        }
        if let Some(before) = p.before {
            query.append_pair("before", &before.to_string());
        }
        if let Some(project) = &p.project {
            query.append_pair("project", project);
        }
        if p.context {
            query.append_pair("context", "true");
        }
        query.finish()
    };
    let path = format!("/switchboard/chats/{}?{}", id.unwrap_or("search"), query);
    match tokio::time::timeout(
        Duration::from_secs(15),
        host.request(Method::GET, &path, Bytes::new(), "application/json"),
    )
    .await
    {
        Ok(Ok(r)) if r.status == StatusCode::OK => serde_json::from_slice(&r.body)
            .unwrap_or_else(|_| json!({"error":"invalid_peer_response"})),
        Ok(Ok(r)) if r.status == StatusCode::BAD_REQUEST && (p.tail || p.before.is_some()) => {
            json!({"error":"This computer needs an update to show recent messages first."})
        },
        Ok(Ok(r)) if r.status == StatusCode::NOT_FOUND => {
            json!({"error":"unsupported_peer_version"})
        },
        _ => json!({"error":"computer_unavailable"}),
    }
}
pub(super) async fn search(State(state): State<RelayState>, Query(p): Query<Params>) -> Response {
    if !p.valid() {
        return (StatusCode::BAD_REQUEST, "Invalid chat query").into_response();
    }
    let mut computers = Vec::new();
    if p.host.as_deref().is_none_or(|h| h == "local") {
        let mut v = local_async(p.clone(), None).await;
        v["host"] = json!("local");
        v["name"] = json!(if let Some(mesh) = &state.mesh {
            mesh.computer_name()
                .await
                .unwrap_or_else(|| "This computer".into())
        } else {
            "This computer".into()
        });
        computers.push(v);
    }
    if let Some(mesh) = &state.mesh {
        let peers = mesh.hosts();
        let mut requests = futures_util::stream::iter(
            peers
                .into_iter()
                .filter(|h| p.host.as_ref().is_none_or(|id| id == &h.config.id))
                .map(|h| {
                    let p = p.clone();
                    async move {
                        let mut v = remote(&h, &p, None).await;
                        v["host"] = json!(h.config.id);
                        v["name"] = json!(h.config.name);
                        v
                    }
                }),
        )
        .buffer_unordered(4);
        while let Some(v) = requests.next().await {
            computers.push(v);
        }
    }
    if computers.is_empty() {
        return (StatusCode::NOT_FOUND, "Unknown computer").into_response();
    }
    Json(json!({"computers":computers,"limit_per_source":p.limit()})).into_response()
}
pub(super) async fn read(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Query(p): Query<Params>,
) -> Response {
    if !p.valid() || !valid_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut result = if let Some(host) = p.host.as_deref().filter(|h| *h != "local") {
        let Some(h) = state.mesh.as_ref().and_then(|m| m.host(host)) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        remote(&h, &p, Some(&id)).await
    } else {
        local_async(p, Some(id)).await
    };
    if result.get("error").is_some() || result["partial"] == true {
        let outcome = if result.get("error").is_some() {
            "failed"
        } else {
            "partial"
        };
        let reason = result["error"]
            .as_str()
            .filter(|reason| {
                matches!(
                    *reason,
                    "unreadable"
                        | "not_found"
                        | "discovery_incomplete"
                        | "computer_unavailable"
                        | "invalid_peer_response"
                        | "unsupported_peer_version"
                        | "history_reader_failed"
                        | "unsupported_storage"
                )
            })
            .unwrap_or(outcome);
        let partial_reasons = result["partial_reasons"]
            .as_array()
            .map(|reasons| {
                reasons
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|reason| {
                        matches!(
                            *reason,
                            "file_limit" | "record_limit" | "malformed_record" | "message_limit"
                        )
                    })
                    .take(4)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        logs::record(
            "Conversation",
            &format!("History load {outcome}: {reason}; reasons={partial_reasons}"),
        );
    }
    result["stream"] = json!(true);
    Json(result).into_response()
}

pub(super) async fn context_count(id: &str) -> Result<usize, Error> {
    if !valid_id(id) {
        return Err((StatusCode::BAD_REQUEST, "Invalid source conversation"));
    }
    let page = local_async(
        Params {
            limit: Some(1),
            tail: true,
            ..Params::default()
        },
        Some(id.into()),
    )
    .await;
    page["message_count"]
        .as_u64()
        .and_then(|count| usize::try_from(count).ok())
        .ok_or((
            StatusCode::CONFLICT,
            "Cannot verify the source history before switching models",
        ))
}

/// One browser connection follows the selected transcript. The owning computer's
/// index makes idle checks metadata-only and reads only appended records on change.
pub(super) async fn stream(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Query(p): Query<Params>,
) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    if !p.valid() || !valid_id(&id) || p.before.is_some() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let host = match p.host.as_deref().filter(|host| *host != "local") {
        Some(host) => match state.mesh.as_ref().and_then(|mesh| mesh.host(host)) {
            Some(host) => Some(host),
            None => return StatusCode::NOT_FOUND.into_response(),
        },
        None => None,
    };
    let updates = futures_util::stream::unfold(
        (p, id, host, None::<Value>, false),
        |(mut p, id, host, previous, wait)| async move {
            if wait {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            let page = match &host {
                Some(host) => remote(host, &p, Some(&id)).await,
                None => local_async(p.clone(), Some(id.clone())).await,
            };
            let event = if previous.as_ref() == Some(&page) {
                Event::default().comment("following")
            } else {
                Event::default().event("page").json_data(&page).unwrap()
            };
            if let (Some(start), Some(messages)) =
                (page["start_cursor"].as_u64(), page["messages"].as_array())
            {
                p.tail = false;
                p.cursor = start as usize + messages.len().saturating_sub(1);
            }
            Some((
                Ok::<_, std::convert::Infallible>(event),
                (p, id, host, Some(page), true),
            ))
        },
    );
    let mut response = Sse::new(updates)
        .keep_alive(KeepAlive::default())
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}
fn valid_id(id: &str) -> bool {
    id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
pub(in crate::switchboard_relay) async fn gateway(request: Request) -> Response {
    if request.method() != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Ok(Query(p)) = Query::<Params>::try_from_uri(request.uri()) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let id = request
        .uri()
        .path()
        .trim_start_matches("/switchboard/chats/");
    if !p.valid() || !valid_id(id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    Json(
        local_async(
            p,
            if id == "search" {
                None
            } else {
                Some(id.into())
            },
        )
        .await,
    )
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn switchboard_chats_drop_claude_image_placeholders_beside_their_images() {
        // Captured from Claude Code 2.1.319 after Conversation attached a screenshot.
        assert_eq!(
            without_image_placeholders("[Image #3]and images should render? \nAttached files:")
                .as_deref(),
            Some("and images should render?")
        );
        assert_eq!(
            without_image_placeholders("See [Image #1] and [Image #12]\n\nAttached images:\n")
                .as_deref(),
            Some("See  and")
        );
        // An image-only message keeps nothing but its image.
        assert_eq!(
            without_image_placeholders("[Image #1]\nAttached files:").as_deref(),
            Some("")
        );
        assert_eq!(without_image_placeholders("Plain [Image #x] text"), None);
        assert_eq!(without_image_placeholders("No placeholders"), None);
    }
    #[test]
    fn switchboard_chats_long_composer_messages_have_bounded_receipts() {
        let upload = "/home/fixture/.local/share/switchboard/attachments/11111111-2222-4333-8444-555555555555/photo.png";
        let text = format!("{}\n\nAttached files:\n{upload}", "a".repeat(4500));
        let chat = Chat {
            messages: vec![
                json!({"role":"user","text":text}),
                json!({"role":"assistant","text":"a".repeat(4500)}),
                json!({"role":"user","text":"a".repeat(16001)}),
            ],
            ..Chat::default()
        };
        let page = read_page(
            &chat,
            &Params {
                limit: Some(3),
                ..Params::default()
            },
        );
        assert_eq!(
            page["messages"][0]["text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            4000
        );
        assert_eq!(page["messages"][0]["receipt_text"], text);
        assert_eq!(page["messages"][0]["attachments"][0]["name"], "photo.png");
        assert!(page["messages"][1].get("receipt_text").is_none());
        assert!(page["messages"][2].get("receipt_text").is_none());
    }

    #[test]
    fn switchboard_chats_report_claude_usage_with_subagents_and_appended_responses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let reply = |id: &str, text: &str, output: u64| {
            format!(
                "{}\n",
                json!({"type":"assistant","sessionId":"s","timestamp":"2026-11-08T00:00:00Z",
                    "message":{"id":id,"model":"claude-sonnet-4-6","role":"assistant",
                        "content":[{"type":"text","text":text}],
                        "usage":{"input_tokens":1_000_000,"output_tokens":output}}})
            )
        };
        fs::write(&path, reply("msg_1", "One", 0).repeat(2)).unwrap();
        let mut index = HistoryIndex::new("claude", dir.path(), &path);
        let params = Params {
            tail: true,
            ..Params::default()
        };
        let page = index.page(&params).unwrap();
        assert_eq!(page["usage"]["responses"], 1);
        assert_eq!(page["usage"]["cost_usd"], 3.0);

        let subagents = dir.path().join("session/subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(subagents.join("agent-a.jsonl"), reply("msg_2", "Sub", 0)).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(reply("msg_3", "Two", 1_000_000).as_bytes())
            .unwrap();
        index.subagents_checked = None;
        let page = index.page(&params).unwrap();
        assert_eq!(page["usage"]["responses"], 3);
        assert_eq!(page["usage"]["cost_usd"], 24.0);
        assert_eq!(page["usage"]["output_tokens"], 1_000_000);
    }

    #[test]
    fn switchboard_chats_keep_model_and_effort_with_each_turn_and_live_page() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("models.jsonl");
        let context = |model: &str, effort: Value| json!({"type":"turn_context","payload":{"model":model,"effort":effort}});
        let reply = |text: &str| json!({"type":"event_msg","payload":{"type":"agent_message","message":text}});
        let records = [
            context("gpt-6.1-sol", json!("medium")),
            reply("First answer"),
            context("gpt-6-astra", json!("high")),
            reply("Second answer"),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(|record| format!("{record}\n"))
                .collect::<String>(),
        )
        .unwrap();
        let mut index = HistoryIndex::new("codex", dir.path(), &path);
        let params = Params {
            tail: true,
            limit: Some(1),
            ..Params::default()
        };
        let latest = index.page(&params).unwrap();
        assert_eq!(latest["model"], "gpt-6-astra");
        assert_eq!(latest["reasoning_effort"], "high");
        assert_eq!(latest["messages"][0]["model"], "gpt-6-astra");
        assert_eq!(latest["messages"][0]["reasoning_effort"], "high");
        let older = index
            .page(&Params {
                before: Some(1),
                ..params.clone()
            })
            .unwrap();
        assert_eq!(
            older["model"], "gpt-6-astra",
            "Reading old history must not change the current model"
        );
        assert_eq!(older["messages"][0]["model"], "gpt-6.1-sol");
        assert_eq!(older["messages"][0]["reasoning_effort"], "medium");
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", context("gpt-6.1-sol", Value::Null)).unwrap();
        let changed = index.page(&params).unwrap();
        assert_eq!(changed["model"], "gpt-6.1-sol");
        assert!(
            changed["reasoning_effort"].is_null(),
            "Do not reuse an effort that was not reported for the new turn"
        );
        assert_eq!(changed["messages"][0]["model"], "gpt-6-astra");
        assert_eq!(changed["messages"][0]["reasoning_effort"], "high");
        drop(file);
        fs::write(&path, format!("{}\n", reply("Replaced history"))).unwrap();
        let replaced = index.page(&params).unwrap();
        assert!(replaced["model"].is_null());
        assert!(replaced["messages"][0]["model"].is_null());
        let mut claude = Chat {
            agent: "claude".into(),
            ..Chat::default()
        };
        claude.record(&json!({"type":"assistant","message":{"model":"claude-opus-4-6","content":"Claude reply"}}), 0);
        assert_eq!(claude.summary()["model"], "claude-opus-4-6");
        assert_eq!(claude.messages[0]["model"], "claude-opus-4-6");
        assert!(claude.summary()["reasoning_effort"].is_null());
        claude.record(&json!({"type":"assistant","effort":"high","perTurnEffort":"high","message":{"model":"claude-opus-5-5","content":"Effort reply"}}), 0);
        assert_eq!(claude.summary()["model"], "claude-opus-5-5");
        assert_eq!(claude.summary()["reasoning_effort"], "high");
        assert_eq!(claude.messages[1]["reasoning_effort"], "high");
        claude.record(
            &json!({"type":"assistant","message":{"model":"<synthetic>","content":"API error"}}),
            0,
        );
        assert_eq!(
            claude.summary()["reasoning_effort"],
            "high",
            "A synthetic message keeps the turn's effort"
        );
    }

    #[test]
    fn switchboard_chats_display_uploaded_files_without_changing_delivery_text() {
        let windows = r"C:\Users\fixture\.local/share/switchboard/attachments\11111111-2222-4333-8444-555555555555\image.png";
        let unix = "/home/fixture/.local/share/switchboard/attachments/11111111-2222-4333-8444-555555555555/notes.txt";
        let text = format!("Check **this screenshot**.\n\nAttached files:\n{windows}\n{unix}");
        let chat = Chat {
            messages: vec![json!({"role":"user","text":text})],
            ..Chat::default()
        };
        let page = read_page(&chat, &Params::default());
        let message = &page["messages"][0];
        assert_eq!(
            message["text"], text,
            "The outgoing receipt matches the original payload"
        );
        assert_eq!(
            message["attachments"][0],
            json!({"kind":"image","name":"image.png","url":windows})
        );
        assert_eq!(message["attachments"][1]["kind"], "file");
        assert_eq!(
            message["markdown"],
            json!(markdown_events("Check **this screenshot**."))
        );
        let only = uploaded_attachments(&format!("\n\nAttached files:\n{windows}")).unwrap();
        let (body, images) =
            uploaded_attachments(&format!("look\n\nAttached images:\n{unix}")).unwrap();
        assert_eq!(
            (body.as_str(), images[0]["kind"].as_str()),
            ("look", Some("file"))
        );
        assert!(uploaded_attachments(&format!("Attached images:\n{unix}")).is_some());
        assert_eq!(only.0, "");
        assert_eq!(only.1.len(), 1);
        assert!(uploaded_attachments(&format!("Attached files:\r\n{windows}\r\n")).is_some());
        let duplicate = Chat {
            messages: vec![
                json!({"role":"user","text":format!("Photo\n\nAttached files:\n{windows}"),"attachments":[{"kind":"image","name":"image.png","url":windows.replace('\\',"/")}]}),
            ],
            ..Chat::default()
        };
        assert_eq!(
            read_page(&duplicate, &Params::default())["messages"][0]["attachments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        for invalid in [
            "/repo/image.png".into(),
            windows.replace("11111111-2222-4333-8444-555555555555", "not-an-upload"),
            format!("{windows}\nnot a file"),
            std::iter::repeat_n(windows, 9)
                .collect::<Vec<_>>()
                .join("\n"),
        ] {
            assert!(
                uploaded_attachments(&format!("Message\n\nAttached files:\n{invalid}")).is_none()
            );
        }
        let assistant = Chat {
            messages: vec![json!({"role":"assistant","text":text})],
            ..Chat::default()
        };
        let message = &read_page(&assistant, &Params::default())["messages"][0];
        assert!(message["attachments"].is_null());
        assert!(message["markdown"].to_string().contains("Attached files:"));
        // Claude turned the image into an image block and left a placeholder; the
        // text file stays an uploaded path. Only the caption shows; text stays raw.
        let image = json!({"kind":"image","name":"Attachment","url":"data:image/png;base64,AA=="});
        let mixed = Chat {
            messages: vec![
                json!({"role":"user","text":format!("[Image #2]Check this\n\nAttached files:\n{unix}"),"attachments":[image]}),
                json!({"role":"user","text":"[Image #1]\nAttached files:","attachments":[image]}),
            ],
            ..Chat::default()
        };
        let page = read_page(&mixed, &Params::default());
        assert_eq!(
            page["messages"][0]["markdown"],
            json!(markdown_events("Check this"))
        );
        assert_eq!(
            page["messages"][0]["attachments"].as_array().unwrap().len(),
            2
        );
        assert_eq!(page["messages"][1]["markdown"], json!(markdown_events("")));
        assert_eq!(page["messages"][1]["text"], "[Image #1]\nAttached files:");
    }

    #[test]
    fn switchboard_chats_index_reads_beyond_file_and_message_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("long.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_meta","payload":{"id":"native-thread","cwd":"/repo"}})
        )
        .unwrap();
        for i in 0..50_002 {
            writeln!(file, "{}", json!({"type":"event_msg","payload":{"type":"user_message","message":format!("Message {i}")}})).unwrap();
        }
        // A sparse, oversized tool record crosses the old 64 MiB cutoff without
        // allocating that much RAM. Valid messages on both sides remain pageable.
        file.set_len(FILE_BYTES + 128).unwrap();
        file.seek(SeekFrom::End(0)).unwrap();
        writeln!(
            file,
            "\n{}",
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Newest reply"}})
        )
        .unwrap();
        drop(file);
        let mut index = HistoryIndex::new("codex", dir.path(), &path);
        let tail = index
            .page(&Params {
                tail: true,
                limit: Some(2),
                ..Params::default()
            })
            .unwrap();
        assert_eq!(tail["start_cursor"], 50_001);
        assert_eq!(tail["messages"][1]["text"], "Newest reply");
        assert_eq!(tail["session_id"], "native-thread");
        assert_eq!(tail["partial_reasons"], json!(["record_limit"]));
        let first = index
            .page(&Params {
                limit: Some(1),
                ..Params::default()
            })
            .unwrap();
        assert_eq!(first["messages"][0]["text"], "Message 0");
        let older = index
            .page(&Params {
                before: Some(50_001),
                limit: Some(1),
                ..Params::default()
            })
            .unwrap();
        assert_eq!(older["messages"][0]["text"], "Message 50000");
        let offset = index.offset;
        assert_eq!(
            index
                .page(&Params {
                    cursor: 50_002,
                    ..Params::default()
                })
                .unwrap()["messages"][0]["text"],
            "Newest reply"
        );
        assert_eq!(index.offset, offset);
    }

    #[test]
    fn switchboard_chats_mark_claude_text_before_a_tool_call_as_commentary() {
        let text =
            |t: &str| json!({"type":"assistant","message":{"content":[{"type":"text","text":t}]}});
        let tool =
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","input":{}}]}});
        let records = vec![
            json!({"type":"user","message":{"content":"question"}}),
            tool.clone(),
            text("Checking the logs."),
            tool.clone(),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"out"}]}}),
            text("Found it."),
        ];
        let phases = |messages: &Value| {
            messages
                .as_array()
                .unwrap()
                .iter()
                .map(|m| m["phase"].as_str().unwrap_or("").to_owned())
                .collect::<Vec<_>>()
        };
        let expected = ["", "commentary", ""];
        let c = chat("claude", records.clone());
        assert_eq!(phases(&json!(c.messages)), expected);
        // The live index sees each record separately and must agree.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.jsonl");
        let lines = |records: &[Value]| {
            records
                .iter()
                .map(|r| r.to_string() + "\n")
                .collect::<String>()
        };
        fs::write(&path, lines(&records[..3])).unwrap();
        let mut index = HistoryIndex::new("claude", dir.path(), &path);
        let params = Params {
            tail: true,
            limit: Some(50),
            ..Params::default()
        };
        assert_eq!(phases(&index.page(&params).unwrap()["messages"]), ["", ""]);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{}", lines(&records[3..])).unwrap();
        assert_eq!(phases(&index.page(&params).unwrap()["messages"]), expected);
    }

    /// Reads `records` whole and as live appends, checks both agree, and returns the page.
    fn tool_page(agent: &str, records: &[Value]) -> Value {
        let tail = Params {
            tail: true,
            limit: Some(50),
            ..Params::default()
        };
        let whole = read_page(&chat(agent, records.to_vec()), &tail);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        let mut index = HistoryIndex::new(agent, dir.path(), &path);
        for record in records {
            writeln!(file, "{record}").unwrap();
            index.page(&tail).unwrap();
        }
        let live = index.page(&tail).unwrap();
        assert_eq!(live["messages"], whole["messages"]);
        assert_eq!(live["message_count"], whole["message_count"]);
        // Cursors index the same list, tool steps included.
        let page = index
            .page(&Params {
                cursor: 2,
                limit: Some(2),
                ..Params::default()
            })
            .unwrap();
        assert_eq!(page["start_cursor"], 2);
        assert_eq!(page["next_cursor"], 4);
        assert_eq!(page["messages"][0], whole["messages"][2]);
        whole
    }
    fn steps(page: &Value) -> Vec<(String, String, String)> {
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let field = |key: &str| m[key].as_str().unwrap_or_default().to_owned();
                (field("phase"), field("tool"), field("text"))
            })
            .collect()
    }
    fn assert_hidden(page: &Value, secrets: &[&str]) {
        let json = page.to_string();
        for secret in secrets {
            assert!(!json.contains(secret), "{secret} leaked: {json}");
        }
    }

    #[test]
    fn switchboard_chats_show_claude_tool_calls_as_steps_without_contents() {
        let call = |name: &str, input: Value| json!({"type":"assistant","cwd":"/repo","timestamp":"2026-11-08T10:00:00Z","message":{"content":[{"type":"tool_use","id":"t","name":name,"input":input}]}});
        let text = |t: &str| json!({"type":"assistant","cwd":"/repo","message":{"content":[{"type":"text","text":t}]}});
        let records = [
            json!({"type":"user","cwd":"/repo","message":{"content":"question"}}),
            text("Checking."),
            call(
                "Bash",
                json!({"command":"API_TOKEN=abc123 cargo test -p zellij-client\necho done","description":"Run tests"}),
            ),
            json!({"type":"user","cwd":"/repo","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"SECRET OUTPUT"}]}}),
            call("Read", json!({"file_path":"/repo/src/main.rs"})),
            call(
                "Edit",
                json!({"file_path":"/repo/src/lib.rs","old_string":"OLD BODY","new_string":"NEW BODY"}),
            ),
            call(
                "Write",
                json!({"file_path":"/elsewhere/new.rs","content":"FILE CONTENT"}),
            ),
            call("Grep", json!({"pattern":"fn main","path":"/repo"})),
            call(
                "WebFetch",
                json!({"url":"https://user:hunter2@example.com/x?token=t0k&page=2","prompt":"FETCH PROMPT"}),
            ),
            call(
                "Agent",
                json!({"description":"Find relay code","prompt":"AGENT PROMPT"}),
            ),
            call("TodoWrite", json!({"todos":[{"content":"TODO BODY"}]})),
            call("mcp__github__create_issue", json!({"body":"MCP ARGUMENT"})),
            text("Done."),
        ];
        let page = tool_page("claude", &records);
        let step = |tool: &str, text: &str| ("commentary".into(), tool.into(), text.into());
        assert_eq!(
            steps(&page),
            [
                ("".into(), "".into(), "question".into()),
                step("", "Checking."),
                step("run", "Ran API_TOKEN=*** cargo test -p zellij-client …"),
                step("read", "Read src/main.rs"),
                step("edit", "Edited src/lib.rs"),
                step("write", "Wrote /elsewhere/new.rs"),
                step("search", "Searched fn main"),
                step(
                    "fetch",
                    "Fetched https://***@example.com/x?token=***&page=2"
                ),
                step("agent", "Delegated Find relay code"),
                step("plan", "Updated the plan"),
                step("tool", "Used github create_issue"),
                ("".into(), "".into(), "Done.".into()),
            ]
        );
        let bash = &page["messages"][2];
        assert_eq!(bash["kind"], "tool");
        assert_eq!(
            bash["detail"],
            "API_TOKEN=*** cargo test -p zellij-client …"
        );
        // Older browsers render the step from markdown: a quiet note with the detail as code.
        assert_eq!(bash["markdown"][1]["text"], "Ran ");
        assert_eq!(bash["markdown"][2]["type"], "code");
        assert!(page["messages"][1].get("kind").is_none());
        assert_hidden(
            &page,
            &[
                "abc123",
                "echo done",
                "SECRET OUTPUT",
                "OLD BODY",
                "NEW BODY",
                "FILE CONTENT",
                "hunter2",
                "t0k",
                "FETCH PROMPT",
                "AGENT PROMPT",
                "TODO BODY",
                "MCP ARGUMENT",
                "Run tests",
            ],
        );
        // Search matches what was said, not what was run.
        let mut results = Vec::new();
        let params = Params {
            q: "cargo test".into(),
            ..Params::default()
        };
        add_result(&chat("claude", records.to_vec()), &params, &mut results);
        assert!(results.is_empty());
    }

    #[test]
    fn switchboard_chats_show_codex_tool_calls_as_steps_without_outputs() {
        let item = |payload: Value| json!({"type":"response_item","timestamp":"2026-11-08T10:00:00Z","payload":payload});
        let function = |name: &str, arguments: Value| {
            item(
                json!({"type":"function_call","name":name,"arguments":arguments.to_string(),"call_id":"c"}),
            )
        };
        let patch = "*** Begin Patch\n*** Update File: C:\\repo\\src\\a.rs\n@@\n-OLD LINE\n+NEW LINE\n*** Add File: C:\\repo\\b.rs\n+ADDED BODY\n*** End Patch";
        let code = "const r=await Promise.allSettled([tools.exec_command({cmd:\"cargo test --lib\",workdir:\"C:\\\\repo\"}),tools.exec_command({cmd:\"git diff\"})]);text(r);";
        let records = [
            json!({"type":"session_meta","payload":{"id":"x1","cwd":"C:\\repo"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"question"}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"Looking."}}),
            function(
                "shell_command",
                json!({"command":"git status --short","workdir":"C:\\repo"}),
            ),
            item(json!({"type":"function_call_output","call_id":"c","output":"TOOL OUTPUT"})),
            function("shell", json!({"command":["bash","-lc","ls -la"]})),
            function(
                "exec_command",
                json!({"cmd":"rg -n needle","max_output_tokens":6000}),
            ),
            item(
                json!({"type":"custom_tool_call","name":"apply_patch","input":patch,"call_id":"p"}),
            ),
            item(json!({"type":"custom_tool_call_output","call_id":"p","output":"PATCH OUTPUT"})),
            item(json!({"type":"custom_tool_call","name":"exec","input":code,"call_id":"e"})),
            function(
                "update_plan",
                json!({"plan":[{"step":"PLAN BODY","status":"pending"}]}),
            ),
            item(
                json!({"type":"function_call","name":"read_memory","namespace":"mcp__cheatengine__","arguments":"{\"address\":\"ADDRESS ARG\"}","call_id":"m"}),
            ),
            item(
                json!({"type":"web_search_call","status":"completed","action":{"type":"search","query":"zellij docs"}}),
            ),
            item(
                json!({"type":"local_shell_call","action":{"type":"exec","command":["git","log","-1"]}}),
            ),
            function(
                "spawn_agent",
                json!({"agent_type":"explorer","message":"DELEGATED PROMPT"}),
            ),
            function(
                "spawn_agent",
                json!({"task_name":"Audit the relay","message":"DELEGATED PROMPT"}),
            ),
            item(
                json!({"type":"reasoning","summary":[{"type":"summary_text","text":"SECRET REASONING"}]}),
            ),
            json!({"type":"event_msg","payload":{"type":"agent_message","phase":"final_answer","message":"Done."}}),
        ];
        let page = tool_page("codex", &records);
        let step = |tool: &str, text: &str| ("commentary".into(), tool.into(), text.into());
        assert_eq!(
            steps(&page),
            [
                ("".into(), "".into(), "question".into()),
                step("", "Looking."),
                step("run", "Ran git status --short"),
                step("run", "Ran ls -la"),
                step("run", "Ran rg -n needle"),
                step("edit", "Edited src\\a.rs (+1 more)"),
                step("run", "Ran cargo test --lib (+1 more)"),
                step("plan", "Updated the plan"),
                step("tool", "Used cheatengine read_memory"),
                step("search", "Searched zellij docs"),
                step("run", "Ran git log -1"),
                step("agent", "Delegated a task"),
                step("agent", "Delegated Audit the relay"),
                ("".into(), "".into(), "Done.".into()),
            ]
        );
        assert_hidden(
            &page,
            &[
                "TOOL OUTPUT",
                "OLD LINE",
                "NEW LINE",
                "ADDED BODY",
                "PATCH OUTPUT",
                "PLAN BODY",
                "ADDRESS ARG",
                "SECRET REASONING",
                "Begin Patch",
                "DELEGATED PROMPT",
            ],
        );
    }

    #[test]
    fn switchboard_chats_redact_credentials_in_tool_steps() {
        for (command, expected) in [
            (
                "export GITHUB_TOKEN=ghp_x && gh pr list",
                "export GITHUB_TOKEN=*** && gh pr list",
            ),
            (
                "$env:OPENAI_API_KEY = \"sk-live value\"; codex",
                "$env:OPENAI_API_KEY = ***; codex",
            ),
            (
                "mysql --password hunter2 -u root",
                "mysql --password *** -u root",
            ),
            (
                "curl -H 'Authorization: Bearer abc.def.ghi' https://x",
                "curl -H 'Authorization: ***' https://x",
            ),
            (
                "curl -H \"X-Api-Key: k123\" https://x",
                "curl -H \"X-Api-Key: ***\" https://x",
            ),
            (
                "git push https://dom:pat123@github.com/a/b",
                "git push https://***@github.com/a/b",
            ),
            ("echo ghp_abcdefghijklmnopqrstuvwxyz0123", "echo ***"),
            (
                "cd $PWD && zellij --session main",
                "cd $PWD && zellij --session main",
            ),
            (
                "curl -H \"api-key: private-value\" https://x",
                "curl -H \"api-key: ***\" https://x",
            ),
            (
                "curl --data '{\"user\":\"dom\",\"password\":\"private-value\"}' https://x",
                "curl --data '{\"user\":\"dom\",\"password\":\"***\"}' https://x",
            ),
            (
                "curl -d \"{\\\"client_secret\\\": \\\"private-value\\\"}\" https://x",
                "curl -d \"{\\\"client_secret\\\": \"***\"}\" https://x",
            ),
            (
                "curl --data '{\"authorization\":\"private-value\"}' https://x",
                "curl --data '{\"authorization\":\"***\"}' https://x",
            ),
            (
                "curl -d \"{\\\"Auth_Token\\\":\\\"private-value\\\"}\" https://x",
                "curl -d \"{\\\"Auth_Token\\\":\"***\"}\" https://x",
            ),
            (
                "curl --data 'grant=pw&password=private-value' https://x",
                "curl --data 'grant=pw&password=***' https://x",
            ),
        ] {
            assert_eq!(one_line(command), expected);
        }
        assert_eq!(one_line(&"a".repeat(200)).chars().count(), 120);
    }

    #[test]
    fn switchboard_chats_read_code_mode_commands_only_from_exec_calls() {
        // A patch body or a comment can look like a command; neither is one.
        let patch = "await tools.apply_patch(`*** Begin Patch\n+const job = {cmd: \"PRIVATE FILE BODY\"};\n+tools.exec_command({cmd:\"HIDDEN\"});\n*** End Patch`);";
        assert_eq!(code_mode(patch), ("tool", "apply_patch".into()));
        let code = "// tools.exec_command({cmd:\"COMMENTED\"})\nconst note='{cmd: \"QUOTED\"}';\ntext(await tools.exec_command({cmd:\"git status\",workdir:\"C:\\\\repo\"}));";
        assert_eq!(code_mode(code), ("run", "git status".into()));
        // A command that is not the call's first field falls back to the tool name.
        let late = "await tools.exec_command({workdir:\"/repo\",cmd:\"cargo test\"});";
        assert_eq!(code_mode(late), ("tool", "exec_command".into()));
    }

    #[test]
    fn switchboard_chats_name_claude_background_agents_until_they_finish() {
        // Claude Code 2.1.319 records, trimmed.
        let launch = |call: &str, agent: &str, description: &str| {
            json!({"type":"user","timestamp":"2026-11-07T22:16:38.546Z",
                "toolUseResult":{"isAsync":true,"status":"async_launched","agentId":agent,"description":description,"resolvedModel":"claude-opus-5-5"},
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":call,"content":"Async agent launched successfully."}]}})
        };
        let notice = |call: &str, agent: &str| {
            format!("<task-notification>\n<task-id>{agent}</task-id>\n<tool-use-id>{call}</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<result>Uses <b>tags</b></result>\n</task-notification>")
        };
        let queued = |call: &str, agent: &str| json!({"type":"queue-operation","operation":"enqueue","content":notice(call, agent)});
        let delivered = |call: &str, agent: &str| {
            json!({"type":"user","origin":{"kind":"task-notification","producer":"session-task"},
                "message":{"role":"user","content":notice(call, agent)}})
        };
        let stop = |agent: &str| json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"TaskStop","input":{"task_id":agent}}]}});
        let start = |how: &str| json!({"type":"attachment","attachment":{"type":"hook_success","hookName":format!("SessionStart:{how}"),"hookEvent":"SessionStart"}});
        let names = |records: Vec<Value>| -> Vec<String> {
            chat("claude", records).summary()["background_agents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["description"].as_str().unwrap().to_owned())
                .collect()
        };
        let (one, two) = (
            launch("toolu_1", "a1", "Review the diff"),
            launch("toolu_2", "a2", "Run the e2e suite"),
        );
        assert_eq!(
            names(vec![one.clone(), one.clone(), two.clone()]),
            ["Review the diff", "Run the e2e suite"],
            "A repeated launch record is one agent"
        );
        assert_eq!(
            names(vec![one.clone(), two.clone(), queued("toolu_1", "a1")]),
            ["Run the e2e suite"]
        );
        assert_eq!(
            names(vec![one.clone(), two.clone(), delivered("toolu_2", "a2")]),
            ["Review the diff"]
        );
        assert_eq!(
            names(vec![one.clone(), two.clone(), stop("a1")]),
            ["Run the e2e suite"]
        );
        assert_eq!(
            names(vec![one.clone(), start("compact")]),
            ["Review the diff"],
            "Compaction keeps background agents running"
        );
        assert!(names(vec![one.clone(), two.clone(), start("resume")]).is_empty());
        assert_eq!(
            chat("claude", vec![one.clone()]).summary()["background_agents"][0]["model"],
            "claude-opus-5-5"
        );
        // A background shell's notification names no agent.
        assert_eq!(
            names(vec![one, queued("toolu_9", "b9")]),
            ["Review the diff"]
        );
    }

    #[test]
    fn switchboard_chats_exclude_claude_system_task_notifications() {
        // Claude Code 2.1.319 emits this as a user record without isMeta.
        let notification = json!({
            "type":"user", "version":"2.1.319", "userType":"external",
            "origin":{"kind":"task-notification","producer":"session-task"},
            "promptSource":"system", "turnOrigin":"task_notification",
            "message":{"role":"user","content":concat!(
                "<task-notification>\n<task-id>bvq2ldvi9</task-id>\n",
                "<tool-use-id>toolu_01KsyYBwFC6SG5fbyNcf8mJc</tool-use-id>\n",
                "<output-file>C:\\Temp\\claude\\tasks\\bvq2ldvi9.output</output-file>\n",
                "<status>completed</status>\n",
                "<summary>Background command \"Build dev-opt binary with hidden attach\" completed (exit code 0)</summary>\n",
                "</task-notification>"
            )}
        });
        // A human can paste the same XML, including when reporting a parser bug.
        let mut human = notification.clone();
        human["origin"] = json!({"kind":"human"});
        human["promptSource"] = json!("typed");
        human["turnOrigin"] = json!("human");
        let legacy = json!({"type":"user","message":{"content":"Measure the change"}});
        let summary = json!({"type":"user","isVisibleInTranscriptOnly":true,"isCompactSummary":true,
            "message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context."}});
        let progress = json!({"type":"assistant","message":{"content":[{"type":"text","text":"Waiting for the dev-opt build."}]}});
        let answer = json!({"type":"assistant","message":{"content":[{"type":"text","text":"Build finished."}]}});
        let records = vec![
            notification.clone(),
            legacy,
            progress,
            summary,
            notification,
            human,
            answer,
        ];
        let c = chat("claude", records.clone());
        assert_eq!(c.messages.len(), 4);
        assert_eq!(c.title, "Measure the change");
        assert_eq!(c.messages[2]["text"], records[5]["message"]["content"]);

        // Live appends and paged reads must use the same filtering and cursors.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        let mut index = HistoryIndex::new("claude", dir.path(), &path);
        let params = Params {
            tail: true,
            limit: Some(50),
            ..Params::default()
        };
        let mut expected = 0;
        for record in records {
            writeln!(file, "{record}").unwrap();
            expected += chat("claude", vec![record]).messages.len();
            assert_eq!(index.page(&params).unwrap()["message_count"], expected);
        }
        let first = index
            .page(&Params {
                limit: Some(2),
                ..Params::default()
            })
            .unwrap();
        let second = index
            .page(&Params {
                cursor: 2,
                limit: Some(2),
                ..Params::default()
            })
            .unwrap();
        assert_eq!(first["next_cursor"], 2);
        assert_eq!(second["next_cursor"], Value::Null);
        let page = read_page(&c, &Params::default());
        let messages = page["messages"].as_array().unwrap();
        assert_eq!(first["messages"], json!(&messages[..2]));
        assert_eq!(second["messages"], json!(&messages[2..]));
    }

    #[test]
    fn switchboard_chats_show_only_what_the_human_typed() {
        // Shapes copied from Claude Code 2.1.x and Codex transcripts; None means hidden.
        let claude = |content: Value, source: Value| json!({"type":"user","promptSource":source,"message":{"role":"user","content":content}});
        let text = |t: &str| json!([{"type":"text","text":t}]);
        let pasted =
            "<command-name>/model</command-name>\n<command-message>model</command-message>";
        let cases = [
            (claude(text("[Request interrupted by user]"), Value::Null), None),
            (claude(text("[Request interrupted by user for tool use]"), Value::Null), None),
            (claude(json!("<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"), Value::Null), Some("/model")),
            (claude(json!("<command-message>dotfiles-skills:bro</command-message>\n<command-name>/dotfiles-skills:bro</command-name>\n<command-args>fix it</command-args>"), Value::Null), Some("/dotfiles-skills:bro fix it")),
            (claude(json!("<local-command-stdout>Set model to `Fable 5.1`</local-command-stdout>"), Value::Null), None),
            (claude(json!("<bash-input>ssh-copy-id danny@danny-pc.local</bash-input>"), Value::Null), Some("!ssh-copy-id danny@danny-pc.local")),
            (claude(json!("<bash-stdout></bash-stdout><bash-stderr>ERROR: Host key verification failed.</bash-stderr>"), Value::Null), None),
            // Typed and programmatic (`claude -p`, T3 Code) prompts show as written.
            (claude(json!(pasted), json!("typed")), Some(pasted)),
            (claude(json!("reply ok"), json!("sdk")), Some("reply ok")),
            (claude(json!("Interrupted? [Request interrupted by user]"), Value::Null), Some("Interrupted? [Request interrupted by user]")),
            (claude(text("[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]"), Value::Null), None),
            // Claude Code's own provenance flags and origins.
            (json!({"type":"user","isVisibleInTranscriptOnly":true,"isCompactSummary":true,"message":{"content":"This session is being continued from a previous conversation."}}), None),
            (json!({"type":"user","isVisibleInTranscriptOnly":true,"message":{"content":"transcript only"}}), None),
            (json!({"type":"user","origin":{"kind":"coordinator"},"message":{"content":"from the coordinator"}}), None),
            (json!({"type":"user","origin":{"kind":"channel"},"message":{"content":"from a channel"}}), None),
            (json!({"type":"user","commandMode":"task-notification","message":{"content":"<task-notification>old</task-notification>"}}), None),
            (json!({"type":"user","origin":{"kind":"human"},"promptSource":"typed","message":{"content":"<task-notification>pasted</task-notification>"}}), Some("<task-notification>pasted</task-notification>")),
        ];
        for (record, expected) in &cases {
            let c = chat("claude", vec![record.clone()]);
            assert_eq!(
                c.messages.first().map(|m| m["text"].as_str().unwrap()),
                *expected,
                "{record}"
            );
        }

        // Records copied from Codex 0.167 rollouts. Only the events Codex's own history
        // reads become messages; response_item model input never does.
        let input = |t: &str| json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":t}]}});
        let legacy = |t: &str| json!({"type":"event_msg","payload":{"type":"user_message","message":t,"images":[],"local_images":[]}});
        let paginated = |content: Value| json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"t","item":{"type":"UserMessage","id":"u","content":content}}});
        let reply = "<send_user_message_question_reply>\n[{\"answer\":\"Updates waiting for viewers\",\"question\":\"Which chat?\",\"questionItemId\":\"q\"}]\n</send_user_message_question_reply>";
        let cases = [
            (input("# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nBe brief.\n</INSTRUCTIONS>"), None),
            (input("<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"), None),
            (input("typed, but this copy is model input"), None),
            (legacy("has mac updated?"), Some("has mac updated?")),
            (paginated(json!([{"type":"text","text":"why hasnt it updated yet?","text_elements":[]}])), Some("why hasnt it updated yet?")),
            (paginated(json!([{"type":"text","text":reply,"text_elements":[]}])), Some("> Which chat?\n\nUpdates waiting for viewers")),
            (paginated(json!([{"type":"text","text":"it is in [Image #1]","text_elements":[]},{"type":"local_image","path":"/tmp/a.png"}])), Some("it is in [Image #1]")),
            (json!({"type":"event_msg","payload":{"type":"user_message","message":"see this","images":["data:image/png;base64,iVBORw0KGgo="],"local_images":[]}}), Some("see this")),
            (json!({"type":"event_msg","payload":{"type":"agent_message","message":"Checking.","phase":"commentary"}}), Some("Checking.")),
            (json!({"type":"event_msg","payload":{"type":"item_completed","turn_id":"t","item":{"type":"AgentMessage","id":"a","phase":"final_answer","content":[{"type":"Text","text":"Done."}]}}}), Some("Done.")),
        ];
        for (record, expected) in &cases {
            let c = chat("codex", vec![record.clone()]);
            assert_eq!(
                c.messages.first().map(|m| m["text"].as_str().unwrap()),
                *expected,
                "{record}"
            );
        }
        assert_eq!(
            chat("codex", vec![cases[6].0.clone()]).messages[0]["attachments"][0]["url"],
            "/tmp/a.png"
        );
        assert_eq!(
            chat("codex", vec![cases[7].0.clone()]).messages[0]["attachments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let page = read_page(
            &chat("codex", vec![cases[8].0.clone(), cases[9].0.clone()]),
            &Params::default(),
        );
        assert_eq!(page["messages"][0]["phase"], "commentary");

        // A forked sub-agent keeps its own id after the parent's copied session_meta.
        let meta = |id: &str| json!({"type":"session_meta","payload":{"id":id,"cwd":"/repo"}});
        assert_eq!(
            chat("codex", vec![meta("child"), meta("parent")]).session_id,
            "child"
        );

        // Live appends and paged reads filter the same way.
        let records: Vec<_> = cases.iter().map(|(record, _)| record.clone()).collect();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.jsonl");
        let mut file = fs::File::create(&path).unwrap();
        let mut index = HistoryIndex::new("codex", dir.path(), &path);
        let tail = Params {
            tail: true,
            limit: Some(50),
            ..Params::default()
        };
        for record in &records {
            writeln!(file, "{record}").unwrap();
            index.page(&tail).unwrap();
        }
        let whole = read_page(&chat("codex", records), &tail);
        assert_eq!(index.page(&tail).unwrap()["messages"], whole["messages"]);
        assert_eq!(whole["message_count"], 7);
    }

    #[test]
    fn switchboard_chats_read_switchboard_prompt_wrappers() {
        // Each producer's wrapper must stay in step with this reader.
        let handover_js = include_str!("../../../tools/switchboard/static/handover.js");
        assert!(handover_js.contains(
            "'Read the context handover file at '+JSON.stringify(path)+' before acting. "
        ));
        assert!(handover_js.contains("\\n\\nCurrent user request:\\n'+"));
        for js in [
            include_str!("../../../tools/switchboard/static/app.js"),
            include_str!("../../../tools/switchboard/static/conversation.js"),
        ] {
            assert!(js.contains("'\\n\\nAttached files:\\n'"));
        }
        let root = "/Users/me/.local/share/switchboard/attachments";
        let handover = format!(
            "{root}/4d6b6f6e-8c4f-4f43-9a9c-31f3c1f1a2b3/switchboard-context-handover.json"
        );
        let file = format!("{root}/5d6b6f6e-8c4f-4f43-9a9c-31f3c1f1a2b3/notes.txt");
        let image = format!("{root}/6d6b6f6e-8c4f-4f43-9a9c-31f3c1f1a2b3/shot.png");
        // New tab for Claude: handover.js prompt, app.js file suffix, then the relay's image suffix.
        let prompt = format!(
            "Read the context handover file at {} before acting. It contains attributed historical messages.\n\nCurrent user request:\nKeep going\n\nAttached files:\n{file}\n\nAttached images:\n{image}",
            serde_json::to_string(&handover).unwrap()
        );
        let (body, attachments) = uploaded_attachments(&prompt).unwrap();
        assert_eq!(body, "Keep going");
        let urls: Vec<_> = attachments
            .iter()
            .map(|a| a["url"].as_str().unwrap())
            .collect();
        assert_eq!(urls, [&handover, &file, &image]);
        // A handover path outside the upload directory is left as written.
        let foreign = prompt.replace(&handover, "/tmp/switchboard-context-handover.json");
        let (body, _) = uploaded_attachments(&foreign).unwrap();
        assert!(body.starts_with("Read the context handover file at "));
    }

    #[test]
    fn switchboard_chats_index_retries_live_records_and_replaced_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live.jsonl");
        let record = |text: &str| json!({"type":"user","message":{"content":text}}).to_string();
        fs::write(&path, format!("{}\n{{\"type\":", record("First"))).unwrap();
        let mut index = HistoryIndex::new("claude", dir.path(), &path);
        let params = Params {
            tail: true,
            limit: Some(50),
            ..Params::default()
        };
        assert_eq!(
            index.page(&params).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "\"user\",\"message\":{{\"content\":\"Second\"}}}}").unwrap();
        assert_eq!(
            index.page(&params).unwrap()["messages"][1]["text"],
            "Second"
        );
        writeln!(file, "\n{}", record("Third")).unwrap();
        let page = index.page(&params).unwrap();
        assert_eq!(page["messages"].as_array().unwrap().len(), 3);
        assert_eq!(page["messages"][2]["text"], "Third");
        assert_eq!(page["partial"], false);
        drop(file);
        fs::write(&path, format!("{}\n", record("Replacement"))).unwrap();
        let page = index.page(&params).unwrap();
        assert_eq!(page["messages"].as_array().unwrap().len(), 1);
        assert_eq!(page["messages"][0]["text"], "Replacement");
    }
    fn chat(agent: &str, records: Vec<Value>) -> Chat {
        let mut c = Chat {
            agent: agent.into(),
            ..Chat::default()
        };
        for record in records {
            c.record(&record, 0);
        }
        c
    }
    #[test]
    fn switchboard_chat_hook_transcript_reads_empty_until_the_first_message() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let path = root.join("-repo/1da2fbc0-43c6-4808-beec-63e446ce3d50.jsonl");
        let id = bind_transcript("claude", root.clone(), &path).unwrap();
        let p = Params {
            tail: true,
            ..Params::default()
        };
        let empty = local(vec![("claude", root.clone())], &p, Some(&id));
        assert!(empty.get("error").is_none(), "{empty}");
        assert_eq!(empty["messages"], json!([]));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = json!({"type":"user","message":{"role":"user","content":"Fix the sidebar"}});
        fs::write(&path, format!("{record}\n")).unwrap();
        let first = local(vec![("claude", root)], &p, Some(&id));
        assert_eq!(first["messages"].as_array().unwrap().len(), 1, "{first}");
    }

    #[test]
    fn switchboard_chat_hook_uses_exact_transcript_without_search() {
        for (agent, root, file) in [
            ("codex", "/home/test/.codex", "sessions/2026/11/07/rollout-2026-11-07T00-49-23-01a1b11f-09b6-75b2-aea2-e1108e1424e1.jsonl"),
            ("claude", "/home/test/.claude/projects", "-repo/session.jsonl"),
        ] {
            let root = Path::new(root);
            let path = root.join(file);
            assert_eq!(transcript_id(agent, root, &path), Some(file_id(agent, root, &path)));
            assert_eq!(transcript_id(agent, root, &root.join("../outside.jsonl")), None);
            assert_eq!(transcript_id(agent, root, Path::new("/outside.jsonl")), None);
        }
        assert_eq!(
            transcript_id(
                "codex",
                Path::new("/codex"),
                Path::new("/codex/config.jsonl")
            ),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn switchboard_chat_windows_hook_casing_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let path = root.join("c--repo/session.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = json!({"type":"user","message":{"content":"Hello"}});
        fs::write(&path, format!("{record}\n")).unwrap();
        let hook_path = root.join("C--repo/session.jsonl");
        let id = bind_transcript("claude", root.clone(), &hook_path).unwrap();
        let params = Params::default();
        let before = local(vec![("claude", root.clone())], &params, Some(&id));
        assert_eq!(before["messages"][0]["text"], "Hello");
        assert_eq!(before["id"], id);

        // A relay restart drops the hook's in-memory path. Discovery must find
        // the same ID even when the hook used different Windows path casing.
        TRANSCRIPTS.lock().unwrap().remove(&id);
        let after = local(vec![("claude", root)], &params, Some(&id));
        assert_eq!(after["messages"][0]["text"], "Hello", "{after}");
        assert_eq!(after["id"], id);
    }

    #[test]
    fn switchboard_chats_media_parts_and_markdown_are_bounded_and_inert() {
        let c = chat(
            "claude",
            vec![
                json!({"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}}),
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"**Result** ![shot](out/shot.png) [demo](out/demo.mp4) <script>bad()</script>"},{"type":"tool_use","input":{"type":"image","source":{"url":"secret.png"}}}]}}),
            ],
        );
        assert_eq!(c.messages.len(), 2);
        let page = read_page(&c, &Params::default());
        assert_eq!(
            page["messages"][0]["attachments"][0]["url"],
            "data:image/png;base64,aGVsbG8="
        );
        assert!(page["messages"][1]["attachments"].is_null());
        let markdown = page["messages"][1]["markdown"].as_array().unwrap();
        assert!(markdown
            .iter()
            .any(|v| v["tag"] == "image" && v["url"] == "out/shot.png"));
        assert!(markdown.iter().any(|v| v["tag"] == "strong"));
        assert!(!markdown.iter().any(|v| v["tag"] == "script"));
        let c = chat(
            "codex",
            vec![
                json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[
                    {"type":"local_image","path":"C:\\work\\shot.png"},
                    {"type":"input_image","image_url":"data:image/svg+xml;base64,aGVsbG8="},
                    {"type":"input_image","image_url":"data:image/png;base64,INVALID!"}
                ]}}}),
            ],
        );
        let attachments = &c.messages[0]["attachments"];
        assert_eq!(attachments[0]["url"], "C:\\work\\shot.png");
        assert!(attachments[1]["unavailable"].is_string());
        assert!(attachments[2]["unavailable"].is_string());
        let mut c = Chat {
            agent: "claude".into(),
            embedded_bytes: 2 * 1024 * 1024,
            ..Chat::default()
        };
        c.record(&json!({"type":"user","message":{"content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}}]}}),0);
        assert!(c.messages[0]["attachments"][0]["unavailable"].is_string());
    }
    #[test]
    fn switchboard_chats_readers_exclude_tools_reasoning_and_duplicate_events() {
        let c = chat(
            "claude",
            vec![
                json!({"type":"user","sessionId":"c1","cwd":"/repo","message":{"content":"pairing question"}}),
                json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"secret reasoning"},{"type":"text","text":"answer"},{"type":"tool_use","input":{"text":"secret tool"}}]}}),
                json!({"type":"user","message":{"content":[{"type":"tool_result","content":"secret result"}]}}),
                // Claude Code 2.1.319 writes this after a pasted image, and skill bodies likewise.
                json!({"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":"[Image: source: /tmp/pasted.png]"}]}}),
            ],
        );
        assert_eq!(c.messages.len(), 2);
        assert_eq!(c.project, "/repo");
        assert_eq!(c.session_id, "c1");
        let c = chat(
            "codex",
            vec![
                json!({"type":"session_meta","payload":{"id":"x1","cwd":"/repo"}}),
                json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}}),
                json!({"type":"event_msg","payload":{"type":"user_message","message":"question"}}),
                json!({"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"answer"}}),
            ],
        );
        assert_eq!(c.messages.len(), 2);
        assert_eq!(c.session_id, "x1");
        assert_eq!(
            read_page(&c, &Params::default())["messages"][1]["phase"],
            "commentary"
        );
        let c = chat(
            "copilot",
            vec![
                json!({"type":"session.start","data":{"sessionId":"p1","context":{"cwd":"/work"}}}),
                json!({"type":"user.message","data":{"content":"question"}}),
                json!({"type":"assistant.message","data":{"content":"answer"}}),
                json!({"type":"assistant.reasoning","data":{"content":"secret"}}),
            ],
        );
        assert_eq!(c.messages.len(), 2);
        assert_eq!(c.project, "/work");
        let records = vec![
            json!({"payload_type":"runtime.session.metadata","stream":{"kind":"session","id":"m1"},"payload":{"record":{"workspace_root":"/muse"}}}),
            json!({"payload":{"kind":"run","event":{"kind":"started","prompt":"question"}}}),
            json!({"payload":{"kind":"run","event":{"kind":"assistant_message_committed","text":"answer"}}}),
        ];
        let frame = json!({"children":records.iter().map(|v|json!({"record_json":v.to_string()})).collect::<Vec<_>>()});
        let c = chat("muse", vec![frame]);
        assert_eq!(c.messages.len(), 2);
        assert_eq!(c.project, "/muse");
        assert_eq!(c.session_id, "m1");
    }
    #[test]
    fn switchboard_chats_muse_inflight_followups_are_searchable_once() {
        let delivery = json!({"recorded_at":3,"payload":{"kind":"run","event":{
            "kind":"inbox_item_drained","item_id":"input-1","delivery_snapshot":{
                "source":{"source":"user_steer"},"payload":{"prompt":"Check pairing on Windows too"}
            }
        }}});
        let mut queued = delivery.clone();
        queued["payload"]["event"]["kind"] = json!("inbox_item_queued");
        let mut peer = delivery.clone();
        peer["payload"]["event"]["item_id"] = json!("peer-1");
        peer["payload"]["event"]["delivery_snapshot"]["source"]["source"] = json!("peer_message");
        let c = chat(
            "muse",
            vec![
                json!({"payload":{"kind":"run","event":{"kind":"started","prompt":"Fix reconnect"}}}),
                json!({"payload_type":"runtime.user_intent.accepted","payload":{"refill_blocks":[{"kind":"text","text":"Check pairing on Windows too"}]}}),
                queued,
                delivery.clone(),
                delivery,
                peer,
                json!({"payload":{"kind":"run","event":{"kind":"assistant_message_committed","text":"Done"}}}),
            ],
        );
        assert_eq!(c.messages.len(), 3);
        assert_eq!(c.messages[1]["text"], "Check pairing on Windows too");
        assert_eq!(c.messages[1]["timestamp"], 3);
        let p = Params {
            q: "pairing".into(),
            ..Params::default()
        };
        let mut hits = Vec::new();
        add_result(&c, &p, &mut hits);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["message_cursor"], 1);
        assert_eq!(
            read_page(
                &c,
                &Params {
                    cursor: 1,
                    limit: Some(1),
                    ..Params::default()
                }
            )["messages"][0]["role"],
            "user"
        );
    }
    #[test]
    fn switchboard_chats_search_read_pagination_and_coverage() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..3 {
            fs::write(
                dir.path().join(format!("{n}.jsonl")),
                format!(
                    "{}\n",
                    json!({"type":"user","message":{"content":format!("pairing {n}")}})
                ),
            )
            .unwrap();
        }
        let p = Params {
            q: "PAIRING".into(),
            limit: Some(1),
            ..Params::default()
        };
        let result = local(vec![("claude", dir.path().into())], &p, None);
        assert_eq!(result["sources"][0]["results"].as_array().unwrap().len(), 1);
        assert_eq!(result["sources"][0]["next_cursor"], 1);
        let id = result["sources"][0]["results"][0]["id"].as_str().unwrap();
        let page = local(
            vec![("claude", dir.path().into())],
            &Params::default(),
            Some(id),
        );
        assert_eq!(page["messages"][0]["text"], "pairing 0");
        let next = local(
            vec![("claude", dir.path().into())],
            &Params { cursor: 1, ..p },
            None,
        );
        assert_ne!(next["sources"][0]["results"][0]["id"], id);
        fs::write(dir.path().join("broken.jsonl"), "not json\n").unwrap();
        let result = local(
            vec![("claude", dir.path().into())],
            &Params::default(),
            None,
        );
        assert_eq!(result["sources"][0]["status"], "partial");
        let result = local(
            vec![("muse", dir.path().join("absent"))],
            &Params::default(),
            None,
        );
        assert_eq!(result["sources"][0]["status"], "missing");
        assert!(!Params {
            agent: Some("invalid".into()),
            ..Params::default()
        }
        .valid());
        assert!(!Params {
            limit: Some(500),
            ..Params::default()
        }
        .valid());
        assert!(!valid_id("../../auth.json"));
    }
    #[test]
    fn switchboard_chats_unicode_and_bounded_read() {
        let expanded = format!("{}Needle{}", "İ".repeat(500), "x".repeat(1000));
        assert!(excerpt(&expanded, "needle").contains("Needle"));

        let mut c = Chat::default();
        c.push("user", format!("{}Needle", "é".repeat(5000)), Value::Null);
        c.push("assistant", "reply".into(), Value::Null);
        let page = read_page(
            &c,
            &Params {
                limit: Some(1),
                ..Params::default()
            },
        );
        assert_eq!(page["messages"][0]["truncated"], true);
        assert_eq!(page["next_cursor"], 1);
        assert!(excerpt(c.messages[0]["text"].as_str().unwrap(), "needle").contains("Needle"));
        assert_eq!(
            read_page(
                &c,
                &Params {
                    cursor: 1,
                    ..Params::default()
                }
            )["messages"][0]["text"],
            "reply"
        );
    }
    #[test]
    fn switchboard_chats_handover_retains_complete_text_and_separates_cached_previews() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        let text = format!("{} final constraint", "\u{1f680}".repeat(5000));
        fs::write(
            &path,
            format!("{}\n", json!({"type":"user","message":{"content":text}})),
        )
        .unwrap();
        let mut index = HistoryIndex::new("claude", dir.path(), &path);
        let preview = index.page(&Params::default()).unwrap();
        assert_eq!(preview["messages"][0]["truncated"], true);
        assert!(preview["messages"][0].get("context_text").is_none());
        let context = index
            .page(&Params {
                context: true,
                ..Params::default()
            })
            .unwrap();
        assert_eq!(context["messages"][0]["context_text"], text);
        assert_eq!(context["messages"][0]["context_truncated"], false);
        // Conversation shows the whole message, not the 4,000-character preview.
        assert_eq!(context["messages"][0]["text"], text);
        assert_eq!(context["messages"][0]["truncated"], false);
        assert!(serde_json::to_string(&context["messages"][0]["markdown"])
            .unwrap()
            .contains("final constraint"));
        let preview = index.page(&Params::default()).unwrap();
        assert!(preview["messages"][0].get("context_text").is_none());

        let mut chat = Chat::default();
        chat.push("assistant", "x".repeat(64001), Value::Null);
        let context = read_page(
            &chat,
            &Params {
                context: true,
                ..Params::default()
            },
        );
        assert_eq!(context["messages"][0]["context_truncated"], true);
        assert!(
            context["messages"][0]["context_text"]
                .as_str()
                .unwrap()
                .chars()
                .count()
                <= 64001
        );
    }
    #[test]
    fn switchboard_chats_tail_and_previous_pages() {
        let mut chat = Chat::default();
        for i in 0..503 {
            chat.push("user", format!("Message {i}"), Value::Null);
        }
        let p = Params {
            tail: true,
            limit: Some(50),
            ..Params::default()
        };
        let page = read_page(&chat, &p);
        assert_eq!(page["start_cursor"], 453);
        assert_eq!(page["previous_cursor"], 453);
        assert_eq!(page["next_cursor"], Value::Null);
        assert_eq!(page["messages"][49]["text"], "Message 502");
        let older = read_page(
            &chat,
            &Params {
                before: Some(453),
                ..p.clone()
            },
        );
        assert_eq!(older["start_cursor"], 403);
        assert_eq!(older["messages"][49]["text"], "Message 452");
        let first = read_page(
            &chat,
            &Params {
                before: Some(3),
                ..p.clone()
            },
        );
        assert_eq!(first["start_cursor"], 0);
        assert_eq!(first["previous_cursor"], Value::Null);
        assert_eq!(first["messages"].as_array().unwrap().len(), 3);
        assert_eq!(read_page(&Chat::default(), &p)["messages"], json!([]));
        assert_eq!(
            read_page(
                &chat,
                &Params {
                    before: Some(0),
                    ..p.clone()
                }
            )["messages"],
            json!([])
        );
        let forward = read_page(
            &chat,
            &Params {
                cursor: 500,
                ..Params::default()
            },
        );
        assert_eq!(forward["start_cursor"], 500);
        assert_eq!(forward["messages"][0]["text"], "Message 500");
    }
    #[test]
    fn switchboard_chats_opencode_readonly_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE session(id TEXT,title TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER); CREATE TABLE part(id TEXT,message_id TEXT,data TEXT,time_created INTEGER); INSERT INTO session VALUES('ses_1','Pairing','/repo'); INSERT INTO message VALUES('m1','ses_1','{\"role\":\"user\"}',1); INSERT INTO part VALUES('p1','m1','{\"type\":\"text\",\"text\":\"find pairing\"}',1); INSERT INTO part VALUES('p2','m1','{\"type\":\"reasoning\",\"text\":\"secret\"}',2);").unwrap();
        drop(db);
        let before = fs::read(&path).unwrap();
        let result = local(
            vec![("opencode", path.clone())],
            &Params {
                q: "pairing".into(),
                ..Params::default()
            },
            None,
        );
        assert_eq!(result["sources"][0]["results"][0]["id"], "opencode-ses_1");
        let result = local(
            vec![("opencode", path.clone())],
            &Params::default(),
            Some("opencode-ses_1"),
        );
        assert_eq!(result["messages"].as_array().unwrap().len(), 1);
        assert_eq!(fs::read(&path).unwrap(), before);
        let db = rusqlite::Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE session_message(id TEXT,session_id TEXT); INSERT INTO session_message VALUES('new','ses_1');").unwrap();
        let result = local(
            vec![("opencode", path.clone())],
            &Params::default(),
            Some("opencode-ses_1"),
        );
        assert_eq!(result["partial"], true);
        db.execute_batch("DELETE FROM session_message; CREATE TABLE session_v2(id TEXT);")
            .unwrap();
        let result = local(
            vec![("opencode", path.clone())],
            &Params::default(),
            Some("opencode-ses_1"),
        );
        assert_eq!(result["partial"], true);
        let result = local(
            vec![("opencode", path)],
            &Params::default(),
            Some("opencode-ses_new"),
        );
        assert_eq!(result["error"], "unsupported_storage");
    }
    #[test]
    fn switchboard_chats_live_tail_and_skipped_records_keep_later_messages() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("chat.jsonl");
        let record =
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Hello"}})
                .to_string();
        fs::write(&path, format!("{record}\n{{\"type\":")).unwrap();
        let chat = read_file("codex", dir.path(), &path).unwrap();
        assert!(
            !chat.partial,
            "An unfinished live write is retried, not lost history"
        );
        assert_eq!(chat.messages.len(), 1);
        fs::write(&path, format!("broken JSON\n{record}\n")).unwrap();
        let chat = read_file("codex", dir.path(), &path).unwrap();
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.partial_reasons, vec!["malformed_record"]);
        let oversized = "x".repeat(LINE_BYTES as usize + 1);
        fs::write(&path, format!("{oversized}\n{record}\n")).unwrap();
        let chat = read_file("codex", dir.path(), &path).unwrap();
        assert_eq!(
            chat.messages.len(),
            1,
            "Oversized tool records must not hide later messages"
        );
        assert_eq!(chat.partial_reasons, vec!["record_limit"]);
        assert_eq!(
            read_page(&chat, &Params::default())["partial_reasons"],
            json!(["record_limit"])
        );
    }
    #[test]
    #[ignore = "reads this account's installed agent histories; prints only coverage"]
    fn switchboard_chats_installed_history_smoke() {
        let result = local(
            roots(),
            &Params {
                limit: Some(1),
                ..Params::default()
            },
            None,
        );
        for source in result["sources"].as_array().unwrap() {
            println!(
                "{}: status={}, results={}",
                source["agent"],
                source["status"],
                source["results"].as_array().unwrap().len()
            );
            assert_ne!(source["status"], "unreadable_or_unsupported_schema");
            if let Some(hit) = source["results"].as_array().unwrap().first() {
                let page = local(
                    roots(),
                    &Params {
                        limit: Some(1),
                        ..Params::default()
                    },
                    hit["id"].as_str(),
                );
                assert!(
                    page.get("messages").is_some(),
                    "{} read failed",
                    source["agent"]
                );
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn switchboard_chats_skip_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.jsonl"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("linked")).unwrap();
        assert!(discover(dir.path(), "claude").0.is_empty());
    }
    #[tokio::test]
    async fn switchboard_chats_http_guard_and_unknown_host() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        for path in ["/api/chats/search", "/api/chats/claude-123"] {
            let request = Request::builder()
                .uri(path)
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, "https://attacker.example")
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );
        }
        for path in [
            "/api/chats/search?host=unknown",
            "/api/chats/claude-123?host=unknown",
        ] {
            let request = Request::builder()
                .uri(path)
                .header(header::HOST, "127.0.0.1:8090")
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(request).await.unwrap().status(),
                StatusCode::NOT_FOUND
            );
        }
        let request = Request::builder()
            .uri("/api/chats/search?limit=1000")
            .header(header::HOST, "127.0.0.1:8090")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(request).await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
    }
    #[tokio::test]
    async fn switchboard_chats_gateway_is_local_read_only() {
        let r = Request::builder()
            .method(Method::POST)
            .uri("/switchboard/chats/search")
            .body(Body::empty())
            .unwrap();
        assert_eq!(gateway(r).await.status(), StatusCode::METHOD_NOT_ALLOWED);
        let r = Request::builder()
            .uri("/switchboard/chats/search?limit=999")
            .body(Body::empty())
            .unwrap();
        assert_eq!(gateway(r).await.status(), StatusCode::BAD_REQUEST);
    }
}
