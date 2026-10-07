use super::*;
use anyhow::Context;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EscapeTarget {
    session: String,
    pane_id: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CloseTarget {
    session: String,
    tab_id: u32,
}

pub(super) fn validate_session(session: &str) -> Result<(), Error> {
    if session.trim().is_empty()
        || session.chars().count() > 200
        || matches!(session, "." | "..")
        || session.starts_with(HELPER_PREFIX)
        || session
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid session"));
    }
    Ok(())
}

pub(super) fn local(host: &Host) -> bool {
    match host.config.escape_transport.as_deref() {
        Some("local") => true,
        Some(_) => false,
        None => matches!(
            host.origin.host_str(),
            Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
        ),
    }
}

fn binary(host: &Host) -> anyhow::Result<PathBuf> {
    host.config
        .zellij_binary
        .as_ref()
        .map(|path| expand_path(path))
        .unwrap_or_else(|| Ok(std::env::current_exe()?))
}

pub(super) fn expand_path(path: &str) -> anyhow::Result<PathBuf> {
    if let Some(tail) = path.strip_prefix("~/") {
        Ok(PathBuf::from(
            std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .ok_or_else(|| anyhow::anyhow!("No home directory"))?,
        )
        .join(tail))
    } else {
        Ok(path.into())
    }
}

