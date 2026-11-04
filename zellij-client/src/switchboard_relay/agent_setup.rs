//! Whether this computer's coding agents report their own status to Switchboard, and
//! the one fixed setup per agent that makes them. Settings → Updates shows it for
//! every paired computer, next to the build this relay runs and its last self-update.
//!
//! Browsers and paired computers can only ask for an agent's setup by name. What it
//! runs is fixed here: the `switchboard` plugin for Claude Code and Copilot CLI, and
//! command hooks in `~/.codex/hooks.json` for Codex, whose plugins can't carry hooks.
use super::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex as SyncMutex},
    time::SystemTime,
};

const PLUGIN: &str = "switchboard@switchboard";
const REPO: &str = "domsleee/switchboard";
const SETUP_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Reports are saved at most this often per agent, so a restart keeps them.
const SAVE_EVERY_MS: u64 = 60_000;
/// The Codex events `attention::hook` reads, with the name Codex gives each in its
/// hook trust keys. Codex caps `Interrupt` and `SessionEnd` hooks at 3 seconds.
const CODEX_EVENTS: [(&str, &str, u64); 6] = [
    ("UserPromptSubmit", "user_prompt_submit", 5),
    ("PostToolUse", "post_tool_use", 5),
    ("PermissionRequest", "permission_request", 5),
    ("Stop", "stop", 5),
    ("Interrupt", "interrupt", 3),
    ("SessionEnd", "session_end", 3),
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Agent {
    Claude,
    Copilot,
    Codex,
}

impl Agent {
    const ALL: [Agent; 3] = [Agent::Claude, Agent::Copilot, Agent::Codex];

    fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Copilot => "copilot",
            Agent::Codex => "codex",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Copilot => "Copilot CLI",
            Agent::Codex => "Codex",
        }
    }

    fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|agent| agent.id() == id)
    }

    /// The agent's own settings folder, which it creates on first run.
    fn home(self) -> PathBuf {
        let (variable, folder) = match self {
            Agent::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
            Agent::Copilot => ("COPILOT_HOME", ".copilot"),
            Agent::Codex => ("CODEX_HOME", ".codex"),
        };
        std::env::var_os(variable)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(folder))
    }
}

fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A JSON file, allowing the `//` comment lines Copilot puts at the top of its own.
fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    let body: String = text
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    serde_json::from_str(&body).ok()
}

/// Write through a temporary file, so an agent never reads half a settings file.
fn write_json(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.switchboard-tmp");
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    std::fs::write(&temporary, bytes).and_then(|_| std::fs::rename(&temporary, path))
}

/// Keep the user's file once, before Switchboard first changes it.
fn back_up(path: &Path) {
    let backup = path.with_extension("json.switchboard.bak");
    if path.is_file() && !backup.exists() {
        let _ = std::fs::copy(path, backup);
    }
}

// --- Finding agents -------------------------------------------------------------

/// Folders an agent's installer may use. The relay runs as a service, whose PATH
/// often lacks them, so they are searched after PATH and the PATH in tasks.json.
fn usual_folders() -> Vec<PathBuf> {
    let home = home();
    let mut folders = vec![
        home.join(".local").join("bin"),
        home.join(".claude").join("local"),
        home.join(".bun").join("bin"),
        home.join(".volta").join("bin"),
        home.join(".npm-global").join("bin"),
    ];
    if cfg!(windows) {
        for (variable, tail) in [
            ("APPDATA", vec!["npm"]),
            ("LOCALAPPDATA", vec!["Microsoft", "WinGet", "Links"]),
            ("LOCALAPPDATA", vec!["Programs", "copilot"]),
        ] {
            if let Some(base) = std::env::var_os(variable) {
                folders.push(tail.iter().fold(PathBuf::from(base), |p, c| p.join(c)));
            }
        }
    } else {
        folders.extend(
            ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
                .into_iter()
                .map(PathBuf::from),
        );
    }
    folders
}

