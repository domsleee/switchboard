//! Native engine requests without child processes or terminal viewers.
use super::*;
use interprocess::local_socket::{prelude::*, tokio::Stream};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zellij_utils::{
    client_server_contract::client_server_contract::{
        ClientToServerMsg as WireRequest, ServerToClientMsg as WireResponse,
    },
    input::actions::Action,
    ipc::{ClientToServerMsg, ExitReason, ServerToClientMsg},
    prost::Message as _,
};

pub(super) struct Connection {
    command: Stream,
    reply: Option<Stream>,
}

async fn connect_path(path: &Path) -> std::io::Result<Stream> {
    use interprocess::local_socket::traits::tokio::Stream as _;
    #[cfg(unix)]
    let name = path.to_fs_name::<interprocess::local_socket::GenericFilePath>()?;
    #[cfg(windows)]
    let name = path
        .as_os_str()
        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()?;
    Stream::connect(name).await
}

impl Connection {
    pub(super) async fn connect(session: &str) -> anyhow::Result<Self> {
        control::validate_session(session).map_err(|(_, error)| anyhow::anyhow!(error))?;
        Self::at(&zellij_utils::consts::ZELLIJ_SOCK_DIR.join(session)).await
    }

    pub(super) async fn at(path: &Path) -> anyhow::Result<Self> {
        #[cfg(unix)]
        return Ok(Self {
            command: connect_path(path).await?,
            reply: None,
        });
        #[cfg(windows)]
        {
            use interprocess::local_socket::{traits::tokio::Listener as _, ListenerOptions};
            let id = uuid::Uuid::new_v4();
            let reply_name = format!("zellij-reply-{id}");
            let listener = ListenerOptions::new()
                .name(
                    reply_name
                        .as_str()
                        .to_ns_name::<interprocess::local_socket::GenericNamespaced>()?,
                )
                .create_tokio()?;
            let mut paired_path = path.as_os_str().to_owned();
            paired_path.push("-paired-v1");
            match connect_path(Path::new(&paired_path)).await {
                Ok(mut command) => {
                    command.write_all(id.as_bytes()).await?;
                    let reply =
                        tokio::time::timeout(Duration::from_secs(2), listener.accept()).await??;
                    Ok(Self {
                        command,
                        reply: Some(reply),
                    })
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Preserve access to existing engines during rolling upgrades.
                    // Only absence, never a failed paired handshake, permits this fallback.
                    let command = connect_path(path).await?;
                    let mut reply_path = path.as_os_str().to_owned();
                    reply_path.push("-reply");
                    let reply = tokio::time::timeout(Duration::from_secs(2), async {
                        loop {
                            match connect_path(Path::new(&reply_path)).await {
                                Ok(reply) => break Ok::<_, std::io::Error>(reply),
                                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                                    tokio::time::sleep(Duration::from_millis(10)).await;
                                },
                                Err(error) => break Err(error),
                            }
                        }
                    })
                    .await??;
                    Ok(Self {
                        command,
                        reply: Some(reply),
                    })
                },
                Err(error) => Err(error.into()),
            }
        }
    }

    pub(super) async fn send(&mut self, message: ClientToServerMsg) -> anyhow::Result<()> {
        let message: WireRequest = message.into();
        let bytes = message.encode_to_vec();
        anyhow::ensure!(bytes.len() <= LIMIT, "Engine request too large");
        self.command.write_u32_le(bytes.len() as u32).await?;
        self.command.write_all(&bytes).await?;
        Ok(())
    }

    pub(super) async fn receive(&mut self) -> anyhow::Result<ServerToClientMsg> {
        let reader = self.reply.as_mut().unwrap_or(&mut self.command);
        let length = reader.read_u32_le().await? as usize;
        anyhow::ensure!(length <= LIMIT, "Engine response too large");
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).await?;
        WireResponse::decode(bytes.as_slice())?
            .try_into()
            .map_err(|error| anyhow::anyhow!("Invalid engine reply: {error:?}"))
    }

    async fn action(&mut self, action: Action) -> anyhow::Result<String> {
        self.send(ClientToServerMsg::Action {
            action,
            terminal_id: None,
            client_id: None,
            is_cli_client: true,
        })
        .await?;
        loop {
            match self.receive().await? {
                ServerToClientMsg::Log { lines } => return Ok(lines.join("\n")),
                ServerToClientMsg::LogError { .. } => {
                    anyhow::bail!("Engine rejected terminal request")
                },
                ServerToClientMsg::UnblockInputThread => return Ok(String::new()),
                ServerToClientMsg::Exit {
                    exit_reason: ExitReason::Normal,
                } => return Ok(String::new()),
                ServerToClientMsg::Exit { .. } => anyhow::bail!("Engine closed terminal request"),
                _ => {},
            }
        }
    }
}

