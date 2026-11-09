//! Moves a running session to a new engine while its programs keep running.
//! See docs/SWITCHBOARD_TERMINAL_HOST.md.
use super::run_command;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zellij_utils::handoff::{self, SessionRecord};

const HANDOVER_TIMEOUT: Duration = Duration::from_secs(30);
const ENGINE_EXIT_TIMEOUT: Duration = Duration::from_secs(15);
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const JOURNAL: &str = "swap.json";

#[derive(Debug, PartialEq)]
pub(super) enum Outcome {
    Moved,
    /// The session carries on with the engine it had.
    NotMoved(String),
    /// A new engine failed and the previous executable took the session back.
    RolledBack(String),
}

/// Written before a session is touched, so a later run can finish the job if
/// this one dies with the session between engines.
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    id: String,
    previous: PathBuf,
}

/// The terminals and tabs a move must leave unchanged.
#[derive(Debug, PartialEq, Deserialize)]
struct Identities {
    terminals: BTreeSet<u32>,
    tabs: BTreeSet<usize>,
}

/// The frozen session, from the manifest its engine wrote.
fn frozen_identities(manifest: &Path) -> Result<Identities> {
    #[derive(Deserialize)]
    struct Tab {
        id: usize,
    }
    #[derive(Deserialize)]
    struct Manifest {
        terminals: BTreeMap<u32, serde_json::Value>,
        tabs: Vec<Tab>,
    }
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(manifest)?).context("Invalid handoff manifest")?;
    Ok(Identities {
        terminals: manifest.terminals.into_keys().collect(),
        tabs: manifest.tabs.iter().map(|tab| tab.id).collect(),
    })
}

pub(super) struct Swap<'a> {
    pub session: &'a str,
    pub config: Option<&'a Path>,
    /// Where the previous build is kept, when an update has replaced the file
    /// the running engine was started from.
    pub previous: Option<&'a Path>,
    pub reject_first_verification: Cell<bool>,
}

fn engine_fingerprint(binary: &Path) -> Result<String> {
    let mut command = Command::new(binary);
    command.args(["switchboard", "engine-fingerprint"]);
    Ok(run_command(command, COMMAND_TIMEOUT)?.trim().to_string())
}

fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn stop_process(pid: u32) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let pid = Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid]),
        true,
        ProcessRefreshKind::nothing(),
    );
    if let Some(process) = system.process(pid) {
        process.kill();
    }
}

