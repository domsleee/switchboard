//! How long user journeys take, per build. The browser runs the clock because only it sees
//! what the user waits for; this keeps every sample as a histogram so builds can be compared.
use super::*;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

const MAX_BUILDS: usize = 12;
const SLOWEST_PER_SERIES: usize = 5;
const RECENT_PER_SERIES: usize = 20;
const MAX_ELAPSED_MS: u32 = 120_000;
const MAX_STAGES: usize = 16;
/// Each bucket is 10% wider than the last, so a reported percentile is within about 10%.
const BUCKET_GROWTH: f64 = 1.1;
const JOURNEYS: [&str; 6] = [
    "terminal_to_conversation",
    "conversation_select",
    "conversation_load",
    "conversation_connect",
    "conversation_to_terminal",
    "terminal_input_ready",
];

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(Default::default);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    journey: String,
    outcome: String,
    elapsed_ms: u32,
    /// The page was hidden at some point, so the elapsed time is not a wait anyone saw.
    hidden: bool,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    stages: Vec<(String, u32)>,
}

fn is_identifier(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

impl Report {
    fn valid(&self) -> bool {
        JOURNEYS.contains(&self.journey.as_str())
            && is_identifier(&self.outcome, 20)
            && self.elapsed_ms <= MAX_ELAPSED_MS
            && self.stages.len() <= MAX_STAGES
            && self
                .stages
                .iter()
                .all(|(name, ms)| is_identifier(name, 24) && *ms <= MAX_ELAPSED_MS)
    }

    /// Abandoned journeys say nothing about speed, but a timeout or failure is the worst wait.
    fn counts_as_wait(&self) -> bool {
        !self.hidden
            && matches!(
                self.outcome.as_str(),
                "cached" | "history" | "ready" | "timeout" | "failed"
            )
    }
}

#[derive(Clone, serde::Serialize, Deserialize)]
struct Sample {
    time: u64,
    elapsed_ms: u32,
    outcome: String,
    stages: Vec<(String, u32)>,
}

#[derive(Default, Clone, serde::Serialize, Deserialize)]
struct Series {
    first_seen: u64,
    count: u32,
    max_ms: u32,
    buckets: BTreeMap<u16, u32>,
    outcomes: BTreeMap<String, u32>,
    hidden: u32,
    slowest: Vec<Sample>,
    #[serde(default)]
    recent: Vec<Sample>,
}

fn bucket(ms: u32) -> u16 {
    (f64::from(ms.max(1)).ln() / BUCKET_GROWTH.ln()).ceil() as u16
}

impl Series {
    fn add(&mut self, report: &Report, now: u64) {
        if self.first_seen == 0 {
            self.first_seen = now;
        }
        *self.outcomes.entry(report.outcome.clone()).or_default() += 1;
        if report.hidden {
            self.hidden += 1;
        }
        if !report.counts_as_wait() {
            return;
        }
        self.count += 1;
        self.max_ms = self.max_ms.max(report.elapsed_ms);
        *self.buckets.entry(bucket(report.elapsed_ms)).or_default() += 1;
        let sample = Sample {
            time: now,
            elapsed_ms: report.elapsed_ms,
            outcome: report.outcome.clone(),
            stages: report.stages.clone(),
        };
        self.recent.insert(0, sample.clone());
        self.recent.truncate(RECENT_PER_SERIES);
        self.slowest.push(sample);
        self.slowest
            .sort_by_key(|sample| std::cmp::Reverse(sample.elapsed_ms));
        self.slowest.truncate(SLOWEST_PER_SERIES);
    }

    fn percentile(&self, fraction: f64) -> Option<u32> {
        let rank = ((fraction * f64::from(self.count)).ceil() as u32).max(1);
        let mut seen = 0;
        for (bucket, count) in &self.buckets {
            seen += count;
            if seen >= rank {
                let upper = BUCKET_GROWTH.powi(i32::from(*bucket)).round() as u32;
                return Some(upper.min(self.max_ms));
            }
        }
        None
    }
}

#[derive(serde::Serialize, Deserialize)]
struct Saved {
    journey: String,
    build: String,
    target: String,
    series: Series,
}

#[derive(Default)]
struct Store {
    series: BTreeMap<(String, String, String), Series>,
    dirty: bool,
}

impl Store {
    fn add(&mut self, report: &Report, build: &str, target: &str, now: u64) {
        let key = (report.journey.clone(), build.into(), target.into());
        self.series.entry(key).or_default().add(report, now);
        self.dirty = true;
        self.evict_old_builds();
    }

    fn evict_old_builds(&mut self) {
        loop {
            let mut builds: BTreeMap<&str, u64> = BTreeMap::new();
            for ((_, build, _), series) in &self.series {
                let first = builds.entry(build).or_insert(u64::MAX);
                *first = (*first).min(series.first_seen);
            }
            if builds.len() <= MAX_BUILDS {
                return;
            }
            let oldest = builds
                .into_iter()
                .min_by_key(|(_, first)| *first)
                .map(|(build, _)| build.to_string());
            self.series
                .retain(|(_, build, _), _| Some(build) != oldest.as_ref());
        }
    }

    fn view(&self) -> Vec<Value> {
        let mut rows: Vec<_> = self.series.iter().collect();
        rows.sort_by_key(|(_, series)| std::cmp::Reverse(series.first_seen));
        rows.into_iter()
            .map(|((journey, build, target), series)| {
                json!({
                    "journey": journey, "build": build, "target": target,
                    "first_seen": series.first_seen, "count": series.count,
                    "p50_ms": series.percentile(0.5), "p95_ms": series.percentile(0.95),
                    "max_ms": series.max_ms, "outcomes": series.outcomes,
                    "hidden": series.hidden, "slowest": series.slowest, "recent": series.recent,
                })
            })
            .collect()
    }

    fn saved(&mut self) -> Option<Vec<u8>> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        let rows: Vec<Saved> = self
            .series
            .iter()
            .map(|((journey, build, target), series)| Saved {
                journey: journey.clone(),
                build: build.clone(),
                target: target.clone(),
                series: series.clone(),
            })
            .collect();
        serde_json::to_vec(&rows).ok()
    }

    fn load(&mut self, bytes: &[u8]) {
        // Timings are disposable: an unreadable file starts over rather than blocking startup.
        let rows: Vec<Saved> = serde_json::from_slice(bytes).unwrap_or_default();
        self.series = rows
            .into_iter()
            .map(|row| ((row.journey, row.build, row.target), row.series))
            .collect();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn store() -> std::sync::MutexGuard<'static, Store> {
    STORE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn build() -> &'static str {
    let commit = env!("SWITCHBOARD_COMMIT");
    &commit[..commit.len().min(8)]
}

pub(super) async fn report(State(state): State<RelayState>, request: Request) -> StatusCode {
    let Ok(body) = to_bytes(request.into_body(), 8192).await else {
        return StatusCode::PAYLOAD_TOO_LARGE;
    };
    let Ok(report) = serde_json::from_slice::<Report>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    if !report.valid() {
        return StatusCode::BAD_REQUEST;
    }
    // Only names this relay already knows are stored, never a string from the request.
    let target = match report.host.as_deref() {
        // Conversation names this computer "local" rather than by its configured id.
        Some("local") => computer_name(&state).await,
        host => host
            .and_then(|host| state.host(host))
            .map_or_else(|| "unknown".to_string(), |host| host.config.name.clone()),
    };
    store().add(&report, build(), &target, now_ms());
    StatusCode::NO_CONTENT
}

/// Gateway reply for paired computers reading this computer's timings.
pub(super) fn local() -> Value {
    json!({ "series": store().view() })
}

async fn peer(host: &Host) -> Value {
    let reply = tokio::time::timeout(
        Duration::from_secs(3),
        host.request(
            Method::GET,
            "/switchboard/timings",
            Bytes::new(),
            "application/json",
        ),
    )
    .await;
    let name = &host.config.name;
    match reply {
        Ok(Ok(response)) if response.status == StatusCode::OK => {
            match serde_json::from_slice::<Value>(&response.body) {
                Ok(body) if body["series"].is_array() => {
                    json!({"name": name, "series": body["series"]})
                },
                _ => {
                    json!({"name": name, "error": "Timings unavailable on this computer's version"})
                },
            }
        },
        Ok(Ok(response)) if response.status == StatusCode::NOT_FOUND => {
            json!({"name": name, "error": "Timings unavailable on this computer's version"})
        },
        Ok(_) => json!({"name": name, "error": "Timings unavailable"}),
        Err(_) => json!({"name": name, "error": "Computer did not respond"}),
    }
}

async fn computer_name(state: &RelayState) -> String {
    match &state.mesh {
        Some(mesh) => mesh.computer_name().await,
        None => None,
    }
    .unwrap_or_else(|| "This computer".to_string())
}

pub(super) async fn handler(State(state): State<RelayState>) -> Json<Value> {
    let name = computer_name(&state).await;
    let peers = state
        .mesh
        .as_ref()
        .map_or_else(Vec::new, |mesh| mesh.hosts());
    let mut computers = vec![json!({"name": name, "local": true, "series": local()["series"]})];
    computers.extend(futures_util::future::join_all(peers.iter().map(|host| peer(host))).await);
    Json(json!({ "computers": computers }))
}

async fn save(file: &Path) {
    let data = store().saved();
    if let Some(data) = data {
        let _ = logs::write_private(file, &data).await;
    }
}

/// Restore earlier builds' timings, then save changes every few seconds.
pub(super) async fn start(file: PathBuf) -> tokio::task::JoinHandle<()> {
    if let Ok(bytes) = tokio::fs::read(&file).await {
        store().load(&bytes);
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            save(&file).await;
        }
    })
}

