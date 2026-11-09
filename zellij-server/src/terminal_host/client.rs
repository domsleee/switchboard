//! The engine's side of the terminal host: a PTY backend whose terminals live
//! in the host process.
use super::boundary::SequenceTracker;
use super::protocol::{
    control, parse, read_frame, write_frame, Channel, CommandSpec, Event, Frame, Hello, Reply,
    Request, RequestEnvelope, PROTOCOL,
};
use super::{connect_endpoint, new_token, HostDirectory};
use crate::os_input_output::{pane_terminal_type, AsyncReader};
use crate::panes::PaneId;
use async_trait::async_trait;
use interprocess::local_socket::Stream;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    mpsc, Arc, Condvar, Mutex,
};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use zellij_utils::{envs, errors::prelude::*, errors::ZellijError, input::command::RunCommand};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY: Duration = Duration::from_millis(10);
const MAX_WRITE: usize = 64 * 1024;

type QuitCallback = Box<dyn Fn(PaneId, Option<i32>, RunCommand) + Send>;

struct Route {
    output: UnboundedSender<(u64, Vec<u8>)>,
    quit: QuitCallback,
    command: RunCommand,
}

/// How far a terminal's output has reached Screen.
struct Progress {
    tracker: Mutex<SequenceTracker>,
    changed: Condvar,
}

impl Progress {
    fn new(position: u64) -> Arc<Self> {
        Arc::new(Self {
            tracker: Mutex::new(SequenceTracker::new(position)),
            changed: Condvar::new(),
        })
    }

    fn record(&self, bytes: &[u8]) {
        self.tracker.lock().unwrap().advance(bytes);
        self.changed.notify_all();
    }

    fn wait_for(&self, position: u64, deadline: Instant) -> bool {
        let mut tracker = self.tracker.lock().unwrap();
        while tracker.position() < position {
            let wait = deadline.saturating_duration_since(Instant::now());
            if wait.is_zero() {
                return false;
            }
            tracker = self.changed.wait_timeout(tracker, wait).unwrap().0;
        }
        true
    }
}

struct Waiter {
    reply: mpsc::Sender<Reply>,
    /// Installed when `Spawned` arrives, so output from a previous process in
    /// this terminal can never reach the new reader.
    route: Option<(u32, Route)>,
}

struct Connection {
    commands: Mutex<Option<Stream>>,
    /// `None` once the host is lost, so no request can wait for a reply
    /// that the finished event reader will never deliver.
    waiters: Mutex<Option<HashMap<u64, Waiter>>>,
    routes: Mutex<HashMap<u32, Route>>,
    next_request: AtomicU64,
    progress: Mutex<HashMap<u32, Arc<Progress>>>,
    paused: Mutex<Option<mpsc::Sender<Vec<(u32, u64)>>>>,
    /// Exits wait here during a handoff, so that a terminal cannot close while
    /// it is between engines.
    held_exits: Mutex<Option<Vec<(u32, Option<i32>)>>>,
    /// This engine is leaving on purpose, and its terminals carry on.
    detached: AtomicBool,
}

/// A running terminal host. Cloning shares the connection.
#[derive(Clone)]
pub struct HostedPtyBackend {
    connection: Arc<Connection>,
}

impl HostedPtyBackend {
    /// Start a host process for this session and connect to it.
    pub fn start() -> io::Result<Self> {
        let directory = HostDirectory::create()?;
        super::spawn_host_process(directory.path())?;
        Self::connect(&directory.endpoint(), &directory.read_token()?)
    }

