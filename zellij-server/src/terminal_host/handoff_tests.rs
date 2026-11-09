//! The host's side of a handoff, with real shells and real connections.
use super::protocol::*;
use super::{connect_endpoint, endpoint_for, host, new_token};
use interprocess::local_socket::Stream;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(20);

struct Host {
    _directory: tempfile::TempDir,
    path: PathBuf,
    token: String,
    server: Option<JoinHandle<io::Result<()>>>,
}

fn start(handoff_limit: Duration) -> Host {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().to_path_buf();
    let token = new_token();
    fs::write(path.join("token"), &token).unwrap();
    let serve = path.clone();
    let server = Some(std::thread::spawn(move || {
        host::serve_with(&serve, handoff_limit)
    }));
    Host {
        _directory: directory,
        path,
        token,
        server,
    }
}

struct Engine {
    commands: Stream,
    frames: Receiver<Frame>,
    generation: u64,
    next_id: u64,
    seen: Vec<u8>,
}

fn open(path: &Path) -> Stream {
    let endpoint = endpoint_for(path);
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match connect_endpoint(&endpoint) {
            Ok(stream) => return stream,
            Err(error) if Instant::now() >= deadline => panic!("cannot connect: {error}"),
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

impl Host {
    fn connect(&self) -> io::Result<Engine> {
        let pair = new_token();
        let hello = |channel| {
            control(&Hello {
                protocol: PROTOCOL,
                token: self.token.clone(),
                pair: pair.clone(),
                channel,
            })
            .unwrap()
        };
        let mut commands = open(&self.path);
        write_frame(&mut commands, &hello(Channel::Commands))?;
        let mut events = open(&self.path);
        write_frame(&mut events, &hello(Channel::Events))?;
        let generation = match read_frame(&mut events)? {
            Frame::Control(bytes) => match parse::<Event>(&bytes)? {
                Event::Welcome { generation, .. } => generation,
                other => panic!("unexpected {other:?}"),
            },
            other => panic!("unexpected {other:?}"),
        };
        let (sender, frames) = channel();
        std::thread::spawn(move || {
            while let Ok(frame) = read_frame(&mut events) {
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        Ok(Engine {
            commands,
            frames,
            generation,
            next_id: 1,
            seen: Vec::new(),
        })
    }
}

fn shell_command() -> CommandSpec {
    CommandSpec {
        command: if cfg!(windows) { "cmd.exe" } else { "sh" }.to_string(),
        args: Vec::new(),
        cwd: None,
    }
}

/// A line whose output contains a number the typed text does not.
fn sum_line(a: u32, b: u32) -> (Vec<u8>, String) {
    let line = if cfg!(windows) {
        format!("set /a {a}+{b}\r")
    } else {
        format!("echo $(({a}+{b}))\n")
    };
    (line.into_bytes(), (a + b).to_string())
}

impl Engine {
    fn send(&mut self, request: Request) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        write_frame(
            &mut self.commands,
            &control(&RequestEnvelope { id, request }).unwrap(),
        )
        .unwrap();
        id
    }

    fn type_line(&mut self, line: &[u8]) {
        let id = self.next_id;
        self.next_id += 1;
        let frame = Frame::Write {
            id,
            terminal_id: 1,
            bytes: line.to_vec(),
        };
        write_frame(&mut self.commands, &frame).unwrap();
    }

    fn reply_to(&mut self, id: u64) -> Reply {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            match self.frames.recv_timeout(wait).expect("no reply") {
                Frame::Control(bytes) => match parse::<Event>(&bytes).unwrap() {
                    Event::Reply { id: got, reply } if got == id => return reply,
                    _ => {},
                },
                _ => {},
            }
        }
    }

    fn spawn_shell(&mut self) -> u32 {
        let id = self.send(Request::Spawn {
            terminal_id: 1,
            command: shell_command(),
            failover: None,
            env: Vec::new(),
        });
        match self.reply_to(id) {
            Reply::Spawned { pid } => pid,
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Reads output until `marker`, returning the first position seen and
    /// where the output ended.
    fn read_until(&mut self, marker: &str) -> (u64, u64) {
        let deadline = Instant::now() + TIMEOUT;
        let mut text = Vec::new();
        let mut first = None;
        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            let frame = self.frames.recv_timeout(wait).unwrap_or_else(|_| {
                panic!(
                    "no {marker:?} in output: {}",
                    String::from_utf8_lossy(&text)
                )
            });
            if let Frame::Output {
                sequence, bytes, ..
            } = frame
            {
                first.get_or_insert(sequence);
                text.extend_from_slice(&bytes);
                self.seen.extend_from_slice(&bytes);
                let end = sequence + bytes.len() as u64;
                self.send(Request::Ack {
                    terminal_id: 1,
                    sequence: end,
                });
                if String::from_utf8_lossy(&text).contains(marker) {
                    return (first.unwrap(), end);
                }
            }
        }
    }

    fn pause(&mut self) -> u64 {
        self.send(Request::PauseOutput);
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let wait = deadline.saturating_duration_since(Instant::now());
            if let Frame::Control(bytes) = self.frames.recv_timeout(wait).expect("not paused") {
                if let Event::OutputPaused { ends } = parse::<Event>(&bytes).unwrap() {
                    return ends[0].1;
                }
            }
        }
    }

    fn begin_handoff(&mut self, position: u64) -> Reply {
        let id = self.send(Request::BeginHandoff {
            handoff_id: "h1".to_string(),
            retain_from: vec![(1, position)],
        });
        self.reply_to(id)
    }
}

fn process_alive(pid: u32) -> bool {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

fn wait_for_exit(pid: u32) {
    let deadline = Instant::now() + TIMEOUT;
    while process_alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still running");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn shell_at_prompt(engine: &mut Engine) -> u32 {
    let pid = engine.spawn_shell();
    let (line, marker) = sum_line(40, 2);
    engine.type_line(&line);
    engine.read_until(&marker);
    pid
}

mod through_the_client {
    use super::super::HostedPtyBackend;
    use super::*;
    use crate::os_input_output::AsyncReader;
    use crate::panes::PaneId;
    use std::path::PathBuf;
    use zellij_utils::input::command::RunCommand;

    fn backend(host: &Host) -> HostedPtyBackend {
        HostedPtyBackend::connect(&endpoint_for(&host.path), &host.token).unwrap()
    }

    fn shell() -> RunCommand {
        RunCommand {
            command: PathBuf::from(shell_command().command),
            ..Default::default()
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    fn read_briefly(
        runtime: &tokio::runtime::Runtime,
        reader: &mut Box<dyn AsyncReader>,
    ) -> Option<Vec<u8>> {
        let mut buffer = vec![0; 65536];
        let read = runtime.block_on(async {
            tokio::time::timeout(Duration::from_millis(100), reader.read(&mut buffer)).await
        });
        match read {
            Ok(Ok(count)) => Some(buffer[..count].to_vec()),
            _ => None,
        }
    }

    fn read_until(
        runtime: &tokio::runtime::Runtime,
        reader: &mut Box<dyn AsyncReader>,
        marker: &str,
    ) -> Vec<u8> {
        let deadline = Instant::now() + TIMEOUT;
        let mut output = Vec::new();
        while !String::from_utf8_lossy(&output).contains(marker) {
            assert!(
                Instant::now() < deadline,
                "no {marker:?} in {}",
                String::from_utf8_lossy(&output)
            );
            output.extend(read_briefly(runtime, reader).unwrap_or_default());
        }
        output
    }

    fn type_all(backend: &HostedPtyBackend, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            let accepted = backend.write_to_tty_stdin(1, bytes).unwrap();
            bytes = &bytes[accepted..];
        }
    }

    #[test]
    fn a_detached_terminal_is_adopted_and_keeps_running() {
        let host = start(TIMEOUT);
        let runtime = runtime();
        let old = backend(&host);
        let (old_exit, old_exited) = channel();
        let (mut old_reader, pid) = old
            .spawn_terminal(
                shell(),
                None,
                Box::new(move |pane, _, _| {
                    let _ = old_exit.send(pane);
                }),
                1,
            )
            .unwrap();
        let (line, marker) = sum_line(40, 2);
        type_all(&old, &line);
        read_until(&runtime, &mut old_reader, &marker);

        let ends = old.pause_output(TIMEOUT).unwrap();
        let deadline = Instant::now() + TIMEOUT;
        while !old.wait_until_delivered(&ends, Duration::ZERO) {
            assert!(Instant::now() < deadline, "output never reached the screen");
            read_briefly(&runtime, &mut old_reader);
        }
        let position = old.resume_position(1).expect("a resumable position");
        old.begin_handoff("h1", vec![(1, position)]).unwrap();
        old.detach();
        assert!(
            old_exited.recv_timeout(Duration::from_millis(400)).is_err(),
            "detaching reported the terminal as exited"
        );
        assert!(process_alive(pid));

        let new = backend(&host);
        new.hold_exits();
        let (new_exit, new_exited) = channel();
        let mut new_reader = new.adopt_terminal(
            1,
            position,
            Box::new(move |pane, status, _| {
                let _ = new_exit.send((pane, status));
            }),
            shell(),
        );
        new.resume_output().unwrap();
        let (line, marker) = sum_line(100, 23);
        type_all(&new, &line);
        read_until(&runtime, &mut new_reader, &marker);

        let exit: &[u8] = if cfg!(windows) { b"exit\r" } else { b"exit\n" };
        type_all(&new, exit);
        assert!(
            new_exited.recv_timeout(Duration::from_secs(1)).is_err(),
            "an exit was reported during the handoff"
        );
        new.commit_adoption("h1").unwrap();
        new.release_exits();
        let (pane, _) = new_exited.recv_timeout(TIMEOUT).unwrap();
        assert_eq!(pane, PaneId::Terminal(1));
    }

    #[test]
    fn only_a_known_terminal_has_a_resume_position() {
        let host = start(TIMEOUT);
        let runtime = runtime();
        let engine = backend(&host);
        let (mut reader, _) = engine
            .spawn_terminal(shell(), None, Box::new(|_, _, _| {}), 1)
            .unwrap();
        let (line, marker) = sum_line(11, 22);
        type_all(&engine, &line);
        read_until(&runtime, &mut reader, &marker);
        read_briefly(&runtime, &mut reader);
        assert!(engine.resume_position(1).is_some());
        assert_eq!(engine.resume_position(99), None);
    }
}

#[test]
fn a_new_engine_takes_over_the_same_shell_from_the_snapshot_position() {
    let host = start(TIMEOUT);
    let mut old = host.connect().unwrap();
    assert_eq!(old.generation, 1);
    let pid = shell_at_prompt(&mut old);
    let end = old.pause();
    assert!(end > 0);
    assert_eq!(old.begin_handoff(0), Reply::Ok);
    drop(old);

    std::thread::sleep(Duration::from_millis(300));
    assert!(process_alive(pid), "losing the engine stopped the shell");

    let mut new = host.connect().unwrap();
    assert_eq!(new.generation, 2);
    new.send(Request::ResumeOutput);
    let (first, _) = new.read_until("42");
    assert_eq!(first, 0, "output must resume at the snapshot position");
    let (line, marker) = sum_line(100, 23);
    new.type_line(&line);
    new.read_until(&marker);
    let id = new.send(Request::CommitAdoption {
        handoff_id: "h1".to_string(),
    });
    assert_eq!(new.reply_to(id), Reply::Ok);
    assert!(process_alive(pid));
    new.send(Request::Shutdown);
    wait_for_exit(pid);
}

#[test]
fn nothing_can_destroy_a_terminal_during_a_handoff() {
    let host = start(TIMEOUT);
    let mut engine = host.connect().unwrap();
    let pid = shell_at_prompt(&mut engine);
    assert_eq!(engine.begin_handoff(0), Reply::Ok);
    for request in [
        Request::Kill { pid },
        Request::ForceKill { pid },
        Request::Close { terminal_id: 1 },
        Request::Shutdown,
    ] {
        let id = engine.send(request);
        assert!(matches!(engine.reply_to(id), Reply::Error { .. }));
    }
    assert!(process_alive(pid));
    let id = engine.send(Request::AbortHandoff {
        handoff_id: "h1".to_string(),
    });
    assert_eq!(engine.reply_to(id), Reply::Ok);
    let id = engine.send(Request::Kill { pid });
    assert_eq!(engine.reply_to(id), Reply::Ok);
    wait_for_exit(pid);
}

#[test]
fn losing_the_engine_outside_a_handoff_still_stops_everything() {
    let mut host = start(TIMEOUT);
    let mut engine = host.connect().unwrap();
    let pid = shell_at_prompt(&mut engine);
    drop(engine);
    host.server.take().unwrap().join().unwrap().unwrap();
    wait_for_exit(pid);
}

#[test]
fn a_second_engine_is_refused_outside_a_handoff() {
    let host = start(TIMEOUT);
    let mut engine = host.connect().unwrap();
    let pid = shell_at_prompt(&mut engine);
    assert!(host.connect().is_err());
    let (line, marker) = sum_line(7, 8);
    engine.type_line(&line);
    engine.read_until(&marker);
    engine.send(Request::Shutdown);
    wait_for_exit(pid);
}

#[test]
fn a_replaced_engine_can_no_longer_act() {
    let host = start(TIMEOUT);
    let mut old = host.connect().unwrap();
    let pid = shell_at_prompt(&mut old);
    assert_eq!(old.begin_handoff(0), Reply::Ok);
    let mut new = host.connect().unwrap();
    assert_eq!(new.generation, 2);
    old.type_line(if cfg!(windows) {
        b"set /a 5000+1\r"
    } else {
        b"echo $((5000+1))\n"
    });
    new.send(Request::ResumeOutput);
    std::thread::sleep(Duration::from_millis(500));
    let (line, marker) = sum_line(6000, 1);
    new.type_line(&line);
    new.read_until(&marker);
    let text = String::from_utf8_lossy(&new.seen).into_owned();
    assert!(!text.contains("5001"), "the old engine's input ran: {text}");
    let id = new.send(Request::AbortHandoff {
        handoff_id: "h1".to_string(),
    });
    assert_eq!(new.reply_to(id), Reply::Ok);
    new.send(Request::Shutdown);
    wait_for_exit(pid);
}

#[test]
fn a_handoff_nobody_finishes_stops_at_its_deadline() {
    let mut host = start(Duration::from_millis(500));
    let mut engine = host.connect().unwrap();
    let pid = shell_at_prompt(&mut engine);
    assert_eq!(engine.begin_handoff(0), Reply::Ok);
    drop(engine);
    let result = host.server.take().unwrap().join().unwrap();
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    wait_for_exit(pid);
}

#[test]
fn paused_output_waits_and_nothing_is_lost() {
    let host = start(TIMEOUT);
    let mut engine = host.connect().unwrap();
    let pid = shell_at_prompt(&mut engine);
    let end = engine.pause();
    let (line, marker) = sum_line(300, 33);
    engine.type_line(&line);
    let quiet = Instant::now() + Duration::from_millis(700);
    while Instant::now() < quiet {
        if let Ok(frame) = engine.frames.recv_timeout(Duration::from_millis(50)) {
            assert!(
                !matches!(frame, Frame::Output { .. }),
                "output arrived while paused"
            );
        }
    }
    engine.send(Request::ResumeOutput);
    let (first, _) = engine.read_until(&marker);
    assert_eq!(first, end, "output after a pause must continue exactly");
    engine.send(Request::Shutdown);
    wait_for_exit(pid);
}

#[test]
fn a_snapshot_position_that_is_gone_refuses_the_handoff() {
    let host = start(TIMEOUT);
    let mut engine = host.connect().unwrap();
    let pid = shell_at_prompt(&mut engine);
    assert!(matches!(
        engine.begin_handoff(u64::MAX),
        Reply::Error { .. }
    ));
    let id = engine.send(Request::Kill { pid });
    assert_eq!(engine.reply_to(id), Reply::Ok);
    wait_for_exit(pid);
}
