//! Isolated experiment, excluded from normal builds. A session-engine-owned
//! native attachment outlives replaceable bridges. This is NOT the web protocol:
//! input is raw bytes to one fixed pane; no web parser, sharing or updater changes.
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use zellij_utils::{
    input::{actions::Action, cli_assets::CliAssets},
    ipc::{
        ClientToServerMsg, IpcReceiverWithContext, IpcSenderWithContext, PaneReference,
        ServerToClientMsg,
    },
    pane_size::Size,
};

const INPUT_LIMIT: usize = 16 * 1024;
const REPLAY_LIMIT: usize = 1024 * 1024;
const VIEWER_LIMIT: usize = 4;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Input {
    sequence: u64,
    bytes: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    capability: String,
    viewer: String,
    operation: String,
    #[serde(default)]
    resume_id: Option<String>,
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    output_ack: u64,
    #[serde(default)]
    input: Option<Input>,
    #[serde(default)]
    pane: u32,
    #[serde(default)]
    rows: usize,
    #[serde(default)]
    cols: usize,
    #[serde(default)]
    replay_limit: Option<usize>,
}
#[derive(Clone, Serialize)]
struct Output {
    sequence: u64,
    text: String,
}
#[derive(Default)]
struct Journal {
    generation: u64,
    resume_id: Option<String>,
    resume_from: u64,
    input: Option<Input>,
    output: VecDeque<Output>,
    output_sequence: u64,
    output_ack: u64,
    bytes: usize,
    limit: usize,
    failure: Option<String>,
}
impl Journal {
    fn acknowledge(&mut self, sequence: u64) -> Result<()> {
        ensure!(
            sequence >= self.output_ack && sequence <= self.output_sequence,
            "invalid output acknowledgment"
        );
        self.output_ack = sequence;
        while self
            .output
            .front()
            .is_some_and(|frame| frame.sequence <= sequence)
        {
            self.bytes -= self.output.pop_front().unwrap().text.len();
        }
        Ok(())
    }
    fn emit(&mut self, text: String) {
        if self.failure.is_some() {
            return;
        }
        if self.bytes.saturating_add(text.len()) > self.limit || self.output.len() >= 4096 {
            self.failure =
                Some("output replay exhausted; viewer cannot resume without loss".into());
            return;
        }
        self.output_sequence += 1;
        self.bytes += text.len();
        self.output.push_back(Output {
            sequence: self.output_sequence,
            text,
        });
    }
    fn input_is_new(&self, input: &Input) -> Result<bool> {
        ensure!(
            !input.bytes.is_empty() && input.bytes.len() <= INPUT_LIMIT,
            "invalid input size"
        );
        if let Some(last) = &self.input {
            if input.sequence == last.sequence {
                ensure!(input == last, "retry changed accepted input");
                return Ok(false);
            }
        }
        let next = self.input.as_ref().map_or(1, |last| last.sequence + 1);
        ensure!(input.sequence == next, "input sequence gap or stale retry");
        Ok(true)
    }
    fn reply(&self) -> Result<serde_json::Value> {
        if let Some(error) = &self.failure {
            bail!("{error}");
        }
        Ok(serde_json::json!({"generation":self.generation,
            "input_ack":self.input.as_ref().map_or(0, |input|input.sequence),
            "output":self.output,"engine_pid":std::process::id()}))
    }
}
struct Viewer {
    pane: u32,
    rows: usize,
    cols: usize,
    sender: IpcSenderWithContext<ClientToServerMsg>,
    journal: Arc<Mutex<Journal>>,
}
impl Drop for Viewer {
    fn drop(&mut self) {
        let _ = self.sender.send_client_msg(ClientToServerMsg::ClientExited);
    }
}

