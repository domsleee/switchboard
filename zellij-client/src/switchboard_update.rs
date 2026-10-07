//! Automatic Switchboard updates from the rolling `latest-main` release.
//!
//! Only connection services (relay, web server, tray) are restarted; terminal
//! engines keep running. Platform helpers shipped in the bundle do the
//! process-preserving work: `update_local.sh` on macOS, the PowerShell release
//! and service helpers on Windows.
use anyhow::{anyhow, bail, ensure, Context, Result};
use isahc::{
    config::{Configurable, RedirectPolicy},
    prelude::*,
    Request,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zellij_utils::cli::{SwitchboardCommand, SwitchboardUpdateCli};

pub const RELEASE_URL: &str =
    "https://github.com/domsleee/switchboard/releases/download/latest-main/";

/// Session identity and sharing as listed by the relay catalog.
type Session = (String, String, bool);

pub fn run(command: &SwitchboardCommand) -> Result<()> {
    match command {
        SwitchboardCommand::Update(cli) => Updater::from_cli(cli)?.run(),
        SwitchboardCommand::Package {
            platform,
            commit,
            run_number,
            helpers,
            output,
        } => package(
            &std::env::current_exe()?,
            platform,
            commit,
            *run_number,
            helpers,
            output,
        ),
    }
}

/// Files in each platform bundle. `auto_update.py` is a forwarding shim for
/// installs whose scheduler still runs the retired Python updater; the old
/// updater also rejects bundles without it.
// ponytail: drop the shim once every machine schedules `zellij switchboard update`.
pub fn bundle_files(platform: &str) -> Result<&'static [&'static str]> {
    Ok(match platform {
        "windows" => &[
            "auto_update.py",
            "install_windows_web.ps1",
            "update_services_windows.ps1",
            "update_windows.ps1",
            "windows_cli.ps1",
            "windows_releases.psm1",
            "zellij.exe",
        ],
        "macos-arm64" | "macos-x86_64" => &[
            "auto_update.py",
            "install_service.py",
            "menu_bar.swift",
            "update_local.sh",
            "zellij",
        ],
        _ => bail!("Unsupported update platform {platform}"),
    })
}

fn executable_name(platform: &str) -> &'static str {
    if platform == "windows" {
        "zellij.exe"
    } else {
        "zellij"
    }
}

fn target_platform() -> Result<&'static str> {
    if cfg!(windows) {
        Ok("windows")
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Ok("macos-arm64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Ok("macos-x86_64")
    } else {
        bail!("Automatic updates currently support Windows and macOS")
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub commit: String,
    pub platform: String,
    #[serde(default)]
    pub run_number: u64,
    pub files: BTreeMap<String, String>,
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_manifest(manifest: &Manifest, platform: &str) -> Result<()> {
    ensure!(
        manifest.schema == 1
            && is_hex(&manifest.commit, 40)
            && manifest.platform == platform
            && manifest.run_number > 0,
        "Bundle provenance or platform does not match this computer"
    );
    let expected: Vec<&str> = bundle_files(platform)?.to_vec();
    let actual: Vec<&str> = manifest.files.keys().map(String::as_str).collect();
    ensure!(
        actual == expected && manifest.files.values().all(|digest| is_hex(digest, 64)),
        "Incomplete or unexpected update bundle"
    );
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    let digest =
        Sha256::digest(fs::read(path).with_context(|| format!("Cannot read {}", path.display()))?);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn verify_files(directory: &Path, manifest: &Manifest) -> Result<()> {
    for (name, digest) in &manifest.files {
        let path = directory.join(name);
        let regular = fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file());
        ensure!(
            regular && sha256_file(&path)? == *digest,
            "Bundle checksum mismatch: {name}"
        );
    }
    Ok(())
}

pub fn package(
    binary: &Path,
    platform: &str,
    commit: &str,
    run_number: u64,
    helpers: &Path,
    output: &Path,
) -> Result<()> {
    fs::create_dir_all(output)?;
    let mut files = BTreeMap::new();
    for name in bundle_files(platform)? {
        let source = if *name == executable_name(platform) {
            binary.to_path_buf()
        } else {
            helpers.join(name)
        };
        let target = output.join(name);
        fs::copy(&source, &target).with_context(|| format!("Cannot stage {}", source.display()))?;
        files.insert(name.to_string(), sha256_file(&target)?);
    }
    let manifest = Manifest {
        schema: 1,
        commit: commit.to_owned(),
        platform: platform.to_owned(),
        run_number,
        files,
    };
    validate_manifest(&manifest, platform)?;
    fs::write(output.join("bundle.json"), serde_json::to_vec(&manifest)?)?;
    Ok(())
}

/// `state.json`, shared with the retired Python updater. Unknown keys are kept.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    #[serde(skip_serializing_if = "Option::is_none")]
    run_number: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

/// Rollback journal, written before the first service mutation.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pending {
    backup: String,
    /// Commit the relay ran before the update; recovery restores it.
    #[serde(default)]
    commit: Option<String>,
    /// Commit being installed (absent in journals written by the Python updater).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    #[serde(default)]
    sessions: Vec<Session>,
    #[serde(default)]
    processes: serde_json::Value,
}

impl State {
    fn load(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => {
                let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
                serde_json::from_slice(bytes).with_context(|| format!("Invalid {}", path.display()))
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error.into()),
        }
    }
    fn save(&self, path: &Path) -> Result<()> {
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec(self)?)?;
        fs::rename(&temporary, path)?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct Health {
    relay: Option<String>,
    commit: Option<String>,
}

/// Short relay commits match full manifest commits by prefix.
fn same_commit(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a.starts_with(b) || b.starts_with(a))
}

