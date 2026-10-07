//! Update decisions and orchestration. Services are simulated: a fake relay
//! reports the commit of the "running" fake executable, and fake helpers
//! record calls, so no real launchd job, tray or terminal engine is touched.
use super::*;
use std::io::Write;
use std::net::{TcpListener, TcpStream};

const OLD: &str = "aaaaaaa";

fn full(c: char) -> String {
    c.to_string().repeat(40)
}

fn session() -> Session {
    ("mac".into(), "main".into(), true)
}

/// A fake executable: enough CLI for update_local.sh, and a relay that refuses
/// to start outside launchd the way a second relay on a taken port fails.
fn fake_binary(root: &Path, commit: &str, extra: &str) -> String {
    let root = root.display();
    format!(
        r#"#!/bin/bash
# commit={commit} {extra}
root='{root}'
echo "${{SWITCHBOARD_FAKE_LAUNCHD:-direct}} $*" >> "$root/events"
case "$*" in
  --version) echo 'zellij 0.0.0' ;;
  'web --list-tokens') echo token-1 ;;
  'list-sessions --no-formatting') echo 'No active zellij sessions found.' >&2; exit 1 ;;
  'web --stop') kill "$(cat "$root/web.pid" 2>/dev/null)" 2>/dev/null; true ;;
  web\ --status*) kill -0 "$(cat "$root/web.pid" 2>/dev/null)" 2>/dev/null ;;
  'web --daemonize') (exec -a "$0 web --start" sleep 20) >/dev/null 2>&1 & echo $! > "$root/web.pid" ;;
  serve*) [ -n "$SWITCHBOARD_FAKE_LAUNCHD" ] || {{ echo 'Address already in use (os error 48)' >&2; exit 1; }}
          exec -a "$0 serve" sleep 20 ;;
esac
"#
    )
}

fn write_executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    make_executable(path).unwrap();
}

/// Relay health/catalog derived from `running`, plus release assets over HTTP.
fn serve(root: PathBuf) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let root = root.clone();
            std::thread::spawn(move || respond(stream, &root));
        }
    });
    port
}

fn respond(mut stream: TcpStream, root: &Path) {
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => return,
            Ok(n) => request.extend_from_slice(&buffer[..n]),
        }
    }
    let request = String::from_utf8_lossy(&request).into_owned();
    let path = request.split_whitespace().nth(1).unwrap_or("/");
    let running = fs::read_to_string(root.join("running"))
        .ok()
        .filter(|binary| !binary.contains("broken"));
    let (status, body) = match (path, running) {
        (path, _) if path.starts_with("/releases/") => {
            match fs::read(root.join("release").join(&path["/releases/".len()..])) {
                Ok(body) => (200, body),
                Err(_) => (404, Vec::new()),
            }
        },
        (_, None) => (503, Vec::new()),
        ("/api/health", Some(binary)) => {
            let start = binary.find("commit=").unwrap() + "commit=".len();
            let commit = &binary[start..start + 7];
            let body = serde_json::json!({"relay": "rust", "commit": commit});
            (200, body.to_string().into_bytes())
        },
        ("/api/hosts", Some(_)) => (
            200,
            fs::read(root.join("hosts.json")).unwrap_or_else(|_| {
                br#"[{"id":"mac","sessions":[{"name":"main","web_clients_allowed":true}]}]"#
                    .to_vec()
            }),
        ),
        _ => (404, Vec::new()),
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} Fake\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(&body);
}

struct Harness {
    _dir: tempfile::TempDir,
    root: PathBuf,
    port: u16,
    /// Use the real update_local.sh with a fake launchctl.
    launchd: bool,
    updater: Updater,
}

impl Drop for Harness {
    fn drop(&mut self) {
        for name in ["web.pid", "serve.pid"] {
            if let Ok(pid) = fs::read_to_string(self.root.join(name)) {
                let _ = Command::new("kill").arg(pid.trim()).status();
            }
        }
    }
}

impl Harness {
    fn new(windows: bool) -> Self {
        Self::build(windows, false)
    }

