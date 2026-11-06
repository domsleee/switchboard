//! Device subscriptions belong to this relay, never to the mesh. Payloads contain
//! status and a terminal link, never screen contents or password requests.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf};
use web_push_native::{p256::PublicKey, Auth, WebPushBuilder};

#[derive(Clone, Deserialize, Serialize)]
struct Keys {
    p256dh: String,
    auth: String,
}
#[derive(Clone, Deserialize, Serialize)]
pub(super) struct Subscription {
    endpoint: String,
    keys: Keys,
}
#[derive(Clone, Deserialize, Serialize)]
struct Device {
    subscription: Subscription,
    #[serde(default)]
    sent: BTreeMap<String, String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Saved {
    version: u8,
    private_key: String,
    devices: Vec<Device>,
}
pub(super) struct Push {
    file: PathBuf,
    data: Mutex<Saved>,
    key: EcdsaKeyPair,
}

impl Push {
    async fn load(file: PathBuf) -> anyhow::Result<Self> {
        let data: Saved = match tokio::fs::read(&file).await {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved {
                version: 1,
                private_key: B64.encode(
                    EcdsaKeyPair::generate_pkcs8(
                        &ECDSA_P256_SHA256_FIXED_SIGNING,
                        &ring::rand::SystemRandom::new(),
                    )
                    .map_err(|_| anyhow::anyhow!("Cannot generate push key"))?
                    .as_ref(),
                ),
                devices: Vec::new(),
            },
            Err(e) => return Err(e.into()),
        };
        anyhow::ensure!(data.version == 1, "Unsupported push subscription version");
        let key = EcdsaKeyPair::from_pkcs8(
            &ECDSA_P256_SHA256_FIXED_SIGNING,
            &B64.decode(&data.private_key)?,
            &ring::rand::SystemRandom::new(),
        )
        .map_err(|_| anyhow::anyhow!("Invalid saved push key"))?;
        logs::write_private(&file, &serde_json::to_vec(&data)?).await?;
        Ok(Self {
            file,
            data: Mutex::new(data),
            key,
        })
    }

    async fn save(&self, data: &Saved) -> anyhow::Result<()> {
        logs::write_private(&self.file, &serde_json::to_vec(data)?).await?;
        Ok(())
    }

    fn public_key(&self) -> String {
        B64.encode(self.key.public_key().as_ref())
    }

    async fn subscribe(&self, subscription: Subscription, snapshot: &Value) -> anyhow::Result<()> {
        validate(&subscription)?;
        let mut data = self.data.lock().await;
        // Reopening the app is idempotent; it must not reset delivery history.
        if let Some(device) = data
            .devices
            .iter()
            .find(|d| d.subscription.endpoint == subscription.endpoint)
        {
            anyhow::ensure!(
                device.subscription.keys.p256dh == subscription.keys.p256dh
                    && device.subscription.keys.auth == subscription.keys.auth,
                "Subscription keys changed"
            );
            return Ok(());
        }
        anyhow::ensure!(data.devices.len() < 64, "Too many notification devices");
        let mut next = data.clone();
        // Enabling notifications does not flood the phone with old results.
        next.devices.push(Device {
            subscription,
            sent: alerts(snapshot)
                .into_iter()
                .map(|a| (a.key, a.signature))
                .collect(),
        });
        self.save(&next).await?;
        *data = next;
        Ok(())
    }

    async fn unsubscribe(&self, endpoint: &str) -> anyhow::Result<()> {
        let mut data = self.data.lock().await;
        let mut next = data.clone();
        next.devices.retain(|d| d.subscription.endpoint != endpoint);
        self.save(&next).await?;
        *data = next;
        Ok(())
    }