#[derive(Debug, PartialEq)]
enum Resolution {
    /// Services are healthy without the journal; carries the running commit.
    Discard(String),
    Recover,
}

/// Decide what an interrupted update's journal still means. Recovery exists
/// for unhealthy services; it must never downgrade a computer that is healthy,
/// or that has since been updated by other means.
fn resolve_pending(
    pending: &Pending,
    health: Option<&Health>,
    catalog: Option<&[Session]>,
) -> Resolution {
    let Some(health) = health.filter(|h| h.relay.as_deref() == Some("rust")) else {
        return Resolution::Recover;
    };
    let running = health.commit.clone().unwrap_or_default();
    let Some(catalog) = catalog else {
        return Resolution::Recover;
    };
    let intact = pending.sessions.iter().all(|s| catalog.contains(s));
    let known = [pending.commit.as_deref(), pending.target.as_deref()];
    let superseded = !known
        .iter()
        .flatten()
        .any(|commit| same_commit(&running, commit));
    if intact || superseded {
        Resolution::Discard(running)
    } else {
        Resolution::Recover
    }
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TrayArguments {
    config: String,
    release_directory: String,
}

pub struct Updater {
    windows: bool,
    platform: String,
    check: bool,
    config: Option<PathBuf>,
    host_config: PathBuf,
    port: u16,
    binary: PathBuf,
    release_directory: PathBuf,
    state_directory: PathBuf,
    helpers: PathBuf,
    source: String,
    menu_app: PathBuf,
    ready_timeout: Duration,
}

impl Updater {
    fn from_cli(cli: &SwitchboardUpdateCli) -> Result<Self> {
        #[allow(deprecated)]
        let home = std::env::home_dir().context("No home directory")?;
        let windows = cfg!(windows);
        let share = home.join(".local/share/switchboard");
        let helpers = cli.helper_directory.clone().unwrap_or_else(|| {
            if windows {
                home.join(".config/switchboard")
            } else {
                share.join("updater")
            }
        });
        // Started by hand or from a bundle: keep the running tray's settings.
        let mut running = TrayArguments::default();
        if windows && (cli.config.is_none() || cli.release_directory.is_none()) {
            let script = helpers.join("update_services_windows.ps1");
            let args = vec!["-Action".into(), "Arguments".into()];
            if let Ok(output) = powershell(&script, args, &[tray_script(&helpers)]) {
                running = serde_json::from_str(&output).unwrap_or_default();
            }
        }
        let given =
            |value: String| Some(PathBuf::from(value)).filter(|p| !p.as_os_str().is_empty());
        Ok(Self {
            windows,
            platform: target_platform()?.to_owned(),
            check: cli.check,
            config: cli.config.clone().or_else(|| given(running.config)),
            host_config: cli.host_config.clone().unwrap_or_else(|| {
                home.join(if windows {
                    ".config/switchboard/hosts.json"
                } else {
                    ".config/zellij/switchboard-hosts.json"
                })
            }),
            port: cli.port.unwrap_or(if windows { 80 } else { 8090 }),
            binary: cli
                .binary
                .clone()
                .unwrap_or_else(|| home.join(".cargo/bin/zellij")),
            release_directory: cli
                .release_directory
                .clone()
                .or_else(|| given(running.release_directory))
                .unwrap_or_else(|| share.join("windows-releases")),
            state_directory: cli
                .state_directory
                .clone()
                .unwrap_or_else(|| share.join("automatic-updates")),
            helpers,
            source: cli.source.clone().unwrap_or_else(|| RELEASE_URL.to_owned()),
            menu_app: home.join("Applications/Switchboard.app/Contents/MacOS/Switchboard"),
            ready_timeout: Duration::from_secs(60),
        })
    }

    fn state_path(&self) -> PathBuf {
        self.state_directory.join("state.json")
    }

    fn exe(&self) -> &'static str {
        executable_name(&self.platform)
    }

    pub fn run(&self) -> Result<()> {
        fs::create_dir_all(&self.state_directory)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.state_directory.join("automatic.lock"))?;
        lock.try_lock()
            .map_err(|_| anyhow!("Another automatic update is running"))?;
        let mut state = State::load(&self.state_path())?;
        if let Some(pending) = state.pending.clone() {
            self.settle_pending(&mut state, &pending)?;
        }
        self.update(&mut state)
    }

    fn settle_pending(&self, state: &mut State, pending: &Pending) -> Result<()> {
        let health = self.health().ok();
        let catalog = self.catalog().ok();
        match resolve_pending(pending, health.as_ref(), catalog.as_deref()) {
            Resolution::Discard(running) => {
                if let Some(target) = pending
                    .target
                    .as_deref()
                    .filter(|t| same_commit(&running, t))
                {
                    state.commit = Some(target.to_owned());
                }
                let interrupted = pending.target.as_deref().or(pending.commit.as_deref());
                let notice = format!(
                    "Discarded stale interrupted update {}; services healthy on {running}",
                    interrupted.unwrap_or("(unknown)")
                );
                println!("{notice}");
                state.notice = Some(notice);
                state.pending = None;
                state.save(&self.state_path())
            },
            Resolution::Recover => {
                ensure!(
                    !self.check,
                    "Interrupted update requires recovery before checking another build"
                );
                let result = self.with_handoff(|| self.recover(pending));
                // Reported once: a failed recovery never blocks later builds.
                state.pending = None;
                match result {
                    Ok(()) => {
                        state.error = None;
                        state.notice = Some(format!(
                            "Recovered interrupted update; services restored on {}",
                            pending.commit.as_deref().unwrap_or("the previous build")
                        ));
                        state.save(&self.state_path())
                    },
                    Err(error) => {
                        state.error = Some(format!(
                            "Recovery of interrupted update failed ({error:#}); services were left as they are. Rollback files: {}",
                            pending.backup
                        ));
                        state.save(&self.state_path())?;
                        Err(error)
                    },
                }
            },
        }
    }

    fn update(&self, state: &mut State) -> Result<()> {
        let asset = |name: &str| format!("switchboard-{}-{name}", self.platform);
        let manifest: Manifest = serde_json::from_slice(&self.fetch(&asset("bundle.json"))?)
            .context("Invalid release manifest")?;
        validate_manifest(&manifest, &self.platform)?;
        if manifest.run_number <= state.run_number.unwrap_or(0) {
            println!("No newer successful main build.");
            return Ok(());
        }
        if !self.check {
            if let Ok(health) = self.health() {
                if health.relay.as_deref() == Some("rust")
                    && same_commit(health.commit.as_deref().unwrap_or(""), &manifest.commit)
                {
                    state.run_number = Some(manifest.run_number);
                    state.commit = Some(manifest.commit.clone());
                    state.error = None;
                    println!("Already running {}", manifest.commit);
                    return state.save(&self.state_path());
                }
            }
        }
        let staging = tempfile::Builder::new()
            .prefix("download-")
            .tempdir_in(&self.state_directory)?;
        let downloaded = manifest.files.keys().try_for_each(|name| {
            fs::write(staging.path().join(name), self.fetch(&asset(name))?)
                .map_err(anyhow::Error::from)
        });
        if let Err(error) = downloaded.and_then(|()| verify_files(staging.path(), &manifest)) {
            // The manifest is uploaded last, so this is usually a newer upload
            // replacing assets. Skip without recording the build; retry next run.
            println!("Release assets are not ready ({error:#}); retrying on the next run.");
            return Ok(());
        }
        if self.check {
            println!("Verified update {}", manifest.commit);
            return Ok(());
        }
        // Do not retry a broken build every fifteen minutes. A newer build is
        // still eligible; state.json records the failure for inspection.
        state.run_number = Some(manifest.run_number);
        let result = self.with_handoff(|| self.apply(staging.path(), &manifest, state));
        match &result {
            Ok(()) => {
                state.error = None;
                state.notice = None;
                println!("Updated connection services to {}", manifest.commit);
            },
            Err(error) => state.error = Some(format!("{error:#}")),
        }
        state.save(&self.state_path())?;
        result
    }

    /// The Windows tray yields service supervision while this names a live process.
    fn with_handoff<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let handoff = self.state_directory.join("handoff.json");
        fs::write(&handoff, format!("{{\"pid\": {}}}", std::process::id()))?;
        let result = action();
        let _ = fs::remove_file(&handoff);
        result
    }

    fn apply(&self, bundle: &Path, manifest: &Manifest, state: &mut State) -> Result<()> {
        let sessions = self.catalog()?;
        let old_commit = self.health()?.commit;
        let old = self.selected_binary()?;
        let candidate = bundle.join(self.exe());
        make_executable(&candidate)?;
        self.verify_auth(&old, &candidate)?;
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let backup = self.state_directory.join(format!("rollback-{nanos}"));
        fs::create_dir(&backup)?;
        fs::copy(&old, backup.join(self.exe()))?;
        for name in self.helper_names(manifest) {
            if self.helpers.join(name).is_file() {
                fs::copy(self.helpers.join(name), backup.join(name))?;
            }
        }
        let snapshot = backup.join("services.json");
        if self.windows {
            self.services(&self.helpers, "Snapshot", &snapshot, None)?;
        }
        // Persist rollback information before the first mutation. The next run
        // settles this journal if the updater or computer dies mid-handoff.
        let pending = Pending {
            backup: backup.display().to_string(),
            commit: old_commit,
            target: Some(manifest.commit.clone()),
            sessions: sessions.clone(),
            processes: serde_json::json!({}),
        };
        state.pending = Some(pending.clone());
        state.save(&self.state_path())?;
        let mut replaced = false;
        if let Err(error) = self.handoff(bundle, manifest, &snapshot, &sessions, &mut replaced) {
            if replaced {
                // Undo this transaction's helper replacement along with the binary.
                for name in self.helper_names(manifest) {
                    if backup.join(name).is_file() {
                        let _ = replace_file(&backup.join(name), &self.helpers.join(name));
                    }
                }
            }
            if let Err(recovery) = self.recover(&pending) {
                // The journal stays for one more attempt on the next run.
                return Err(anyhow!("{error:#}; rollback also failed: {recovery:#}"));
            }
            state.pending = None;
            return Err(error);
        }
        state.pending = None;
        state.commit = Some(manifest.commit.clone());
        state.save(&self.state_path())
    }

    fn handoff(
        &self,
        bundle: &Path,
        manifest: &Manifest,
        snapshot: &Path,
        sessions: &[Session],
        replaced: &mut bool,
    ) -> Result<()> {
        let candidate = bundle.join(self.exe());
        if self.windows {
            self.install_windows(&self.helpers, &candidate)?;
            self.services(&self.helpers, "Stop", snapshot, None)?;
            self.services(
                &self.helpers,
                "Start",
                snapshot,
                Some(&self.selected_binary()?),
            )?;
            self.wait_ready(Some(&manifest.commit), sessions)?;
            self.services(&self.helpers, "Verify", snapshot, None)?;
        } else {
            // update_local.sh checks tokens, session compatibility and engine
            // identities, restarts web + relay, and restores itself on failure.
            self.install_mac(&self.helpers, &candidate, Some(&manifest.commit))?;
            self.wait_ready(Some(&manifest.commit), sessions)?;
        }
        *replaced = true;
        let previous_menu = fs::read(self.helpers.join("menu_bar.swift")).ok();
        for name in self.helper_names(manifest) {
            replace_file(&bundle.join(name), &self.helpers.join(name))?;
        }
        // Reload the tray/menu only after the connection services recover.
        if self.windows {
            self.services(&self.helpers, "StopTray", snapshot, None)?;
            self.install_tray()?;
        } else if previous_menu != fs::read(self.helpers.join("menu_bar.swift")).ok() {
            // The menu is cosmetic; its failure must not roll back working services.
            if let Err(error) = self.reload_menu() {
                eprintln!("Menu bar app was not reloaded: {error:#}");
            }
        }
        Ok(())
    }

    /// Restore the previous executable and restart services on it, running the
    /// helpers retained beside it. Installed helpers are never replaced here.
    fn recover(&self, pending: &Pending) -> Result<()> {
        // Resolved only for the check: helpers run from the path as recorded
        // (Windows' canonical \\?\ form is not a safe PowerShell -File path).
        let backup = PathBuf::from(&pending.backup);
        let resolved = fs::canonicalize(&backup).context("Missing rollback directory")?;
        ensure!(
            resolved.parent() == Some(fs::canonicalize(&self.state_directory)?.as_path())
                && backup
                    .file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with("rollback-")),
            "Invalid rollback directory"
        );
        let previous = backup.join(self.exe());
        if self.previous_state_intact(pending, &previous) {
            return Ok(());
        }
        if self.windows {
            let snapshot = backup.join("services.json");
            self.install_windows(&backup, &previous)?;
            self.services(&backup, "Stop", &snapshot, None)?;
            self.services(&backup, "Start", &snapshot, Some(&self.selected_binary()?))?;
            self.services(&backup, "Verify", &snapshot, None)?;
            self.install_tray()?;
        } else {
            self.install_mac(&backup, &previous, pending.commit.as_deref())?;
        }
        self.wait_ready(pending.commit.as_deref(), &pending.sessions)
    }

    /// The previous executable is selected and its services are healthy, e.g.
    /// when a helper failed before changing anything or restored itself.
    fn previous_state_intact(&self, pending: &Pending, previous: &Path) -> bool {
        let selected = self.selected_binary().and_then(|path| sha256_file(&path));
        let same_binary = matches!((selected, sha256_file(previous)), (Ok(a), Ok(b)) if a == b);
        let healthy = self.health().is_ok_and(|h| {
            h.relay.as_deref() == Some("rust")
                && same_commit(
                    h.commit.as_deref().unwrap_or(""),
                    pending.commit.as_deref().unwrap_or(""),
                )
        });
        same_binary
            && healthy
            && self
                .catalog()
                .is_ok_and(|catalog| pending.sessions.iter().all(|s| catalog.contains(s)))
    }

    fn helper_names<'a>(&self, manifest: &'a Manifest) -> impl Iterator<Item = &'a str> {
        let exe = self.exe();
        manifest
            .files
            .keys()
            .map(String::as_str)
            .filter(move |name| *name != exe)
    }

    fn fetch(&self, asset: &str) -> Result<Vec<u8>> {
        if !(self.source.starts_with("https://") || self.source.starts_with("http://")) {
            let path = Path::new(&self.source).join(asset);
            return fs::read(&path).with_context(|| format!("Cannot read {}", path.display()));
        }
        let url = format!("{}/{asset}", self.source.trim_end_matches('/'));
        let request = Request::get(&url)
            .redirect_policy(RedirectPolicy::Limit(10))
            .timeout(Duration::from_secs(300))
            .body(())?;
        let mut response =
            isahc::send(request).with_context(|| format!("Cannot download {url}"))?;
        ensure!(
            response.status().is_success(),
            "Download {url} returned {}",
            response.status()
        );
        Ok(response.bytes()?)
    }

    fn local_json<T: DeserializeOwned>(&self, path: &str, timeout: Duration) -> Result<T> {
        // Tokens stay in the relay; only build and session identity cross here.
        let request = Request::get(format!("http://127.0.0.1:{}{path}", self.port))
            .header("Host", "switchboard.localhost")
            .proxy(None::<isahc::http::Uri>)
            .timeout(timeout)
            .body(())?;
        let mut response = isahc::send(request)?;
        ensure!(
            response.status().is_success(),
            "{path} returned {}",
            response.status()
        );
        Ok(serde_json::from_slice(&response.bytes()?)?)
    }

    fn health(&self) -> Result<Health> {
        self.local_json("/api/health", Duration::from_secs(3))
    }

    fn catalog(&self) -> Result<Vec<Session>> {
        let hosts: serde_json::Value = self.local_json("/api/hosts", Duration::from_secs(10))?;
        let mut sessions = Vec::new();
        for host in hosts.as_array().context("Invalid host catalog")? {
            let id = host["id"].as_str().context("Invalid host catalog")?;
            for session in host["sessions"].as_array().into_iter().flatten() {
                sessions.push((
                    id.to_owned(),
                    session["name"]
                        .as_str()
                        .context("Invalid session")?
                        .to_owned(),
                    session["web_clients_allowed"].as_bool().unwrap_or(false),
                ));
            }
        }
        sessions.sort();
        Ok(sessions)
    }

    fn wait_ready(&self, commit: Option<&str>, sessions: &[Session]) -> Result<()> {
        let deadline = Instant::now() + self.ready_timeout;
        while Instant::now() < deadline {
            let ready = self.health().is_ok_and(|h| {
                h.relay.as_deref() == Some("rust")
                    && commit.is_none_or(|c| same_commit(c, h.commit.as_deref().unwrap_or("")))
            }) && self
                .catalog()
                .is_ok_and(|catalog| sessions.iter().all(|s| catalog.contains(s)));
            if ready {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        bail!("Relay did not recover its build identity and existing session catalog")
    }

    fn selected_binary(&self) -> Result<PathBuf> {
        if !self.windows {
            return Ok(fs::canonicalize(&self.binary)?);
        }
        let bytes = fs::read(self.release_directory.join("current.json"))?;
        let state: serde_json::Value =
            serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes))?;
        let hash = state["sha256"].as_str().unwrap_or("");
        ensure!(is_hex(hash, 64), "Invalid selected executable checksum");
        Ok(self.release_directory.join(hash).join("zellij.exe"))
    }

    fn verify_auth(&self, old: &Path, candidate: &Path) -> Result<()> {
        let tokens = |binary: &Path| -> Result<Vec<String>> {
            let mut command = Command::new(binary);
            if let Some(config) = &self.config {
                command.arg("--config").arg(config);
            }
            command.args(["web", "--list-tokens"]);
            Ok(run_command(command, Duration::from_secs(15))?
                .lines()
                .map(str::to_owned)
                .collect())
        };
        let after = tokens(candidate)?;
        ensure!(
            tokens(old)?.iter().all(|token| after.contains(token)),
            "Candidate cannot see existing authentication tokens; services were not changed"
        );
        Ok(())
    }

    fn install_mac(&self, helpers: &Path, candidate: &Path, commit: Option<&str>) -> Result<()> {
        let mut command = Command::new("bash");
        command
            .arg(helpers.join("update_local.sh"))
            .arg(candidate)
            .arg(&self.binary)
            .env("SWITCHBOARD_EXPECTED_COMMIT", commit.unwrap_or(""))
            .env("SWITCHBOARD_RELAY_PORT", self.port.to_string())
            .env_remove("SWITCHBOARD_UPDATE_BINARY_ONLY");
        run_command(command, Duration::from_secs(300)).map(drop)
    }

    fn reload_menu(&self) -> Result<()> {
        let Some(directory) = self.menu_app.parent().filter(|d| d.is_dir()) else {
            return Ok(());
        };
        let staged = directory.join("Switchboard.update");
        let mut compile = Command::new("swiftc");
        compile
            .arg(self.helpers.join("menu_bar.swift"))
            .arg("-o")
            .arg(&staged);
        run_command(compile, Duration::from_secs(180))?;
        fs::rename(&staged, &self.menu_app)?;
        let mut kickstart = Command::new("launchctl");
        kickstart
            .args(["kickstart", "-k"])
            .arg(format!("gui/{}/dev.switchboard.menu", user_id()));
        run_command(kickstart, Duration::from_secs(30)).map(drop)
    }

    fn with_config(&self, mut args: Vec<OsString>) -> Vec<OsString> {
        if let Some(config) = &self.config {
            args.extend(["-Config".into(), config.into()]);
        }
        args
    }

    fn install_windows(&self, helpers: &Path, candidate: &Path) -> Result<()> {
        let args = vec![
            "-Candidate".into(),
            candidate.into(),
            "-ReleaseDirectory".into(),
            self.release_directory.clone().into(),
        ];
        powershell(
            &helpers.join("update_windows.ps1"),
            self.with_config(args),
            // This updater performs its own service handoff; the selector must not.
            &[("SWITCHBOARD_UPDATE_BINARY_ONLY", "1".into())],
        )
        .map(drop)
    }

    fn services(
        &self,
        helpers: &Path,
        action: &str,
        snapshot: &Path,
        binary: Option<&Path>,
    ) -> Result<()> {
        let mut args: Vec<OsString> = vec![
            "-Action".into(),
            action.into(),
            "-Snapshot".into(),
            snapshot.into(),
            "-ReleaseDirectory".into(),
            self.release_directory.clone().into(),
            "-HostConfig".into(),
            self.host_config.clone().into(),
            "-RelayPort".into(),
            self.port.to_string().into(),
        ];
        if let Some(binary) = binary {
            args.extend(["-Binary".into(), binary.into()]);
        }
        let script = helpers.join("update_services_windows.ps1");
        powershell(&script, args, &[tray_script(&self.helpers)]).map(drop)
    }

    /// Restart the tray from the installed helpers (a running tray keeps its mutex).
    fn install_tray(&self) -> Result<()> {
        let args = vec![
            "-ReleaseDirectory".into(),
            self.release_directory.clone().into(),
        ];
        powershell(
            &self.helpers.join("install_windows_web.ps1"),
            self.with_config(args),
            &[],
        )
        .map(drop)
    }
}

