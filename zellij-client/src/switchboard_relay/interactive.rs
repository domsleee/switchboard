//! `zellij switchboard run`: a command that needs a terminal, run from a shell
//! that has none.
//!
//! Claude Code's `!` and Bash tool give commands no terminal, so anything that
//! prompts (`gio mount`, `ssh`, `gh auth login`, `passwd`) fails or quits. The
//! helper opens a floating pane beside the caller's, runs the command there under
//! `script` (which records what the pane shows, not what is typed, so passwords
//! typed with echo off stay out of it), waits for the pane to close, prints the
//! recording and exits with the command's status. Meanwhile it holds a request to
//! this relay open, and the caller's pane shows "input" on every paired sidebar.
use super::RelayState;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    Json,
};
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

/// The relay forgets a run after this long even if its helper still waits.
const MAX_WAIT: Duration = Duration::from_secs(4 * 3600);
const MAX_RUNS: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Waiting {
    session: String,
    pane_id: u64,
}

/// Clears the pane's "input" when its helper stops waiting, however it stops.
struct Finished {
    state: RelayState,
    session: String,
    pane_id: u64,
}

impl Drop for Finished {
    fn drop(&mut self) {
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let state = self.state.clone();
            let session = std::mem::take(&mut self.session);
            let pane_id = self.pane_id;
            runtime.spawn(async move {
                state
                    .poll
                    .lock()
                    .await
                    .run_waiting(&session, pane_id, false);
            });
        }
    }
}

/// Held open by the helper for as long as its pane is open; closing the
/// connection ends the request.
pub(super) async fn wait(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Json(waiting): Json<Waiting>,
) -> StatusCode {
    if headers.contains_key(header::ORIGIN) || headers.contains_key("sec-fetch-mode") {
        return StatusCode::FORBIDDEN;
    }
    if waiting.session.is_empty() || waiting.session.len() > 256 {
        return StatusCode::BAD_REQUEST;
    }
    {
        let mut poll = state.poll.lock().await;
        if poll.runs_waiting() >= MAX_RUNS {
            return StatusCode::TOO_MANY_REQUESTS;
        }
        poll.run_waiting(&waiting.session, waiting.pane_id, true);
    }
    let _finished = Finished {
        state: state.clone(),
        session: waiting.session,
        pane_id: waiting.pane_id,
    };
    tokio::time::sleep(MAX_WAIT).await;
    StatusCode::REQUEST_TIMEOUT
}

/// A script that runs the helper, written at relay startup so panes started
/// before an update can use it.
pub fn helper_script(home: &Path) -> PathBuf {
    home.join(".local/share/switchboard/run-interactive")
}

fn script_text(binary: &Path) -> String {
    let quoted = binary.to_string_lossy().replace('\'', r"'\''");
    format!("#!/bin/sh\nexec '{quoted}' switchboard run -- \"$@\"\n")
}

#[cfg(unix)]
pub(super) fn install_helper(home: &Path, binary: &Path) -> std::io::Result<()> {
    super::askpass::write_script(&helper_script(home), &script_text(binary))
}