    pub(super) fn connect(endpoint: &PathBuf, token: &str) -> io::Result<Self> {
        let deadline = Instant::now() + CONNECT_TIMEOUT;
        let pair = new_token();
        let mut commands = connect_with_retry(endpoint, deadline)?;
        write_hello(&mut commands, token, &pair, Channel::Commands)?;
        let mut events = connect_with_retry(endpoint, deadline)?;
        write_hello(&mut events, token, &pair, Channel::Events)?;
        match read_frame(&mut events)? {
            Frame::Control(bytes) => match parse::<Event>(&bytes)? {
                Event::Welcome { protocol, .. } if protocol == PROTOCOL => {},
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unsupported terminal host: {other:?}"),
                    ))
                },
            },
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "terminal host did not welcome this engine",
                ))
            },
        }
        let connection = Arc::new(Connection {
            commands: Mutex::new(Some(commands)),
            waiters: Mutex::new(Some(HashMap::new())),
            routes: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            progress: Mutex::new(HashMap::new()),
            paused: Mutex::new(None),
            held_exits: Mutex::new(None),
            detached: AtomicBool::new(false),
        });
        std::thread::Builder::new()
            .name("terminal_host_events".into())
            .spawn({
                let connection = connection.clone();
                move || connection.read_events(events)
            })?;
        Ok(Self { connection })
    }

    pub fn spawn_terminal(
        &self,
        cmd: RunCommand,
        failover_cmd: Option<RunCommand>,
        quit_cb: QuitCallback,
        terminal_id: u32,
    ) -> Result<(Box<dyn AsyncReader>, u32)> {
        let (output, receiver) = unbounded_channel();
        let request = Request::Spawn {
            terminal_id,
            command: command_spec(&cmd),
            failover: failover_cmd.as_ref().map(command_spec),
            env: pane_environment(),
        };
        let route = Route {
            output,
            quit: quit_cb,
            command: cmd.clone(),
        };
        match self.connection.call(request, Some((terminal_id, route)))? {
            Reply::Spawned { pid } => Ok((
                self.connection
                    .reader(terminal_id, receiver, Vec::new(), Progress::new(0)),
                pid,
            )),
            Reply::CommandNotFound => Err(ZellijError::CommandNotFound {
                terminal_id,
                command: cmd.command.to_string_lossy().to_string(),
            })
            .context("failed to spawn terminal"),
            other => Err(anyhow!("terminal host could not spawn: {other:?}")),
        }
    }

    pub fn set_terminal_size(
        &self,
        terminal_id: u32,
        cols: u16,
        rows: u16,
        width_in_pixels: Option<u16>,
        height_in_pixels: Option<u16>,
    ) -> Result<()> {
        if cols > 0 && rows > 0 {
            self.connection.send(Request::Resize {
                terminal_id,
                cols,
                rows,
                width_in_pixels,
                height_in_pixels,
            })?;
        }
        Ok(())
    }

    pub fn write_to_tty_stdin(&self, terminal_id: u32, buf: &[u8]) -> Result<usize> {
        let id = self.connection.request_id();
        let (reply, receiver) = mpsc::channel();
        self.connection.register(id, reply, None)?;
        // Callers resend whatever is not accepted, and a frame has a size limit.
        let bytes = buf[..buf.len().min(MAX_WRITE)].to_vec();
        self.connection.send_frame(&Frame::Write {
            id,
            terminal_id,
            bytes,
        })?;
        match receive(receiver)? {
            Reply::Written { accepted } => Ok(accepted),
            other => Err(anyhow!("terminal host could not write: {other:?}")),
        }
    }

    pub fn tcdrain(&self, terminal_id: u32) -> Result<()> {
        self.connection
            .call(Request::Drain { terminal_id }, None)
            .map(drop)
    }

    pub fn kill(&self, pid: u32) -> Result<()> {
        self.connection.send(Request::Kill { pid })
    }

    pub fn force_kill(&self, pid: u32) -> Result<()> {
        self.connection.send(Request::ForceKill { pid })
    }

    pub fn send_sigint(&self, pid: u32) -> Result<()> {
        self.connection.send(Request::Interrupt { pid })
    }

    #[cfg(unix)]
    pub fn tcgetpgrp(&self, terminal_id: u32) -> Option<i32> {
        match self
            .connection
            .call(Request::ForegroundProcessGroup { terminal_id }, None)
        {
            Ok(Reply::ForegroundProcessGroup { pgid }) => pgid,
            _ => None,
        }
    }

    /// Takes over a running terminal. The reader yields `snapshot`, then the
    /// terminal's output from `position`.
    pub fn adopt_terminal(
        &self,
        terminal_id: u32,
        snapshot: Vec<u8>,
        position: u64,
        quit_cb: QuitCallback,
        command: RunCommand,
    ) -> Box<dyn AsyncReader> {
        let (output, receiver) = unbounded_channel();
        let route = Route {
            output,
            quit: quit_cb,
            command,
        };
        self.connection
            .routes
            .lock()
            .unwrap()
            .insert(terminal_id, route);
        self.connection
            .reader(terminal_id, receiver, snapshot, Progress::new(position))
    }

    /// Stops output and returns where each terminal's output ended.
    pub fn pause_output(&self, timeout: Duration) -> Result<Vec<(u32, u64)>> {
        let (sender, receiver) = mpsc::channel();
        *self.connection.paused.lock().to_anyhow()? = Some(sender);
        self.connection.send(Request::PauseOutput)?;
        receiver
            .recv_timeout(timeout)
            .map_err(|_| anyhow!("terminal host did not pause output"))
    }

    pub fn resume_output(&self) -> Result<()> {
        self.connection.send(Request::ResumeOutput)
    }

    /// Waits until the output up to these positions has reached Screen.
    pub fn wait_until_delivered(&self, ends: &[(u32, u64)], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let progress = self.connection.progress.lock().unwrap();
        let waiting: Vec<_> = ends
            .iter()
            .filter_map(|(id, end)| Some((progress.get(id)?.clone(), *end)))
            .collect();
        drop(progress);
        waiting
            .iter()
            .all(|(progress, end)| progress.wait_for(*end, deadline))
    }

    /// Where a new parser must start for this terminal, or `None` when no
    /// position would reproduce the state of the screen.
    pub fn resume_position(&self, terminal_id: u32) -> Option<u64> {
        let progress = self.connection.progress.lock().unwrap();
        let tracker = progress.get(&terminal_id)?.tracker.lock().unwrap();
        tracker.resume_position()
    }

    /// Asks the host to keep these terminals, and their output from these
    /// positions, until the handoff ends.
    pub fn begin_handoff(&self, handoff_id: &str, retain_from: Vec<(u32, u64)>) -> Result<()> {
        self.expect_ok(Request::BeginHandoff {
            handoff_id: handoff_id.to_string(),
            retain_from,
        })
    }

    pub fn commit_adoption(&self, handoff_id: &str) -> Result<()> {
        self.expect_ok(Request::CommitAdoption {
            handoff_id: handoff_id.to_string(),
        })
    }

    pub fn abort_handoff(&self, handoff_id: &str) -> Result<()> {
        self.expect_ok(Request::AbortHandoff {
            handoff_id: handoff_id.to_string(),
        })
    }

    /// Stops every terminal and the host, for a real session kill.
    pub fn shutdown(&self) -> Result<()> {
        self.connection.send(Request::Shutdown)
    }

    fn expect_ok(&self, request: Request) -> Result<()> {
        match self.connection.call(request, None)? {
            Reply::Ok => Ok(()),
            other => Err(anyhow!("terminal host refused: {other:?}")),
        }
    }

    /// Exits wait until `release_exits`.
    pub fn hold_exits(&self) {
        let mut held = self.connection.held_exits.lock().unwrap();
        held.get_or_insert_with(Vec::new);
    }

    pub fn release_exits(&self) {
        let held = self.connection.held_exits.lock().unwrap().take();
        for (terminal_id, status) in held.unwrap_or_default() {
            self.connection.finish_terminal(terminal_id, status);
        }
    }

    /// Leaves without stopping anything or reporting any terminal as exited.
    pub fn detach(&self) {
        self.connection.detached.store(true, Ordering::SeqCst);
        self.connection.commands.lock().unwrap().take();
    }

    pub fn clear_terminal_id(&self, terminal_id: u32) {
        self.connection
            .progress
            .lock()
            .unwrap()
            .remove(&terminal_id);
        self.connection.routes.lock().unwrap().remove(&terminal_id);
        let _ = self.connection.send(Request::Close { terminal_id });
    }

    #[cfg(test)]
    pub(super) fn disconnect(&self) {
        self.connection.commands.lock().unwrap().take();
    }

    #[cfg(test)]
    pub(super) fn fail_connection(&self) {
        self.connection.fail_all();
    }
}

