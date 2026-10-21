use clap::ValueEnum;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use crate::input::command::RunCommand;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Codex,
    Claude,
    Copilot,
}

impl AgentKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Copilot => "copilot",
        }
    }
}

pub fn invocation(command: &[String]) -> Option<(AgentKind, usize)> {
    let executable = command
        .first()?
        .rsplit(['/', '\\'])
        .next()?
        .to_ascii_lowercase();
    let executable = executable
        .strip_suffix(".exe")
        .or_else(|| executable.strip_suffix(".cmd"))
        .or_else(|| executable.strip_suffix(".ps1"))
        .unwrap_or(&executable);
    match executable {
        "codex" => Some((AgentKind::Codex, 0)),
        "claude" => Some((AgentKind::Claude, 0)),
        "copilot" => Some((AgentKind::Copilot, 0)),
        "node" | "bun" => {
            let script = command.get(1)?.replace('\\', "/").to_ascii_lowercase();
            if script.ends_with("/@anthropic-ai/claude-code/cli.js") {
                Some((AgentKind::Claude, 1))
            } else if script.ends_with("/@github/copilot/index.js") {
                Some((AgentKind::Copilot, 1))
            } else {
                None
            }
        },
        _ => None,
    }
}

pub fn resume_command(
    launch: &[String],
    agent: AgentKind,
    session_id: &str,
    cwd: PathBuf,
) -> Result<RunCommand, String> {
    let id = Uuid::parse_str(session_id)
        .map_err(|_| "Agent recovery requires a full session UUID".to_owned())?;
    let (actual_agent, executable_index) =
        invocation(launch).ok_or("Unrecognized agent executable")?;
    if actual_agent != agent {
        return Err("Agent executable does not match the session hook".into());
    }
    let mut command = launch[..=executable_index].to_vec();
    let mut args = launch[executable_index + 1..].iter().peekable();
    while let Some(arg) = args.next() {
        let (flag, inline_value) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(flag, value)| (flag, Some(value)));
        if matches!(flag, "--help" | "-h" | "--version" | "-V")
            || matches!(flag, "--print" | "--prompt" | "--connect" | "--remote")
            || agent != AgentKind::Codex && flag == "-p"
            || agent == AgentKind::Claude && flag == "--no-session-persistence"
        {
            return Err(format!("Cannot automatically resume {flag} invocations"));
        }
        if agent == AgentKind::Codex
            && matches!(
                flag,
                "exec"
                    | "e"
                    | "review"
                    | "app-server"
                    | "exec-server"
                    | "agents"
                    | "mcp"
                    | "login"
                    | "logout"
                    | "debug"
                    | "app"
                    | "help"
            )
        {
            return Err("Only interactive Codex conversations can be resumed".into());
        }
        if agent == AgentKind::Codex && matches!(flag, "resume" | "fork") {
            if args.peek().is_some_and(|arg| !arg.starts_with('-')) {
                args.next();
            }
            continue;
        }
        if matches!(agent, AgentKind::Codex | AgentKind::Copilot) && matches!(flag, "-C" | "--cd") {
            if inline_value.is_none() {
                args.next()
                    .ok_or_else(|| format!("Missing value for {flag}"))?;
            }
            continue;
        }
        if agent == AgentKind::Copilot && matches!(flag, "--worktree" | "-w") {
            if inline_value.is_none() && args.peek().is_some_and(|arg| !arg.starts_with('-')) {
                args.next();
            }
            continue;
        }
        if matches!(flag, "--resume" | "-r" | "--session-id") {
            if inline_value.is_none() && args.peek().is_some_and(|arg| !arg.starts_with('-')) {
                args.next();
            }
            continue;
        }
        if matches!(flag, "--continue" | "--fork-session")
            || agent == AgentKind::Claude && flag == "-c"
            || agent == AgentKind::Codex
                && matches!(flag, "--last" | "--all" | "--include-non-interactive")
        {
            continue;
        }
        if flag == "--" {
            break;
        }
        if !flag.starts_with('-') {
            // Initial prompts must not be submitted again after a restart.
            continue;
        }
        if takes_value(agent, flag) {
            command.push(arg.clone());
            if inline_value.is_none() {
                command.push(
                    args.next()
                        .ok_or_else(|| format!("Missing value for {flag}"))?
                        .clone(),
                );
            }
            if agent == AgentKind::Claude
                && matches!(
                    flag,
                    "--add-dir"
                        | "--allowedTools"
                        | "--allowed-tools"
                        | "--disallowedTools"
                        | "--disallowed-tools"
                        | "--tools"
                        | "--mcp-config"
                        | "--betas"
                )
            {
                while args.peek().is_some_and(|arg| !arg.starts_with('-')) {
                    command.push(args.next().unwrap().clone());
                }
            }
        } else if switch(agent, flag) && inline_value.is_none() {
            command.push(arg.clone());
        } else {
            return Err(format!(
                "Unknown {} recovery option {flag}; leaving the command suspended",
                agent.name()
            ));
        }
    }
    command.push(
        if agent == AgentKind::Codex {
            "resume"
        } else {
            "--resume"
        }
        .into(),
    );
    command.push(id.to_string());
    Ok(RunCommand {
        command: PathBuf::from(&command[0]),
        args: command[1..].to_vec(),
        cwd: Some(cwd),
        hold_on_close: true,
        ..Default::default()
    })
}

