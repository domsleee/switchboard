//! Retained production terminal attachments. Web/relay transports may disappear;
//! the parser, native IPC client and delivery journal remain in this process.
mod journal;
mod process;

use super::{
    control_message::WebClientToWebServerControlMessagePayload,
    message_handlers::{parse_stdin, StdinSession},
    server_listener::zellij_server_listener,
    types::{AppState, CreateClientIdResponse},
    websocket_handlers::{control_payload_to_server_msg, has_room},
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
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, watch, Notify};
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
const RETIRED: &str = "Terminal viewer retired";
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
    #[serde(default)]
    may_create_session: bool,
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
    may_create_session: bool,
    touched: Mutex<Instant>,
    incoming: Mutex<Option<mpsc::Receiver<Delivery>>>,
    retired: watch::Sender<bool>,
    parser_pending: AtomicBool,
    session: String,
    failure_context: Mutex<FailureContext>,
    failure_report: tokio::sync::OnceCell<crate::terminal_failures::Failure>,
    failure_saved: AtomicBool,
}
struct FailureContext {
    operation: &'static str,
    started: Instant,
    target: Option<(u32, bool)>,
    focus_confirmed: bool,
    query_received: bool,
}
impl FailureContext {
    fn new(operation: &'static str) -> Self {
        Self {
            operation,
            started: Instant::now(),
            target: None,
            focus_confirmed: false,
            query_received: false,
        }
    }
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
    #[serde(default)]
    pub hidden: bool,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Input { generation: u64, input: Input },
    Ack { generation: u64, applied: u64 },
    Close { generation: u64 },
    Retire { generation: u64 },
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
        may_create_session: attach.may_create_session,
        touched: Mutex::new(Instant::now()),
        incoming: Mutex::new(Some(rx)),
        retired: watch::channel(false).0,
        parser_pending: AtomicBool::new(false),
        session: worker.session.clone(),
        failure_context: Mutex::new(FailureContext::new("attach")),
        failure_report: tokio::sync::OnceCell::new(),
        failure_saved: AtomicBool::new(false),
    });
    {
        let mut views = worker.views.lock().unwrap();
        if views
            .values()
            .filter(|viewer| !*viewer.retired.borrow())
            .count()
            >= VIEWER_LIMIT
        {
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
    // A transport may lose the terminal error while disconnecting. Authenticate
    // first, then deliver the retained failure over WebSocket so the browser can
    // stop retrying immediately instead of hiding an HTTP upgrade rejection.
    let failure = viewer.journal.lock().unwrap().failure.clone();
    if let Some(error) = failure {
        return ws.on_upgrade(move |mut socket| async move {
            let _ = socket
                .send(Message::Text(
                    final_reply(&viewer, error).await.to_string().into(),
                ))
                .await;
        });
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
            query.hidden,
        ));
    }
    *viewer.touched.lock().unwrap() = Instant::now();
    viewer.notify.notify_waiters();
    ws.max_message_size(512 * 1024)
        .on_upgrade(move |socket| transport(socket, viewer, generation, query.applied))
}

async fn final_reply(viewer: &Viewer, error: String) -> serde_json::Value {
    if error == "Terminal viewer closed" {
        return json!({"type":"retired"});
    }
    if error == RETIRED {
        let mut retired = viewer.retired.subscribe();
        if matches!(
            tokio::time::timeout(Duration::from_secs(10), retired.wait_for(|done| *done)).await,
            Ok(Ok(_))
        ) {
            return json!({"type":"retired"});
        }
    }
    let failure = report_failure(viewer, &error).await;
    json!({"type":"error","message":format!("{error}\nReference: {}",failure.reference),"failure":failure,"failure_saved":viewer.failure_saved.load(Ordering::Acquire)})
}

