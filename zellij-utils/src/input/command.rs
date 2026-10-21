//! Trigger a command
use crate::data::{Direction, OriginatingPlugin};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub enum TerminalAction {
    OpenFile(OpenFilePayload),
    RunCommand(RunCommand),
}

impl TerminalAction {
    pub fn change_cwd(&mut self, new_cwd: PathBuf) {
        match self {
            TerminalAction::OpenFile(open_file_payload) => {
                open_file_payload.cwd = Some(new_cwd);
            },
            TerminalAction::RunCommand(run_command) => {
                run_command.cwd = Some(new_cwd);
            },
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenFilePayload {
    pub path: PathBuf,
    pub line_number: Option<usize>,
    pub cwd: Option<PathBuf>,
    pub originating_plugin: Option<OriginatingPlugin>,
}

impl Default for OpenFilePayload {
    fn default() -> Self {
        OpenFilePayload {
            path: PathBuf::new(),
            line_number: None,
            cwd: None,
            originating_plugin: None,
        }
    }
}

impl OpenFilePayload {
    pub fn new(path: PathBuf, line_number: Option<usize>, cwd: Option<PathBuf>) -> Self {
        OpenFilePayload {
            path,
            line_number,
            cwd,
            originating_plugin: None,
        }
    }
    pub fn with_originating_plugin(mut self, originating_plugin: OriginatingPlugin) -> Self {
        self.originating_plugin = Some(originating_plugin);
        self
    }
}

#[derive(Clone, Debug, Deserialize, Default, Serialize, PartialEq, Eq)]
pub struct RunCommand {
    #[serde(alias = "cmd")]
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub hold_on_close: bool,
    #[serde(default)]
    pub hold_on_start: bool,
    #[serde(default)]
    pub originating_plugin: Option<OriginatingPlugin>,
    #[serde(default)]
    pub use_terminal_title: bool,
    #[serde(skip)]
    pub is_verified_agent_resume: bool,
}

impl std::fmt::Display for RunCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut command: String = self
            .command
            .as_path()
            .as_os_str()
            .to_string_lossy()
            .to_string();
        for arg in &self.args {
            command.push(' ');
            command.push_str(arg);
        }
        write!(f, "{}", command)
    }
}

/// Intermediate representation
#[derive(Clone, Debug, Deserialize, Default, Serialize, PartialEq, Eq)]
pub struct RunCommandAction {
    #[serde(rename = "cmd")]
    pub command: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub direction: Option<Direction>,
    #[serde(default)]
    pub hold_on_close: bool,
    #[serde(default)]
    pub hold_on_start: bool,
    #[serde(default)]
    pub originating_plugin: Option<OriginatingPlugin>,
    #[serde(default)]
    pub use_terminal_title: bool,
}

impl From<RunCommandAction> for RunCommand {
    fn from(action: RunCommandAction) -> Self {
        RunCommand {
            command: action.command,
            args: action.args,
            cwd: action.cwd,
            hold_on_close: action.hold_on_close,
            hold_on_start: action.hold_on_start,
            originating_plugin: action.originating_plugin,
            use_terminal_title: action.use_terminal_title,
            is_verified_agent_resume: false,
        }
    }
}

impl From<RunCommand> for RunCommandAction {
    fn from(run_command: RunCommand) -> Self {
        RunCommandAction {
            command: run_command.command,
            args: run_command.args,
            cwd: run_command.cwd,
            direction: None,
            hold_on_close: run_command.hold_on_close,
            hold_on_start: run_command.hold_on_start,
            originating_plugin: run_command.originating_plugin,
            use_terminal_title: run_command.use_terminal_title,
        }
    }
}

impl RunCommandAction {
    pub fn new(mut command: Vec<String>) -> Self {
        if command.is_empty() {
            Default::default()
        } else {
            RunCommandAction {
                command: PathBuf::from(command.remove(0)),
                args: command,
                ..Default::default()
            }
        }
    }
    pub fn populate_originating_plugin(&mut self, originating_plugin: OriginatingPlugin) {
        self.originating_plugin = Some(originating_plugin);
    }
}

impl RunCommand {
    pub fn new(command: PathBuf) -> Self {
        RunCommand {
            command,
            ..Default::default()
        }
    }

    pub fn with_cwd(mut self, cwd: PathBuf) -> Self {
        self.cwd = Some(cwd);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_resume_verification_cannot_be_persisted_or_supplied_by_clients() {
        let command = RunCommand {
            command: "claude".into(),
            is_verified_agent_resume: true,
            ..Default::default()
        };
        let serialized = serde_json::to_value(&command).unwrap();
        assert!(serialized.get("is_verified_agent_resume").is_none());
        let restored: RunCommand = serde_json::from_value(serialized).unwrap();
        assert!(!restored.is_verified_agent_resume);

        let supplied: RunCommand = serde_json::from_value(serde_json::json!({
            "command": "claude",
            "is_verified_agent_resume": true
        }))
        .unwrap();
        assert!(!supplied.is_verified_agent_resume);

        let action: RunCommandAction = command.into();
        let restored: RunCommand = action.into();
        assert!(!restored.is_verified_agent_resume);
    }
}
