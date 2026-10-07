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

#[cfg(test)]
mod tests {
    use super::*;

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