pub(super) async fn run_local(
    host: &Host,
    session: &str,
    args: &[&str],
    timeout: Duration,
) -> anyhow::Result<String> {
    let mut command = tokio::process::Command::new(binary(host)?);
    command
        .args(["-s", session, "action"])
        .args(args)
        .kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output()).await??;
    anyhow::ensure!(output.status.success(), "Terminal command failed");
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub(super) async fn sessions(host: &Host) -> anyhow::Result<Vec<String>> {
    let response = tokio::time::timeout(
        Duration::from_secs(20),
        host.request(
            Method::GET,
            "/session-list",
            Bytes::new(),
            "application/json",
        ),
    )
    .await??;
    anyhow::ensure!(
        response.status == StatusCode::OK,
        "Cannot validate sessions"
    );
    let catalog: Value = serde_json::from_slice(&response.body)?;
    let mut names = Vec::new();
    for session in catalog["sessions"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Invalid session catalog"))?
    {
        if session["web_clients_allowed"] == true {
            if let Some(name) = session["name"].as_str() {
                if !name.starts_with(HELPER_PREFIX) {
                    validate_session(name)
                        .map_err(|_| anyhow::anyhow!("Invalid shared session"))?;
                    names.push(name.to_owned());
                }
            }
        }
    }
    Ok(names)
}

pub(super) async fn escape(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<EscapeTarget>,
) -> Result<Json<Value>, Error> {
    execute(&state, &id, &target.session, target.pane_id, false).await?;
    Ok(Json(json!({"ok":true})))
}
pub(super) async fn close_tab(
    State(state): State<RelayState>,
    RoutePath(id): RoutePath<String>,
    Json(target): Json<CloseTarget>,
) -> Result<Json<Value>, Error> {
    execute(&state, &id, &target.session, target.tab_id, true).await?;
    Ok(Json(json!({"ok":true})))
}

async fn execute(
    state: &RelayState,
    id: &str,
    session: &str,
    target: u32,
    close: bool,
) -> Result<(), Error> {
    validate_session(session)?;
    let host = state
        .host(id)
        .ok_or((StatusCode::NOT_FOUND, "Unknown host"))?;
    if host.config.escape_transport.as_deref() == Some("gateway") {
        let response = host
            .request(
                Method::POST,
                "/switchboard/control",
                json!({"session":session,"target":target,"close":close})
                    .to_string()
                    .into(),
                "application/json",
            )
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Peer control unavailable"))?;
        return if response.status == StatusCode::OK {
            Ok(())
        } else {
            Err((response.status, "Peer rejected terminal control"))
        };
    }
    execute_host(&host, session, target, close).await
}

pub(super) async fn execute_host(
    host: &Host,
    session: &str,
    target: u32,
    close: bool,
) -> Result<(), Error> {
    validate_session(session)?;
    // Serialize validation and delivery with the host's private helper. No target focus changes.
    let mut helper = host.control.lock().await;
    let names = sessions(host)
        .await
        .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot validate session"))?;
    if !names.iter().any(|name| name == session) {
        return Err((StatusCode::NOT_FOUND, "Session is unavailable"));
    }
    if local(host) {
        let cookie = host
            .cookie
            .lock()
            .await
            .clone()
            .ok_or((StatusCode::UNAUTHORIZED, "Host is not authenticated"))?;
        let token = cookie
            .strip_prefix("session_token=")
            .ok_or((StatusCode::UNAUTHORIZED, "Invalid host authentication"))?;
        // A local CLI has the OS user's privileges. Do not bypass a view-only
        // upstream token by invoking it on behalf of that authenticated browser.
        use zellij_utils::web_authentication_tokens::{
            is_session_token_read_only, validate_session_token,
        };
        if !validate_session_token(token).unwrap_or(false)
            || is_session_token_read_only(token).unwrap_or(true)
        {
            return Err((
                StatusCode::FORBIDDEN,
                "Writable host authentication is required",
            ));
        }
        let all = if close {
            vec!["list-panes", "--json", "--all"]
        } else {
            vec!["list-panes", "--json"]
        };
        let panes = run_local(host, session, &all, Duration::from_secs(5))
            .await
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Cannot identify target"))?;
        let panes: Vec<Value> = serde_json::from_str(&panes)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "Invalid pane catalog"))?;
        let available = panes.iter().any(|pane| {
            if close {
                pane["tab_id"] == target
            } else {
                pane["id"] == target
                    && pane["is_plugin"] == false
                    && pane["exited"] != true
                    && pane["is_held"] != true
            }
        });
        if !available {
            return Err((StatusCode::CONFLICT, "Target is no longer available"));
        }
        let target = target.to_string();
        let args = if close {
            vec!["close-tab", "--tab-id", &target]
        } else {
            vec!["write", "-p", &target, "27"]
        };
        run_local(host, session, &args, Duration::from_secs(5))
            .await
            .map_err(|_| {
                (
                    StatusCode::BAD_GATEWAY,
                    "Terminal command failed; delivery may be uncertain",
                )
            })?;
    } else {
        ensure_helper(host, &mut helper).await.map_err(|error| {
            let message = helper_failure_message(&error);
            log::warn!(
                "Remote control startup failed for host {}: {}",
                host.config.id,
                message
            );
            (StatusCode::BAD_GATEWAY, message)
        })?;
        let filter = if close {
            format!("$_.tab_id -eq {target}")
        } else {
            format!("$_.id -eq {target} -and -not $_.is_plugin -and -not $_.exited -and -not $_.is_held")
        };
        let session = ps_literal(session);
        let list = if close {
            "'list-panes','--json','--all'"
        } else {
            "'list-panes','--json'"
        };
        let action = if close {
            format!("'close-tab','--tab-id','{target}'")
        } else {
            format!("'write','-p','{target}','27'")
        };
        let script = format!("$result=Invoke-SB @('-s',{session},'action',{list}) 5000; if($result.code -ne 0) {{ throw 'Cannot list panes' }}; $panes=$result.output | ConvertFrom-Json; $found=@($panes | Where-Object {{ {filter} }}); if($found.Count -eq 0) {{ $code=4 }} else {{ $result=Invoke-SB @('-s',{session},'action',{action}) 5000; $code=$result.code }}");
        match helper.helper.as_mut().unwrap().command(&script).await {
            Ok((0, _)) => {},
            Ok((4, _)) => return Err((StatusCode::CONFLICT, "Target is no longer available")),
            _ => {
                discard(&mut helper).await;
                return Err((
                    StatusCode::BAD_GATEWAY,
                    "Remote command failed; delivery may be uncertain",
                ));
            },
        }
    }
    Ok(())
}

pub(super) fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn shell_command(script: &str) -> String {
    // A fixed ASCII loader keeps quoting shell-independent and avoids UTF-16's
    // doubled payload size hitting cmd.exe's command-line ceiling.
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -OutputFormat Text -Command \"Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')))\"", STANDARD.encode(script.as_bytes()))
}