/// Persist before publishing a fatal error. The report contains fixed codes and
/// numeric protocol observations, never the error's potentially private contents.
async fn report_failure<'a>(
    viewer: &'a Viewer,
    error: &str,
) -> &'a crate::terminal_failures::Failure {
    viewer
        .failure_report
        .get_or_init(|| async {
            let failure = {
                let context = viewer.failure_context.lock().unwrap();
                let code = if error.starts_with("Engine did not confirm") {
                    "focus_unconfirmed"
                } else if error.starts_with("Terminal pane selection was not confirmed") {
                    "focus_timeout"
                } else if error.starts_with("Requested terminal pane could not be selected") {
                    "pane_unavailable"
                } else if error.starts_with("Terminal IPC failed") {
                    "ipc_failure"
                } else if error.starts_with("Terminal permission was revoked") {
                    "permission_revoked"
                } else if error.starts_with("Terminal attachment expired") {
                    "attachment_expired"
                } else if error.contains("sequence") || error.contains("input retry") {
                    "input_sequence"
                } else {
                    "attachment_ended"
                };
                crate::terminal_failures::Failure {
                    reference: Uuid::new_v4().simple().to_string()[..12].into(),
                    code: code.into(),
                    session: viewer.session.clone(),
                    pane_id: context.target.map(|p| p.0),
                    is_plugin: context.target.is_some_and(|p| p.1),
                    operation: context.operation.into(),
                    elapsed_ms: context.started.elapsed().as_millis().min(86_400_000) as u64,
                    focus_confirmed: context.focus_confirmed,
                    query_received: context.query_received,
                    worker_build: Some(env!("SWITCHBOARD_COMMIT").into()),
                    engine_build: None,
                    pending_records: None,
                }
            };
            let saved = failure.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::terminal_failures::record_at(
                    &crate::terminal_failures::path()?,
                    "Terminal worker",
                    &saved,
                )
            })
            .await;
            let saved = matches!(result, Ok(Ok(())));
            viewer.failure_saved.store(saved, Ordering::Release);
            if !saved {
                log::warn!("Could not persist terminal failure {}", failure.reference);
            }
            failure
        })
        .await
}

async fn transport(socket: WebSocket, viewer: Arc<Viewer>, generation: u64, mut sent: u64) {
    let (mut writer, mut reader) = socket.split();
    let hello = delivery_checkpoint(viewer.as_ref(), "hello", Some(generation));
    if writer
        .send(Message::Text(hello.to_string().into()))
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
                    final_reply(&viewer, error).await.to_string().into(),
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
            _=heartbeat.tick()=>{if writer.send(Message::Text(delivery_checkpoint(&viewer,"heartbeat",None).to_string().into())).await.is_err(){break;}},
            frame=reader.next()=>{
                let Some(Ok(frame))=frame else {break;};
                *viewer.touched.lock().unwrap()=Instant::now();
                let Message::Text(text)=frame else {if matches!(frame,Message::Close(_)){break;}continue;};
                let result:Result<Option<serde_json::Value>>=async {
                    match serde_json::from_str::<Request>(&text)? {
                        Request::Input{generation:g,input}=>{
                            ensure!(g==generation,"Stale transport");
                            let (done,reply)=oneshot::channel();
                            viewer.input.send(Delivery{generation,input,done}).await.map_err(|_|anyhow::anyhow!("Attachment ended"))?;
                            let input_ack=reply.await??;
                            let mut checkpoint=delivery_checkpoint(&viewer,"ack",None);
                            // A newer transport may already have delivered another record.
                            if checkpoint["input_ack"]!=input_ack {checkpoint["replaceable"]=json!(false);}
                            checkpoint["input_ack"]=json!(input_ack);
                            Ok(Some(checkpoint))
                        },
                        Request::Ack{generation:g,applied}=>{
                            let mut journal=viewer.journal.lock().unwrap();
                            ensure!(g==generation && g==journal.generation,"Stale transport");
                            journal.acknowledge(applied)?;Ok(None)
                        },
                        Request::Retire{generation:g}=>{
                            {
                                let mut journal=viewer.journal.lock().unwrap();
                                ensure!(g==generation && g==journal.generation,"Stale transport");
                                if viewer.parser_pending.load(Ordering::Acquire) {
                                    return Ok(Some(json!({"type":"retirement_rejected","message":"An incomplete terminal sequence is still buffered. Return to Terminal to finish it."})));
                                }
                                journal.failure=Some(RETIRED.into());
                            }
                            viewer.notify.notify_waiters();
                            Ok(Some(final_reply(&viewer, RETIRED.into()).await))
                        }
                        Request::Close{generation:g}=>{
                            let mut journal=viewer.journal.lock().unwrap();ensure!(g==generation && g==journal.generation,"Stale transport");
                            journal.failure=Some("Terminal viewer closed".into());viewer.notify.notify_waiters();Ok(None)
                        }
                    }
                }.await;
                match result {
                    Ok(Some(reply))=>{let retired=reply["type"]=="retired";if writer.send(Message::Text(reply.to_string().into())).await.is_err()||retired{break;}},
                    Ok(None)=>{},Err(error)=>{let _=writer.send(Message::Text(final_reply(&viewer,error.to_string()).await.to_string().into())).await;break;}
                }
            }
        }
    }
}

