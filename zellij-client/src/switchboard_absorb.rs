//! `zellij absorb`: recreate another terminal app's tabs as Switchboard tabs, then close them.
//!
//! A running process can't move into Zellij, so each tab is recreated: an idle shell becomes a
//! new tab in the same folder, and an idle Claude Code or Codex is quit and resumed in a new tab.
//! The platform-independent part lives here; each terminal app implements [`Terminal`].

#[cfg(target_os = "macos")]
mod iterm;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, UNIX_EPOCH};
use zellij_utils::agent_resumption::{invocation, resume_command, AgentKind};

/// One tab (or split pane) of another terminal app.
#[derive(Clone, Debug)]
pub struct ForeignTab {
    /// Stable id the backend understands in [`Terminal::type_text`] and [`Terminal::close`].
    pub id: String,
    pub title: String,
    /// The tab's shell. Everything else in the tab runs below it.
    pub shell_pid: u32,
}

/// What `zellij absorb` needs from a terminal app.
pub trait Terminal {
    /// Every tab the user could see, with its shell's pid. Skip tabs that can't be read.
    fn tabs(&self) -> Result<Vec<ForeignTab>>;
    /// The visible screen text, used to tell whether Codex is idle.
    fn screen(&self, id: &str) -> Result<String>;
    /// Type `text` as keystrokes. No newline is added: "\r" is Enter, "\x03" is Ctrl-C.
    fn type_text(&self, id: &str, text: &str) -> Result<()>;
    /// Close the tab. Only called once its replacement runs.
    fn close(&self, id: &str) -> Result<()>;
}

fn terminal() -> Result<Box<dyn Terminal>> {
    #[cfg(target_os = "macos")]
    return Ok(Box::new(iterm::ITerm));
    #[cfg(not(target_os = "macos"))]
    bail!("zellij absorb supports only iTerm on macOS so far")
}

/// A process below a tab's shell, as the core sees it (from sysinfo, or a test fixture).
#[derive(Clone, Debug)]
pub struct Process {
    pub pid: u32,
    pub parent: Option<u32>,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// Unix seconds.
    pub started: u64,
}

/// What absorbing one tab will do.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Open a tab in `cwd`, then close the original.
    Shell { cwd: PathBuf },
    /// Quit the agent at `pid`, then run `command` in `cwd`.
    Agent {
        agent: AgentKind,
        pid: u32,
        session_id: String,
        cwd: PathBuf,
        command: Vec<String>,
    },
    /// Leave the tab alone.
    Skip(String),
}

pub struct Step {
    pub tab: ForeignTab,
    pub action: Action,
}

pub fn run(apply: bool, only: Option<&str>, session: &str) -> Result<()> {
    let terminal = terminal()?;
    let home = std::env::home_dir().context("No home directory")?;
    let steps = plan(&*terminal, &home, only)?;
    if steps.is_empty() {
        println!("No tabs to absorb.");
        return Ok(());
    }
    for step in &steps {
        println!("{}", describe(step));
    }
    if !apply {
        println!("\nNothing changed. Run `zellij absorb --apply` to do this.");
        return Ok(());
    }
    println!();
    let mut failed = 0;
    for step in &steps {
        if matches!(step.action, Action::Skip(_)) {
            continue;
        }
        match absorb(&*terminal, &home, session, step) {
            Ok(()) => println!("Absorbed {}", step.tab.title),
            Err(error) => {
                failed += 1;
                println!("Left {} open: {error:#}", step.tab.title);
            },
        }
    }
    if failed > 0 {
        bail!("{failed} tab(s) could not be absorbed");
    }
    Ok(())
}

/// Every process on this computer.
fn processes() -> Vec<Process> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cmd(UpdateKind::Always)
            .with_cwd(UpdateKind::Always),
    );
    system
        .processes()
        .iter()
        .map(|(pid, process)| Process {
            pid: pid.as_u32(),
            parent: process.parent().map(Pid::as_u32),
            args: process
                .cmd()
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
            cwd: process.cwd().map(Path::to_path_buf),
            started: process.start_time(),
        })
        .collect()
}

fn alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new();
    let pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(pid).is_some()
}

/// What runs in a tab.
#[derive(Debug)]
enum Found<'a> {
    /// Only the shell.
    Shell,
    Agent(AgentKind, &'a Process),
    /// A Zellij client: the tab is already Switchboard.
    Zellij,
    Other(String),
}

fn executable(process: &Process) -> String {
    let name = process
        .args
        .first()
        .map_or("", |arg| arg.rsplit(['/', '\\']).next().unwrap_or(arg));
    name.strip_suffix(".exe")
        .unwrap_or(name)
        .trim_start_matches('-')
        .to_ascii_lowercase()
}

