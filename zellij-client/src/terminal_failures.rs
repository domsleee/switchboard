//! Durable, content-free terminal failures shared by retained workers and relays.
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

const CAPACITY: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Failure {
    pub reference: String,
    pub code: String,
    pub session: String,
    pub pane_id: Option<u32>,
    pub is_plugin: bool,
    pub operation: String,
    pub elapsed_ms: u64,
    pub focus_confirmed: bool,
    pub query_received: bool,
    pub worker_build: Option<String>,
    // Older native engines do not report their build. Never substitute the relay build.
    pub engine_build: Option<String>,
    pub pending_records: Option<u32>,
}

impl Failure {
    pub fn valid(&self) -> bool {
        self.reference.len() == 12
            && self.reference.bytes().all(|b| b.is_ascii_hexdigit())
            && matches!(
                self.code.as_str(),
                "focus_unconfirmed"
                    | "focus_timeout"
                    | "pane_unavailable"
                    | "ipc_failure"
                    | "permission_revoked"
                    | "attachment_expired"
                    | "attachment_ended"
                    | "input_sequence"
                    | "browser_failure"
                    | "input_limit"
                    | "invalid_delivery"
                    | "renderer_unavailable"
                    | "resume_timeout"
            )
            && matches!(
                self.operation.as_str(),
                "attach" | "focus" | "input" | "control" | "transport" | "browser"
            )
            && self.session.chars().count() <= 128
            && !self.session.chars().any(char::is_control)
            && self.elapsed_ms <= 86_400_000
            && [&self.worker_build, &self.engine_build]
                .into_iter()
                .flatten()
                .all(|s| s.len() <= 40 && s.bytes().all(|b| b.is_ascii_hexdigit()))
    }
    fn message(&self) -> String {
        format!("Terminal failure {} ref={} pane={}{} op={} focus={} query={} worker={} engine={} t={}ms pending={}",
            self.code, self.reference, if self.is_plugin { "plugin:" } else { "" },
            self.pane_id.map_or_else(|| "?".into(), |p| p.to_string()), self.operation,
            self.focus_confirmed, self.query_received, self.worker_build.as_deref().unwrap_or("unknown"),
            self.engine_build.as_deref().unwrap_or("unknown"), self.elapsed_ms,
            self.pending_records.map_or_else(|| "?".into(), |n| n.to_string()))
    }
}

pub(crate) fn path() -> Result<PathBuf> {
    Ok(std::env::var_os("SWITCHBOARD_TERMINAL_FAILURE_FILE")
        .map(PathBuf::from)
        .unwrap_or(
            std::env::home_dir()
                .context("No home directory")?
                .join(".config/switchboard/terminal-failures.json"),
        ))
}

fn read(path: &Path) -> Result<Vec<Value>> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

/// Lock only the diagnostic store, never a terminal or a transport. Atomic replacement
/// lets the relay read it without a lock, including after a worker or relay exits.
pub(crate) fn record_at(path: &Path, source: &str, failure: &Failure) -> Result<()> {
    ensure!(failure.valid(), "Invalid terminal failure metadata");
    let parent = path.parent().context("No failure directory")?;
    fs::create_dir_all(parent)?;
    let mut options = fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(path.with_extension("lock"))?;
    lock.lock()?;
    let mut entries = read(path)?;
    // A browser may report an error the worker already saved. It is one occurrence.
    if entries.iter().any(|e| {
        e["references"]
            .as_array()
            .is_some_and(|refs| refs.iter().any(|r| r == &failure.reference))
    }) {
        return Ok(());
    }
    let repeat = entries
        .iter()
        .position(|entry| {
            let old = &entry["failure"];
            entry["source"] == source
                && old["code"] == failure.code
                && old["session"] == failure.session
                && old["pane_id"] == json!(failure.pane_id)
                && old["is_plugin"] == failure.is_plugin
                && old["operation"] == failure.operation
                && old["worker_build"] == json!(failure.worker_build)
                && old["engine_build"] == json!(failure.engine_build)
                && old["focus_confirmed"] == failure.focus_confirmed
                && old["query_received"] == failure.query_received
        })
        .map(|i| entries.remove(i));
    let count = repeat
        .as_ref()
        .and_then(|e| e["count"].as_u64())
        .unwrap_or(0)
        .saturating_add(1);
    let mut references = repeat
        .and_then(|e| e["references"].as_array().cloned())
        .unwrap_or_default();
    references.push(json!(failure.reference));
    if references.len() > 8 {
        references.remove(0);
    }
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as u64;
    entries.push(json!({"source":source,"message":failure.message(),"time":time,"count":count,"references":references,"failure":failure}));
    if entries.len() > CAPACITY {
        entries.drain(..entries.len() - CAPACITY);
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(&serde_json::to_vec(&entries)?)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    Ok(())
}

pub(crate) fn entries() -> Vec<Value> {
    path().and_then(|p| read(&p)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> Failure {
        Failure {
            reference: "0123456789ab".into(),
            code: "focus_unconfirmed".into(),
            session: "fixture".into(),
            pane_id: Some(7),
            is_plugin: false,
            operation: "focus".into(),
            elapsed_ms: 21,
            focus_confirmed: false,
            query_received: true,
            worker_build: Some("abcdef01".into()),
            engine_build: None,
            pending_records: None,
        }
    }
    #[test]
    fn switchboard_terminal_failure_concurrent_writers_keep_every_occurrence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("failures.json");
        let threads: Vec<_> = (0..8)
            .map(|id| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut failure = sample();
                    failure.reference = format!("{id:012x}");
                    record_at(&path, "Terminal worker", &failure).unwrap();
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        let saved = read(&path).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["count"], 8);
        assert_eq!(saved[0]["references"].as_array().unwrap().len(), 8);
    }
    #[test]
    fn switchboard_terminal_failure_survives_reopen_and_counts_repeats_without_double_reporting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("failures.json");
        let mut failure = sample();
        record_at(&path, "Terminal worker", &failure).unwrap();
        record_at(&path, "Browser", &failure).unwrap();
        let saved = read(&path).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["count"], 1);
        assert_eq!(saved[0]["failure"]["query_received"], true);
        assert_eq!(saved[0]["failure"]["engine_build"], Value::Null);
        failure.reference = "abcdef012345".into();
        record_at(&path, "Terminal worker", &failure).unwrap();
        let reopened = read(&path).unwrap();
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0]["count"], 2);
        assert_eq!(reopened[0]["references"].as_array().unwrap().len(), 2);
        assert!(reopened[0]["message"]
            .as_str()
            .unwrap()
            .contains("ref=abcdef012345"));
        for pane in 0..205 {
            failure.pane_id = Some(pane);
            failure.reference = format!("{pane:012x}");
            record_at(&path, "Terminal worker", &failure).unwrap();
        }
        assert_eq!(read(&path).unwrap().len(), CAPACITY);
    }
    #[test]
    fn switchboard_terminal_failure_rejects_contents_in_diagnostic_fields() {
        let mut failure = serde_json::to_value(sample()).unwrap();
        failure["typed_text"] = json!("private prompt");
        assert!(serde_json::from_value::<Failure>(failure).is_err());
        for field in ["code", "operation", "worker_build", "reference"] {
            let mut failure = serde_json::to_value(sample()).unwrap();
            failure[field] = json!("private prompt");
            assert!(!serde_json::from_value::<Failure>(failure).unwrap().valid());
        }
    }
}