/// The installed tray lives beside the installed helpers, wherever the
/// PowerShell helper being run is (installed, retained or downloaded).
fn tray_script(helpers: &Path) -> (&'static str, OsString) {
    let script = helpers.join("switchboard-tray.ps1");
    ("SWITCHBOARD_TRAY_SCRIPT", script.into())
}

fn powershell(script: &Path, args: Vec<OsString>, env: &[(&str, OsString)]) -> Result<String> {
    let executable = if cfg!(windows) {
        PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
    } else {
        PathBuf::from("pwsh") // Orchestration tests on macOS.
    };
    let mut command = Command::new(executable);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .args(args)
        // PowerShell 7's module path can shadow Windows PowerShell's core modules.
        .env_remove("PSModulePath");
    // Environment, not flags: older retained helpers ignore what they don't know.
    command.envs(env.iter().map(|(name, value)| (name, value)));
    run_command(command, Duration::from_secs(180))
}

fn replace_file(from: &Path, to: &Path) -> Result<()> {
    let mut staged = to.as_os_str().to_owned();
    staged.push(".update-tmp");
    fs::copy(from, &staged)?;
    fs::rename(&staged, to)?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(permissions.mode() | 0o111);
    Ok(fs::set_permissions(path, permissions)?)
}

#[cfg(not(unix))]
fn make_executable(_: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn user_id() -> u32 {
    nix::unistd::getuid().as_raw()
}

#[cfg(not(unix))]
fn user_id() -> u32 {
    0
}

/// Run a helper with a deadline, returning trimmed stdout.
fn run_command(mut command: Command, timeout: Duration) -> Result<String> {
    let name = Path::new(command.get_program())
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("Cannot start {name}"))?;
    let collect = |mut pipe: Box<dyn Read + Send>| {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            let _ = sender.send(String::from_utf8_lossy(&bytes).into_owned());
        });
        receiver
    };
    let stdout = collect(Box::new(child.stdout.take().expect("piped stdout")));
    let stderr = collect(Box::new(child.stderr.take().expect("piped stderr")));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{name} timed out after {} seconds", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // A daemon started by the helper may inherit the pipes; don't wait on it.
    let output = |receiver: mpsc::Receiver<String>| {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_default()
    };
    let (stdout, stderr) = (output(stdout), output(stderr));
    if !status.success() {
        let stderr = stderr.trim();
        let start = stderr
            .char_indices()
            .map(|(index, _)| index)
            .find(|index| stderr.len() - index <= 2000)
            .unwrap_or(stderr.len());
        bail!("{name} failed: {}", &stderr[start..]);
    }
    Ok(stdout.trim().to_owned())
}

#[cfg(test)]
#[path = "unit/switchboard_update_tests.rs"]
mod tests;
