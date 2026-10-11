//! Recent Switchboard failures, reviewable from Settings instead of zellij.log.
use super::*;
use std::{collections::VecDeque, sync::LazyLock};

const CAPACITY: usize = 200;
static LOG: Log = Log(std::sync::Mutex::new(VecDeque::new()));

struct Log(std::sync::Mutex<VecDeque<Value>>);

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
        while entries.len() > CAPACITY {
            entries.pop_front();
        }
        count == 1
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
    if LOG.push(source, message, time) {
        log::warn!("Switchboard {source}: {}", redact(message));
    }
}

/// Gateway reply for paired peers reviewing this computer's failures.
pub(super) fn local() -> Value {
    json!({"entries": LOG.newest_first()})
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
    let mut computers = vec![json!({"name":name,"local":true,"entries":LOG.newest_first()})];
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
        let timing = |t: Option<u32>| t.map_or_else(|| "-".into(), |t| t.to_string());
        Some(format!(
            "Terminal switch {} pane={}{} focus={} t={}ms ack={} frame={}/{} parse={}/{} render={}/{} raf={}/{} lag={}/{}/{}ms frames={} bytes={} queue={} quiet={} late={}",
            self.outcome, if self.is_plugin { "plugin:" } else { "" }, self.pane_id, self.focus_id,
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
    if !message.is_empty() {
        record(&host.config.name, &message);
        record(&host.config.name, &diagnostic.viewport_message());
    }
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

    fn switch_sample() -> Value {
        json!({"host":"mac","focus_id":17,"pane_id":30,"is_plugin":false,"expected_render":true,
            "outcome":"settled","elapsed_ms":900,"ack_ms":15,"first_frame_ms":20,"first_parse_ms":750,
            "last_frame_ms":20,"last_parse_ms":750,"frames":1,"bytes":120000,"writes_pending":0,
            "max_parse_lag_ms":730,"physical_cols":120,"physical_rows":40,"native_cols":120,"native_rows":40,
            "viewport_claims":2,"terminal_resizes":3})
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

    #[test]
    fn ring_buffer_is_bounded_newest_first_and_counts_repeats() {
        let log = Log(Default::default());
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