fn attach(path: &PathBuf, request: &Request) -> Result<Viewer> {
    ensure!(
        (2..=100).contains(&request.rows) && (2..=200).contains(&request.cols),
        "invalid viewport"
    );
    let limit = request.replay_limit.unwrap_or(REPLAY_LIMIT);
    ensure!(
        (128..=REPLAY_LIMIT).contains(&limit),
        "invalid replay bound"
    );
    #[cfg(windows)]
    let (mut sender, mut receiver) = {
        let (command, reply) = zellij_utils::windows_ipc::connect(path)?;
        (
            IpcSenderWithContext::new(command),
            IpcReceiverWithContext::<ServerToClientMsg>::new(reply),
        )
    };
    #[cfg(not(windows))]
    let (mut sender, mut receiver) = {
        let receiver = IpcReceiverWithContext::<ServerToClientMsg>::new(
            zellij_utils::consts::ipc_connect(path)?,
        );
        (receiver.get_sender(), receiver)
    };
    sender.send_client_msg(ClientToServerMsg::AttachClient {
        cli_assets: CliAssets {
            terminal_window_size: Size {
                rows: request.rows,
                cols: request.cols,
            },
            should_ignore_config: true,
            ..Default::default()
        },
        tab_position_to_focus: None,
        pane_to_focus: Some(PaneReference {
            pane_id: request.pane,
            is_plugin: false,
        }),
        is_web_client: false,
    })?;
    let journal = Arc::new(Mutex::new(Journal {
        generation: 1,
        limit,
        ..Default::default()
    }));
    let output = journal.clone();
    thread::spawn(move || {
        while let Some((message, _)) = receiver.recv_server_msg() {
            match message {
                ServerToClientMsg::Render { content } => output.lock().unwrap().emit(content),
                ServerToClientMsg::Exit { exit_reason } => {
                    output.lock().unwrap().failure =
                        Some(format!("attachment ended: {exit_reason:?}"));
                    return;
                },
                ServerToClientMsg::LogError { lines } => {
                    output.lock().unwrap().failure = Some(lines.join("\n"));
                    return;
                },
                _ => {},
            }
        }
        output.lock().unwrap().failure = Some("engine attachment disconnected".into());
    });
    Ok(Viewer {
        pane: request.pane,
        rows: request.rows,
        cols: request.cols,
        sender,
        journal,
    })
}

fn dispatch(
    viewers: &mut HashMap<String, Viewer>,
    path: &PathBuf,
    request: Request,
) -> Result<serde_json::Value> {
    ensure!(
        uuid::Uuid::parse_str(&request.viewer).is_ok(),
        "invalid viewer capability"
    );
    if request.operation == "open" {
        ensure!(
            request.generation == 0 && request.output_ack == 0 && request.input.is_none(),
            "invalid open"
        );
        if !viewers.contains_key(&request.viewer) {
            ensure!(viewers.len() < VIEWER_LIMIT, "proof viewer limit reached");
            viewers.insert(request.viewer.clone(), attach(path, &request)?);
        }
    }
    let viewer = viewers
        .get_mut(&request.viewer)
        .context("unknown viewer; refusing to recreate lost state")?;
    let mut journal = viewer.journal.lock().unwrap();
    if let Some(error) = &journal.failure {
        bail!("{error}");
    }
    match request.operation.as_str() {
        "open" => {
            ensure!(
                (viewer.pane, viewer.rows, viewer.cols)
                    == (request.pane, request.rows, request.cols),
                "open retry changed attachment"
            );
        },
        "resume" => {
            ensure!(request.input.is_none(), "resume cannot contain input");
            let resume_id = request.resume_id.context("missing resume identity")?;
            ensure!(
                uuid::Uuid::parse_str(&resume_id).is_ok(),
                "invalid resume identity"
            );
            let retry = journal.resume_id.as_ref() == Some(&resume_id);
            ensure!(
                request.generation
                    == if retry {
                        journal.resume_from
                    } else {
                        journal.generation
                    },
                "stale resume generation"
            );
            let next = if retry {
                journal.generation
            } else {
                journal
                    .generation
                    .checked_add(1)
                    .context("generation exhausted")?
            };
            journal.acknowledge(request.output_ack)?;
            if !retry {
                journal.resume_from = request.generation;
                journal.generation = next;
                journal.resume_id = Some(resume_id);
            }
        },
        "exchange" => {
            ensure!(
                request.generation == journal.generation,
                "stale transport generation"
            );
            journal.acknowledge(request.output_ack)?;
            if let Some(input) = request.input {
                if journal.input_is_new(&input)? {
                    // The engine process owns this persistent IPC attachment and
                    // serializes acceptance with the ledger. Bridges own no state.
                    // ACK is acceptance by this surviving process, not application consumption.
                    let write = ClientToServerMsg::Action {
                        action: Action::WriteToPaneId {
                            bytes: input.bytes.clone(),
                            pane_id: zellij_utils::data::PaneId::Terminal(viewer.pane),
                        },
                        terminal_id: None,
                        client_id: None,
                        is_cli_client: false,
                    };
                    if let Err(error) = viewer.sender.send_client_msg(write) {
                        journal.failure =
                            Some(format!("persistent input attachment failed: {error:#}"));
                        bail!("persistent input attachment failed");
                    }
                    journal.input = Some(input);
                }
            }
        },
        _ => bail!("unknown operation"),
    }
    journal.reply()
}

