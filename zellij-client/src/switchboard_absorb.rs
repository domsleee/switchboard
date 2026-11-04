//! `zellij absorb`: recreate another terminal app's tabs as Switchboard tabs, then close them.
//!
//! A running process can't move into Zellij, so each tab is recreated: an idle shell becomes a
//! new tab in the same folder, and an idle Claude Code or Codex is quit and resumed in a new tab.
//! The platform-independent part lives here; each terminal app implements [`Terminal`].

#[cfg(target_os = "macos")]
mod iterm;
#[cfg(windows)]
mod windows_terminal;

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
    #[cfg(windows)]
    return Ok(Box::new(windows_terminal::WindowsTerminal));
    #[cfg(not(any(target_os = "macos", windows)))]
    bail!("zellij absorb supports only iTerm on macOS and Windows Terminal so far")
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
    /// Quit the agent at `pid`, then resume its conversation in `cwd`. Codex's conversation
    /// id is None until `--apply` reads it from Codex's /status.
    Agent {
        agent: AgentKind,
        pid: u32,
        session_id: Option<String>,
        cwd: PathBuf,
        launch: Vec<String>,
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
        // The plan may be minutes old: absorb only what still looks the same.
        let now = plan(&*terminal, &home, Some(&step.tab.id))
            .ok()
            .and_then(|mut steps| steps.pop());
        let result = match now {
            Some(now) if now.action == step.action => absorb(&*terminal, &home, session, step),
            Some(now) => Err(anyhow::anyhow!(
                "it changed since the plan: {}",
                describe(&now)
            )),
            None => Err(anyhow::anyhow!("it is gone")),
        };
        match result {
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

/// Shells absorb knows how to end with `exit`. A tab whose own process is anything else (a
/// profile that runs claude, ssh or zellij directly) is left alone: typing `exit` into it, or
/// ending it, would not be closing an idle shell.
const SHELLS: &[&str] = &[
    "bash",
    "cmd",
    "csh",
    "dash",
    "elvish",
    "fish",
    "ksh",
    "nu",
    "powershell",
    "pwsh",
    "sh",
    "tcsh",
    "xonsh",
    "zsh",
];

/// Classify a tab from every process on the computer. An agent may sit below launcher shims
/// (cmd.exe and node.exe on Windows); anything else running beside it leaves the tab alone.
fn classify(shell: u32, processes: &[Process]) -> Found<'_> {
    let own = processes
        .iter()
        .find(|p| p.pid == shell)
        .map(executable)
        .unwrap_or_default();
    if !SHELLS.contains(&own.as_str()) {
        return Found::Other(if own.is_empty() {
            "can't tell what the tab runs".to_owned()
        } else {
            format!("the tab runs {own}, not a shell")
        });
    }
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

/// Conversations Codex wrote in its folder since `codex` started. Codex keeps no pid file and
/// doesn't hold its rollout open, so this only tells whether it has a conversation at all;
/// its /status names which one.
fn codex_threads(home: &Path, codex: &Process) -> Result<Vec<String>, String> {
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
    Ok(ids)
}

/// Session ids on a Codex /status card ("Session:  01a1a644-18d0-…"), oldest first.
fn status_sessions(screen: &str) -> Vec<String> {
    static SESSION: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"Session:\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        )
        .unwrap()
    });
    SESSION
        .captures_iter(screen)
        .map(|c| c[1].to_owned())
        .collect()
}

/// Ask Codex for its conversation id with /status, which only prints a card.
fn codex_session(terminal: &dyn Terminal, tab: &str, home: &Path) -> Result<String> {
    let before = status_sessions(&terminal.screen(tab)?).len();
    for keys in ["/status", "\r"] {
        terminal.type_text(tab, keys)?;
        std::thread::sleep(Duration::from_millis(400));
    }
    let mut sessions = Vec::new();
    wait_for(Duration::from_secs(5), || {
        sessions = terminal
            .screen(tab)
            .map(|s| status_sessions(&s))
            .unwrap_or_default();
        sessions.len() > before
    });
    if sessions.len() <= before {
        bail!("Codex's /status showed no session id");
    }
    let id = sessions.pop().unwrap();
    if !rollout_exists(&home.join(".codex/sessions"), &id) {
        bail!("Codex's /status names {id}, which has no saved conversation");
    }
    Ok(id)
}

