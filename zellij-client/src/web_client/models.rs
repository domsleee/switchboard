use axum::Json;
use serde_json::{json, Value};

// This route sits behind the same authentication as the terminal and session list.
// Ask this computer's Codex, never the one hosting the sidebar: accounts and versions differ.
pub(super) async fn list() -> Json<Value> {
    Json(json!({"codex": crate::switchboard_relay::codex_models().await}))
}
