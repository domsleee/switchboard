//! The terminal host process. It owns terminals and buffers their output, and
//! knows nothing about layouts, VT parsing or clients. It cannot be replaced
//! without losing its shells, so anything that may need fixing belongs in the
//! engine instead.
use super::buffer::OutputBuffer;
use super::protocol::{
    control, parse, read_frame, write_frame, Channel, CommandSpec, Event, Frame, Hello, Reply,
    Request, RequestEnvelope, PROTOCOL,
};
use super::{bind_endpoint, endpoint_for};
use crate::os_input_output::{AsyncReader, PtyBackendImpl};
use interprocess::local_socket::{prelude::*, Stream};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tokio::runtime::Runtime;
use tokio::sync::Notify;
use tokio::task::AbortHandle;
use zellij_utils::{errors::ZellijError, input::command::RunCommand};

const ENGINE_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an exit waits for the terminal's final output to be read.
const EXIT_OUTPUT_GRACE: Duration = Duration::from_millis(200);

struct Terminal {
    instance: u64,
    buffer: OutputBuffer,
    announced: bool,
    pid: u32,
    reader: Option<AbortHandle>,
    reader_done: bool,
    room: Arc<Notify>,
    exited: Option<Option<i32>>,
    exit_sent: bool,
}

struct Outgoing {
    id: u64,
    reply: Reply,
    announce: Option<u32>,
}

#[derive(Default)]
struct State {
    terminals: BTreeMap<u32, Terminal>,
    replies: VecDeque<Outgoing>,
    next_instance: u64,
    last_sent: u32,
    stopping: bool,
}

impl State {
    fn next_frame(&mut self) -> io::Result<Option<Frame>> {
        if let Some(outgoing) = self.replies.pop_front() {
            if let Some(terminal) = outgoing.announce.and_then(|id| self.terminals.get_mut(&id)) {
                terminal.announced = true;
            }
            return control(&Event::Reply {
                id: outgoing.id,
                reply: outgoing.reply,
            })
            .map(Some);
        }
        // Start after the last terminal served so a busy one cannot starve others.
        let ids: Vec<u32> = self
            .terminals
            .range(self.last_sent.saturating_add(1)..)
            .chain(self.terminals.range(..=self.last_sent))
            .map(|(id, _)| *id)
            .collect();
        for terminal_id in ids {
            let terminal = self.terminals.get_mut(&terminal_id).unwrap();
            if !terminal.announced {
                continue;
            }
            if let Some((sequence, bytes)) = terminal.buffer.take_unsent() {
                self.last_sent = terminal_id;
                return Ok(Some(Frame::Output {
                    terminal_id,
                    sequence,
                    bytes,
                }));
            }
            if let (Some(status), false, true) = (
                terminal.exited,
                terminal.exit_sent,
                terminal.buffer.is_fully_sent(),
            ) {
                terminal.exit_sent = true;
                return control(&Event::Exited {
                    terminal_id,
                    status,
                })
                .map(Some);
            }
        }
        Ok(None)
    }
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    backend: PtyBackendImpl,
    runtime: Runtime,
}

impl Shared {
    fn reply(&self, id: u64, reply: Reply, announce: Option<u32>) {
        if id != 0 {
            self.state.lock().unwrap().replies.push_back(Outgoing {
                id,
                reply,
                announce,
            });
            self.changed.notify_all();
        }
    }

    fn write_events(&self, mut events: Stream) {
        loop {
            let frame = {
                let mut state = self.state.lock().unwrap();
                loop {
                    if state.stopping {
                        return;
                    }
                    match state.next_frame() {
                        Ok(Some(frame)) => break frame,
                        Ok(None) => state = self.changed.wait(state).unwrap(),
                        Err(error) => {
                            log::error!("Terminal host could not encode an event: {error}");
                            return;
                        },
                    }
                }
            };
            if write_frame(&mut events, &frame).is_err() {
                return;
            }
        }
    }