pub(crate) fn start(socket_path: PathBuf) -> Result<()> {
    let Some(endpoint_path) = std::env::var_os("SWITCHBOARD_RESUME_PROOF_ENDPOINT") else {
        return Ok(());
    };
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let capability = uuid::Uuid::new_v4().to_string();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut endpoint = options.open(endpoint_path)?;
    serde_json::to_writer(
        &mut endpoint,
        &serde_json::json!({"port":listener.local_addr()?.port(),"capability":capability,"engine_pid":std::process::id()}),
    )?;
    endpoint.flush()?;
    let viewers = Arc::new(Mutex::new(HashMap::new()));
    let active = Arc::new(AtomicUsize::new(0));
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            if active.fetch_add(1, Ordering::SeqCst) >= 8 {
                active.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let (active, viewers, path, capability) = (
                active.clone(),
                viewers.clone(),
                socket_path.clone(),
                capability.clone(),
            );
            thread::spawn(move || {
                if let Err(error) = serve(stream, viewers, path, capability) {
                    log::debug!("Resume proof request: {error:#}");
                }
                active.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    Ok(())
}
fn serve(
    mut stream: TcpStream,
    viewers: Arc<Mutex<HashMap<String, Viewer>>>,
    path: PathBuf,
    capability: String,
) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut input = Vec::new();
    let result = (|| -> Result<serde_json::Value> {
        use std::io::Read;
        BufReader::new(&stream)
            .take(96 * 1024)
            .read_until(b'\n', &mut input)?;
        ensure!(
            input.last() == Some(&b'\n'),
            "incomplete or oversized request"
        );
        let request: Request = serde_json::from_slice(&input)?;
        ensure!(
            request.capability == capability,
            "invalid engine capability"
        );
        dispatch(
            &mut *viewers
                .lock()
                .map_err(|_| anyhow!("proof registry unavailable"))?,
            &path,
            request,
        )
    })();
    let reply = match result {
        Ok(reply) => reply,
        Err(error) => serde_json::json!({"error":format!("{error:#}")}),
    };
    serde_json::to_writer(&mut stream, &reply)?;
    stream.write_all(b"\n")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resumable_proof_input_retries_cannot_change_or_skip_bytes() {
        let mut journal = Journal::default();
        let input = Input {
            sequence: 1,
            bytes: vec![27, 91],
        };
        assert!(journal.input_is_new(&input).unwrap());
        journal.input = Some(input.clone());
        assert!(!journal.input_is_new(&input).unwrap());
        assert!(journal
            .input_is_new(&Input {
                sequence: 1,
                bytes: vec![65]
            })
            .is_err());
        assert!(journal
            .input_is_new(&Input {
                sequence: 3,
                bytes: vec![65]
            })
            .is_err());
        assert!(journal
            .input_is_new(&Input {
                sequence: 2,
                bytes: vec![65]
            })
            .unwrap());
    }
    #[test]
    fn resumable_proof_output_is_retained_until_acknowledged_and_overflow_fails_closed() {
        let mut journal = Journal {
            limit: 5,
            ..Default::default()
        };
        journal.emit("abc".into());
        journal.emit("de".into());
        assert_eq!(journal.output.len(), 2);
        assert!(journal.acknowledge(3).is_err());
        journal.acknowledge(1).unwrap();
        assert_eq!(journal.bytes, 2);
        assert!(journal.acknowledge(0).is_err());
        journal.emit("fgh".into());
        assert!(journal.reply().is_ok());
        journal.emit("i".into());
        assert!(journal.reply().is_err());
    }
}