    fn build(windows: bool, launchd: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        for name in [
            "helpers",
            "state",
            "release",
            "releases",
            "installed",
            "fakebin",
        ] {
            fs::create_dir(root.join(name)).unwrap();
        }
        let port = serve(root.clone());
        let installed = root.join("installed/zellij");
        write_executable(&installed, &fake_binary(&root, OLD, ""));
        fs::copy(&installed, root.join("running")).unwrap();
        let platform = if windows { "windows" } else { "macos-arm64" };
        let harness = Self {
            launchd,
            updater: Updater {
                windows,
                platform: platform.into(),
                check: false,
                config: None,
                host_config: root.join("hosts.json"),
                port,
                binary: installed.clone(),
                release_directory: root.join("releases"),
                state_directory: root.join("state"),
                helpers: root.join("helpers"),
                source: root.join("release").display().to_string(),
                menu_app: root.join("no-app/Switchboard"),
                ready_timeout: Duration::from_secs(1),
            },
            _dir: dir,
            root,
            port,
        };
        harness.write_helpers(&harness.root.join("helpers"), "installed");
        if launchd {
            // Starts web and relay the way the dev.zellij.switchboard job does.
            let installed = installed.display();
            write_executable(
                &harness.root.join("fakebin/launchctl"),
                &format!(
                    r#"#!/bin/bash
root='{root}'
echo "launchctl $*" >> "$root/events"
case "$1" in
  print) echo "arguments = {{ /bin/sh -c exec {installed} serve --host-config hosts.json --port {port} }}" ;;
  kickstart)
    kill "$(cat "$root/serve.pid" 2>/dev/null)" 2>/dev/null
    cp '{installed}' "$root/running"
    '{installed}' web --status --timeout 2 || '{installed}' web --daemonize
    (SWITCHBOARD_FAKE_LAUNCHD=1 exec '{installed}' serve --port {port}) >/dev/null 2>&1 &
    echo $! > "$root/serve.pid" ;;
esac
"#,
                    root = harness.root.display(),
                ),
            );
        }
        if windows {
            let hash = sha256_file(&installed).unwrap();
            fs::create_dir(harness.root.join("releases").join(&hash)).unwrap();
            fs::copy(
                &installed,
                harness.root.join("releases").join(&hash).join("zellij.exe"),
            )
            .unwrap();
            fs::write(
                harness.root.join("releases/current.json"),
                format!("{{\"sha256\":\"{hash}\"}}"),
            )
            .unwrap();
        }
        harness
    }

    /// Functional fake helpers; `version` identifies which copy ran.
    fn write_helpers(&self, directory: &Path, version: &str) {
        let root = self.root.display();
        let calls = format!("Add-Content -LiteralPath '{root}/calls' -Value \"{version}");
        let files: Vec<(&str, String)> = if self.updater.windows {
            vec![
                ("update_windows.ps1", format!(
                    "param([string]$Candidate, [string]$ReleaseDirectory, [string]$Config)\n\
                     if ($env:SWITCHBOARD_UPDATE_BINARY_ONLY -ne '1') {{ throw 'selector must not restart services' }}\n\
                     {calls} select\"\n\
                     $hash = (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLower()\n\
                     New-Item -ItemType Directory -Force -Path (Join-Path $ReleaseDirectory $hash) | Out-Null\n\
                     Copy-Item -LiteralPath $Candidate -Destination (Join-Path $ReleaseDirectory \"$hash/zellij.exe\") -Force\n\
                     Set-Content -LiteralPath (Join-Path $ReleaseDirectory 'current.json') -Value ('{{\"sha256\":\"' + $hash + '\"}}')\n")),
                ("update_services_windows.ps1", format!(
                    "param([string]$Action, [string]$Snapshot, [string]$ReleaseDirectory, [string]$HostConfig, [int]$RelayPort, [string]$Binary)\n\
                     {calls} $Action\"\n\
                     if ($Action -eq 'Snapshot') {{\n\
                       if ($env:SWITCHBOARD_TRAY_SCRIPT -ne '{root}/helpers/switchboard-tray.ps1') {{ throw 'tray not located beside the installed helpers' }}\n\
                       Set-Content -LiteralPath $Snapshot -Value '{{}}' }}\n\
                     if ($Action -eq 'Stop') {{ Remove-Item -LiteralPath '{root}/running' -ErrorAction SilentlyContinue }}\n\
                     if ($Action -eq 'Start') {{ Copy-Item -LiteralPath $Binary -Destination '{root}/running' }}\n")),
                ("install_windows_web.ps1", format!(
                    "param([string]$ReleaseDirectory, [string]$Config)\n{calls} tray\"\n")),
                ("windows_releases.psm1", format!("# {version}\n")),
                ("windows_cli.ps1", format!("# {version}\n")),
                ("auto_update.py", format!("# {version}\n")),
            ]
        } else {
            let script =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../tools/switchboard/update_local.sh");
            let update_local = if self.launchd {
                format!(
                    "#!/bin/bash\nexport PATH='{root}/fakebin':\"$PATH\" SWITCHBOARD_RELEASES_DIR='{root}/retained' SWITCHBOARD_UPDATE_SERVICE_TIMEOUT=4\n\
                     echo \"{version} update_local.sh\" >> '{root}/events'\n\
                     exec bash '{}' \"$@\"\n",
                    script.display()
                )
            } else {
                format!(
                    "#!/bin/sh\necho \"{version} $1 $SWITCHBOARD_EXPECTED_COMMIT\" >> '{root}/calls'\n\
                     cp \"$1\" \"$2\" && cp \"$1\" '{root}/running'\n"
                )
            };
            vec![
                ("update_local.sh", update_local),
                ("install_service.py", format!("# {version}\n")),
                ("menu_bar.swift", "// unchanged menu\n".into()),
                ("auto_update.py", format!("# {version}\n")),
            ]
        };
        for (name, contents) in files {
            write_executable(&directory.join(name), &contents);
        }
    }

    /// Publish release assets exactly as the workflow does: prefixed files,
    /// the manifest last.
    fn publish(&self, commit: &str, run_number: u64, extra: &str) {
        let source = self.root.join(format!("source-{run_number}"));
        let output = self.root.join(format!("bundle-{run_number}"));
        fs::create_dir(&source).unwrap();
        self.write_helpers(&source, &format!("v{run_number}"));
        let binary = source.join(self.updater.exe());
        write_executable(&binary, &fake_binary(&self.root, &commit[..7], extra));
        let platform = &self.updater.platform;
        package(&binary, platform, commit, run_number, &source, &output).unwrap();
        for entry in fs::read_dir(&output).unwrap() {
            let name = entry.unwrap().file_name().into_string().unwrap();
            fs::copy(
                output.join(&name),
                self.root
                    .join("release")
                    .join(format!("switchboard-{platform}-{name}")),
            )
            .unwrap();
        }
    }

    /// A journal like the one the 2026-10-07 interrupted update left behind.
    fn interrupted(&self, previous_commit: &str, recovery_helper: &str) {
        let backup = self.root.join("state/rollback-1791354170155176700");
        fs::create_dir(&backup).unwrap();
        self.write_helpers(&backup, "rollback");
        write_executable(
            &backup.join(self.updater.exe()),
            &fake_binary(&self.root, previous_commit, ""),
        );
        if !recovery_helper.is_empty() {
            write_executable(&backup.join("update_local.sh"), recovery_helper);
        }
        let state = serde_json::json!({
            "run_number": 4,
            "pending": {"backup": backup, "commit": previous_commit,
                        "sessions": [["mac", "main", true]], "processes": {}},
        });
        fs::write(self.root.join("state/state.json"), state.to_string()).unwrap();
    }

    fn state(&self) -> serde_json::Value {
        fs::read(self.root.join("state/state.json")).map_or(serde_json::json!({}), |bytes| {
            serde_json::from_slice(&bytes).unwrap()
        })
    }

    fn calls(&self) -> String {
        fs::read_to_string(self.root.join("calls")).unwrap_or_default()
    }

    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.root.join(path)).unwrap()
    }
}

