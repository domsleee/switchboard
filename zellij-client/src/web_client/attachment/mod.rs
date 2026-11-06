//! Retained production terminal attachments. Web/relay transports may disappear;
//! the parser, native IPC client and delivery journal remain in this process.
mod journal;
mod process;

use super::{
    control_message::WebClientToWebServerControlMessagePayload,
    message_handlers::{parse_stdin, StdinSession},
    server_listener::zellij_server_listener,
    types::{AppState, CreateClientIdResponse},
    websocket_handlers::control_payload_to_server_msg,
};
use anyhow::{ensure, Result};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        Query, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use journal::{Input, Journal};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, Notify};
use uuid::Uuid;
use zellij_utils::{
    input::mouse::MouseEvent,
    ipc::ClientToServerMsg,
    pane_size::Size,
    web_authentication_tokens::{
        credential_is_read_only, is_session_token_read_only, session_token_owner,
        validate_session_token,
    },
};

pub(crate) use process::worker_status;
pub(super) use process::{bootstrap, proxy, run_worker};
const VIEWER_LIMIT: usize = 64;
const DETACHED_TTL: Duration = Duration::from_secs(600);
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct ResumeInfo {
    pub protocol: u8,
    pub session: String,
}
#[derive(Deserialize, Serialize)]
pub(super) struct Attach {
    token: String,
    welcome: bool,
}
#[derive(Clone)]
struct Worker {
    app: AppState,
    session: String,
    views: Arc<Mutex<HashMap<String, Arc<Viewer>>>>,
}
struct Viewer {
    journal: Mutex<Journal>,
    notify: Notify,
    input: mpsc::Sender<Delivery>,
    owner: String,
    read_only: bool,
    touched: Mutex<Instant>,
    incoming: Mutex<Option<mpsc::Receiver<Delivery>>>,
}
struct Delivery {
    generation: u64,
    input: Input,
    done: oneshot::Sender<Result<u64>>,
}
#[derive(Deserialize, Serialize)]
pub(super) struct ResumeQuery {
    pub session: String,
    pub web_client_id: String,
    #[serde(default)]
    pub generation: u64,
    pub nonce: String,
    #[serde(default)]
    pub applied: u64,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
    pub cell_width: Option<u16>,
    pub cell_height: Option<u16>,
    pub wheel_lines: Option<u32>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Input { generation: u64, input: Input },
    Ack { generation: u64, applied: u64 },
    Close { generation: u64 },
}