/// Where to look for agents, in order: the relay's PATH, tasks.json's, then the usual folders.
fn search_path() -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    if let Some(path) = tasks::configured_path() {
        folders.extend(std::env::split_paths(&path));
    }
    folders.extend(usual_folders());
    let mut seen = std::collections::HashSet::new();
    folders.retain(|folder| !folder.as_os_str().is_empty() && seen.insert(folder.clone()));
    folders
}

fn find_program(name: &str, folders: &[PathBuf]) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{name}.{ext}"))
            .collect()
    } else {
        vec![name.to_string()]
    };
    folders
        .iter()
        .flat_map(|folder| names.iter().map(move |name| folder.join(name)))
        .find(|path| path.is_file())
}

// --- Checks -----------------------------------------------------------------------

#[derive(Debug, PartialEq)]
struct Check {
    /// `absent` (agent not installed), `setup`, `approve` (Codex hooks await trust) or `ready`.
    state: &'static str,
    detail: String,
}

impl Check {
    fn from_missing(missing: Vec<&str>) -> Self {
        if missing.is_empty() {
            Check {
                state: "ready",
                detail: "Plugin installed and auto-updating".into(),
            }
        } else {
            Check {
                state: "setup",
                detail: missing.join(" · "),
            }
        }
    }
}

fn check_claude(dir: &Path) -> Check {
    let installed = read_json(&dir.join("plugins").join("installed_plugins.json"))
        .and_then(|v| v["plugins"][PLUGIN].as_array().map(|a| !a.is_empty()))
        .unwrap_or(false);
    let settings = read_json(&dir.join("settings.json")).unwrap_or(Value::Null);
    let known =
        read_json(&dir.join("plugins").join("known_marketplaces.json")).unwrap_or(Value::Null);
    let automatic = settings["extraKnownMarketplaces"]["switchboard"]["autoUpdate"] == true
        || known["switchboard"]["autoUpdate"] == true;
    let mut missing = Vec::new();
    if !installed {
        missing.push("Plugin not installed");
    } else if settings["enabledPlugins"][PLUGIN] == false {
        missing.push("Plugin turned off");
    }
    if !automatic {
        missing.push("Auto-update off");
    }
    Check::from_missing(missing)
}

fn check_copilot(dir: &Path) -> Check {
    let plugin = read_json(&dir.join("config.json")).and_then(|config| {
        config["installedPlugins"]
            .as_array()?
            .iter()
            .find(|p| p["name"] == "switchboard" && p["marketplace"] == "switchboard")
            .cloned()
    });
    let settings = read_json(&dir.join("settings.json")).unwrap_or(Value::Null);
    let mut missing = Vec::new();
    match plugin {
        None => missing.push("Plugin not installed"),
        Some(plugin)
            if plugin["enabled"] == false || settings["enabledPlugins"][PLUGIN] == false =>
        {
            missing.push("Plugin turned off")
        },
        Some(_) => {},
    }
    if settings["extraKnownMarketplaces"]["switchboard"]["autoUpdate"] != true {
        missing.push("Auto-update off");
    }
    Check::from_missing(missing)
}

/// The launcher Codex hooks run. Its path never changes, so the hook text Codex was
/// asked to trust stays the same across updates; on Windows each release runs from
/// its own folder. The relay rewrites it at startup to run its current executable.
pub(super) fn codex_launcher(home: &Path) -> PathBuf {
    home.join(".local")
        .join("share")
        .join("switchboard")
        .join(if cfg!(windows) {
            "codex-agent-hook.cmd"
        } else {
            "codex-agent-hook"
        })
}

fn launcher_text(binary: &Path) -> String {
    let binary = binary.to_string_lossy();
    if cfg!(windows) {
        format!(
            "@\"{}\" agent-hook --agent codex\r\n",
            binary.replace('%', "%%")
        )
    } else {
        format!(
            "#!/bin/sh\nexec '{}' agent-hook --agent codex\n",
            binary.replace('\'', "'\\''")
        )
    }
}