fn pending(target: Option<&str>) -> Pending {
    Pending {
        backup: String::new(),
        commit: Some(OLD.into()),
        target: target.map(str::to_owned),
        sessions: vec![session()],
        processes: serde_json::json!({}),
    }
}

fn healthy(commit: &str) -> Option<Health> {
    Some(Health {
        relay: Some("rust".into()),
        commit: Some(commit.into()),
    })
}

#[test]
fn interrupted_update_is_recovered_only_when_services_are_unhealthy() {
    let target = full('b');
    let journal = pending(Some(&target));
    let intact = vec![session(), ("mac".into(), "other".into(), false)];
    let resolve = |health: Option<Health>, catalog: Option<&[Session]>| {
        resolve_pending(&journal, health.as_ref(), catalog)
    };
    let discard = |commit: &str| Resolution::Discard(commit.into());
    // Unreachable, non-Rust or partially answering relays need recovery.
    assert_eq!(resolve(None, Some(&intact)), Resolution::Recover);
    let python = Health {
        relay: Some("python".into()),
        commit: Some(OLD.into()),
    };
    assert_eq!(resolve(Some(python), Some(&intact)), Resolution::Recover);
    assert_eq!(resolve(healthy(OLD), None), Resolution::Recover);
    // Healthy with sessions intact, on either side of the interrupted update.
    assert_eq!(resolve(healthy(OLD), Some(&intact)), discard(OLD));
    assert_eq!(
        resolve(healthy("bbbbbbb"), Some(&intact)),
        discard("bbbbbbb")
    );
    // Missing sessions on the journal's own builds: roll back.
    assert_eq!(resolve(healthy(OLD), Some(&[])), Resolution::Recover);
    assert_eq!(resolve(healthy("bbbbbbb"), Some(&[])), Resolution::Recover);
    // Since updated by other means: recovery would downgrade it.
    assert_eq!(resolve(healthy("ccccccc"), Some(&[])), discard("ccccccc"));
    // Python journals record only the previous commit.
    let python_journal = pending(None);
    let resolution = resolve_pending(&python_journal, healthy("ddddddd").as_ref(), Some(&[]));
    assert_eq!(resolution, discard("ddddddd"));
}

