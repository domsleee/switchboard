//! Whether this computer's coding agents report their own status to Switchboard, and
//! the one fixed setup per agent that makes them. Settings → Updates shows it for
//! every paired computer, next to the build this relay runs and its last self-update.
//!
//! Browsers and paired computers can only ask for an agent's setup by name. What it
//! runs is fixed here: the `switchboard` plugin for Claude Code, Copilot CLI and Codex.
mod dotfiles;

use super::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex as SyncMutex},
    time::SystemTime,
};

const PLUGIN: &str = "switchboard@switchboard";
const CODEX_HOOK_SOURCE: &str = "switchboard@switchboard:hooks/codex.json";
const REPO: &str = "domsleee/switchboard";
const SETUP_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Reports are saved at most this often per agent, so a restart keeps them.
const SAVE_EVERY_MS: u64 = 60_000;
/// The Codex events `attention::hook` reads, with the name Codex gives each in its
/// hook trust keys. Codex caps `Interrupt` and `SessionEnd` hooks at 3 seconds.
const CODEX_EVENTS: [(&str, &str, u64); 7] = [
    ("SessionStart", "session_start", 5),
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
            ("LOCALAPPDATA", vec!["Programs", "OpenAI", "Codex", "bin"]),
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

pub(crate) fn find_program(name: &str, folders: &[PathBuf]) -> Option<PathBuf> {
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

/// Queue text as argv, never through Windows batch-file shell interpretation.
pub(super) fn codex_queue_program() -> Option<(PathBuf, std::ffi::OsString)> {
    agent_program("codex")
}

pub(super) fn agent_program(agent: &str) -> Option<(PathBuf, std::ffi::OsString)> {
    let folders = search_path();
    let name = if cfg!(windows) {
        format!("{agent}.exe")
    } else {
        agent.to_owned()
    };
    let program = folders
        .iter()
        .map(|p| p.join(&name))
        .find(|p| p.is_file())?;
    Some((program, std::env::join_paths(folders).ok()?))
}

// --- Checks -----------------------------------------------------------------------

// Inspect package metadata, not the launcher extension: custom wrappers are not npm.
fn codex_installation(program: Option<&Path>, windows: bool) -> Value {
    if !windows {
        return Value::Null;
    }
    let Some(program) = program else {
        return Value::Null;
    };
    let is_codex_package =
        |path: &Path| read_json(path).is_some_and(|package| package["name"] == "@openai/codex");
    let npm = program.parent().is_some_and(|directory| {
        is_codex_package(&directory.join("node_modules/@openai/codex/package.json"))
    }) || program
        .ancestors()
        .skip(1)
        .take(12)
        .any(|directory| is_codex_package(&directory.join("package.json")));
    if !npm {
        return Value::Null;
    }
    json!({
        "state": "attention",
        "manager": "npm",
        "path": program,
        "detail": "Codex uses an npm installation on Windows. Updates can fail with EBUSY while Codex sessions are running, leaving repeated update prompts. Use the standalone Windows installer from a new PowerShell window, remove the npm installation after its sessions exit, and check that Get-Command codex selects the standalone installation.",
        "command": "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\""
    })
}

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
                detail: "Plugin installed · auto-updates enabled".into(),
            }
        } else {
            Check {
                state: "setup",
                detail: missing.join(" · "),
            }
        }
    }
}

fn claude_command(hook: &Value, wait: bool) -> bool {
    let Some(command) = hook["command"].as_str() else {
        return false;
    };
    let arguments = if wait {
        json!(["agent-hook", "--agent", "claude", "--wait"])
    } else {
        json!(["agent-hook", "--agent", "claude"])
    };
    if let Some(args) = hook.get("args") {
        let executable = command.rsplit(['/', '\\']).next().unwrap_or(command);
        (executable.eq_ignore_ascii_case("zellij") || executable.eq_ignore_ascii_case("zellij.exe"))
            && *args == arguments
    } else {
        let suffix = if wait { " --wait" } else { "" };
        command == format!("zellij agent-hook --agent claude{suffix}")
    }
}

fn claude_http(hook: &Value) -> bool {
    hook["type"] == "http"
        && hook["url"] == "http://127.0.0.1:8090/api/agent-hook/claude"
        && [
            ("X-Zellij-Session", "ZELLIJ_SESSION_NAME"),
            ("X-Zellij-Pane", "ZELLIJ_PANE_ID"),
            ("X-Claudecode", "CLAUDECODE"),
            ("X-Claude-Entrypoint", "CLAUDE_CODE_ENTRYPOINT"),
        ]
        .iter()
        .all(|(header, var)| {
            hook["headers"][*header] == format!("${var}")
                && hook["allowedEnvVars"]
                    .as_array()
                    .is_some_and(|vars| vars.iter().any(|v| v == var))
        })
}

fn prompt_recovery_hook(hook: &Value) -> bool {
    hook["command"].as_str().is_some_and(|command| {
        zellij_utils::agent_resumption::recovery_hook(
            command,
            zellij_utils::agent_resumption::AgentKind::Claude,
        )
    })
}

fn has_prompt_recovery(settings: &Value) -> bool {
    settings["hooks"]["UserPromptSubmit"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
        .any(prompt_recovery_hook)
}

fn remove_prompt_recovery(file: &Path) -> Result<(), String> {
    let mut settings = read_json(file).ok_or("Cannot read Claude settings")?;
    if !has_prompt_recovery(&settings) {
        return Ok(());
    }
    let groups = settings["hooks"]["UserPromptSubmit"]
        .as_array_mut()
        .unwrap();
    for group in groups.iter_mut() {
        if let Some(hooks) = group["hooks"].as_array_mut() {
            hooks.retain(|hook| !prompt_recovery_hook(hook));
        }
    }
    groups.retain(|group| !group["hooks"].as_array().is_some_and(Vec::is_empty));
    back_up(file);
    write_json(file, &settings).map_err(|e| e.to_string())
}

/// Check the reporting and message-delivery contract, not a plugin revision:
/// plugin managers can install a newer compatible version before the relay updates.
fn claude_hooks_complete(plugin: &Path) -> bool {
    let config = read_json(&plugin.join("hooks/hooks.json")).unwrap_or(Value::Null);
    let handlers = |event: &str| {
        config["hooks"][event]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|group| {
                group
                    .get("matcher")
                    .is_none_or(|matcher| matches!(matcher.as_str(), Some("" | "*")))
            })
            .flat_map(|group| group["hooks"].as_array().into_iter().flatten())
            .filter(|hook| hook["if"].is_null())
            .collect::<Vec<_>>()
    };
    [
        "SessionStart",
        "UserPromptSubmit",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionRequest",
        "Notification",
        "Stop",
        "StopFailure",
        "SessionEnd",
    ]
    .iter()
    .all(|event| {
        handlers(event).iter().any(|hook| {
            (claude_command(hook, false) || (*event != "SessionStart" && claude_http(hook)))
                && hook["async"] != true
                && hook["asyncRewake"] != true
        })
    }) && ["SessionStart", "Stop"].iter().all(|event| {
        handlers(event).iter().any(|hook| {
            claude_command(hook, true)
                && hook["asyncRewake"] == true
                && hook["timeout"]
                    .as_u64()
                    .is_some_and(|timeout| timeout >= crate::message_board::hooks::WATCH_TIMEOUT)
        })
    })
}

/// The `zellij` that command hooks and agents run. Tests never read or replace the real one.
fn path_copy() -> Option<PathBuf> {
    (cfg!(windows) && !cfg!(test)).then(|| home().join(".cargo/bin/zellij.exe"))
}

/// A file that cannot start at all. Reads the header instead of running it: this happens
/// on every status request, and starting a process can be slow under Defender.
fn path_copy_damaged(path: &Path) -> bool {
    use std::io::Read;
    let mut header = [0; 2];
    std::fs::File::open(path)
        .is_ok_and(|mut file| file.read_exact(&mut header).is_err() || header != *b"MZ")
}

/// A damaged copy replaces a check that has no list of missing pieces to add it to.
fn with_path_copy_damage(check: Check, path: Option<&Path>) -> Check {
    let mut missing = Vec::new();
    note_damaged_path_copy(path, &mut missing);
    if missing.is_empty() {
        check
    } else {
        Check::from_missing(missing)
    }
}

fn note_damaged_path_copy(path: Option<&Path>, missing: &mut Vec<&str>) {
    if path.is_some_and(path_copy_damaged) {
        missing.push("zellij on PATH is damaged, so session-start hooks and messages fail");
    }
}

