//! Automatic Switchboard updates from the rolling `latest-main` release.
//!
//! Only connection services (relay, web server, tray) are restarted; terminal
//! engines keep running. Platform helpers shipped in the bundle do the
//! process-preserving work: `update_local.sh` on macOS and Linux, the PowerShell release
//! and service helpers on Windows.
use anyhow::{anyhow, bail, ensure, Context, Result};
use isahc::{
    config::{Configurable, RedirectPolicy},
    prelude::*,
    Request,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zellij_utils::cli::{SwitchboardCommand, SwitchboardUpdateCli};

pub const RELEASE_URL: &str =
    "https://github.com/domsleee/switchboard/releases/download/latest-main/";
const RELEASE_API: &str = "https://api.github.com/repos/domsleee/switchboard/releases";

#[derive(Default)]
struct ReleaseDownloads {
    assets: RefCell<Option<BTreeMap<String, u64>>>,
}

impl ReleaseDownloads {
    fn fetch(&self, url: &str, asset: &str, api: Option<&str>) -> Result<Vec<u8>> {
        match Self::http(url, "application/octet-stream") {
            Ok(bytes) => Ok(bytes),
            Err(primary) => {
                let Some(api) = api else { return Err(primary) };
                self.from_api(api, asset)
                    .with_context(|| format!("{primary:#}; GitHub API fallback also failed"))
            },
        }
    }

    fn from_api(&self, api: &str, asset: &str) -> Result<Vec<u8>> {
        if self.assets.borrow().is_none() {
            #[derive(Deserialize)]
            struct Asset {
                name: String,
                id: u64,
            }
            #[derive(Deserialize)]
            struct Release {
                assets: Vec<Asset>,
            }
            let release: Release = serde_json::from_slice(&Self::http(
                &format!("{api}/tags/latest-main"),
                "application/vnd.github+json",
            )?)?;
            *self.assets.borrow_mut() =
                Some(release.assets.into_iter().map(|a| (a.name, a.id)).collect());
        }
        let id = self
            .assets
            .borrow()
            .as_ref()
            .unwrap()
            .get(asset)
            .copied()
            .with_context(|| format!("Published release has no asset {asset}"))?;
        // Construct the URL from a numeric ID, rather than following URLs from metadata.
        // No credentials or GitHub CLI are needed for this public release.
        Self::http(&format!("{api}/assets/{id}"), "application/octet-stream")
    }

    fn http(url: &str, accept: &str) -> Result<Vec<u8>> {
        let request = Request::get(url)
            .header("User-Agent", "Switchboard-Updater")
            .header("Accept", accept)
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
}

/// Session identity and sharing as listed by the relay catalog.
type Session = (String, String, bool);

/// A timed update step: name, duration, and whether it succeeded.
type Phase = (&'static str, Duration, bool);

/// One log line per update, e.g. `install 8.4s, ready 60.0s failed; total 80.1s`.
fn timing_line(phases: &[Phase], total: Duration) -> String {
    let mut line = phases
        .iter()
        .map(|(name, took, ok)| {
            format!(
                "{name} {:.1}s{}",
                took.as_secs_f64(),
                if *ok { "" } else { " failed" }
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    if !line.is_empty() {
        line.push_str("; ");
    }
    format!("{line}total {:.1}s", total.as_secs_f64())
}

#[path = "switchboard_engine_swap.rs"]
mod engine_swap;
#[path = "switchboard_install.rs"]
mod install;

pub fn run(command: &SwitchboardCommand) -> Result<()> {
    match command {
        SwitchboardCommand::Install { binary } => match binary {
            Some(binary) => install::install(binary),
            None => install::install(&std::env::current_exe()?),
        },
        SwitchboardCommand::Update(cli) => Updater::from_cli(cli)?.run(),
        SwitchboardCommand::EngineFingerprint => {
            bail!("The engine fingerprint is printed by the zellij executable")
        },
        SwitchboardCommand::SwapEngine {
            session,
            binary,
            config,
            reject_first_verification,
        } => engine_swap::run_cli(
            session,
            binary.as_deref(),
            config.as_deref(),
            *reject_first_verification,
        ),
        SwitchboardCommand::Artifact {
            files,
            id,
            relay_url,
        } => crate::switchboard_relay::artifacts::publish(files, id.as_deref(), relay_url),
        SwitchboardCommand::Askpass { prompt, relay_url } => {
            crate::switchboard_relay::askpass::run(prompt.as_deref(), relay_url)
        },
        SwitchboardCommand::Run {
            timeout_secs,
            relay_url,
            command,
        } => crate::switchboard_relay::interactive::run(
            command,
            Duration::from_secs(*timeout_secs),
            relay_url,
        ),
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
        SwitchboardCommand::LanProbe {
            addresses,
            timeout_secs,
        } => lan_probe(addresses, Duration::from_secs(*timeout_secs)),
    }
}

/// Gateways of the paired computers the running relay reaches now, so a probe
/// failure means the candidate is refused rather than a computer being offline.
fn probe_addresses(hosts: &serde_json::Value) -> Vec<String> {
    let mut addresses = Vec::new();
    for host in hosts.as_array().into_iter().flatten() {
        if host["local"] != false || !host["error"].is_null() {
            continue;
        }
        for field in ["address", "pairing_address"] {
            let Some(url) = host[field].as_str().and_then(|u| url::Url::parse(u).ok()) else {
                continue;
            };
            if let (Some(name), Some(port)) = (url.host_str(), url.port_or_known_default()) {
                let address = format!("{name}:{port}");
                if !addresses.contains(&address) {
                    addresses.push(address);
                }
            }
        }
    }
    addresses
}

/// Paired computers the running relay reaches now, by id.
fn reachable_peers(hosts: &serde_json::Value) -> Vec<String> {
    hosts
        .as_array()
        .into_iter()
        .flatten()
        .filter(|host| host["local"] == false && host["error"].is_null())
        .filter_map(|host| host["id"].as_str().map(str::to_owned))
        .collect()
}

/// Keeps retrying instead of exiting on the first refusal: macOS shows no
/// Local Network alert to a launchd job that exits immediately (TN3179).
fn lan_probe(addresses: &[String], timeout: Duration) -> Result<()> {
    use std::net::{TcpStream, ToSocketAddrs};
    let deadline = Instant::now() + timeout;
    loop {
        for address in addresses {
            for socket in address.to_socket_addrs().into_iter().flatten() {
                if TcpStream::connect_timeout(&socket, Duration::from_secs(1)).is_ok() {
                    println!("reachable {address}");
                    return Ok(());
                }
            }
        }
        if Instant::now() >= deadline {
            bail!("No paired computer answered");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Files in each platform bundle. Installed updaters reject a bundle whose
/// list differs, so retired names stay: `auto_update.py` forwards to
/// `zellij switchboard update` and `install_service.py` to `zellij switchboard install`.
// ponytail: drop both once every machine runs an updater that accepts their absence.
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
        "linux-x86_64" | "linux-arm64" => &["update_local.sh", "zellij"],
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
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok("linux-x86_64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Ok("linux-arm64")
    } else {
        bail!("Automatic updates currently support Windows, macOS and Linux (x86_64, arm64)")
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub attachment_protocol: u32,
    pub schema: u32,
    pub commit: String,
    pub platform: String,
    #[serde(default)]
    pub run_number: u64,
    /// When `commit` was committed (`%cI`), so a computer running a newer build it
    /// made itself never goes back to an older published one. Absent in older bundles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_timestamp: Option<String>,
    pub files: BTreeMap<String, String>,
}

/// Seconds since the epoch of a `%cI` timestamp such as `2026-11-08T15:11:53+11:00`.
fn commit_seconds(timestamp: &str) -> Option<i64> {
    let b = timestamp.as_bytes();
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(b.get(range)?).ok()?.parse().ok()
    };
    if b.len() != 25 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[22] != b':' {
        return None;
    }
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let offset = (number(20..22)? * 60 + number(23..25)?) * 60;
    let offset = match b[19] {
        b'+' => offset,
        b'-' => -offset,
        _ => return None,
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(days * 86_400 + hour * 3_600 + minute * 60 + second - offset)
}

/// Whether the running build was committed after the published one, as when this
/// computer built a newer main itself.
fn running_is_newer(running: Option<&str>, published: Option<&str>) -> bool {
    matches!(
        (running.and_then(commit_seconds), published.and_then(commit_seconds)),
        (Some(running), Some(published)) if running > published
    )
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
    // The packaging executable is the build being packaged, so its own commit
    // time describes `commit`.
    let own = env!("SWITCHBOARD_COMMIT");
    let commit_timestamp = (own != "unknown" && same_commit(own, commit))
        .then(|| env!("SWITCHBOARD_COMMIT_TIMESTAMP").to_owned())
        .filter(|timestamp| commit_seconds(timestamp).is_some());
    let manifest = Manifest {
        attachment_protocol: 1,
        schema: 1,
        commit: commit.to_owned(),
        platform: platform.to_owned(),
        run_number,
        commit_timestamp,
        files,
    };
    validate_manifest(&manifest, platform)?;
    fs::write(output.join("bundle.json"), serde_json::to_vec(&manifest)?)?;
    Ok(())
}

/// Handoffs of one build before it is skipped until a newer build appears.
const ATTEMPTS: u32 = 3;
/// Legacy viewers reconnect after a restart, so a new build waits this long for them
/// to disconnect, then activates anyway. Merges land often enough that an open
/// legacy viewer would otherwise keep a computer on an old build indefinitely.
const LEGACY_VIEWER_WAIT: u64 = 10 * 60;

/// `state.json`, shared with the retired Python updater. Unknown keys are kept.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    /// The last build handed off (or found running).
    #[serde(skip_serializing_if = "Option::is_none")]
    run_number: Option<u64>,
    /// Handoffs of `run_number` started without succeeding; absent once it succeeds.
    #[serde(skip_serializing_if = "Option::is_none")]
    attempts: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<Pending>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready: Option<ReadyUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activation: Option<Activation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest_failure: Option<ManifestFailure>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

/// The `error` that reports a failed manifest read. The next successful read of the
/// same source settles it; a failed activation stays until a build installs.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestFailure {
    source: String,
    error: String,
}

/// Marks an update error as a failed read of the release manifest.
#[derive(Debug)]
struct ManifestUnavailable;

impl std::fmt::Display for ManifestUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Release manifest unavailable")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ReadyUpdate {
    commit: String,
    since: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Activation {
    commit: String,
    expires: u64,
}
fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn valid_commit(commit: &str) -> bool {
    commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit())
}

/// One-shot request for the installed scheduled updater, outside the relay's lifetime.
pub(crate) fn request_activation(directory: &Path, commit: &str) -> Result<()> {
    ensure!(valid_commit(commit), "Invalid update commit");
    let state = State::load(&directory.join("state.json"))?;
    ensure!(
        state
            .ready
            .as_ref()
            .is_some_and(|ready| ready.commit == commit)
            || state
                .pending
                .as_ref()
                .and_then(|pending| pending.target.as_deref())
                == Some(commit),
        "That update is no longer ready; refresh Health"
    );
    fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(
        file.as_file_mut(),
        &Activation {
            commit: commit.into(),
            expires: epoch() + 300,
        },
    )?;
    file.persist(directory.join("activate.json"))?;
    Ok(())
}
fn take_activation(directory: &Path) -> Result<Option<String>> {
    let consumed = directory.join(format!("activation-{}.json", uuid::Uuid::new_v4()));
    match fs::rename(directory.join("activate.json"), &consumed) {
        Ok(()) => {},
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let body = fs::read(&consumed);
    let _ = fs::remove_file(consumed);
    let request: Activation = serde_json::from_slice(&body?)?;
    ensure!(
        valid_commit(&request.commit)
            && request.expires >= epoch()
            && request.expires <= epoch() + 300,
        "Activation request expired or invalid; choose Update now again"
    );
    Ok(Some(request.commit))
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

// Preserve only the installation being updated. Peer availability is checked
// independently; an unrelated peer closing a tab must never cause rollback.
fn local_catalog(hosts: &serde_json::Value) -> Result<(String, Vec<Session>)> {
    let hosts = hosts.as_array().context("Invalid host catalog")?;
    let local: Vec<_> = hosts.iter().filter(|host| host["local"] == true).collect();
    ensure!(
        local.len() == 1,
        "Cannot identify this installation in host catalog"
    );
    let host = local[0];
    let id = host["id"]
        .as_str()
        .context("Invalid local host identity")?
        .to_owned();
    let entries = host["sessions"]
        .as_array()
        .context("Local session catalog unavailable")?;
    let mut sessions = Vec::new();
    for session in entries {
        sessions.push((
            id.clone(),
            session["name"]
                .as_str()
                .context("Invalid local session")?
                .to_owned(),
            session["web_clients_allowed"].as_bool().unwrap_or(false),
        ));
    }
    sessions.sort();
    Ok((id, sessions))
}

fn live_session_names(output: &str) -> Result<Vec<String>> {
    ensure!(!output.trim().is_empty(), "Empty native session listing");
    let pattern = regex::Regex::new(
        r"^(.+) \[Created [^\]\r\n]+\](?: (\(current\)|\(EXITED - attach to resurrect\)))?\s*$",
    )?;
    let mut names = Vec::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let row = pattern
            .captures(line)
            .context("Invalid native session listing")?;
        if row.get(2).map(|state| state.as_str()) != Some("(EXITED - attach to resurrect)") {
            names.push(row[1].to_owned());
        }
    }
    Ok(names)
}

/// Whether a new build has waited long enough for legacy viewers to disconnect.
/// A retry of a failed build never bypasses them.
fn waited_for_viewers(state: &State, manifest: &Manifest) -> bool {
    manifest.run_number > state.run_number.unwrap_or(0)
        && state
            .ready
            .as_ref()
            .is_some_and(|ready| epoch().saturating_sub(ready.since) >= LEGACY_VIEWER_WAIT)
}

/// Whether the updater should install published build `run_number`: it is newer than
/// the last build tried, or that build with attempts left.
fn is_due(state: &State, run_number: u64) -> bool {
    let last = state.run_number.unwrap_or(0);
    run_number > last || (run_number == last && state.attempts.is_some_and(|a| a < ATTEMPTS))
}

/// Whether a published main build is due on this computer. The relay asks every two
/// minutes and starts the update job early, so updates do not wait for its schedule.
pub fn newer_build_published() -> Result<bool> {
    let home = std::env::home_dir().context("No home directory")?;
    let platform = target_platform()?;
    let state = State::load(&home.join(".local/share/switchboard/automatic-updates/state.json"))?;
    let url = format!("{RELEASE_URL}switchboard-{platform}-bundle.json");
    let request = Request::get(&url)
        .redirect_policy(RedirectPolicy::Limit(10))
        .timeout(Duration::from_secs(30))
        .body(())?;
    let mut response = isahc::send(request).with_context(|| format!("Cannot download {url}"))?;
    ensure!(
        response.status().is_success(),
        "Download {url} returned {}",
        response.status()
    );
    let manifest: Manifest =
        serde_json::from_slice(&response.bytes()?).context("Invalid release manifest")?;
    validate_manifest(&manifest, platform)?;
    Ok(is_due(&state, manifest.run_number))
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
    /// A damaged file would fail every run with nothing able to record why, while
    /// Health reads it as current. Callers must hold the updater lock.
    fn set_aside_if_corrupt(path: &Path) {
        if Self::load(path).is_err_and(|error| error.is::<serde_json::Error>()) {
            let aside = path.with_extension("json.corrupt");
            match fs::rename(path, &aside) {
                Ok(()) => println!("Set aside corrupt {}", path.display()),
                Err(error) => eprintln!("Cannot set aside {}: {error}", path.display()),
            }
        }
    }
    fn save(&self, path: &Path) -> Result<()> {
        let temporary = path.with_extension("tmp");
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec(self)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct Health {
    relay: Option<String>,
    commit: Option<String>,
    #[serde(default)]
    commit_timestamp: Option<String>,
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
    relay_port: Option<u16>,
}

pub struct Updater {
    windows: bool,
    platform: String,
    check: bool,
    activation: RefCell<Option<String>>,
    config: Option<PathBuf>,
    host_config: PathBuf,
    port: u16,
    binary: PathBuf,
    release_directory: PathBuf,
    state_directory: PathBuf,
    viewer_lock: PathBuf,
    helpers: PathBuf,
    source: String,
    menu_app: PathBuf,
    downloads: ReleaseDownloads,
    ready_timeout: Duration,
    peer_watch: Duration,
    timings: RefCell<Vec<Phase>>,
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
        if windows
            && (cli.config.is_none() || cli.release_directory.is_none() || cli.port.is_none())
        {
            let script = helpers.join("update_services_windows.ps1");
            let mut args = vec!["-Action".into(), "Arguments".into()];
            if let Some(host_config) = &cli.host_config {
                args.extend(["-HostConfig".into(), host_config.clone().into()]);
            }
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
            activation: RefCell::new(cli.activate.clone()),
            config: cli.config.clone().or_else(|| given(running.config)),
            host_config: cli.host_config.clone().unwrap_or_else(|| {
                home.join(if windows {
                    ".config/switchboard/hosts.json"
                } else {
                    ".config/zellij/switchboard-hosts.json"
                })
            }),
            port: cli
                .port
                .or(running.relay_port.filter(|p| *p != 0))
                .unwrap_or(8090),
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
            viewer_lock: crate::switchboard_viewers::path(&share.join("automatic-updates")),
            helpers,
            source: cli.source.clone().unwrap_or_else(|| RELEASE_URL.to_owned()),
            downloads: ReleaseDownloads::default(),
            menu_app: home.join("Applications/Switchboard.app/Contents/MacOS/Switchboard"),
            ready_timeout: Duration::from_secs(60),
            peer_watch: Duration::from_secs(20),
            timings: RefCell::default(),
        })
    }

    /// Runs one update step and records how long it took for the timing line.
    fn timed<T>(&self, phase: &'static str, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let start = Instant::now();
        let result = action();
        self.timings
            .borrow_mut()
            .push((phase, start.elapsed(), result.is_ok()));
        result
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
            .read(true)
            .append(true)
            .open(self.state_directory.join("automatic.lock"))?;
        // Health briefly probes this lock to distinguish a live updater from a
        // journal left by a crash. Let that read-only probe finish before giving up.
        for attempt in 0..3 {
            match lock.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if attempt < 2 => {
                    std::thread::sleep(Duration::from_millis(20))
                },
                Err(_) => return Err(anyhow!("Another automatic update is running")),
            }
        }
        State::set_aside_if_corrupt(&self.state_path());
        let previous_error = State::load(&self.state_path())
            .ok()
            .and_then(|state| state.error);
        let result = (|| {
            if !self.check && self.activation.borrow().is_none() {
                *self.activation.borrow_mut() = take_activation(&self.state_directory)?;
            }
            let mut state = State::load(&self.state_path())?;
            if !self.check {
                state.activation = self.activation.borrow().as_ref().map(|commit| Activation {
                    commit: commit.clone(),
                    expires: epoch() + 300,
                });
                if state.activation.is_some() {
                    state.error = None;
                    state.notice =
                        Some("Preparing requested update; terminals will briefly reconnect".into());
                    state.save(&self.state_path())?;
                }
            }
            if let Some(pending) = state.pending.clone() {
                self.settle_pending(&mut state, &pending)?;
                if state.pending.is_some() {
                    return Ok(());
                }
            }
            self.update(&mut state)
        })();
        // Closing is not enough: a child forked meanwhile shares the lock until it execs.
        self.activation.borrow_mut().take();
        if !self.check {
            if let Ok(mut state) = State::load(&self.state_path()) {
                state.activation = None;
                if let Err(error) = &result {
                    if state.error == previous_error || state.error.is_none() {
                        let text = format!("{error:#}");
                        state.manifest_failure =
                            error.is::<ManifestUnavailable>().then(|| ManifestFailure {
                                source: self.source.clone(),
                                error: text.clone(),
                            });
                        state.error = Some(text);
                    }
                }
                let _ = state.save(&self.state_path());
            }
        }
        let _ = lock.unlock();
        result
    }

    fn settle_pending(&self, state: &mut State, pending: &Pending) -> Result<()> {
        let health = self.health().ok();
        let catalog = self.catalog().ok();
        let mut pending = pending.clone();
        if let Ok(local) = self.local_host_id() {
            pending.sessions.retain(|session| session.0 == local);
        }
        // A journal may outlive short-lived sessions by hours. Check the
        // engines independently before deciding that the relay lost them;
        // its own catalog alone cannot distinguish a closed session from a bug.
        if let Some(catalog) = &catalog {
            if pending.sessions.iter().any(|s| !catalog.contains(s)) {
                if let Ok(live) = self.native_sessions() {
                    pending.sessions.retain(|s| live.contains(&s.1));
                }
            }
        }
        let pending = &pending;
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
                state.error = None;
                state.pending = None;
                state.save(&self.state_path())
            },
            Resolution::Recover => {
                ensure!(
                    !self.check,
                    "Interrupted update requires recovery before checking another build"
                );
                let _viewers = crate::switchboard_viewers::update(&self.viewer_lock)?;
                if _viewers.is_none()
                    && !pending
                        .target
                        .as_deref()
                        .is_some_and(|target| self.activating(target))
                {
                    state.notice =
                        Some("Recovery waiting for terminal viewers to disconnect".into());
                    return state.save(&self.state_path());
                }
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
        let manifest = self
            .read_manifest(&asset("bundle.json"))
            .context(ManifestUnavailable)?;
        if !self.check
            && state
                .manifest_failure
                .as_ref()
                .is_some_and(|failure| failure.source == self.source)
        {
            let failure = state.manifest_failure.take();
            if state.error == failure.map(|failure| failure.error) {
                state.error = None;
            }
            state.save(&self.state_path())?;
        }
        ensure!(
            manifest.attachment_protocol == 1
                || crate::web_client::attachment::worker_status().is_empty(),
            "Candidate does not support retained terminal attachments"
        );
        if let Some(requested) = self.activation.borrow().as_ref() {
            ensure!(requested == &manifest.commit, "The requested update was superseded; check for updates and choose Update now again");
        }
        let explicit_retry = self.activating(&manifest.commit)
            && state.run_number == Some(manifest.run_number)
            && state.attempts.is_some();
        if !is_due(state, manifest.run_number) && !explicit_retry {
            // Scheduled runs log every few minutes; only say so when someone is watching.
            if std::io::IsTerminal::is_terminal(&std::io::stdout()) {
                println!("No newer successful main build.");
            }
            return Ok(());
        }
        if !self.check {
            // This computer's own build of a newer main can be waiting for viewers
            // while the published build catches up. It keeps its place and its wait.
            let other_build_waiting = state
                .ready
                .as_ref()
                .is_some_and(|ready| !same_commit(&ready.commit, &manifest.commit));
            if let Ok(health) = self.health() {
                if health.relay.as_deref() == Some("rust")
                    && same_commit(health.commit.as_deref().unwrap_or(""), &manifest.commit)
                {
                    state.run_number = Some(manifest.run_number);
                    state.attempts = None;
                    state.commit = Some(manifest.commit.clone());
                    state.error = None;
                    if !other_build_waiting {
                        state.notice = None;
                        state.ready = None;
                    }
                    println!("Already running {}", manifest.commit);
                    return state.save(&self.state_path());
                }
                // A build this computer made from a newer main stays until a newer
                // one is published. Update now still installs the chosen build.
                if health.relay.as_deref() == Some("rust")
                    && !self.activating(&manifest.commit)
                    && running_is_newer(
                        health.commit_timestamp.as_deref(),
                        manifest.commit_timestamp.as_deref(),
                    )
                {
                    let running = health.commit.unwrap_or_default();
                    state.run_number = Some(manifest.run_number);
                    state.attempts = None;
                    state.error = None;
                    if !other_build_waiting {
                        state.ready = None;
                        state.notice = Some(format!(
                            "Running {running}, which is newer than published {}",
                            &manifest.commit[..7]
                        ));
                    }
                    println!(
                        "Keeping {running}; published {} is older",
                        &manifest.commit[..7]
                    );
                    return state.save(&self.state_path());
                }
            }
        }
        // Keep one verified bundle while viewers defer activation. Always fetch the
        // current manifest first, so a later release supersedes the waiting one.
        let ready = self.state_directory.join("ready");
        if verify_files(&ready, &manifest).is_err() {
            let staging = tempfile::Builder::new()
                .prefix("download-")
                .tempdir_in(&self.state_directory)?;
            let downloaded = manifest.files.keys().try_for_each(|name| {
                fs::write(staging.path().join(name), self.fetch(&asset(name))?)
                    .map_err(anyhow::Error::from)
            });
            downloaded.context(ManifestUnavailable)?;
            if let Err(error) = verify_files(staging.path(), &manifest) {
                // Only a checksum mismatch means an upload is still in progress.
                if error.is::<std::io::Error>() {
                    return Err(error.context(ManifestUnavailable));
                }
                println!("Release assets are not ready ({error:#}); retrying on the next run.");
                return Ok(());
            }
            if ready.exists() {
                fs::remove_dir_all(&ready)?;
            }
            fs::rename(staging.path(), &ready)?;
        }
        if self.check {
            println!("Verified update {}", manifest.commit);
            return Ok(());
        }
        // Avoid expensive preflight while occupied. apply() checks again and
        // holds the lock across the actual handoff to close the admission race.
        if crate::switchboard_viewers::update(&self.viewer_lock)?.is_none()
            && !self.activating(&manifest.commit)
            && !waited_for_viewers(state, &manifest)
        {
            return self.defer(state, &manifest);
        }
        let before = (state.run_number, state.attempts);
        self.timings.borrow_mut().clear();
        let (started, start) = (SystemTime::now(), Instant::now());
        let result = self.with_handoff(|| self.apply(&ready, &manifest, state));
        // The log has no timestamps; Unix seconds match the relay's /api/logs times.
        println!(
            "Update timing for {} at {}: {}",
            manifest.commit,
            started.duration_since(UNIX_EPOCH)?.as_secs(),
            timing_line(&self.timings.borrow(), start.elapsed())
        );
        match &result {
            Ok(false) => return self.defer(state, &manifest),
            Ok(true) => {
                state.error = None;
                state.notice = None;
                state.ready = None;
                println!("Updated connection services to {}", manifest.commit);
            },
            Err(error) => {
                state.error = Some(format!("{error:#}"));
                // Keep this verified release actionable after a failed activation,
                // including when its automatic retry budget has been exhausted.
                state.ready = Some(ReadyUpdate {
                    commit: manifest.commit.clone(),
                    since: epoch(),
                });
                // Preflight failures happen before an attempt is counted.
                if let Some(attempt) = state
                    .attempts
                    .filter(|_| (state.run_number, state.attempts) != before)
                {
                    let next = if attempt < ATTEMPTS {
                        "retrying on the next run"
                    } else {
                        "skipping it until a newer build is published"
                    };
                    println!(
                        "Update to {} failed (attempt {attempt} of {ATTEMPTS}); {next}.",
                        manifest.commit
                    );
                }
            },
        }
        state.save(&self.state_path())?;
        result.map(|_| ())
    }

    fn activating(&self, commit: &str) -> bool {
        self.activation.borrow().as_deref() == Some(commit)
    }

    fn defer(&self, state: &mut State, manifest: &Manifest) -> Result<()> {
        if !state
            .ready
            .as_ref()
            .is_some_and(|ready| ready.commit == manifest.commit)
        {
            // A newer build replacing the waiting one keeps the original wait, so
            // frequent merges cannot restart the viewer time limit.
            state.ready = Some(ReadyUpdate {
                commit: manifest.commit.clone(),
                since: state.ready.as_ref().map_or_else(epoch, |ready| ready.since),
            });
        }
        let notice = format!(
            "Update {} ready; waiting for terminal viewers to disconnect (at most {} minutes)",
            manifest.commit,
            LEGACY_VIEWER_WAIT / 60
        );
        if state.notice.as_deref() != Some(&notice) {
            println!("{notice}");
        }
        state.notice = Some(notice);
        state.save(&self.state_path())
    }

    /// The Windows tray yields service supervision while this names a live process.
    fn with_handoff<T>(&self, action: impl FnOnce() -> Result<T>) -> Result<T> {
        let _admission = crate::switchboard_viewers::activation(&self.viewer_lock)?;
        let handoff = self.state_directory.join("handoff.json");
        fs::write(&handoff, format!("{{\"pid\": {}}}", std::process::id()))?;
        let result = action();
        let _ = fs::remove_file(&handoff);
        result
    }

    fn apply(&self, bundle: &Path, manifest: &Manifest, state: &mut State) -> Result<bool> {
        let sessions = self.timed("catalog", || self.catalog())?;
        let old_commit = self.health()?.commit;
        let old = self.selected_binary()?;
        let candidate = bundle.join(self.exe());
        make_executable(&candidate)?;
        self.timed("auth", || self.verify_auth(&old, &candidate))?;
        let mut peers = Vec::new();
        if cfg!(target_os = "macos") {
            self.timed("lan-probe", || self.check_lan_access(&candidate))?;
            peers = reachable_peers(&self.timed("peers", || {
                self.local_json("/api/hosts", Duration::from_secs(30))
            })?);
        }
        let _viewers = crate::switchboard_viewers::update(&self.viewer_lock)?;
        if _viewers.is_none() {
            if !self.activating(&manifest.commit) && !waited_for_viewers(state, manifest) {
                return Ok(false);
            }
            println!(
                "Activating {} with legacy terminal viewers connected; they reconnect",
                manifest.commit
            );
        }
        // Recheck under the activation lock: a viewer can bootstrap after the
        // download/preflight check but before we acquire exclusive admission.
        ensure!(
            manifest.attachment_protocol == 1
                || crate::web_client::attachment::worker_status().is_empty(),
            "Candidate cannot resume retained terminal attachments"
        );
        state.ready = None;
        state.notice = Some(format!(
            "Activating {}; terminals briefly reconnect",
            manifest.commit
        ));
        state.save(&self.state_path())?;
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
        // Preflight failures are local/transient, not evidence of a broken
        // build. Count an attempt only once rollback data is ready and this
        // transaction is about to change the selected release or services, so
        // a build that kills the updater mid-handoff is still given up on.
        let earlier = if state.run_number == Some(manifest.run_number) {
            state.attempts.unwrap_or(0)
        } else {
            0
        };
        state.run_number = Some(manifest.run_number);
        state.attempts = Some(earlier + 1);
        state.pending = Some(pending.clone());
        state.save(&self.state_path())?;
        let mut replaced = false;
        if let Err(error) = self.handoff(
            bundle,
            manifest,
            &snapshot,
            &sessions,
            &peers,
            &mut replaced,
        ) {
            if replaced {
                // Undo this transaction's helper replacement along with the binary.
                for name in self.helper_names(manifest) {
                    if backup.join(name).is_file() {
                        let _ = replace_file(&backup.join(name), &self.helpers.join(name));
                    }
                }
            }
            if let Err(recovery) = self.timed("rollback", || self.recover(&pending)) {
                // The journal stays for one more attempt on the next run.
                return Err(anyhow!("{error:#}; rollback also failed: {recovery:#}"));
            }
            state.pending = None;
            return Err(error);
        }
        state.pending = None;
        state.attempts = None;
        state.commit = Some(manifest.commit.clone());
        state.save(&self.state_path())?;
        self.prune_rollbacks(&backup);
        Ok(true)
    }

    /// Any journal naming an older directory was settled before this update
    /// started, and this update's journal is cleared. Deletion is best effort: a
    /// directory that cannot be removed is retried after the next success.
    fn prune_rollbacks(&self, keep: &Path) {
        let Ok(entries) = fs::read_dir(&self.state_directory) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("rollback-")
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
                && keep.file_name() != Some(entry.file_name().as_os_str())
            {
                if let Err(error) = fs::remove_dir_all(entry.path()) {
                    eprintln!("Cannot delete {}: {error}", entry.path().display());
                }
            }
        }
    }

    fn handoff(
        &self,
        bundle: &Path,
        manifest: &Manifest,
        snapshot: &Path,
        sessions: &[Session],
        peers: &[String],
        replaced: &mut bool,
    ) -> Result<()> {
        let candidate = bundle.join(self.exe());
        let ready = || {
            self.timed("ready", || {
                self.wait_ready(Some(&manifest.commit), sessions, false)
            })
        };
        let peers_stay = || {
            self.timed("peer-watch", || {
                ensure!(
                    self.peers_stay_reachable(peers),
                    "The new relay cannot reach paired computers the previous one reached"
                );
                Ok(())
            })
        };
        if self.windows {
            self.timed("install", || {
                self.install_windows(&self.helpers, &candidate)
            })?;
            self.timed("stop", || {
                self.services(&self.helpers, "Stop", snapshot, None)
            })?;
            self.timed("start", || {
                self.services(
                    &self.helpers,
                    "Start",
                    snapshot,
                    Some(&self.selected_binary()?),
                )
            })?;
            ready()?;
            self.timed("verify", || {
                self.services(&self.helpers, "Verify", snapshot, None)
            })?;
        } else {
            // update_local.sh checks tokens, session compatibility and engine
            // identities, restarts web + relay, and restores itself on failure.
            let install = || {
                self.timed("install", || {
                    self.install_mac(&self.helpers, &candidate, Some(&manifest.commit))
                })
            };
            install()?;
            ready()?;
            if peers_stay().is_err() {
                // On 2026-10-31 macOS refused a new relay Local Network access
                // after the probe passed, while a restarted relay was allowed.
                eprintln!("The new relay lost paired computers; restarting it once");
                install()?;
                ready()?;
                peers_stay()?;
            }
        }
        *replaced = true;
        let previous_menu = fs::read(self.helpers.join("menu_bar.swift")).ok();
        for name in self.helper_names(manifest) {
            replace_file(&bundle.join(name), &self.helpers.join(name))?;
        }
        // Reload the tray/menu only after the connection services recover.
        if self.windows {
            self.timed("tray", || {
                self.services(&self.helpers, "StopTray", snapshot, None)?;
                self.install_tray()
            })?;
        } else if previous_menu != fs::read(self.helpers.join("menu_bar.swift")).ok() {
            // The menu is cosmetic; its failure must not roll back working services.
            if let Err(error) = self.timed("menu", || self.reload_menu()) {
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
        self.wait_ready(pending.commit.as_deref(), &pending.sessions, true)
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

    fn read_manifest(&self, asset: &str) -> Result<Manifest> {
        let manifest: Manifest =
            serde_json::from_slice(&self.fetch(asset)?).context("Invalid release manifest")?;
        validate_manifest(&manifest, &self.platform)?;
        Ok(manifest)
    }

    fn fetch(&self, asset: &str) -> Result<Vec<u8>> {
        if !(self.source.starts_with("https://") || self.source.starts_with("http://")) {
            let path = Path::new(&self.source).join(asset);
            return fs::read(&path).with_context(|| format!("Cannot read {}", path.display()));
        }
        let url = format!("{}/{asset}", self.source.trim_end_matches('/'));
        // A GitHub release-download edge can fail while the API asset route works.
        // Custom sources stay self-contained, and both routes use normal bundle checksums.
        let api = (self.source.trim_end_matches('/') == RELEASE_URL.trim_end_matches('/'))
            .then_some(RELEASE_API);
        self.downloads.fetch(&url, asset, api)
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
        // The relay waits up to 20 seconds for each peer, in parallel, before
        // reporting it unavailable. Let that catalog finish even with an
        // offline peer, including when talking to an older relay.
        let hosts: serde_json::Value = self.local_json("/api/hosts", Duration::from_secs(30))?;
        local_catalog(&hosts).map(|(_, sessions)| sessions)
    }

    fn local_host_id(&self) -> Result<String> {
        let hosts: serde_json::Value = self.local_json("/api/hosts", Duration::from_secs(30))?;
        local_catalog(&hosts).map(|(id, _)| id)
    }

    fn native_sessions(&self) -> Result<Vec<String>> {
        let mut command = Command::new(self.selected_binary()?);
        if let Some(config) = &self.config {
            command.arg("--config").arg(config);
        }
        command.args(["list-sessions", "--no-formatting"]);
        match run_command(command, Duration::from_secs(15)) {
            Ok(output) => live_session_names(&output),
            Err(error)
                if error.to_string()
                    == format!("{} failed: No active zellij sessions found.", self.exe()) =>
            {
                Ok(Vec::new())
            },
            Err(error) => Err(error),
        }
    }

    fn wait_ready(
        &self,
        commit: Option<&str>,
        sessions: &[Session],
        filter_legacy_peers: bool,
    ) -> Result<()> {
        let deadline = Instant::now() + self.ready_timeout;
        while Instant::now() < deadline {
            let ready = self.health().is_ok_and(|h| {
                h.relay.as_deref() == Some("rust")
                    && commit.is_none_or(|c| same_commit(c, h.commit.as_deref().unwrap_or("")))
            }) && self
                .local_json::<serde_json::Value>("/api/hosts", Duration::from_secs(30))
                .and_then(|hosts| local_catalog(&hosts))
                .is_ok_and(|(local, catalog)| {
                    let missing = sessions
                        .iter()
                        .any(|s| (!filter_legacy_peers || s.0 == local) && !catalog.contains(s));
                    let live = missing.then(|| self.native_sessions().ok()).flatten();
                    sessions
                        .iter()
                        .filter(|s| !filter_legacy_peers || s.0 == local)
                        .filter(|s| live.as_ref().is_none_or(|names| names.contains(&s.1)))
                        .all(|s| catalog.contains(s))
                });
            if ready {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        bail!("Relay did not recover its build identity and existing session catalog")
    }

    /// Whether the relay keeps reaching any of `peers` for the watch period;
    /// the refusal on 2026-10-31 began only after the relay first answered.
    fn peers_stay_reachable(&self, peers: &[String]) -> bool {
        if peers.is_empty() {
            return true;
        }
        let deadline = Instant::now() + self.peer_watch;
        loop {
            let reachable = self
                .local_json::<serde_json::Value>("/api/hosts", Duration::from_secs(30))
                .is_ok_and(|hosts| reachable_peers(&hosts).iter().any(|id| peers.contains(id)));
            if !reachable {
                return false;
            }
            if Instant::now() >= deadline {
                return true;
            }
            std::thread::sleep(Duration::from_secs(2));
        }
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

    /// macOS grants Local Network access per code signature and every build is
    /// ad hoc signed, so a new relay could not reach paired computers until someone
    /// clicked Allow, and the update rolled back after a minute of downtime. Ask
    /// first, from a launchd job running the candidate as the relay will.
    fn check_lan_access(&self, candidate: &Path) -> Result<()> {
        let hosts: serde_json::Value = self.local_json("/api/hosts", Duration::from_secs(30))?;
        let addresses = probe_addresses(&hosts);
        if addresses.is_empty() {
            return Ok(());
        }
        const LABEL: &str = "dev.switchboard.lan-probe";
        let log = self.state_directory.join("lan-probe.log");
        let _ = fs::remove_file(&log);
        let remove = || {
            let _ = Command::new("launchctl").args(["remove", LABEL]).status();
        };
        remove();
        let mut submit = Command::new("launchctl");
        submit
            .args(["submit", "-l", LABEL, "-o"])
            .arg(&log)
            .arg("-e")
            .arg(&log)
            .arg("--")
            .arg(candidate)
            .args(["switchboard", "lan-probe"])
            .args(&addresses);
        run_command(submit, Duration::from_secs(15))?;
        let deadline = Instant::now() + Duration::from_secs(125);
        let outcome = loop {
            let output = fs::read_to_string(&log).unwrap_or_default();
            // shortcut: a build without lan-probe skips the check; drop once every build has it.
            if output.contains("reachable") || output.contains("unrecognized subcommand") {
                break Ok(());
            }
            if Instant::now() >= deadline {
                break Err(anyhow!(
                    "This build cannot reach paired computers yet; allow Local Network access for zellij when macOS asks. Services were not changed"
                ));
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        remove();
        outcome
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
        // Four pane checks per live session can legitimately exceed five
        // minutes on computers with many sessions. Each probe remains bounded.
        let sessions = self.native_sessions()?.len() as u64;
        let probe_seconds = std::env::var("SWITCHBOARD_UPDATE_PROBE_TIMEOUT")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|seconds| (1..=300).contains(seconds))
            .unwrap_or(15);
        run_command(
            command,
            Duration::from_secs(300 + sessions * 4 * probe_seconds),
        )
        .map(drop)
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
            "-RelayPort".into(),
            self.port.to_string().into(),
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
            #[cfg(unix)]
            {
                // Let the shell's EXIT trap restore the executable and services.
                // Signal this helper only: session engines must remain alive.
                let _ = nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(child.id() as i32),
                    nix::sys::signal::Signal::SIGTERM,
                );
                let cleanup_deadline = Instant::now() + Duration::from_secs(180);
                while child.try_wait()?.is_none() && Instant::now() < cleanup_deadline {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
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
