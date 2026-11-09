//! Use Codex's durable input queue without typing into its terminal composer.
use super::*;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Child;

#[derive(Debug, PartialEq)]
pub(super) enum Failure {
    BeforeSend,
    Rejected,
    Unconfirmed,
}

#[derive(Default)]
pub(super) struct Sender {
    server: tokio::sync::Mutex<Option<Server>>,
}

struct Server {
    _child: Option<Child>,
    input: Box<dyn AsyncWrite + Send + Unpin>,
    output: BufReader<Box<dyn tokio::io::AsyncRead + Send + Unpin>>,
    sequence: u64,
}

impl Server {
    async fn start() -> Option<Self> {
        let (program, path) = agent_setup::codex_queue_program()?;
        let mut command = tokio::process::Command::new(program);
        command
            .arg("app-server")
            .env("PATH", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(home) = std::env::home_dir() {
            command.current_dir(home);
        }
        for name in [
            "CODEX_THREAD_ID",
            "ZELLIJ_SESSION_NAME",
            "ZELLIJ_PANE_ID",
            "CLAUDECODE",
        ] {
            command.env_remove(name);
        }
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().ok()?;
        let mut server = Self {
            input: Box::new(child.stdin.take()?),
            output: BufReader::new(Box::new(child.stdout.take()?)),
            _child: Some(child),
            sequence: 0,
        };
        server
            .call("initialize", json!({"clientInfo":{"name":"switchboard","version":env!("SWITCHBOARD_COMMIT")},"capabilities":{"experimentalApi":true}}))
            .await
            .ok()?;
        server
            .input
            .write_all(b"{\"method\":\"initialized\"}\n")
            .await
            .ok()?;
        Some(server)
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, Failure> {
        self.sequence += 1;
        rpc(
            &mut self.input,
            &mut self.output,
            self.sequence,
            method,
            params,
        )
        .await
    }
}

async fn rpc(
    input: &mut (impl AsyncWrite + Unpin),
    output: &mut (impl AsyncBufRead + Unpin),
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, Failure> {
    tokio::time::timeout(QUEUE_TIMEOUT, async {
        let mut request =
            serde_json::to_vec(&json!({"id":id,"method":method,"params":params})).unwrap();
        request.push(b'\n');
        input
            .write_all(&request)
            .await
            .map_err(|_| Failure::Unconfirmed)?;
        loop {
            let mut line = String::new();
            if output
                .read_line(&mut line)
                .await
                .map_err(|_| Failure::Unconfirmed)?
                == 0
            {
                return Err(Failure::Unconfirmed);
            }
            if line.len() > 2 * 1024 * 1024 {
                return Err(Failure::Unconfirmed);
            }
            let Ok(mut response) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if response["id"] != id {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(if matches!(error["code"].as_i64(), Some(-32601 | -32602)) {
                    Failure::Rejected
                } else {
                    Failure::Unconfirmed
                });
            }
            return response
                .get_mut("result")
                .map(Value::take)
                .ok_or(Failure::Unconfirmed);
        }
    })
    .await
    .map_err(|_| Failure::Unconfirmed)?
}

fn matches(item: &Value, key: &str, text: &str) -> bool {
    item["clientUserMessageId"] == key
        && item["input"].as_array().is_some_and(|input| {
            input.len() == 1 && input[0]["type"] == "text" && input[0]["text"] == text
        })
}

impl Sender {
    #[cfg(test)]
    pub(super) fn fixture() -> (Self, tokio::io::DuplexStream) {
        let (client, provider) = tokio::io::duplex(16384);
        let (output, input) = tokio::io::split(client);
        (
            Self {
                server: tokio::sync::Mutex::new(Some(Server {
                    _child: None,
                    input: Box::new(input),
                    output: BufReader::new(Box::new(output)),
                    sequence: 0,
                })),
            },
            provider,
        )
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, Failure> {
        let mut server = self.server.lock().await;
        if server.is_none() {
            *server = Server::start().await;
        }
        let Some(connection) = server.as_mut() else {
            return Err(Failure::BeforeSend);
        };
        let result = connection.call(method, params).await;
        if result == Err(Failure::Unconfirmed) {
            *server = None;
        }
        result
    }

    /// A lost add response must not cause another add. Codex does not deduplicate
    /// clientUserMessageId itself, so reconcile the retained queue first.
    pub(super) async fn queued(
        &self,
        thread: &str,
        key: &str,
        text: &str,
    ) -> Result<bool, Failure> {
        let mut cursor = Value::Null;
        loop {
            let result = self
                .call(
                    "thread/queue/list",
                    json!({"threadId":thread,"limit":100,"cursor":cursor}),
                )
                .await?;
            let items = result["data"].as_array().ok_or(Failure::Unconfirmed)?;
            if let Some(item) = items.iter().find(|item| item["clientUserMessageId"] == key) {
                return if matches(item, key, text) {
                    Ok(true)
                } else {
                    Err(Failure::Rejected)
                };
            }
            cursor = result["nextCursor"].clone();
            if cursor.is_null() {
                return Ok(false);
            }
        }
    }

    pub(super) async fn add(&self, thread: &str, key: &str, text: &str) -> Result<(), Failure> {
        let result = self.call("thread/queue/add", json!({"threadId":thread,"clientUserMessageId":key,"input":[{"type":"text","text":text}]})).await?;
        if matches(&result["queuedSubmission"], key, text) {
            Ok(())
        } else {
            Err(Failure::Unconfirmed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn switchboard_codex_native_queue_preserves_unicode_and_requires_provider_ack() {
        let (mut client, mut provider) = tokio::io::duplex(8192);
        let (output, mut input) = tokio::io::split(&mut client);
        let mut output = BufReader::new(output);
        let text = "Don’t lose ‘quotes’ — 東京 🦀\nsecond line";
        let fixture = tokio::spawn(async move {
            let mut line = String::new();
            let mut provider = BufReader::new(&mut provider);
            provider.read_line(&mut line).await.unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["params"]["input"][0]["text"], text);
            let answer = json!({"id":1,"result":{"queuedSubmission":{"id":"provider-item","clientUserMessageId":"stable-key","input":[{"type":"text","text":text}]}}});
            provider
                .get_mut()
                .write_all(format!("{answer}\n").as_bytes())
                .await
                .unwrap();
        });
        let result = rpc(
            &mut input,
            &mut output,
            1,
            "thread/queue/add",
            json!({"input":[{"type":"text","text":text}]}),
        )
        .await
        .unwrap();
        assert!(matches(&result["queuedSubmission"], "stable-key", text));
        assert!(!matches(&result["queuedSubmission"], "other-key", text));
        assert!(!matches(
            &result["queuedSubmission"],
            "stable-key",
            "different input"
        ));
        fixture.await.unwrap();
    }

    #[tokio::test]
    async fn switchboard_codex_native_queue_distinguishes_rejection_from_lost_ack() {
        for (answer, expected) in [
            (
                "{\"id\":1,\"error\":{\"code\":-32601}}\n",
                Failure::Rejected,
            ),
            ("", Failure::Unconfirmed),
        ] {
            let mut input = Vec::new();
            let mut output = BufReader::new(answer.as_bytes());
            assert_eq!(
                rpc(&mut input, &mut output, 1, "thread/queue/add", json!({})).await,
                Err(expected)
            );
        }
    }
}