// PowerShell 5/.NET on existing Windows hosts lacks ProcessStartInfo.ArgumentList.
// Quote argv for CreateProcess, drain both pipes asynchronously, and bound each CLI probe.
pub(super) const WINDOWS_RUNNER: &str = r#"
function Quote-SB([string]$value) {
    '"' + [regex]::Replace($value,'(\\*)("|$)',{
        param($m)
        $slashes=$m.Groups[1].Value
        $suffix=if($m.Groups[2].Value -eq '"'){'\"'}else{''}
        $slashes+$slashes+$suffix
    }) + '"'
}
function Invoke-SB([string[]]$argv,[int]$timeout) {
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName='zellij'
    $info.Arguments=($argv | ForEach-Object { Quote-SB $_ }) -join ' '
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    $info.StandardOutputEncoding=New-Object Text.UTF8Encoding($false)
    $info.StandardErrorEncoding=New-Object Text.UTF8Encoding($false)
    $p=New-Object Diagnostics.Process
    $p.StartInfo=$info
    try {
        if(-not $p.Start()){throw 'Cannot start CLI'}
        $out=$p.StandardOutput.ReadToEndAsync()
        $err=$p.StandardError.ReadToEndAsync()
        if(-not $p.WaitForExit($timeout)) {
            $p.Kill()
            $null=$p.WaitForExit(1000)
            throw 'CLI timed out'
        }
        @{code=$p.ExitCode;output=$out.GetAwaiter().GetResult()}
    } finally { $p.Dispose() }
}
"#;

pub(super) struct Helper {
    name: String,
    terminal: WebSocketStream<Stream>,
    control: WebSocketStream<Stream>,
    state: Value,
    pong: bool,
    cookie: String,
}

pub(super) struct Control {
    pub(super) helper: Option<Helper>,
    // Retain the identity even when startup/cleanup fails. A retry must attach to
    // our existing session, not leave another randomly named server behind.
    name: String,
    retry_at: tokio::time::Instant,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            helper: None,
            name: format!("{HELPER_PREFIX}{}", uuid::Uuid::new_v4().simple()),
            retry_at: tokio::time::Instant::now(),
        }
    }
}

// Expose only fixed local descriptions, never raw upstream errors/cookies/output.
#[derive(Debug)]
struct HelperFailure(&'static str);
impl std::fmt::Display for HelperFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for HelperFailure {}

fn helper_failure_message(error: &anyhow::Error) -> &'static str {
    error.downcast_ref::<HelperFailure>().map_or(
        "Cannot open remote control: connection or session setup failed",
        |failure| failure.0,
    )
}

pub(super) async fn ensure_helper(host: &Host, control: &mut Control) -> anyhow::Result<()> {
    anyhow::ensure!(
        host.config.escape_transport.as_deref().unwrap_or("windows") == "windows",
        "Unsupported control transport"
    );
    if let Some(existing) = control.helper.as_mut() {
        // Detect broken idle sockets before delivery. Never retry an acknowledged/uncertain write.
        if host.cookie.lock().await.as_deref() != Some(existing.cookie.as_str())
            || existing.probe().await.is_err()
        {
            discard(control).await;
        }
    }
    if control.helper.is_none() {
        anyhow::ensure!(
            tokio::time::Instant::now() >= control.retry_at,
            HelperFailure("Remote control is reconnecting; retry in 30 seconds")
        );
        // Also throttle failures before either WebSocket has connected.
        control.retry_at = tokio::time::Instant::now() + Duration::from_secs(30);
        let result = Helper::open(host, &control.name).await;
        control.retry_at = tokio::time::Instant::now() + Duration::from_secs(30);
        control.helper = Some(result?);
    }
    Ok(())
}

