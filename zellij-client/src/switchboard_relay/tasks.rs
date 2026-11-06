//! Update tasks the user configures in `~/.config/switchboard/tasks.json`, run on a
//! schedule by this computer's relay and reported to every paired computer.
//!
//! Switchboard knows nothing about what a task does. The file is local and only its
//! owner writes it: browsers and paired computers can run, pause or clear the groups
//! it already names, never change what they run.
use super::*;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
    path::PathBuf,
    sync::{Mutex as SyncMutex, OnceLock},
    time::SystemTime,
};

const TICK: Duration = Duration::from_secs(30);
/// Scheduled runs wait this long after the relay starts, so an update handoff settles first.
const STARTUP_DELAY: Duration = Duration::from_secs(60);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TAIL: usize = 3;
const LOG_LIMIT: u64 = 256 * 1024;

static TASKS: OnceLock<Arc<Tasks>> = OnceLock::new();
/// Process ids of running tasks, each leading its own process group.
static RUNNING: SyncMutex<BTreeSet<u32>> = SyncMutex::new(BTreeSet::new());

#[derive(Deserialize, Clone, Default)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    groups: Vec<GroupConfig>,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct GroupConfig {
    name: String,
    every: String,
    #[serde(default)]
    hosts: Option<Vec<String>>,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    env: BTreeMap<String, String>,
    tasks: Vec<TaskConfig>,
    #[serde(skip)]
    interval: Duration,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskConfig {
    name: String,
    run: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    timeout: Option<String>,
    #[serde(default)]
    after: OneOrMany,
    #[serde(default)]
    when_agents_idle: bool,
    #[serde(skip)]
    limit: Duration,
}

#[derive(Deserialize, Clone, Default)]
#[serde(untagged)]
enum OneOrMany {
    #[default]
    None,
    One(String),
    Many(Vec<String>),
}

impl OneOrMany {
    fn names(&self) -> Vec<&str> {
        match self {
            OneOrMany::None => vec![],
            OneOrMany::One(name) => vec![name],
            OneOrMany::Many(names) => names.iter().map(String::as_str).collect(),
        }
    }
}

fn yes() -> bool {
    true
}

/// "30s", "10m", "6h", "1d" or a combination such as "1h30m".
fn duration(text: &str) -> Result<Duration, String> {
    let invalid = || format!("Invalid duration \"{text}\"; use a number with s, m, h or d");
    let (mut total, mut number) = (0u64, String::new());
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            number.push(c);
            continue;
        }
        let unit = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86400,
            _ => return Err(invalid()),
        };
        let value: u64 = number.parse().map_err(|_| invalid())?;
        total = value
            .checked_mul(unit)
            .and_then(|v| total.checked_add(v))
            .ok_or_else(invalid)?;
        number.clear();
    }
    if !number.is_empty() || total == 0 {
        return Err(invalid());
    }
    Ok(Duration::from_secs(total))
}

impl Config {
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut config: Config =
            serde_json::from_slice(bytes).map_err(|e| format!("tasks.json: {e}"))?;
        let mut groups = HashSet::new();
        for group in &mut config.groups {
            let name = group.name.clone();
            if name.trim().is_empty() || !groups.insert(name.clone()) {
                return Err(format!(
                    "Group names must be unique and not empty: \"{name}\""
                ));
            }
            group.interval = duration(&group.every).map_err(|e| format!("{name}: {e}"))?;
            if group.interval < Duration::from_secs(60) {
                return Err(format!("{name}: run at most once a minute"));
            }
            let mut tasks = HashSet::new();
            for task in &mut group.tasks {
                let label = format!("{name} / {}", task.name);
                if task.name.trim().is_empty() || !tasks.insert(task.name.clone()) {
                    return Err(format!("Task names must be unique in a group: \"{label}\""));
                }
                if task.run.first().is_none_or(|program| program.is_empty()) {
                    return Err(format!("{label}: \"run\" needs a program"));
                }
                task.limit = match &task.timeout {
                    Some(text) => duration(text).map_err(|e| format!("{label}: {e}"))?,
                    None => DEFAULT_TIMEOUT,
                };
            }
            group.tasks = order(&group.tasks).map_err(|e| format!("{name}: {e}"))?;
        }
        Ok(config)
    }
}