// A browser may replace an expired viewer only after every input record was
// acknowledged and the parser had no unfinished escape or paste sequence.
// Snapshot under the journal lock, which also protects input parsing/dispatch.
fn delivery_checkpoint(viewer: &Viewer, kind: &str, generation: Option<u64>) -> serde_json::Value {
    let journal = viewer.journal.lock().unwrap();
    let mut message = json!({
        "type": kind,
        "input_ack": journal.input_ack(),
        "replaceable": journal.failure.is_none() && !viewer.parser_pending.load(Ordering::Acquire),
    });
    if let Some(generation) = generation {
        message["generation"] = json!(generation);
    }
    message
}

async fn attachment(
    worker: Worker,
    id: String,
    viewer: Arc<Viewer>,
    mut input: mpsc::Receiver<Delivery>,
    rows: Option<u16>,
    cols: Option<u16>,
    wheel_lines: u32,
    hidden: bool,
) {
    let app = &worker.app;
    let os = match app
        .client_os_api_factory
        .create_client_os_api()
        .map_err(|e| e.to_string())
    {
        Ok(os) => os,
        Err(error) => {
            viewer.journal.lock().unwrap().failure = Some(error.to_string());
            report_failure(&viewer, &error.to_string()).await;
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
        table
            .client_id_to_channels
            .get_mut(&id)
            .unwrap()
            .may_create_session = viewer.may_create_session;
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
        })
        .filter(has_room),
        None,
        app.pending_welcome_sessions.clone(),
        app.sharing_recovery.clone(),
        hidden,
    );
    if !matches!(
        tokio::time::timeout(Duration::from_secs(30), attachment).await,
        Ok(Ok(()))
    ) {
        viewer.journal.lock().unwrap().failure =
            Some("Terminal attachment failed or timed out".into());
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
    os.remember_viewer_hidden(hidden);
    let mut handing_off = false;
    let mut seen_reconnections = 0;
    loop {
        {
            let mut journal = viewer.journal.lock().unwrap();
            if journal.failure.is_some() {
                break;
            }
            if std::mem::take(&mut journal.redraw) {
                os.send_to_server(ClientToServerMsg::Redraw);
            }
        }
        tokio::select! {
            // Typing waits here while the session moves to a new engine.
            Some(delivery)=input.recv(), if !handing_off && !os.is_reconnecting() && os.reconnections()==seen_reconnections =>{
                let mut accepted=false;
                let result=async {
                    let focus;
                    {
                        let journal=viewer.journal.lock().unwrap();
                        if !journal.accepts(delivery.generation,&delivery.input)? { return Ok(journal.input_ack()); }
                        accepted=true;
                        if delivery.input.channel=="terminal" {
                            let mut context=viewer.failure_context.lock().unwrap();
                            let target=context.target;
                            *context=FailureContext::new("input");context.target=target;drop(context);
                            if !viewer.read_only { parse_stdin(delivery.input.data.as_bytes(),os.clone(),&mut mouse,&mut stdin); }
                            held_since=Instant::now();focus=None;
                        } else {
                            let payload:WebClientToWebServerControlMessagePayload=serde_json::from_str(&delivery.input.data)?;
                            if let WebClientToWebServerControlMessagePayload::SetViewerHidden{hidden}=&payload {os.remember_viewer_hidden(*hidden);}
                            // Geometry does not change the input target. It may arrive
                            // between paste chunks during a mode switch or resize.
                            // Leave the parser untouched; routing/action controls must
                            // still fail closed until the sequence is complete.
                            if !matches!(payload,
                                WebClientToWebServerControlMessagePayload::TerminalResize(_) |
                                WebClientToWebServerControlMessagePayload::TerminalMetrics(_) |
                                WebClientToWebServerControlMessagePayload::SetTabViewport { .. } |
                                WebClientToWebServerControlMessagePayload::SetViewerHidden { .. }
                            ) {
                                if stdin.pending_finalize() { stdin.finalize(&*os,&mut mouse); }
                                ensure!(!stdin.has_pending_bytes(),"Incomplete terminal sequence before a control command; attachment stopped to preserve its target pane");
                            }
                            focus=match &payload {WebClientToWebServerControlMessagePayload::FocusPane{pane_id,is_plugin}=>Some((*pane_id,*is_plugin)),_=>None};
                            let mut context=FailureContext::new(if focus.is_some(){"focus"}else{"control"});
                            context.target=focus.or(viewer.failure_context.lock().unwrap().target);
                            *viewer.failure_context.lock().unwrap()=context;
                            if let Some(message)=control_payload_to_server_msg(payload,app.config.lock().unwrap().options.default_shell.clone()) {
                                if let Some(target)=focus {
                                    send_focus_probe(&*os,target);
                                } else {
                                    os.send_to_server(message);
                                }
                            }
                            if focus.is_some() {if let Some(refresh)=app.connection_table.lock().unwrap().client_id_to_channels.get(&id).and_then(|c|c.recovery_metadata_refresh.clone()){refresh.request();}}
                        }
                        viewer.parser_pending.store(stdin.has_pending_bytes(),Ordering::Release);
                        ensure!(os.send_failure().is_none(),"Terminal IPC failed; input delivery is uncertain");
                    }
                    if let Some(target)=focus {
                        confirm_focus(&viewer,target,&mut output,&mut controls,|| send_focus_probe(&*os,target)).await?;
                    }
                    // The action was dispatched before a newer generation could
                    // fence it. Commit before processing its queued retry.
                    let mut journal=viewer.journal.lock().unwrap();
                    ensure!(journal.failure.is_none(),"Terminal attachment failed during input delivery");
                    journal.input=Some(delivery.input);
                    Ok(journal.input_ack())
                }.await;
                if let Err(error)=&result { viewer.journal.lock().unwrap().delivery_failed(accepted,error.to_string());viewer.notify.notify_waiters(); }
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
                viewer.parser_pending.store(stdin.has_pending_bytes(),Ordering::Release);
                handing_off=zellij_utils::handoff::in_progress(&worker.session);
                let reconnections=os.reconnections();
                // Until the move is final this engine can still be replaced.
                if reconnections!=seen_reconnections && !handing_off && !os.is_reconnecting() {
                    seen_reconnections=reconnections;
                    // A new engine puts this viewer on the first tab. Typing waits until
                    // it is back on its own pane, and is never sent anywhere else.
                    let target=viewer.failure_context.lock().unwrap().target;
                    if let Some(target)=target {
                        send_focus_probe(&*os,target);
                        if let Err(error)=confirm_focus(&viewer,target,&mut output,&mut controls,|| send_focus_probe(&*os,target)).await {
                            viewer.journal.lock().unwrap().failure=Some(format!("Could not reselect the terminal pane after a new engine took over: {error}"));
                        }
                    }
                }
                if let Some(error)=os.send_failure().filter(|_|!handing_off&&!os.is_reconnecting()){viewer.journal.lock().unwrap().failure=Some(format!("Terminal IPC failed: {error}"));}
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
    let failure = viewer.journal.lock().unwrap().failure.clone();
    if let Some(error) = failure.filter(|e| e != RETIRED && e != "Terminal viewer closed") {
        report_failure(&viewer, &error).await;
    }
    viewer.notify.notify_waiters();
    os.send_to_server(ClientToServerMsg::ClientExited);
    app.connection_table.lock().unwrap().remove_client(&id);
    // Keep the generation so an existing transport can deliver its final error.
    viewer.journal.lock().unwrap().release_payloads();
    viewer.retired.send_replace(true);
    // Retain a lightweight receipt beyond the browser retry deadline, including
    // explicit recovery after a pause. Other failures need only brief delivery.
    let retention = if viewer.journal.lock().unwrap().failure.as_deref() == Some(RETIRED) {
        DETACHED_TTL
    } else {
        Duration::from_secs(10)
    };
    tokio::time::sleep(retention).await;
    worker.views.lock().unwrap().remove(&id);
}

fn send_focus_probe(os: &dyn crate::os_input_output::ClientOsApi, target: (u32, bool)) {
    let message = control_payload_to_server_msg(
        WebClientToWebServerControlMessagePayload::FocusPane {
            pane_id: target.0,
            is_plugin: target.1,
        },
        None,
    )
    .expect("FocusPane always maps to an engine action");
    os.send_to_server(message.clone());
    os.send_to_server(message);
    os.send_to_server(ClientToServerMsg::Action {
        action: zellij_utils::input::actions::Action::CurrentTabInfo { output_json: false },
        terminal_id: None,
        client_id: None,
        is_cli_client: false,
    });
}

/// Every focus transaction issues two identical focus actions, followed by this
/// connection's reserved plain CurrentTabInfo query. The second action reports
/// "already focused" only after the engine actually selects that pane. Drain to
/// the query response before acknowledging so no duplicate reply leaks into the
/// next transaction. Cached MobileState is never evidence of focus success.
async fn confirm_focus(
    viewer: &Viewer,
    target: (u32, bool),
    output: &mut mpsc::UnboundedReceiver<String>,
    controls: &mut mpsc::UnboundedReceiver<Message>,
    mut retry: impl FnMut(),
) -> Result<()> {
    let deadline = tokio::time::sleep(Duration::from_secs(10));
    tokio::pin!(deadline);
    let mut permission = tokio::time::interval(Duration::from_secs(1));
    let mut confirmation = FocusConfirmation::new(target);
    loop {
        ensure!(
            viewer.journal.lock().unwrap().failure.is_none(),
            "Terminal attachment failed while selecting pane"
        );
        tokio::select! {
            _=&mut deadline=>anyhow::bail!("Terminal pane selection was not confirmed; queued typing was not sent"),
            _=permission.tick()=>ensure!(credential_is_read_only(&viewer.owner).ok()==Some(viewer.read_only),"Terminal permission was revoked"),
            Some(text)=output.recv()=>{viewer.journal.lock().unwrap().emit("terminal",text);viewer.notify.notify_waiters();},
            message=controls.recv()=>{
                let Some(Message::Text(text))=message else {anyhow::bail!("Terminal ended while selecting pane");};
                let value:serde_json::Value=serde_json::from_str(&text)?;
                let reply = confirmation.consume(&value);
                {
                    let mut context=viewer.failure_context.lock().unwrap();
                    context.focus_confirmed=confirmation.confirmed;
                    context.query_received |= value["type"]=="Log" && focus_marker(&value["lines"]);
                }
                match reply? {
                    FocusReply::Private=>continue,
                    FocusReply::Retry=>{retry();continue;},
                    FocusReply::Complete=>{
                        viewer.journal.lock().unwrap().emit("control",json!({"type":"FocusConfirmed","payload":{"pane_id":target.0,"is_plugin":target.1}}).to_string());
                        viewer.notify.notify_waiters();return Ok(());
                    },
                    FocusReply::Forward=>{},
                }
                viewer.journal.lock().unwrap().emit("control",text.to_string());viewer.notify.notify_waiters();
            }
        }
    }
}

#[derive(Debug, PartialEq)]
enum FocusReply {
    Retry,
    Forward,
    Private,
    Complete,
}
struct FocusConfirmation {
    pane: String,
    positive: String,
    confirmed: bool,
    attempts: usize,
}
impl FocusConfirmation {
    fn new(target: (u32, bool)) -> Self {
        let pane = format!(
            "{}({})",
            if target.1 { "Plugin" } else { "Terminal" },
            target.0
        );
        Self {
            positive: format!("Pane {pane} is already focused"),
            pane,
            confirmed: false,
            attempts: 1,
        }
    }
    fn consume(&mut self, value: &serde_json::Value) -> Result<FocusReply> {
        if value["type"] == "LogError" {
            for line in value["lines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|line| line.as_str())
            {
                if line == self.positive {
                    self.confirmed = true;
                } else {
                    ensure!(
                        !line.contains(&self.pane),
                        "Requested terminal pane could not be selected; queued typing was not sent"
                    );
                }
            }
            if value["lines"].as_array().is_some_and(|lines| {
                !lines.is_empty()
                    && lines
                        .iter()
                        .all(|line| line.as_str() == Some(&self.positive))
            }) {
                return Ok(FocusReply::Private);
            }
        }
        if value["type"] == "Log" && focus_marker(&value["lines"]) {
            if self.confirmed {
                return Ok(FocusReply::Complete);
            }
            // The engine drops an action's completion receiver after one second.
            // A busy screen can apply both focus actions after their receivers
            // expire, then answer this barrier without delivering either reply.
            // Re-probe only after draining the barrier, preserving queued typing
            // and the original deadline until a fresh native reply confirms it.
            ensure!(
                self.attempts < 3,
                "Engine did not confirm terminal pane selection; queued typing was not sent"
            );
            self.attempts += 1;
            Ok(FocusReply::Retry)
        } else {
            Ok(FocusReply::Forward)
        }
    }
}

fn focus_marker(lines: &serde_json::Value) -> bool {
    let Some(lines) = lines.as_array() else {
        return false;
    };
    lines.len() == 3
        && lines[0].as_str().is_some_and(|s| s.starts_with("name: "))
        && lines[1]
            .as_str()
            .and_then(|s| s.strip_prefix("id: "))
            .is_some_and(|s| s.parse::<u64>().is_ok())
        && lines[2]
            .as_str()
            .and_then(|s| s.strip_prefix("position: "))
            .is_some_and(|s| s.parse::<u64>().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn viewer() -> Viewer {
        let (input, incoming) = mpsc::channel(1);
        Viewer {
            journal: Mutex::new(Journal::default()),
            notify: Notify::new(),
            input,
            owner: String::new(),
            read_only: false,
            may_create_session: false,
            touched: Mutex::new(Instant::now()),
            incoming: Mutex::new(Some(incoming)),
            retired: watch::channel(true).0,
            parser_pending: AtomicBool::new(false),
            session: "fixture".into(),
            failure_context: Mutex::new(FailureContext::new("attach")),
            failure_report: tokio::sync::OnceCell::new(),
            failure_saved: AtomicBool::new(false),
        }
    }
    #[test]
    fn switchboard_attachment_checkpoint_requires_a_clean_parser_and_live_journal() {
        let viewer = viewer();
        assert_eq!(
            delivery_checkpoint(&viewer, "hello", Some(1)),
            json!({
                "type":"hello", "generation":1, "input_ack":0, "replaceable":true
            })
        );
        viewer.journal.lock().unwrap().input = Some(Input {
            seq: 1,
            channel: "terminal".into(),
            data: "\u{1b}[200~partial".into(),
        });
        viewer.parser_pending.store(true, Ordering::Release);
        let checkpoint = delivery_checkpoint(&viewer, "ack", None);
        assert_eq!(checkpoint["input_ack"], 1);
        assert_eq!(checkpoint["replaceable"], false);
        viewer.parser_pending.store(false, Ordering::Release);
        assert_eq!(
            delivery_checkpoint(&viewer, "heartbeat", None)["replaceable"],
            true
        );
        viewer.journal.lock().unwrap().failure = Some("failed".into());
        assert_eq!(
            delivery_checkpoint(&viewer, "heartbeat", None)["replaceable"],
            false
        );
    }
    #[tokio::test]
    async fn switchboard_attachment_intentional_close_and_retirement_do_not_report_failure() {
        let viewer = viewer();
        assert_eq!(
            final_reply(&viewer, "Terminal viewer closed".into()).await["type"],
            "retired"
        );
        assert_eq!(
            final_reply(&viewer, RETIRED.into()).await["type"],
            "retired"
        );
        assert!(viewer.failure_report.get().is_none());
    }
    #[test]
    fn switchboard_attachment_focus_recovers_lost_completion_without_trusting_metadata() {
        let marker = json!({"type":"Log","lines":["name: tab","id: 0","position: 0"]});
        let snapshot =
            json!({"type":"MobileState","payload":{"active_pane":{"pane_id":7,"is_plugin":false}}});
        let yes = json!({"type":"LogError","lines":["Pane Terminal(7) is already focused"]});
        let mut focus = FocusConfirmation::new((7, false));
        // Both native completion receivers expired while the screen was busy.
        // Even a matching snapshot cannot release the queued input.
        for _ in 0..2 {
            assert_eq!(focus.consume(&snapshot).unwrap(), FocusReply::Forward);
            assert_eq!(focus.consume(&marker).unwrap(), FocusReply::Retry);
        }
        // A fresh probe finally receives native proof. Its barrier must also
        // arrive before the caller can acknowledge focus and drain input.
        assert_eq!(focus.consume(&yes).unwrap(), FocusReply::Private);
        assert_eq!(focus.consume(&marker).unwrap(), FocusReply::Complete);
        let mut next = FocusConfirmation::new((7, false));
        assert_eq!(next.consume(&marker).unwrap(), FocusReply::Retry);
    }

    #[test]
    fn switchboard_attachment_focus_ignores_stale_state_and_drains_duplicate_confirmations() {
        let marker = json!({"type":"Log","lines":["name: tab","id: 0","position: 0"]});
        let stale =
            json!({"type":"MobileState","payload":{"active_pane":{"pane_id":7,"is_plugin":false}}});
        let mut focus = FocusConfirmation::new((7, false));
        assert_eq!(focus.consume(&stale).unwrap(), FocusReply::Forward);
        assert!(
            focus.consume(&marker).unwrap() == FocusReply::Retry,
            "Cached metadata cannot prove focus or release typing"
        );
        let yes = json!({"type":"LogError","lines":["Pane Terminal(7) is already focused"]});
        assert_eq!(focus.consume(&yes).unwrap(), FocusReply::Private);
        assert_eq!(focus.consume(&yes).unwrap(), FocusReply::Private);
        assert_eq!(focus.consume(&marker).unwrap(), FocusReply::Complete);
        let mut missing = FocusConfirmation::new((7, false));
        missing.consume(&yes).unwrap();
        assert!(missing
            .consume(&json!({"type":"LogError","lines":["Pane with id Terminal(7) not found"]}))
            .is_err());
        let mut wrong = FocusConfirmation::new((8, false));
        wrong.consume(&yes).unwrap();
        assert_eq!(wrong.consume(&marker).unwrap(), FocusReply::Retry);
        assert_eq!(wrong.consume(&marker).unwrap(), FocusReply::Retry);
        assert!(wrong.consume(&marker).is_err());
    }
}