pub fn is_exact_resume(command: &RunCommand) -> bool {
    let mut launch = vec![command.command.to_string_lossy().into_owned()];
    launch.extend(command.args.clone());
    let Some((agent, _)) = invocation(&launch) else {
        return false;
    };
    let Some(id) = launch.last() else {
        return false;
    };
    resume_command(&launch, agent, id, PathBuf::new())
        .map(|normalized| normalized.command == command.command && normalized.args == command.args)
        .unwrap_or(false)
}

fn takes_value(agent: AgentKind, flag: &str) -> bool {
    match agent {
        AgentKind::Codex => matches!(
            flag,
            "-c" | "--config"
                | "--enable"
                | "--disable"
                | "-m"
                | "--model"
                | "-p"
                | "--profile"
                | "-s"
                | "--sandbox"
                | "-C"
                | "--cd"
                | "--add-dir"
                | "--local-provider"
                | "--color"
        ),
        AgentKind::Claude => matches!(
            flag,
            "--agent"
                | "--agents"
                | "--model"
                | "--fallback-model"
                | "--effort"
                | "--permission-mode"
                | "--allowedTools"
                | "--allowed-tools"
                | "--disallowedTools"
                | "--disallowed-tools"
                | "--tools"
                | "--add-dir"
                | "--settings"
                | "--setting-sources"
                | "--mcp-config"
                | "--plugin-dir"
                | "--plugin-url"
                | "--system-prompt"
                | "--append-system-prompt"
                | "--system-prompt-file"
                | "--append-system-prompt-file"
                | "--betas"
                | "--debug-file"
                | "--name"
        ),
        AgentKind::Copilot => matches!(
            flag,
            "--agent"
                | "--model"
                | "--reasoning-effort"
                | "--context-tier"
                | "--service-tier"
                | "--mode"
                | "--max-ai-credits"
                | "--add-dir"
                | "--allow-tool"
                | "--deny-tool"
                | "--allow-url"
                | "--deny-url"
                | "--additional-mcp-config"
                | "--disable-mcp-server"
                | "--plugin-dir"
                | "--log-dir"
                | "--log-level"
                | "--theme"
                | "--name"
                | "-n"
                | "-C"
                | "--cd"
                | "--max-autopilot-continues"
        ),
    }
}

