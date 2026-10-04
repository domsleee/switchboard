//! A single durable agent board, served separately from terminals and artifacts.
mod cli;
mod store;
#[cfg(test)]
mod tests;
mod transport;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

pub use cli::run_cli;
const MAX_BODY: usize = 64 * 1024;
const MAX_RECIPIENTS: usize = 256;
type Result<T> = std::result::Result<T, BoardError>;

#[derive(Debug)]
struct BoardError(StatusCode, String);
impl BoardError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    fn forbidden() -> Self {
        Self(
            StatusCode::FORBIDDEN,
            "Agent session belongs to another computer".into(),
        )
    }
    fn missing() -> Self {
        Self(StatusCode::NOT_FOUND, "Board record is unavailable".into())
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self(StatusCode::CONFLICT, message.into())
    }
}
impl From<rusqlite::Error> for BoardError {
    fn from(error: rusqlite::Error) -> Self {
        log::error!("Message board database operation failed: {error}");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Board storage is unavailable".into(),
        )
    }
}
impl IntoResponse for BoardError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Machine {
    id: String,
    name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct TerminalLocation {
    host: String,
    session: String,
    tab_id: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Participant {
    cursor: u64,
    id: String,
    machine_id: String,
    machine_name: String,
    name: String,
    project: String,
    terminal: Option<TerminalLocation>,
    active: bool,
    created_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Register {
    name: String,
    project: String,
    #[serde(default)]
    resume: Option<String>,
    #[serde(default)]
    terminal: Option<TerminalLocation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SendMessage {
    sender: String,
    send_key: String,
    body: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    broadcast: Option<String>,
    #[serde(default)]
    reply_to: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Delivery {
    recipient: String,
    name: String,
    machine_id: String,
    machine_name: String,
    acknowledged_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Message {
    cursor: u64,
    id: String,
    sender: String,
    sender_name: String,
    sender_machine_id: String,
    sender_machine_name: String,
    project: String,
    thread_id: String,
    reply_to: Option<String>,
    body: String,
    created_at: u64,
    deliveries: Vec<Delivery>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Page<T> {
    items: Vec<T>,
    next_cursor: Option<u64>,
}

#[derive(Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct ReadPage {
    #[serde(default)]
    after: u64,
    #[serde(default = "default_limit")]
    limit: u16,
    #[serde(default)]
    project: Option<String>,
}
fn default_limit() -> u16 {
    25
}
fn validate_page(page: &ReadPage) -> Result<()> {
    if !(1..=100).contains(&page.limit) || page.after > i64::MAX as u64 {
        return Err(BoardError::invalid(
            "Use a limit from 1 to 100 and a valid cursor",
        ));
    }
    Ok(())
}
fn label(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
        return Err(BoardError::invalid(format!(
            "{field} must contain 1–200 bytes without control characters"
        )));
    }
    Ok(())
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