impl Connection {
    fn reader(
        self: &Arc<Self>,
        terminal_id: u32,
        receiver: UnboundedReceiver<(u64, Vec<u8>)>,
        snapshot: Vec<u8>,
        progress: Arc<Progress>,
    ) -> Box<dyn AsyncReader> {
        self.progress
            .lock()
            .unwrap()
            .insert(terminal_id, progress.clone());
        Box::new(HostedReader {
            connection: self.clone(),
            terminal_id,
            receiver,
            snapshot_remaining: snapshot.len(),
            leftover: snapshot,
            acknowledge: None,
            progress,
            just_returned: Vec::new(),
        })
    }

    fn request_id(&self) -> u64 {
        self.next_request.fetch_add(1, Ordering::Relaxed)
    }

    fn register(
        &self,
        id: u64,
        reply: mpsc::Sender<Reply>,
        route: Option<(u32, Route)>,
    ) -> Result<()> {
        self.waiters
            .lock()
            .to_anyhow()?
            .as_mut()
            .ok_or_else(|| anyhow!("terminal host connection lost"))?
            .insert(id, Waiter { reply, route });
        Ok(())
    }

    fn send_frame(&self, frame: &Frame) -> Result<()> {
        let mut commands = self.commands.lock().to_anyhow()?;
        let commands = commands
            .as_mut()
            .ok_or_else(|| anyhow!("terminal host disconnected"))?;
        write_frame(commands, frame).context("terminal host connection failed")
    }

