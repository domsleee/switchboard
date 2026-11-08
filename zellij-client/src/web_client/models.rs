use axum::Json;
use serde_json::{json, Value};

// This route sits behind the same authentication as the terminal and session list.
// Ask this computer's agents, never the ones hosting the sidebar: accounts and versions differ.
pub(super) async fn list() -> Json<Value> {
    let (codex, claude) = tokio::join!(
        crate::switchboard_relay::codex_models(),
        crate::switchboard_relay::claude_models()
    );
    Json(json!({"codex": codex, "claude": claude}))
}