impl Helper {
    pub(super) async fn json(&mut self, script: &str) -> anyhow::Result<Value> {
        use std::io::Read;
        let file = ps_literal(&format!("{}.json.gz", self.name));
        let length_marker = format!("__SB_LENGTH_{}", uuid::Uuid::new_v4().simple());
        // A terminal redraw contains only visible cells. Large JSON cannot be
        // captured from one printed line: compress and read bounded chunks instead.
        let prepare=format!("{script}; $bytes=[Text.Encoding]::UTF8.GetBytes($json); if($bytes.Length -gt {LIMIT}){{throw 'Snapshot too large'}}; $path=Join-Path ([IO.Path]::GetTempPath()) {file}; $f=[IO.File]::Open($path,[IO.FileMode]::Create); $gzip=New-Object IO.Compression.GZipStream($f,[IO.Compression.CompressionMode]::Compress); try{{$gzip.Write($bytes,0,$bytes.Length)}}finally{{$gzip.Dispose()}}; $length=(Get-Item -LiteralPath $path).Length; [Console]::WriteLine('{length_marker}:'+$length+':SIZEEND'); $code=0");
        let (code, output) = self.command(&prepare).await?;
        anyhow::ensure!(code == 0, "Cannot stage snapshot");
        let length: usize = output
            .split(&format!("{length_marker}:"))
            .nth(1)
            .and_then(|s| s.split(":SIZEEND").next())
            .ok_or_else(|| anyhow::anyhow!("Snapshot length missing"))?
            .trim()
            .parse()?;
        anyhow::ensure!(
            length <= 65536,
            "Snapshot exceeds legacy terminal transport capacity"
        );
        let mut data = Vec::with_capacity(length);
        let result=tokio::time::timeout(Duration::from_secs(30),async {
            for offset in (0..length).step_by(1024) {
                let marker=format!("__SB_CHUNK_{}",uuid::Uuid::new_v4().simple());
                let read=format!("$path=Join-Path ([IO.Path]::GetTempPath()) {file}; $f=[IO.File]::OpenRead($path); try{{$null=$f.Seek({offset},[IO.SeekOrigin]::Begin); $buffer=New-Object byte[] 1024; $n=$f.Read($buffer,0,$buffer.Length); [Console]::WriteLine('{marker}:'+ [Convert]::ToBase64String($buffer,0,$n)+':DATAEND'); $code=0}}finally{{$f.Dispose()}}");
                let (code,output)=self.command(&read).await?;
                anyhow::ensure!(code==0,"Cannot read staged snapshot");
                let encoded=output.split(&format!("{marker}:")).nth(1).and_then(|s|s.split(":DATAEND").next()).ok_or_else(||anyhow::anyhow!("Snapshot chunk missing"))?;
                let encoded:String=encoded.chars().filter(|c|!c.is_whitespace()).collect();
                let chunk=STANDARD.decode(encoded)?;
                anyhow::ensure!(chunk.len()==1024.min(length-offset),"Truncated snapshot chunk");
                data.extend(chunk);
            }
            let mut plain=Vec::new();
            flate2::read::GzDecoder::new(data.as_slice()).take((LIMIT+1) as u64).read_to_end(&mut plain)?;
            anyhow::ensure!(plain.len()<=LIMIT,"Decoded snapshot too large");
            Ok::<_,anyhow::Error>(serde_json::from_slice(&plain)?)
        }).await;
        let _ = self
            .command(&format!(
                "[IO.File]::Delete((Join-Path ([IO.Path]::GetTempPath()) {file})); $code=0"
            ))
            .await;
        result?
    }

