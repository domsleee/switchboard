//! iTerm2 through AppleScript.

use super::{ForeignTab, Terminal};
use anyhow::{bail, Context, Result};
use std::process::Command;

pub struct ITerm;

/// Run `body` against the session whose unique id is `item 1 of argv`.
/// Arguments are passed as argv, never spliced into the script.
fn with_session(body: &str, args: &[&str]) -> Result<String> {
    osascript(
        &format!(
            r#"on run argv
    tell application "iTerm"
        repeat with w in windows
            repeat with t in tabs of w
                repeat with s in sessions of t
                    if unique id of s is (item 1 of argv) then
                        {body}
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    error "No iTerm session " & (item 1 of argv)
end run"#
        ),
        args,
    )
}

fn osascript(script: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .args(args)
        .output()
        .context("Running osascript")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The shell of a tty: the first process whose parent is not on the tty, or the child of
/// /usr/bin/login when iTerm starts the shell through it. Input: `ps -o pid=,ppid=,args=` lines.
pub(super) fn shell_pid(ps: &str) -> Option<u32> {
    let rows: Vec<(u32, u32, &str)> = ps
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            let args = line.trim_start().splitn(3, char::is_whitespace).nth(2)?;
            Some((pid, ppid, args.trim_start()))
        })
        .collect();
    let (root, _, args) = rows
        .iter()
        .find(|(_, ppid, _)| !rows.iter().any(|(pid, ..)| pid == ppid))?;
    if args.starts_with("/usr/bin/login ") {
        rows.iter()
            .find(|(_, ppid, _)| ppid == root)
            .map(|(pid, ..)| *pid)
    } else {
        Some(*root)
    }
}

impl Terminal for ITerm {
    fn tabs(&self) -> Result<Vec<ForeignTab>> {
        // Asking iTerm for its tabs would launch it.
        let running = Command::new("pgrep").args(["-xq", "iTerm2"]).status()?;
        if !running.success() {
            return Ok(Vec::new());
        }
        let list = osascript(
            r#"set out to ""
tell application "iTerm"
    repeat with w in windows
        repeat with t in tabs of w
            repeat with s in sessions of t
                set out to out & (unique id of s) & (character id 9) & (tty of s) & (character id 9) & (name of s) & linefeed
            end repeat
        end repeat
    end repeat
end tell
return out"#,
            &[],
        )?;
        let mut tabs = Vec::new();
        for line in list.lines() {
            let mut fields = line.splitn(3, '\t');
            let (Some(id), Some(tty), title) = (fields.next(), fields.next(), fields.next()) else {
                continue;
            };
            let Some(tty) = tty.strip_prefix("/dev/") else {
                continue;
            };
            let ps = Command::new("ps")
                .args(["-o", "pid=,ppid=,args=", "-t", tty])
                .output()?;
            let Some(shell_pid) = shell_pid(&String::from_utf8_lossy(&ps.stdout)) else {
                continue;
            };
            tabs.push(ForeignTab {
                id: id.to_owned(),
                title: title.unwrap_or("").to_owned(),
                shell_pid,
            });
        }
        Ok(tabs)
    }

    fn screen(&self, id: &str) -> Result<String> {
        with_session("return contents of s", &[id])
    }

    fn type_text(&self, id: &str, text: &str) -> Result<()> {
        with_session(
            "tell s to write text (item 2 of argv) newline no\nreturn",
            &[id, text],
        )
        .map(drop)
    }

    fn close(&self, id: &str) -> Result<()> {
        with_session("close s\nreturn", &[id]).map(drop)
    }
}

#[cfg(test)]
mod tests {
    use super::shell_pid;

    #[test]
    fn switchboard_absorb_iterm_shell_is_the_child_of_login() {
        let ps = "35329 87199 /usr/bin/login -fqpl dom /Applications/iTerm.app/Contents/MacOS/ShellLauncher --launch_shell SHELL=/Users/dom/.cargo/bin/nu
35330 35329 -nu
35349 35330 /Users/dom/.local/bin/claude --dangerously-skip-permissions
29964 35349 caffeinate -i -t 300";
        assert_eq!(shell_pid(ps), Some(35330));
        // A profile that runs its command directly has no login wrapper.
        assert_eq!(shell_pid("500 1 /bin/zsh -l\n501 500 vim"), Some(500));
        assert_eq!(shell_pid(""), None);
    }
}