/// One argument is a shell command line; several are a program and its arguments.
fn command_line(command: &[String]) -> String {
    match command {
        [line] => line.clone(),
        words => words
            .iter()
            .map(|word| super::askpass::shell_quote(word))
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// What runs in the floating pane: `$1` the private directory, `$2` the helper's
/// pid, `$3` the command line. `script` runs its command with `$SHELL`, which
/// may be nu or fish, so it gets `/bin/sh` and the command gets `$SHELL` back.
/// It flushes every write, so a pane closed or timed out early still has output.
fn pane_script() -> &'static str {
    #[cfg(target_os = "linux")]
    const RECORD: &str = r#"SWITCHBOARD_SHELL=${SHELL-} SHELL=/bin/sh script -qefc 'SHELL=$SWITCHBOARD_SHELL; unset SWITCHBOARD_SHELL; '"$3" "$1/log""#;
    #[cfg(not(target_os = "linux"))]
    const RECORD: &str = r#"script -q -t 0 "$1/log" /bin/sh -c "$3""#;
    static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SCRIPT.get_or_init(|| {
        format!(
            "printf '%s\\n' \"$ZELLIJ_PANE_ID\" >\"$1/pane\"\n\
             {RECORD}\n\
             printf '%s\\n' \"$?\" >\"$1/status\"\n\
             # The helper is gone and nobody will print the recording: drop it now.\n\
             kill -0 \"$2\" 2>/dev/null || rm -rf \"$1\"\n"
        )
    })
}

/// The recording as plain text: no colours, cursor moves or `script` banners,
/// and only what a carriage return left visible on each line.
fn readable(log: &[u8]) -> String {
    let text = String::from_utf8_lossy(log);
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then one final byte in @..~.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                },
                // OSC, DCS and friends: up to BEL or ST.
                Some(']' | 'P' | 'X' | '^' | '_') => {
                    while let Some(c) = chars.next() {
                        if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                },
                // Charset selection takes one more character.
                Some('(' | ')' | '*' | '+' | '#' | '%') => {
                    chars.next();
                },
                _ => {},
            },
            '\x08' => {
                plain.pop();
            },
            '\n' | '\r' | '\t' => plain.push(c),
            c if c.is_control() => {},
            c => plain.push(c),
        }
    }
    let mut lines: Vec<&str> = plain
        .split('\n')
        .map(|line| {
            let line = line.trim_end_matches('\r');
            line.rsplit('\r').next().unwrap_or(line).trim_end()
        })
        .collect();
    if lines
        .first()
        .is_some_and(|l| l.starts_with("Script started on "))
    {
        lines.remove(0);
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    if lines
        .last()
        .is_some_and(|l| l.starts_with("Script done on "))
    {
        lines.pop();
    }
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    text
}

fn duration(time: Duration) -> String {
    match time.as_secs() {
        1 => "1 second".into(),
        secs if secs < 60 || secs % 60 != 0 => format!("{secs} seconds"),
        60 => "1 minute".into(),
        secs => format!("{} minutes", secs / 60),
    }
}

fn pane_name(line: &str) -> String {
    let mut name: String = line.chars().take(60).collect();
    if name.len() < line.len() {
        name.push('…');
    }
    format!("Input needed: {name}")
}

/// `zellij switchboard run`: runs a command in a floating pane beside this one,
/// prints what it showed, and exits with its status.
pub fn run(command: &[String], timeout: Duration, relay_url: &str) -> anyhow::Result<()> {
    let code = run_command(command, timeout, relay_url)?;
    std::process::exit(code);
}

#[cfg(not(unix))]
fn run_command(_: &[String], _: Duration, _: &str) -> anyhow::Result<i32> {
    anyhow::bail!("Switchboard runs interactive commands on macOS and Linux only")
}