    async fn open(host: &Host, name: &str) -> anyhow::Result<Self> {
        let response = tokio::time::timeout(
            Duration::from_secs(20),
            host.request(
                Method::POST,
                &format!("/session?session={name}&welcome=false"),
                Bytes::new(),
                "application/json",
            ),
        )
        .await??;
        anyhow::ensure!(response.status == StatusCode::OK, "Cannot create helper");
        let boot: Value = serde_json::from_slice(&response.body)?;
        anyhow::ensure!(
            boot["is_read_only"] != true && boot["session_name"] == name,
            "Helper must be writable and private"
        );
        let client = boot["web_client_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid helper client"))?;
        let mut terminal = tokio::time::timeout(
            Duration::from_secs(10),
            host.websocket(&format!(
                "/ws/terminal/{name}?web_client_id={}&rows=30&cols=160",
                urlencoding::encode(client)
            )),
        )
        .await??;
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            host.websocket(&format!(
                "/ws/control?web_client_id={}",
                urlencoding::encode(client)
            )),
        )
        .await;
        let control = match result {
            Ok(Ok(control)) => control,
            _ => {
                let _ = tokio::time::timeout(Duration::from_secs(1), terminal.close(None)).await;
                log::warn!("Private helper {name} lost its control connection before initialization; cleanup could not be confirmed");
                anyhow::bail!("Cannot connect private helper control");
            },
        };
        let mut helper = Self {
            name: name.to_owned(),
            terminal,
            control,
            state: Value::Null,
            pong: false,
            cookie: host
                .cookie
                .lock()
                .await
                .clone()
                .ok_or_else(|| anyhow::anyhow!("Helper lacks authentication"))?,
        };
        let result = helper.initialize().await;
        if let Err(error) = result {
            helper.close().await;
            return Err(error);
        }
        Ok(helper)
    }

    async fn initialize(&mut self) -> anyhow::Result<()> {
        // Give terminal readiness its own budget. The command's 15-second
        // deadline must not be cut short by a shared 10-second startup timer.
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.state["active_pane"].is_null() {
                let _ = self.next().await?;
            }
            self.check()
        })
        .await
        .context(HelperFailure(
            "Remote control terminal did not become ready within 10 seconds",
        ))?
        .context(HelperFailure(
            "Remote control terminal disconnected or reported an invalid pane",
        ))?;
        let (code, _) = self
            .command("$result=Invoke-SB @('--version') 5000; $code=$result.code")
            .await
            .context(HelperFailure(
                "Remote control shell did not complete the CLI check",
            ))?;
        anyhow::ensure!(
            code == 0,
            HelperFailure("Remote control cannot run the Windows zellij CLI")
        );
        Ok::<_, anyhow::Error>(())
    }

    async fn close(mut self) {
        // Close the transport even if no usable pane ever arrived. Helper
        // sessions terminate on their last client disconnect in current engines.
        // Keep the shell cleanup for older hosts, but report an uncertain result.
        let result = tokio::time::timeout(Duration::from_secs(3), async {
            self.send(&format!("[IO.File]::Delete((Join-Path ([IO.Path]::GetTempPath()) {})); $p=(& zellij -s {} action list-panes --json --all) -join [Environment]::NewLine; if($LASTEXITCODE -eq 0) {{ $tabs=@(($p | ConvertFrom-Json).tab_id | Select-Object -Unique); foreach($id in $tabs) {{ & zellij -s {} action close-tab --tab-id $id }} }}", ps_literal(&format!("{}.json.gz", self.name)), ps_literal(&self.name), ps_literal(&self.name))).await?;
            // Older engines need time to consume the cleanup before disconnect.
            while self.next().await.is_ok() {}
            Ok::<(), anyhow::Error>(())
        }).await;
        if !matches!(result, Ok(Ok(()))) {
            log::warn!(
                "Private helper {} shell cleanup could not be confirmed; closing its connections",
                self.name
            );
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), async {
            let _ = self.terminal.close(None).await;
            let _ = self.control.close(None).await;
        })
        .await;
    }

    fn check(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.state["session_name"] == self.name
                && self.state["active_pane"]["is_plugin"] == false,
            "Helper is not its private terminal"
        );
        Ok(())
    }

    async fn next(&mut self) -> anyhow::Result<Option<String>> {
        tokio::select! {
            message = self.terminal.next() => {
                match message.transpose()? {
                    Some(Message::Text(value)) => Ok(Some(value.to_string())),
                    Some(Message::Binary(value)) => Ok(Some(String::from_utf8_lossy(&value).into_owned())),
                    Some(Message::Pong(_)) => {self.pong=true;Ok(None)},
                    Some(Message::Close(_)) | None => anyhow::bail!("Helper disconnected; delivery is uncertain"),
                    _ => Ok(None),
                }
            },
            message = self.control.next() => {
                match message.transpose()? {
                    Some(Message::Text(value)) => {
                        let data: Value = serde_json::from_str(&value)?;
                        if data["type"] == "MobileState" {
                            let state = data["payload"].clone();
                            // A new session can report its identity before its first
                            // terminal is ready. Never send input until it is verified.
                            validate_helper_state(&self.name, &state)?;
                            self.state = state;
                        }
                        Ok(None)
                    },
                    Some(Message::Close(_)) | None => anyhow::bail!("Helper control disconnected"),
                    _ => Ok(None),
                }
            }
        }
    }

    async fn probe(&mut self) -> anyhow::Result<()> {
        self.pong = false;
        tokio::time::timeout(Duration::from_secs(2), async {
            self.terminal.send(Message::Ping(Bytes::new())).await?;
            while !self.pong {
                let _ = self.next().await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await?
    }

    async fn send(&mut self, script: &str) -> anyhow::Result<()> {
        self.check()?;
        let command = shell_command(script);
        anyhow::ensure!(
            command.len() < 7500,
            "Remote command exceeds the shell limit; delivery was not attempted"
        );
        self.terminal
            .send(Message::Binary(command.into_bytes().into()))
            .await?;
        // Stock Windows parsers need Enter as a separate frame.
        self.terminal
            .send(Message::Binary(vec![b'\r'].into()))
            .await?;
        Ok(())
    }

    pub(super) async fn command(&mut self, script: &str) -> anyhow::Result<(i32, String)> {
        let marker = format!("__SB_{}", uuid::Uuid::new_v4().simple());
        let command = format!("$ErrorActionPreference='Stop'; {WINDOWS_RUNNER}; $code=1; try {{ {script} }} catch {{ $code=1 }}; [Console]::WriteLine('{marker}:' + $code + ':END')");
        tokio::time::timeout(Duration::from_secs(15), async {
            self.send(&command).await?;
            let mut output = String::new();
            loop {
                if let Some(chunk) = self.next().await? {
                    output.push_str(&chunk);
                    // Bound retained screen output, including ANSI and echoed commands.
                    if output.len() > 2 * LIMIT {
                        anyhow::bail!("Helper output too large");
                    }
                    let plain = strip_ansi(&output);
                    if let Some(rest) = plain.split(&format!("{marker}:")).nth(1) {
                        if let Some((code, _)) = rest.split_once(":END") {
                            return Ok((code.trim().parse()?, plain));
                        }
                    }
                }
            }
        })
        .await?
    }
}

fn validate_helper_state(name: &str, state: &Value) -> anyhow::Result<()> {
    anyhow::ensure!(state["session_name"] == name, "Helper changed session");
    if !state["active_pane"].is_null() {
        anyhow::ensure!(
            state["active_pane"]["is_plugin"] == false,
            "Helper is not its private terminal"
        );
    }
    Ok(())
}

pub(super) fn strip_ansi(text: &str) -> String {
    static ANSI: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*?(?:\x07|\x1b\\)").unwrap()
    });
    ANSI.replace_all(text, "").into_owned()
}