fn rollout_exists(dir: &Path, id: &str) -> bool {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .any(|entry| {
            let path = entry.path();
            if path.is_dir() {
                return rollout_exists(&path, id);
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("rollout-") && name.ends_with(&format!("{id}.jsonl"))
        })
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
    let action = match classify(tab.shell_pid, processes) {
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
            agent_action(AgentKind::Claude, claude, Some(id), PathBuf::from(cwd))
        },
        Found::Agent(AgentKind::Codex, codex) => {
            match codex_threads(home, codex) {
                Ok(ids) if ids.is_empty() => return skip("Codex has no conversation yet"),
                Ok(_) => {},
                Err(reason) => return Action::Skip(reason),
            }
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
            agent_action(AgentKind::Codex, codex, None, codex.cwd.clone().unwrap())
        },
        Found::Agent(agent, _) => Action::Skip(format!("{} can't be resumed here", agent.name())),
    };
    if let Action::Agent { agent, .. } = &action {
        // Quitting types /exit, which would join a half-typed prompt and lose it.
        match screen() {
            Ok(screen) => {
                if let Err(reason) = prompt_empty(*agent, &screen) {
                    return Action::Skip(format!("{} {reason}", agent.name()));
                }
            },
            Err(error) => return Action::Skip(format!("can't read its screen ({error})")),
        }
    }
    action
}

/// Whether the agent's prompt is on screen and holds nothing but its own placeholder.
/// shortcut: a dim suggestion we don't know reads as a draft, so that tab is left alone.
fn prompt_empty(agent: AgentKind, screen: &str) -> Result<(), String> {
    let marker = if agent == AgentKind::Codex {
        '›'
    } else {
        '❯'
    };
    let line = screen
        .lines()
        .rev()
        .find_map(|line| line.trim_start().strip_prefix(marker))
        .ok_or("shows no prompt")?
        .trim();
    let placeholder = match agent {
        AgentKind::Codex => {
            matches!(
                line,
                "Ask Codex to do anything" | "Ask a follow-up question"
            )
        },
        _ => line.starts_with("Try \"") && line.ends_with('"'),
    };
    if line.is_empty() || placeholder {
        Ok(())
    } else {
        Err(format!("has unsent text: {line}"))
    }
}

fn agent_action(agent: AgentKind, process: &Process, id: Option<&str>, cwd: PathBuf) -> Action {
    // Check the agent's options can be resumed before quitting it.
    let probe = id.unwrap_or("00000000-0000-0000-0000-000000000000");
    match resume(agent, &process.args, probe, &cwd) {
        Ok(_) => Action::Agent {
            agent,
            pid: process.pid,
            session_id: id.map(str::to_owned),
            cwd,
            launch: process.args.clone(),
        },
        Err(reason) => Action::Skip(reason),
    }
}