#[test]
fn bundles_are_checked_for_provenance_platform_contents_and_checksums() {
    let harness = Harness::new(false);
    harness.publish(&full('b'), 5, "");
    let bundle = harness.root.join("bundle-5");
    let read = || -> Manifest {
        serde_json::from_slice(&fs::read(bundle.join("bundle.json")).unwrap()).unwrap()
    };
    let manifest = read();
    validate_manifest(&manifest, "macos-arm64").unwrap();
    verify_files(&bundle, &manifest).unwrap();
    assert!(validate_manifest(&manifest, "macos-x86_64").is_err());
    assert!(validate_manifest(&manifest, "windows").is_err());
    for change in [
        |m: &mut Manifest| m.commit = "B".repeat(40),
        |m: &mut Manifest| m.commit = "b".repeat(7),
        |m: &mut Manifest| m.run_number = 0,
        |m: &mut Manifest| m.schema = 2,
        |m: &mut Manifest| drop(m.files.insert("../outside".into(), "0".repeat(64))),
        |m: &mut Manifest| drop(m.files.remove("update_local.sh")),
    ] {
        let mut manifest = read();
        change(&mut manifest);
        assert!(validate_manifest(&manifest, "macos-arm64").is_err());
    }
    fs::write(bundle.join("zellij"), "corrupted download").unwrap();
    let error = verify_files(&bundle, &manifest).unwrap_err();
    assert!(error.to_string().contains("checksum"), "{error}");
}

#[test]
fn state_written_by_the_python_updater_round_trips() {
    let text = r#"{"run_number": 7, "commit": "abc", "notice": "n", "extra": [1],
        "pending": {"backup": "/b", "commit": "68a907c", "sessions": [["windows", "main", true]], "processes": {}}}"#;
    let state: State = serde_json::from_str(text).unwrap();
    assert_eq!(state.run_number, Some(7));
    let pending = state.pending.as_ref().unwrap();
    assert_eq!(
        pending.sessions,
        vec![("windows".into(), "main".into(), true)]
    );
    assert_eq!(pending.target, None);
    let saved: serde_json::Value = serde_json::to_value(&state).unwrap();
    assert_eq!(saved["extra"], serde_json::json!([1]));
    assert_eq!(
        saved["pending"]["sessions"],
        serde_json::json!([["windows", "main", true]])
    );
}

#[cfg(unix)]
mod orchestration {
    use super::*;
    // Serial: concurrent helper processes from parallel tests made the lock check flaky.
    use serial_test::serial;

    #[serial]
    #[test]
    fn update_downloads_over_https_shape_and_replaces_helpers_after_verification() {
        let mut harness = Harness::new(false);
        harness.updater.source = format!("http://127.0.0.1:{}/releases/", harness.port);
        harness.publish(&full('b'), 5, "");
        harness.updater.run().unwrap();
        let state = harness.state();
        assert_eq!(state["commit"], full('b'));
        assert_eq!(state["run_number"], 5);
        assert!(state.get("pending").is_none() && state.get("error").is_none());
        // The installed helper ran the handoff with the expected commit.
        assert_eq!(harness.calls().lines().count(), 1);
        assert!(harness.calls().starts_with("installed ") && harness.calls().contains(&full('b')));
        assert!(harness.read("installed/zellij").contains("commit=bbbbbbb"));
        assert!(harness.read("helpers/update_local.sh").contains("v5"));
        // Nothing newer: no further handoff.
        harness.updater.run().unwrap();
        assert_eq!(harness.calls().lines().count(), 1);
    }