pub(super) async fn discard(control: &mut Control) {
    control.retry_at = tokio::time::Instant::now() + Duration::from_secs(30);
    if let Some(private) = control.helper.take() {
        private.close().await;
    }
}
pub(super) async fn cleanup(host: &Host) {
    discard(&mut *host.control.lock().await).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn helper_cli_probe_receives_its_full_deadline_after_terminal_readiness() {
        use tokio_tungstenite::tungstenite::protocol::Role;
        let (terminal, terminal_peer) = tokio::io::duplex(16384);
        let (control, control_peer) = tokio::io::duplex(4096);
        let name = format!("{HELPER_PREFIX}slow-start");
        let mut helper = Helper {
            name: name.clone(),
            terminal: WebSocketStream::from_raw_socket(
                Box::new(terminal) as Stream,
                Role::Client,
                None,
            )
            .await,
            control: WebSocketStream::from_raw_socket(
                Box::new(control) as Stream,
                Role::Client,
                None,
            )
            .await,
            state: Value::Null,
            pong: false,
            cookie: String::new(),
        };
        let peer = tokio::spawn(async move {
            let mut terminal =
                WebSocketStream::from_raw_socket(terminal_peer, Role::Server, None).await;
            let mut control =
                WebSocketStream::from_raw_socket(control_peer, Role::Server, None).await;
            tokio::time::sleep(Duration::from_secs(4)).await;
            control
                .send(Message::Text(
                    json!({"type":"MobileState", "payload": {
                        "session_name":name, "active_pane":{"is_plugin":false}
                    }})
                    .to_string()
                    .into(),
                ))
                .await
                .unwrap();
            let command = terminal.next().await.unwrap().unwrap();
            let command = String::from_utf8(command.into_data().to_vec()).unwrap();
            assert_eq!(
                terminal.next().await.unwrap().unwrap().into_data().as_ref(),
                b"\r"
            );
            let encoded = command
                .split("FromBase64String('")
                .nth(1)
                .unwrap()
                .split('\'')
                .next()
                .unwrap();
            let script = String::from_utf8(STANDARD.decode(encoded).unwrap()).unwrap();
            let marker = script
                .split("[Console]::WriteLine('")
                .nth(1)
                .unwrap()
                .split(':')
                .next()
                .unwrap();
            tokio::time::sleep(Duration::from_secs(11)).await;
            terminal
                .send(Message::Text(format!("{marker}:0:END").into()))
                .await
                .unwrap();
            // Keep control open until the successful terminal response is consumed.
            while terminal.next().await.is_some() {}
            drop(control);
        });
        helper.initialize().await.unwrap();
        peer.abort();
    }

    #[test]
    fn helper_diagnostics_expose_only_fixed_local_messages() {
        let upstream = anyhow::anyhow!("secret cookie and upstream output");
        assert_eq!(
            helper_failure_message(&upstream),
            "Cannot open remote control: connection or session setup failed"
        );
        let contextual = upstream.context(HelperFailure("Remote control CLI check failed"));
        assert_eq!(
            helper_failure_message(&contextual),
            "Remote control CLI check failed"
        );
    }

    #[tokio::test]
    async fn failed_helper_startup_is_throttled_and_reuses_its_session() {
        let attempts = Arc::new(Mutex::new(Vec::<String>::new()));
        let upstream = Router::new().route(
            "/session",
            post({
                let attempts = attempts.clone();
                move |axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>| {
                    let attempts = attempts.clone();
                    async move {
                        attempts.lock().await.push(query["session"].clone());
                        StatusCode::BAD_GATEWAY
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = Host::new(super::super::tests::config(&format!(
            "http://{}",
            listener.local_addr().unwrap()
        )))
        .unwrap();
        *host.cookie.lock().await = Some("session_token=test".into());
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
        let mut control = Control::default();
        assert!(ensure_helper(&host, &mut control).await.is_err());
        for _ in 0..10 {
            assert!(ensure_helper(&host, &mut control)
                .await
                .unwrap_err()
                .to_string()
                .contains("retry in 30 seconds"));
        }
        assert_eq!(attempts.lock().await.len(), 1);
        control.retry_at = tokio::time::Instant::now();
        assert!(ensure_helper(&host, &mut control).await.is_err());
        assert_eq!(
            *attempts.lock().await,
            vec![control.name.clone(), control.name.clone()]
        );
        assert_ne!(control.name, Control::default().name);
        server.abort();
    }

    #[tokio::test]
    async fn uninitialized_helper_closes_both_sockets_without_shell_input() {
        use tokio_tungstenite::tungstenite::protocol::Role;
        let (terminal, terminal_peer) = tokio::io::duplex(4096);
        let (control, control_peer) = tokio::io::duplex(4096);
        let helper = Helper {
            name: format!("{HELPER_PREFIX}test"),
            terminal: WebSocketStream::from_raw_socket(
                Box::new(terminal) as Stream,
                Role::Client,
                None,
            )
            .await,
            control: WebSocketStream::from_raw_socket(
                Box::new(control) as Stream,
                Role::Client,
                None,
            )
            .await,
            state: Value::Null,
            pong: false,
            cookie: String::new(),
        };
        helper.close().await;
        for peer in [terminal_peer, control_peer] {
            let mut socket = WebSocketStream::from_raw_socket(peer, Role::Server, None).await;
            assert!(matches!(
                socket.next().await.unwrap().unwrap(),
                Message::Close(_)
            ));
        }
    }

    #[test]
    fn helper_startup_accepts_empty_state_but_never_another_session_or_plugin() {
        let name = "__switchboard_control_test";
        assert!(
            validate_helper_state(name, &json!({"session_name":name,"active_pane":null})).is_ok()
        );
        assert!(validate_helper_state(
            name,
            &json!({"session_name":name,"active_pane":{"is_plugin":false}})
        )
        .is_ok());
        assert!(
            validate_helper_state(name, &json!({"session_name":"main","active_pane":null}))
                .is_err()
        );
        assert!(validate_helper_state(
            name,
            &json!({"session_name":name,"active_pane":{"is_plugin":true}})
        )
        .is_err());
    }
    #[test]
    fn boundary_and_powershell_encoding() {
        for name in ["", "..", "x/y", "x\\y", "x\n", "__switchboard_control_x"] {
            assert!(validate_session(name).is_err());
        }
        assert!(validate_session("user's session; $(anything)").is_ok());
        assert_eq!(ps_literal("a'b"), "'a''b'");
        let script = "Write-Output 'héllo'";
        let cmd = shell_command(script);
        let payload = cmd
            .split("FromBase64String('")
            .nth(1)
            .unwrap()
            .split('\'')
            .next()
            .unwrap();
        assert_eq!(
            String::from_utf8(STANDARD.decode(payload).unwrap()).unwrap(),
            script
        );
        assert!(
            serde_json::from_value::<EscapeTarget>(json!({"session":"main","pane_id":-1})).is_err()
        );
        assert!(serde_json::from_value::<CloseTarget>(
            json!({"session":"main","tab_id":1,"extra":true})
        )
        .is_err());
    }
}