impl Swap<'_> {
    fn command(&self, binary: &Path, args: &[&str]) -> Command {
        let mut command = Command::new(binary);
        if let Some(config) = self.config {
            command.arg("--config").arg(config);
        }
        command.args(args);
        command
    }

    fn session_exists(&self) -> bool {
        zellij_utils::sessions::session_exists(self.session).unwrap_or(false)
    }

    fn identities(&self, binary: &Path) -> Result<Identities> {
        let output = run_command(
            self.command(
                binary,
                &[
                    "-s",
                    self.session,
                    "action",
                    "list-panes",
                    "--json",
                    "--all",
                ],
            ),
            COMMAND_TIMEOUT,
        )?;
        let panes: Vec<serde_json::Value> =
            serde_json::from_str(&output).context("Invalid pane list")?;
        let mut identities = Identities {
            terminals: BTreeSet::new(),
            tabs: BTreeSet::new(),
        };
        for pane in panes.iter().filter(|pane| pane["is_plugin"] != true) {
            let id = pane["id"].as_u64().and_then(|id| u32::try_from(id).ok());
            let tab = pane["tab_id"]
                .as_u64()
                .and_then(|id| usize::try_from(id).ok());
            let (Some(id), Some(tab)) = (id, tab) else {
                bail!("Pane list is missing identities");
            };
            identities.terminals.insert(id);
            identities.tabs.insert(tab);
        }
        Ok(identities)
    }

    /// The engine daemon inherits these handles, so a pipe here would never close.
    fn start_engine(&self, binary: &Path, manifest: &Path) -> Result<()> {
        let mut command = self.command(binary, &["attach", "--create-background", self.session]);
        command
            .env("SWITCHBOARD_HANDOFF_MANIFEST", manifest)
            .env("SWITCHBOARD_HANDOFF_VERIFY", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let status = command.status().context("Cannot start the new engine")?;
        if !status.success() {
            bail!("The new engine failed to start: {status}");
        }
        Ok(())
    }

    /// Starts an engine and makes it final once it shows the same session.
    fn adopt(&self, binary: &Path, manifest: &Path) -> Result<()> {
        let frozen = frozen_identities(manifest)?;
        self.start_engine(binary, manifest)?;
        let verified = wait_until(VERIFY_TIMEOUT, || {
            self.identities(binary).is_ok_and(|seen| seen == frozen)
        });
        if !verified {
            bail!("The new engine did not show the same panes and tabs");
        }
        if self.reject_first_verification.take() {
            bail!("Verification was rejected for a test");
        }
        let commit = run_command(
            self.command(
                binary,
                &[
                    "-s",
                    self.session,
                    "pipe",
                    "--name",
                    "switchboard-handoff-commit",
                ],
            ),
            COMMAND_TIMEOUT,
        );
        if !wait_until(COMMAND_TIMEOUT, || !handoff::in_progress(self.session)) {
            bail!("The new engine did not finish taking over: {commit:?}");
        }
        Ok(())
    }

    /// Stops an unverified engine, which leaves the terminals with their host,
    /// and gives the session back to the executable it came from.
    fn roll_back(&self, record: &SessionRecord, journal: &Journal) -> Result<()> {
        let folder = record.host_directory.join("handoff");
        if let Some(pid) = fs::read_to_string(folder.join(format!("{}.pid", journal.id)))
            .ok()
            .and_then(|pid| pid.trim().parse().ok())
        {
            stop_process(pid);
        }
        if !wait_until(ENGINE_EXIT_TIMEOUT, || !self.session_exists()) {
            bail!("The failed engine did not stop");
        }
        let manifest = folder.join(format!("{}.json", journal.id));
        self.adopt(&journal.previous, &manifest)
            .context("The previous engine could not take the session back")?;
        let _ = fs::remove_file(folder.join(JOURNAL));
        Ok(())
    }

    /// Finishes a move that a previous run left between engines.
    fn settle_interrupted(&self) -> Result<bool> {
        let Some(record) = handoff::read_session_record(self.session) else {
            return Ok(false);
        };
        let path = record.host_directory.join("handoff").join(JOURNAL);
        let Ok(text) = fs::read_to_string(&path) else {
            return Ok(false);
        };
        let journal: Journal = serde_json::from_str(&text).context("Invalid swap journal")?;
        if !handoff::marked(self.session) {
            let _ = fs::remove_file(path);
            return Ok(false);
        }
        self.roll_back(&record, &journal)?;
        Ok(true)
    }

    pub(super) fn run(&self, candidate: &Path) -> Result<Outcome> {
        let Some(record) = handoff::read_session_record(self.session) else {
            return Ok(Outcome::NotMoved("the session has no terminal host".into()));
        };
        if self.settle_interrupted()? {
            return Ok(Outcome::RolledBack(
                "an earlier update left this session between engines".into(),
            ));
        }
        if handoff::in_progress(self.session) {
            return Ok(Outcome::NotMoved("a move is already in progress".into()));
        }
        // An update can replace the recorded file, and a session can be several
        // builds behind, so only a build proven to be this engine's will do.
        let Some(previous) = [Some(record.executable.as_path()), self.previous]
            .into_iter()
            .flatten()
            .find(|path| {
                path.is_file() && engine_fingerprint(path).is_ok_and(|built| built == record.engine)
            })
        else {
            return Ok(Outcome::NotMoved(
                "the build this session is running is no longer available".into(),
            ));
        };
        let folder = record.host_directory.join("handoff");
        fs::create_dir_all(&folder)?;
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let journal = Journal {
            id: format!("update-{nanos}"),
            previous: previous.to_path_buf(),
        };
        fs::write(folder.join(JOURNAL), serde_json::to_vec(&journal)?)?;
        // Only the old engine's own executable is sure to speak its protocol.
        // The pipe ends when the engine exits, so its own result says little.
        let _ = run_command(
            self.command(
                previous,
                &[
                    "-s",
                    self.session,
                    "pipe",
                    "--name",
                    "switchboard-handoff",
                    "--",
                    &journal.id,
                ],
            ),
            HANDOVER_TIMEOUT,
        );
        let manifest = folder.join(format!("{}.json", journal.id));
        if !manifest.is_file() {
            let _ = fs::remove_file(folder.join(JOURNAL));
            return Ok(Outcome::NotMoved("the engine declined to hand over".into()));
        }
        if !wait_until(ENGINE_EXIT_TIMEOUT, || !self.session_exists()) {
            bail!("The old engine did not exit after handing over");
        }
        match self.adopt(candidate, &manifest) {
            Ok(()) => {
                let _ = fs::remove_file(folder.join(JOURNAL));
                Ok(Outcome::Moved)
            },
            Err(error) => {
                self.roll_back(&record, &journal)
                    .map_err(|rollback| anyhow!("{error:#}; {rollback:#}"))?;
                Ok(Outcome::RolledBack(format!("{error:#}")))
            },
        }
    }
}