    fn spawn(
        self: &Arc<Self>,
        id: u64,
        terminal_id: u32,
        command: CommandSpec,
        failover: Option<CommandSpec>,
        env: Vec<(String, String)>,
    ) {
        let instance = self.begin_terminal(terminal_id);
        self.backend.reserve_terminal_id(terminal_id);
        let quit = self.quit_callback(terminal_id, instance);
        let spawned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.backend.spawn_terminal(
                run_command(command),
                failover.map(run_command),
                env,
                quit,
                terminal_id,
            )
        }));
        let reply = match spawned {
            Ok(Ok((reader, pid))) => {
                let pid = pid as u32;
                self.start_reader(terminal_id, instance, pid, reader);
                self.reply(id, Reply::Spawned { pid }, Some(terminal_id));
                return;
            },
            Ok(Err(error)) => match error.downcast_ref::<ZellijError>() {
                Some(ZellijError::CommandNotFound { .. }) => Reply::CommandNotFound,
                _ => Reply::Error {
                    message: format!("{error:#}"),
                },
            },
            Err(_) => Reply::Error {
                message: "terminal spawn panicked".to_string(),
            },
        };
        self.remove_terminal(terminal_id, instance);
        self.backend.clear_terminal_id(terminal_id);
        self.reply(id, reply, None);
    }

    /// Replace any earlier process in this terminal before the new one starts,
    /// because a process can exit before its spawn call returns.
    fn begin_terminal(&self, terminal_id: u32) -> u64 {
        let mut state = self.state.lock().unwrap();
        state.next_instance += 1;
        let instance = state.next_instance;
        let previous = state.terminals.insert(
            terminal_id,
            Terminal {
                instance,
                buffer: OutputBuffer::default(),
                announced: false,
                pid: 0,
                reader: None,
                reader_done: false,
                room: Arc::new(Notify::new()),
                exited: None,
                exit_sent: false,
            },
        );
        if let Some(reader) = previous.and_then(|terminal| terminal.reader) {
            reader.abort();
        }
        instance
    }

    fn quit_callback(
        self: &Arc<Self>,
        terminal_id: u32,
        instance: u64,
    ) -> Box<dyn Fn(crate::panes::PaneId, Option<i32>, RunCommand) + Send> {
        let shared = self.clone();
        Box::new(move |_, status, _| {
            let deadline = Instant::now() + EXIT_OUTPUT_GRACE;
            while Instant::now() < deadline
                && shared.with_terminal(terminal_id, instance, |terminal| !terminal.reader_done)
                    == Some(true)
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            shared.with_terminal(terminal_id, instance, |terminal| {
                terminal.exited = Some(status)
            });
            shared.changed.notify_all();
        })
    }

    fn with_terminal<T>(
        &self,
        terminal_id: u32,
        instance: u64,
        action: impl FnOnce(&mut Terminal) -> T,
    ) -> Option<T> {
        let mut state = self.state.lock().unwrap();
        state
            .terminals
            .get_mut(&terminal_id)
            .filter(|terminal| terminal.instance == instance)
            .map(action)
    }

    fn start_reader(
        self: &Arc<Self>,
        terminal_id: u32,
        instance: u64,
        pid: u32,
        mut reader: Box<dyn AsyncReader>,
    ) {
        let room = self
            .with_terminal(terminal_id, instance, |terminal| {
                terminal.pid = pid;
                terminal.room.clone()
            })
            .unwrap_or_default();
        let shared = self.clone();
        let task = self.runtime.spawn(async move {
            let mut bytes = vec![0; super::protocol::MAX_OUTPUT_CHUNK];
            loop {
                while shared.with_terminal(terminal_id, instance, |terminal| {
                    !terminal.buffer.has_room()
                }) == Some(true)
                {
                    room.notified().await;
                }
                match reader.read(&mut bytes).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        shared.with_terminal(terminal_id, instance, |terminal| {
                            terminal.buffer.append(&bytes[..count])
                        });
                        shared.changed.notify_all();
                    },
                }
            }
            shared.with_terminal(terminal_id, instance, |terminal| {
                terminal.reader_done = true
            });
            shared.changed.notify_all();
        });
        self.with_terminal(terminal_id, instance, |terminal| {
            terminal.reader = Some(task.abort_handle())
        });
    }

    fn remove_terminal(&self, terminal_id: u32, instance: u64) {
        let mut state = self.state.lock().unwrap();
        if state
            .terminals
            .get(&terminal_id)
            .is_some_and(|terminal| terminal.instance == instance)
        {
            state.terminals.remove(&terminal_id);
        }
    }

    fn close(&self, terminal_id: u32) {
        let removed = self.state.lock().unwrap().terminals.remove(&terminal_id);
        if let Some(reader) = removed.and_then(|terminal| terminal.reader) {
            reader.abort();
        }
        self.backend.clear_terminal_id(terminal_id);
    }

    fn acknowledge(&self, terminal_id: u32, sequence: u64) {
        let mut state = self.state.lock().unwrap();
        if let Some(terminal) = state.terminals.get_mut(&terminal_id) {
            terminal.buffer.acknowledge(sequence);
            terminal.room.notify_one();
        }
        drop(state);
        self.changed.notify_all();
    }

    fn handle(self: &Arc<Self>, envelope: RequestEnvelope) {
        let id = envelope.id;
        let finished = |result: zellij_utils::errors::prelude::Result<()>| match result {
            Ok(()) => Reply::Ok,
            Err(error) => Reply::Error {
                message: format!("{error:#}"),
            },
        };
        match envelope.request {
            Request::Spawn {
                terminal_id,
                command,
                failover,
                env,
            } => {
                let shared = self.clone();
                std::thread::spawn(move || shared.spawn(id, terminal_id, command, failover, env));
            },
            Request::Resize {
                terminal_id,
                cols,
                rows,
                width_in_pixels,
                height_in_pixels,
            } => {
                let reply = finished(self.backend.set_terminal_size(
                    terminal_id,
                    cols,
                    rows,
                    width_in_pixels,
                    height_in_pixels,
                ));
                self.reply(id, reply, None);
            },
            Request::Drain { terminal_id } => {
                // Draining can wait on a child that is blocked writing output,
                // and that output needs this thread to process acknowledgements.
                let shared = self.clone();
                std::thread::spawn(move || {
                    let reply = finished(shared.backend.tcdrain(terminal_id));
                    shared.reply(id, reply, None);
                });
            },
            Request::Kill { pid } => {
                let reply = finished(self.backend.kill(pid));
                self.reply(id, reply, None);
            },
            Request::ForceKill { pid } => {
                let reply = finished(self.backend.force_kill(pid));
                self.reply(id, reply, None);
            },
            Request::Interrupt { pid } => {
                let reply = finished(self.backend.send_sigint(pid));
                self.reply(id, reply, None);
            },
            Request::ForegroundProcessGroup { terminal_id } => {
                #[cfg(unix)]
                let pgid = self.backend.tcgetpgrp(terminal_id);
                #[cfg(not(unix))]
                let pgid = {
                    let _ = terminal_id;
                    None
                };
                self.reply(id, Reply::ForegroundProcessGroup { pgid }, None);
            },
            Request::Close { terminal_id } => {
                self.close(terminal_id);
                self.reply(id, Reply::Ok, None);
            },
            Request::Ack {
                terminal_id,
                sequence,
            } => self.acknowledge(terminal_id, sequence),
        }
    }

    fn read_commands(self: &Arc<Self>, mut commands: Stream) {
        loop {
            match read_frame(&mut commands) {
                Ok(Frame::Control(bytes)) => match parse::<RequestEnvelope>(&bytes) {
                    Ok(envelope) => self.handle(envelope),
                    Err(error) => log::error!("Terminal host ignored a request: {error}"),
                },
                Ok(Frame::Write {
                    id,
                    terminal_id,
                    bytes,
                }) => {
                    let reply = match self.backend.write_to_tty_stdin(terminal_id, &bytes) {
                        Ok(accepted) => Reply::Written { accepted },
                        Err(error) => Reply::Error {
                            message: format!("{error:#}"),
                        },
                    };
                    self.reply(id, reply, None);
                },
                Ok(Frame::Output { .. }) => {},
                Err(_) => return,
            }
        }
    }

    /// Losing the engine stops the terminals, as an engine crash does today.
    fn stop_terminals(&self) {
        let terminals = {
            let mut state = self.state.lock().unwrap();
            state.stopping = true;
            std::mem::take(&mut state.terminals)
        };
        self.changed.notify_all();
        for (terminal_id, terminal) in terminals {
            if let Some(reader) = terminal.reader {
                reader.abort();
            }
            if terminal.pid != 0 {
                let _ = self.backend.kill(terminal.pid);
            }
            self.backend.clear_terminal_id(terminal_id);
        }
    }
}