/// Classify a tab from every process on the computer. An agent may sit below launcher shims
/// (cmd.exe and node.exe on Windows); anything else running beside it leaves the tab alone.
fn classify(shell: u32, processes: &[Process]) -> Found<'_> {
    let parent = |pid: u32| processes.iter().find(|p| p.pid == pid)?.parent;
    let below = |pid: u32, ancestor: u32| {
        let mut current = parent(pid);
        for _ in 0..64 {
            match current {
                Some(p) if p == ancestor => return true,
                Some(p) if p != 0 => current = parent(p),
                _ => return false,
            }
        }
        false
    };
    let inside: Vec<&Process> = processes
        .iter()
        .filter(|p| p.pid != shell && below(p.pid, shell))
        .collect();
    if inside.is_empty() {
        return Found::Shell;
    }
    if inside.iter().any(|p| executable(p) == "zellij") {
        return Found::Zellij;
    }
    let agents: Vec<&&Process> = inside
        .iter()
        .filter(|p| invocation(&p.args).is_some())
        .collect();
    let top = agents
        .iter()
        .find(|p| !agents.iter().any(|a| below(p.pid, a.pid)));
    if let Some(agent) = top {
        let unrelated: Vec<String> = inside
            .iter()
            .filter(|p| p.pid != agent.pid && !below(p.pid, agent.pid) && !below(agent.pid, p.pid))
            .map(|p| executable(p))
            .collect();
        if unrelated.is_empty() {
            return Found::Agent(invocation(&agent.args).unwrap().0, agent);
        }
        return Found::Other(format!("it also runs {}", unrelated.join(", ")));
    }
    let mut names: Vec<String> = inside
        .iter()
        .filter(|p| p.parent == Some(shell))
        .map(|p| executable(p))
        .collect();
    names.dedup();
    Found::Other(format!("it runs {}", names.join(", ")))
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canonical(a) == canonical(b)
}

/// The Codex conversation `codex` is in. Codex keeps no pid file and doesn't hold its rollout
/// open, so look for rollouts in its folder written since it started. None if not exactly one.
fn codex_thread(home: &Path, codex: &Process) -> Result<String, String> {
    let cwd = codex.cwd.as_deref().ok_or("can't read Codex's folder")?;
    let since = UNIX_EPOCH + Duration::from_secs(codex.started);
    let mut ids = Vec::new();
    let mut dirs = vec![home.join(".codex/sessions")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                dirs.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.starts_with("rollout-")
                || metadata
                    .modified()
                    .map_or(true, |modified| modified < since)
            {
                continue;
            }
            let Some(meta) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(text.lines().next()?).ok())
            else {
                continue;
            };
            let payload = &meta["payload"];
            if let (Some(id), Some(dir)) = (payload["id"].as_str(), payload["cwd"].as_str()) {
                if same_dir(Path::new(dir), cwd) && !ids.iter().any(|known| known == id) {
                    ids.push(id.to_owned());
                }
            }
        }
    }
    match ids.len() {
        1 => Ok(ids.remove(0)),
        0 => Err("Codex has no conversation yet".into()),
        _ => Err("can't tell which Codex conversation it is".into()),
    }
}