/// Swaps in a working copy. The damaged file is retired, as the updater's PATH sync does.
fn replace_path_copy(path: &Path, binary: &Path) -> Result<(), String> {
    let directory = path.parent().ok_or("zellij on PATH has no folder")?;
    let id = format!("{}-{}", std::process::id(), now());
    let staged = directory.join(format!(".zellij-{id}.exe"));
    let retired = directory.join(format!("zellij.retired-{id}.exe"));
    let result = std::fs::copy(binary, &staged)
        .and_then(|_| std::fs::rename(path, &retired))
        .and_then(|()| {
            std::fs::rename(&staged, path).inspect_err(|_| {
                let _ = std::fs::rename(&retired, path);
            })
        });
    if result.is_err() {
        let _ = std::fs::remove_file(&staged);
    }
    result.map_err(|error| format!("Could not repair zellij on PATH: {error}"))
}

fn check_claude(dir: &Path) -> Check {
    let records = read_json(&dir.join("plugins/installed_plugins.json"))
        .and_then(|v| v["plugins"][PLUGIN].as_array().cloned())
        .unwrap_or_default();
    // The relay can inspect only the user-wide install. Project overrides belong to their session.
    let installed = records.iter().find(|v| v["scope"] == "user");
    let settings = read_json(&dir.join("settings.json")).unwrap_or(Value::Null);
    let known =
        read_json(&dir.join("plugins").join("known_marketplaces.json")).unwrap_or(Value::Null);
    let automatic = settings["extraKnownMarketplaces"]["switchboard"]["autoUpdate"]
        .as_bool()
        .unwrap_or(known["switchboard"]["autoUpdate"] == true);
    let mut missing = Vec::new();
    if installed.is_none() {
        missing.push("Plugin not installed");
    } else if settings["enabledPlugins"][PLUGIN] == false {
        missing.push("Plugin turned off");
    }
    if let Some(record) = installed {
        if !record["installPath"]
            .as_str()
            .is_some_and(|p| claude_hooks_complete(Path::new(p)))
        {
            missing.push("Reporting and message hooks missing or out of date");
        }
        if !record["installPath"]
            .as_str()
            .is_some_and(|p| super::agent_skills::plugin_complete(Path::new(p)))
        {
            missing.push("Plugin skills missing or unreadable");
        }
    }
    if !automatic {
        missing.push("Auto-update off");
    }
    if has_prompt_recovery(&settings) {
        missing.push("Slow recovery command runs on every prompt");
    }
    note_damaged_path_copy(path_copy().as_deref(), &mut missing);
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
    match &plugin {
        None => missing.push("Plugin not installed"),
        Some(plugin)
            if plugin["enabled"] == false || settings["enabledPlugins"][PLUGIN] == false =>
        {
            missing.push("Plugin turned off")
        },
        Some(_) => {},
    }
    if plugin.as_ref().is_some_and(|p| {
        !p["cache_path"]
            .as_str()
            .is_some_and(|root| super::agent_skills::plugin_complete(Path::new(root)))
    }) {
        missing.push("Plugin skills missing or unreadable");
    }
    if settings["extraKnownMarketplaces"]["switchboard"]["autoUpdate"] != true {
        missing.push("Auto-update off");
    }
    note_damaged_path_copy(path_copy().as_deref(), &mut missing);
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
            "@\"{}\" agent-hook --agent codex %*\r\n",
            binary.replace('%', "%%")
        )
    } else {
        format!(
            "#!/bin/sh\nexec '{}' agent-hook --agent codex \"$@\"\n",
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
#[cfg(test)]
fn codex_command(launcher: &Path) -> String {
    codex_command_with_wait(launcher, false)
}

#[cfg(test)]
fn codex_command_with_wait(launcher: &Path, wait: bool) -> String {
    let launcher = launcher.to_string_lossy();
    let args = if wait { " --wait" } else { "" };
    if cfg!(windows) {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let script = format!(
            "$utf8=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$utf8; $OutputEncoding=$utf8; $payload=[Console]::In.ReadToEnd(); $payload | & '{}'{args}; exit 0",
            launcher.replace('\'', "''")
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            STANDARD.encode(bytes)
        )
    } else {
        format!("'{}'{args}", launcher.replace('\'', "'\\''"))
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
/// `[hooks.state."switchboard@switchboard:hooks/codex.json:<event>:<group>:<hook>"]` in config.toml.
fn codex_trusted(dir: &Path, event: &str, group: usize, hook: usize) -> bool {
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
                key.strip_suffix(&suffix) == Some(CODEX_HOOK_SOURCE)
                    && value.get("trusted_hash").is_some()
                    && value.get("trusted_content_hash").is_some()
            })
        })
}

/// From Codex's `hooks/list` answer, the trust entries for Switchboard's own hooks that
/// Codex doesn't trust yet: `{key: {"trusted_hash": hash}}` for `hooks.state`.
fn codex_trust_edits(listed: &Value) -> serde_json::Map<String, Value> {
    listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .filter(|hook| is_codex_plugin_hook(hook))
        .filter(|hook| matches!(hook["trustStatus"].as_str(), Some("untrusted" | "modified")))
        .filter_map(|hook| {
            // Codex returns definition/content hashes joined by '/'; batchWrite
            // splits them into trusted_hash and trusted_content_hash itself.
            Some((
                hook["key"].as_str()?.to_owned(),
                json!({"trusted_hash": hook["currentHash"].as_str()?}),
            ))
        })
        .collect()
}

fn is_codex_plugin_hook(hook: &Value) -> bool {
    hook["key"]
        .as_str()
        .and_then(|key| key.strip_prefix(CODEX_HOOK_SOURCE))
        .is_some_and(|suffix| suffix.starts_with(':'))
}

/// Saved trust keys survive plugin updates and disabling individual hooks. Bind
/// Health's readiness to the exact plugin/config snapshot Codex actually checked.
fn codex_trust_fingerprint(dir: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    fn hash_files(path: &Path, hash: &mut Sha256) -> Option<()> {
        let mut entries = std::fs::read_dir(path)
            .ok()?
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            hash.update(entry.file_name().to_string_lossy().as_bytes());
            hash.update([0]);
            let kind = entry.file_type().ok()?;
            if kind.is_dir() {
                hash_files(&entry.path(), hash)?;
            } else if kind.is_file() {
                hash.update(std::fs::read(entry.path()).ok()?);
            } else {
                return None;
            }
            hash.update([0]);
        }
        Some(())
    }
    let text = std::fs::read_to_string(dir.join("config.toml")).ok()?;
    let config: toml::Table = text.parse().ok()?;
    let states = config.get("hooks")?.get("state")?.as_table()?;
    let ours: BTreeMap<_, _> = states
        .iter()
        .filter(|(key, _)| key.starts_with(CODEX_HOOK_SOURCE))
        .collect();
    let mut hash = Sha256::new();
    hash.update([u8::from(codex_hooks_enabled(&config))]);
    hash.update(serde_json::to_vec(&ours).ok()?);
    hash.update(serde_json::to_vec(config.get("plugins")?.get(PLUGIN)?).ok()?);
    hash_files(&codex_plugin_cache(dir), &mut hash)?;
    Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

fn codex_trust_proof_current(dir: &Path) -> bool {
    codex_trust_fingerprint(dir).is_some_and(|fingerprint| {
        read_json(&dir.join("plugins/switchboard-hook-trust.json"))
            .is_some_and(|proof| proof["fingerprint"] == fingerprint)
    })
}

/// A successful empty hooks/list is not proof that the installed plugin works.
fn codex_plugin_list_ready(listed: &Value, trusted: bool) -> bool {
    listed["data"].as_array().is_some_and(|entries| {
        !entries.is_empty()
            && entries.iter().all(|entry| {
                let switchboard: Vec<_> = entry["hooks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|hook| {
                        hook["key"]
                            .as_str()
                            .is_some_and(|key| key.starts_with("switchboard@switchboard:"))
                    })
                    .collect();
                entry["errors"].as_array().is_none_or(Vec::is_empty)
                    && switchboard.len() == CODEX_EVENTS.len() + 2
                    && switchboard.iter().all(|hook| is_codex_plugin_hook(hook))
                    && CODEX_EVENTS.iter().all(|(_, event, _)| {
                        let count = if matches!(*event, "session_start" | "stop") {
                            2
                        } else {
                            1
                        };
                        (0..count).all(|index| {
                            let key = format!("{CODEX_HOOK_SOURCE}:{event}:0:{index}");
                            entry["hooks"].as_array().into_iter().flatten().any(|hook| {
                                hook["key"] == key
                                    && hook["enabled"] != false
                                    && (!trusted || hook["trustStatus"] == "trusted")
                            })
                        })
                    })
            })
    })
}