/// Point the launcher at `binary`, rewriting it only when its text changed.
pub(super) fn install_codex_launcher(home: &Path, binary: &Path) -> std::io::Result<()> {
    let path = codex_launcher(home);
    let text = launcher_text(binary);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    let staged = path.with_extension("switchboard-tmp");
    std::fs::write(&staged, text)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&staged, &path)
}

/// Codex hooks run through a shell, as `zellij agent-resume install`'s do; Windows
/// PowerShell gets the payload as UTF-8 and pipes it to the launcher.
fn codex_command(launcher: &Path) -> String {
    let launcher = launcher.to_string_lossy();
    if cfg!(windows) {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let script = format!(
            "$utf8=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$utf8; $OutputEncoding=$utf8; $payload=[Console]::In.ReadToEnd(); $payload | & '{}'; exit 0",
            launcher.replace('\'', "''")
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            STANDARD.encode(bytes)
        )
    } else {
        format!("'{}'", launcher.replace('\'', "'\\''"))
    }
}

/// Switchboard's Codex hooks: the launcher, or an executable named directly, as the
/// first builds did.
fn is_codex_hook(command: &str) -> bool {
    let ours = |text: &str| {
        text.contains(" agent-hook --agent codex") || text.contains("codex-agent-hook")
    };
    if ours(command) {
        return true;
    }
    use base64::{engine::general_purpose::STANDARD, Engine};
    command
        .split_once(" -EncodedCommand ")
        .and_then(|(_, encoded)| STANDARD.decode(encoded.trim()).ok())
        .is_some_and(|bytes| {
            let words: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|w| u16::from_le_bytes([w[0], w[1]]))
                .collect();
            ours(&String::from_utf16_lossy(&words))
        })
}

/// Where each of Switchboard's Codex hooks sits: (event, group index, hook index, command).
fn codex_hooks(config: &Value) -> Vec<(&'static str, usize, usize, String)> {
    let mut found = Vec::new();
    for (event, _, _) in CODEX_EVENTS {
        let groups = config["hooks"][event]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for (g, group) in groups.iter().enumerate() {
            for (h, hook) in group["hooks"].as_array().into_iter().flatten().enumerate() {
                if let Some(command) = hook["command"].as_str().filter(|c| is_codex_hook(c)) {
                    found.push((event, g, h, command.to_string()));
                }
            }
        }
    }
    found
}

/// Codex runs a new or changed hook only after the user trusts it, recording
/// `[hooks.state."<hooks.json>:<event>:<group>:<hook>"]` in config.toml.
fn codex_trusted(dir: &Path, hooks_file: &Path, event: &str, group: usize, hook: usize) -> bool {
    let snake = CODEX_EVENTS
        .iter()
        .find(|(name, _, _)| *name == event)
        .map_or("", |(_, snake, _)| *snake);
    let Ok(text) = std::fs::read_to_string(dir.join("config.toml")) else {
        return false;
    };
    let Ok(config) = text.parse::<toml::Table>() else {
        return false;
    };
    let suffix = format!(":{snake}:{group}:{hook}");
    config
        .get("hooks")
        .and_then(|h| h.get("state"))
        .and_then(|s| s.as_table())
        .is_some_and(|state| {
            state.iter().any(|(key, value)| {
                key.strip_suffix(&suffix)
                    .is_some_and(|file| same_path(Path::new(file), hooks_file))
                    && value.get("trusted_hash").is_some()
            })
        })
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .replace('/', "\\")
            .eq_ignore_ascii_case(&b.to_string_lossy().replace('/', "\\"))
    } else {
        a == b
    }
}