    fn request(
        &self,
        subscription: &Subscription,
        payload: &Value,
    ) -> anyhow::Result<axum::http::Request<Vec<u8>>> {
        let endpoint = validate(subscription)?;
        let public = PublicKey::from_sec1_bytes(&B64.decode(&subscription.keys.p256dh)?)?;
        let auth = B64.decode(&subscription.keys.auth)?;
        let builder = WebPushBuilder::new(
            subscription.endpoint.parse()?,
            public,
            Auth::from(<[u8; 16]>::try_from(auth.as_slice())?),
        )
        .with_valid_duration(Duration::from_secs(300));
        let mut request = builder.build(payload.to_string())?;
        // RFC 8292: ES256, URL-safe unpadded encoding, and a short-lived audience
        // restricted to this push service. Encryption is handled by web-push-native.
        let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
            + 3600;
        let claims = B64.encode(json!({"aud":endpoint.origin().ascii_serialization(),"exp":expiry,"sub":"https://github.com/domsleee/switchboard"}).to_string());
        let input = format!("{header}.{claims}");
        let signature = self
            .key
            .sign(&ring::rand::SystemRandom::new(), input.as_bytes())
            .map_err(|_| anyhow::anyhow!("Cannot sign push message"))?;
        request.headers_mut().insert(
            header::AUTHORIZATION,
            format!(
                "vapid t={input}.{}, k={}",
                B64.encode(signature.as_ref()),
                self.public_key()
            )
            .parse()?,
        );
        request.headers_mut().insert("urgency", "high".parse()?);
        Ok(request)
    }

    async fn send(
        &self,
        subscription: &Subscription,
        payload: &Value,
    ) -> anyhow::Result<StatusCode> {
        let endpoint = validate(subscription)?;
        let request = self.request(subscription, payload)?;
        let mut target = endpoint.clone();
        target.set_path("/");
        target.set_query(None);
        let host = Host::new(HostConfig {
            id: "push".into(),
            name: "Push service".into(),
            url: target.to_string(),
            token_file: String::new(),
            gateway_token_file: None,
            tls_fingerprint: None,
            artifact_urls: Value::Null,
            escape_transport: None,
            zellij_binary: None,
            hostname: None,
            address: None,
        })?;
        let (mut parts, body) = request.into_parts();
        parts.headers.remove(header::CONTENT_TYPE);
        let path = parts.uri.path_and_query().unwrap().as_str();
        // Direct, certificate-verified HTTPS; no relay tokens and no redirects.
        let response = host
            .stream_request(
                Method::POST,
                path,
                body.into(),
                "application/octet-stream",
                None,
                parts.headers,
            )
            .await?;
        Ok(response.status())
    }
}

fn validate(subscription: &Subscription) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(&subscription.endpoint)?;
    // A browser-supplied URL must never turn the relay into an internal HTTP client.
    // These are the push services used by Chrome/Android, Firefox and Safari.
    anyhow::ensure!(
        url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && subscription.endpoint.len() <= 4096
            && matches!(
                url.host_str(),
                Some(
                    "fcm.googleapis.com"
                        | "updates.push.services.mozilla.com"
                        | "web.push.apple.com"
                )
            ),
        "Unsupported push service"
    );
    let public = B64.decode(&subscription.keys.p256dh)?;
    PublicKey::from_sec1_bytes(&public)?;
    anyhow::ensure!(
        public.len() == 65 && B64.decode(&subscription.keys.auth)?.len() == 16,
        "Invalid push keys"
    );
    Ok(url)
}

struct Alert {
    key: String,
    signature: String,
    payload: Value,
}

