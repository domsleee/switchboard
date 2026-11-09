//! The engine's side of the terminal host: a PTY backend whose terminals live
//! in the host process.
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
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Mutex,
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
                Box::new(HostedReader {
                    connection: self.connection.clone(),
                    terminal_id,
                    receiver,
                    leftover: Vec::new(),
                    acknowledge: None,
                }) as Box<dyn AsyncReader>,
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

    pub fn clear_terminal_id(&self, terminal_id: u32) {
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
                    }) => self.finish_terminal(terminal_id, status),
                    Ok(Event::Welcome { .. }) | Ok(Event::OutputPaused { .. }) | Err(_) => {},
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
}

#[async_trait]
impl AsyncReader for HostedReader {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize, io::Error> {
        if self.leftover.is_empty() {
            // Reaching the next read means the previous bytes reached Screen.
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
        Ok(length)
    }
}