    #[serial]
    #[test]
    fn mismatched_assets_from_an_upload_in_progress_are_retried_later() {
        let harness = Harness::new(false);
        harness.publish(&full('b'), 5, "");
        let asset = harness.root.join("release/switchboard-macos-arm64-zellij");
        let original = fs::read(&asset).unwrap();
        fs::write(&asset, "next build's executable").unwrap();
        harness.updater.run().unwrap();
        assert!(harness.calls().is_empty());
        assert!(harness.state().get("run_number").is_none());
        fs::write(&asset, original).unwrap();
        harness.updater.run().unwrap();
        assert_eq!(harness.state()["commit"], full('b'));
    }

    #[serial]
    #[test]
    fn failed_health_rolls_back_and_backs_off_from_the_broken_build() {
        let harness = Harness::new(false);
        harness.publish(&full('b'), 5, "broken");
        assert!(harness.updater.run().is_err());
        let state = harness.state();
        assert!(state.get("pending").is_none());
        assert!(state["error"].as_str().unwrap().contains("did not recover"));
        assert_eq!(state["run_number"], 5);
        assert!(harness.read("installed/zellij").contains(OLD));
        assert!(harness.read("running").contains(OLD));
        assert!(harness
            .read("helpers/update_local.sh")
            .contains("installed"));
        // Rollback used the retained copy of the previous helpers.
        let calls = harness.calls();
        let rollback = calls.lines().nth(1).unwrap();
        assert!(rollback.starts_with("installed ") && rollback.contains("/rollback-"));
        harness.updater.run().unwrap();
        assert_eq!(harness.calls().lines().count(), 2, "broken build retried");
    }

    #[serial]
    #[test]
    fn stale_pending_with_healthy_services_is_discarded_and_update_proceeds() {
        let harness = Harness::new(false);
        harness.interrupted("68a907c", "");
        harness.publish(&full('b'), 4, "");
        harness.updater.run().unwrap();
        let state = harness.state();
        assert!(state.get("pending").is_none());
        let notice = state["notice"].as_str().unwrap();
        assert_eq!(
            notice,
            format!("Discarded stale interrupted update 68a907c; services healthy on {OLD}")
        );
        assert!(harness.calls().is_empty(), "no recovery or downgrade");
        harness.publish(&full('c'), 5, "");
        harness.updater.run().unwrap();
        assert_eq!(harness.state()["commit"], full('c'));
        assert!(harness.calls().starts_with("installed "));
        assert!(!harness.calls().contains("rollback"));
    }

    #[serial]
    #[test]
    fn check_discards_stale_pending_but_refuses_while_services_need_recovery() {
        let mut harness = Harness::new(false);
        harness.updater.check = true;
        harness.interrupted("68a907c", "");
        harness.publish(&full('b'), 5, "");
        fs::remove_file(harness.root.join("running")).unwrap();
        let error = harness.updater.run().unwrap_err();
        assert!(error.to_string().contains("requires recovery"));
        assert!(harness.state().get("pending").is_some());
        fs::write(
            harness.root.join("running"),
            fake_binary(&harness.root, OLD, ""),
        )
        .unwrap();
        harness.updater.run().unwrap();
        assert!(harness.state().get("pending").is_none());
        assert!(harness.calls().is_empty());
    }

    #[serial]
    #[test]
    fn unhealthy_pending_recovers_with_retained_helpers_without_clobbering_installed_ones() {
        let harness = Harness::new(false);
        harness.interrupted("6666666", "");
        harness.publish(&full('b'), 4, "");
        fs::remove_file(harness.root.join("running")).unwrap(); // services down
        harness.updater.run().unwrap();
        let state = harness.state();
        assert!(state.get("pending").is_none());
        assert!(state["notice"]
            .as_str()
            .unwrap()
            .starts_with("Recovered interrupted update"));
        assert!(
            harness.calls().starts_with("rollback "),
            "{}",
            harness.calls()
        );
        assert!(harness.read("running").contains("6666666"));
        for name in ["update_local.sh", "install_service.py", "auto_update.py"] {
            assert!(
                harness
                    .read(&format!("helpers/{name}"))
                    .contains("installed"),
                "{name}"
            );
        }
    }

