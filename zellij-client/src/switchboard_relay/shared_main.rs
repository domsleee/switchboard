//! Keeps a shared session on this computer. The sidebar shows only shared sessions and
//! offers to start `main` only on a computer with no sessions at all, so once the shared
//! `main` closed, a computer with other (unshared) sessions vanished from it for good.
use super::*;

const EVERY: Duration = Duration::from_secs(30);

pub(super) async fn keep(state: RelayState) {
    // shortcut: Windows is not covered, since its engine starts sessions differently; add it once tested there.
    if cfg!(windows) {
        return;
    }
    let mut missing_before = false;
    loop {
        tokio::time::sleep(EVERY).await;
        let Some(host) = state
            .order
            .iter()
            .map(|id| state.hosts[id].clone())
            .find(|host| host.is_local_engine())
        else {
            return;
        };
        let missing =
            matches!(control::session_catalog(&host).await, Ok(sessions) if needs_main(&sessions));
        // Seen twice in a row, so a list caught while the engine restarts is not taken for none.
        if missing && missing_before {
            start_main(&host).await;
        }
        missing_before = missing && !missing_before;
    }
}

/// No session is shared, and none is called `main`. An unshared `main` is the user's to keep.
fn needs_main(sessions: &[Value]) -> bool {
    !sessions
        .iter()
        .any(|session| session["web_clients_allowed"] == true || session["name"] == "main")
}

async fn start_main(host: &Host) {
    let Ok(binary) = control::binary(host) else {
        return;
    };
    let run = |args: &[&str]| {
        let mut command = tokio::process::Command::new(&binary);
        command
            .args(args)
            .current_dir(std::env::var_os("HOME").unwrap_or_else(|| "/".into()))
            // The daemonized server inherits these; a pipe here would never close.
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        async move {
            matches!(
                tokio::time::timeout(Duration::from_secs(20), command.status()).await,
                Ok(Ok(status)) if status.success()
            )
        }
    };
    let created = run(&["attach", "--create-background", "main"]).await;
    // Sharing is set afterwards because a config's `web_sharing` can override the create option.
    if !(created && run(&["-s", "main", "action", "set-web-sharing", "on"]).await) {
        log::warn!("Cannot start a shared main session");
        return;
    }
    log::info!("Started a shared main session: this computer had none");
    logs::record(
        &host.config.name,
        "Started a shared 'main' session because this computer had none",
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_is_needed_only_without_a_shared_session_or_any_main() {
        let session =
            |name: &str, shared: bool| json!({"name": name, "web_clients_allowed": shared});
        assert!(needs_main(&[]));
        assert!(needs_main(&[session("adamant-duck", false)]));
        assert!(!needs_main(&[
            session("adamant-duck", false),
            session("work", true)
        ]));
        assert!(!needs_main(&[session("main", false)]));
    }
}
