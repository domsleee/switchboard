//! Recent Switchboard failures, reviewable from Settings instead of zellij.log.
//! Saved beside the relay config so failures before an update stay visible.
use super::*;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock,
    },
};

const CAPACITY: usize = 200;
const SAMPLE_SLOTS: usize = 50;
static LOG: Log = Log(
    std::sync::Mutex::new(VecDeque::new()),
    AtomicBool::new(false),
);

struct Log(std::sync::Mutex<VecDeque<Value>>, AtomicBool);

/// Browser and terminal timing reports are samples rather than failures.
fn diagnostic(message: &str) -> bool {
    message.starts_with("Terminal ") && !message.starts_with("Terminal failure ")
        || message.starts_with("Browser tab ")
        || message.starts_with("Conversation shown ")
        || message.starts_with("Relay runtime slow ")
        || browser_load_sample(message)
}

/// Each carries its own elapsed time, so every one would be a new, permanent failure.
fn browser_load_sample(message: &str) -> bool {
    message.starts_with("History ")
        && (message.contains(": recovered;") || message.contains(": partial;"))
}

/// Short, content-free computer id accepted from browser timing reports.
fn diagnostic_host(host: Option<&str>) -> Result<Option<&str>, ()> {
    match host {
        None => Ok(None),
        Some(host)
            if !host.is_empty()
                && host.len() <= 80
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            Ok(Some(&host[..host.len().min(13)]))
        },
        Some(_) => Err(()),
    }
}

/// Eviction order: routine samples, then slow samples, then failures.
fn rank(message: &str) -> u8 {
    if !diagnostic(message) {
        2
    } else if message.contains(" slow ") || message.starts_with("Terminal resize ") {
        1
    } else {
        0
    }
}

/// Index to drop from an oversized log ordered oldest first. Failures past their
/// share go first, because an unreachable peer can otherwise fill the log and
/// discard every timing sample the moment it arrives.
fn eviction(entries: &[Value]) -> usize {
    let rank_of = |e: &Value| rank(e["message"].as_str().unwrap_or(""));
    let failures = entries.iter().filter(|e| rank_of(e) == 2).count();
    let lowest = if failures > CAPACITY - SAMPLE_SLOTS {
        2
    } else {
        0
    };
    entries
        .iter()
        .enumerate()
        .filter(|(_, e)| rank_of(e) >= lowest)
        .min_by_key(|(i, e)| (rank_of(e), *i))
        .map_or(0, |(i, _)| i)
}

impl Log {
    /// Returns true when the entry is new rather than a repeat of a known failure.
    fn push(&self, source: &str, message: &str, time: u64) -> bool {
        let message = redact(message);
        let mut entries = self.0.lock().unwrap();
        // Pollers fail every few seconds; one counted entry keeps older failures visible.
        let count = entries
            .iter()
            .position(|e| e["source"] == source && e["message"] == message.as_str())
            .and_then(|i| entries.remove(i))
            .map_or(1, |e| e["count"].as_u64().unwrap_or(1) + 1);
        entries.push_back(json!({"time":time,"source":source,"message":message,"count":count}));
        // Routine samples give way first, then slow ones, so a busy terminal
        // pushes out neither failures nor the slow moments worth investigating.
        while entries.len() > CAPACITY {
            let evicted = eviction(entries.make_contiguous());
            entries.remove(evicted);
        }
        self.1.store(true, Ordering::Relaxed);
        count == 1
    }
    fn load(&self, bytes: &[u8]) {
        let Ok(Value::Array(saved)) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        let mut entries = self.0.lock().unwrap();
        for entry in saved.into_iter().rev().take(CAPACITY).rev() {
            if let (Some(source), Some(message), Some(time)) = (
                entry["source"].as_str(),
                entry["message"].as_str(),
                entry["time"].as_u64(),
            ) {
                let count = entry["count"].as_u64().unwrap_or(1).max(1);
                entries.push_back(
                    json!({"time":time,"source":source,"message":redact(message),"count":count}),
                );
            }
        }
    }
    fn saved(&self) -> Option<Vec<u8>> {
        self.1
            .swap(false, Ordering::Relaxed)
            .then(|| serde_json::to_vec(&*self.0.lock().unwrap()).unwrap())
    }
    fn newest_first(&self) -> Vec<Value> {
        self.0.lock().unwrap().iter().rev().cloned().collect()
    }
}

/// Bounded first line with credential-looking values removed.
fn redact(message: &str) -> String {
    static SECRET: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r"((?i-u:bearer)\s+|(?i-u:token|cookie|secret|password|key|auth[a-z_]*)[\w-]*\s*[=:]\s*)[^;,&]+",
        )
        .unwrap()
    });
    let line = message.lines().next().unwrap_or("");
    SECRET
        .replace_all(line, "${1}[redacted]")
        .chars()
        .take(240)
        .collect()
}

/// Warn in zellij.log once and keep the failure for the Logs view.
pub(super) fn record(source: &str, message: &str) {
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    if LOG.push(source, message, time) && !diagnostic(message) {
        log::warn!("Switchboard {source}: {}", redact(message));
    }
}

/// Write `data` readable only by this user, replacing `path` atomically.
pub(super) async fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let path = path.to_owned();
    let data = data.to_vec();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        std::fs::create_dir_all(parent)?;
        // NamedTempFile creates a unique file with mode 0600 on Unix, before any
        // secrets are written. Never reuse a predictable, possibly public .tmp.
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&data)?;
        temp.persist(&path).map_err(|error| error.error)?;
        Ok(())
    })
    .await
    .map_err(std::io::Error::other)?
}

fn runtime_late_bucket(late: Duration) -> Option<&'static str> {
    [
        (2000, "Relay runtime slow late=2000ms+"),
        (1000, "Relay runtime slow late=1000ms+"),
        (500, "Relay runtime slow late=500ms+"),
        (250, "Relay runtime slow late=250ms+"),
    ]
    .into_iter()
    .find_map(|(ms, message)| (late.as_millis() >= ms).then_some(message))
}

/// Records when a short timer fires late, the sign of a starved or blocked relay.
pub(super) fn watch_runtime() {
    const TICK: Duration = Duration::from_millis(100);
    tokio::spawn(async {
        loop {
            let started = tokio::time::Instant::now();
            tokio::time::sleep(TICK).await;
            if let Some(message) = runtime_late_bucket(started.elapsed().saturating_sub(TICK)) {
                record("relay", message);
            }
        }
    });
}

/// Restore saved failures, then save changes every few seconds.
pub(super) async fn start(file: PathBuf) -> tokio::task::JoinHandle<()> {
    if let Ok(bytes) = tokio::fs::read(&file).await {
        LOG.load(&bytes);
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            save(&file).await;
        }
    })
}

/// Save unsaved failures now, e.g. as an update stops the relay.
pub(super) async fn save(file: &Path) {
    if let Some(data) = LOG.saved() {
        let _ = write_private(file, &data).await;
    }
}

/// Gateway reply for paired peers reviewing this computer's failures.
pub(super) fn local() -> Value {
    let mut entries = LOG.newest_first();
    entries.extend(crate::terminal_failures::entries());
    json!({"entries": recent_entries(entries)})
}

fn recent_entries(mut entries: Vec<Value>) -> Vec<Value> {
    // Keep the peer reply bounded without allowing newer performance samples to
    // displace durable fatal reports from the independently bounded worker store.
    entries.sort_by_key(|e| e["time"].as_u64().unwrap_or(0));
    while entries.len() > CAPACITY {
        entries.remove(eviction(&entries));
    }
    entries.reverse();
    entries
}