/// The command that resumes conversation `id` of an agent started with `launch`.
fn resume(
    agent: AgentKind,
    launch: &[String],
    id: &str,
    cwd: &Path,
) -> Result<Vec<String>, String> {
    let run = resume_command(launch, agent, id, cwd.to_path_buf())?;
    Ok(std::iter::once(run.command.to_string_lossy().into_owned())
        .chain(run.args)
        .collect())
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
        Action::Agent {
            agent,
            session_id: Some(id),
            cwd,
            launch,
            ..
        } => format!(
            "quit {} and resume it in a new tab: {}",
            agent.name(),
            resume(*agent, launch, id, cwd).map_or_else(|e| e, |c| shell_words(&c))
        ),
        Action::Agent { agent, .. } => format!(
            "read {0}'s conversation id from /status, quit {0} and resume it in a new tab",
            agent.name()
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
            launch,
        } => {
            let session_id = match session_id {
                Some(known) => known.clone(),
                None => codex_session(terminal, id, home)?,
            };
            let command = resume(*agent, launch, &session_id, cwd).map_err(anyhow::Error::msg)?;
            let command = &command;
            let name = claude_session(home, *pid)
                .and_then(|s| s["name"].as_str().map(str::to_owned))
                .unwrap_or_else(|| folder_name(cwd));
            // Enter goes separately: typed in one burst, it reads as pasted text.
            for keys in ["/exit", "\r"] {
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
                    claude_resumed(home, &session_id, *pid)
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
        .filter(|entry| entry.file_name() != *format!("{old_pid}.json"))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .any(|s| s["sessionId"] == session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, args: &str) -> Process {
        Process {
            pid,
            parent: Some(parent),
            args: args.split(' ').map(str::to_owned).collect(),
            cwd: Some(PathBuf::from("/work")),
            started: 0,
        }
    }

    /// A login shell (pid 10) in an iTerm tab (pid 1), plus `extra`.
    fn tab(extra: &[Process]) -> Vec<Process> {
        let mut processes = vec![
            process(1, 0, "/Applications/iTerm.app/Contents/MacOS/iTerm2"),
            process(9, 1, "/usr/bin/login -fqpl dom"),
            process(10, 9, "-nu"),
            process(20, 1, "/Users/dom/.local/bin/claude"), // another tab's agent
        ];
        processes.extend_from_slice(extra);
        processes
    }

    fn found(processes: &[Process]) -> String {
        match classify(10, processes) {
            Found::Shell => "shell".into(),
            Found::Zellij => "zellij".into(),
            Found::Agent(agent, process) => format!("{} {}", agent.name(), process.pid),
            Found::Other(reason) => reason,
        }
    }

    #[test]
    fn switchboard_absorb_classifies_what_runs_in_a_tab() {
        assert_eq!(found(&tab(&[])), "shell");
        // A profile that starts a program directly: there is no shell to type `exit` into.
        let direct = |args: &str| {
            let mut processes = tab(&[]);
            processes.retain(|p| p.pid != 10);
            processes.push(process(10, 9, args));
            found(&processes)
        };
        assert_eq!(
            direct("/Users/dom/.local/bin/claude"),
            "the tab runs claude, not a shell"
        );
        assert_eq!(
            direct("C:\\Tools\\zellij.exe attach main"),
            "the tab runs zellij, not a shell"
        );
        assert_eq!(direct("ssh box"), "the tab runs ssh, not a shell");
        assert_eq!(direct("C:\\PowerShell\\7\\pwsh.exe -NoLogo"), "shell");
        assert_eq!(direct("/bin/zsh -l"), "shell");
        let mut unreadable = tab(&[]);
        unreadable.retain(|p| p.pid != 10);
        assert_eq!(found(&unreadable), "can't tell what the tab runs");
        // Claude's MCP servers and tool commands run below it.
        let claude = [
            process(
                11,
                10,
                "/Users/dom/.local/bin/claude --dangerously-skip-permissions",
            ),
            process(12, 11, "npm exec @playwright/mcp@latest"),
            process(13, 12, "node playwright-mcp"),
            process(14, 11, "caffeinate -i -t 300"),
        ];
        assert_eq!(found(&tab(&claude)), "claude 11");
        // Windows: codex.exe under the npm shim under the shell.
        let codex = [
            process(11, 10, "C:\\Windows\\System32\\cmd.exe /c codex.cmd"),
            process(12, 11, "node.exe C:\\npm\\codex.js"),
            process(13, 12, "C:\\npm\\codex.exe"),
        ];
        assert_eq!(found(&tab(&codex)), "codex 13");
        // A nested agent below Claude is Claude's business.
        let nested = [process(11, 10, "claude"), process(12, 11, "claude -p hi")];
        assert_eq!(found(&tab(&nested)), "claude 11");
        let background = [process(11, 10, "claude"), process(15, 10, "sleep 100")];
        assert_eq!(found(&tab(&background)), "it also runs sleep");
        assert_eq!(
            found(&tab(&[process(11, 10, "zellij attach main")])),
            "zellij"
        );
        assert_eq!(found(&tab(&[process(11, 10, "ssh box")])), "it runs ssh");
        assert_eq!(
            found(&tab(&[process(11, 10, "vim notes.md")])),
            "it runs vim"
        );
    }

    const CLAUDE_IDLE: &str = "● Done.\n────\n❯ \n────\n  ⏵⏵ auto mode on";

    fn plan_one(home: &Path, extra: &[Process], screen: &str) -> Action {
        let tab = ForeignTab {
            id: "A".into(),
            title: "t".into(),
            shell_pid: 10,
        };
        let screen = screen.to_owned();
        plan_tab(&tab, &tab_processes(extra), home, &move || {
            Ok(screen.clone())
        })
    }

    fn tab_processes(extra: &[Process]) -> Vec<Process> {
        tab(extra)
    }

    #[test]
    fn switchboard_absorb_plans_claude_from_its_session_file() {
        let home = tempfile::tempdir().unwrap();
        let sessions = home.path().join(".claude/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let claude = [process(
            11,
            10,
            "/Users/dom/.local/bin/claude --dangerously-skip-permissions",
        )];
        assert_eq!(
            plan_one(home.path(), &claude, CLAUDE_IDLE),
            Action::Skip("Claude has no conversation yet".into())
        );
        let id = "b5eb3883-4bb6-44a0-b8e6-80625b93a4cc";
        for status in ["busy", "shell"] {
            std::fs::write(
                sessions.join("11.json"),
                json!({"pid":11,"sessionId":id,"cwd":"/proj","status":status}).to_string(),
            )
            .unwrap();
            assert_eq!(
                plan_one(home.path(), &claude, CLAUDE_IDLE),
                Action::Skip(format!("Claude is {status}"))
            );
        }
        std::fs::write(
            sessions.join("11.json"),
            json!({"pid":11,"sessionId":id,"cwd":"/proj","status":"idle"}).to_string(),
        )
        .unwrap();
        assert_eq!(
            plan_one(home.path(), &claude, CLAUDE_IDLE),
            Action::Agent {
                agent: AgentKind::Claude,
                pid: 11,
                session_id: Some(id.into()),
                cwd: "/proj".into(),
                launch: claude[0].args.clone(),
            }
        );
        // An initial prompt is not sent again.
        let prompted = [process(11, 10, "claude fix-the-bug")];
        assert!(matches!(
            plan_one(home.path(), &prompted, CLAUDE_IDLE),
            Action::Agent { agent, launch, cwd, .. }
                if resume(agent, &launch, id, &cwd).unwrap() == ["claude", "--resume", id]
        ));
    }

    #[test]
    fn switchboard_absorb_finds_codex_thread_by_folder_and_start() {
        let home = tempfile::tempdir().unwrap();
        let work = home.path().join("work");
        let day = home.path().join(".codex/sessions/2026/11/04");
        std::fs::create_dir_all(&work).unwrap();
        std::fs::create_dir_all(&day).unwrap();
        let rollout = |name: &str, id: &str, cwd: &Path| {
            let meta = json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}});
            std::fs::write(day.join(name), format!("{meta}\n{{}}\n")).unwrap();
        };
        let id = "01a1a607-29f9-7730-8ce6-8f9b156c2a0b";
        let mut codex = process(11, 10, "/Users/dom/.local/bin/codex");
        codex.cwd = Some(work.clone());
        // A Codex screen at its idle prompt (codex-cli 0.164).
        let idle = "• hi\n  Worked for 3s • 9:08 PM\n› Ask Codex to do anything\n  GPT-6.1-Sol high · /work\n  ← for agents · ? for shortcuts";
        let working = "• Working (3s • esc to interrupt)\n› \n  tab to queue message";

        assert_eq!(
            plan_one(home.path(), &[codex.clone()], idle),
            Action::Skip("Codex has no conversation yet".into())
        );
        rollout(
            "rollout-other.jsonl",
            "01a1a3aa-468b-7890-8cec-80861b965236",
            Path::new("/elsewhere"),
        );
        rollout(
            &format!("rollout-2026-11-04T21-07-29-{id}.jsonl"),
            id,
            &work,
        );
        // Which conversation is read from /status when applying.
        assert!(matches!(
            plan_one(home.path(), &[codex.clone()], idle),
            Action::Agent { session_id: None, agent, launch, cwd, .. }
                if resume(agent, &launch, id, &cwd).unwrap()
                    == ["/Users/dom/.local/bin/codex", "resume", id]
        ));
        assert_eq!(
            plan_one(home.path(), &[codex.clone()], working),
            Action::Skip("Codex is working".into())
        );
        // Older rollouts in the same folder are other conversations.
        codex.started = SystemTime_now() + 60;
        assert_eq!(
            plan_one(home.path(), &[codex.clone()], idle),
            Action::Skip("Codex has no conversation yet".into())
        );
        codex.started = 0;
        rollout(
            "rollout-second.jsonl",
            "01a1a3aa-468b-7890-8cec-80861b965237",
            &work,
        );
        assert!(matches!(
            plan_one(home.path(), &[codex], idle),
            Action::Agent {
                session_id: None,
                ..
            }
        ));
        assert!(rollout_exists(&home.path().join(".codex/sessions"), id));
        assert!(!rollout_exists(
            &home.path().join(".codex/sessions"),
            "01a1a644-18d0-7c31-9659-24d0587a92fa"
        ));
    }

    #[test]
    fn switchboard_absorb_reads_codex_status_card() {
        // codex-cli 0.164 /status, below an earlier card.
        let card = |id: &str| {
            format!("  Thread name:         Reply with alpha\n  Collaboration mode:  Default\n  Session:             {id}\n  Context window:      99% left (15.8K used / 475K)\n")
        };
        let old = "01a1a644-28d1-76e3-9ca8-a2c6f8e928f6";
        let new = "01a1a644-18d0-7c31-9659-24d0587a92fa";
        let screen = format!(
            "{}› reply\n{}› Ask Codex to do anything",
            card(old),
            card(new)
        );
        assert_eq!(status_sessions(&screen), [old, new]);
        assert!(status_sessions("Session: not-an-id").is_empty());
    }

    #[test]
    fn switchboard_absorb_sees_unsent_prompts() {
        let unsent = |line: &str| Err(format!("has unsent text: {line}"));
        let claude = |line: &str| {
            prompt_empty(
                AgentKind::Claude,
                &format!("● done\n───\n{line}\n───\n  ⏵⏵ auto mode on"),
            )
        };
        assert_eq!(claude("❯ "), Ok(()));
        assert_eq!(claude("❯ Try \"how do I log an error?\""), Ok(()));
        assert_eq!(claude("❯ fix the flaky test"), unsent("fix the flaky test"));
        assert_eq!(
            prompt_empty(AgentKind::Claude, "Do you trust this folder?"),
            Err("shows no prompt".into())
        );
        let codex = |line: &str| {
            prompt_empty(
                AgentKind::Codex,
                &format!("• hi\n{line}\n  GPT-6.1-Sol high · /w\n  ? for shortcuts"),
            )
        };
        assert_eq!(codex("› Ask Codex to do anything"), Ok(()));
        assert_eq!(codex("› "), Ok(()));
        assert_eq!(codex("› explain this repo"), unsent("explain this repo"));
    }

    #[allow(non_snake_case)]
    fn SystemTime_now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[test]
    fn switchboard_absorb_plans_shells_and_leaves_the_rest() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(
            plan_one(home.path(), &[], ""),
            Action::Shell {
                cwd: "/work".into()
            }
        );
        assert_eq!(
            plan_one(home.path(), &[process(11, 10, "zellij")], ""),
            Action::Skip("already Switchboard".into())
        );
        assert_eq!(
            plan_one(home.path(), &[process(11, 10, "copilot")], ""),
            Action::Skip("copilot can't be resumed here".into())
        );
    }
}