fn check_codex(dir: &Path, launcher: &Path, reported_since_setup: bool) -> Check {
    let file = dir.join("hooks.json");
    let config = read_json(&file).unwrap_or(Value::Null);
    let hooks = codex_hooks(&config);
    let expected = codex_command(launcher);
    let complete = CODEX_EVENTS.iter().all(|(event, _, _)| {
        hooks
            .iter()
            .any(|(e, _, _, command)| e == event && *command == expected)
    });
    if hooks.is_empty() {
        return Check {
            state: "setup",
            detail: "Status hooks not installed".into(),
        };
    }
    if !complete {
        return Check {
            state: "setup",
            detail: "Status hooks are out of date".into(),
        };
    }
    if !launcher.is_file() {
        return Check {
            state: "setup",
            detail: "Status hook launcher missing".into(),
        };
    }
    let trusted = hooks
        .iter()
        .all(|(event, g, h, _)| codex_trusted(dir, &file, event, *g, *h));
    if trusted || reported_since_setup {
        Check {
            state: "ready",
            detail: "Status hooks installed and trusted".into(),
        }
    } else {
        Check {
            state: "approve",
            detail: "Start Codex and choose “Trust all and continue” when it asks to review hooks"
                .into(),
        }
    }
}

// --- Setup ------------------------------------------------------------------------

/// Set `extraKnownMarketplaces.switchboard.autoUpdate`, adding the marketplace entry
/// with `source` if the agent's `marketplace add` did not write one.
fn turn_on_auto_update(settings_file: &Path, source: Value) -> Result<(), String> {
    let mut settings = match std::fs::read_to_string(settings_file) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("{} is not valid JSON: {e}", settings_file.display()))?,
        Err(_) => json!({}),
    };
    if !settings.is_object() {
        return Err(format!("{} is not a JSON object", settings_file.display()));
    }
    let markets = settings
        .as_object_mut()
        .unwrap()
        .entry("extraKnownMarketplaces")
        .or_insert_with(|| json!({}));
    let Some(markets) = markets.as_object_mut() else {
        return Err("extraKnownMarketplaces is not an object".into());
    };
    let entry = markets
        .entry("switchboard")
        .or_insert_with(|| json!({ "source": source }));
    if entry["autoUpdate"] == true {
        return Ok(());
    }
    let Some(entry) = entry.as_object_mut() else {
        return Err("extraKnownMarketplaces.switchboard is not an object".into());
    };
    entry.insert("autoUpdate".into(), json!(true));
    back_up(settings_file);
    write_json(settings_file, &settings)
        .map_err(|e| format!("Could not save {}: {e}", settings_file.display()))
}

/// Replace Switchboard's Codex hooks with current ones, keeping every other hook.
fn install_codex_hooks(file: &Path, command: &str) -> Result<(), String> {
    let mut config = match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("{} is not valid JSON: {e}", file.display()))?,
        Err(_) => json!({}),
    };
    let Some(root) = config.as_object_mut() else {
        return Err(format!("{} is not a JSON object", file.display()));
    };
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let Some(hooks) = hooks.as_object_mut() else {
        return Err("hooks is not an object".into());
    };
    for (event, _, timeout) in CODEX_EVENTS {
        let groups = hooks.entry(event).or_insert_with(|| json!([]));
        let Some(groups) = groups.as_array_mut() else {
            return Err(format!("hooks.{event} is not a list"));
        };
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = list.len();
            list.retain(|hook| !hook["command"].as_str().is_some_and(is_codex_hook));
            !(before > 0 && list.is_empty())
        });
        groups
            .push(json!({"hooks": [{"type": "command", "command": command, "timeout": timeout}]}));
    }
    back_up(file);
    write_json(file, &config).map_err(|e| format!("Could not save {}: {e}", file.display()))
}