async fn peer(host: &Host) -> Value {
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        host.request(
            Method::GET,
            "/switchboard/logs",
            Bytes::new(),
            "application/json",
        ),
    )
    .await;
    let error = match result {
        Ok(Ok(response)) if response.status == StatusCode::OK => {
            match serde_json::from_slice::<Value>(&response.body) {
                Ok(Value::Object(mut body)) if body.get("entries").is_some_and(Value::is_array) => {
                    let mut entries = body.remove("entries").unwrap();
                    entries.as_array_mut().unwrap().truncate(CAPACITY);
                    return json!({"name":host.config.name,"entries":entries});
                },
                _ => "Logs unavailable on this computer's version",
            }
        },
        Ok(Ok(response)) if response.status == StatusCode::NOT_FOUND => {
            "Logs unavailable on this computer's version"
        },
        Ok(_) => "Logs unavailable",
        Err(_) => "Computer did not respond",
    };
    json!({"name":host.config.name,"error":error})
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
    let mut computers = vec![json!({"name":name,"local":true,"entries":local()["entries"]})];
    computers.extend(futures_util::future::join_all(peers.iter().map(|h| peer(h))).await);
    Json(json!({ "computers": computers }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SwitchDiagnostic {
    host: String,
    focus_id: u32,
    pane_id: u32,
    is_plugin: bool,
    expected_render: bool,
    outcome: String,
    elapsed_ms: u32,
    ack_ms: Option<u32>,
    first_frame_ms: Option<u32>,
    first_parse_ms: Option<u32>,
    last_frame_ms: Option<u32>,
    last_parse_ms: Option<u32>,
    frames: u32,
    bytes: u64,
    writes_pending: u32,
    max_parse_lag_ms: u32,
    physical_cols: u16,
    physical_rows: u16,
    native_cols: u16,
    native_rows: u16,
    viewport_claims: u32,
    terminal_resizes: u32,
    #[serde(default)]
    control_tracking: bool,
    #[serde(default)]
    focus_commands: u32,
    #[serde(default)]
    terminal_metrics: u32,
    #[serde(default)]
    cell_size_changes: u32,
    #[serde(default)]
    first_cell_width_px: u16,
    #[serde(default)]
    first_cell_height_px: u16,
    #[serde(default)]
    last_cell_width_px: u16,
    #[serde(default)]
    last_cell_height_px: u16,
    #[serde(default)]
    min_cell_width_px: u16,
    #[serde(default)]
    min_cell_height_px: u16,
    #[serde(default)]
    max_cell_width_px: u16,
    #[serde(default)]
    max_cell_height_px: u16,
    #[serde(default)]
    scroll_height_px: u32,
    #[serde(default)]
    client_height_px: u32,
    #[serde(default)]
    scroll_top_px: u32,
    #[serde(default)]
    xterm_rows: u16,
    #[serde(default)]
    buffer_rows: u32,
    #[serde(default)]
    render_tracking: bool,
    #[serde(default)]
    first_render_ms: Option<u32>,
    #[serde(default)]
    last_render_ms: Option<u32>,
    #[serde(default)]
    render_events: u32,
    #[serde(default)]
    max_render_lag_ms: u32,
    #[serde(default)]
    render_pending: bool,
    #[serde(default)]
    first_animation_ms: Option<u32>,
    #[serde(default)]
    last_animation_ms: Option<u32>,
    #[serde(default)]
    max_animation_lag_ms: u32,
    #[serde(default)]
    animation_pending: bool,
    #[serde(default)]
    first_quiet_ms: Option<u32>,
    #[serde(default)]
    late_frames: u32,
    #[serde(default)]
    hidden_at_start: bool,
    #[serde(default)]
    document_hidden: bool,
    #[serde(default)]
    browser_focused: bool,
    #[serde(default)]
    viewport_size_changes: u32,
    #[serde(default)]
    first_native_cols: u16,
    #[serde(default)]
    first_native_rows: u16,
    #[serde(default)]
    min_native_cols: u16,
    #[serde(default)]
    min_native_rows: u16,
    #[serde(default)]
    max_native_cols: u16,
    #[serde(default)]
    max_native_rows: u16,
    #[serde(default)]
    first_owner_active: Option<bool>,
    #[serde(default)]
    first_is_owner: Option<bool>,
    #[serde(default)]
    xterm_cols: u16,
    #[serde(default)]
    buffer_scroll_events: u32,
    #[serde(default)]
    line_feed_events: u32,
    #[serde(default)]
    wheel_events: u32,
    #[serde(default)]
    wheel_reports: u32,
    #[serde(default)]
    wheel_delta_mode: u8,
    #[serde(default)]
    max_wheel_delta: u32,
    #[serde(default)]
    xterm_size_changes: u32,
    #[serde(default)]
    first_xterm_cols: u16,
    #[serde(default)]
    first_xterm_rows: u16,
    #[serde(default)]
    min_xterm_cols: u16,
    #[serde(default)]
    min_xterm_rows: u16,
    #[serde(default)]
    max_xterm_cols: u16,
    #[serde(default)]
    max_xterm_rows: u16,
    #[serde(default)]
    clipped_bottom_rows: u16,
    #[serde(default)]
    max_clipped_bottom_rows: u16,
}

impl SwitchDiagnostic {
    fn message(&self) -> Option<String> {
        if !matches!(
            self.outcome.as_str(),
            "settled" | "sampled" | "timeout" | "superseded" | "disconnected"
        ) || self.elapsed_ms > 86_400_000
            || self.max_parse_lag_ms > 86_400_000
            || self.max_render_lag_ms > 86_400_000
            || self.max_animation_lag_ms > 86_400_000
            || [
                self.ack_ms,
                self.first_frame_ms,
                self.first_parse_ms,
                self.last_frame_ms,
                self.last_parse_ms,
                self.first_render_ms,
                self.last_render_ms,
                self.first_animation_ms,
                self.last_animation_ms,
                self.first_quiet_ms,
            ]
            .into_iter()
            .flatten()
            .any(|t| t > 86_400_000)
        {
            return None;
        }
        // Quiet settling time and a continuously printing TUI are not latency.
        let slow = self.ack_ms.is_some_and(|t| t > 500)
            || self.first_parse_ms.is_some_and(|t| t > 500)
            || self.max_parse_lag_ms > 500
            || self.first_render_ms.is_some_and(|t| t > 500)
            || self.first_animation_ms.is_some_and(|t| t > 500)
            || self.max_render_lag_ms > 500
            || self.max_animation_lag_ms > 500
            || (self.elapsed_ms > 500
                && (self.ack_ms.is_none()
                    || self.writes_pending > 0
                    || self.expected_render && self.first_parse_ms.is_none()
                    || self.render_tracking
                        && self.expected_render
                        && self.first_render_ms.is_none()));
        let oversized = self.client_height_px > 0
            && u64::from(self.scroll_height_px) > u64::from(self.client_height_px) * 8;
        if !slow && !oversized && !self.expected_render {
            return Some(String::new());
        }
        // Render lag alone is not marked: a hidden terminal defers drawing for minutes.
        let noticeable = [
            self.ack_ms,
            self.first_parse_ms,
            self.first_render_ms,
            self.first_animation_ms,
        ]
        .into_iter()
        .flatten()
        .any(|t| t > 500)
            || self.max_animation_lag_ms > 500;
        let timing = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| t.to_string());
        Some(format!(
            "Terminal switch {}{} pane={}{} focus={} t={}ms ack={} frame={}/{} parse={}/{} render={}/{} raf={}/{} lag={}/{}/{}ms frames={} bytes={} queue={} quiet={} late={}",
            if noticeable { "slow " } else { "" }, self.outcome, if self.is_plugin { "plugin:" } else { "" }, self.pane_id, self.focus_id,
            self.elapsed_ms, timing(self.ack_ms), timing(self.first_frame_ms),timing(self.last_frame_ms),timing(self.first_parse_ms),timing(self.last_parse_ms),
            timing(self.first_render_ms),timing(self.last_render_ms),timing(self.first_animation_ms),timing(self.last_animation_ms),
            self.max_parse_lag_ms,self.max_render_lag_ms,self.max_animation_lag_ms,self.frames,self.bytes,self.writes_pending,timing(self.first_quiet_ms),self.late_frames,
        ))
    }

    fn viewport_message(&self) -> String {
        format!(
            "Terminal viewport pane={}{} focus={} resize={} claims={} changes={} native={}x{}->{}x{} range={}x{}..{}x{} scroll={}/{}/{} rows={}/{} view={}x{} hidden={}/{} focused={} render_events={} pending={}/{}",
            if self.is_plugin { "plugin:" } else { "" },self.pane_id,self.focus_id,self.terminal_resizes,
            self.viewport_claims,self.viewport_size_changes,self.first_native_cols,self.first_native_rows,self.native_cols,self.native_rows,
            self.min_native_cols,self.min_native_rows,self.max_native_cols,self.max_native_rows,
            self.scroll_height_px,self.client_height_px,self.scroll_top_px,self.xterm_rows,self.buffer_rows,
            self.physical_cols,self.physical_rows,self.hidden_at_start,self.document_hidden,self.browser_focused,self.render_events,self.render_pending,self.animation_pending,
        )
    }

    /// A tab that changes size on arrival makes its agent redraw: the flicker on tab switches.
    /// Kept with the slow samples so routine reports cannot push it out.
    fn resize_message(&self) -> Option<String> {
        let arrived = (self.first_native_cols, self.first_native_rows);
        let resized = self.viewport_size_changes > 0
            || arrived.0 > 0 && arrived != (self.native_cols, self.native_rows);
        if !resized {
            return None;
        }
        let owner = match (self.first_owner_active, self.first_is_owner) {
            (Some(true), Some(true)) => "this window",
            (Some(true), _) => "another window",
            (Some(false), _) => "none (smallest viewer)",
            (None, _) => "unknown",
        };
        Some(format!(
            "Terminal resize on switch pane={}{} focus={} arrived={}x{} final={}x{} window={}x{} changes={} owner_on_arrival={} claims={} line_feeds={} bytes={}",
            if self.is_plugin { "plugin:" } else { "" }, self.pane_id, self.focus_id,
            arrived.0, arrived.1, self.native_cols, self.native_rows, self.physical_cols, self.physical_rows,
            self.viewport_size_changes, owner, self.viewport_claims, self.line_feed_events, self.bytes,
        ))
    }

    fn control_message(&self) -> String {
        format!(
            "Terminal control pane={}{} focus={} tracked={} focus_commands={} metrics={} cell_px={}x{}->{}x{} range={}x{}..{}x{} changes={}",
            if self.is_plugin { "plugin:" } else { "" }, self.pane_id, self.focus_id,
            self.control_tracking, self.focus_commands, self.terminal_metrics,
            self.first_cell_width_px, self.first_cell_height_px, self.last_cell_width_px, self.last_cell_height_px,
            self.min_cell_width_px, self.min_cell_height_px, self.max_cell_width_px, self.max_cell_height_px, self.cell_size_changes,
        )
    }

    fn scroll_message(&self) -> String {
        format!(
            "Terminal scrolling pane={}{} focus={} buffer_scrolls={} line_feeds={} wheel={} wheel_reports={} wheel_mode={} max_wheel_delta={} xterm={}x{}->{}x{} range={}x{}..{}x{} changes={} native={}x{} clipped_rows={}/{}",
            if self.is_plugin { "plugin:" } else { "" }, self.pane_id, self.focus_id,
            self.buffer_scroll_events, self.line_feed_events, self.wheel_events,
            self.wheel_reports, self.wheel_delta_mode, self.max_wheel_delta,
            self.first_xterm_cols, self.first_xterm_rows,self.xterm_cols, self.xterm_rows,
            self.min_xterm_cols,self.min_xterm_rows,self.max_xterm_cols,self.max_xterm_rows,self.xterm_size_changes,
            self.native_cols, self.native_rows,self.clipped_bottom_rows,self.max_clipped_bottom_rows,
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BrowserDiagnostic {
    id: u32,
    reason: String,
    outcome: String,
    hidden_ms: Option<u64>,
    load_ms: Option<u32>,
    frozen: bool,
    event_delay_ms: Option<u32>,
    first_animation_ms: Option<u32>,
    terminal_animation_ms: Option<u32>,
    terminal_probe: bool,
    terminal_socket: Option<u8>,
    control_socket: Option<u8>,
    writes_pending: Option<u32>,
    render_pending: Option<bool>,
    terminal_message_ms: Option<u32>,
    terminal_frame_ms: Option<u32>,
    terminal_reply_ms: Option<u32>,
    terminal_render_cycle_ms: Option<u32>,
    long_frame_tracking: Option<bool>,
    long_frames: Option<u32>,
    max_frame_ms: Option<u32>,
    max_render_ms: Option<u32>,
    max_layout_ms: Option<u32>,
    max_script_ms: Option<u32>,
    initial_writes_pending: Option<u32>,
    initial_render_pending: Option<bool>,
    terminal_hidden: Option<bool>,
    terminal_active: Option<bool>,
    terminal_long_task_tracking: Option<bool>,
    terminal_long_tasks: Option<u32>,
    terminal_max_long_task_ms: Option<u32>,
    terminal_total_long_task_ms: Option<u32>,
    long_task_tracking: bool,
    long_tasks: u32,
    max_long_task_ms: u32,
    total_long_task_ms: u32,
    elapsed_ms: u32,
}

impl BrowserDiagnostic {
    fn slow(&self) -> bool {
        self.event_delay_ms.is_some_and(|t| t > 500)
            || self.load_ms.is_some_and(|t| t > 500)
            || self.first_animation_ms.is_some_and(|t| t > 500)
            || self.terminal_animation_ms.is_some_and(|t| t > 500)
            || self.max_frame_ms.is_some_and(|t| t > 500)
            || self.terminal_render_cycle_ms.is_some_and(|t| t > 500)
            || self.terminal_max_long_task_ms.is_some_and(|t| t > 500)
            || self.max_long_task_ms > 500
            || self.elapsed_ms > 500
                && (self.first_animation_ms.is_none()
                    || self.terminal_probe && self.terminal_animation_ms.is_none())
    }

    fn message(&self) -> Option<String> {
        if !matches!(
            self.reason.as_str(),
            "visible" | "resumed" | "restored" | "discarded" | "conversation"
        ) || !matches!(self.outcome.as_str(), "sampled" | "hidden" | "superseded")
            || [self.terminal_socket, self.control_socket]
                .into_iter()
                .flatten()
                .any(|s| s > 3)
        {
            return None;
        }
        let timing = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| t.to_string());
        Some(format!(
            "Browser tab {} reason={} {} id={} hidden={}ms load={}ms event={}ms raf={}/{}ms tasks={}/{}/{}ms queue={}/{} ws={}/{} frozen={} observed={}ms",
            if self.slow() { "slow" } else { "resumed" }, self.reason, self.outcome, self.id,
            self.hidden_ms.map_or_else(|| "-".into(), |t| t.to_string()), timing(self.load_ms), timing(self.event_delay_ms),
            timing(self.first_animation_ms), timing(self.terminal_animation_ms),
            if self.long_task_tracking { self.long_tasks.to_string() } else { "-".into() },
            self.max_long_task_ms, self.total_long_task_ms, timing(self.writes_pending),
            self.render_pending.map_or_else(|| "-".into(), |pending| pending.to_string()),
            self.terminal_socket.map_or_else(|| "-".into(), |s| s.to_string()),
            self.control_socket.map_or_else(|| "-".into(), |s| s.to_string()), self.frozen, self.elapsed_ms,
        ))
    }

    fn stages_message(&self) -> Option<String> {
        if self.terminal_message_ms.is_none() && self.initial_writes_pending.is_none() {
            return None;
        }
        let timing = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| t.to_string());
        let flag = |b: Option<bool>| b.map_or_else(|| "-".into(), |b| b.to_string());
        Some(format!(
            "Browser tab {} stages id={} delivery={}ms frame={}ms reply={}ms queue={}/{}->{}/{} hidden={} active={} tasks={}/{}/{}ms",
            if self.slow() { "slow" } else { "resumed" }, self.id,
            timing(self.terminal_message_ms), timing(self.terminal_frame_ms), timing(self.terminal_reply_ms),
            timing(self.initial_writes_pending), flag(self.initial_render_pending), timing(self.writes_pending), flag(self.render_pending),
            flag(self.terminal_hidden), flag(self.terminal_active),
            if self.terminal_long_task_tracking == Some(true) { timing(self.terminal_long_tasks) } else { "-".into() },
            timing(self.terminal_max_long_task_ms), timing(self.terminal_total_long_task_ms),
        ))
    }

    fn rendering_message(&self) -> Option<String> {
        if self.long_frame_tracking.is_none() && self.terminal_render_cycle_ms.is_none() {
            return None;
        }
        let timing = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| t.to_string());
        Some(format!(
            "Browser tab {} render id={} tracked={} frames={} longest={}ms render={}ms layout={}ms scripts={}ms terminal_cycle={}ms",
            if self.slow() { "slow" } else { "resumed" }, self.id,
            self.long_frame_tracking.map_or_else(|| "-".into(), |t| t.to_string()), timing(self.long_frames),
            timing(self.max_frame_ms), timing(self.max_render_ms), timing(self.max_layout_ms),
            timing(self.max_script_ms), timing(self.terminal_render_cycle_ms),
        ))
    }
}

pub(super) async fn browser_resume(request: Request) -> StatusCode {
    let diagnostic: BrowserDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    record("Browser", &message);
    if let Some(stages) = diagnostic.stages_message() {
        record("Browser", &stages);
    }
    if let Some(rendering) = diagnostic.rendering_message() {
        record("Browser", &rendering);
    }
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewTabDiagnostic {
    host: String,
    request_id: u32,
    outcome: String,
    elapsed_ms: u32,
    delivery_ms: u32,
    sent_ms: Option<u32>,
    pane_id: Option<u32>,
    control_socket: Option<u8>,
}

impl NewTabDiagnostic {
    fn message(&self) -> Option<String> {
        if !matches!(
            self.outcome.as_str(),
            "ready" | "timeout" | "disconnected" | "send-failed"
        ) || self.elapsed_ms > 86_400_000
            || self.delivery_ms > self.elapsed_ms
            || self
                .sent_ms
                .is_some_and(|sent| sent < self.delivery_ms || sent > self.elapsed_ms)
            || self.control_socket.is_some_and(|state| state > 3)
            || self.outcome == "ready" && (self.sent_ms.is_none() || self.pane_id.is_none())
        {
            return None;
        }
        let timing = |value: Option<u32>| value.map_or_else(|| "-".into(), |v| v.to_string());
        let outcome = if self.outcome == "ready" && self.elapsed_ms > 500 {
            "slow"
        } else {
            &self.outcome
        };
        Some(format!(
            "Terminal new tab {} request={} pane={} t={}ms delivery={}ms send={}ms control={}",
            outcome,
            self.request_id,
            timing(self.pane_id),
            self.elapsed_ms,
            self.delivery_ms,
            timing(self.sent_ms),
            self.control_socket
                .map_or_else(|| "-".into(), |v| v.to_string()),
        ))
    }
}

/// First load of a terminal page, timed from navigation in the terminal frame.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LoadDiagnostic {
    host: String,
    outcome: String,
    elapsed_ms: u32,
    page_ms: Option<u32>,
    socket_ms: Option<u32>,
    frame_ms: Option<u32>,
    render_ms: Option<u32>,
    visible: bool,
    /// What the viewer was loaded for, when the load is the wait the user saw.
    #[serde(default)]
    after: Option<String>,
}

impl LoadDiagnostic {
    fn message(&self) -> Option<String> {
        if self.outcome != "ready"
            || self
                .after
                .as_deref()
                .is_some_and(|after| after != "conversation")
            || [self.page_ms, self.socket_ms, self.frame_ms, self.render_ms]
                .into_iter()
                .flatten()
                .chain([self.elapsed_ms])
                .any(|t| t > 86_400_000)
        {
            return None;
        }
        let timing = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| t.to_string());
        let outcome = if self.elapsed_ms > 500 {
            "slow"
        } else {
            "ready"
        };
        Some(format!(
            "Terminal load {} t={}ms page={}ms socket={}ms frame={}ms render={}ms visible={}{}",
            outcome,
            self.elapsed_ms,
            timing(self.page_ms),
            timing(self.socket_ms),
            timing(self.frame_ms),
            timing(self.render_ms),
            self.visible,
            self.after
                .as_ref()
                .map_or_else(String::new, |after| format!(" after={after}")),
        ))
    }
}

