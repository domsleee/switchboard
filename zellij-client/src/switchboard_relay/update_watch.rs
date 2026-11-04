//! Starts this computer's update job as soon as a newer main build is published,
//! instead of leaving it to the job's own schedule. The relay checks every two
//! minutes; on Windows the tray checks that often itself, so this does nothing there.
use super::*;

const EVERY: Duration = Duration::from_secs(120);

pub(super) async fn watch() {
    if cfg!(windows) {
        return;
    }
    loop {
        tokio::time::sleep(EVERY).await;
        // The job is how updates run; without it there is nothing to start.
        if !agent_setup::automatic_updates() {
            continue;
        }
        match tokio::task::spawn_blocking(crate::switchboard_update::newer_build_published).await {
            Ok(Ok(true)) => start_update_job().await,
            Ok(Err(error)) => log::debug!("Update check: {error:#}"),
            _ => {},
        }
    }
}

/// Start the update job now. Starting a job that is already running does nothing,
/// and the updater's own lock keeps two runs apart.
async fn start_update_job() {
    match update_now().await {
        Ok(()) => log::info!("Started the update job for a newer build"),
        Err(error) => log::warn!("{error}"),
    }
}

/// Start this computer's update job, as Settings → Health's Update now does. The
/// updater still installs only a newer build, so this never reinstalls the running one.
pub(super) async fn update_now() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = tokio::process::Command::new("systemctl");
        command.args([
            "--user",
            "start",
            "--no-block",
            "switchboard-update.service",
        ]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = tokio::process::Command::new("launchctl");
        command.arg("kickstart").arg(format!(
            "gui/{}/dev.switchboard.update",
            nix::unistd::getuid()
        ));
        command
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        match command.status().await {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("Could not start the update job: {status}")),
            Err(error) => Err(format!("Could not start the update job: {error}")),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        Err("This computer's tray checks for updates every 2 minutes".into())
    }
}