// A scan failure is not a resolved alert. Only a known state clears the receipt,
// so a temporarily disconnected computer cannot repeatedly ring the phone.
fn resolved(snapshot: &Value) -> Vec<String> {
    snapshot["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|pane| {
            matches!(pane["state"].as_str(), Some("working" | "waiting"))
                || pane["state"] == "ready" && pane["seen"] == true
        })
        .map(|pane| json!([pane["host"], pane["session"], pane["pane_id"]]).to_string())
        .collect()
}
fn alerts(snapshot: &Value) -> Vec<Alert> {
    let mut alerts = Vec::new();
    for pane in snapshot["panes"].as_array().into_iter().flatten() {
        let label = match pane["state"].as_str() {
            Some("approval") => "Approval needed",
            Some("input") => "Input needed",
            Some("ready") if pane["seen"] != true => "Ready to review",
            _ => continue,
        };
        let (Some(host), Some(session), Some(id)) = (
            pane["host"].as_str(),
            pane["session"].as_str(),
            pane["pane_id"].as_u64(),
        ) else {
            continue;
        };
        let tab = snapshot["tabs"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|tab| {
                tab["host"] == host
                    && tab["session"] == session
                    && tab["panes"]
                        .as_array()
                        .is_some_and(|panes| panes.iter().any(|p| p["pane_id"] == id))
            });
        let title = tab
            .and_then(|tab| tab["name"].as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or("Switchboard");
        let machine = snapshot["computer_names"][host].as_str().unwrap_or(host);
        let key = json!([host, session, id]).to_string();
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("host", host)
            .append_pair("session", session)
            .append_pair("pane", &id.to_string())
            .finish();
        alerts.push(Alert {
            key: key.clone(), signature: json!([pane["state"], pane["token"]]).to_string(),
            payload: json!({"title":title.chars().take(120).collect::<String>(),"body":format!("{label} · {machine}"),"tag":key,"url":format!("/?{query}")}),
        });
    }
    alerts
}

pub(super) async fn config(State(state): State<RelayState>) -> Response {
    match &state.push {
        Some(push) => Json(json!({"publicKey":push.public_key()})).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Push notifications unavailable",
        )
            .into_response(),
    }
}
pub(super) async fn subscribe(
    State(state): State<RelayState>,
    Json(subscription): Json<Subscription>,
) -> Response {
    let Some(push) = &state.push else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let snapshot = state.attention.borrow().1.clone();
    match push.subscribe(subscription, &snapshot).await {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(error) => {
            logs::record("notifications", &format!("Cannot subscribe: {error}"));
            (
                StatusCode::BAD_REQUEST,
                "Cannot save notification subscription",
            )
                .into_response()
        },
    }
}
#[derive(Deserialize)]
pub(super) struct Endpoint {
    endpoint: String,
}
pub(super) async fn unsubscribe(
    State(state): State<RelayState>,
    Json(endpoint): Json<Endpoint>,
) -> Response {
    let Some(push) = &state.push else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match push.unsubscribe(&endpoint.endpoint).await {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Cannot remove notification subscription",
        )
            .into_response(),
    }
}

pub(super) async fn test(
    State(state): State<RelayState>,
    Json(endpoint): Json<Endpoint>,
) -> Response {
    let Some(push) = &state.push else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let subscription = push
        .data
        .lock()
        .await
        .devices
        .iter()
        .find(|d| d.subscription.endpoint == endpoint.endpoint)
        .map(|d| d.subscription.clone());
    let Some(subscription) = subscription else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let result = tokio::time::timeout(Duration::from_secs(10), push.send(&subscription,
        &json!({"title":"Switchboard","body":"Notifications are connected on this device.","tag":"switchboard-test","url":"/"}))).await;
    match result {
        Ok(Ok(code)) if code.is_success() => Json(json!({"ok":true})).into_response(),
        _ => (
            StatusCode::BAD_GATEWAY,
            "Could not deliver test notification",
        )
            .into_response(),
    }
}

pub(super) async fn start(
    state: &mut RelayState,
    file: PathBuf,
) -> Option<tokio::task::JoinHandle<()>> {
    let push = match Push::load(file).await {
        Ok(push) => Arc::new(push),
        Err(error) => {
            logs::record(
                "notifications",
                &format!("Push notifications unavailable: {error}"),
            );
            return None;
        },
    };
    state.push = Some(push.clone());
    let mut changes = state.attention.subscribe();
    let state = state.clone();
    Some(tokio::spawn(async move {
        // Retry temporary service/network failures without blocking attention polling.
        let mut retry = tokio::time::interval(Duration::from_secs(30));
        let mut backoff = HashMap::<String, tokio::time::Instant>::new();
        loop {
            tokio::select! { result = changes.changed() => { if result.is_err() { break; } }, _ = retry.tick() => {} }
            let mut snapshot = changes.borrow_and_update().1.clone();
            snapshot["computer_names"] = Value::Object(
                state
                    .all_hosts()
                    .iter()
                    .map(|host| (host.config.id.clone(), json!(host.config.name)))
                    .collect(),
            );
            push.deliver(&snapshot, &mut backoff, |subscription, payload| {
                let push = push.clone();
                async move { push.send(&subscription, &payload).await }
            })
            .await;
        }
    }))
}