/// Trust Switchboard's hooks the way Codex's own "Trust all and continue" does: ask
/// `codex app-server` for each hook's key and hash, then record those in config.toml.
/// Codex computes the hashes, and hooks other programs installed stay untrusted.
async fn trust_codex_hooks(codex: &Path, folders: &[PathBuf], dir: &Path) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let fail = |e: &dyn std::fmt::Display| format!("codex app-server: {e}");
    let mut command = tokio::process::Command::new(codex);
    command
        .arg("app-server")
        .env("CODEX_HOME", dir)
        .current_dir(home())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if let Ok(path) = std::env::join_paths(folders) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|e| fail(&e))?;
    let mut input = child.stdin.take().ok_or("codex app-server: no stdin")?;
    let mut output =
        BufReader::new(child.stdout.take().ok_or("codex app-server: no stdout")?).lines();
    let session = async {
        let mut id = 0;
        let mut call = async |method: &str, params: Value| -> Result<Value, String> {
            id += 1;
            let request = json!({"id": id, "method": method, "params": params});
            input
                .write_all(format!("{request}\n").as_bytes())
                .await
                .map_err(|e| fail(&e))?;
            if method == "initialize" {
                let initialized = json!({"method": "initialized"});
                input
                    .write_all(format!("{initialized}\n").as_bytes())
                    .await
                    .map_err(|e| fail(&e))?;
            }
            // Skip notifications until the answer to this request.
            loop {
                let line = output
                    .next_line()
                    .await
                    .map_err(|e| fail(&e))?
                    .ok_or_else(|| format!("codex app-server exited during {method}; check its configuration and update Codex if app-server support is missing"))?;
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message["id"] != json!(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    let error = error["message"].as_str().unwrap_or("failed");
                    return Err(format!("codex app-server {method}: {error}"));
                }
                return Ok(message["result"].clone());
            }
        };
        call(
            "initialize",
            json!({"clientInfo": {"name": "switchboard", "version": env!("SWITCHBOARD_COMMIT")}}),
        )
        .await?;
        let listed = call("hooks/list", json!({"cwds": []})).await?;
        if !codex_plugin_list_ready(&listed, false) {
            let errors = listed["data"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|entry| entry["errors"].as_array().into_iter().flatten())
                .map(|error| {
                    error
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| error.to_string())
                })
                .collect::<Vec<_>>()
                .join(" · ");
            if !errors.is_empty() {
                return Err(format!(
                    "Codex hook configuration errors: {}; global hooks were kept",
                    errors.chars().take(1000).collect::<String>()
                ));
            }
            return Err(
                "Codex did not load all Switchboard plugin hooks; global hooks were kept".into(),
            );
        }
        let edits = codex_trust_edits(&listed);
        if !edits.is_empty() {
            call(
                "config/batchWrite",
                json!({"edits": [{"keyPath": "hooks.state", "value": edits, "mergeStrategy": "upsert"}],
                       "reloadUserConfig": true}),
            )
            .await?;
        }
        let fingerprint = codex_trust_fingerprint(dir);
        let listed = call("hooks/list", json!({"cwds": []})).await?;
        if !codex_plugin_list_ready(&listed, true) {
            return Err(
                "Codex has not trusted all Switchboard plugin hooks; global hooks were kept".into(),
            );
        }
        let fingerprint = fingerprint
            .filter(|before| codex_trust_fingerprint(&dir).as_ref() == Some(before))
            .ok_or(
                "Switchboard plugin or hook settings changed while checking trust; retry setup",
            )?;
        write_json(
            &dir.join("plugins/switchboard-hook-trust.json"),
            &json!({"fingerprint":fingerprint}),
        )
        .map_err(|error| format!("Could not save the plugin hook trust check: {error}"))?;
        Ok(())
    };
    let result = tokio::time::timeout(Duration::from_secs(60), session)
        .await
        .unwrap_or_else(|_| Err("codex app-server: timed out".into()));
    let _ = child.kill().await;
    result
}

fn codex_plugin_cache(dir: &Path) -> PathBuf {
    dir.join("plugins/cache/switchboard/switchboard/local")
}

fn codex_hooks_enabled(config: &toml::Table) -> bool {
    config
        .get("features")
        .and_then(|features| {
            features
                .get("hooks")
                .or_else(|| features.get("codex_hooks"))
        })
        .and_then(|enabled| enabled.as_bool())
        .unwrap_or(true)
}

/// The Codex manifest must select its own shell-form hooks, never Claude's args form.
fn codex_plugin_hooks_complete(cache: &Path) -> bool {
    let config = read_json(&cache.join("hooks/codex.json")).unwrap_or(Value::Null);
    let expected: Value = serde_json::from_str(include_str!(
        "../../../plugins/switchboard/hooks/codex.json"
    ))
    .unwrap();
    CODEX_EVENTS.iter().all(|(event, _, _)| {
        let group = &config["hooks"][event][0];
        group
            .get("matcher")
            .is_none_or(|m| matches!(m.as_str(), Some("" | "*")))
            && expected["hooks"][event][0]["hooks"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .all(|(index, required)| {
                    let hook = &group["hooks"][index];
                    hook["type"] == "command"
                        && hook["command"] == required["command"]
                        && (hook["commandWindows"] == required["commandWindows"]
                            || codex_powershell_hook(hook, required))
                        && hook["async"] == required["async"]
                        && hook["args"].is_null()
                        && hook["if"].is_null()
                        && hook["asyncRewake"].is_null()
                        && hook["timeout"]
                            .as_u64()
                            .is_some_and(|timeout| timeout >= required["timeout"].as_u64().unwrap())
                })
    }) && (!codex_cache_uses_powershell(cache) || cache.join("hooks/codex.ps1").is_file())
}

/// Each Windows hook once started PowerShell to run this script. A cache from then still
/// works, so it stays healthy until the relay refreshes it.
/// The script stays in the plugin because Codex sessions already running keep calling it.
fn codex_powershell_hook(hook: &Value, required: &Value) -> bool {
    let wait = required["commandWindows"]
        .as_str()
        .is_some_and(|command| command.contains(" --wait"));
    hook["commandWindows"].as_str().is_some_and(|command| {
        command.starts_with("powershell.exe ")
            && command.contains("hooks/codex.ps1")
            && command.ends_with("-WaitForMessages") == wait
    })
}

fn codex_cache_uses_powershell(cache: &Path) -> bool {
    std::fs::read_to_string(cache.join("hooks/codex.json"))
        .is_ok_and(|hooks| hooks.contains("hooks/codex.ps1"))
}

async fn refresh_codex_plugin(codex: &Path, folders: &[PathBuf]) -> Result<(), String> {
    run(
        codex,
        &["plugin", "marketplace", "upgrade", "switchboard"],
        folders,
    )
    .await?;
    run(codex, &["plugin", "add", PLUGIN], folders).await
}

/// A report from a legacy global hook cannot prove that the plugin is ready.
fn check_codex_plugin(dir: &Path) -> Result<(), &'static str> {
    let config = std::fs::read_to_string(dir.join("config.toml"))
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok());
    if config
        .as_ref()
        .is_some_and(|config| !codex_hooks_enabled(config))
    {
        return Err("Codex hooks are turned off in config.toml");
    }
    let plugin = config
        .as_ref()
        .and_then(|c| c.get("plugins"))
        .and_then(|p| p.get(PLUGIN));
    let Some(plugin) = plugin else {
        return Err("Switchboard plugin not installed");
    };
    if plugin.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return Err("Switchboard plugin turned off");
    }
    let cache = codex_plugin_cache(dir);
    let manifest = read_json(&cache.join(".codex-plugin/plugin.json"));
    let Some(manifest) =
        manifest.filter(|m| m["name"] == "switchboard" && m["skills"] == "./skills/")
    else {
        return Err("Switchboard plugin cache missing or invalid");
    };
    if manifest["hooks"] != "./hooks/codex.json" || !codex_plugin_hooks_complete(&cache) {
        return Err("Switchboard plugin hooks are incompatible; refresh the plugin");
    }
    for skill in ["close-tab", "interactive", "message-board", "sudo"] {
        if !cache.join("skills").join(skill).join("SKILL.md").is_file() {
            return Err("Switchboard plugin skills missing");
        }
    }
    Ok(())
}

fn check_codex(dir: &Path, launcher: &Path) -> Check {
    if let Err(detail) = check_codex_plugin(dir) {
        return Check {
            state: "setup",
            detail: detail.into(),
        };
    }
    if !launcher.is_file() {
        return Check {
            state: "setup",
            detail: "Status hook launcher missing".into(),
        };
    }
    let trusted = codex_trust_proof_current(dir)
        && CODEX_EVENTS.iter().all(|(event, _, _)| {
            codex_trusted(dir, event, 0, 0)
                && (!matches!(*event, "SessionStart" | "Stop") || codex_trusted(dir, event, 0, 1))
        });
    let legacy =
        read_json(&dir.join("hooks.json")).is_some_and(|config| !codex_hooks(&config).is_empty());
    if trusted && legacy {
        Check {
            state: "setup",
            detail: "Legacy Switchboard hooks need migration to the plugin".into(),
        }
    } else if trusted {
        Check {
            state: "ready",
            detail: "Plugin hooks installed and trusted".into(),
        }
    } else {
        Check {
            state: "approve",
            detail: "Codex has not trusted the status hooks yet".into(),
        }
    }
}