/// An Instant typing guess the screen never showed. Counts and positions only, never typed text.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PredictDiagnostic {
    host: String,
    outcome: String,
    pane_id: u32,
    is_plugin: bool,
    pending: u16,
    typed: u16,
    confirmed: u16,
    frames: u16,
    age_ms: u32,
    srtt_ms: Option<u32>,
    since_input_ms: Option<u32>,
    since_write_ms: Option<u32>,
    run_row: u16,
    cursor_row: u16,
    cursor_col: u16,
    expected_col: u16,
    cursor_hidden: bool,
}

impl PredictDiagnostic {
    fn message(&self) -> Option<String> {
        if !["timeout", "moved", "screen"].contains(&self.outcome.as_str())
            || [self.srtt_ms, self.since_input_ms, self.since_write_ms]
                .into_iter()
                .flatten()
                .chain([self.age_ms])
                .any(|t| t > 86_400_000)
        {
            return None;
        }
        let ms = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| format!("{t}ms"));
        Some(format!(
            "Terminal typing miss outcome={} pane={}{} pending={} typed={} confirmed={} frames={} age={}ms srtt={} since_input={} since_write={} row={}->{} col={}->{} hidden={}",
            self.outcome,
            if self.is_plugin { "plugin:" } else { "" },
            self.pane_id,
            self.pending,
            self.typed,
            self.confirmed,
            self.frames,
            self.age_ms,
            ms(self.srtt_ms),
            ms(self.since_input_ms),
            ms(self.since_write_ms),
            self.run_row,
            self.cursor_row,
            self.cursor_col,
            self.expected_col,
            self.cursor_hidden,
        ))
    }
}