/// Finishes moves an earlier run left between engines. Reads files only, so
/// it can run on every scheduled update.
pub(super) fn settle_interrupted_moves(config: Option<&Path>) {
    for (session, _) in handoff::session_records() {
        let swap = Swap {
            session: &session,
            config,
            previous: None,
            reject_first_verification: Cell::new(false),
        };
        match swap.settle_interrupted() {
            Ok(true) => println!("Gave {session} back to its previous engine"),
            Ok(false) => {},
            Err(error) => eprintln!("Cannot recover {session}: {error:#}"),
        }
    }
}

/// Moves each running session whose engine is built differently from `binary`.
/// A session that cannot move keeps the engine it has, so nothing here fails
/// the update.
pub(super) fn swap_outdated_engines(binary: &Path, previous: Option<&Path>, config: Option<&Path>) {
    let fingerprint = match engine_fingerprint(binary) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            eprintln!("Not moving sessions: {error:#}");
            return;
        },
    };
    for (session, record) in handoff::session_records() {
        let swap = Swap {
            session: &session,
            config,
            previous,
            reject_first_verification: Cell::new(false),
        };
        if record.engine == fingerprint || !swap.session_exists() {
            continue;
        }
        match swap.run(binary) {
            Ok(Outcome::Moved) => println!("Moved {session} to a new engine"),
            Ok(Outcome::NotMoved(reason)) => println!("Did not move {session}: {reason}"),
            Ok(Outcome::RolledBack(reason)) => eprintln!("Rolled {session} back: {reason}"),
            Err(error) => eprintln!("Cannot move {session}: {error:#}"),
        }
    }
}

pub(super) fn run_cli(
    session: &str,
    binary: Option<&Path>,
    previous: Option<&Path>,
    config: Option<&Path>,
    reject_first_verification: bool,
) -> Result<()> {
    let current = std::env::current_exe()?;
    let swap = Swap {
        session,
        config,
        previous,
        reject_first_verification: Cell::new(reject_first_verification),
    };
    match swap.run(binary.unwrap_or(&current))? {
        Outcome::Moved => println!("Moved {session} to a new engine"),
        Outcome::NotMoved(reason) => println!("Did not move {session}: {reason}"),
        Outcome::RolledBack(reason) => bail!("Rolled {session} back: {reason}"),
    }
    Ok(())
}
