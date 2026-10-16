use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use zellij_utils::{
    agent_resumption::{invocation, resume_command, AgentKind},
    consts::{session_info_folder_for_session, ZELLIJ_SOCK_DIR},
    envs,
    input::command::RunCommand,
    sessions::validate_session_name,
};

use crate::background_jobs::atomic_write;

const MAX_RECORD_SIZE: u64 = 64 * 1024;
const MAX_HOOK_INPUT_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
struct AgentSession {
    agent: AgentKind,
    session_id: String,
    cwd: PathBuf,
    command: Vec<String>,
    process_id: u32,
    process_start: u64,
    socket_identity: String,
}

fn socket_identity(path: &Path) -> Result<String> {
    let metadata = fs::metadata(path).context("Cannot identify the running terminal session")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime()
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(format!(
            "{}:{}",
            fs::read_to_string(path)?.trim(),
            metadata
                .created()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ))
    }
}

fn record_path(directory: &Path, pane_id: u32) -> PathBuf {
    directory.join(format!("agent-resume-{pane_id}.json"))
}

fn processes() -> System {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );
    system
}

fn process_command(process: &sysinfo::Process) -> Vec<String> {
    process
        .cmd()
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

pub fn record_hook(agent: AgentKind, input: impl Read) -> Result<Option<String>> {
    let session_name = match envs::get_session_name() {
        Ok(name) => name,
        Err(_) => return Ok(None),
    };
    let pane_id = match std::env::var("ZELLIJ_PANE_ID") {
        Ok(id) => id
            .parse::<u32>()
            .context("Invalid ZELLIJ_PANE_ID in agent hook")?,
        Err(_) => return Ok(None),
    };
    validate_session_name(&session_name).map_err(anyhow::Error::msg)?;
    let mut payload = Vec::new();
    input
        .take(MAX_HOOK_INPUT_SIZE + 1)
        .read_to_end(&mut payload)?;
    if payload.len() as u64 > MAX_HOOK_INPUT_SIZE {
        bail!("Agent session hook input is too large");
    }
    let payload: Value =
        serde_json::from_slice(&payload).context("Invalid agent session hook JSON")?;
    let session_id = payload["session_id"]
        .as_str()
        .or_else(|| payload["sessionId"].as_str())
        .context("Agent session hook did not supply a session ID")?;
    let cwd = PathBuf::from(
        payload["cwd"]
            .as_str()
            .context("Agent hook did not supply its folder")?,
    );
    if !cwd.is_absolute() {
        bail!("Agent session folder must be absolute");
    }
    let system = processes();
    let mut pid = Pid::from_u32(std::process::id());
    let mut owner = None;
    for _ in 0..32 {
        let Some(process) = system.process(pid) else {
            break;
        };
        let command = process_command(process);
        if invocation(&command).is_some_and(|(kind, _)| kind == agent) {
            resume_command(&command, agent, session_id, cwd.clone()).map_err(anyhow::Error::msg)?;
            owner = Some((pid.as_u32(), process.start_time(), command));
            break;
        }
        let Some(parent) = process.parent() else {
            break;
        };
        if parent == pid {
            break;
        }
        pid = parent;
    }
    let (process_id, process_start, command) = owner
        .context("Cannot bind the agent chat to its terminal process; recovery was not changed")?;
    let record = AgentSession {
        agent,
        session_id: session_id.to_owned(),
        cwd,
        command,
        process_id,
        process_start,
        socket_identity: socket_identity(&ZELLIJ_SOCK_DIR.join(&session_name))?,
    };
    atomic_write(
        &record_path(&session_info_folder_for_session(&session_name), pane_id),
        &serde_json::to_vec_pretty(&record)?,
    )?;
    Ok(Some(session_name))
}

fn is_descendant(system: &System, mut pid: Pid, root: Pid) -> bool {
    for _ in 0..64 {
        if pid == root {
            return true;
        }
        let Some(parent) = system.process(pid).and_then(|process| process.parent()) else {
            return false;
        };
        if parent == pid {
            return false;
        }
        pid = parent;
    }
    false
}

fn validated_command(
    record: &AgentSession,
    socket: &str,
    pane_pid: u32,
    system: &System,
) -> Result<Option<RunCommand>> {
    if record.socket_identity != socket {
        return Ok(None);
    }
    let pid = Pid::from_u32(record.process_id);
    let Some(process) = system.process(pid) else {
        return Ok(None);
    };
    if process.start_time() != record.process_start
        || process_command(process) != record.command
        || !is_descendant(system, pid, Pid::from_u32(pane_pid))
    {
        return Ok(None);
    }
    resume_command(
        &record.command,
        record.agent,
        &record.session_id,
        record.cwd.clone(),
    )
    .map(Some)
    .map_err(anyhow::Error::msg)
}

pub(crate) fn pane_resumptions(panes: &[(u32, u32)]) -> HashMap<u32, RunCommand> {
    let Ok(session_name) = envs::get_session_name() else {
        return HashMap::new();
    };
    let directory = session_info_folder_for_session(&session_name);
    let mut records = Vec::new();
    for &(pane_id, pane_pid) in panes {
        let path = record_path(&directory, pane_id);
        match fs::File::open(&path) {
            Ok(file) => {
                let record = serde_json::from_reader::<_, AgentSession>(file.take(MAX_RECORD_SIZE));
                match record {
                    Ok(record) => records.push((pane_id, pane_pid, record)),
                    Err(error) => {
                        log::error!("Invalid agent recovery record {}: {error}", path.display())
                    },
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => log::error!(
                "Cannot read agent recovery record {}: {error}",
                path.display()
            ),
        }
    }
    if records.is_empty() {
        return HashMap::new();
    }
    let socket = match socket_identity(&ZELLIJ_SOCK_DIR.join(session_name)) {
        Ok(identity) => identity,
        Err(error) => {
            log::error!("Cannot verify agent recovery session: {error:#}");
            return HashMap::new();
        },
    };
    let system = processes();
    let mut commands = HashMap::new();
    for (pane_id, pane_pid, record) in records {
        match validated_command(&record, &socket, pane_pid, &system) {
            Ok(Some(command)) => {
                commands.insert(pane_id, command);
            },
            Ok(None) => {},
            Err(error) => log::error!("Cannot resume agent in pane {pane_id}: {error:#}"),
        }
    }
    commands
}

fn merge_hook(path: &Path, event: &str, hook: Value, grouped: bool) -> Result<()> {
    let original = match fs::read(path) {
        Ok(contents) => Some(contents),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    let mut config: Value = match &original {
        Some(contents) => serde_json::from_slice(contents)
            .with_context(|| format!("Will not overwrite invalid settings: {}", path.display()))?,
        None => json!({}),
    };
    let object = config
        .as_object_mut()
        .context("Agent settings must be a JSON object")?;
    if !grouped {
        match object.get("version") {
            None => {
                object.insert("version".into(), json!(1));
            },
            Some(version) if version == 1 => {},
            Some(_) => bail!("Unsupported Copilot hook configuration version"),
        }
    }
    let hooks = object
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Agent hooks must be a JSON object")?;
    let entries = hooks
        .entry(event)
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .context("Agent hook event must be an array")?;
    // Replace only our own entry. Other hooks and settings stay in their original order.
    if grouped {
        for entry in entries.iter_mut() {
            if let Some(hooks) = entry["hooks"].as_array_mut() {
                hooks.retain(|hook| !is_our_hook(hook));
            }
        }
        entries.retain(|entry| !entry["hooks"].as_array().is_some_and(Vec::is_empty));
    } else {
        entries.retain(|entry| !is_our_hook(entry));
    }
    entries.push(if grouped {
        json!({"hooks":[hook]})
    } else {
        hook
    });
    if let Some(original) = original {
        let backup = path.with_extension("json.switchboard-resume.bak");
        if !backup.exists() {
            atomic_write(&backup, &original)?;
        }
    }
    atomic_write(path, &serde_json::to_vec_pretty(&config)?)?;
    Ok(())
}

fn is_our_hook(hook: &Value) -> bool {
    let Some(command) = hook["command"].as_str() else {
        return false;
    };
    if command.contains(" agent-resume record --agent ") {
        return true;
    }
    #[cfg(windows)]
    {
        use base64::{engine::general_purpose::STANDARD, Engine};
        if let Some((_, encoded)) = command.split_once(" -EncodedCommand ") {
            if let Ok(bytes) = STANDARD.decode(encoded.trim()) {
                let words: Vec<u16> = bytes
                    .chunks_exact(2)
                    .map(|word| u16::from_le_bytes([word[0], word[1]]))
                    .collect();
                return String::from_utf16_lossy(&words).contains(" agent-resume record --agent ");
            }
        }
    }
    false
}

fn hook_command(binary: &Path, agent: AgentKind) -> String {
    let binary = binary.to_string_lossy().replace('\'', "'\\''");
    #[cfg(not(windows))]
    {
        format!("'{binary}' agent-resume record --agent {}", agent.name())
    }
    #[cfg(windows)]
    {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let binary = binary.replace("'\\''", "''");
        let script = format!(
            "$utf8=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$utf8; $OutputEncoding=$utf8; $payload=[Console]::In.ReadToEnd(); $payload | & '{binary}' agent-resume record --agent {}; exit $LASTEXITCODE",
            agent.name()
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
            STANDARD.encode(bytes)
        )
    }
}

pub fn install_hooks(binary: &Path) -> Result<()> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .context("Cannot locate the user's home directory")?;
    let binary = if binary.is_absolute() {
        binary.to_path_buf()
    } else {
        std::env::current_dir()?.join(binary)
    };
    if !binary.is_file() {
        bail!(
            "Cannot locate the recovery hook executable: {}",
            binary.display()
        );
    }
    for (agent, variable, directory, file) in [
        (AgentKind::Codex, "CODEX_HOME", ".codex", "hooks.json"),
        (
            AgentKind::Claude,
            "CLAUDE_CONFIG_DIR",
            ".claude",
            "settings.json",
        ),
        (
            AgentKind::Copilot,
            "COPILOT_HOME",
            ".copilot",
            "hooks/switchboard-resume.json",
        ),
    ] {
        let directory = std::env::var_os(variable)
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(directory));
        let path = file
            .split('/')
            .fold(directory, |path, component| path.join(component));
        let grouped = agent != AgentKind::Copilot;
        for event in if grouped {
            ["SessionStart", "UserPromptSubmit"]
        } else {
            ["sessionStart", "userPromptSubmitted"]
        } {
            merge_hook(
                &path,
                event,
                json!({
                    "type": "command",
                    "command": hook_command(&binary, agent),
                    "timeout": 10
                }),
                grouped,
            )?;
        }
        println!(
            "Installed {} recovery hooks: {}",
            agent.name(),
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_hooks_preserves_settings_and_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let original = br#"{"model":"example","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing-hook"}]}]}}"#;
        fs::write(&path, original).unwrap();
        let hook =
            json!({"type":"command","command":"'zellij' agent-resume record --agent claude"});
        for _ in 0..2 {
            merge_hook(&path, "SessionStart", hook.clone(), true).unwrap();
        }
        let config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["model"], "example");
        assert_eq!(config["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
        assert_eq!(
            config["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "existing-hook"
        );
        assert_eq!(
            fs::read(path.with_extension("json.switchboard-resume.bak")).unwrap(),
            original
        );
    }

    #[test]
    fn invalid_settings_are_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        fs::write(&path, "not json").unwrap();
        assert!(merge_hook(&path, "SessionStart", json!({}), true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "not json");
    }

    #[test]
    fn copilot_hooks_have_a_version_and_preserve_unrelated_handlers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hooks.json");
        let hook = json!({"type":"command","command":hook_command(Path::new("zellij"), AgentKind::Copilot)});
        merge_hook(
            &path,
            "sessionStart",
            json!({"type":"command","command":"existing-hook"}),
            false,
        )
        .unwrap();
        for _ in 0..2 {
            merge_hook(&path, "sessionStart", hook.clone(), false).unwrap();
        }
        let config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(config["version"], 1);
        assert_eq!(config["hooks"]["sessionStart"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn reinstalling_preserves_other_hooks_in_a_shared_matcher_group() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("hooks.json");
        let hook =
            json!({"type":"command","command":hook_command(Path::new("zellij"), AgentKind::Codex)});
        fs::write(
            &path,
            serde_json::to_vec(&json!({"hooks":{"SessionStart":[{
                "matcher":"startup",
                "hooks":[hook.clone(), {"type":"command","command":"other-hook"}]
            }]}}))
            .unwrap(),
        )
        .unwrap();
        merge_hook(&path, "SessionStart", hook, true).unwrap();
        let config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(config["hooks"]["SessionStart"][0]["matcher"], "startup");
        assert_eq!(
            config["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "other-hook"
        );
        assert_eq!(config["hooks"]["SessionStart"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn recovery_records_reject_replaced_sessions_and_reused_process_ids() {
        let system = processes();
        let pid = Pid::from_u32(std::process::id());
        let process = system.process(pid).unwrap();
        let mut record = AgentSession {
            agent: AgentKind::Copilot,
            session_id: "11111111-2222-4333-8444-555555555555".into(),
            cwd: std::env::current_dir().unwrap(),
            command: process_command(process),
            process_id: pid.as_u32(),
            process_start: process.start_time(),
            socket_identity: "original".into(),
        };
        assert!(
            validated_command(&record, "replacement", pid.as_u32(), &system)
                .unwrap()
                .is_none()
        );
        record.process_start = 0;
        assert!(
            validated_command(&record, "original", pid.as_u32(), &system)
                .unwrap()
                .is_none()
        );
    }
}