async fn create(State(worker): State<Worker>, Json(attach): Json<Attach>) -> Response {
    if !validate_session_token(&attach.token).unwrap_or(false) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if attach.welcome {
        super::types::record_pending_welcome_session(
            &worker.app.pending_welcome_sessions,
            &worker.session,
        );
    }
    let id = Uuid::new_v4().to_string();
    let Ok(owner) = session_token_owner(&attach.token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let read_only = is_session_token_read_only(&attach.token).unwrap_or(true);
    let (tx, rx) = mpsc::channel(32);
    let viewer = Arc::new(Viewer {
        journal: Mutex::new(Journal::default()),
        notify: Notify::new(),
        input: tx,
        owner,
        read_only,
        touched: Mutex::new(Instant::now()),
        incoming: Mutex::new(Some(rx)),
    });
    {
        let mut views = worker.views.lock().unwrap();
        if views.len() >= VIEWER_LIMIT {
            return (StatusCode::SERVICE_UNAVAILABLE, "Too many retained viewers").into_response();
        }
        views.insert(id.clone(), viewer.clone());
    }

    Json(json!({"web_client_id":id})).into_response()
}

async fn resume(
    State(worker): State<Worker>,
    Query(query): Query<ResumeQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(viewer) = worker
        .views
        .lock()
        .unwrap()
        .get(&query.web_client_id)
        .cloned()
    else {
        return (
            StatusCode::GONE,
            "Terminal attachment expired; reload explicitly",
        )
            .into_response();
    };
    // Every reconnect revalidates the current web credential, independently of
    // the private worker capability. A viewer id is not an authorization token.
    let mut request = axum::http::Request::new(());
    *request.headers_mut() = headers;
    let token = super::utils::parse_cookies(&request);
    let Some(token) = token.get("session_token") else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !validate_session_token(token).unwrap_or(false)
        || session_token_owner(token).ok().as_ref() != Some(&viewer.owner)
        || is_session_token_read_only(token).unwrap_or(true) != viewer.read_only
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    if query.session != worker.session {
        return StatusCode::FORBIDDEN.into_response();
    }
    let generation =
        match viewer
            .journal
            .lock()
            .unwrap()
            .resume(query.generation, &query.nonce, query.applied)
        {
            Ok(g) => g,
            Err(error) => return (StatusCode::CONFLICT, error.to_string()).into_response(),
        };
    if let Some(input) = viewer.incoming.lock().unwrap().take() {
        tokio::spawn(attachment(
            worker.clone(),
            query.web_client_id.clone(),
            viewer.clone(),
            input,
            query.rows,
            query.cols,
            query.wheel_lines.unwrap_or(0),
        ));
    }
    *viewer.touched.lock().unwrap() = Instant::now();
    viewer.notify.notify_waiters();
    ws.max_message_size(128 * 1024)
        .on_upgrade(move |socket| transport(socket, viewer, generation, query.applied))
}

async fn transport(socket: WebSocket, viewer: Arc<Viewer>, generation: u64, mut sent: u64) {
    let (mut writer, mut reader) = socket.split();
    let input_ack = viewer.journal.lock().unwrap().input_ack();
    if writer
        .send(Message::Text(
            json!({"type":"hello","generation":generation,"input_ack":input_ack})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    let mut heartbeat = tokio::time::interval(Duration::from_secs(2));
    loop {
        // Register before snapshotting so an emit between snapshot and wait
        // cannot strand output until the next unrelated engine event.
        let notified = viewer.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let (output, error) = {
            let journal = viewer.journal.lock().unwrap();
            if journal.generation != generation {
                break;
            }
            (
                journal
                    .output
                    .iter()
                    .filter(|o| o.seq > sent)
                    .cloned()
                    .collect::<Vec<_>>(),
                journal.failure.clone(),
            )
        };
        if let Some(error) = error {
            let _ = writer
                .send(Message::Text(
                    json!({"type":"error","message":error}).to_string().into(),
                ))
                .await;
            break;
        }
        for record in output {
            sent = record.seq;
            if writer
                .send(Message::Text(
                    json!({"type":"output","record":record}).to_string().into(),
                ))
                .await
                .is_err()
            {
                return;
            }
        }
        tokio::select! {
            _=&mut notified=>{},
            _=heartbeat.tick()=>{if writer.send(Message::Text(json!({"type":"heartbeat"}).to_string().into())).await.is_err(){break;}},
            frame=reader.next()=>{
                let Some(Ok(frame))=frame else {break;};
                *viewer.touched.lock().unwrap()=Instant::now();
                let Message::Text(text)=frame else {if matches!(frame,Message::Close(_)){break;}continue;};
                let result:Result<Option<u64>>=async {
                    match serde_json::from_str::<Request>(&text)? {
                        Request::Input{generation:g,input}=>{
                            ensure!(g==generation,"Stale transport");
                            let (done,reply)=oneshot::channel();
                            viewer.input.send(Delivery{generation,input,done}).await.map_err(|_|anyhow::anyhow!("Attachment ended"))?;
                            Ok(Some(reply.await??))
                        },
                        Request::Ack{generation:g,applied}=>{
                            let mut journal=viewer.journal.lock().unwrap();
                            ensure!(g==generation && g==journal.generation,"Stale transport");
                            journal.acknowledge(applied)?;Ok(None)
                        },
                        Request::Close{generation:g}=>{
                            let mut journal=viewer.journal.lock().unwrap();ensure!(g==generation && g==journal.generation,"Stale transport");
                            journal.failure=Some("Terminal viewer closed".into());viewer.notify.notify_waiters();Ok(None)
                        }
                    }
                }.await;
                match result {
                    Ok(Some(ack))=>{if writer.send(Message::Text(json!({"type":"ack","input_ack":ack}).to_string().into())).await.is_err(){break;}},
                    Ok(None)=>{},Err(error)=>{let _=writer.send(Message::Text(json!({"type":"error","message":error.to_string()}).to_string().into())).await;break;}
                }
            }
        }
    }
}

async fn attachment(
    worker: Worker,
    id: String,
    viewer: Arc<Viewer>,
    mut input: mpsc::Receiver<Delivery>,
    rows: Option<u16>,
    cols: Option<u16>,
    wheel_lines: u32,
) {
    let app = &worker.app;
    let os = match app.client_os_api_factory.create_client_os_api() {
        Ok(os) => os,
        Err(error) => {
            viewer.journal.lock().unwrap().failure = Some(error.to_string());
            viewer.notify.notify_waiters();
            return;
        },
    };
    let (stdout, mut output) = mpsc::unbounded_channel();
    let (control, mut controls) = mpsc::unbounded_channel();
    {
        let mut table = app.connection_table.lock().unwrap();
        table.add_new_client(
            id.clone(),
            os.clone(),
            viewer.read_only,
            viewer.owner.clone(),
        );
        table.add_client_terminal_tx(&id, stdout);
        table.add_client_control_tx(&id, control);
    }
    let (attached, attachment) = oneshot::channel();
    zellij_server_listener(
        os.clone(),
        app.connection_table.clone(),
        Some(worker.session.clone()),
        app.config.lock().unwrap().clone(),
        app.config_options.clone(),
        Some(app.config_file_path.clone()),
        id.clone(),
        app.session_manager.clone(),
        Some(attached),
        Some(Size {
            rows: rows.unwrap_or(24).max(1) as usize,
            cols: cols.unwrap_or(80).max(1) as usize,
        }),
        None,
        app.pending_welcome_sessions.clone(),
        app.sharing_recovery.clone(),
    );
    if !matches!(
        tokio::time::timeout(Duration::from_secs(30), attachment).await,
        Ok(Ok(()))
    ) {
        viewer.journal.lock().unwrap().failure = Some("Terminal attachment timed out".into());
    }
    let mut stdin = StdinSession::new(
        app.config
            .lock()
            .unwrap()
            .options
            .support_kitty_keyboard_protocol
            == Some(false),
    );
    stdin.wheel_lines = wheel_lines.min(3);
    let mut mouse = MouseEvent::new();
    let mut timer = tokio::time::interval(Duration::from_millis(50));
    let mut held_since = Instant::now();
    let mut auth_checked = Instant::now();
    loop {
        if viewer.journal.lock().unwrap().failure.is_some() {
            break;
        }
        tokio::select! {
            Some(delivery)=input.recv()=>{
                let result=(||->Result<u64>{
                    let mut journal=viewer.journal.lock().unwrap();
                    if journal.accepts(delivery.generation,&delivery.input)? {
                        if delivery.input.channel=="terminal" {
                            // Engine read-only policy remains authoritative; do
                            // not even parse user bytes for a read-only viewer.
                            if !viewer.read_only { parse_stdin(delivery.input.data.as_bytes(),os.clone(),&mut mouse,&mut stdin); }
                            held_since=Instant::now();
                        } else {
                            let payload:WebClientToWebServerControlMessagePayload=serde_json::from_str(&delivery.input.data)?;
                            // Complete ambiguous terminal bytes on their original pane
                            // before a control command can move this client.
                            if stdin.pending_finalize() { stdin.finalize(&*os,&mut mouse); }
                            if stdin.has_pending_bytes() {
                                journal.failure=Some("Incomplete terminal sequence before a control command; attachment stopped to preserve its target pane".into());
                                anyhow::bail!("Incomplete terminal sequence before a control command");
                            }
                            let focus=matches!(payload,WebClientToWebServerControlMessagePayload::FocusPane{..});
                            if let Some(message)=control_payload_to_server_msg(payload,app.config.lock().unwrap().options.default_shell.clone()) {
                                os.send_to_server(message);
                            }
                            if focus {if let Some(refresh)=app.connection_table.lock().unwrap().client_id_to_channels.get(&id).and_then(|c|c.recovery_metadata_refresh.clone()){refresh.request();}}
                        }
                        if let Some(error)=os.send_failure() {
                            journal.failure=Some(format!("Terminal IPC failed: {error}"));
                            anyhow::bail!("Terminal IPC failed; input delivery is uncertain");
                        }
                        journal.input=Some(delivery.input);
                    }
                    Ok(journal.input_ack())
                })();
                let _=delivery.done.send(result);
            },
            Some(text)=output.recv()=>{viewer.journal.lock().unwrap().emit("terminal",text);viewer.notify.notify_waiters();},
            Some(message)=controls.recv()=>{
                match message {
                    Message::Text(text)=>viewer.journal.lock().unwrap().emit("control",text.to_string()),
                    Message::Close(_)=>viewer.journal.lock().unwrap().failure=Some("Terminal ended or sharing was revoked".into()),
                    _=>{},
                }
                viewer.notify.notify_waiters();
            },
            _=timer.tick()=>{
                if stdin.pending_finalize() && held_since.elapsed()>=Duration::from_millis(50){stdin.finalize(&*os,&mut mouse);}
                if let Some(error)=os.send_failure(){viewer.journal.lock().unwrap().failure=Some(format!("Terminal IPC failed: {error}"));}
                if auth_checked.elapsed()>=Duration::from_secs(1){
                    auth_checked=Instant::now();
                    if credential_is_read_only(&viewer.owner).ok() != Some(viewer.read_only) {
                        viewer.journal.lock().unwrap().failure=Some("Terminal permission was revoked".into());
                    }
                }
                if viewer.touched.lock().unwrap().elapsed()>DETACHED_TTL{viewer.journal.lock().unwrap().failure=Some("Terminal attachment expired".into());}
            }
        }
    }
    viewer.notify.notify_waiters();
    os.send_to_server(ClientToServerMsg::ClientExited);
    app.connection_table.lock().unwrap().remove_client(&id);
    // Keep the failure available briefly so an in-flight transport receives a
    // definitive failure rather than creating a fresh attachment and replaying.
    tokio::time::sleep(Duration::from_secs(10)).await;
    worker.views.lock().unwrap().remove(&id);
}