fn claude_session(home: &Path, pid: u32) -> Option<Value> {
    let text = std::fs::read_to_string(home.join(format!(".claude/sessions/{pid}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

fn plan_tab(
    tab: &ForeignTab,
    processes: &[Process],
    home: &Path,
    screen: &dyn Fn() -> Result<String>,
) -> Action {
    let skip = |reason: &str| Action::Skip(reason.to_owned());
    match classify(tab.shell_pid, processes) {
        Found::Shell => match processes
            .iter()
            .find(|p| p.pid == tab.shell_pid)
            .and_then(|p| p.cwd.clone())
        {
            Some(cwd) => Action::Shell { cwd },
            None => skip("can't read the shell's folder"),
        },
        Found::Zellij => skip("already Switchboard"),
        Found::Other(reason) => Action::Skip(reason),
        Found::Agent(AgentKind::Claude, claude) => {
            let Some(session) = claude_session(home, claude.pid) else {
                return skip("Claude has no conversation yet");
            };
            let status = session["status"].as_str().unwrap_or("unknown");
            if status != "idle" {
                return Action::Skip(format!("Claude is {status}"));
            }
            let (Some(id), Some(cwd)) = (session["sessionId"].as_str(), session["cwd"].as_str())
            else {
                return skip("Claude's session file has no session id");
            };
            agent_action(AgentKind::Claude, claude, id, PathBuf::from(cwd))
        },
        Found::Agent(AgentKind::Codex, codex) => {
            let id = match codex_thread(home, codex) {
                Ok(id) => id,
                Err(reason) => return Action::Skip(reason),
            };
            let pane = json!({"pane_command": "codex", "title": tab.title});
            let state = match screen() {
                Ok(screen) => crate::switchboard_relay::attention::classify(&pane, &screen)
                    ["state"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned(),
                Err(error) => format!("unreadable ({error})"),
            };
            if state != "ready" {
                return Action::Skip(format!("Codex is {state}"));
            }
            agent_action(AgentKind::Codex, codex, &id, codex.cwd.clone().unwrap())
        },
        Found::Agent(agent, _) => Action::Skip(format!("{} can't be resumed here", agent.name())),
    }
}

fn agent_action(agent: AgentKind, process: &Process, id: &str, cwd: PathBuf) -> Action {
    match resume_command(&process.args, agent, id, cwd.clone()) {
        Ok(run) => Action::Agent {
            agent,
            pid: process.pid,
            session_id: id.to_owned(),
            cwd,
            command: std::iter::once(run.command.to_string_lossy().into_owned())
                .chain(run.args)
                .collect(),
        },
        Err(reason) => Action::Skip(reason),
    }
}

fn plan(terminal: &dyn Terminal, home: &Path, only: Option<&str>) -> Result<Vec<Step>> {
    let tabs: Vec<ForeignTab> = terminal
        .tabs()?
        .into_iter()
        .filter(|tab| only.map_or(true, |id| tab.id == id))
        .collect();
    if let (Some(id), true) = (only, tabs.is_empty()) {
        bail!("No tab {id}");
    }
    let processes = processes();
    Ok(tabs
        .into_iter()
        .map(|tab| {
            let action = plan_tab(&tab, &processes, home, &|| terminal.screen(&tab.id));
            Step { tab, action }
        })
        .collect())
}

fn describe(step: &Step) -> String {
    let what = match &step.action {
        Action::Shell { cwd } => format!("open a shell tab in {}", cwd.display()),
        Action::Agent { agent, command, .. } => format!(
            "quit {} and resume it in a new tab: {}",
            agent.name(),
            shell_words(command)
        ),
        Action::Skip(reason) => format!("leave alone: {reason}"),
    };
    format!("{}  {}\n    {what}", step.tab.id, step.tab.title)
}

fn shell_words(words: &[String]) -> String {
    words
        .iter()
        .map(|word| {
            if word
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./=:@".contains(c))
            {
                word.clone()
            } else {
                format!("'{}'", word.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn zellij(session: &str) -> Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    for name in ["ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"] {
        command.env_remove(name);
    }
    command.args(["-s", session, "action"]);
    Ok(command)
}

/// Open a tab and return its id once its pane is still running a moment later.
fn new_tab(session: &str, name: &str, cwd: &Path, command: &[String]) -> Result<u64> {
    let mut new_tab = zellij(session)?;
    new_tab.args(["new-tab", "--name", name, "--cwd"]).arg(cwd);
    if !command.is_empty() {
        new_tab.arg("--").args(command);
    }
    let output = new_tab.output()?;
    if !output.status.success() {
        bail!(
            "zellij new-tab failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let tab: u64 = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse()
        .context("zellij new-tab printed no tab id")?;
    std::thread::sleep(Duration::from_secs(3));
    let panes = zellij(session)?
        .args(["list-panes", "--json", "--all"])
        .output()?;
    let panes: Value = serde_json::from_slice(&panes.stdout).context("Reading list-panes")?;
    let running = panes.as_array().is_some_and(|panes| {
        panes.iter().any(|pane| {
            pane["tab_id"] == tab && pane["is_plugin"] == false && pane["exited"] == false
        })
    });
    if !running {
        bail!("the new tab's command exited");
    }
    Ok(tab)
}

fn wait_for(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    done()
}

fn folder_name(cwd: &Path) -> String {
    cwd.file_name().map_or_else(
        || cwd.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn absorb(terminal: &dyn Terminal, home: &Path, session: &str, step: &Step) -> Result<()> {
    let id = &step.tab.id;
    match &step.action {
        Action::Skip(_) => return Ok(()),
        Action::Shell { cwd } => {
            new_tab(session, &folder_name(cwd), cwd, &[])?;
        },
        Action::Agent {
            agent,
            pid,
            session_id,
            cwd,
            command,
        } => {
            let name = claude_session(home, *pid)
                .and_then(|s| s["name"].as_str().map(str::to_owned))
                .unwrap_or_else(|| folder_name(cwd));
            // Ctrl-C first clears any half-typed prompt, so /exit is never appended to it.
            // Enter goes separately: typed in one burst, it reads as pasted text.
            for keys in ["\x03", "/exit", "\r"] {
                terminal.type_text(id, keys)?;
                std::thread::sleep(Duration::from_millis(400));
            }
            if !wait_for(Duration::from_secs(20), || !alive(*pid)) {
                bail!("{} did not quit; it still runs there", agent.name());
            }
            let resume = || format!("resume it there with: {}", shell_words(command));
            let tab = new_tab(session, &name, cwd, command).with_context(|| {
                format!("{} quit but did not restart; {}", agent.name(), resume())
            })?;
            if *agent == AgentKind::Claude
                && !wait_for(Duration::from_secs(30), || {
                    claude_resumed(home, session_id, *pid)
                })
            {
                bail!(
                    "Claude started in tab {tab} but never resumed its conversation; {}",
                    resume()
                );
            }
        },
    }
    terminal.close(id)
}

/// Whether a new Claude process reports the conversation `session_id`.
fn claude_resumed(home: &Path, session_id: &str, old_pid: u32) -> bool {
    std::fs::read_dir(home.join(".claude/sessions"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .any(|s| s["sessionId"] == session_id && s["pid"] != old_pid)
}