pub(super) async fn instant_typing(
    State(state): State<RelayState>,
    request: Request,
) -> StatusCode {
    let diagnostic: PredictDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(host) = state.host(&diagnostic.host) else {
        return StatusCode::NOT_FOUND;
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    record(&host.config.name, &message);
    StatusCode::NO_CONTENT
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "kebab-case")]
enum ClipboardOutcome {
    Drag,
    Attempt,
    Success,
    Failed,
    ApiSuccess,
    PermissionDenied,
    ApiFailed,
    Fallback,
    FallbackSuccess,
    Manual,
    CopyKey,
    Osc52,
    Osc52Ignored,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClipboardDiagnostic {
    host: String,
    outcome: ClipboardOutcome,
    chars: u32,
    attempt: u32,
    selection_mode: bool,
    mouse_tracking: bool,
    focused: bool,
    secure: bool,
    clipboard_api: bool,
}

pub(super) async fn clipboard(State(state): State<RelayState>, request: Request) -> StatusCode {
    let d: ClipboardDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(host) = state.host(&d.host) else {
        return StatusCode::NOT_FOUND;
    };
    record(&host.config.name, &format!(
        "Terminal clipboard outcome={:?} attempt={} chars={} selection_mode={} mouse_tracking={} focused={} secure={} clipboard_api={}",
        d.outcome, d.attempt, d.chars, d.selection_mode, d.mouse_tracking, d.focused, d.secure, d.clipboard_api,
    ));
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnterDiagnostic {
    host: String,
    pane_id: u32,
    is_plugin: bool,
    shift: bool,
    ctrl: bool,
    alt: bool,
    meta: bool,
    repeat: bool,
    held_ms: Option<u32>,
    released_ms: Option<u32>,
}

async fn diagnostic_body<T: serde::de::DeserializeOwned>(
    request: Request,
) -> Result<T, StatusCode> {
    let body = to_bytes(request.into_body(), 8192)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)?;
    serde_json::from_slice(&body).map_err(|_| StatusCode::BAD_REQUEST)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalFailureDiagnostic {
    host: String,
    failure: crate::terminal_failures::Failure,
}

pub(super) async fn terminal_failure(
    State(state): State<RelayState>,
    request: Request,
) -> StatusCode {
    let report: TerminalFailureDiagnostic = match diagnostic_body(request).await {
        Ok(report) => report,
        Err(status) => return status,
    };
    let Some(host) = state.host(&report.host) else {
        return StatusCode::NOT_FOUND;
    };
    if !report.failure.valid() {
        return StatusCode::BAD_REQUEST;
    }
    let source = host.config.name.clone();
    match tokio::task::spawn_blocking(move || {
        crate::terminal_failures::record_at(
            &crate::terminal_failures::path()?,
            &source,
            &report.failure,
        )
    })
    .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub(super) async fn terminal_switch(
    State(state): State<RelayState>,
    request: Request,
) -> StatusCode {
    let diagnostic: SwitchDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(host) = state.host(&diagnostic.host) else {
        return StatusCode::NOT_FOUND;
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    if let Some(resize) = diagnostic.resize_message() {
        record(&host.config.name, &resize);
    }
    if !message.is_empty() {
        record(&host.config.name, &message);
        record(&host.config.name, &diagnostic.viewport_message());
        record(&host.config.name, &diagnostic.scroll_message());
        record(&host.config.name, &diagnostic.control_message());
    }
    StatusCode::NO_CONTENT
}

pub(super) async fn new_tab(State(state): State<RelayState>, request: Request) -> StatusCode {
    let diagnostic: NewTabDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(host) = state.host(&diagnostic.host) else {
        return StatusCode::NOT_FOUND;
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    record(&host.config.name, &message);
    StatusCode::NO_CONTENT
}

pub(super) async fn terminal_load(State(state): State<RelayState>, request: Request) -> StatusCode {
    let diagnostic: LoadDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(host) = state.host(&diagnostic.host) else {
        return StatusCode::NOT_FOUND;
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    record(&host.config.name, &message);
    StatusCode::NO_CONTENT
}

pub(super) async fn modified_enter(
    State(state): State<RelayState>,
    request: Request,
) -> StatusCode {
    let diagnostic: EnterDiagnostic = match diagnostic_body(request).await {
        Ok(d) => d,
        Err(status) => return status,
    };
    let Some(host) = state.host(&diagnostic.host) else {
        return StatusCode::NOT_FOUND;
    };
    if !diagnostic.shift
        || [diagnostic.held_ms, diagnostic.released_ms]
            .into_iter()
            .flatten()
            .any(|t| t > 86_400_000)
    {
        return StatusCode::BAD_REQUEST;
    }
    record(&host.config.name, &format!(
        "Browser Shift+Enter pane={}{} shift={} ctrl={} alt={} meta={} repeat={} held_ms={:?} released_ms={:?}",
        if diagnostic.is_plugin { "plugin:" } else { "" }, diagnostic.pane_id,
        diagnostic.shift, diagnostic.ctrl, diagnostic.alt, diagnostic.meta, diagnostic.repeat,
        diagnostic.held_ms, diagnostic.released_ms,
    ));
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn switchboard_terminal_failure_survives_newer_timing_samples_in_bounded_peer_logs() {
        let mut entries: Vec<_> = (1..=200)
            .map(|time| json!({"time":time,"message":"Terminal transport sample"}))
            .collect();
        entries.push(
            json!({"time":0,"message":"Terminal failure focus_unconfirmed ref=0123456789ab"}),
        );
        let entries = recent_entries(entries);
        assert_eq!(entries.len(), CAPACITY);
        assert!(entries
            .iter()
            .any(|e| e["message"].as_str().unwrap().contains("ref=0123456789ab")));
        assert_eq!(entries[0]["time"], 200);
    }

    const SLOW_LOAD: &str = "Conversation shown slow t=2400ms paint=20ms end=history";

    #[test]
    fn switchboard_timing_sample_survives_a_log_full_of_failures() {
        let log = Log(Default::default(), Default::default());
        for i in 0..CAPACITY {
            log.push("windows", &format!("failure {i}"), i as u64);
        }
        log.push("Conversation", SLOW_LOAD, 1000);
        for i in 0..CAPACITY {
            log.push("windows", &format!("later failure {i}"), 2000 + i as u64);
        }
        let entries = log.newest_first();
        assert_eq!(entries.len(), CAPACITY);
        assert!(entries.iter().any(|e| e["message"] == SLOW_LOAD));
    }

    #[test]
    fn switchboard_timing_samples_leave_failures_most_of_the_log() {
        let log = Log(Default::default(), Default::default());
        for i in 0..CAPACITY {
            log.push("windows", &format!("failure {i}"), i as u64);
        }
        for i in 0..CAPACITY {
            let sample = format!("Conversation shown slow t={i}ms paint=20ms end=history");
            log.push("Conversation", &sample, 1000 + i as u64);
        }
        let entries = log.newest_first();
        let failures = entries
            .iter()
            .filter(|e| e["source"] == "windows")
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), CAPACITY);
        assert_eq!(failures.len(), CAPACITY - SAMPLE_SLOTS);
        assert_eq!(failures[0]["message"], format!("failure {}", CAPACITY - 1));
    }

    #[test]
    fn switchboard_timing_sample_survives_bounded_peer_log_full_of_failures() {
        let mut entries: Vec<_> = (1..=CAPACITY as u64 * 2)
            .map(|time| json!({"time":time,"message":format!("Terminal failure ref={time}")}))
            .collect();
        entries.push(json!({"time":100,"message":SLOW_LOAD}));
        let entries = recent_entries(entries);
        assert_eq!(entries.len(), CAPACITY);
        assert!(entries.iter().any(|e| e["message"] == SLOW_LOAD));
        assert_eq!(entries[0]["time"], CAPACITY as u64 * 2);
    }
    #[tokio::test]
    async fn switchboard_terminal_failure_requires_known_host_origin_and_content_free_metadata() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![super::super::tests::config("http://127.0.0.1:8082")],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        let report = json!({"host":"mac","failure":{"reference":"0123456789ab","code":"focus_unconfirmed","session":"fixture",
            "pane_id":7,"is_plugin":false,"operation":"focus","elapsed_ms":20,"focus_confirmed":false,"query_received":true,
            "worker_build":"abcdef01","engine_build":null,"pending_records":null}});
        let request = |body: Value, origin: &str| {
            hyper::Request::post("/api/diagnostics/terminal-failure")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        assert_eq!(
            app.clone()
                .oneshot(request(report.clone(), "https://attacker.example"))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let mut unknown = report.clone();
        unknown["host"] = json!("unpaired");
        assert_eq!(
            app.clone()
                .oneshot(request(unknown, "http://127.0.0.1:8090"))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        for field in ["message", "typed_text", "terminal_contents"] {
            let mut private = report.clone();
            private["failure"][field] = json!("private prompt");
            assert_eq!(
                app.clone()
                    .oneshot(request(private, "http://127.0.0.1:8090"))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert!(!diagnostic(
            "Terminal failure focus_unconfirmed ref=0123456789ab"
        ));
    }

    #[tokio::test]
    async fn switchboard_private_writes_do_not_reuse_preexisting_temporary_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("push.json");
        let stale = dir.path().join("push.json.tmp");
        std::fs::write(&stale, b"unrelated public file").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_private(&path, b"private push keys").await.unwrap();
        write_private(&path, b"replacement private keys")
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement private keys");
        assert_eq!(std::fs::read(&stale).unwrap(), b"unrelated public file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn clipboard_diagnostics_reject_contents_and_arbitrary_errors() {
        let sample = json!({"host":"mac", "outcome":"drag", "chars":0, "attempt":0,
            "selection_mode":false, "mouse_tracking":true, "focused":true,
            "secure":true, "clipboard_api":true});
        assert!(serde_json::from_value::<ClipboardDiagnostic>(sample.clone()).is_ok());
        let mut contents = sample.clone();
        contents["text"] = json!("clipboard contents");
        assert!(serde_json::from_value::<ClipboardDiagnostic>(contents).is_err());
        let mut error = sample;
        error["outcome"] = json!("arbitrary error text");
        assert!(serde_json::from_value::<ClipboardDiagnostic>(error).is_err());
    }

    #[test]
    fn failures_survive_a_restart_and_samples_never_push_them_out() {
        let log = Log(
            std::sync::Mutex::new(VecDeque::new()),
            AtomicBool::new(false),
        );
        log.push("Windows", "Host is down", 1);
        log.push("Windows", "Host is down", 2);
        log.push("AP", "Inviter rejected token=abc", 3);
        log.push("Mac", "Terminal switch slow settled t=1400ms", 4);
        for time in 0..CAPACITY as u64 * 2 {
            log.push(
                "Mac",
                &format!("Terminal transport frames={time}"),
                10 + time,
            );
        }
        let entries = log.newest_first();
        assert_eq!(entries.len(), CAPACITY);
        let failure = |e: &&Value| !e["message"].as_str().unwrap().starts_with("Terminal ");
        assert_eq!(entries.iter().filter(failure).count(), 2);
        assert!(entries
            .iter()
            .any(|e| e["message"] == "Terminal switch slow settled t=1400ms"));
        let saved = log.saved().expect("changes are pending");
        assert!(log.saved().is_none(), "saved once until the next change");
        let restarted = Log(
            std::sync::Mutex::new(VecDeque::new()),
            AtomicBool::new(false),
        );
        restarted.load(&saved);
        assert_eq!(restarted.newest_first(), entries);
        let down = entries
            .iter()
            .find(|e| e["message"] == "Host is down")
            .unwrap();
        assert_eq!(down["count"], 2);
        let rejected = entries.iter().find(|e| e["source"] == "AP").unwrap();
        assert_eq!(rejected["message"], "Inviter rejected token=[redacted]");
        assert!(restarted.saved().is_none(), "loading is not a change");
        restarted.load(b"not json");
        assert_eq!(restarted.newest_first().len(), CAPACITY);
    }

    fn switch_sample() -> Value {
        json!({"host":"mac","focus_id":17,"pane_id":30,"is_plugin":false,"expected_render":true,
            "outcome":"settled","elapsed_ms":900,"ack_ms":15,"first_frame_ms":20,"first_parse_ms":750,
            "last_frame_ms":20,"last_parse_ms":750,"frames":1,"bytes":120000,"writes_pending":0,
            "max_parse_lag_ms":730,"physical_cols":120,"physical_rows":40,"native_cols":120,"native_rows":40,
            "viewport_claims":2,"terminal_resizes":3})
    }

    #[tokio::test]
    async fn new_tab_diagnostics_report_connection_wait_and_reject_untrusted_metadata() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![super::super::tests::config("http://127.0.0.1:8082")],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        let sample = json!({"host":"mac","request_id":7,"outcome":"ready",
            "elapsed_ms":1800,"delivery_ms":2,"sent_ms":700,"pane_id":9,"control_socket":1});
        let diagnostic: NewTabDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert_eq!(
            diagnostic.message().unwrap(),
            "Terminal new tab slow request=7 pane=9 t=1800ms delivery=2ms send=700ms control=1"
        );
        let request = |body: &Value, origin: &str| {
            hyper::Request::post("/api/diagnostics/new-tab")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        for (origin, expected) in [
            ("https://attacker.example", StatusCode::FORBIDDEN),
            ("http://127.0.0.1:8090", StatusCode::NO_CONTENT),
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(request(&sample, origin))
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
        for (field, value, expected) in [
            ("host", json!("unknown"), StatusCode::NOT_FOUND),
            ("contents", json!("private screen"), StatusCode::BAD_REQUEST),
            ("elapsed_ms", json!(86_400_001), StatusCode::BAD_REQUEST),
            ("delivery_ms", json!(1801), StatusCode::BAD_REQUEST),
            ("sent_ms", json!(1), StatusCode::BAD_REQUEST),
            ("sent_ms", json!(1801), StatusCode::BAD_REQUEST),
            ("sent_ms", Value::Null, StatusCode::BAD_REQUEST),
            ("pane_id", Value::Null, StatusCode::BAD_REQUEST),
            ("control_socket", json!(4), StatusCode::BAD_REQUEST),
            ("outcome", json!("private title"), StatusCode::BAD_REQUEST),
        ] {
            let mut invalid = sample.clone();
            invalid[field] = value;
            assert_eq!(
                app.clone()
                    .oneshot(request(&invalid, "http://127.0.0.1:8090"))
                    .await
                    .unwrap()
                    .status(),
                expected,
                "{field}"
            );
        }
        for outcome in ["timeout", "disconnected", "send-failed"] {
            let mut failed = sample.clone();
            failed["outcome"] = json!(outcome);
            failed["sent_ms"] = Value::Null;
            failed["pane_id"] = Value::Null;
            assert!(serde_json::from_value::<NewTabDiagnostic>(failed)
                .unwrap()
                .message()
                .unwrap()
                .starts_with(&format!("Terminal new tab {outcome} ")));
        }
    }

    #[test]
    fn switch_diagnostics_distinguish_parser_latency_from_settle_time_and_reject_contents() {
        let mut sample = switch_sample();
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        let message = diagnostic.message().unwrap();
        assert!(message.contains("pane=30"));
        assert!(message.contains("ack=15"));
        assert!(message.contains("lag=730/0/0ms"));
        assert!(diagnostic.viewport_message().contains("resize=3"));
        sample["first_parse_ms"] = json!(400);
        sample["max_parse_lag_ms"] = json!(380);
        sample["expected_render"] = json!(false);
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert_eq!(diagnostic.message(), Some(String::new()));
        sample["scroll_height_px"] = json!(180000);
        sample["client_height_px"] = json!(800);
        sample["xterm_rows"] = json!(10000);
        sample["buffer_rows"] = json!(10000);
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert!(!diagnostic.message().unwrap().is_empty());
        assert!(diagnostic.viewport_message().contains("scroll=180000/800"));
        sample["outcome"] = json!("token=private terminal output");
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert_eq!(diagnostic.message(), None);
        sample["contents"] = json!("private terminal output");
        assert!(serde_json::from_value::<SwitchDiagnostic>(sample).is_err());
    }

    #[test]
    fn noticeable_switch_and_load_delays_are_marked_slow() {
        let mut sample = switch_sample();
        assert!(serde_json::from_value::<SwitchDiagnostic>(sample.clone())
            .unwrap()
            .message()
            .unwrap()
            .starts_with("Terminal switch slow settled "));
        sample["first_parse_ms"] = json!(40);
        sample["max_parse_lag_ms"] = json!(20);
        sample["max_render_lag_ms"] = json!(216270);
        assert!(serde_json::from_value::<SwitchDiagnostic>(sample.clone())
            .unwrap()
            .message()
            .unwrap()
            .starts_with("Terminal switch settled "));
        sample["max_animation_lag_ms"] = json!(1470);
        assert!(serde_json::from_value::<SwitchDiagnostic>(sample)
            .unwrap()
            .message()
            .unwrap()
            .starts_with("Terminal switch slow settled "));
        let load = |elapsed: u32| {
            serde_json::from_value::<LoadDiagnostic>(
                json!({"host":"mac","outcome":"ready","elapsed_ms":elapsed,
                "page_ms":90,"socket_ms":150,"frame_ms":200,"render_ms":elapsed,"visible":true}),
            )
            .unwrap()
            .message()
            .unwrap()
        };
        assert_eq!(load(240), "Terminal load ready t=240ms page=90ms socket=150ms frame=200ms render=240ms visible=true");
        assert!(load(1800).starts_with("Terminal load slow t=1800ms "));
        let after = |after: &str| {
            serde_json::from_value::<LoadDiagnostic>(
                json!({"host":"mac","outcome":"ready","elapsed_ms":900,"visible":true,"after":after}),
            )
            .unwrap()
            .message()
        };
        assert!(after("conversation")
            .unwrap()
            .ends_with("visible=true after=conversation"));
        assert_eq!(after("token=x"), None);
        let bad = json!({"host":"mac","outcome":"token=x","elapsed_ms":1,"visible":true});
        assert_eq!(
            serde_json::from_value::<LoadDiagnostic>(bad)
                .unwrap()
                .message(),
            None
        );
        let contents =
            json!({"host":"mac","outcome":"ready","elapsed_ms":1,"visible":true,"contents":"x"});
        assert!(serde_json::from_value::<LoadDiagnostic>(contents).is_err());
    }

    #[test]
    fn switch_diagnostics_keep_numeric_focus_and_cell_metrics_with_old_client_defaults() {
        let mut sample = switch_sample();
        let older: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert!(!older.control_tracking);
        assert!(older.control_message().contains("tracked=false"));
        assert!(older
            .control_message()
            .contains("focus_commands=0 metrics=0 cell_px=0x0->0x0"));
        sample["control_tracking"] = json!(true);
        let empty: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert!(empty
            .control_message()
            .contains("tracked=true focus_commands=0 metrics=0"));
        for (field, value) in [
            ("focus_commands", 2),
            ("terminal_metrics", 5),
            ("cell_size_changes", 3),
            ("first_cell_width_px", 9),
            ("first_cell_height_px", 18),
            ("last_cell_width_px", 9),
            ("last_cell_height_px", 18),
            ("min_cell_width_px", 8),
            ("min_cell_height_px", 16),
            ("max_cell_width_px", 10),
            ("max_cell_height_px", 20),
        ] {
            sample[field] = json!(value);
        }
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        let message = diagnostic.control_message();
        assert!(message
            .contains("focus_commands=2 metrics=5 cell_px=9x18->9x18 range=8x16..10x20 changes=3"));
        assert_eq!(message, redact(&message));
        for value in [json!("private prompt"), json!(-1), json!(65536), json!(1.5)] {
            sample["first_cell_width_px"] = value;
            assert!(serde_json::from_value::<SwitchDiagnostic>(sample.clone()).is_err());
        }
    }

    #[test]
    fn switch_diagnostics_preserve_later_replay_and_render_timings() {
        let mut sample = switch_sample();
        sample["elapsed_ms"] = json!(10015);
        sample["first_parse_ms"] = json!(21);
        sample["max_parse_lag_ms"] = json!(1);
        sample["last_frame_ms"] = json!(4200);
        sample["last_parse_ms"] = json!(4201);
        sample["first_render_ms"] = json!(820);
        sample["last_render_ms"] = json!(4210);
        sample["first_animation_ms"] = json!(836);
        sample["last_animation_ms"] = json!(4226);
        sample["max_render_lag_ms"] = json!(799);
        sample["max_animation_lag_ms"] = json!(16);
        sample["first_quiet_ms"] = json!(986);
        sample["late_frames"] = json!(8);
        sample["viewport_size_changes"] = json!(2);
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        let message = diagnostic.message().unwrap();
        assert!(message.contains("frame=20/4200"));
        assert!(message.contains("render=820/4210"));
        assert!(message.contains("raf=836/4226"));
        assert!(message.contains("late=8"));
        assert_eq!(message, redact(&message));
        assert!(diagnostic.viewport_message().contains("changes=2"));
        sample["max_animation_lag_ms"] = json!(86_400_001);
        assert!(serde_json::from_value::<SwitchDiagnostic>(sample)
            .unwrap()
            .message()
            .is_none());
    }

    #[test]
    fn switch_resize_reports_the_size_on_arrival_and_outlasts_routine_samples() {
        let mut sample = switch_sample();
        let unchanged: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert!(unchanged.resize_message().is_none());
        sample["first_native_cols"] = json!(100);
        sample["first_native_rows"] = json!(30);
        sample["viewport_size_changes"] = json!(1);
        sample["first_owner_active"] = json!(false);
        sample["first_is_owner"] = json!(false);
        sample["line_feed_events"] = json!(420);
        let message = serde_json::from_value::<SwitchDiagnostic>(sample.clone())
            .unwrap()
            .resize_message()
            .unwrap();
        assert_eq!(
            message,
            "Terminal resize on switch pane=30 focus=17 arrived=100x30 final=120x40 window=120x40 changes=1 owner_on_arrival=none (smallest viewer) claims=2 line_feeds=420 bytes=120000"
        );
        assert_eq!(message, redact(&message));
        sample["first_owner_active"] = json!(true);
        assert!(serde_json::from_value::<SwitchDiagnostic>(sample)
            .unwrap()
            .resize_message()
            .unwrap()
            .contains("owner_on_arrival=another window"));
        assert_eq!(rank(&message), rank("Terminal switch slow settled"));
        assert!(rank(&message) > rank("Terminal viewport pane=30"));
    }

    #[test]
    fn switch_diagnostics_preserve_scrolling_and_transient_terminal_sizes() {
        let mut sample = switch_sample();
        // Old clients omit these fields and remain valid.
        let old: SwitchDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert!(old
            .scroll_message()
            .contains("buffer_scrolls=0 line_feeds=0 wheel=0"));
        sample["buffer_scroll_events"] = json!(17);
        sample["line_feed_events"] = json!(0);
        sample["wheel_events"] = json!(3);
        sample["wheel_reports"] = json!(5);
        sample["wheel_delta_mode"] = json!(0);
        sample["max_wheel_delta"] = json!(120);
        sample["first_xterm_cols"] = json!(80);
        sample["first_xterm_rows"] = json!(40);
        sample["xterm_cols"] = json!(120);
        sample["xterm_rows"] = json!(40);
        sample["min_xterm_cols"] = json!(80);
        sample["min_xterm_rows"] = json!(40);
        sample["max_xterm_cols"] = json!(120);
        sample["max_xterm_rows"] = json!(40);
        sample["xterm_size_changes"] = json!(1);
        sample["clipped_bottom_rows"] = json!(35);
        let diagnostic: SwitchDiagnostic = serde_json::from_value(sample).unwrap();
        let message = diagnostic.scroll_message();
        assert!(message.contains(
            "buffer_scrolls=17 line_feeds=0 wheel=3 wheel_reports=5 wheel_mode=0 max_wheel_delta=120"
        ));
        assert!(message.contains("xterm=80x40->120x40 range=80x40..120x40 changes=1"));
        assert!(message.contains("clipped_rows=35"));
        assert_eq!(message, redact(&message));
    }

    #[test]
    fn instant_typing_misses_accept_only_counts_and_positions() {
        let mut sample = json!({"host":"mac","outcome":"moved","pane_id":30,"is_plugin":false,
            "pending":2,"typed":2,"confirmed":0,"frames":1,"age_ms":40,"srtt_ms":null,"since_input_ms":900,
            "since_write_ms":12,"run_row":26,"cursor_row":28,"cursor_col":2,"expected_col":4,"cursor_hidden":false});
        let diagnostic: PredictDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        let message = diagnostic.message().unwrap();
        assert_eq!(
            message,
            "Terminal typing miss outcome=moved pane=30 pending=2 typed=2 confirmed=0 frames=1 age=40ms srtt=- since_input=900ms since_write=12ms row=26->28 col=2->4 hidden=false"
        );
        assert_eq!(
            redact(&message),
            message,
            "no field looks like a credential"
        );
        let mut longest = sample.clone();
        longest["pane_id"] = json!(u32::MAX);
        for field in ["pending", "typed", "confirmed", "frames"] {
            longest[field] = json!(u16::MAX);
        }
        for field in ["age_ms", "srtt_ms", "since_input_ms", "since_write_ms"] {
            longest[field] = json!(86_400_000);
        }
        for field in ["run_row", "cursor_row", "cursor_col", "expected_col"] {
            longest[field] = json!(u16::MAX);
        }
        longest["outcome"] = json!("timeout");
        longest["is_plugin"] = json!(true);
        let message = serde_json::from_value::<PredictDiagnostic>(longest)
            .unwrap()
            .message()
            .unwrap();
        assert_eq!(
            redact(&message),
            message,
            "the longest miss fits a log line"
        );
        sample["outcome"] = json!("typed hello");
        let diagnostic: PredictDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert!(
            diagnostic.message().is_none(),
            "outcome is one of a few words"
        );
        sample["outcome"] = json!("timeout");
        sample["text"] = json!("private prompt");
        assert!(serde_json::from_value::<PredictDiagnostic>(sample.clone()).is_err());
        sample.as_object_mut().unwrap().remove("text");
        sample["cursor_row"] = json!(-1);
        assert!(serde_json::from_value::<PredictDiagnostic>(sample).is_err());
    }

    #[test]
    fn modified_enter_diagnostics_accept_only_modifier_metadata() {
        let mut sample = json!({"host":"mac","pane_id":30,"is_plugin":false,"shift":true,
            "ctrl":false,"alt":false,"meta":false,"repeat":false,"held_ms":null,"released_ms":10});
        let diagnostic: EnterDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        assert_eq!(diagnostic.held_ms, None);
        assert_eq!(diagnostic.released_ms, Some(10));
        sample["typed_text"] = json!("private prompt");
        assert!(serde_json::from_value::<EnterDiagnostic>(sample.clone()).is_err());
        sample.as_object_mut().unwrap().remove("typed_text");
        sample["held_ms"] = json!(-1);
        assert!(serde_json::from_value::<EnterDiagnostic>(sample).is_err());
    }

    #[tokio::test]
    async fn terminal_diagnostics_require_known_host_origin_and_bounded_metadata() {
        use tower::ServiceExt;
        let app = router(
            RelayConfig {
                browser_origin: None,
                hosts: vec![super::super::tests::config("http://127.0.0.1:8082")],
                artifact_proxy: None,
            },
            8090,
        )
        .await
        .unwrap();
        let request = |body: Value, origin: &str| {
            hyper::Request::post("/api/diagnostics/terminal-switch")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = app
            .clone()
            .oneshot(request(switch_sample(), "https://attacker.example"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app
            .clone()
            .oneshot(request(switch_sample(), "http://127.0.0.1:8090"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(local()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["source"] == "Mac" && e["message"].as_str().unwrap().contains("pane=30")));
        let mut sample = switch_sample();
        sample["host"] = json!("unpaired");
        let response = app
            .clone()
            .oneshot(request(sample, "http://127.0.0.1:8090"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let mut sample = switch_sample();
        sample["contents"] = json!("private transcript");
        let response = app
            .clone()
            .oneshot(request(sample, "http://127.0.0.1:8090"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = app
            .oneshot(request(
                json!({"contents":"x".repeat(9000)}),
                "http://127.0.0.1:8090",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    fn browser_sample() -> Value {
        json!({"id":1,"reason":"visible","outcome":"sampled","hidden_ms":60000,"frozen":false,
            "event_delay_ms":5,"first_animation_ms":16,"terminal_animation_ms":30,"terminal_probe":true,
            "terminal_socket":1,"control_socket":1,"writes_pending":0,"render_pending":false,
            "long_task_tracking":true,"long_tasks":0,"max_long_task_ms":0,"total_long_task_ms":0,
            "elapsed_ms":5000})
    }

    fn browser_stages_sample() -> Value {
        let mut sample = browser_sample();
        for (field, value) in json!({
            "terminal_message_ms":4,"terminal_frame_ms":23,"terminal_reply_ms":3,
            "initial_writes_pending":7,"initial_render_pending":true,
            "terminal_hidden":false,"terminal_active":true,"terminal_long_task_tracking":true,
            "terminal_long_tasks":0,"terminal_max_long_task_ms":0,"terminal_total_long_task_ms":0
        })
        .as_object()
        .unwrap()
        {
            sample[field] = value.clone();
        }
        sample
    }

    #[test]
    fn browser_stages_keep_delivery_animation_reply_and_initial_backlog_separate() {
        let sample = browser_stages_sample();
        let diagnostic: BrowserDiagnostic = serde_json::from_value(sample.clone()).unwrap();
        let message = diagnostic.stages_message().unwrap();
        assert!(message.starts_with("Browser tab resumed stages id=1"));
        assert!(message.contains("delivery=4ms frame=23ms reply=3ms"));
        assert!(message.contains("queue=7/true->0/false hidden=false active=true tasks=0/0/0ms"));
        assert_eq!(
            message,
            redact(&message),
            "The persisted line must not lose its tail"
        );
        let legacy: BrowserDiagnostic = serde_json::from_value(browser_sample()).unwrap();
        assert!(legacy.stages_message().is_none());

        let mut missing = sample.clone();
        missing["terminal_animation_ms"] = Value::Null;
        missing["terminal_frame_ms"] = Value::Null;
        missing["terminal_reply_ms"] = Value::Null;
        missing["writes_pending"] = Value::Null;
        missing["render_pending"] = Value::Null;
        let diagnostic: BrowserDiagnostic = serde_json::from_value(missing).unwrap();
        let message = diagnostic.stages_message().unwrap();
        assert!(message.starts_with("Browser tab slow stages"));
        assert!(message.contains("delivery=4ms frame=-ms reply=-ms queue=7/true->-/-"));

        let mut busy = sample;
        busy["terminal_max_long_task_ms"] = json!(700);
        busy["terminal_long_tasks"] = json!(1);
        busy["terminal_total_long_task_ms"] = json!(700);
        let diagnostic: BrowserDiagnostic = serde_json::from_value(busy).unwrap();
        assert!(diagnostic
            .message()
            .unwrap()
            .starts_with("Browser tab slow"));
        assert!(diagnostic
            .stages_message()
            .unwrap()
            .contains("tasks=1/700/700ms"));
    }

    #[test]
    fn browser_stage_line_is_bounded_even_for_maximum_numeric_metadata() {
        let mut sample = browser_stages_sample();
        for field in [
            "id",
            "terminal_message_ms",
            "terminal_frame_ms",
            "terminal_reply_ms",
            "initial_writes_pending",
            "writes_pending",
            "terminal_long_tasks",
            "terminal_max_long_task_ms",
            "terminal_total_long_task_ms",
        ] {
            sample[field] = json!(u32::MAX);
        }
        let diagnostic: BrowserDiagnostic = serde_json::from_value(sample).unwrap();
        let message = diagnostic.stages_message().unwrap();
        assert_eq!(message, redact(&message));
        assert!(message.chars().count() <= 240);
    }

    #[test]
    fn browser_rendering_distinguishes_slow_frames_from_fast_scripts_and_legacy_clients() {
        let legacy: BrowserDiagnostic = serde_json::from_value(browser_sample()).unwrap();
        assert!(legacy.rendering_message().is_none());
        let mut sample = browser_sample();
        sample["long_frame_tracking"] = json!(true);
        sample["long_frames"] = json!(1);
        sample["max_frame_ms"] = json!(700);
        sample["max_render_ms"] = json!(680);
        sample["max_layout_ms"] = json!(650);
        sample["max_script_ms"] = json!(5);
        sample["terminal_render_cycle_ms"] = json!(600);
        let diagnostic: BrowserDiagnostic = serde_json::from_value(sample).unwrap();
        assert!(diagnostic.slow());
        let message = diagnostic.rendering_message().unwrap();
        assert!(message.contains(
            "tracked=true frames=1 longest=700ms render=680ms layout=650ms scripts=5ms terminal_cycle=600ms"
        ));
        assert_eq!(message, redact(&message));
        let mut terminal = browser_sample();
        terminal["terminal_render_cycle_ms"] = json!(700);
        let terminal: BrowserDiagnostic = serde_json::from_value(terminal).unwrap();
        assert!(terminal.slow());
        assert!(terminal
            .rendering_message()
            .unwrap()
            .contains("tracked=- frames=- longest=-ms"));
    }

    #[test]
    fn browser_rendering_lines_keep_all_maximum_numeric_metadata() {
        let mut sample = browser_sample();
        sample["long_frame_tracking"] = json!(true);
        for field in [
            "long_frames",
            "max_frame_ms",
            "max_render_ms",
            "max_layout_ms",
            "max_script_ms",
        ] {
            sample[field] = json!(u32::MAX);
        }
        sample["id"] = json!(u32::MAX);
        sample["terminal_render_cycle_ms"] = json!(u32::MAX);
        let diagnostic: BrowserDiagnostic = serde_json::from_value(sample).unwrap();
        let message = diagnostic.rendering_message().unwrap();
        assert_eq!(message, redact(&message));
        assert!(message.chars().count() <= 240);
    }

    #[test]
    fn browser_resume_distinguishes_observation_time_from_delayed_animation_and_missing_terminal() {
        let mut sample = browser_sample();
        let message = serde_json::from_value::<BrowserDiagnostic>(sample.clone())
            .unwrap()
            .message()
            .unwrap();
        assert!(message.starts_with("Browser tab resumed"));
        assert!(message.contains("hidden=60000ms load=-ms event=5ms raf=16/30ms"));
        assert!(diagnostic(&message));
        assert_eq!(message, redact(&message));
        for field in [
            "load_ms",
            "event_delay_ms",
            "first_animation_ms",
            "terminal_animation_ms",
            "max_long_task_ms",
        ] {
            let mut slow = sample.clone();
            slow[field] = json!(700);
            assert!(serde_json::from_value::<BrowserDiagnostic>(slow)
                .unwrap()
                .message()
                .unwrap()
                .starts_with("Browser tab slow"));
        }
        sample["terminal_animation_ms"] = Value::Null;
        assert!(serde_json::from_value::<BrowserDiagnostic>(sample.clone())
            .unwrap()
            .message()
            .unwrap()
            .starts_with("Browser tab slow"));
        sample["terminal_probe"] = json!(false);
        assert!(serde_json::from_value::<BrowserDiagnostic>(sample.clone())
            .unwrap()
            .message()
            .unwrap()
            .starts_with("Browser tab resumed"));
        sample["reason"] = json!("conversation");
        assert!(serde_json::from_value::<BrowserDiagnostic>(sample.clone())
            .unwrap()
            .message()
            .unwrap()
            .starts_with("Browser tab resumed reason=conversation "));
        sample["reason"] = json!("token=x");
        assert_eq!(
            serde_json::from_value::<BrowserDiagnostic>(sample)
                .unwrap()
                .message(),
            None
        );
    }

    #[tokio::test]
    async fn browser_resume_requires_same_origin_bounded_metadata_and_no_terminal_contents() {
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
        let request = |body: Value, origin: &str| {
            hyper::Request::post("/api/diagnostics/browser-resume")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let response = app
            .clone()
            .oneshot(request(browser_sample(), "https://attacker.example"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let mut rendered = browser_stages_sample();
        rendered["long_frame_tracking"] = json!(true);
        rendered["long_frames"] = json!(1);
        rendered["max_frame_ms"] = json!(700);
        rendered["max_render_ms"] = json!(650);
        rendered["max_layout_ms"] = json!(600);
        rendered["max_script_ms"] = json!(5);
        rendered["terminal_render_cycle_ms"] = json!(700);
        let response = app
            .clone()
            .oneshot(request(rendered, "http://127.0.0.1:8090"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(local()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["message"]
                .as_str()
                .unwrap()
                .contains("tracked=true frames=1 longest=700ms render=650ms layout=600ms scripts=5ms terminal_cycle=700ms")));
        let response = app
            .clone()
            .oneshot(request(browser_stages_sample(), "http://127.0.0.1:8090"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(local()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["source"] == "Browser"
                && entry["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("Browser tab resumed")));
        assert!(local()["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["message"]
                .as_str()
                .unwrap()
                .starts_with("Browser tab resumed stages")));
        for (field, value) in [
            ("reason", json!("private URL")),
            ("terminal_socket", json!(4)),
            ("first_animation_ms", json!(-1)),
            ("first_animation_ms", json!(u64::MAX)),
            ("terminal_message_ms", json!(-1)),
            ("terminal_frame_ms", json!(u64::MAX)),
            ("initial_writes_pending", json!(-1)),
            ("terminal_hidden", json!("private URL")),
            ("terminal_long_tasks", json!(-1)),
            ("terminal_render_cycle_ms", json!(-1)),
            ("max_frame_ms", json!(u64::MAX)),
            ("max_render_ms", json!("private URL")),
            ("long_frame_tracking", json!("private URL")),
            ("scripts", json!([])),
            ("sourceURL", json!("private URL")),
            ("received_at", json!(1000000)),
            ("contents", json!("private transcript")),
        ] {
            let mut invalid = browser_sample();
            invalid[field] = value;
            let response = app
                .clone()
                .oneshot(request(invalid, "http://127.0.0.1:8090"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{field}");
        }
        let response = app
            .oneshot(request(
                json!({"contents":"x".repeat(9000)}),
                "http://127.0.0.1:8090",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn ring_buffer_is_bounded_newest_first_and_counts_repeats() {
        let log = Log(Default::default(), Default::default());
        for i in 0..CAPACITY + 50 {
            assert!(log.push("windows", &format!("failure {i}"), i as u64));
        }
        let entries = log.newest_first();
        assert_eq!(entries.len(), CAPACITY);
        assert_eq!(entries[0]["message"], format!("failure {}", CAPACITY + 49));
        assert_eq!(entries[CAPACITY - 1]["message"], "failure 50");
        assert!(!log.push("windows", "failure 60", 999));
        let entries = log.newest_first();
        assert_eq!(entries.len(), CAPACITY);
        assert_eq!(entries[0]["message"], "failure 60");
        assert_eq!(entries[0]["count"], 2);
        assert_eq!(entries[0]["time"], 999);
    }

    #[test]
    fn entries_redact_credentials_and_keep_one_bounded_line() {
        for (raw, kept) in [
            ("Authorization: Bearer abc.def", "Authorization: [redacted]"),
            (
                "login failed token=s3cr3t; retry",
                "login failed token=[redacted]; retry",
            ),
            ("Cookie: session_token=xyz", "Cookie: [redacted]"),
            (
                "GET /x?auth_token=1&ok=2",
                "GET /x?auth_token=[redacted]&ok=2",
            ),
        ] {
            let message = redact(raw);
            assert_eq!(message, kept);
        }
        assert_eq!(redact("first line\nupstream body secret"), "first line");
        assert_eq!(redact(&"x".repeat(1000)).len(), 240);
    }

    #[tokio::test]
    async fn api_logs_lists_this_computer_behind_the_relay_guard() {
        record("test-host", "Remote control unavailable for api test");
        use tower::ServiceExt;
        let config = RelayConfig {
            browser_origin: None,
            hosts: vec![],
            artifact_proxy: None,
        };
        let app = router(config, 8090).await.unwrap();
        let request = |origin: &str| {
            hyper::Request::get("/api/logs")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::empty())
                .unwrap()
        };
        let forbidden = app
            .clone()
            .oneshot(request("https://attacker.example"))
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let response = app.oneshot(request("http://127.0.0.1:8090")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), LIMIT).await.unwrap()).unwrap();
        assert_eq!(body["computers"][0]["local"], true);
        assert!(body["computers"][0]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["source"] == "test-host"
                && e["message"] == "Remote control unavailable for api test"));
    }
}

// Browser diagnostics accept fixed codes only, never transcript text or paths.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ConversationDiagnostic {
    phase: String,
    outcome: String,
    elapsed_ms: u32,
    host: Option<String>,
}
impl ConversationDiagnostic {
    fn message(&self) -> Option<String> {
        if !matches!(self.phase.as_str(), "initial" | "poll" | "older")
            || !matches!(
                self.outcome.as_str(),
                "timeout" | "network" | "http" | "invalid_response" | "partial" | "recovered"
            )
            || self.elapsed_ms > 120_000
        {
            return None;
        }
        let host = diagnostic_host(self.host.as_deref()).ok()?;
        Some(format!(
            "History {}: {}; elapsed_ms={}{}",
            self.phase,
            self.outcome,
            self.elapsed_ms,
            host.map_or_else(String::new, |host| format!(" host={host}")),
        ))
    }
}
/// A switch from Terminal to Conversation, timed until its messages are on screen.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ShownDiagnostic {
    end: String,
    elapsed_ms: u32,
    paint_ms: Option<u32>,
    #[serde(default = "shown_mode")]
    reason: String,
    remote: Option<bool>,
    host: Option<String>,
    request_ms: Option<u32>,
    render_ms: Option<u32>,
    peer_ms: Option<u32>,
    bridge_ms: Option<u32>,
    queue_ms: Option<u32>,
    read_ms: Option<u32>,
    index_ms: Option<u32>,
    page_ms: Option<u32>,
}
fn shown_mode() -> String {
    "mode".into()
}
impl ShownDiagnostic {
    fn message(&self) -> Option<String> {
        if !matches!(
            self.end.as_str(),
            "cached"
                | "history"
                | "unbound"
                | "failed"
                | "changed"
                | "left"
                | "superseded"
                | "timeout"
        ) || self.elapsed_ms > 120_000
            || self.paint_ms.is_some_and(|t| t > self.elapsed_ms)
            || !matches!(self.reason.as_str(), "mode" | "selection")
            || [
                self.request_ms,
                self.render_ms,
                self.peer_ms,
                self.bridge_ms,
                self.queue_ms,
                self.read_ms,
                self.index_ms,
                self.page_ms,
            ]
            .into_iter()
            .flatten()
            .any(|t| t > 120_000)
        {
            return None;
        }
        let host = diagnostic_host(self.host.as_deref()).ok()?;
        let slow = self.elapsed_ms > 500 || matches!(self.end.as_str(), "failed" | "timeout");
        let mut message = format!(
            "Conversation shown {} t={}ms paint={}ms end={}",
            if slow { "slow" } else { "ready" },
            self.elapsed_ms,
            self.paint_ms.map_or_else(|| "-".into(), |t| t.to_string()),
            self.end,
        );
        // Keep the original form for older browsers while retaining numeric stages from new ones.
        if self.remote.is_some() {
            use std::fmt::Write;
            let _ = write!(
                message,
                " reason={} remote={}",
                self.reason,
                self.remote.unwrap()
            );
            if let Some(host) = host {
                let _ = write!(message, " host={host}");
            }
            for (name, value) in [
                ("request", self.request_ms),
                ("render", self.render_ms),
                ("peer", self.peer_ms),
                ("bridge", self.bridge_ms),
                ("queue", self.queue_ms),
                ("read", self.read_ms),
                ("index", self.index_ms),
                ("page", self.page_ms),
            ] {
                if let Some(value) = value {
                    let _ = write!(message, " {name}={value}ms");
                }
            }
        }
        Some(message)
    }
}
pub(super) async fn conversation_shown(request: Request) -> StatusCode {
    let diagnostic: ShownDiagnostic = match diagnostic_body(request).await {
        Ok(value) => value,
        Err(status) => return status,
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    record("Conversation", &message);
    StatusCode::NO_CONTENT
}
pub(super) async fn conversation(request: Request) -> StatusCode {
    let diagnostic: ConversationDiagnostic = match diagnostic_body(request).await {
        Ok(value) => value,
        Err(status) => return status,
    };
    let Some(message) = diagnostic.message() else {
        return StatusCode::BAD_REQUEST;
    };
    record("Conversation", &message);
    StatusCode::NO_CONTENT
}

#[cfg(test)]
mod conversation_diagnostic_tests {
    use super::*;
    #[test]
    fn switchboard_conversation_shown_reports_wait_and_how_it_ended() {
        let shown = |value: Value| {
            serde_json::from_value::<ShownDiagnostic>(value)
                .unwrap()
                .message()
        };
        let message = shown(json!({"end":"cached","elapsed_ms":40,"paint_ms":30})).unwrap();
        assert_eq!(
            message,
            "Conversation shown ready t=40ms paint=30ms end=cached"
        );
        assert!(diagnostic(&message));
        assert_eq!(
            shown(json!({"end":"history","elapsed_ms":2400,"paint_ms":20})).unwrap(),
            "Conversation shown slow t=2400ms paint=20ms end=history"
        );
        assert!(
            shown(json!({"end":"failed","elapsed_ms":300,"paint_ms":null}))
                .unwrap()
                .starts_with("Conversation shown slow ")
        );
        assert_eq!(
            shown(json!({"end":"token=x","elapsed_ms":1,"paint_ms":1})),
            None
        );
        assert_eq!(
            shown(json!({"end":"cached","elapsed_ms":1,"paint_ms":5})),
            None
        );
        assert!(serde_json::from_value::<ShownDiagnostic>(
            json!({"end":"cached","elapsed_ms":1,"paint_ms":1,"text":"x"})
        )
        .is_err());
        let sample = json!({"end":"history","elapsed_ms":900,"paint_ms":10,
            "reason":"selection","remote":true,"request_ms":850,"render_ms":20,
            "queue_ms":50,"read_ms":700,"index_ms":600,"page_ms":80});
        assert_eq!(shown(sample.clone()).unwrap(),
            "Conversation shown slow t=900ms paint=10ms end=history reason=selection remote=true request=850ms render=20ms queue=50ms read=700ms index=600ms page=80ms");
        for field in [
            "request_ms",
            "render_ms",
            "peer_ms",
            "bridge_ms",
            "queue_ms",
            "read_ms",
            "index_ms",
            "page_ms",
        ] {
            let mut invalid = sample.clone();
            invalid[field] = json!(120_001);
            assert!(shown(invalid).is_none());
        }
        let mut invalid = sample;
        invalid["reason"] = json!("private chat title");
        assert!(shown(invalid).is_none());
    }
    #[test]
    fn switchboard_browser_load_samples_do_not_evict_conversation_timings() {
        let log = Log(Default::default(), Default::default());
        log.push(
            "Conversation",
            "Conversation shown slow t=2400ms paint=20ms end=history",
            0,
        );
        for elapsed in 0..CAPACITY as u64 + 20 {
            log.push(
                "Conversation",
                &format!("History poll: recovered; elapsed_ms={elapsed}"),
                elapsed + 1,
            );
        }
        assert!(log.newest_first().iter().any(|e| e["message"]
            .as_str()
            .unwrap()
            .starts_with("Conversation shown slow ")));
        assert!(!diagnostic(
            "History load failed: computer_unavailable; reasons="
        ));
        assert!(!diagnostic("History poll: http; elapsed_ms=1720"));
    }

    #[test]
    fn switchboard_runtime_lateness_is_bucketed() {
        assert_eq!(runtime_late_bucket(Duration::from_millis(249)), None);
        assert_eq!(
            runtime_late_bucket(Duration::from_millis(1200)),
            Some("Relay runtime slow late=1000ms+")
        );
        assert!(diagnostic("Relay runtime slow late=250ms+"));
        assert_eq!(rank("Relay runtime slow late=250ms+"), 1);
    }

    #[tokio::test]
    async fn switchboard_conversation_diagnostics_accept_only_content_free_codes() {
        let request = |value: Value| {
            Request::builder()
                .method("POST")
                .body(Body::from(value.to_string()))
                .unwrap()
        };
        assert_eq!(
            conversation(request(
                json!({"phase":"initial","outcome":"timeout","elapsed_ms":15000})
            ))
            .await,
            StatusCode::NO_CONTENT
        );
        for value in [
            json!({"phase":"private prompt","outcome":"timeout","elapsed_ms":1}),
            json!({"phase":"poll","outcome":"private error text","elapsed_ms":1}),
            json!({"phase":"poll","outcome":"network","elapsed_ms":1,"message":"private prompt"}),
            json!({"phase":"poll","outcome":"network","elapsed_ms":120001}),
            json!({"phase":"poll","outcome":"network","elapsed_ms":1,"host":"a b/c"}),
        ] {
            assert_eq!(conversation(request(value)).await, StatusCode::BAD_REQUEST);
        }
    }
}