/// Save now, as an update stops the relay.
pub(super) async fn flush(file: &Path) {
    save(file).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(outcome: &str, elapsed_ms: u32, hidden: bool) -> Report {
        Report {
            journey: "conversation_to_terminal".into(),
            outcome: outcome.into(),
            elapsed_ms,
            hidden,
            host: None,
            stages: vec![("socket".into(), 12)],
        }
    }

    fn series(store: &Store) -> &Series {
        store.series.values().next().unwrap()
    }

    #[tokio::test]
    async fn switchboard_timing_reports_arrive_over_http_in_the_browsers_shape() {
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
        let post = |body: Value, origin: &str| {
            hyper::Request::post("/api/diagnostics/timing")
                .header(header::HOST, "127.0.0.1:8090")
                .header(header::ORIGIN, origin)
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        let sample = json!({"journey":"conversation_select","outcome":"history","elapsed_ms":640,
            "hidden":false,"host":"mac","stages":[["request",600],["render",12]]});
        let status = |request: hyper::Request<Body>| {
            let app = app.clone();
            async move { app.oneshot(request).await.unwrap().status() }
        };
        assert_eq!(
            status(post(sample.clone(), "https://attacker.example")).await,
            StatusCode::FORBIDDEN
        );
        let mut private = sample.clone();
        private["text"] = json!("chat contents");
        assert_eq!(
            status(post(private, "http://127.0.0.1:8090")).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status(post(sample, "http://127.0.0.1:8090")).await,
            StatusCode::NO_CONTENT
        );
        let response = app
            .clone()
            .oneshot(
                hyper::Request::get("/api/timings")
                    .header(header::HOST, "127.0.0.1:8090")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1 << 20).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        let series = body["computers"][0]["series"].as_array().unwrap();
        let row = series
            .iter()
            .find(|row| row["journey"] == "conversation_select")
            .unwrap();
        assert_eq!(row["max_ms"], 640);
        assert_ne!(row["target"], "unknown", "A paired host is stored by name");
        assert_eq!(row["slowest"][0]["stages"][0], json!(["request", 600]));
        assert_eq!(row["recent"][0]["elapsed_ms"], 640);
        let local = json!({"journey":"conversation_load","outcome":"history","elapsed_ms":9,
            "hidden":false,"host":"local"});
        assert_eq!(
            status(post(local, "http://127.0.0.1:8090")).await,
            StatusCode::NO_CONTENT
        );
        let target = store()
            .series
            .keys()
            .find(|(journey, _, _)| journey == "conversation_load")
            .map(|(_, _, target)| target.clone());
        assert_eq!(target.as_deref(), Some("This computer"));
    }

    #[test]
    fn switchboard_timings_reject_anything_but_known_journeys_and_plain_names() {
        assert!(report("ready", 10, false).valid());
        let mut typing = report("ready", 10, false);
        typing.journey = "terminal_input_ready".into();
        assert!(typing.valid());
        let mut bad = report("ready", 10, false);
        bad.journey = "something_else".into();
        assert!(!bad.valid());
        assert!(!report("Not Plain", 10, false).valid());
        assert!(!report("ready", MAX_ELAPSED_MS + 1, false).valid());
        let mut bad = report("ready", 10, false);
        bad.stages = vec![("c:\\path".into(), 1)];
        assert!(!bad.valid());
        bad.stages = vec![("a".into(), 1); MAX_STAGES + 1];
        assert!(!bad.valid());
    }

    #[test]
    fn switchboard_timings_leave_hidden_and_abandoned_journeys_out_of_percentiles() {
        let mut store = Store::default();
        store.add(&report("ready", 100, false), "abc", "Mac", 1);
        store.add(&report("ready", 86_000, true), "abc", "Mac", 2);
        store.add(&report("left", 90_000, false), "abc", "Mac", 3);
        let row = series(&store);
        assert_eq!((row.count, row.hidden), (1, 1));
        assert_eq!(row.max_ms, 100);
        assert_eq!(row.outcomes["left"], 1);
        assert_eq!(row.slowest.len(), 1);
        assert_eq!(row.recent.len(), 1);
    }

    #[test]
    fn switchboard_timings_count_a_timeout_as_the_worst_wait() {
        let mut store = Store::default();
        store.add(&report("timeout", 30_000, false), "abc", "Mac", 1);
        assert_eq!(series(&store).max_ms, 30_000);
    }

    #[test]
    fn switchboard_timing_percentiles_are_within_a_bucket_of_the_truth() {
        let mut store = Store::default();
        for ms in 1..=1000 {
            store.add(&report("ready", ms, false), "abc", "Mac", 1);
        }
        let row = series(&store);
        for (fraction, truth) in [(0.5, 500.0), (0.95, 950.0)] {
            let value = f64::from(row.percentile(fraction).unwrap());
            assert!((value - truth).abs() / truth <= 0.1, "{fraction}: {value}");
        }
        assert_eq!(row.percentile(1.0), Some(1000));
    }

    #[test]
    fn switchboard_timings_keep_only_the_slowest_samples() {
        let mut store = Store::default();
        for ms in 1..=20 {
            store.add(&report("ready", ms, false), "abc", "Mac", 1);
        }
        let kept: Vec<_> = series(&store)
            .slowest
            .iter()
            .map(|s| s.elapsed_ms)
            .collect();
        assert_eq!(kept, [20, 19, 18, 17, 16]);
    }

    #[test]
    fn switchboard_timings_keep_recent_waits_even_when_they_are_fast() {
        let mut store = Store::default();
        for n in 1..=30 {
            store.add(&report("ready", 1000 - n, false), "abc", "Mac", n.into());
        }
        let row = series(&store);
        assert_eq!(row.recent.len(), RECENT_PER_SERIES);
        assert_eq!(row.recent.first().unwrap().elapsed_ms, 970);
        assert_eq!(row.recent.last().unwrap().time, 11);
        assert_eq!(row.slowest.first().unwrap().elapsed_ms, 999);
        store.add(&report("timeout", 30_000, false), "def", "Studio", 31);
        let mut restored = Store::default();
        restored.load(&store.saved().unwrap());
        assert_eq!(restored.view(), store.view());
    }

    #[test]
    fn switchboard_timings_load_files_without_recent_events() {
        let mut store = Store::default();
        store.add(&report("ready", 42, false), "abc", "Mac", 1);
        let mut saved: Value = serde_json::from_slice(&store.saved().unwrap()).unwrap();
        saved[0]["series"].as_object_mut().unwrap().remove("recent");
        let mut restored = Store::default();
        restored.load(&serde_json::to_vec(&saved).unwrap());
        assert_eq!(series(&restored).count, 1);
        assert!(series(&restored).recent.is_empty());
    }

    #[test]
    fn switchboard_timings_keep_builds_apart_and_drop_the_oldest() {
        let mut store = Store::default();
        for build in 0..=MAX_BUILDS as u64 {
            store.add(
                &report("ready", 10, false),
                &format!("b{build}"),
                "Mac",
                build + 1,
            );
        }
        assert_eq!(store.series.len(), MAX_BUILDS);
        assert!(!store.series.keys().any(|(_, build, _)| build == "b0"));
    }

    #[test]
    fn switchboard_timings_survive_a_restart_and_ignore_a_damaged_file() {
        let mut store = Store::default();
        store.add(&report("ready", 42, false), "abc", "Mac", 1);
        let saved = store.saved().unwrap();
        assert!(
            store.saved().is_none(),
            "Unchanged timings are not rewritten"
        );
        let mut restored = Store::default();
        restored.load(&saved);
        assert_eq!(series(&restored).max_ms, 42);
        restored.load(b"not json");
        assert!(restored.series.is_empty());
    }
}