impl Push {
    async fn deliver<F, Fut>(
        &self,
        snapshot: &Value,
        backoff: &mut HashMap<String, tokio::time::Instant>,
        send: F,
    ) where
        F: Fn(Subscription, Value) -> Fut,
        Fut: Future<Output = anyhow::Result<StatusCode>>,
    {
        let alerts = alerts(&snapshot);
        let resolved = resolved(&snapshot);
        if !resolved.is_empty() {
            let mut data = self.data.lock().await;
            let mut next = data.clone();
            let mut changed = false;
            for device in &mut next.devices {
                for key in &resolved {
                    changed |= device.sent.remove(key).is_some();
                }
            }
            if changed {
                if let Err(error) = self.save(&next).await {
                    logs::record("notifications", &format!("Cannot save push state: {error}"));
                }
                *data = next;
            }
        }
        let devices = self.data.lock().await.devices.clone();
        for device in devices {
            if backoff
                .get(&device.subscription.endpoint)
                .is_some_and(|until| *until > tokio::time::Instant::now())
            {
                continue;
            }
            for alert in &alerts {
                if device.sent.get(&alert.key) == Some(&alert.signature) {
                    continue;
                }
                let status = tokio::time::timeout(
                    Duration::from_secs(10),
                    send(device.subscription.clone(), alert.payload.clone()),
                )
                .await;
                let expired = matches!(status, Ok(Ok(StatusCode::GONE | StatusCode::NOT_FOUND)));
                let delivered = matches!(status, Ok(Ok(code)) if code.is_success());
                if expired || delivered {
                    let mut data = self.data.lock().await;
                    let mut next = data.clone();
                    if expired {
                        next.devices
                            .retain(|d| d.subscription.endpoint != device.subscription.endpoint);
                    } else if let Some(current) = next
                        .devices
                        .iter_mut()
                        .find(|d| d.subscription.endpoint == device.subscription.endpoint)
                    {
                        current
                            .sent
                            .insert(alert.key.clone(), alert.signature.clone());
                    }
                    if let Err(error) = self.save(&next).await {
                        logs::record(
                            "notifications",
                            &format!("Cannot save push delivery: {error}"),
                        );
                    }
                    // Keep the in-memory receipt even if disk is temporarily full.
                    *data = next;
                } else {
                    // Endpoints contain subscription secrets; do not log the URL or HTTP error.
                    logs::record(
                        "notifications",
                        "Push delivery failed; retrying in 30 seconds",
                    );
                    backoff.insert(
                        device.subscription.endpoint.clone(),
                        tokio::time::Instant::now() + Duration::from_secs(30),
                    );
                    break;
                }
                if expired {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use web_push_native::p256::{
        elliptic_curve::{rand_core::OsRng, sec1::ToEncodedPoint},
        SecretKey,
    };

    fn subscription() -> (Subscription, SecretKey) {
        let secret = SecretKey::random(&mut OsRng);
        (
            Subscription {
                endpoint: "https://fcm.googleapis.com/push/test-device".into(),
                keys: Keys {
                    p256dh: B64.encode(secret.public_key().to_encoded_point(false).as_bytes()),
                    auth: B64.encode([7; 16]),
                },
            },
            secret,
        )
    }
    fn snapshot(state: &str, token: &str) -> Value {
        json!({"panes":[{"host":"linux","session":"work & home","pane_id":7,"state":state,"token":token,"seen":false}],
            "tabs":[{"host":"linux","session":"work & home","name":"Build the app","panes":[{"pane_id":7}]}],"errors":[]})
    }
    #[tokio::test]
    async fn switchboard_push_payload_is_encrypted_and_vapid_signature_verifies() {
        let dir = tempfile::tempdir().unwrap();
        let push = Push::load(dir.path().join("push.json")).await.unwrap();
        let (subscription, secret) = subscription();
        let payload = json!({"title":"Build finished","url":"/?host=linux&pane=7"});
        let request = push.request(&subscription, &payload).unwrap();
        assert_eq!(request.headers()["content-encoding"], "aes128gcm");
        assert_eq!(request.headers()["ttl"], "300");
        assert!(!request.headers().contains_key("cookie"));
        let plaintext =
            web_push_native::decrypt(request.body().clone(), &secret, &Auth::from([7; 16]))
                .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&plaintext).unwrap(),
            payload
        );
        let auth = request.headers()["authorization"].to_str().unwrap();
        let (jwt, public) = auth
            .strip_prefix("vapid t=")
            .unwrap()
            .split_once(", k=")
            .unwrap();
        assert_eq!(public, push.public_key());
        let (input, signature) = jwt.rsplit_once('.').unwrap();
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            &B64.decode(public).unwrap(),
        )
        .verify(input.as_bytes(), &B64.decode(signature).unwrap())
        .unwrap();
        let claims: Value =
            serde_json::from_slice(&B64.decode(input.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
    }
    #[tokio::test]
    async fn switchboard_push_subscriptions_and_identity_survive_restart_and_disable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("push.json");
        let push = Push::load(file.clone()).await.unwrap();
        let key = push.public_key();
        let (sub, _) = subscription();
        push.subscribe(sub.clone(), &snapshot("ready", "result:1"))
            .await
            .unwrap();
        push.subscribe(sub.clone(), &json!({})).await.unwrap();
        let data = push.data.lock().await;
        assert_eq!(data.devices.len(), 1);
        assert_eq!(data.devices[0].sent.len(), 1);
        drop(data);
        let push = Push::load(file.clone()).await.unwrap();
        assert_eq!(push.public_key(), key);
        assert_eq!(push.data.lock().await.devices.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        push.unsubscribe(&sub.endpoint).await.unwrap();
        assert!(Push::load(file)
            .await
            .unwrap()
            .data
            .lock()
            .await
            .devices
            .is_empty());
    }
    #[test]
    fn switchboard_push_rejects_internal_untrusted_and_malformed_endpoints() {
        let (mut sub, _) = subscription();
        for endpoint in [
            "http://fcm.googleapis.com/x",
            "https://127.0.0.1/x",
            "https://fcm.googleapis.com.evil.test/x",
            "https://evil.test/x",
            "https://fcm.googleapis.com:8090/x",
            "https://u:p@fcm.googleapis.com/x",
            "https://fcm.googleapis.com/x#y",
        ] {
            sub.endpoint = endpoint.into();
            assert!(validate(&sub).is_err(), "{endpoint}");
        }
        sub.endpoint = "https://fcm.googleapis.com/x".into();
        sub.keys.auth = B64.encode([1; 15]);
        assert!(validate(&sub).is_err());
    }
    #[tokio::test]
    async fn switchboard_push_deduplicates_retries_and_removes_expired_devices() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("push.json");
        let push = Push::load(file.clone()).await.unwrap();
        let (sub, _) = subscription();
        push.subscribe(sub.clone(), &json!({})).await.unwrap();
        let sent = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut backoff = HashMap::new();
        let send = |_: Subscription, _: Value| {
            sent.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(StatusCode::CREATED) }
        };
        push.deliver(&snapshot("approval", "approval"), &mut backoff, send)
            .await;
        // Polling, reconnecting a missing host, and restarting do not repeat an alert.
        push.deliver(&snapshot("approval", "approval"), &mut backoff, send)
            .await;
        push.deliver(
            &json!({"panes":[],"errors":[{"host":"linux"}]}),
            &mut backoff,
            send,
        )
        .await;
        let push = Push::load(file).await.unwrap();
        push.deliver(&snapshot("approval", "approval"), &mut backoff, send)
            .await;
        assert_eq!(sent.load(std::sync::atomic::Ordering::SeqCst), 1);
        push.deliver(&snapshot("working", ""), &mut backoff, send)
            .await;
        push.deliver(&snapshot("approval", "approval"), &mut backoff, send)
            .await;
        assert_eq!(sent.load(std::sync::atomic::Ordering::SeqCst), 2);
        push.deliver(&snapshot("ready", "result:2"), &mut backoff, |_, _| async {
            Ok(StatusCode::SERVICE_UNAVAILABLE)
        })
        .await;
        push.deliver(&snapshot("ready", "result:2"), &mut backoff, send)
            .await;
        assert_eq!(
            sent.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "failed service backs off even if attention changes"
        );
        backoff.clear();
        push.deliver(&snapshot("ready", "result:2"), &mut backoff, send)
            .await;
        assert_eq!(sent.load(std::sync::atomic::Ordering::SeqCst), 3);
        push.deliver(&snapshot("input", "question"), &mut backoff, |_, _| async {
            Ok(StatusCode::GONE)
        })
        .await;
        assert!(push.data.lock().await.devices.is_empty());
    }
    #[test]
    fn switchboard_push_skips_reviewed_results_and_links_to_the_correct_pane() {
        let mut snapshot = snapshot("ready", "result:1");
        let alert = alerts(&snapshot).pop().unwrap();
        assert_eq!(alert.payload["title"], "Build the app");
        assert_eq!(
            alert.payload["url"],
            "/?host=linux&session=work+%26+home&pane=7"
        );
        snapshot["panes"][0]["seen"] = json!(true);
        assert!(alerts(&snapshot).is_empty());
    }
}