fn run_command(command: CommandSpec) -> RunCommand {
    RunCommand {
        command: PathBuf::from(command.command),
        args: command.args,
        cwd: command.cwd.map(PathBuf::from),
        ..Default::default()
    }
}

/// Entry point of the hidden `terminal-host` command.
pub fn run(directory: &Path) -> io::Result<()> {
    // The engine re-enables Ctrl+C for its children in the same way.
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0);
    }
    let result = serve(directory);
    let _ = std::fs::remove_dir_all(directory);
    // The accept thread is still blocked on the listener.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

pub(super) fn serve(directory: &Path) -> io::Result<()> {
    let token = std::fs::read_to_string(directory.join("token"))?;
    let listener = bind_endpoint(&endpoint_for(directory))?;
    let (connected, connections) = mpsc::channel();
    std::thread::Builder::new()
        .name("terminal_host_accept".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let connected = connected.clone();
                let token = token.clone();
                // A connection that never says hello must not block the next one.
                std::thread::spawn(move || {
                    if let Some((hello, stream)) = read_hello(stream, &token) {
                        let _ = connected.send((hello, stream));
                    }
                });
            }
        })?;
    let (commands, events) = wait_for_engine(&connections)?;
    let shared = Arc::new(Shared {
        state: Mutex::new(State::default()),
        changed: Condvar::new(),
        backend: PtyBackendImpl::new()?,
        runtime: tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()?,
    });
    let mut events = events;
    write_frame(
        &mut events,
        &control(&Event::Welcome {
            protocol: PROTOCOL,
            host_pid: std::process::id(),
        })?,
    )?;
    let writer = std::thread::Builder::new()
        .name("terminal_host_events".into())
        .spawn({
            let shared = shared.clone();
            move || shared.write_events(events)
        })?;
    shared.read_commands(commands);
    shared.stop_terminals();
    let _ = writer.join();
    Ok(())
}