/// Run one of the agent's own commands, failing with the end of its output.
async fn run(program: &Path, args: &[&str], folders: &[PathBuf]) -> Result<(), String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .current_dir(home())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Ok(path) = std::env::join_paths(folders) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let shown = format!(
        "{} {}",
        program.file_stem().unwrap_or_default().to_string_lossy(),
        args.join(" ")
    );
    let output = match tokio::time::timeout(SETUP_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(format!("{shown}: {error}")),
        Err(_) => return Err(format!("{shown}: timed out")),
    };
    if output.status.success() {
        return Ok(());
    }
    let text = String::from_utf8_lossy(if output.stderr.is_empty() {
        &output.stdout
    } else {
        &output.stderr
    })
    .into_owned();
    let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(3)..].join(" / ");
    Err(format!("{shown} failed: {tail}"))
}

async fn set_up(agent: Agent) -> Result<(), String> {
    let folders = search_path();
    let dir = agent.home();
    match agent {
        Agent::Claude => {
            let claude = find_program("claude", &folders).ok_or("Claude Code not found")?;
            let known = read_json(&dir.join("plugins").join("known_marketplaces.json"))
                .unwrap_or(Value::Null);
            if known.get("switchboard").is_none() {
                run(
                    &claude,
                    &[
                        "plugin",
                        "marketplace",
                        "add",
                        REPO,
                        "--sparse",
                        ".claude-plugin",
                        "plugins",
                    ],
                    &folders,
                )
                .await?;
            }
            let check = check_claude(&dir);
            if check.detail.contains("not installed") {
                run(
                    &claude,
                    &["plugin", "install", PLUGIN, "--scope", "user"],
                    &folders,
                )
                .await?;
            } else if check.detail.contains("turned off") {
                run(&claude, &["plugin", "enable", PLUGIN], &folders).await?;
            }
            turn_on_auto_update(
                &dir.join("settings.json"),
                json!({"source": "github", "repo": REPO, "sparsePaths": [".claude-plugin", "plugins"]}),
            )
        },
        Agent::Copilot => {
            let copilot = find_program("copilot", &folders).ok_or("Copilot CLI not found")?;
            let settings = read_json(&dir.join("settings.json")).unwrap_or(Value::Null);
            if settings["extraKnownMarketplaces"]
                .get("switchboard")
                .is_none()
            {
                run(&copilot, &["plugin", "marketplace", "add", REPO], &folders).await?;
            }
            let check = check_copilot(&dir);
            if check.detail.contains("not installed") {
                run(&copilot, &["plugin", "install", PLUGIN], &folders).await?;
            } else if check.detail.contains("turned off") {
                run(&copilot, &["plugin", "enable", PLUGIN], &folders).await?;
            }
            turn_on_auto_update(
                &dir.join("settings.json"),
                json!({"source": "github", "repo": REPO}),
            )
        },
        Agent::Codex => {
            let binary = control::own_executable()
                .map_err(|e| format!("Cannot find Switchboard's executable: {e}"))?;
            install_codex_launcher(&home(), &binary)
                .map_err(|e| format!("Could not write the Codex hook launcher: {e}"))?;
            install_codex_hooks(
                &dir.join("hooks.json"),
                &codex_command(&codex_launcher(&home())),
            )
        },
    }
}

#[derive(Clone, Default)]
struct Setup {
    running: bool,
    finished: Option<u64>,
    error: Option<String>,
}

static SETUPS: SyncMutex<BTreeMap<&'static str, Setup>> = SyncMutex::new(BTreeMap::new());

/// Start an agent's setup in the background; the status shows it running, then its result.
fn start_setup(id: &str) -> Result<(), (StatusCode, String)> {
    let agent = Agent::parse(id).ok_or((StatusCode::BAD_REQUEST, "Unknown agent".to_string()))?;
    if describe(agent)["state"] == "absent" {
        return Err((
            StatusCode::CONFLICT,
            format!("{} is not installed on this computer", agent.name()),
        ));
    }
    {
        let mut setups = SETUPS.lock().unwrap();
        let setup = setups.entry(agent.id()).or_default();
        if setup.running {
            return Err((StatusCode::CONFLICT, "Setup is already running".into()));
        }
        setup.running = true;
    }
    tokio::spawn(async move {
        let result = set_up(agent).await;
        if let Err(error) = &result {
            log::warn!("{} setup failed: {error}", agent.name());
        }
        SETUPS.lock().unwrap().insert(
            agent.id(),
            Setup {
                running: false,
                finished: Some(now()),
                error: result.err(),
            },
        );
    });
    Ok(())
}

