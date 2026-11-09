//! Wire format between a session engine and its terminal host. Hosts outlive
//! engines, so this must not depend on Zellij wire types, and changes must be
//! additive or gated on the handshake's protocol number.
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const PROTOCOL: u32 = 2;
pub const MAX_OUTPUT_CHUNK: usize = 64 * 1024;
const MAX_FRAME: usize = 1024 * 1024;

const KIND_CONTROL: u8 = 0;
const KIND_OUTPUT: u8 = 1;
const KIND_WRITE: u8 = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Commands,
    Events,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u32,
    pub token: String,
    pub pair: String,
    pub channel: Channel,
}

#[allow(dead_code)] // The handoff requests are sent once engines can hand over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Spawn {
        terminal_id: u32,
        command: CommandSpec,
        failover: Option<CommandSpec>,
        env: Vec<(String, String)>,
    },
    Resize {
        terminal_id: u32,
        cols: u16,
        rows: u16,
        width_in_pixels: Option<u16>,
        height_in_pixels: Option<u16>,
    },
    Drain {
        terminal_id: u32,
    },
    Kill {
        pid: u32,
    },
    ForceKill {
        pid: u32,
    },
    Interrupt {
        pid: u32,
    },
    ForegroundProcessGroup {
        terminal_id: u32,
    },
    Close {
        terminal_id: u32,
    },
    Ack {
        terminal_id: u32,
        sequence: u64,
    },
    PauseOutput,
    ResumeOutput,
    /// Keeps each terminal's output from its snapshot position until the
    /// handoff ends. Losing this connection no longer stops anything.
    BeginHandoff {
        handoff_id: String,
        retain_from: Vec<(u32, u64)>,
    },
    CommitAdoption {
        handoff_id: String,
    },
    AbortHandoff {
        handoff_id: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestEnvelope {
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Reply {
    Ok,
    Spawned { pid: u32 },
    CommandNotFound,
    Written { accepted: usize },
    ForegroundProcessGroup { pgid: Option<i32> },
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Welcome {
        protocol: u32,
        host_pid: u32,
        generation: u64,
    },
    /// Follows the last `Output`, with where each terminal's output stopped.
    OutputPaused {
        ends: Vec<(u32, u64)>,
    },
    Reply {
        id: u64,
        reply: Reply,
    },
    Exited {
        terminal_id: u32,
        status: Option<i32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Control(Vec<u8>),
    Output {
        terminal_id: u32,
        sequence: u64,
        bytes: Vec<u8>,
    },
    Write {
        id: u64,
        terminal_id: u32,
        bytes: Vec<u8>,
    },
}

pub fn control<T: Serialize>(value: &T) -> io::Result<Frame> {
    Ok(Frame::Control(serde_json::to_vec(value)?))
}

pub fn parse<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> io::Result<T> {
    Ok(serde_json::from_slice(bytes)?)
}

pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let mut body = Vec::new();
    match frame {
        Frame::Control(bytes) => {
            body.push(KIND_CONTROL);
            body.extend_from_slice(bytes);
        },
        Frame::Output {
            terminal_id,
            sequence,
            bytes,
        } => {
            body.push(KIND_OUTPUT);
            body.extend_from_slice(&terminal_id.to_le_bytes());
            body.extend_from_slice(&sequence.to_le_bytes());
            body.extend_from_slice(bytes);
        },
        Frame::Write {
            id,
            terminal_id,
            bytes,
        } => {
            body.push(KIND_WRITE);
            body.extend_from_slice(&id.to_le_bytes());
            body.extend_from_slice(&terminal_id.to_le_bytes());
            body.extend_from_slice(bytes);
        },
    }
    if body.len() > MAX_FRAME {
        return Err(invalid("frame too large"));
    }
    let mut message = Vec::with_capacity(body.len() + 4);
    message.extend_from_slice(&(body.len() as u32).to_le_bytes());
    message.extend_from_slice(&body);
    writer.write_all(&message)?;
    writer.flush()
}

pub fn read_frame(reader: &mut impl Read) -> io::Result<Frame> {
    let mut length = [0; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(invalid("invalid frame length"));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let payload = body.split_off(1);
    match body[0] {
        KIND_CONTROL => Ok(Frame::Control(payload)),
        KIND_OUTPUT if payload.len() >= 12 => Ok(Frame::Output {
            terminal_id: u32::from_le_bytes(payload[..4].try_into().unwrap()),
            sequence: u64::from_le_bytes(payload[4..12].try_into().unwrap()),
            bytes: payload[12..].to_vec(),
        }),
        KIND_WRITE if payload.len() >= 12 => Ok(Frame::Write {
            id: u64::from_le_bytes(payload[..8].try_into().unwrap()),
            terminal_id: u32::from_le_bytes(payload[8..12].try_into().unwrap()),
            bytes: payload[12..].to_vec(),
        }),
        _ => Err(invalid("invalid frame")),
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        for frame in [
            Frame::Control(b"{}".to_vec()),
            Frame::Output {
                terminal_id: 7,
                sequence: u64::MAX - 1,
                bytes: vec![0, 27, 255],
            },
            Frame::Write {
                id: 9,
                terminal_id: 3,
                bytes: b"typed".to_vec(),
            },
        ] {
            let mut wire = Vec::new();
            write_frame(&mut wire, &frame).unwrap();
            assert_eq!(read_frame(&mut wire.as_slice()).unwrap(), frame);
        }
    }

    #[test]
    fn rejects_oversized_and_truncated_frames() {
        let oversized = ((MAX_FRAME + 1) as u32).to_le_bytes();
        assert!(read_frame(&mut oversized.as_slice()).is_err());
        let truncated_output = [5, 0, 0, 0, KIND_OUTPUT, 1, 2, 3, 4];
        assert!(read_frame(&mut truncated_output.as_slice()).is_err());
    }

    #[test]
    fn request_envelope_keeps_its_id_beside_the_request() {
        let envelope = RequestEnvelope {
            id: 4,
            request: Request::Close { terminal_id: 2 },
        };
        let json = serde_json::to_string(&envelope).unwrap();
        assert_eq!(json, r#"{"id":4,"type":"close","terminal_id":2}"#);
        assert_eq!(
            serde_json::from_str::<RequestEnvelope>(&json).unwrap(),
            envelope
        );
    }
}