    #[serial]
    #[test]
    fn failed_recovery_is_recorded_once_and_does_not_block_a_later_update() {
        let harness = Harness::new(false);
        harness.interrupted(
            "6666666",
            "#!/bin/sh\necho 'Engine process changed' >&2\nexit 1\n",
        );
        harness.publish(&full('b'), 5, "");
        fs::remove_file(harness.root.join("running")).unwrap();
        let error = harness.updater.run().unwrap_err();
        assert!(error.to_string().contains("Engine process changed"));
        let state = harness.state();
        assert!(state.get("pending").is_none());
        assert!(state["error"]
            .as_str()
            .unwrap()
            .contains("Recovery of interrupted update failed"));
        assert_eq!(state["run_number"], 4);
        // Services come back by other means; the next run updates normally.
        fs::write(
            harness.root.join("running"),
            fake_binary(&harness.root, OLD, ""),
        )
        .unwrap();
        harness.updater.run().unwrap();
        let state = harness.state();
        assert_eq!(state["commit"], full('b'));
        assert!(state.get("error").is_none());
    }

    #[cfg(target_os = "macos")]
    #[serial]
    #[test]
    fn mac_restart_goes_through_launchd_only_and_rolls_back_through_it() {
        if Command::new("jq").arg("--version").output().is_err() {
            eprintln!("skipped: jq is not installed");
            return;
        }
        let harness = Harness::build(false, true);
        let launchctl = harness.root.join("fakebin/launchctl");
        Command::new(&launchctl)
            .args(["kickstart", "-k", "gui/0/initial"])
            .status()
            .unwrap();
        let events = || harness.read("events");
        let kickstarts = || events().matches("launchctl kickstart -k gui/").count();
        harness.publish(&full('b'), 5, "");
        harness.updater.run().unwrap();
        assert_eq!(harness.state()["commit"], full('b'));
        assert!(harness.read("installed/zellij").contains("commit=bbbbbbb"));
        let log = events();
        let update = log.find("installed update_local.sh").unwrap();
        let stop = update + log[update..].find("direct web --stop").unwrap();
        assert!(stop < update + log[update..].find("launchctl kickstart -k").unwrap());
        assert_eq!(kickstarts(), 2);

        harness.publish(&full('c'), 6, "broken");
        let error = harness.updater.run().unwrap_err();
        assert!(error.to_string().contains("did not come back"), "{error:#}");
        // update_local.sh restored the previous build and restarted it via launchd.
        assert!(harness.read("installed/zellij").contains("commit=bbbbbbb"));
        assert!(harness.read("running").contains("commit=bbbbbbb"));
        assert_eq!(kickstarts(), 4);
        assert!(harness.state().get("pending").is_none());
        assert!(
            !events().contains("direct serve"),
            "relay started outside launchd:\n{}",
            events()
        );
    }

    #[serial]
    #[test]
    fn windows_handoff_and_rollback_use_the_powershell_helpers() {
        if Command::new("pwsh").arg("-Version").output().is_err() {
            eprintln!("skipped: PowerShell 7 (pwsh) is not installed");
            return;
        }
        let harness = Harness::new(true);
        harness.publish(&full('b'), 5, "");
        harness.updater.run().unwrap();
        let steps: Vec<String> = harness.calls().lines().map(str::to_owned).collect();
        let expected = [
            "installed Snapshot",
            "installed select",
            "installed Stop",
            "installed Start",
            "installed Verify",
            "v5 StopTray",
            "v5 tray",
        ];
        assert_eq!(steps, expected);
        let selected = harness.updater.selected_binary().unwrap();
        assert!(fs::read_to_string(selected)
            .unwrap()
            .contains("commit=bbbbbbb"));
        assert_eq!(harness.state()["commit"], full('b'));

        harness.publish(&full('c'), 6, "broken");
        assert!(harness.updater.run().is_err());
        let steps: Vec<String> = harness.calls().lines().skip(7).map(str::to_owned).collect();
        let expected = [
            "v5 Snapshot",
            "v5 select",
            "v5 Stop",
            "v5 Start",
            // rollback: retained helpers, then the installed tray installer
            "v5 select",
            "v5 Stop",
            "v5 Start",
            "v5 Verify",
            "v5 tray",
        ];
        assert_eq!(steps, expected);
        let selected = harness.updater.selected_binary().unwrap();
        assert!(fs::read_to_string(selected)
            .unwrap()
            .contains("commit=bbbbbbb"));
        let state = harness.state();
        assert!(state.get("pending").is_none());
        assert_eq!(state["run_number"], 6);
    }
}