    fn send(&self, request: Request) -> Result<()> {
        self.send_frame(&control(&RequestEnvelope { id: 0, request })?)
    }

    fn call(&self, request: Request, route: Option<(u32, Route)>) -> Result<Reply> {
        let id = self.request_id();
        let (reply, receiver) = mpsc::channel();
        self.register(id, reply, route)?;
        self.send_frame(&control(&RequestEnvelope { id, request })?)?;
        receive(receiver)
    }

    fn read_events(&self, mut events: Stream) {
        loop {
            match read_frame(&mut events) {
                Ok(Frame::Output {
                    terminal_id,
                    sequence,
                    bytes,
                }) => {
                    if let Some(route) = self.routes.lock().unwrap().get(&terminal_id) {
                        let _ = route.output.send((sequence, bytes));
                    }
                },
                Ok(Frame::Control(bytes)) => match parse::<Event>(&bytes) {
                    Ok(Event::Reply { id, reply }) => self.finish_request(id, reply),
                    Ok(Event::Exited {
                        terminal_id,
                        status,
                    }) => {
                        let mut held = self.held_exits.lock().unwrap();
                        match held.as_mut() {
                            Some(held) => held.push((terminal_id, status)),
                            None => {
                                drop(held);
                                self.finish_terminal(terminal_id, status);
                            },
                        }
                    },
                    Ok(Event::OutputPaused { ends }) => {
                        if let Some(sender) = self.paused.lock().unwrap().take() {
                            let _ = sender.send(ends);
                        }
                    },
                    Ok(Event::Welcome { .. }) | Err(_) => {},
                },
                Ok(Frame::Write { .. }) => {},
                Err(error) => {
                    log::error!("Lost terminal host connection: {error}");
                    self.fail_all();
                    return;
                },
            }
        }
    }

    fn finish_request(&self, id: u64, reply: Reply) {
        let Some(waiter) = self
            .waiters
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|waiters| waiters.remove(&id))
        else {
            return;
        };
        if let (Reply::Spawned { .. }, Some((terminal_id, route))) = (&reply, waiter.route) {
            self.routes.lock().unwrap().insert(terminal_id, route);
        }
        let _ = waiter.reply.send(reply);
    }

    fn finish_terminal(&self, terminal_id: u32, status: Option<i32>) {
        // The route stays until the pane closes, as later output may still be
        // queued for it. Only the callback must run once.
        let finished = self
            .routes
            .lock()
            .unwrap()
            .get_mut(&terminal_id)
            .map(|route| {
                (
                    std::mem::replace(&mut route.quit, Box::new(|_, _, _| {})),
                    route.command.clone(),
                )
            });
        if let Some((quit, command)) = finished {
            run_quit_callback(quit, terminal_id, status, command);
        }
    }

    fn fail_all(&self) {
        self.waiters.lock().unwrap().take();
        self.commands.lock().unwrap().take();
        let routes: Vec<_> = self.routes.lock().unwrap().drain().collect();
        if self.detached.load(Ordering::SeqCst) {
            return;
        }
        for (terminal_id, route) in routes {
            run_quit_callback(route.quit, terminal_id, None, route.command);
        }
    }
}