// --- Reports ----------------------------------------------------------------------

/// Tests never read or write the user's real file.
fn reports_file() -> Option<PathBuf> {
    (!cfg!(test)).then(|| {
        home()
            .join(".config")
            .join("switchboard")
            .join("agent-reports.json")
    })
}

/// When each agent last reported through a hook, kept across relay restarts.
static HEARD: LazyLock<SyncMutex<BTreeMap<String, u64>>> = LazyLock::new(|| {
    SyncMutex::new(
        reports_file()
            .and_then(|file| read_json(&file))
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default(),
    )
});

/// Called for each hook event from a Zellij pane.
pub(super) fn heard(agent: &str) {
    let at = now();
    let mut heard = HEARD.lock().unwrap();
    let previous = heard.insert(agent.to_string(), at).unwrap_or(0);
    if let Some(file) = reports_file().filter(|_| at.saturating_sub(previous) >= SAVE_EVERY_MS) {
        let snapshot = json!(*heard);
        tokio::task::spawn_blocking(move || {
            let _ = write_json(&file, &snapshot);
        });
    }
}

fn last_report(agent: Agent) -> Option<u64> {
    HEARD.lock().unwrap().get(agent.id()).copied()
}

// --- Status -----------------------------------------------------------------------

fn describe(agent: Agent) -> Value {
    let folders = search_path();
    let program = find_program(agent.id(), &folders);
    let dir = agent.home();
    let setup = SETUPS
        .lock()
        .unwrap()
        .get(agent.id())
        .cloned()
        .unwrap_or_default();
    let report = last_report(agent);
    // A program without its settings folder has never run, e.g. a launcher that
    // offers to install the real agent.
    let check = if program.is_none() || !dir.is_dir() {
        Check {
            state: "absent",
            detail: "Not installed".into(),
        }
    } else {
        match agent {
            Agent::Claude => check_claude(&dir),
            Agent::Copilot => check_copilot(&dir),
            Agent::Codex => {
                let since = setup.finished.unwrap_or(0);
                check_codex(
                    &dir,
                    &codex_launcher(&home()),
                    report.is_some_and(|at| at > since),
                )
            },
        }
    };
    json!({
        "agent": agent.id(),
        "name": agent.name(),
        "state": if setup.running { "running" } else { check.state },
        "detail": if setup.running { "Setting up…".to_string() } else { check.detail },
        "lastReport": report,
        "setupError": setup.error,
        "setupFinished": setup.finished,
    })
}

/// Whether this computer's automatic Switchboard update is switched on: the systemd
/// user timer is enabled on Linux, the LaunchAgent is loaded on macOS, and on Windows
/// the tray, which runs the update checks, holds its single-instance mutex.
fn automatic_updates() -> bool {
    #[cfg(target_os = "linux")]
    {
        home()
            .join(".config/systemd/user/timers.target.wants/switchboard-update.timer")
            .exists()
    }
    #[cfg(target_os = "macos")]
    {
        home()
            .join("Library/LaunchAgents/dev.switchboard.update.plist")
            .is_file()
            && std::process::Command::new("launchctl")
                .arg("print")
                .arg(format!(
                    "gui/{}/dev.switchboard.update",
                    nix::unistd::getuid()
                ))
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::OpenMutexW};
        const SYNCHRONIZE: u32 = 0x0010_0000;
        let name: Vec<u16> = "Local\\SwitchboardTray".encode_utf16().chain([0]).collect();
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
        let handle = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
        if handle.is_null() {
            return false;
        }
        // SAFETY: `handle` was just opened and is closed once.
        unsafe { CloseHandle(handle) };
        true
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        false
    }
}

