use axum_server::Handle;
use interprocess::local_socket::traits::tokio::Listener;
use std::net::{IpAddr, SocketAddr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zellij_utils::consts::{ipc_bind_async, WEBSERVER_SOCKET_PATH};
use zellij_utils::prost::Message;
use zellij_utils::web_server_commands::{InstructionForWebServer, VersionInfo, WebServerResponse};
use zellij_utils::web_server_contract::web_server_contract::InstructionForWebServer as ProtoInstructionForWebServer;
use zellij_utils::web_server_contract::web_server_contract::WebServerResponse as ProtoWebServerResponse;

pub async fn create_webserver_receiver(
    id: &str,
) -> Result<interprocess::local_socket::tokio::Stream, Box<dyn std::error::Error + Send + Sync>> {
    std::fs::create_dir_all(&WEBSERVER_SOCKET_PATH.as_path())?;
    let socket_path = WEBSERVER_SOCKET_PATH.join(format!("{}", id));

    if socket_path.exists() {
        tokio::fs::remove_file(&socket_path).await?;
    }

    let listener = ipc_bind_async(&socket_path)?;
    let stream = listener.accept().await?;
    Ok(stream)
}

pub async fn receive_webserver_instruction(
    receiver: &mut interprocess::local_socket::tokio::Stream,
) -> std::io::Result<InstructionForWebServer> {
    // Read length prefix (4 bytes)
    let mut len_bytes = [0u8; 4];
    receiver.read_exact(&mut len_bytes).await?;
    let len = u32::from_le_bytes(len_bytes) as usize;

    // Read protobuf message
    let mut buffer = vec![0u8; len];
    receiver.read_exact(&mut buffer).await?;

    // Decode protobuf message
    let proto_instruction = ProtoInstructionForWebServer::decode(&buffer[..])
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    // Convert to Rust type
    proto_instruction
        .try_into()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
}

pub async fn send_webserver_response(
    sender: &mut interprocess::local_socket::tokio::Stream,
    response: WebServerResponse,
) -> std::io::Result<()> {
    let proto_response: ProtoWebServerResponse = response.into();
    let encoded = proto_response.encode_to_vec();
    let len = encoded.len() as u32;

    sender.write_all(&len.to_le_bytes()).await?;
    sender.write_all(&encoded).await?;
    sender.flush().await?;

    Ok(())
}

pub async fn listen_to_web_server_instructions(
    server_handle: Handle<SocketAddr>,
    id: &str,
    web_server_ip: IpAddr,
    web_server_port: u16,
) {
    loop {
        let receiver = create_webserver_receiver(id).await;
        match receiver {
            Ok(mut receiver) => match receive_webserver_instruction(&mut receiver).await {
                Ok(instruction) => match instruction {
                    InstructionForWebServer::ShutdownWebServer => {
                        server_handle.shutdown();
                        break;
                    },
                    InstructionForWebServer::QueryVersion => {
                        let response = WebServerResponse::Version(VersionInfo {
                            version: zellij_utils::consts::VERSION.to_string(),
                            ip: web_server_ip.to_string(),
                            port: web_server_port,
                        });
                        let _ = send_webserver_response(&mut receiver, response).await;
                    },
                },
                Err(e) => {
                    log::error!("Failed to process web server instruction: {}", e);
                },
            },
            Err(e) => {
                // Binding can fail transiently (e.g. a full disk). Giving up would leave the
                // server running with no control socket, so `zellij web --stop` could not reach it.
                log::error!("Failed to listen to ipc channel, retrying: {}", e);
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zellij_utils::web_server_commands::query_webserver_with_response;

    #[cfg(unix)]
    #[tokio::test]
    async fn listener_recovers_after_bind_fails() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        // An absolute id replaces WEBSERVER_SOCKET_PATH in `join`, so the socket lands in our
        // temp dir; its parent does not exist yet, so the first binds fail.
        let socket = missing.join("ws").to_string_lossy().to_string();
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        let listener = tokio::spawn({
            let socket = socket.clone();
            async move { listen_to_web_server_instructions(Handle::new(), &socket, ip, 1).await }
        });

        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        std::fs::create_dir(&missing).unwrap();

        let query = |instruction| {
            let socket = socket.clone();
            tokio::task::spawn_blocking(move || {
                query_webserver_with_response(&socket, instruction, 0)
            })
        };
        let mut response = None;
        for _ in 0..50 {
            if let Ok(Ok(r)) = query(InstructionForWebServer::QueryVersion).await {
                response = Some(r);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let WebServerResponse::Version(info) = response.expect("listener never recovered");
        assert_eq!(info.port, 1);

        let _ = query(InstructionForWebServer::ShutdownWebServer).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), listener)
            .await
            .expect("listener did not stop")
            .unwrap();
    }
}
