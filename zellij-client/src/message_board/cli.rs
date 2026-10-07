use super::transport::{load_host, resolve_path, token_file};
use super::*;
use anyhow::Context;
use isahc::{
    config::{CaCertificate, RedirectPolicy},
    prelude::*,
    HttpClient, Request,
};
use std::{io::Read, path::PathBuf, time::Duration};
use uuid::Uuid;
use zellij_utils::cli::{MessageCli, MessageCommand};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClientConfig {
    url: url::Url,
    token_file: PathBuf,
    ca_cert: Option<PathBuf>,
}
struct Client {
    origin: url::Url,
    token: String,
    http: HttpClient,
}
impl Client {
    fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let mut config: ClientConfig = serde_json::from_slice(
            &std::fs::read(path).context("Cannot read board client configuration")?,
        )?;
        anyhow::ensure!(
            matches!(config.url.scheme(), "http" | "https")
                && config.url.host_str().is_some()
                && config.url.username().is_empty()
                && config.url.password().is_none()
                && config.url.path() == "/"
                && config.url.query().is_none()
                && config.url.fragment().is_none(),
            "Board URL must be a fixed HTTP(S) origin without credentials or a path"
        );
        let loopback = match config.url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain(name)) => name == "localhost",
            _ => false,
        };
        anyhow::ensure!(
            config.url.scheme() == "https" || loopback,
            "Use HTTPS for a board on another computer"
        );
        let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
        resolve_path(parent, &mut config.token_file);
        let mut builder = HttpClient::builder()
            .timeout(Duration::from_secs(15))
            .redirect_policy(RedirectPolicy::None);
        if let Some(cert) = &mut config.ca_cert {
            resolve_path(parent, cert);
            builder = builder.ssl_ca_certificate(CaCertificate::file(cert.clone()));
        }
        Ok(Self {
            origin: config.url,
            token: token_file(&config.token_file)?,
            http: builder.build()?,
        })
    }
    fn request(
        &self,
        method: &str,
        path: &str,
        payload: Option<serde_json::Value>,
    ) -> anyhow::Result<serde_json::Value> {
        let url = self.origin.join(&format!("api/message-board/{path}"))?;
        let body = payload
            .map(|v| serde_json::to_vec(&v).unwrap())
            .unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(url.as_str())
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .body(body)?;
        // Never follow a redirect with a machine credential, and never start a local fallback board.
        let mut response = self.http.send(request).map_err(|_| {
            anyhow::anyhow!(
                "Configured board is unavailable; keep the input and retry with the same send key"
            )
        })?;
        let status = response.status();
        let mut bytes = vec![];
        response
            .body_mut()
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= 64 * 1024 * 1024,
            "Board response exceeded its limit"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).context("Board returned an invalid response")?;
        anyhow::ensure!(
            status.is_success(),
            "{}",
            value
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Board request failed")
        );
        Ok(value)
    }
}
fn body(path: &Option<PathBuf>) -> anyhow::Result<String> {
    let mut bytes = vec![];
    if let Some(path) = path {
        std::fs::File::open(path)?
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut bytes)?;
    } else {
        std::io::stdin()
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut bytes)?;
    }
    anyhow::ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_BODY,
        "Message input must contain 1–65536 bytes"
    );
    String::from_utf8(bytes).context("Message input must be UTF-8 plain text")
}
fn agent(cli: &MessageCli) -> anyhow::Result<&str> {
    cli.agent_session.as_deref().ok_or_else(|| {
        anyhow::anyhow!("Supply --agent-session or SWITCHBOARD_AGENT_SESSION from registration")
    })
}
fn page(after: u64, limit: u16) -> String {
    format!("after={after}&limit={limit}")
}
fn segment(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}
pub fn run_cli(cli: &MessageCli) -> anyhow::Result<()> {
    let config = cli.board_config.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "Supply --board-config or SWITCHBOARD_BOARD_CONFIG; no local fallback board is started"
        )
    })?;
    if matches!(cli.command, MessageCommand::Serve) {
        return tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?
            .block_on(transport::serve(load_host(config)?));
    }
    let client = Client::load(config)?;
    let result = match &cli.command {
        MessageCommand::Register {
            name,
            project,
            resume,
            terminal_host,
            terminal_session,
            terminal_tab,
        } => {
            let terminal = match (terminal_host, terminal_session, terminal_tab) {
                (Some(host), Some(session), Some(tab_id)) => Some(TerminalLocation {
                    host: host.clone(),
                    session: session.clone(),
                    tab_id: *tab_id,
                }),
                (None, None, None) => None,
                _ => anyhow::bail!("Provide all terminal location fields together"),
            };
            client.request(
                "POST",
                "participants",
                Some(serde_json::to_value(Register {
                    name: name.clone(),
                    project: project.clone(),
                    resume: resume.clone(),
                    terminal,
                })?),
            )?
        },
        MessageCommand::Participants {
            project,
            after,
            limit,
        } => {
            let query = project
                .as_ref()
                .map(|p| format!("&project={}", segment(p)))
                .unwrap_or_default();
            client.request(
                "GET",
                &format!("participants?{}{query}", page(*after, *limit)),
                None,
            )?
        },
        MessageCommand::Unread { after, limit } => client.request(
            "GET",
            &format!(
                "participants/{}/unread?{}",
                segment(agent(cli)?),
                page(*after, *limit)
            ),
            None,
        )?,
        MessageCommand::Thread {
            thread_id,
            after,
            limit,
        } => client.request(
            "GET",
            &format!("threads/{}?{}", segment(thread_id), page(*after, *limit)),
            None,
        )?,
        MessageCommand::Ack { message_id } => client.request(
            "POST",
            &format!(
                "participants/{}/ack/{}",
                segment(agent(cli)?),
                segment(message_id)
            ),
            None,
        )?,
        MessageCommand::Retire => client.request(
            "POST",
            &format!("participants/{}/retire", segment(agent(cli)?)),
            None,
        )?,
        MessageCommand::Send {
            to,
            broadcast,
            body_file,
            send_key,
        } => {
            let request = SendMessage {
                sender: agent(cli)?.into(),
                send_key: send_key
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                body: body(body_file)?,
                to: to.clone(),
                broadcast: broadcast.clone(),
                reply_to: None,
            };
            eprintln!("Send key: {}", request.send_key);
            client.request("POST", "messages", Some(serde_json::to_value(request)?))?
        },
        MessageCommand::Reply {
            message_id,
            body_file,
            send_key,
        } => {
            let request = SendMessage {
                sender: agent(cli)?.into(),
                send_key: send_key
                    .clone()
                    .unwrap_or_else(|| Uuid::new_v4().to_string()),
                body: body(body_file)?,
                to: None,
                broadcast: None,
                reply_to: Some(message_id.clone()),
            };
            eprintln!("Send key: {}", request.send_key);
            client.request("POST", "messages", Some(serde_json::to_value(request)?))?
        },
        MessageCommand::Serve => unreachable!(),
    };
    if cli.json {
        println!("{}", serde_json::to_string(&result)?);
    } else if let Some(items) = result.get("items").and_then(|v| v.as_array()) {
        for item in items {
            print_record(item);
        }
        if let Some(next) = result.get("next_cursor").and_then(|v| v.as_u64()) {
            println!("Next cursor: {next}");
        }
    } else {
        print_record(&result);
    }
    Ok(())
}
fn print_record(value: &serde_json::Value) {
    if let Some(body) = value.get("body").and_then(|v| v.as_str()) {
        println!(
            "{} · {} · {}\nThread: {}\n{}",
            value["id"].as_str().unwrap_or(""),
            value["sender_name"].as_str().unwrap_or(""),
            value["sender_machine_name"].as_str().unwrap_or(""),
            value["thread_id"].as_str().unwrap_or(""),
            safe_text(body)
        );
    } else if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
        println!(
            "{} · {} · {}",
            id,
            value["name"].as_str().unwrap_or(""),
            value["machine_name"].as_str().unwrap_or("")
        );
    } else {
        println!("{}", value);
    }
}
fn safe_text(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            if c.is_control() && !matches!(c, '\n' | '\t') {
                c.escape_default().to_string().chars().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_board_cli_preserves_utf8_multiline_file_and_never_prints_terminal_controls() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("body.txt");
        std::fs::write(&file, "Question 🦀\nSecond line\r\n").unwrap();
        assert_eq!(body(&Some(file)).unwrap(), "Question 🦀\nSecond line\r\n");
        assert_eq!(
            safe_text("A\x1b]52;c;Zm9v\x07\nB"),
            "A\\u{1b}]52;c;Zm9v\\u{7}\nB"
        );
    }

    #[tokio::test]
    async fn message_board_client_validates_tls_and_rejects_plain_lan_origins() {
        let dir = tempfile::tempdir().unwrap();
        let token = dir.path().join("token");
        std::fs::write(&token, "0123456789abcdef0123456789abcdef").unwrap();
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca_params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
        // OpenSSL treats a leaf whose issuer equals its own subject as self-signed.
        ca_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "Message board test CA");
        let ca = ca_params.self_signed(&ca_key).unwrap();
        let mut server_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        server_params.subject_alt_names =
            vec![rcgen::SanType::IpAddress("127.0.0.1".parse().unwrap())];
        server_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = server_params
            .signed_by(&key, &rcgen::Issuer::from_params(&ca_params, &ca_key))
            .unwrap();
        let ca_path = dir.path().join("ca.pem");
        let cert_path = dir.path().join("server.pem");
        let key_path = dir.path().join("server-key.pem");
        std::fs::write(&ca_path, ca.pem()).unwrap();
        std::fs::write(&cert_path, cert.pem()).unwrap();
        std::fs::write(&key_path, key.serialize_pem()).unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let config = transport::HostConfig {
            listen: address,
            database: Some(dir.path().join("board.db")),
            machines: vec![transport::MachineCredential {
                id: "mac".into(),
                name: "Mac".into(),
                token_file: token.clone(),
            }],
            tls_cert: Some(cert_path.clone()),
            tls_key: Some(key_path.clone()),
        };
        let app = transport::router(&config).unwrap();
        let _ = rustls::crypto::ring::default_provider().install_default();
        let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert_path, key_path)
            .await
            .unwrap();
        let handle = axum_server::Handle::new();
        let server_handle = handle.clone();
        let server = tokio::spawn(async move {
            axum_server::from_tcp_rustls(listener, tls)
                .unwrap()
                .handle(server_handle)
                .serve(app.into_make_service())
                .await
                .unwrap()
        });
        let trusted = dir.path().join("trusted.json");
        let untrusted = dir.path().join("untrusted.json");
        let plain = dir.path().join("plain.json");
        std::fs::write(
            &trusted,
            serde_json::to_vec(
                &json!({"url":format!("https://{address}"),"token_file":token,"ca_cert":ca_path}),
            )
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            &untrusted,
            serde_json::to_vec(&json!({"url":format!("https://{address}"),"token_file":token}))
                .unwrap(),
        )
        .unwrap();
        std::fs::write(
            &plain,
            serde_json::to_vec(&json!({"url":"http://192.0.2.1:8098","token_file":token})).unwrap(),
        )
        .unwrap();
        let checks = tokio::task::spawn_blocking(move || {
            assert_eq!(
                Client::load(&trusted)
                    .unwrap()
                    .request("GET", "health", None)
                    .unwrap()["protocol"],
                1
            );
            assert!(
                Client::load(&untrusted)
                    .unwrap()
                    .request("GET", "health", None)
                    .is_err(),
                "An untrusted board certificate must fail closed"
            );
            assert!(Client::load(&plain)
                .err()
                .unwrap()
                .to_string()
                .contains("HTTPS"));
        })
        .await;
        handle.shutdown();
        server.await.unwrap();
        checks.unwrap();
    }
}
