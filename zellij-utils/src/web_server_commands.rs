use crate::consts::is_ipc_socket;
use crate::consts::{WEBSERVER_SOCKET_PATH, ZELLIJ_LEGACY_SOCK_DIR};
use crate::errors::prelude::*;
use crate::web_server_contract::web_server_contract::InstructionForWebServer as ProtoInstructionForWebServer;
use crate::web_server_contract::web_server_contract::WebServerResponse as ProtoWebServerResponse;
use interprocess::local_socket::Stream as LocalSocketStream;
use prost::Message;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;

pub fn shutdown_all_webserver_instances() -> Result<()> {
    for path in discover_webserver_sockets()? {
        if let Ok(mut sender) = create_webserver_sender(path.to_str().unwrap_or("")) {
            let _ =
                send_webserver_instruction(&mut sender, InstructionForWebServer::ShutdownWebServer);
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum InstructionForWebServer {
    ShutdownWebServer,
    QueryVersion,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VersionInfo {
    pub version: String,
    pub ip: String,
    pub port: u16,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum WebServerResponse {
    Version(VersionInfo),
}

pub fn create_webserver_sender(path: &str) -> Result<BufWriter<LocalSocketStream>> {
    let stream = crate::consts::ipc_connect(std::path::Path::new(path))?;
    Ok(BufWriter::new(stream))
}

pub fn send_webserver_instruction(
    sender: &mut BufWriter<LocalSocketStream>,
    instruction: InstructionForWebServer,
) -> Result<()> {
    // Convert to protobuf and send with length prefix
    let proto_instruction: ProtoInstructionForWebServer = instruction.into();
    let encoded = proto_instruction.encode_to_vec();
    let len = encoded.len() as u32;

    // Write length prefix
    sender.write_all(&len.to_le_bytes())?;
    // Write protobuf message
    sender.write_all(&encoded)?;
    sender.flush()?;
    Ok(())
}

/// Web server sockets, including (on Windows) those of web servers started by
/// older versions under the legacy socket dir.
pub fn discover_webserver_sockets() -> Result<Vec<PathBuf>> {
    let mut sockets = Vec::new();
    let legacy = ZELLIJ_LEGACY_SOCK_DIR
        .as_ref()
        .map(|dir| dir.join("web_server_bus"));

    for dir in std::iter::once(WEBSERVER_SOCKET_PATH.clone()).chain(legacy) {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if is_ipc_socket(&entry.metadata()?.file_type()) {
                sockets.push(entry.path());
            }
        }
    }

    Ok(sockets)
}

pub fn query_webserver_with_response(
    path: &str,
    instruction: InstructionForWebServer,
    _timeout_ms: u64,
) -> Result<WebServerResponse> {
    let mut sender = create_webserver_sender(path)?;
    send_webserver_instruction(&mut sender, instruction)?;

    let stream = sender.into_inner()?;
    receive_webserver_response(stream)
}

fn receive_webserver_response(mut stream: LocalSocketStream) -> Result<WebServerResponse> {
    let mut len_bytes = [0u8; 4];
    stream.read_exact(&mut len_bytes)?;
    let len = u32::from_le_bytes(len_bytes) as usize;

    let mut buffer = vec![0u8; len];
    stream.read_exact(&mut buffer)?;

    let proto_response = ProtoWebServerResponse::decode(&buffer[..])?;
    proto_response.try_into()
}