/// Exit callbacks send to Screen's bounded queue. Off the event reader, a full
/// queue cannot stop the replies that Screen itself may be waiting for.
fn run_quit_callback(
    quit: QuitCallback,
    terminal_id: u32,
    status: Option<i32>,
    command: RunCommand,
) {
    std::thread::spawn(move || quit(PaneId::Terminal(terminal_id), status, command));
}

fn receive(receiver: mpsc::Receiver<Reply>) -> Result<Reply> {
    receiver
        .recv()
        .map_err(|_| anyhow!("terminal host connection lost"))
}

fn connect_with_retry(endpoint: &PathBuf, deadline: Instant) -> io::Result<Stream> {
    loop {
        match connect_endpoint(endpoint) {
            Ok(stream) => return Ok(stream),
            Err(error) if Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(CONNECT_RETRY),
        }
    }
}

fn write_hello(stream: &mut Stream, token: &str, pair: &str, channel: Channel) -> io::Result<()> {
    write_frame(
        stream,
        &control(&Hello {
            protocol: PROTOCOL,
            token: token.to_string(),
            pair: pair.to_string(),
            channel,
        })?,
    )
}

fn command_spec(command: &RunCommand) -> CommandSpec {
    CommandSpec {
        command: command.command.to_string_lossy().into_owned(),
        args: command.args.clone(),
        cwd: command
            .cwd
            .as_ref()
            .map(|cwd| cwd.to_string_lossy().into_owned()),
    }
}

/// Environment the engine decides for each pane, so changing it never needs a
/// new host. The host merges this over the environment it started with.
fn pane_environment() -> Vec<(String, String)> {
    let (term, colorterm) =
        pane_terminal_type(std::env::var("TERM").ok(), std::env::var("COLORTERM").ok());
    let mut environment = vec![
        ("TERM".to_string(), term),
        ("COLORTERM".to_string(), colorterm),
    ];
    if let Ok(name) = envs::get_session_name() {
        environment.push((envs::SESSION_NAME_ENV_KEY.to_string(), name));
    }
    environment
}

struct HostedReader {
    connection: Arc<Connection>,
    terminal_id: u32,
    receiver: UnboundedReceiver<(u64, Vec<u8>)>,
    leftover: Vec<u8>,
    acknowledge: Option<u64>,
    /// How much of `leftover` is a snapshot, which is not terminal output.
    snapshot_remaining: usize,
    progress: Arc<Progress>,
    just_returned: Vec<u8>,
}

#[async_trait]
impl AsyncReader for HostedReader {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, io::Error> {
        // Reaching the next read means the previous bytes reached Screen.
        if !self.just_returned.is_empty() {
            self.progress.record(&self.just_returned);
            self.just_returned.clear();
        }
        if self.leftover.is_empty() {
            if let Some(sequence) = self.acknowledge.take() {
                let _ = self.connection.send(Request::Ack {
                    terminal_id: self.terminal_id,
                    sequence,
                });
            }
            match self.receiver.recv().await {
                Some((sequence, bytes)) => {
                    self.acknowledge = Some(sequence + bytes.len() as u64);
                    self.leftover = bytes;
                },
                None => return Ok(0),
            }
        }
        let length = self.leftover.len().min(buf.len());
        buf[..length].copy_from_slice(&self.leftover[..length]);
        self.leftover.drain(..length);
        let from_snapshot = length.min(self.snapshot_remaining);
        self.snapshot_remaining -= from_snapshot;
        self.just_returned
            .extend_from_slice(&buf[from_snapshot..length]);
        Ok(length)
    }
}