/// At relay start (so after every update), trust Switchboard's Codex hooks if setup
/// installed them and Codex hasn't trusted them yet, so nobody has to.
pub(super) fn trust_codex_hooks_on_start() {
    tokio::spawn(async {
        let folders = search_path();
        let dir = Agent::Codex.home();
        let Some(codex) = find_program("codex", &folders) else {
            return;
        };
        if !dir.is_dir() || check_codex_plugin(&dir).is_err() {
            return;
        }
        // Updates replace the relay but not Codex's copy of the plugin. Only Windows runs
        // the old PowerShell hooks, so only Windows needs the new copy.
        if cfg!(windows) && codex_cache_uses_powershell(&codex_plugin_cache(&dir)) {
            if let Err(error) = refresh_codex_plugin(&codex, &folders).await {
                log::warn!("Cannot refresh Switchboard's Codex plugin: {error}");
                logs::record(
                    "codex",
                    &format!("Cannot refresh Switchboard's Codex plugin: {error}"),
                );
            }
        }
        match trust_codex_hooks(&codex, &folders, &dir)
            .await
            .and_then(|()| remove_legacy_codex_hooks(&dir.join("hooks.json")))
        {
            Ok(()) => {
                log::info!("Trusted Switchboard's Codex plugin hooks and migrated global hooks")
            },
            Err(error) => {
                log::warn!("Cannot trust Switchboard's Codex hooks: {error}");
                logs::record(
                    "codex",
                    &format!("Cannot trust Switchboard's Codex hooks: {error}"),
                );
            },
        }
    });
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

/// Called only after Codex positively lists all plugin hooks as trusted.
/// Read the current file after that potentially slow operation; preserve other edits.
fn remove_legacy_codex_hooks(file: &Path) -> Result<(), String> {
    let original = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not read {}: {error}", file.display())),
    };
    let mut config: Value = serde_json::from_str(&original)
        .map_err(|e| format!("{} is not valid JSON: {e}", file.display()))?;
    let Some(root) = config.as_object_mut() else {
        return Err(format!("{} is not a JSON object", file.display()));
    };
    let Some(hooks) = root.get_mut("hooks") else {
        return Ok(());
    };
    let Some(hooks) = hooks.as_object_mut() else {
        return Err("hooks is not an object".into());
    };
    let mut removed = false;
    let mut emptied = Vec::new();
    for (event, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        let before_groups = groups.len();
        groups.retain_mut(|group| {
            let Some(list) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            let before = list.len();
            list.retain(|hook| !hook["command"].as_str().is_some_and(is_codex_hook));
            removed |= before != list.len();
            !(before > 0 && list.is_empty())
        });
        if before_groups > 0 && groups.is_empty() {
            emptied.push(event.clone());
        }
    }
    if !removed {
        return Ok(());
    }
    hooks.retain(|event, _| !emptied.contains(event));
    let backup = file.with_extension("json.switchboard.bak");
    if !backup.exists() {
        std::fs::copy(file, &backup)
            .map_err(|e| format!("Could not back up {}: {e}", file.display()))?;
    }
    if std::fs::read_to_string(file).ok().as_deref() != Some(original.as_str()) {
        return Err("Codex hooks changed during migration; retry setup".into());
    }
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

fn verify_plugin_setup(check: Check) -> Result<(), String> {
    if check.state == "ready" {
        Ok(())
    } else {
        Err(format!("Setup finished but {}", check.detail))
    }
}

async fn set_up(agent: Agent) -> Result<(), String> {
    if let Some(path) = path_copy().filter(|path| path_copy_damaged(path)) {
        let binary = std::env::current_exe().map_err(|error| error.to_string())?;
        replace_path_copy(&path, &binary)?;
    }
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
            run(
                &claude,
                &["plugin", "marketplace", "update", "switchboard"],
                &folders,
            )
            .await?;
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
            if !check.detail.contains("not installed") {
                run(
                    &claude,
                    &["plugin", "update", PLUGIN, "--scope", "user"],
                    &folders,
                )
                .await?;
            }
            turn_on_auto_update(
                &dir.join("settings.json"),
                json!({"source": "github", "repo": REPO, "sparsePaths": [".claude-plugin", "plugins"]}),
            )?;
            let check = check_claude(&dir);
            if check.state != "ready"
                && check.detail != "Slow recovery command runs on every prompt"
            {
                return verify_plugin_setup(check);
            }
            remove_prompt_recovery(&dir.join("settings.json"))?;
            verify_plugin_setup(check_claude(&dir))
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
            if !check.detail.contains("not installed") {
                run(&copilot, &["plugin", "update", PLUGIN], &folders).await?;
            }
            turn_on_auto_update(
                &dir.join("settings.json"),
                json!({"source": "github", "repo": REPO}),
            )?;
            verify_plugin_setup(check_copilot(&dir))
        },
        Agent::Codex => {
            let codex = find_program("codex", &folders).ok_or("Codex not found")?;
            if check_codex_plugin(&dir).is_err() {
                run(
                    &codex,
                    &[
                        "plugin",
                        "marketplace",
                        "add",
                        REPO,
                        "--sparse",
                        ".agents/plugins",
                        "--sparse",
                        "plugins",
                    ],
                    &folders,
                )
                .await?;
                refresh_codex_plugin(&codex, &folders).await?;
                check_codex_plugin(&dir).map_err(String::from)?;
            }
            let binary = control::own_executable()
                .map_err(|e| format!("Cannot find Switchboard's executable: {e}"))?;
            install_codex_launcher(&home(), &binary)
                .map_err(|e| format!("Could not write the Codex hook launcher: {e}"))?;
            trust_codex_hooks(&codex, &folders, &dir).await.map_err(|error| {
                format!("Plugin installed, but trusting its hooks failed ({error}). Global hooks were kept. Start Codex and review the Switchboard plugin hooks")
            })?;
            remove_legacy_codex_hooks(&dir.join("hooks.json"))
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
static SKILL_REPAIR: LazyLock<SyncMutex<Setup>> =
    LazyLock::new(|| SyncMutex::new(Setup::default()));

async fn fix_skills() -> Result<(), String> {
    let folders = search_path();
    let program = find_program("codex", &folders).ok_or("Codex not found")?;
    let dir = Agent::Codex.home();
    refresh_skills_at(dir, home(), program, folders).await
}

async fn refresh_skills_at(
    dir: PathBuf,
    skill_home: PathBuf,
    program: PathBuf,
    folders: Vec<PathBuf>,
) -> Result<(), String> {
    let check_dir = dir.clone();
    let check_home = skill_home.clone();
    let check = tokio::task::spawn_blocking(move || skill_health::inspect(&check_dir, &check_home))
        .await
        .map_err(|e| e.to_string())?;
    let plugins = check["refreshPlugins"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut errors = Vec::new();
    for plugin in plugins.iter().filter_map(Value::as_str) {
        if let Err(error) = run(&program, &["plugin", "add", "--", plugin], &folders).await {
            errors.push(error);
        }
    }
    let check = tokio::task::spawn_blocking(move || skill_health::recheck(&dir, &skill_home))
        .await
        .map_err(|e| e.to_string())?;
    if check["state"] != "ok" && errors.is_empty() {
        errors.push(
            "Some skills still need attention. Open diagnostics for the remaining issues.".into(),
        );
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

fn start_skill_repair(agent: &str) -> Result<(), (StatusCode, String)> {
    if agent != "codex" {
        return Err((
            StatusCode::BAD_REQUEST,
            "Fix skills is only supported for Codex".into(),
        ));
    }
    // Lock in the same order as hook setup so the two operations cannot overlap.
    let setups = SETUPS.lock().unwrap();
    let mut repair = SKILL_REPAIR.lock().unwrap();
    if repair.running || setups.get("codex").is_some_and(|s| s.running) {
        return Err((
            StatusCode::CONFLICT,
            "Codex setup or skill repair is already running".into(),
        ));
    }
    *repair = Setup {
        running: true,
        ..Default::default()
    };
    tokio::spawn(async {
        let result = fix_skills().await;
        *SKILL_REPAIR.lock().unwrap() = Setup {
            running: false,
            finished: Some(now()),
            error: result.err(),
        };
    });
    Ok(())
}

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
        if setup.running || (agent == Agent::Codex && SKILL_REPAIR.lock().unwrap().running) {
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
    let repair = SKILL_REPAIR.lock().unwrap().clone();
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
            Agent::Codex => with_path_copy_damage(
                check_codex(&dir, &codex_launcher(&home())),
                path_copy().as_deref(),
            ),
        }
    };
    json!({
        "agent": agent.id(),
        "name": agent.name(),
        "state": if setup.running { "running" } else { check.state },
        "detail": if setup.running { "Setting up…".to_string() } else { check.detail },
        "lastReport": report,
        "installation": if agent == Agent::Codex { codex_installation(program.as_deref(), cfg!(windows)) } else { Value::Null },
        "plugins": if check.state != "absent" { dotfiles::inspect(agent, &dir, &read_json(&home().join(".config/switchboard/dotfiles-plugins.json")).unwrap_or(Value::Null)) } else { Value::Null },
        "skills": if agent == Agent::Codex && check.state != "absent" { skill_health::codex(&dir, &home()) } else { Value::Null },
        "skillRepair": if agent == Agent::Codex { json!({"supported":true,"running":repair.running,"error":repair.error,"finished":repair.finished}) } else { Value::Null },
        "setupError": setup.error,
        "setupFinished": setup.finished,
    })
}

/// Whether this computer's automatic Switchboard update is switched on: the systemd
/// user timer is enabled on Linux, the LaunchAgent is loaded on macOS, and on Windows
/// the tray, which runs the update checks, holds its single-instance mutex.
pub(super) fn automatic_updates() -> bool {
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

/// A journal survives crashes; only the held updater lock proves a job is running.
fn update_running(directory: &std::path::Path) -> bool {
    let Ok(lock) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("automatic.lock"))
    else {
        return false;
    };
    match lock.try_lock() {
        Ok(()) => {
            let _ = lock.unlock();
            false
        },
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(_) => false,
    }
}

/// Whether the recorded error only says the release manifest could not be read: no
/// update was attempted, so it is not a failed update.
fn check_failed(state: &Value) -> bool {
    !state["error"].is_null() && state["error"] == state["manifest_failure"]["error"]
}

fn update_phase(state: &Value, requested: bool, running: bool) -> &'static str {
    if !state["pending"].is_null() && running {
        "applying"
    } else if requested {
        "requested"
    } else if !state["error"].is_null() && !check_failed(state) {
        "failed"
    } else if !state["pending"].is_null() {
        "recovery"
    } else if !state["ready"].is_null() {
        "waiting"
    } else {
        "current"
    }
}

/// The build this relay runs, whether it updates itself and whether its last update failed.
fn switchboard() -> Value {
    let mut status = switchboard_in(
        &home().join(".local/share/switchboard/automatic-updates"),
        automatic_updates(),
    );
    status["pathCopyDamaged"] = path_copy()
        .is_some_and(|path| path_copy_damaged(&path))
        .into();
    status
}

/// Sessions an update cannot move, because their engine owns their terminals.
fn sessions_without_host() -> Vec<String> {
    let mut names: Vec<String> = zellij_utils::sessions::get_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|(name, _)| name)
        .filter(|name| {
            zellij_utils::handoff::read_session_record(name)
                .is_none_or(|record| !record.host_directory.is_dir())
        })
        .collect();
    names.sort();
    names
}

fn switchboard_in(directory: &Path, automatic: bool) -> Value {
    let update_state = read_json(&directory.join("state.json")).unwrap_or(Value::Null);
    let request = read_json(&directory.join("activate.json")).unwrap_or(Value::Null);
    let request_active = [&request, &update_state["activation"]]
        .iter()
        .any(|request| {
            request["expires"]
                .as_u64()
                .is_some_and(|expires| expires >= now() / 1000 && expires <= now() / 1000 + 300)
        });
    let phase = update_phase(&update_state, request_active, update_running(directory));
    let (update_error, check_error) = if check_failed(&update_state) {
        (Value::Null, update_state["error"].clone())
    } else {
        (update_state["error"].clone(), Value::Null)
    };
    json!({
        "updatePhase": phase,
        "commit": env!("SWITCHBOARD_COMMIT"),
        "commitDate": env!("SWITCHBOARD_COMMIT_DATE"),
        "automaticUpdates": automatic,
        // Windows has no update job to start; its tray checks every 2 minutes.
        "updateNow": automatic && cfg!(any(target_os = "linux", target_os = "macos")),
        "lastUpdateError": update_error,
        "updateCheckError": check_error,
        "updateNotice": update_state["notice"],
        "readyUpdate": update_state["ready"],
        "activationTarget": update_state["ready"]["commit"].as_str().or(update_state["pending"]["target"].as_str()),
        "sessionsWithoutHost": sessions_without_host(),
        // Windows consumes activation requests on the tray's next update check.
        "activateUpdate": automatic,
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
    #[serde(default)]
    pub(super) action: SetupAction,
}

#[derive(Clone, Copy, Default, Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum SetupAction {
    #[default]
    Setup,
    FixSkills,
}

pub(super) fn set_up_locally(request: &SetupRequest) -> Response {
    let result = match request.action {
        SetupAction::Setup => start_setup(&request.agent),
        SetupAction::FixSkills => start_skill_repair(&request.agent),
    };
    match result {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({"ok": true}))).into_response(),
        Err((status, error)) => (status, Json(json!({ "error": error }))).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switchboard_health_reports_a_damaged_path_copy_for_codex() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("zellij.exe");
        let ready = || Check {
            state: "ready",
            detail: "Plugin hooks installed and trusted".into(),
        };
        std::fs::write(&path, b"MZ working").unwrap();
        assert_eq!(with_path_copy_damage(ready(), Some(&path)).state, "ready");
        assert_eq!(with_path_copy_damage(ready(), None).state, "ready");
        std::fs::write(&path, b"new").unwrap();
        let check = with_path_copy_damage(ready(), Some(&path));
        assert_eq!(check.state, "setup");
        assert!(check.detail.contains("zellij on PATH is damaged"));
    }

    #[test]
    fn switchboard_health_finds_and_repairs_a_damaged_path_copy() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("zellij.exe");
        let release = directory.path().join("release.exe");
        std::fs::write(&release, b"MZ release").unwrap();
        // What a test's fixture release left on a real computer.
        std::fs::write(&path, b"new").unwrap();
        assert!(path_copy_damaged(&path));
        let mut missing = Vec::new();
        note_damaged_path_copy(Some(&path), &mut missing);
        assert_eq!(missing.len(), 1);
        assert_eq!(Check::from_missing(missing).state, "setup");

        replace_path_copy(&path, &release).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"MZ release");
        assert!(!path_copy_damaged(&path));
        let names: Vec<_> = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(names.iter().any(|name| name.starts_with("zellij.retired-")));
        assert!(!names.iter().any(|name| name.starts_with(".zellij-")));

        // A computer without a PATH copy, or one unreadable right now, is not reported.
        let mut missing = Vec::new();
        note_damaged_path_copy(Some(&directory.path().join("absent.exe")), &mut missing);
        note_damaged_path_copy(None, &mut missing);
        assert!(missing.is_empty());
    }

    #[test]
    fn switchboard_health_advertises_activation_with_a_scheduled_updater() {
        let directory = tempfile::tempdir().unwrap();
        let commit = "b".repeat(40);
        write_json(
            &directory.path().join("state.json"),
            &json!({"ready":{"commit":commit,"since":now() / 1000}}),
        )
        .unwrap();
        let status = switchboard_in(directory.path(), true);
        assert_eq!(status["activateUpdate"], true);
        assert_eq!(status["activationTarget"], commit);
        assert_eq!(status["updatePhase"], "waiting");
        // The Windows tray can activate without a separately startable update job.
        assert_eq!(
            status["updateNow"],
            cfg!(any(target_os = "linux", target_os = "macos"))
        );
        let stopped = switchboard_in(directory.path(), false);
        assert_eq!(stopped["activateUpdate"], false);
        assert_eq!(stopped["updateNow"], false);
    }

    #[test]
    fn switchboard_update_failed_check_is_not_a_failed_update() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let error = "Release manifest unavailable: 504";
        write_json(
            &path,
            &json!({"error": error, "manifest_failure": {"source": "s", "error": error}}),
        )
        .unwrap();
        let status = switchboard_in(directory.path(), true);
        assert_eq!(status["updatePhase"], "current");
        assert_eq!(status["updateCheckError"], error);
        assert!(status["lastUpdateError"].is_null());

        write_json(
            &path,
            &json!({"error": "Handoff failed", "manifest_failure": {"source": "s", "error": error}}),
        )
        .unwrap();
        let status = switchboard_in(directory.path(), true);
        assert_eq!(status["updatePhase"], "failed");
        assert_eq!(status["lastUpdateError"], "Handoff failed");
        assert!(status["updateCheckError"].is_null());
    }

    #[test]
    fn switchboard_update_pending_journal_is_not_a_running_job() {
        let directory = tempfile::tempdir().unwrap();
        let lock = std::fs::File::create(directory.path().join("automatic.lock")).unwrap();
        let state = json!({"pending":{"target":"b".repeat(40)}});
        assert_eq!(
            update_phase(&state, false, update_running(directory.path())),
            "recovery"
        );
        lock.lock().unwrap();
        assert_eq!(
            update_phase(&state, false, update_running(directory.path())),
            "applying"
        );
        lock.unlock().unwrap();
        assert_eq!(update_phase(&state, true, false), "requested");
    }

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
            &json!({"version":2,"plugins":{PLUGIN:[{"scope":"user","installPath":dir.join("active-plugin")}]}}).to_string(),
        );
        for (name, body) in super::super::agent_skills::SKILLS {
            write(
                &dir.join("active-plugin/skills").join(name).join("SKILL.md"),
                body,
            );
        }
        write(
            &dir.join("active-plugin/hooks/hooks.json"),
            include_str!("../../../plugins/switchboard/hooks/hooks.json"),
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
        std::fs::remove_file(dir.join("active-plugin/skills/close-tab/SKILL.md")).unwrap();
        assert!(check_claude(dir).detail.contains("skills missing"));
        write(
            &dir.join("settings.json"),
            r#"{"enabledPlugins":{"switchboard@switchboard":true},"extraKnownMarketplaces":{"switchboard":{"autoUpdate":false}}}"#,
        );
        assert!(check_claude(dir).detail.contains("Auto-update off"));
    }

    #[test]
    fn switchboard_agent_setup_rejects_incomplete_claude_hooks() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let plugin = dir.join("active-plugin");
        write(
            &dir.join("plugins/installed_plugins.json"),
            &json!({"plugins":{PLUGIN:[{"scope":"user","installPath":plugin}]}}).to_string(),
        );
        turn_on_auto_update(&dir.join("settings.json"), json!({})).unwrap();
        for (name, body) in super::super::agent_skills::SKILLS {
            write(&plugin.join("skills").join(name).join("SKILL.md"), body);
        }
        let file = plugin.join("hooks/hooks.json");
        let current: Value = serde_json::from_str(include_str!(
            "../../../plugins/switchboard/hooks/hooks.json"
        ))
        .unwrap();
        assert!(check_claude(dir)
            .detail
            .contains("hooks missing or out of date"));
        let mut http_only = current.clone();
        for groups in http_only["hooks"].as_object_mut().unwrap().values_mut() {
            *groups =
                json!([{"hooks":[{"type":"http","url":"http://127.0.0.1:8090/api/agent-hook"}]}]);
        }
        write_json(&file, &http_only).unwrap();
        assert_eq!(
            check_claude(dir).state,
            "setup",
            "legacy HTTP status reports cannot deliver messages"
        );
        for event in ["SessionStart", "PostToolUse", "Stop", "SessionEnd"] {
            let mut missing = current.clone();
            missing["hooks"].as_object_mut().unwrap().remove(event);
            write_json(&file, &missing).unwrap();
            assert_eq!(check_claude(dir).state, "setup", "missing {event}");
        }
        for event in ["SessionStart", "Stop"] {
            let mut missing = current.clone();
            missing["hooks"][event][0]["hooks"]
                .as_array_mut()
                .unwrap()
                .retain(|hook| hook["asyncRewake"] != true);
            write_json(&file, &missing).unwrap();
            assert_eq!(
                check_claude(dir).state,
                "setup",
                "missing {event} wake hook"
            );
        }
        let mut filtered = current.clone();
        filtered["hooks"]["PostToolUse"][0]["matcher"] = json!("Bash");
        write_json(&file, &filtered).unwrap();
        assert_eq!(
            check_claude(dir).state,
            "setup",
            "tool reporting must cover every tool"
        );
        for (pointer, value) in [
            ("/hooks/PostToolUse/0/hooks/0/allowedEnvVars", json!([])),
            ("/hooks/PostToolUse/0/hooks/0/headers", json!({})),
            (
                "/hooks/PostToolUse/0/hooks/0/url",
                json!("http://127.0.0.1:8090/api/agent-hook"),
            ),
            ("/hooks/PostToolUse/0/hooks/0/async", json!(true)),
            ("/hooks/PostToolUse/0/hooks/0/if", json!("Bash(*)")),
            ("/hooks/Stop/0/hooks/1/asyncRewake", json!(false)),
            ("/hooks/Stop/0/hooks/1/timeout", json!(5)),
        ] {
            let mut broken = current.clone();
            let (parent, field) = pointer.rsplit_once('/').unwrap();
            broken.pointer_mut(parent).unwrap()[field] = value;
            write_json(&file, &broken).unwrap();
            assert_eq!(check_claude(dir).state, "setup", "invalid {pointer}");
        }
        let mut newer = current;
        newer["hooks"]["NewEvent"] = json!([{"hooks":[{"type":"command","command":"echo newer"}]}]);
        newer["hooks"]["PostToolUse"][0]["matcher"] = json!("*");
        write_json(&file, &newer).unwrap();
        assert_eq!(
            check_claude(dir).state,
            "ready",
            "compatible newer hooks are accepted"
        );
        for groups in newer["hooks"].as_object_mut().unwrap().values_mut() {
            for group in groups.as_array_mut().unwrap() {
                for hook in group["hooks"].as_array_mut().unwrap() {
                    if let Some(args) = hook.as_object_mut().unwrap().remove("args") {
                        let args = args
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|arg| arg.as_str().unwrap())
                            .collect::<Vec<_>>()
                            .join(" ");
                        hook["command"] = json!(format!("zellij {args}"));
                    }
                }
            }
        }
        write_json(&file, &newer).unwrap();
        assert_eq!(
            check_claude(dir).state,
            "ready",
            "shell-form hooks are supported too"
        );
    }

    #[test]
    fn switchboard_claude_repair_removes_only_prompt_recovery_commands() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("settings.json");
        let script = "$payload | & 'C:\\Tools\\zellij.exe' agent-resume record --agent claude";
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let recovery = json!({"type":"command","command":format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}", STANDARD.encode(bytes)),"timeout":10});
        let original = json!({"model":"example","hooks":{
            "SessionStart":[{"hooks":[recovery.clone()]}],
            "UserPromptSubmit":[{"matcher":"*","hooks":[recovery,{"type":"command","command":"custom-hook"}]}]
        }});
        write_json(&file, &original).unwrap();
        assert!(has_prompt_recovery(&original));
        for _ in 0..2 {
            remove_prompt_recovery(&file).unwrap();
        }
        let fixed = read_json(&file).unwrap();
        assert!(!has_prompt_recovery(&fixed));
        assert_eq!(fixed["model"], original["model"]);
        assert_eq!(
            fixed["hooks"]["SessionStart"],
            original["hooks"]["SessionStart"]
        );
        assert_eq!(
            fixed["hooks"]["UserPromptSubmit"][0],
            json!({"matcher":"*","hooks":[{"type":"command","command":"custom-hook"}]})
        );
        assert_eq!(
            read_json(&file.with_extension("json.switchboard.bak")).unwrap(),
            original
        );
    }

    #[test]
    fn switchboard_agent_setup_reads_copilot_config_with_comments() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        for (name, body) in super::super::agent_skills::SKILLS {
            write(
                &dir.join("active-plugin/skills").join(name).join("SKILL.md"),
                body,
            );
        }
        write(
            &dir.join("config.json"),
            &format!(
                "// managed config\n{}",
                json!({"installedPlugins":[{"name":"switchboard","marketplace":"switchboard","enabled":true,"cache_path":dir.join("active-plugin")}]})
            ),
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
    fn switchboard_agent_setup_accepts_independently_updated_plugins() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let plugin = dir.join("active-plugin");
        write(
            &dir.join("plugins/installed_plugins.json"),
            &json!({"plugins":{PLUGIN:[{"scope":"user","installPath":plugin}]}}).to_string(),
        );
        write(
            &dir.join("config.json"),
            &json!({"installedPlugins":[{"name":"switchboard","marketplace":"switchboard","cache_path":plugin}]}).to_string(),
        );
        turn_on_auto_update(&dir.join("settings.json"), json!({})).unwrap();
        for (name, body) in super::super::agent_skills::SKILLS {
            write(&plugin.join("skills").join(name).join("SKILL.md"), body);
        }
        write(
            &plugin.join("hooks/hooks.json"),
            include_str!("../../../plugins/switchboard/hooks/hooks.json"),
        );
        let skill = plugin.join("skills/message-board/SKILL.md");
        // A plugin update can change instructions before the relay is updated.
        write(&skill, "---\r\nname: message-board\r\ndescription: Updated messaging\r\n---\r\nNew instructions.\r\n");
        for check in [check_claude(dir), check_copilot(dir)] {
            assert_eq!(check.state, "ready");
            assert!(verify_plugin_setup(check).is_ok());
        }
        for contents in ["", " \r\n\t"] {
            write(&skill, contents);
            for check in [check_claude(dir), check_copilot(dir)] {
                assert_eq!(check.state, "setup");
                assert!(verify_plugin_setup(check)
                    .unwrap_err()
                    .contains("skills missing or unreadable"));
            }
        }
        std::fs::remove_file(&skill).unwrap();
        for check in [check_claude(dir), check_copilot(dir)] {
            assert_eq!(check.state, "setup");
            assert!(verify_plugin_setup(check).is_err());
        }
    }

    #[test]
    fn switchboard_agent_setup_requires_codex_plugin_and_all_skills() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin not installed")
        );
        write(
            &dir.join("config.toml"),
            "[plugins.\"switchboard@switchboard\"]\nenabled = false\n",
        );
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin turned off")
        );
        write(
            &dir.join("config.toml"),
            "[plugins.\"switchboard@switchboard\"]\nenabled = true\n",
        );
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin cache missing or invalid")
        );
        let cache = dir.join("plugins/cache/switchboard/switchboard/local");
        write(
            &cache.join(".codex-plugin/plugin.json"),
            include_str!("../../../plugins/switchboard/.codex-plugin/plugin.json"),
        );
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin hooks are incompatible; refresh the plugin")
        );
        write(
            &cache.join("hooks/codex.json"),
            include_str!("../../../plugins/switchboard/hooks/codex.json"),
        );
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin skills missing")
        );
        for skill in ["close-tab", "interactive", "message-board", "sudo"] {
            write(&cache.join("skills").join(skill).join("SKILL.md"), "skill");
        }
        assert_eq!(check_codex_plugin(dir), Ok(()));
        for feature in ["hooks", "codex_hooks"] {
            write(
                &dir.join("config.toml"),
                &format!("[plugins.\"{PLUGIN}\"]\nenabled = true\n[features]\n{feature} = false\n"),
            );
            assert_eq!(
                check_codex_plugin(dir),
                Err("Codex hooks are turned off in config.toml")
            );
        }
        write(
            &dir.join("config.toml"),
            &format!("[plugins.\"{PLUGIN}\"]\nenabled = true\n"),
        );
        let manifest_file = cache.join(".codex-plugin/plugin.json");
        let mut manifest = read_json(&manifest_file).unwrap();
        manifest.as_object_mut().unwrap().remove("hooks");
        write_json(&manifest_file, &manifest).unwrap();
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin hooks are incompatible; refresh the plugin"),
            "a skills-only manifest still auto-discovers the incompatible Claude hooks"
        );
        manifest["hooks"] =
            json!({"hooks":{"PostToolUse":[{"hooks":[{"type":"command","command":"zellij"}]}]}});
        write_json(&manifest_file, &manifest).unwrap();
        assert!(check_codex_plugin(dir).is_err());
        // A cached copy alone is insufficient after uninstall or disabling.
        write(&dir.join("config.toml"), "");
        assert_eq!(
            check_codex_plugin(dir),
            Err("Switchboard plugin not installed")
        );
    }

    fn install_test_codex_plugin(dir: &Path) {
        let cache = codex_plugin_cache(dir);
        write(
            &dir.join("config.toml"),
            "[plugins.\"switchboard@switchboard\"]\nenabled = true\n",
        );
        write(
            &cache.join(".codex-plugin/plugin.json"),
            include_str!("../../../plugins/switchboard/.codex-plugin/plugin.json"),
        );
        write(
            &cache.join("hooks/codex.json"),
            include_str!("../../../plugins/switchboard/hooks/codex.json"),
        );
        for skill in ["close-tab", "interactive", "message-board", "sudo"] {
            write(&cache.join("skills").join(skill).join("SKILL.md"), "skill");
        }
    }

    #[test]
    fn switchboard_codex_migration_preserves_unrelated_and_shared_hooks() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        install_test_codex_plugin(dir);
        let launcher = codex_launcher(dir);
        install_codex_launcher(dir, Path::new("/release/zellij")).unwrap();
        let file = dir.join("hooks.json");
        let original = json!({"description":"User hooks", "custom":42, "hooks": {
            "SessionStart":[{"matcher":"startup", "hooks":[
                {"type":"command","command":"echo personal"},
                {"type":"command","command":codex_command(&launcher)}]}],
            "Stop":[{"hooks":[{"type":"command","command":codex_command_with_wait(&launcher, true)}]}],
            "OtherEvent":[{"hooks":[{"type":"command","command":"echo other"}]}], "EmptyEvent":[], "_note":"personal metadata"
        }});
        write_json(&file, &original).unwrap();
        assert_eq!(
            check_codex(dir, &launcher).state,
            "approve",
            "legacy activity cannot prove plugin trust"
        );
        let state: String = CODEX_EVENTS.iter().flat_map(|(event, snake, _)| {
            let count = if matches!(*event, "SessionStart" | "Stop") { 2 } else { 1 };
            (0..count).map(move |index| format!("[hooks.state.\"{CODEX_HOOK_SOURCE}:{snake}:0:{index}\"]\ntrusted_hash = \"sha256:00\"\ntrusted_content_hash = \"sha256:11\"\n"))
        }).collect();
        write(
            &dir.join("config.toml"),
            &format!("[plugins.\"{PLUGIN}\"]\nenabled = true\n{state}"),
        );
        assert_eq!(
            check_codex(dir, &launcher).state,
            "approve",
            "saved hashes alone are insufficient"
        );
        write_json(
            &dir.join("plugins/switchboard-hook-trust.json"),
            &json!({"fingerprint":codex_trust_fingerprint(dir).unwrap()}),
        )
        .unwrap();
        assert_eq!(
            check_codex(dir, &launcher).state,
            "setup",
            "duplicate hooks need migration"
        );
        remove_legacy_codex_hooks(&file).unwrap();
        let migrated = read_json(&file).unwrap();
        assert_eq!(migrated["description"], "User hooks");
        assert_eq!(migrated["custom"], 42);
        assert_eq!(migrated["hooks"]["EmptyEvent"], json!([]));
        assert_eq!(migrated["hooks"]["_note"], "personal metadata");
        assert_eq!(migrated["hooks"]["SessionStart"][0]["matcher"], "startup");
        assert_eq!(
            migrated["hooks"]["SessionStart"][0]["hooks"],
            json!([{ "type":"command", "command":"echo personal" }])
        );
        assert!(migrated["hooks"].get("Stop").is_none());
        assert_eq!(
            migrated["hooks"]["OtherEvent"],
            original["hooks"]["OtherEvent"]
        );
        assert_eq!(
            read_json(&file.with_extension("json.switchboard.bak")).unwrap(),
            original
        );
        assert_eq!(check_codex(dir, &launcher).state, "ready");
        let script = codex_plugin_cache(dir).join("hooks/codex.json");
        let original_script = std::fs::read_to_string(&script).unwrap();
        write(&script, &format!("{original_script}\n"));
        assert_eq!(
            check_codex(dir, &launcher).state,
            "approve",
            "changed plugin content invalidates trust proof"
        );
        write(&script, &original_script);
        let settings = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        write(
            &dir.join("config.toml"),
            &settings.replacen("trusted_hash =", "enabled = false\ntrusted_hash =", 1),
        );
        assert_eq!(
            check_codex(dir, &launcher).state,
            "approve",
            "a disabled hook cannot appear healthy"
        );
        write(&dir.join("config.toml"), &settings);
        remove_legacy_codex_hooks(&file).unwrap();
        assert_eq!(read_json(&file).unwrap(), migrated);
        install_codex_launcher(dir, Path::new("/new-release/zellij")).unwrap();
        assert_eq!(check_codex(dir, &launcher).state, "ready");
    }

    #[tokio::test]
    #[ignore = "Requires CODEX_TEST_BINARY; installs only into an isolated Codex home"]
    async fn switchboard_codex_plugin_runtime_migration() {
        let codex =
            PathBuf::from(std::env::var_os("CODEX_TEST_BINARY").expect("set CODEX_TEST_BINARY"));
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("codex");
        std::fs::create_dir_all(&dir).unwrap();
        let market = temp.path().join("marketplace");
        let plugin = market.join("plugins/switchboard");
        write(
            &market.join(".agents/plugins/marketplace.json"),
            include_str!("../../../.agents/plugins/marketplace.json"),
        );
        write(
            &plugin.join(".codex-plugin/plugin.json"),
            r#"{"name":"switchboard","skills":"./skills/","hooks":{"hooks":{}}}"#,
        );
        for (name, body) in super::super::agent_skills::SKILLS {
            write(&plugin.join("skills").join(name).join("SKILL.md"), body);
        }
        let install = || async {
            for args in [
                vec!["plugin", "marketplace", "add", market.to_str().unwrap()],
                vec!["plugin", "add", PLUGIN],
            ] {
                let output = tokio::process::Command::new(&codex)
                    .args(args)
                    .env("CODEX_HOME", &dir)
                    .current_dir(&market)
                    .output()
                    .await
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        };
        install().await;
        assert!(
            check_codex_plugin(&dir).is_err(),
            "old skills-only plugin needs migration"
        );
        let file = dir.join("hooks.json");
        write_json(
            &file,
            &json!({"hooks":{"Stop":[{"hooks":[
                {"type":"command","command":"echo personal"},
                {"type":"command","command":codex_command(&codex_launcher(temp.path()))}
            ]}]}}),
        )
        .unwrap();
        write(
            &plugin.join(".codex-plugin/plugin.json"),
            include_str!("../../../plugins/switchboard/.codex-plugin/plugin.json"),
        );
        write(
            &plugin.join("hooks/codex.json"),
            include_str!("../../../plugins/switchboard/hooks/codex.json"),
        );
        install().await;
        assert_eq!(
            check_codex_plugin(&dir),
            Ok(()),
            "reinstall refreshes an old installed cache"
        );
        let launcher = codex_launcher(temp.path());
        install_codex_launcher(temp.path(), Path::new("/fixture/zellij")).unwrap();
        assert_eq!(check_codex(&dir, &launcher).state, "approve");
        trust_codex_hooks(&codex, &search_path(), &dir)
            .await
            .unwrap();
        assert_eq!(
            check_codex(&dir, &launcher).state,
            "setup",
            "trusted plugin must still migrate duplicates"
        );
        remove_legacy_codex_hooks(&file).unwrap();
        assert_eq!(check_codex(&dir, &launcher).state, "ready");
        assert_eq!(
            read_json(&file).unwrap()["hooks"]["Stop"][0]["hooks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let script = codex_plugin_cache(&dir).join("hooks/codex.json");
        let text = std::fs::read_to_string(&script).unwrap();
        write(&script, &format!("{text}\n"));
        assert_eq!(check_codex(&dir, &launcher).state, "approve");
        trust_codex_hooks(&codex, &search_path(), &dir)
            .await
            .unwrap();
        assert_eq!(check_codex(&dir, &launcher).state, "ready");
    }

    #[test]
    fn switchboard_codex_health_accepts_powershell_hooks_until_they_are_refreshed() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path();
        let current = include_str!("../../../plugins/switchboard/hooks/codex.json");
        let mut old: Value = serde_json::from_str(current).unwrap();
        for groups in old["hooks"].as_object_mut().unwrap().values_mut() {
            for hook in groups[0]["hooks"].as_array_mut().unwrap() {
                let wait = hook["commandWindows"].as_str().unwrap().contains(" --wait");
                hook["commandWindows"] = json!(format!(
                    "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"${{PLUGIN_ROOT}}/hooks/codex.ps1\"{}",
                    if wait { " -WaitForMessages" } else { "" }
                ));
            }
        }
        write(&cache.join("hooks/codex.json"), &old.to_string());
        assert!(
            codex_cache_uses_powershell(cache),
            "the relay must refresh this cache"
        );
        assert!(
            !codex_plugin_hooks_complete(cache),
            "the script it runs must exist"
        );
        write(&cache.join("hooks/codex.ps1"), "script");
        assert!(
            codex_plugin_hooks_complete(cache),
            "an old cache keeps working"
        );

        let swapped = old.to_string().replace(" -WaitForMessages", "");
        write(&cache.join("hooks/codex.json"), &swapped);
        assert!(
            !codex_plugin_hooks_complete(cache),
            "the listener must keep its argument"
        );

        write(&cache.join("hooks/codex.json"), current);
        std::fs::remove_file(cache.join("hooks/codex.ps1")).unwrap();
        assert!(!codex_cache_uses_powershell(cache));
        assert!(
            codex_plugin_hooks_complete(cache),
            "the current hooks need no script"
        );
    }

    #[test]
    fn switchboard_codex_trust_requires_all_current_plugin_handlers() {
        let mut handlers = Vec::new();
        for (event, snake, _) in CODEX_EVENTS {
            for index in 0..if matches!(event, "SessionStart" | "Stop") {
                2
            } else {
                1
            } {
                handlers.push(
                    json!({"key":format!("{CODEX_HOOK_SOURCE}:{snake}:0:{index}"),
                    "currentHash":"sha256:definition/sha256:content", "trustStatus":"untrusted"}),
                );
            }
        }
        handlers.push(json!({"key":"/user/hooks.json:stop:0:0", "command":"echo personal", "trustStatus":"untrusted", "currentHash":"sha256:other"}));
        let mut listed = json!({"data":[{"errors":[],"hooks":handlers}]});
        assert!(codex_plugin_list_ready(&listed, false));
        listed["data"][0]["hooks"].as_array_mut().unwrap().push(json!({"key":"switchboard@switchboard:hooks/hooks.json:session_start:0:0", "command":"zellij"}));
        assert!(
            !codex_plugin_list_ready(&listed, false),
            "inherited Claude hooks must block migration"
        );
        listed["data"][0]["hooks"].as_array_mut().unwrap().pop();
        assert!(!codex_plugin_list_ready(&listed, true));
        let edits = codex_trust_edits(&listed);
        assert_eq!(edits.len(), 9);
        assert!(edits
            .values()
            .all(|trust| trust["trusted_hash"] == "sha256:definition/sha256:content"));
        assert!(!codex_plugin_list_ready(&json!({"data":[]}), false));
        assert!(!codex_plugin_list_ready(
            &json!({"data":[{"hooks":[]}]}),
            false
        ));
        for handler in listed["data"][0]["hooks"].as_array_mut().unwrap() {
            if is_codex_plugin_hook(handler) {
                handler["trustStatus"] = json!("trusted");
            }
        }
        assert!(codex_plugin_list_ready(&listed, true));
        listed["data"][0]["hooks"][0]["enabled"] = json!(false);
        assert!(!codex_plugin_list_ready(&listed, true));
        listed["data"][0]["hooks"].as_array_mut().unwrap().remove(0);
        assert!(!codex_plugin_list_ready(&listed, false));
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
        assert!(remove_legacy_codex_hooks(&file).is_err());
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
    #[test]
    fn switchboard_codex_installation_health_checks_selected_package() {
        let dir = tempfile::tempdir().unwrap();
        let npm = dir.path().join("node");
        let launcher = npm.join("codex.cmd");
        write(&launcher, "npm wrapper");
        write(
            &npm.join("node_modules/@openai/codex/package.json"),
            r#"{"name":"@openai/codex"}"#,
        );
        assert_eq!(
            codex_installation(Some(&launcher), true)["state"],
            "attention"
        );
        let binary = npm.join(
            "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/bin/codex.exe",
        );
        assert_eq!(codex_installation(Some(&binary), true)["manager"], "npm");
        assert!(codex_installation(Some(&launcher), false).is_null());
        assert!(codex_installation(None, true).is_null());
        let standalone = dir.path().join("standalone/bin/codex.exe");
        write(&standalone, "standalone");
        assert!(codex_installation(Some(&standalone), true).is_null());
        let wrapper = dir.path().join("custom/codex.cmd");
        write(&wrapper, "custom wrapper");
        assert!(codex_installation(Some(&wrapper), true).is_null());
        write(
            &dir.path().join("node_modules/@openai/codex/package.json"),
            r#"{"name":"@openai/codex"}"#,
        );
        assert!(codex_installation(Some(&standalone), true).is_null());
    }
    #[tokio::test]
    async fn switchboard_skill_repair_refreshes_and_reports_failures() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = root.join(".codex");
        let source = root.join("source");
        write(&dir.join("config.toml"), &format!("[marketplaces.test]\nsource_type='local'\nsource={:?}\n[plugins.'example@test']\nenabled=true\n", source.to_str().unwrap()));
        write(
            &source.join(".agents/plugins/marketplace.json"),
            r#"{"plugins":[{"name":"example","source":"./plugin"}]}"#,
        );
        let manifest = r#"{"skills":"./skills"}"#;
        write(&source.join("plugin/.codex-plugin/plugin.json"), manifest);
        let original = source.join("plugin/skills/example/SKILL.md");
        let cached = dir.join("plugins/cache/test/example/local/skills/example/SKILL.md");
        write(&original, "---\nname: example\n---\nCurrent");
        write(&cached, "Old");
        write(
            &dir.join("plugins/cache/test/example/local/.codex-plugin/plugin.json"),
            manifest,
        );
        #[cfg(windows)]
        let (program, script) = (root.join("codex.cmd"), format!("@echo off\r\nif not \"%*\"==\"plugin add -- example@test\" exit /b 7\r\ncopy /y \"{}\" \"{}\" >nul\r\n", original.display().to_string().replace('/', "\\"), cached.display().to_string().replace('/', "\\")));
        #[cfg(not(windows))]
        let (program, script) = (
            root.join("codex"),
            format!(
                "#!/bin/sh\n[ \"$*\" = 'plugin add -- example@test' ] || exit 7\ncp '{}' '{}'\n",
                original.display(),
                cached.display()
            ),
        );
        write(&program, &script);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        refresh_skills_at(dir.clone(), root.into(), program.clone(), search_path())
            .await
            .unwrap();
        assert_eq!(skill_health::inspect(&dir, root)["state"], "ok");
        write(&cached, "Old again");
        #[cfg(windows)]
        write(
            &program,
            "@echo off\r\necho Refresh denied 1>&2\r\nexit /b 42\r\n",
        );
        #[cfg(not(windows))]
        write(&program, "#!/bin/sh\necho 'Refresh denied' >&2\nexit 42\n");
        let error = refresh_skills_at(dir.clone(), root.into(), program, search_path())
            .await
            .unwrap_err();
        assert!(error.contains("Refresh denied"), "{error}");
        assert_eq!(skill_health::inspect(&dir, root)["state"], "attention");
        assert_eq!(
            std::fs::read_to_string(original).unwrap(),
            "---\nname: example\n---\nCurrent"
        );
    }
}