fn switch(agent: AgentKind, flag: &str) -> bool {
    match agent {
        AgentKind::Codex => matches!(
            flag,
            "--yolo"
                | "--dangerously-bypass-approvals-and-sandbox"
                | "--approve-for-me"
                | "--full-auto"
                | "--oss"
                | "--no-alt-screen"
                | "--no-daemon"
                | "--search"
                | "--strict-config"
                | "--dangerously-bypass-hook-trust"
        ),
        AgentKind::Claude => matches!(
            flag,
            "--dangerously-skip-permissions"
                | "--allow-dangerously-skip-permissions"
                | "--strict-mcp-config"
                | "--verbose"
                | "--chrome"
                | "--no-chrome"
                | "--disable-slash-commands"
                | "--ide"
        ),
        AgentKind::Copilot => matches!(
            flag,
            "--yolo"
                | "--allow-all"
                | "--allow-all-tools"
                | "--allow-all-paths"
                | "--allow-all-urls"
                | "--disallow-temp-dir"
                | "--no-ask-user"
                | "--disable-builtin-mcps"
                | "--disable-parallel-tools-execution"
                | "--no-auto-update"
                | "--no-custom-instructions"
                | "--no-mcp"
                | "--no-remote"
                | "--no-remote-export"
                | "--no-color"
                | "--no-eager-powershell-resolution"
                | "--experimental"
                | "--assisted-approval"
                | "--banner"
                | "--screen-reader"
                | "--plain-diff"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111-2222-4333-8444-555555555555";
    const OLD_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    fn command(args: &[&str], agent: AgentKind) -> RunCommand {
        resume_command(
            &args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>(),
            agent,
            ID,
            PathBuf::from("project"),
        )
        .unwrap()
    }

    #[test]
    fn exact_agent_resumes_preserve_options_without_replaying_prompts() {
        for (agent, launch, expected) in [
            (
                AgentKind::Codex,
                vec![
                    "codex",
                    "-m",
                    "my-model",
                    "-c",
                    "service_tier=\"default\"",
                    "--yolo",
                    "fix it",
                ],
                vec![
                    "-m",
                    "my-model",
                    "-c",
                    "service_tier=\"default\"",
                    "--yolo",
                    "resume",
                    ID,
                ],
            ),
            (
                AgentKind::Claude,
                vec![
                    "claude",
                    "--dangerously-skip-permissions",
                    "--model=opus",
                    "review this",
                ],
                vec![
                    "--dangerously-skip-permissions",
                    "--model=opus",
                    "--resume",
                    ID,
                ],
            ),
            (
                AgentKind::Copilot,
                vec!["copilot", "--yolo", "--model", "my-model"],
                vec!["--yolo", "--model", "my-model", "--resume", ID],
            ),
        ] {
            let result = command(&launch, agent);
            assert_eq!(result.args, expected);
            assert_eq!(result.cwd, Some(PathBuf::from("project")));
            assert!(result.hold_on_close);
            assert!(is_exact_resume(&result));
        }
    }

    #[test]
    fn current_hook_identity_replaces_old_resume_continue_and_fork_options() {
        for (agent, launch) in [
            (AgentKind::Codex, vec!["codex", "resume", OLD_ID, "--last"]),
            (AgentKind::Codex, vec!["codex", "fork", OLD_ID]),
            (
                AgentKind::Claude,
                vec!["claude", "--resume", OLD_ID, "--fork-session", "-c"],
            ),
            (
                AgentKind::Copilot,
                vec!["copilot", "--session-id", OLD_ID, "--continue"],
            ),
        ] {
            let result = command(&launch, agent);
            assert_eq!(result.args.last().unwrap(), ID);
            assert!(!result.args.iter().any(|arg| arg == OLD_ID));
            assert!(is_exact_resume(&result));
        }
    }

    #[test]
    fn windows_native_and_node_launchers_keep_their_executable_paths() {
        let result = command(
            &[r"C:\Program Files\Copilot\copilot.exe", "--yolo"],
            AgentKind::Copilot,
        );
        assert_eq!(
            result.command,
            PathBuf::from(r"C:\Program Files\Copilot\copilot.exe")
        );
        let script = r"C:\npm\node_modules\@anthropic-ai\claude-code\cli.js";
        let result = command(&["node", script, "--model", "sonnet"], AgentKind::Claude);
        assert_eq!(result.args[0], script);
        assert!(is_exact_resume(&result));
    }

    #[test]
    fn resumes_use_the_captured_folder_instead_of_repeating_directory_changes() {
        for (agent, launch) in [
            (
                AgentKind::Codex,
                vec!["codex", "-C", "relative-folder", "--no-daemon"],
            ),
            (
                AgentKind::Copilot,
                vec![
                    "copilot",
                    "--cd=relative-folder",
                    "--worktree",
                    "branch",
                    "--yolo",
                ],
            ),
        ] {
            let resumed = command(&launch, agent);
            assert_eq!(resumed.cwd, Some(PathBuf::from("project")));
            assert!(!resumed
                .args
                .iter()
                .any(|arg| arg.contains("relative-folder") || arg == "branch"));
            assert!(is_exact_resume(&resumed));
        }
    }

    #[test]
    fn variadic_claude_options_and_copilot_accessibility_switches_are_preserved() {
        let resumed = command(
            &[
                "claude",
                "--allowedTools",
                "Read",
                "Edit",
                "--add-dir",
                "one",
                "two",
                "--model",
                "opus",
            ],
            AgentKind::Claude,
        );
        assert_eq!(
            resumed.args,
            [
                "--allowedTools",
                "Read",
                "Edit",
                "--add-dir",
                "one",
                "two",
                "--model",
                "opus",
                "--resume",
                ID
            ]
        );
        let resumed = command(
            &["copilot", "--screen-reader", "--banner", "--yolo"],
            AgentKind::Copilot,
        );
        assert_eq!(
            resumed.args,
            ["--screen-reader", "--banner", "--yolo", "--resume", ID]
        );
        assert!(is_exact_resume(&resumed));
    }

    #[test]
    fn unsafe_or_unknown_launches_are_not_automatically_replayed() {
        for (agent, args) in [
            (AgentKind::Codex, vec!["codex", "exec", "fix it"]),
            (AgentKind::Codex, vec!["codex", "--remote", "ws://remote"]),
            (AgentKind::Claude, vec!["claude", "-p", "fix it"]),
            (
                AgentKind::Claude,
                vec!["claude", "--no-session-persistence"],
            ),
            (AgentKind::Copilot, vec!["copilot", "--prompt", "fix it"]),
            (
                AgentKind::Copilot,
                vec!["copilot", "--unknown-option", "value"],
            ),
        ] {
            assert!(resume_command(
                &args.into_iter().map(String::from).collect::<Vec<_>>(),
                agent,
                ID,
                PathBuf::new(),
            )
            .is_err());
        }
        assert!(!is_exact_resume(&RunCommand::new("bash".into())));
        assert!(!is_exact_resume(&RunCommand {
            command: "codex".into(),
            args: vec!["resume".into(), "--last".into()],
            ..Default::default()
        }));
    }
}