pub(super) async fn action(
    session: &str,
    action: Action,
    timeout: Duration,
) -> anyhow::Result<String> {
    // Dropping a timed out future closes its pipes. No worker thread or child survives it,
    // and an uncertain write is never retried.
    tokio::time::timeout(timeout, async {
        let mut connection = Connection::connect(session).await?;
        let result = connection.action(action).await;
        let _ = connection.send(ClientToServerMsg::ClientExited).await;
        result
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use interprocess::local_socket::traits::tokio::Listener as _;

    fn listen(path: &Path) -> interprocess::local_socket::tokio::Listener {
        #[cfg(windows)]
        let path = {
            let mut value = path.as_os_str().to_owned();
            value.push("-paired-v1");
            std::path::PathBuf::from(value)
        };
        zellij_utils::consts::ipc_bind_async(&path).unwrap()
    }

    async fn accept(listener: &interprocess::local_socket::tokio::Listener) -> Connection {
        let command = listener.accept().await.unwrap();
        #[cfg(windows)]
        {
            let mut command = command;
            let mut id = [0; 16];
            command.read_exact(&mut id).await.unwrap();
            let reply = connect_path(Path::new(&format!(
                "zellij-reply-{}",
                uuid::Uuid::from_bytes(id)
            )))
            .await
            .unwrap();
            Connection {
                command,
                reply: Some(reply),
            }
        }
        #[cfg(unix)]
        Connection {
            command,
            reply: None,
        }
    }

    #[tokio::test]
    async fn engine_request_targets_only_the_named_pane_and_returns_output_without_attaching() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("engine");
        let listener = listen(&path);
        let server = tokio::spawn(async move {
            let mut pair = accept(&listener).await;
            let stream = &mut pair.command;
            let length = stream.read_u32_le().await.unwrap();
            let mut bytes = vec![0; length as usize];
            stream.read_exact(&mut bytes).await.unwrap();
            let message: ClientToServerMsg = WireRequest::decode(bytes.as_slice())
                .unwrap()
                .try_into()
                .unwrap();
            assert!(matches!(
                message,
                ClientToServerMsg::Action {
                    action: Action::DumpScreen {
                        pane_id: Some(zellij_utils::data::PaneId::Terminal(17)),
                        ..
                    },
                    terminal_id: None,
                    client_id: None,
                    is_cli_client: true,
                }
            ));
            let reply: WireResponse = ServerToClientMsg::Log {
                lines: vec!["screen contents".into()],
            }
            .into();
            let bytes = reply.encode_to_vec();
            let stream = pair.reply.as_mut().unwrap_or(&mut pair.command);
            stream.write_u32_le(bytes.len() as u32).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let mut connection = Connection::at(&path).await.unwrap();
        let screen = connection
            .action(Action::DumpScreen {
                file_path: None,
                include_scrollback: false,
                pane_id: Some(zellij_utils::data::PaneId::Terminal(17)),
                ansi: false,
            })
            .await
            .unwrap();
        assert_eq!(screen, "screen contents");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn engine_timeout_closes_connection_without_retrying_the_action() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("engine");
        let listener = listen(&path);
        let server = tokio::spawn(async move {
            let mut pair = accept(&listener).await;
            let stream = &mut pair.command;
            let length = stream.read_u32_le().await.unwrap();
            let mut bytes = vec![0; length as usize];
            stream.read_exact(&mut bytes).await.unwrap();
            assert!(matches!(stream.read(&mut [0u8; 1]).await, Ok(0) | Err(_)));
            assert!(
                tokio::time::timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err()
            );
        });
        assert!(tokio::time::timeout(Duration::from_millis(500), async {
            let mut connection = Connection::at(&path).await.unwrap();
            connection.action(Action::CloseTabById { id: 42 }).await
        })
        .await
        .is_err());
        server.await.unwrap();
    }
}