fn read_hello(mut stream: Stream, token: &str) -> Option<(Hello, Stream)> {
    let Frame::Control(bytes) = read_frame(&mut stream).ok()? else {
        return None;
    };
    let hello = parse::<Hello>(&bytes).ok()?;
    (hello.token == token && hello.protocol == PROTOCOL).then_some((hello, stream))
}

/// Pair an engine's command and event connections. Windows pipes cannot read
/// and write concurrently through one synchronous handle.
fn wait_for_engine(connections: &mpsc::Receiver<(Hello, Stream)>) -> io::Result<(Stream, Stream)> {
    let deadline = Instant::now() + ENGINE_CONNECT_TIMEOUT;
    let mut waiting: HashMap<String, (Option<Stream>, Option<Stream>)> = HashMap::new();
    loop {
        let timeout = deadline.saturating_duration_since(Instant::now());
        let (hello, stream) = connections
            .recv_timeout(timeout)
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "no engine connected"))?;
        let pair = waiting.entry(hello.pair.clone()).or_default();
        match hello.channel {
            Channel::Commands => pair.0 = Some(stream),
            Channel::Events => pair.1 = Some(stream),
        }
        if let (Some(_), Some(_)) = pair {
            let (commands, events) = waiting.remove(&hello.pair).unwrap();
            return Ok((commands.unwrap(), events.unwrap()));
        }
    }
}