#[cfg(unix)]
fn run_command(command: &[String], timeout: Duration, relay_url: &str) -> anyhow::Result<i32> {
    use anyhow::Context;
    use std::process::{Command, Stdio};
    let session = std::env::var("ZELLIJ_SESSION_NAME").ok();
    let pane = std::env::var("ZELLIJ_PANE_ID")
        .ok()
        .and_then(|p| p.parse::<u64>().ok());
    let (Some(session), Some(pane_id)) = (session.filter(|s| !s.is_empty()), pane) else {
        anyhow::bail!("Switchboard runs interactive commands only inside a Switchboard terminal");
    };
    let line = command_line(command);
    let cwd = std::env::current_dir().context("Cannot read the current directory")?;
    let zellij = super::control::own_executable()?;
    // Created 0700: the recording may hold anything the command printed.
    let dir = tempfile::Builder::new()
        .prefix("switchboard-run-")
        .tempdir()
        .context("Cannot create a private directory for the recording")?;

    // The badge is a courtesy: a relay that is down or older leaves the run unmarked.
    let request = serde_json::json!({ "session": session, "pane_id": pane_id }).to_string();
    anyhow::ensure!(relay_url.starts_with("https://"), "HTTPS is required");
    let url = format!("{}/api/interactive", relay_url.trim_end_matches('/'));
    std::thread::spawn(move || {
        use isahc::config::Configurable;
        if let Ok(request) = isahc::Request::post(url)
            .header("content-type", "application/json")
            .timeout(MAX_WAIT)
            .body(request)
        {
            if let Ok(client) = crate::switchboard_relay::tls::http_client() {
                let _ = client.send(request);
            }
        }
    });

    let mut pane = Command::new(&zellij)
        .args(["run", "--floating", "--close-on-exit", "--blocking"])
        .arg("--near-current-pane")
        .arg("--name")
        .arg(pane_name(&line))
        .arg("--cwd")
        .arg(&cwd)
        .args(["--", "/bin/sh", "-c", pane_script(), "sh"])
        .arg(dir.path())
        .arg(std::process::id().to_string())
        .arg(&line)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .context("Cannot open a Switchboard pane")?;
    let deadline = std::time::Instant::now() + timeout;
    let opened = loop {
        if let Some(status) = pane.try_wait()? {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = pane.kill();
            if let Ok(id) = std::fs::read_to_string(dir.path().join("pane")) {
                let _ = Command::new(&zellij)
                    .args(["action", "close-pane", "--pane-id"])
                    .arg(format!("terminal_{}", id.trim()))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            // The pane's shell may still be writing; the directory goes with `dir`.
            let shown = std::fs::read(dir.path().join("log")).unwrap_or_default();
            print!("{}", readable(&shown));
            drop(dir);
            anyhow::bail!(
                "Nobody finished the command within {}; its pane was closed",
                duration(timeout)
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    if !opened.success() {
        let mut error = String::new();
        if let Some(mut stderr) = pane.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut error);
        }
        anyhow::bail!("Could not open a Switchboard pane: {}", error.trim());
    }
    let shown = std::fs::read(dir.path().join("log")).unwrap_or_default();
    let status = std::fs::read_to_string(dir.path().join("status"))
        .ok()
        .and_then(|s| s.trim().parse::<i32>().ok());
    let started = dir.path().join("pane").exists();
    drop(dir);
    print!("{}", readable(&shown));
    use std::io::Write;
    std::io::stdout().flush()?;
    match status {
        Some(code) => Ok(code),
        None if started => anyhow::bail!("The pane was closed before the command finished"),
        None => {
            anyhow::bail!("Zellij opened no pane for the command; run it in a terminal yourself")
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_recording_reads_as_the_pane_showed_it() {
        let log = b"Script started on 2026-11-04 19:04:11+11:00 [COMMAND=\"x\"]\n\
            \x1b[1;32mMounted\x1b[0m smb://dom-pc.local/ssb-share\r\n\
            Password: \r\n\
            \x1b]0;title\x07progress 10%\rprogress 100%\r\n\
            tyop\x08\x08po\r\n\
            \r\n\
            Script done on 2026-11-04 19:04:12+11:00 [COMMAND_EXIT_CODE=\"0\"]\n";
        assert_eq!(
            readable(log),
            "Mounted smb://dom-pc.local/ssb-share\nPassword:\nprogress 100%\ntypo\n"
        );
        assert_eq!(readable(b""), "");
    }

    #[test]
    fn one_argument_is_a_command_line_and_several_are_words() {
        assert_eq!(
            command_line(&["gio mount smb://h/s && ls".into()]),
            "gio mount smb://h/s && ls"
        );
        assert_eq!(
            command_line(&["ssh".into(), "dom-pc".into(), "echo hi there".into()]),
            "ssh dom-pc 'echo hi there'"
        );
        assert_eq!(
            script_text(Path::new("/Users/o'neil/bin/zellij")),
            "#!/bin/sh\nexec '/Users/o'\\''neil/bin/zellij' switchboard run -- \"$@\"\n"
        );
        assert_eq!(pane_name("ls"), "Input needed: ls");
        assert_eq!(duration(Duration::from_secs(600)), "10 minutes");
        assert_eq!(duration(Duration::from_secs(90)), "90 seconds");
    }

    /// The real pane script under `/bin/sh`, with `script` standing in for a pane.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_pane_script_records_output_and_status_and_cleans_up_after_a_lost_helper() {
        if std::process::Command::new("script")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let run = |dir: &Path, helper: u32, line: &str| {
            std::process::Command::new("/bin/sh")
                .args(["-c", pane_script(), "sh"])
                .arg(dir)
                .arg(helper.to_string())
                .arg(line)
                .env("ZELLIJ_PANE_ID", "41")
                .env("SHELL", "/usr/bin/nu")
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap()
        };
        let dir = tempfile::tempdir().unwrap();
        run(
            dir.path(),
            std::process::id(),
            "echo \"$SHELL\" && printf 'a b\\n' && exit 3",
        );
        let read = |name: &str| std::fs::read_to_string(dir.path().join(name)).unwrap();
        assert_eq!(read("pane"), "41\n");
        assert_eq!(read("status"), "3\n");
        assert_eq!(
            readable(read("log").as_bytes()),
            "/usr/bin/nu\na b\n",
            "the command runs under sh with the caller's SHELL"
        );
        // A helper that was killed leaves nobody to print or delete the recording.
        let gone = tempfile::tempdir().unwrap().into_path();
        run(&gone, u32::MAX >> 1, "echo secret");
        assert!(!gone.exists(), "the recording outlived its helper");
    }

    #[tokio::test]
    async fn a_waiting_run_marks_its_pane_until_the_helper_disconnects() {
        use crate::switchboard_relay::Host;
        use std::{collections::HashMap, sync::Arc};
        let host = Arc::new(
            Host::new(crate::switchboard_relay::tests::config(
                "http://127.0.0.1:9",
            ))
            .unwrap(),
        );
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
            push: None,
            browser_origin: None,
        };
        let app = axum::Router::new()
            .route("/api/interactive", axum::routing::post(wait))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let scanned = |poll: &mut super::super::attention::PollState| {
            let mut snapshot = serde_json::json!({"panes":[
                {"session":"main","pane_id":7,"state":"working","agent":"claude","command":"claude"},
                {"session":"main","pane_id":8,"state":"working","agent":"claude","command":"claude"}
            ],"tabs":[],"errors":[]});
            poll.update("mac", &mut snapshot);
            let states: Vec<_> = snapshot["panes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["state"].as_str().unwrap().to_owned())
                .collect();
            states
        };

        // The helper is a raw connection, so the test can drop it like a killed process.
        use tokio::io::AsyncWriteExt;
        let body = r#"{"session":"main","pane_id":7}"#;
        let mut helper = tokio::net::TcpStream::connect(address).await.unwrap();
        helper
            .write_all(
                format!(
                    "POST /api/interactive HTTP/1.1\r\nhost: x\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        let mut marked = false;
        for _ in 0..200 {
            if scanned(&mut *state.poll.lock().await) == ["input", "working"] {
                marked = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(marked, "the waiting pane, and only it, shows input");
        {
            let mut poll = state.poll.lock().await;
            let mut peer = serde_json::json!({"panes":[{"session":"main","pane_id":7,"state":"working"}],"tabs":[],"errors":[]});
            poll.update("peer", &mut peer);
            assert_eq!(
                peer["panes"][0]["state"], "working",
                "a peer's pane 7 is another pane"
            );
        }
        drop(helper);
        for _ in 0..200 {
            if scanned(&mut *state.poll.lock().await) == ["working", "working"] {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the pane kept asking for input after its helper went away");
    }

    #[tokio::test]
    async fn a_web_page_cannot_mark_a_pane() {
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
            push: None,
            browser_origin: None,
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://127.0.0.1:8090".parse().unwrap());
        let waiting = Waiting {
            session: "main".into(),
            pane_id: 7,
        };
        assert_eq!(
            wait(State(state.clone()), headers, Json(waiting)).await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(state.poll.lock().await.runs_waiting(), 0);
    }
}