/// The build this relay runs and whether it updates itself.
fn switchboard() -> Value {
    json!({
        "commit": env!("SWITCHBOARD_COMMIT"),
        "commitDate": env!("SWITCHBOARD_COMMIT_DATE"),
        "automaticUpdates": automatic_updates(),
    })
}

/// This computer's part of `/api/tasks`.
pub(super) fn status() -> (Value, Value) {
    (
        switchboard(),
        Value::Array(Agent::ALL.into_iter().map(describe).collect()),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SetupRequest {
    #[serde(default)]
    pub(super) host: Option<String>,
    pub(super) agent: String,
}

pub(super) fn set_up_locally(request: &SetupRequest) -> Response {
    match start_setup(&request.agent) {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({"ok": true}))).into_response(),
        Err((status, error)) => (status, Json(json!({ "error": error }))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn switchboard_agent_setup_reads_claude_plugin_state() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        assert_eq!(
            check_claude(dir).detail,
            "Plugin not installed · Auto-update off"
        );
        write(
            &dir.join("plugins/installed_plugins.json"),
            r#"{"version":2,"plugins":{"switchboard@switchboard":[{"scope":"user"}]}}"#,
        );
        write(
            &dir.join("settings.json"),
            r#"{"enabledPlugins":{"switchboard@switchboard":false}}"#,
        );
        assert_eq!(
            check_claude(dir).detail,
            "Plugin turned off · Auto-update off"
        );
        write(
            &dir.join("plugins/known_marketplaces.json"),
            r#"{"switchboard":{"autoUpdate":true}}"#,
        );
        write(
            &dir.join("settings.json"),
            r#"{"enabledPlugins":{"switchboard@switchboard":true}}"#,
        );
        assert_eq!(check_claude(dir).state, "ready");
    }

    #[test]
    fn switchboard_agent_setup_reads_copilot_config_with_comments() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        // Copilot CLI 1.0.105 after `plugin marketplace add` and `plugin install`.
        write(
            &dir.join("config.json"),
            "// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  \"installedPlugins\": [{\"name\": \"switchboard\", \"marketplace\": \"switchboard\", \"enabled\": true}]\n}\n",
        );
        write(
            &dir.join("settings.json"),
            r#"{"extraKnownMarketplaces":{"switchboard":{"source":{"source":"github","repo":"domsleee/switchboard"}}},"enabledPlugins":{"switchboard@switchboard":true}}"#,
        );
        assert_eq!(check_copilot(dir).detail, "Auto-update off");
        turn_on_auto_update(&dir.join("settings.json"), json!({})).unwrap();
        assert_eq!(check_copilot(dir).state, "ready");
        let settings = read_json(&dir.join("settings.json")).unwrap();
        assert_eq!(
            settings["extraKnownMarketplaces"]["switchboard"]["source"]["repo"],
            REPO
        );
        assert_eq!(settings["enabledPlugins"][PLUGIN], true);
        assert!(dir.join("settings.json.switchboard.bak").is_file());
    }

    #[test]
    fn switchboard_agent_setup_installs_codex_hooks_beside_others_and_waits_for_trust() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        let file = dir.join("hooks.json");
        let launcher = codex_launcher(dir);
        let command = codex_command(&launcher);
        write(
            &file,
            r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"'/z' agent-resume record --agent codex","timeout":10}]}],"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}"#,
        );
        assert_eq!(check_codex(dir, &launcher, false).state, "setup");
        install_codex_hooks(&file, &command).unwrap();
        assert_eq!(
            check_codex(dir, &launcher, false).detail,
            "Status hook launcher missing"
        );
        install_codex_launcher(dir, Path::new("/opt/switch board/zellij")).unwrap();
        // Installing again replaces Switchboard's hooks instead of adding more.
        install_codex_hooks(&file, &command).unwrap();
        let config = read_json(&file).unwrap();
        assert_eq!(
            config["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "'/z' agent-resume record --agent codex"
        );
        assert_eq!(config["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            config["hooks"]["Stop"][0]["hooks"][0]["command"],
            "say done"
        );
        assert_eq!(config["hooks"]["Interrupt"][0]["hooks"][0]["timeout"], 3);
        assert_eq!(codex_hooks(&config).len(), CODEX_EVENTS.len());

        let check = check_codex(dir, &launcher, false);
        assert_eq!(check.state, "approve", "{check:?}");
        assert_eq!(
            check_codex(dir, &launcher, true).state,
            "ready",
            "a report proves trust"
        );
        // Codex 0.164 records trust per hook position after "Trust all and continue".
        let state: String = codex_hooks(&config)
            .iter()
            .map(|(event, g, h, _)| {
                let snake = CODEX_EVENTS.iter().find(|e| e.0 == *event).unwrap().1;
                // A TOML string escapes the backslashes of a Windows path, as Codex writes it.
                format!(
                    "[hooks.state.\"{}:{snake}:{g}:{h}\"]\ntrusted_hash = \"sha256:00\"\n\n",
                    file.display().to_string().replace('\\', "\\\\")
                )
            })
            .collect();
        write(
            &dir.join("config.toml"),
            &format!("[tui]\nscreen_reader_detection_done = true\n\n[hooks.state]\n\n{state}"),
        );
        assert_eq!(check_codex(dir, &launcher, false).state, "ready");
        // An update moves the executable (Windows runs each release from its own
        // folder): only the launcher changes, so the trusted hooks stay ready.
        install_codex_launcher(dir, Path::new("/releases/abc123/zellij")).unwrap();
        assert!(std::fs::read_to_string(&launcher)
            .unwrap()
            .contains("/releases/abc123/zellij"));
        assert_eq!(read_json(&file).unwrap(), config);
        assert_eq!(check_codex(dir, &launcher, false).state, "ready");
        // Hooks from the first builds named the executable directly; setup replaces them.
        let old = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'/z' agent-hook --agent codex"}]}]}}"#;
        write(&file, old);
        assert_eq!(
            check_codex(dir, &launcher, false).detail,
            "Status hooks are out of date"
        );
        install_codex_hooks(&file, &command).unwrap();
        assert_eq!(
            codex_hooks(&read_json(&file).unwrap()).len(),
            CODEX_EVENTS.len()
        );
    }

    #[test]
    fn switchboard_agent_setup_recognises_its_codex_hook_on_windows() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let script = "$payload | & 'C:\\Users\\a\\zellij.exe' agent-hook --agent codex; exit 0";
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let command = format!(
            "powershell.exe -NoLogo -EncodedCommand {}",
            STANDARD.encode(bytes)
        );
        assert!(is_codex_hook(&command));
        assert!(is_codex_hook(&codex_command(&codex_launcher(Path::new(
            "/home/a"
        )))));
        assert!(!is_codex_hook("'/z' agent-resume record --agent codex"));
    }

    #[test]
    fn switchboard_agent_setup_refuses_to_overwrite_invalid_files() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("hooks.json");
        write(&file, "{not json");
        assert!(install_codex_hooks(&file, "x agent-hook --agent codex").is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{not json");
        let settings = dir.path().join("settings.json");
        write(&settings, "[]");
        assert!(turn_on_auto_update(&settings, json!({})).is_err());
    }

    #[test]
    fn switchboard_agent_setup_finds_programs_in_given_folders() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) {
            "claude.cmd"
        } else {
            "claude"
        };
        write(&dir.path().join(name), "");
        let folders = vec![dir.path().join("missing"), dir.path().to_path_buf()];
        assert_eq!(
            find_program("claude", &folders),
            Some(dir.path().join(name))
        );
        assert_eq!(find_program("codex", &folders), None);
    }
}