/// Tasks in the order written, moving each one after the tasks it names in `after`.
fn order(tasks: &[TaskConfig]) -> Result<Vec<TaskConfig>, String> {
    let known: HashSet<_> = tasks.iter().map(|t| t.name.as_str()).collect();
    for task in tasks {
        for dependency in task.after.names() {
            if !known.contains(dependency) || dependency == task.name {
                return Err(format!(
                    "\"{}\" runs after unknown task \"{dependency}\"",
                    task.name
                ));
            }
        }
    }
    let mut ordered: Vec<TaskConfig> = Vec::new();
    while ordered.len() < tasks.len() {
        let next = tasks.iter().find(|task| {
            !ordered.iter().any(|done| done.name == task.name)
                && task
                    .after
                    .names()
                    .iter()
                    .all(|dependency| ordered.iter().any(|done| done.name == *dependency))
        });
        match next {
            Some(task) => ordered.push(task.clone()),
            None => return Err("\"after\" forms a cycle".into()),
        }
    }
    Ok(ordered)
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
enum Status {
    #[default]
    Never,
    Ok,
    Failed,
    Timeout,
    Skipped,
    Running,
    Waiting,
    Interrupted,
}

impl Status {
    fn failed(self) -> bool {
        matches!(self, Status::Failed | Status::Timeout | Status::Interrupted)
    }
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
struct TaskState {
    status: Status,
    started: Option<u64>,
    finished: Option<u64>,
    exit_code: Option<i32>,
    duration_ms: Option<u64>,
    /// The last lines of stderr, or of stdout when stderr was empty.
    tail: Vec<String>,
    /// Summaries the task printed as `changed: <summary>`.
    changed: Vec<String>,
    note: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
struct GroupState {
    last_start: Option<u64>,
    last_end: Option<u64>,
    running: bool,
    /// Consecutive runs a relay restart cut short.
    interrupted: u32,
    /// Run at the next scheduled check regardless of the interval.
    retry: bool,
    paused: bool,
    /// Results finished before this time no longer need attention.
    seen: u64,
    tasks: BTreeMap<String, TaskState>,
}

#[derive(Default)]
struct Inner {
    config: Config,
    error: Option<String>,
    modified: Option<SystemTime>,
    groups: BTreeMap<String, GroupState>,
    /// Groups asked to run now, with the one task to run if not the whole group.
    requested: BTreeMap<String, Option<String>>,
    /// Names of this computer that a group's `hosts` may list.
    names: Vec<String>,
}

type Busy = Box<dyn Fn() -> futures_util::future::BoxFuture<'static, bool> + Send + Sync>;

pub(super) struct Tasks {
    config_file: PathBuf,
    state_file: PathBuf,
    logs: PathBuf,
    inner: SyncMutex<Inner>,
    saving: Mutex<()>,
    wake: tokio::sync::Notify,
    /// Whether an agent on this computer is working, for `whenAgentsIdle`.
    agents_busy: Busy,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

/// `~` at the start of a path, and of each entry of a path list.
fn expand(value: &str, list: bool) -> String {
    let one = |part: &str| match part.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            format!("{}{rest}", home().display())
        },
        _ => part.to_string(),
    };
    let separator = if cfg!(windows) { ";" } else { ":" };
    if list {
        value
            .split(separator)
            .map(one)
            .collect::<Vec<_>>()
            .join(separator)
    } else {
        one(value)
    }
}

/// Replace `${NAME}` with the variable from `env`, then the relay's environment.
fn substitute(value: &str, env: &BTreeMap<String, String>) -> String {
    static VARIABLE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}").unwrap());
    VARIABLE
        .replace_all(value, |captures: &regex::Captures| {
            env.get(&captures[1])
                .cloned()
                .or_else(|| std::env::var(&captures[1]).ok())
                .unwrap_or_default()
        })
        .into_owned()
}

fn file_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

impl GroupConfig {
    fn applies(&self, names: &[String]) -> bool {
        self.hosts.as_ref().is_none_or(|hosts| {
            hosts
                .iter()
                .any(|host| names.iter().any(|name| name.eq_ignore_ascii_case(host)))
        })
    }
}

impl Tasks {
    pub(super) fn new(directory: PathBuf, agents_busy: Busy) -> Arc<Self> {
        Arc::new(Self {
            config_file: directory.join("tasks.json"),
            state_file: directory.join("tasks").join("state.json"),
            logs: directory.join("tasks"),
            inner: Default::default(),
            saving: Mutex::new(()),
            wake: Default::default(),
            agents_busy,
        })
    }

    /// Restore saved results; a run the last relay did not finish is retried once.
    async fn load(&self) {
        let Ok(bytes) = tokio::fs::read(&self.state_file).await else {
            return;
        };
        let Ok(mut groups) = serde_json::from_slice::<BTreeMap<String, GroupState>>(&bytes) else {
            return;
        };
        for group in groups.values_mut() {
            if !std::mem::take(&mut group.running) {
                continue;
            }
            group.interrupted += 1;
            group.retry = group.interrupted == 1;
            for task in group.tasks.values_mut() {
                if matches!(task.status, Status::Running | Status::Waiting) {
                    task.status = Status::Interrupted;
                    task.finished = Some(now());
                    task.note = Some("Switchboard restarted during this task".into());
                }
            }
        }
        self.inner.lock().unwrap().groups = groups;
        self.save().await;
    }

    async fn save(&self) {
        let _saving = self.saving.lock().await;
        let data = serde_json::to_vec_pretty(&self.inner.lock().unwrap().groups).unwrap();
        if let Err(error) = logs::write_private(&self.state_file, &data).await {
            logs::record("tasks", &format!("Could not save task results: {error}"));
        }
    }

    /// Read tasks.json when it changes. A missing file means no tasks.
    async fn reload(&self) {
        let modified = tokio::fs::metadata(&self.config_file)
            .await
            .and_then(|m| m.modified())
            .ok();
        if modified == self.inner.lock().unwrap().modified {
            return;
        }
        let parsed = match tokio::fs::read(&self.config_file).await {
            Ok(bytes) => Config::parse(&bytes),
            Err(_) => Ok(Config::default()),
        };
        let mut inner = self.inner.lock().unwrap();
        inner.modified = modified;
        match parsed {
            Ok(config) => {
                inner.config = config;
                inner.error = None;
            },
            Err(error) => {
                logs::record("tasks", &error);
                inner.error = Some(error);
            },
        }
    }

    /// Groups to start now: asked for, or due on this computer.
    fn due(&self, scheduled: bool) -> Vec<(GroupConfig, Option<String>)> {
        let mut inner = self.inner.lock().unwrap();
        let time = now();
        let requested = std::mem::take(&mut inner.requested);
        let mut start = Vec::new();
        // An invalid file runs nothing until it is fixed.
        if inner.error.is_some() {
            return start;
        }
        for group in inner.config.groups.clone() {
            if !group.applies(&inner.names) {
                continue;
            }
            let state = inner.groups.entry(group.name.clone()).or_default();
            if state.running {
                continue;
            }
            let only = match requested.get(&group.name) {
                Some(only) => Some(only.clone()),
                None if scheduled && group.enabled && !state.paused => {
                    let due = state.retry
                        || state.last_start.is_none_or(|last| {
                            time >= last.saturating_add(group.interval.as_millis() as u64)
                        });
                    due.then_some(None)
                },
                None => None,
            };
            if let Some(only) = only {
                state.running = true;
                start.push((group, only));
            }
        }
        start
    }

    fn update(&self, group: &str, change: impl FnOnce(&mut GroupState)) {
        change(
            self.inner
                .lock()
                .unwrap()
                .groups
                .entry(group.to_string())
                .or_default(),
        );
    }

    async fn run_group(self: Arc<Self>, group: GroupConfig, only: Option<String>) {
        let started = now();
        if only.is_none() {
            self.update(&group.name, |state| {
                state.last_start = Some(started);
                state.retry = false;
            });
        }
        self.save().await;
        let mut results: BTreeMap<String, Status> = BTreeMap::new();
        for task in &group.tasks {
            if only.as_ref().is_some_and(|only| *only != task.name) {
                continue;
            }
            let blocked = task
                .after
                .names()
                .into_iter()
                .find(|d| only.is_none() && results.get(*d) != Some(&Status::Ok));
            let state = if let Some(dependency) = blocked {
                TaskState {
                    status: Status::Skipped,
                    started: Some(now()),
                    finished: Some(now()),
                    note: Some(format!("Skipped: \"{dependency}\" did not succeed")),
                    ..Default::default()
                }
            } else {
                self.wait_for_agents(&group.name, task).await;
                self.run_task(&group, task).await
            };
            results.insert(task.name.clone(), state.status);
            self.update(&group.name, |s| {
                s.tasks.insert(task.name.clone(), state);
            });
            self.save().await;
        }
        self.update(&group.name, |state| {
            state.running = false;
            state.interrupted = 0;
            if only.is_none() {
                state.last_end = Some(now());
            }
        });
        self.save().await;
    }

    async fn wait_for_agents(&self, group: &str, task: &TaskConfig) {
        if !task.when_agents_idle {
            return;
        }
        let mut waiting = false;
        while (self.agents_busy)().await {
            if !waiting {
                waiting = true;
                self.update(group, |state| {
                    let entry = state.tasks.entry(task.name.clone()).or_default();
                    entry.status = Status::Waiting;
                    entry.note = Some("Waiting for agents on this computer to finish".into());
                });
                self.save().await;
            }
            tokio::time::sleep(TICK).await;
        }
    }

    async fn run_task(&self, group: &GroupConfig, task: &TaskConfig) -> TaskState {
        let started = now();
        // The previous run's output no longer describes this task.
        self.update(&group.name, |state| {
            state.tasks.insert(
                task.name.clone(),
                TaskState {
                    status: Status::Running,
                    started: Some(started),
                    ..Default::default()
                },
            );
        });
        self.save().await;
        let config = self.inner.lock().unwrap().config.clone();
        let mut env = BTreeMap::new();
        for (name, value) in config.env.iter().chain(&group.env).chain(&task.env) {
            let value = expand(&substitute(value, &env), true);
            env.insert(name.clone(), value);
        }
        let log = self
            .logs
            .join(file_name(&group.name))
            .join(format!("{}.log", file_name(&task.name)));
        let mut state = run(task, &env, &log).await;
        state.started = Some(started);
        state.finished = Some(now());
        state.duration_ms = Some(state.finished.unwrap().saturating_sub(started));
        state
    }

    /// What this computer reports to browsers and paired computers.
    fn status(&self) -> Value {
        let inner = self.inner.lock().unwrap();
        let groups: Vec<_> = inner
            .config
            .groups
            .iter()
            .filter(|group| group.applies(&inner.names))
            .map(|group| {
                let state = inner.groups.get(&group.name).cloned().unwrap_or_default();
                describe(group, &state)
            })
            .collect();
        json!({
            "config": self.config_file.display().to_string(),
            "error": inner.error,
            "groups": groups,
        })
    }

    fn act(&self, action: &Action) -> Result<(), (StatusCode, &'static str)> {
        let mut inner = self.inner.lock().unwrap();
        let Some(group) = inner
            .config
            .groups
            .iter()
            .find(|g| g.name == action.group && g.applies(&inner.names))
            .cloned()
        else {
            return Err((StatusCode::NOT_FOUND, "No such task group on this computer"));
        };
        if let Some(task) = &action.task {
            if !group.tasks.iter().any(|t| t.name == *task) {
                return Err((StatusCode::NOT_FOUND, "No such task in this group"));
            }
        }
        let state = inner.groups.entry(group.name.clone()).or_default();
        match action.action.as_str() {
            "run" => {
                if state.running {
                    return Err((StatusCode::CONFLICT, "This group is already running"));
                }
                inner.requested.insert(group.name, action.task.clone());
                self.wake.notify_one();
            },
            "pause" => state.paused = true,
            "resume" => state.paused = false,
            "clear" => state.seen = now(),
            _ => return Err((StatusCode::BAD_REQUEST, "Unknown task action")),
        }
        Ok(())
    }

    async fn log(&self, group: &str, task: &str) -> Option<String> {
        let known = {
            let inner = self.inner.lock().unwrap();
            inner.config.groups.iter().any(|g| {
                g.name == group && g.applies(&inner.names) && g.tasks.iter().any(|t| t.name == task)
            })
        };
        if !known {
            return None;
        }
        let path = self
            .logs
            .join(file_name(group))
            .join(format!("{}.log", file_name(task)));
        let bytes = tokio::fs::read(path).await.ok()?;
        let start = bytes.len().saturating_sub(LOG_LIMIT as usize);
        Some(String::from_utf8_lossy(&bytes[start..]).into_owned())
    }

    async fn schedule(
        self: Arc<Self>,
        names: impl Fn() -> futures_util::future::BoxFuture<'static, Vec<String>>,
    ) {
        let ready = tokio::time::Instant::now() + STARTUP_DELAY;
        loop {
            let found = names().await;
            self.inner.lock().unwrap().names = found;
            self.reload().await;
            for (group, only) in self.due(tokio::time::Instant::now() >= ready) {
                tokio::spawn(self.clone().run_group(group, only));
            }
            tokio::select! {
                _ = tokio::time::sleep(TICK) => {},
                _ = self.wake.notified() => {},
            }
        }
    }
}

fn describe(group: &GroupConfig, state: &GroupState) -> Value {
    let tasks: Vec<_> = group
        .tasks
        .iter()
        .map(|task| {
            let result = state.tasks.get(&task.name).cloned().unwrap_or_default();
            json!({
                "name": task.name,
                "status": result.status,
                "started": result.started,
                "finished": result.finished,
                "exitCode": result.exit_code,
                "durationMs": result.duration_ms,
                "tail": result.tail,
                "changed": result.changed,
                "note": result.note,
                "whenAgentsIdle": task.when_agents_idle,
            })
        })
        .collect();
    let results: Vec<_> = group
        .tasks
        .iter()
        .filter_map(|task| state.tasks.get(&task.name).map(|r| (&task.name, r)))
        .collect();
    let failed = results.iter().find(|(_, r)| r.status.failed());
    let changed: Vec<_> = results
        .iter()
        .filter(|(_, r)| r.status == Status::Ok)
        .flat_map(|(_, r)| r.changed.iter().cloned())
        .collect();
    let status = if results.iter().any(|(_, r)| r.status == Status::Waiting) {
        "waiting"
    } else if state.running {
        "running"
    } else if failed.is_some() {
        "failed"
    } else if !changed.is_empty() {
        "changed"
    } else if results.iter().any(|(_, r)| r.status == Status::Ok) {
        "ok"
    } else if results.iter().any(|(_, r)| r.status == Status::Skipped) {
        "skipped"
    } else {
        "never"
    };
    let summary = match failed {
        Some((name, result)) => {
            // A timeout or restart explains itself better than the last output line.
            let (first, second) = (result.tail.last().cloned(), result.note.clone());
            let (first, second) = if result.status == Status::Failed {
                (first, second)
            } else {
                (second, first)
            };
            let detail = first
                .or(second)
                .or_else(|| result.exit_code.map(|code| format!("exit {code}")))
                .unwrap_or_else(|| "failed".into());
            format!("{name}: {detail}")
        },
        None => changed.join("; "),
    };
    // Failures and changes ask for attention until someone clears them.
    let notice = !state.running
        && results.iter().any(|(_, r)| {
            (r.status.failed() || (r.status == Status::Ok && !r.changed.is_empty()))
                && r.finished.unwrap_or(0) > state.seen
        });
    let next = (group.enabled && !state.paused).then(|| {
        state
            .last_start
            .map_or(now(), |last| last + group.interval.as_millis() as u64)
    });
    json!({
        "name": group.name,
        "every": group.every,
        "enabled": group.enabled,
        "paused": state.paused,
        "running": state.running,
        "status": status,
        "summary": summary,
        "notice": notice,
        "lastStart": state.last_start,
        "lastEnd": state.last_end,
        "nextRun": next,
        "tasks": tasks,
    })
}

#[derive(Default)]
struct Output {
    stdout: VecDeque<String>,
    stderr: VecDeque<String>,
    changed: Vec<String>,
}

fn keep(lines: &mut VecDeque<String>, line: &str) {
    let line = line.trim_end();
    if line.trim().is_empty() {
        return;
    }
    lines.push_back(line.chars().take(300).collect());
    if lines.len() > TAIL {
        lines.pop_front();
    }
}

/// Run one task: no shell, a timeout that ends its whole process group, output to its log.
async fn run(task: &TaskConfig, env: &BTreeMap<String, String>, log: &Path) -> TaskState {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let failed = |note: String| TaskState {
        status: Status::Failed,
        note: Some(note),
        ..Default::default()
    };
    if let Some(parent) = log.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }
    let mut file = match tokio::fs::File::create(log).await {
        Ok(file) => file,
        Err(error) => return failed(format!("Could not write the log: {error}")),
    };
    let argv: Vec<String> = task.run.iter().map(|a| expand(a, false)).collect();
    let started = time::OffsetDateTime::now_utc();
    let header = format!(
        "# {} started {} {:02}:{:02}:{:02} UTC\n$ {}\n",
        task.name,
        started.date(),
        started.hour(),
        started.minute(),
        started.second(),
        argv.join(" ")
    );
    let _ = file.write_all(header.as_bytes()).await;
    let mut command = tokio::process::Command::new(&argv[0]);
    command
        .args(&argv[1..])
        .envs(env)
        .current_dir(
            task.cwd
                .as_deref()
                .map_or_else(home, |c| expand(c, false).into()),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let note = format!("Could not start {}: {error}", argv[0]);
            let _ = file.write_all(format!("# {note}\n").as_bytes()).await;
            return failed(note);
        },
    };
    let output = Arc::new(SyncMutex::new(Output::default()));
    let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let collected = output.clone();
    let reader = tokio::spawn(async move {
        let mut out = tokio::io::BufReader::new(stdout).lines();
        let mut err = tokio::io::BufReader::new(stderr).lines();
        let (mut out_open, mut err_open) = (true, true);
        while out_open || err_open {
            let (line, is_err) = tokio::select! {
                line = out.next_line(), if out_open => (line, false),
                line = err.next_line(), if err_open => (line, true),
            };
            let Ok(Some(line)) = line else {
                if is_err {
                    err_open = false
                } else {
                    out_open = false
                }
                continue;
            };
            let _ = file.write_all(format!("{line}\n").as_bytes()).await;
            let mut output = collected.lock().unwrap();
            if is_err {
                keep(&mut output.stderr, &line);
            } else {
                if let Some(summary) = line.strip_prefix("changed:") {
                    if output.changed.len() < 20 {
                        output
                            .changed
                            .push(summary.trim().chars().take(200).collect());
                    }
                }
                keep(&mut output.stdout, &line);
            }
        }
        file
    });
    let id = child.id();
    RUNNING.lock().unwrap().extend(id);
    let waited = tokio::time::timeout(task.limit, child.wait()).await;
    if waited.is_err() {
        stop(&mut child).await;
    }
    if let Some(id) = id {
        RUNNING.lock().unwrap().remove(&id);
    }
    // A background process may hold the pipes open after the task itself exits.
    let mut file = match tokio::time::timeout(Duration::from_secs(2), reader).await {
        Ok(Ok(file)) => Some(file),
        _ => tokio::fs::OpenOptions::new()
            .append(true)
            .open(log)
            .await
            .ok(),
    };
    let output = std::mem::take(&mut *output.lock().unwrap());
    let tail: Vec<String> = if output.stderr.is_empty() {
        output.stdout.into()
    } else {
        output.stderr.into()
    };
    let mut state = TaskState {
        tail,
        changed: output.changed,
        ..Default::default()
    };
    let footer = match waited {
        Err(_) => {
            state.status = Status::Timeout;
            state.note = Some(format!(
                "Stopped after {}",
                task.timeout.as_deref().unwrap_or("30m")
            ));
            format!("# {}\n", state.note.as_deref().unwrap())
        },
        Ok(Err(error)) => {
            state.status = Status::Failed;
            state.note = Some(format!("Lost the process: {error}"));
            format!("# {}\n", state.note.as_deref().unwrap())
        },
        Ok(Ok(status)) => {
            state.exit_code = status.code();
            state.status = if status.success() {
                Status::Ok
            } else {
                Status::Failed
            };
            if status.code().is_none() {
                state.note = Some("Ended by a signal".into());
            }
            format!(
                "# exit {}\n",
                status.code().map_or("signal".into(), |c| c.to_string())
            )
        },
    };
    if let Some(file) = &mut file {
        let _ = file.write_all(footer.as_bytes()).await;
    }
    state
}

/// End a task and everything it started.
async fn stop(child: &mut tokio::process::Child) {
    if let Some(id) = child.id() {
        stop_tree(id).await;
    }
    let _ = child.kill().await;
}

async fn stop_tree(id: u32) {
    #[cfg(unix)]
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(id as i32),
        nix::sys::signal::Signal::SIGKILL,
    );
    #[cfg(windows)]
    let _ = tokio::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &id.to_string()])
        .creation_flags(0x0800_0000)
        .output()
        .await;
}

/// End running tasks as the relay stops. They run in their own process groups, so the
/// service manager may not reach them, and the next relay reruns the group.
pub(super) async fn stop_running() {
    let running = std::mem::take(&mut *RUNNING.lock().unwrap());
    for id in running {
        stop_tree(id).await;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Action {
    #[serde(default)]
    host: Option<String>,
    group: String,
    #[serde(default)]
    task: Option<String>,
    action: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LogQuery {
    #[serde(default)]
    host: Option<String>,
    group: String,
    task: String,
}

/// Start the scheduler for `~/.config/switchboard/tasks.json`.
pub(super) async fn start(state: RelayState) -> tokio::task::JoinHandle<()> {
    start_in(home().join(".config").join("switchboard"), state).await
}

async fn start_in(directory: PathBuf, state: RelayState) -> tokio::task::JoinHandle<()> {
    let (poll, local) = (state.poll.clone(), state.order.clone());
    let tasks = Tasks::new(
        directory,
        Box::new(move || {
            let (poll, local) = (poll.clone(), local.clone());
            Box::pin(async move { poll.lock().await.agents_working(&local) })
        }),
    );
    tasks.load().await;
    let _ = TASKS.set(tasks.clone());
    let mesh = state.mesh.clone();
    tokio::spawn(tasks.schedule(move || {
        let mesh = mesh.clone();
        Box::pin(async move {
            let mut names = Vec::new();
            if let Some(mesh) = &mesh {
                names.extend(mesh.computer_name().await);
            }
            if let Some(system) = hostname::system().await {
                names.push(system.trim_end_matches(".local").to_string());
            }
            names
        })
    }))
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":"Update tasks are not running on this computer"})),
    )
        .into_response()
}

/// The PATH tasks.json gives its tasks, which knows where this computer's tools live.
pub(super) fn configured_path() -> Option<String> {
    let tasks = TASKS.get()?;
    let inner = tasks.inner.lock().unwrap();
    let path = inner.config.env.get("PATH")?;
    Some(expand(&substitute(path, &inner.config.env), true))
}

fn local_status() -> Value {
    let mut status = TASKS.get().map_or_else(
        || json!({"groups": [], "error": "Update tasks unavailable"}),
        |t| t.status(),
    );
    let (switchboard, agents) = agent_setup::status();
    status["switchboard"] = switchboard;
    status["agents"] = agents;
    status
}

fn act_locally(action: &Action) -> Response {
    let Some(tasks) = TASKS.get() else {
        return unavailable();
    };
    match tasks.act(action) {
        Ok(()) => Json(json!({"ok": true})).into_response(),
        Err((status, error)) => (status, Json(json!({ "error": error }))).into_response(),
    }
}

async fn log_locally(group: &str, task: &str) -> Response {
    let Some(tasks) = TASKS.get() else {
        return unavailable();
    };
    match tasks.log(group, task).await {
        Some(text) => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response(),
        None => (StatusCode::NOT_FOUND, "No log for this task yet").into_response(),
    }
}

/// Requests from paired computers, which reach only groups this computer already runs.
pub(super) async fn gateway(request: Request) -> Response {
    let path = request.uri().path().to_string();
    match (request.method().clone(), path.as_str()) {
        (Method::GET, "/switchboard/tasks") => Json(local_status()).into_response(),
        (Method::POST, "/switchboard/tasks/action") => {
            let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match serde_json::from_slice::<Action>(&bytes) {
                Ok(action) if action.host.is_none() => act_locally(&action),
                _ => (StatusCode::BAD_REQUEST, "Invalid task action").into_response(),
            }
        },
        (Method::POST, "/switchboard/tasks/setup") => {
            let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match serde_json::from_slice::<agent_setup::SetupRequest>(&bytes) {
                Ok(setup) if setup.host.is_none() => agent_setup::set_up_locally(&setup),
                _ => (StatusCode::BAD_REQUEST, "Invalid setup request").into_response(),
            }
        },
        (Method::POST, "/switchboard/tasks/update") => {
            let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
                return StatusCode::BAD_REQUEST.into_response();
            };
            match serde_json::from_slice::<UpdateRequest>(&bytes) {
                Ok(update) if update.host.is_none() => update_locally().await,
                _ => (StatusCode::BAD_REQUEST, "Invalid update request").into_response(),
            }
        },
        (Method::GET, "/switchboard/tasks/log") => {
            match axum::extract::Query::<LogQuery>::try_from_uri(request.uri()) {
                Ok(axum::extract::Query(query)) if query.host.is_none() => {
                    log_locally(&query.group, &query.task).await
                },
                _ => (StatusCode::BAD_REQUEST, "Invalid log request").into_response(),
            }
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn peer(host: &Host) -> Value {
    let base = json!({"name": host.config.name, "host": host.config.id});
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        host.request(
            Method::GET,
            "/switchboard/tasks",
            Bytes::new(),
            "application/json",
        ),
    )
    .await;
    let error = match result {
        Ok(Ok(response)) if response.status == StatusCode::OK => {
            match serde_json::from_slice::<Value>(&response.body) {
                Ok(Value::Object(mut body)) if body.get("groups").is_some_and(Value::is_array) => {
                    body.insert("name".into(), base["name"].clone());
                    body.insert("host".into(), base["host"].clone());
                    return Value::Object(body);
                },
                _ => "Update tasks unavailable on this computer's version",
            }
        },
        Ok(Ok(response)) if response.status == StatusCode::NOT_FOUND => {
            "Update tasks unavailable on this computer's version"
        },
        Ok(_) => "Update tasks unavailable",
        Err(_) => "Computer did not respond",
    };
    json!({"name": base["name"], "host": base["host"], "groups": [], "error": error})
}

pub(super) async fn handler(State(state): State<RelayState>) -> Json<Value> {
    let mut name = "This computer".to_string();
    let mut peers = Vec::new();
    if let Some(mesh) = &state.mesh {
        if let Some(local) = mesh.computer_name().await {
            name = local;
        }
        peers = mesh.hosts();
    }
    let mut local = local_status();
    local["name"] = json!(name);
    local["local"] = json!(true);
    let mut computers = vec![local];
    computers.extend(futures_util::future::join_all(peers.iter().map(|h| peer(h))).await);
    Json(json!({ "computers": computers }))
}

fn peer_host(state: &RelayState, id: &str) -> Option<Arc<Host>> {
    state.mesh.as_ref().and_then(|mesh| mesh.host(id))
}

fn relayed(
    result: Result<anyhow::Result<UpstreamResponse>, tokio::time::error::Elapsed>,
) -> Response {
    match result {
        Ok(Ok(response)) => {
            let mime = response
                .headers
                .get(header::CONTENT_TYPE)
                .cloned()
                .unwrap_or_else(|| header::HeaderValue::from_static("text/plain"));
            (
                response.status,
                [(header::CONTENT_TYPE, mime)],
                response.body,
            )
                .into_response()
        },
        Ok(Err(_)) => (StatusCode::BAD_GATEWAY, "Computer unavailable").into_response(),
        Err(_) => (StatusCode::GATEWAY_TIMEOUT, "Computer did not respond").into_response(),
    }
}

pub(super) async fn action(State(state): State<RelayState>, request: Request) -> Response {
    let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(mut action) = serde_json::from_slice::<Action>(&bytes) else {
        return (StatusCode::BAD_REQUEST, "Invalid task action").into_response();
    };
    let Some(id) = action.host.take() else {
        return act_locally(&action);
    };
    let Some(host) = peer_host(&state, &id) else {
        return (StatusCode::NOT_FOUND, "Unknown computer").into_response();
    };
    let body = json!({"group": action.group, "task": action.task, "action": action.action});
    relayed(
        tokio::time::timeout(
            Duration::from_secs(5),
            host.request(
                Method::POST,
                "/switchboard/tasks/action",
                Bytes::from(body.to_string()),
                "application/json",
            ),
        )
        .await,
    )
}

/// Set up an agent's status reporting on this or a paired computer.
pub(super) async fn setup(State(state): State<RelayState>, request: Request) -> Response {
    let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(mut setup) = serde_json::from_slice::<agent_setup::SetupRequest>(&bytes) else {
        return (StatusCode::BAD_REQUEST, "Invalid setup request").into_response();
    };
    let Some(id) = setup.host.take() else {
        return agent_setup::set_up_locally(&setup);
    };
    let Some(host) = peer_host(&state, &id) else {
        return (StatusCode::NOT_FOUND, "Unknown computer").into_response();
    };
    relayed(
        tokio::time::timeout(
            Duration::from_secs(5),
            host.request(
                Method::POST,
                "/switchboard/tasks/setup",
                Bytes::from(
                    match setup.action {
                        agent_setup::SetupAction::Setup => json!({"agent": setup.agent}),
                        agent_setup::SetupAction::FixSkills => {
                            json!({"agent": setup.agent, "action": setup.action})
                        },
                    }
                    .to_string(),
                ),
                "application/json",
            ),
        )
        .await,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UpdateRequest {
    #[serde(default)]
    host: Option<String>,
}

async fn update_locally() -> Response {
    match super::update_watch::update_now().await {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({"ok": true}))).into_response(),
        Err(error) => (StatusCode::CONFLICT, Json(json!({ "error": error }))).into_response(),
    }
}

/// `POST /api/tasks/update`: start a computer's update job now, from Settings → Health.
pub(super) async fn update(State(state): State<RelayState>, request: Request) -> Response {
    let Ok(bytes) = to_bytes(request.into_body(), 4096).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Ok(update) = serde_json::from_slice::<UpdateRequest>(&bytes) else {
        return (StatusCode::BAD_REQUEST, "Invalid update request").into_response();
    };
    let Some(id) = update.host else {
        return update_locally().await;
    };
    let Some(host) = peer_host(&state, &id) else {
        return (StatusCode::NOT_FOUND, "Unknown computer").into_response();
    };
    relayed(
        tokio::time::timeout(
            Duration::from_secs(10),
            host.request(
                Method::POST,
                "/switchboard/tasks/update",
                Bytes::from("{}"),
                "application/json",
            ),
        )
        .await,
    )
}

pub(super) async fn log(
    State(state): State<RelayState>,
    axum::extract::Query(query): axum::extract::Query<LogQuery>,
) -> Response {
    let Some(id) = &query.host else {
        return log_locally(&query.group, &query.task).await;
    };
    let Some(host) = peer_host(&state, id) else {
        return (StatusCode::NOT_FOUND, "Unknown computer").into_response();
    };
    let path = format!(
        "/switchboard/tasks/log?group={}&task={}",
        urlencoding::encode(&query.group),
        urlencoding::encode(&query.task)
    );
    relayed(
        tokio::time::timeout(
            Duration::from_secs(10),
            host.request(Method::GET, &path, Bytes::new(), "text/plain"),
        )
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tasks_in(directory: &Path, busy: Arc<std::sync::atomic::AtomicBool>) -> Arc<Tasks> {
        let tasks = Tasks::new(
            directory.to_path_buf(),
            Box::new(move || {
                let busy = busy.clone();
                Box::pin(async move { busy.load(std::sync::atomic::Ordering::SeqCst) })
            }),
        );
        tasks.inner.lock().unwrap().names = vec!["Mac".into()];
        tasks
    }

    async fn write_config(directory: &Path, config: Value) {
        tokio::fs::write(directory.join("tasks.json"), config.to_string())
            .await
            .unwrap();
    }

    async fn run_due(tasks: &Arc<Tasks>) {
        tasks.inner.lock().unwrap().modified = None;
        tasks.reload().await;
        for (group, only) in tasks.due(true) {
            tasks.clone().run_group(group, only).await;
        }
    }

    #[cfg(unix)]
    fn sh(script: &str) -> Value {
        json!(["sh", "-c", script])
    }

    #[test]
    fn durations_accept_units_and_combinations() {
        assert_eq!(duration("6h").unwrap(), Duration::from_secs(6 * 3600));
        assert_eq!(duration("1h30m").unwrap(), Duration::from_secs(5400));
        assert_eq!(duration("1d").unwrap(), Duration::from_secs(86400));
        for bad in ["", "6", "h", "1w", "0m", "1.5h"] {
            assert!(duration(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn configs_are_validated_and_ordered_by_after() {
        let config = Config::parse(
            br#"{"groups":[{"name":"dotfiles","every":"6h","tasks":[
                {"name":"plugins","run":["nu"],"after":"pull","whenAgentsIdle":true},
                {"name":"pull","run":["git","pull"],"timeout":"10m"}]}]}"#,
        )
        .unwrap();
        let group = &config.groups[0];
        assert_eq!(
            group
                .tasks
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            ["pull", "plugins"]
        );
        assert_eq!(group.tasks[0].limit, Duration::from_secs(600));
        assert_eq!(group.tasks[1].limit, DEFAULT_TIMEOUT);
        for (bad, why) in [
            (
                r#"{"groups":[{"name":"a","every":"6h","tasks":[{"name":"x","run":[]}]}]}"#,
                "needs a program",
            ),
            (
                r#"{"groups":[{"name":"a","every":"30s","tasks":[]}]}"#,
                "once a minute",
            ),
            (
                r#"{"groups":[{"name":"a","every":"6h","tasks":[{"name":"x","run":["a"],"after":"y"}]}]}"#,
                "unknown task",
            ),
            (
                r#"{"groups":[{"name":"a","every":"6h","tasks":[{"name":"x","run":["a"],"after":"y"},{"name":"y","run":["a"],"after":"x"}]}]}"#,
                "cycle",
            ),
            (
                r#"{"groups":[{"name":"a","every":"6h","tasks":[]},{"name":"a","every":"6h","tasks":[]}]}"#,
                "unique",
            ),
            (
                r#"{"groups":[{"name":"a","every":"6h","tasks":[],"typo":1}]}"#,
                "unknown field",
            ),
        ] {
            let error = Config::parse(bad.as_bytes()).err().unwrap();
            assert!(error.contains(why), "{bad}: {error}");
        }
    }

    #[test]
    fn home_is_expanded_in_paths_and_path_lists() {
        let home = home().display().to_string();
        assert_eq!(expand("~/bin", false), format!("{home}/bin"));
        assert_eq!(expand("~user/bin", false), "~user/bin");
        let separator = if cfg!(windows) { ";" } else { ":" };
        assert_eq!(
            expand(&format!("~/a{separator}/b"), true),
            format!("{home}/a{separator}/b")
        );
        let env = BTreeMap::from([("A".to_string(), "x".to_string())]);
        assert_eq!(substitute("${A}/${SWITCHBOARD_UNSET_VARIABLE}", &env), "x/");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_group_reports_results_changes_and_skips_dependents_of_failures() {
        let directory = tempfile::tempdir().unwrap();
        let tasks = tasks_in(directory.path(), Default::default());
        write_config(
            directory.path(),
            json!({"env":{"GREETING":"hi"},"groups":[{"name":"dotfiles","every":"6h","tasks":[
                {"name":"pull","run":sh("echo $GREETING; echo 'changed: dotfiles 3 commits'")},
                {"name":"plugins","run":sh("echo first >&2; echo codex failed >&2; exit 3"),"after":"pull"},
                {"name":"after plugins","run":sh("echo never"),"after":"plugins"},
                {"name":"independent","run":sh("pwd")}]}]}),
        )
        .await;
        run_due(&tasks).await;
        let status = tasks.status();
        let group = &status["groups"][0];
        assert_eq!(group["status"], "failed");
        assert_eq!(group["summary"], "plugins: codex failed");
        assert_eq!(group["notice"], true);
        let task = |name: &str| {
            group["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == name)
                .unwrap()
                .clone()
        };
        assert_eq!(task("pull")["status"], "ok");
        assert_eq!(task("pull")["changed"], json!(["dotfiles 3 commits"]));
        assert_eq!(task("pull")["tail"][0], "hi");
        assert_eq!(task("plugins")["exitCode"], 3);
        assert_eq!(task("plugins")["tail"], json!(["first", "codex failed"]));
        assert_eq!(task("after plugins")["status"], "skipped");
        assert_eq!(task("independent")["status"], "ok");
        assert_eq!(
            task("independent")["tail"][0],
            home().canonicalize().unwrap().display().to_string()
        );
        let log = tasks.log("dotfiles", "plugins").await.unwrap();
        assert!(
            log.contains("codex failed") && log.ends_with("# exit 3\n"),
            "{log}"
        );
        assert!(tasks.log("dotfiles", "../state").await.is_none());

        // Not due again until the interval passes; clearing ends the notice everywhere.
        assert!(tasks.due(true).is_empty());
        let action = |action: &str| Action {
            host: None,
            group: "dotfiles".into(),
            task: None,
            action: action.into(),
        };
        tasks.act(&action("clear")).unwrap();
        assert_eq!(tasks.status()["groups"][0]["notice"], false);
        tasks.act(&action("pause")).unwrap();
        assert!(tasks.status()["groups"][0]["nextRun"].is_null());
        // Run now still works while paused.
        tasks.act(&action("run")).unwrap();
        assert_eq!(tasks.due(true).len(), 1);
        assert!(tasks.act(&action("run")).is_err(), "already running");
        let missing = Action {
            group: "nope".into(),
            ..action("run")
        };
        assert_eq!(tasks.act(&missing).unwrap_err().0, StatusCode::NOT_FOUND);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeouts_end_the_whole_process_group() {
        let directory = tempfile::tempdir().unwrap();
        let tasks = tasks_in(directory.path(), Default::default());
        let marker = directory.path().join("survived");
        write_config(
            directory.path(),
            json!({"groups":[{"name":"slow","every":"1h","tasks":[{"name":"sleep","timeout":"1s",
                "run":sh(&format!("(sleep 3; touch {}) & sleep 30", marker.display()))}]}]}),
        )
        .await;
        let started = std::time::Instant::now();
        run_due(&tasks).await;
        assert!(started.elapsed() < Duration::from_secs(10));
        let task = &tasks.status()["groups"][0]["tasks"][0];
        assert_eq!(task["status"], "timeout");
        assert_eq!(tasks.status()["groups"][0]["status"], "failed");
        assert_eq!(
            tasks.status()["groups"][0]["summary"],
            "sleep: Stopped after 1s"
        );
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!marker.exists(), "background child outlived the timeout");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hosts_limit_groups_and_invalid_files_run_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let tasks = tasks_in(directory.path(), Default::default());
        write_config(
            directory.path(),
            json!({"groups":[
                {"name":"here","every":"1h","hosts":["mac"],"tasks":[{"name":"a","run":sh("true")}]},
                {"name":"elsewhere","every":"1h","hosts":["Dom-PC"],"tasks":[{"name":"a","run":sh("true")}]},
                {"name":"off","every":"1h","enabled":false,"tasks":[{"name":"a","run":sh("true")}]}]}),
        )
        .await;
        run_due(&tasks).await;
        let status = tasks.status();
        let names: Vec<_> = status["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| g["name"].clone())
            .collect();
        assert_eq!(names, ["here", "off"]);
        assert_eq!(status["groups"][0]["status"], "ok");
        assert_eq!(status["groups"][1]["status"], "never");
        tokio::fs::write(directory.path().join("tasks.json"), "{")
            .await
            .unwrap();
        tasks.inner.lock().unwrap().modified = None;
        tasks.reload().await;
        tasks
            .inner
            .lock()
            .unwrap()
            .groups
            .get_mut("here")
            .unwrap()
            .retry = true;
        assert!(tasks.due(true).is_empty());
        assert!(tasks.status()["error"]
            .as_str()
            .unwrap()
            .starts_with("tasks.json:"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn agent_idle_tasks_wait_and_restarts_retry_once() {
        let directory = tempfile::tempdir().unwrap();
        let busy = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let tasks = tasks_in(directory.path(), busy.clone());
        write_config(
            directory.path(),
            json!({"groups":[{"name":"plugins","every":"1h","tasks":[
                {"name":"update","run":sh("true"),"whenAgentsIdle":true}]}]}),
        )
        .await;
        tasks.reload().await;
        let (group, only) = tasks.due(true).pop().unwrap();
        tokio::time::pause();
        let running = tokio::spawn(tasks.clone().run_group(group, only));
        while tasks.status()["groups"][0]["status"] != "waiting" {
            tokio::time::advance(Duration::from_millis(10)).await;
        }
        tokio::time::advance(TICK).await;
        assert_eq!(tasks.status()["groups"][0]["status"], "waiting");
        tokio::time::resume();
        let state = directory.path().join("tasks/state.json");
        while !tokio::fs::read_to_string(&state)
            .await
            .is_ok_and(|saved| saved.contains("\"waiting\""))
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // The relay restarts while the task waits: the next relay retries the run once.
        running.abort();
        let reloaded = tasks_in(directory.path(), busy.clone());
        reloaded.load().await;
        reloaded.reload().await;
        let saved = reloaded.status();
        assert_eq!(saved["groups"][0]["tasks"][0]["status"], "interrupted");
        assert_eq!(saved["groups"][0]["notice"], true);
        busy.store(false, std::sync::atomic::Ordering::SeqCst);
        let due = reloaded.due(true);
        assert_eq!(due.len(), 1);
        for (group, only) in due {
            reloaded.clone().run_group(group, only).await;
        }
        assert_eq!(reloaded.status()["groups"][0]["status"], "ok");
    }

    #[tokio::test]
    async fn api_routes_sit_behind_the_relay_guard_and_reject_unknown_computers() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        let send = |method: Method, path: &str, origin: &str, body: &str| {
            hyper::Request::builder()
                .method(method)
                .uri(path)
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let local = "http://127.0.0.1:8090";
        let run = r#"{"host":"elsewhere","group":"dotfiles","action":"run"}"#;
        for request in [
            send(Method::GET, "/api/tasks", "https://attacker.example", ""),
            send(
                Method::POST,
                "/api/tasks/action",
                "https://attacker.example",
                run,
            ),
        ] {
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        let response = app
            .clone()
            .oneshot(send(Method::GET, "/api/tasks", local, ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), LIMIT).await.unwrap()).unwrap();
        assert_eq!(body["computers"][0]["local"], true);
        assert!(body["computers"][0]["groups"].is_array());
        let response = app
            .clone()
            .oneshot(send(Method::POST, "/api/tasks/action", local, run))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let edit = r#"{"group":"dotfiles","action":"run","run":["rm"]}"#;
        let response = app
            .oneshot(send(Method::POST, "/api/tasks/action", local, edit))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "commands are never accepted"
        );
    }
}
