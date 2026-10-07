//! Address-based delivery of the existing invitation handshake. Discovery is
//! unauthenticated; only comparing the bound code and local approvals grants trust.
use super::*;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Offer {
    joining: Joining,
    denied: bool,
    accepted: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Sent {
    pub(super) request: JoinRequest,
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Add {
    target: String,
    computer_name: String,
    address: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Delivery {
    link: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    invitation: String,
    code: String,
    allow: bool,
}

pub(super) fn routes() -> Router<RelayState> {
    Router::new()
        .route("/api/mesh/add", post(add))
        .route("/api/mesh/answer", post(answer))
        .route("/api/mesh/ready", post(ready))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Local {
    computer_name: String,
    address: String,
}
async fn ready(
    State(state): State<RelayState>,
    Json(input): Json<Local>,
) -> Result<Json<Value>, Error> {
    let mesh = state.mesh.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Start Switchboard's local terminal server first",
    ))?;
    mesh.configure(input.computer_name, input.address)
        .await
        .map_err(error)?;
    Ok(Json(json!({"ready":true})))
}
fn error(error: anyhow::Error) -> Error {
    let reason = error.to_string();
    if reason.contains("Update Switchboard") {
        return (
            StatusCode::BAD_GATEWAY,
            "Update Switchboard on the other computer, keep it running, and retry.",
        );
    }
    if reason.contains("already belongs") {
        return (
            StatusCode::CONFLICT,
            "This computer already belongs to a group. Joining another group is not supported yet.",
        );
    }
    if reason.contains("address") || reason.contains("HTTPS") {
        return (
            StatusCode::BAD_REQUEST,
            "Enter the other computer's IP address, for example 172.20.10.10.",
        );
    }
    (StatusCode::BAD_REQUEST,"Pairing could not continue. Check the connection and matching codes on both computers, then retry.")
}
fn target(value: &str) -> anyhow::Result<String> {
    let value = value.trim();
    let address = if value.starts_with("https://") {
        value.to_owned()
    } else {
        let ip = value
            .parse::<std::net::IpAddr>()
            .map_err(|_| anyhow::anyhow!("Invalid IP address"))?;
        format!("https://{}", std::net::SocketAddr::new(ip, 8082))
    };
    let url = endpoint(&address)?;
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
async fn add(
    State(state): State<RelayState>,
    Json(input): Json<Add>,
) -> Result<Json<Value>, Error> {
    let mesh = state.mesh.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Switchboard pairing unavailable",
    ))?;
    let address = target(&input.target).map_err(error)?;
    mesh.configure(input.computer_name, input.address)
        .await
        .map_err(error)?;
    let certificate = tokio::time::timeout(Duration::from_secs(5), discover(&address))
        .await
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Cannot reach that computer on port 8082. Check the address and firewall.",
            )
        })?
        .map_err(|_| {
            (
                StatusCode::BAD_GATEWAY,
                "Cannot reach that computer on port 8082. Check the address and firewall.",
            )
        })?;
    let peer = Member {
        id: String::new(),
        name: String::new(),
        endpoint: address.clone(),
        signing: String::new(),
        encryption: String::new(),
        certificate: certificate.clone(),
    };
    let info: Value = mesh
        .remote(&peer, "/mesh/direct-info", &json!({}))
        .await
        .map_err(|_| error(anyhow::anyhow!("Update Switchboard")))?;
    if info["direct_pairing"] != 1 {
        return Err(error(anyhow::anyhow!("Update Switchboard")));
    }
    let created = mesh.create(input.name, now()).await.map_err(error)?;
    let invitation = Invitation::parse(created["link"].as_str().unwrap(), now()).map_err(error)?;
    let result: anyhow::Result<Signed<JoinRequest>> = mesh
        .remote(&peer, "/mesh/offer", &json!({"link":created["link"]}))
        .await;
    let result = async {
        let request = result?;
        verify(&request, &request.value.member)?;
        request.value.member.validate()?;
        anyhow::ensure!(
            request.value.invitation == invitation.id
                && endpoint(&request.value.member.endpoint)? == endpoint(&address)?
                && request.value.member.certificate == certificate,
            "Pairing identity verification failed"
        );
        let code = verification(&invitation, &request.value)?;
        let mut committed = mesh.database.lock().await;
        let mut db = committed.clone();
        db.direct_sent.insert(invitation.id.clone(), Sent {
            request: request.value.clone(), code: code.clone()
        });
        mesh.save(&db)?;
        *committed = db;
        Ok::<_,anyhow::Error>(json!({"invitation":invitation.id,"computer":request.value.member.name,"code":code,"state":"waiting_for_computer"}))
    }.await;
    if result.is_err() {
        let mut committed = mesh.database.lock().await;
        let mut db = committed.clone();
        if let Some(record) = db.invitations.get_mut(&invitation.id) {
            record.cancelled = true;
        }
        if mesh.save(&db).is_ok() {
            *committed = db;
        }
    }
    Ok(Json(result.map_err(error)?))
}
pub(super) async fn info() -> Json<Value> {
    Json(json!({"direct_pairing":1}))
}
pub(super) async fn offer(
    State(mesh): State<Arc<Mesh>>,
    Json(input): Json<Delivery>,
) -> Result<Json<Signed<JoinRequest>>, Error> {
    let invitation = Invitation::parse(&input.link, now()).map_err(error)?;
    Ok(Json(
        mesh.receive_offer(invitation, now()).await.map_err(error)?,
    ))
}
async fn answer(
    State(state): State<RelayState>,
    Json(input): Json<Answer>,
) -> Result<Json<Value>, Error> {
    let mesh = state.mesh.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Switchboard pairing unavailable",
    ))?;
    mesh.answer_offer(&input.invitation, &input.code, input.allow, now())
        .await
        .map_err(error)?;
    if !input.allow {
        return Ok(Json(json!({"state":"denied"})));
    }
    Ok(Json(mesh.resume().await.map_err(error)?))
}
impl Mesh {
    pub(super) async fn receive_offer(
        &self,
        invitation: Invitation,
        time: u64,
    ) -> anyhow::Result<Signed<JoinRequest>> {
        anyhow::ensure!(
            invitation.expires > time && invitation.expires <= time + 600,
            "Invitation expired"
        );
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        anyhow::ensure!(
            db.can_join() && db.joining.is_none(),
            "This computer already belongs to a group or is joining one"
        );
        let member = db
            .local
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Configure this computer's address first"))?;
        anyhow::ensure!(
            invitation.administrator.id != member.id,
            "Cannot pair a computer with itself"
        );
        db.direct_incoming
            .retain(|_, offer| offer.joining.invitation.expires > time);
        if let Some(existing) = db.direct_incoming.get(&invitation.id) {
            anyhow::ensure!(
                !existing.denied && existing.joining.invitation.link()? == invitation.link()?,
                "Invitation changed or denied"
            );
            return Ok(existing.joining.attempt.request.clone());
        }
        anyhow::ensure!(
            db.direct_incoming.len() < 8,
            "Too many pending requests; try again later"
        );
        let request = self.identity.sign(JoinRequest {
            invitation: invitation.id.clone(),
            request: secret(),
            member,
        })?;
        db.direct_incoming.insert(
            invitation.id.clone(),
            Offer {
                joining: Joining {
                    attempt: JoinAttempt {
                        secret: invitation.secret.clone(),
                        request: request.clone(),
                    },
                    invitation,
                },
                denied: false,
                accepted: false,
            },
        );
        self.save(&db)?;
        *committed = db;
        Ok(request)
    }
    pub(super) async fn answer_offer(
        &self,
        id: &str,
        code: &str,
        allow: bool,
        time: u64,
    ) -> anyhow::Result<()> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        anyhow::ensure!(db.can_join(), "This computer already belongs to a group");
        let offer = db
            .direct_incoming
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("Unknown invitation"))?;
        anyhow::ensure!(
            offer.joining.invitation.expires > time && !offer.denied,
            "Invitation expired or denied"
        );
        anyhow::ensure!(
            verification(
                &offer.joining.invitation,
                &offer.joining.attempt.request.value
            )? == code,
            "Verification code mismatch"
        );
        if allow {
            anyhow::ensure!(
                db.joining
                    .as_ref()
                    .is_none_or(|joining| joining.attempt.request.value
                        == offer.joining.attempt.request.value),
                "Another pairing is pending"
            );
            offer.accepted = true;
            let joining = offer.joining.clone();
            db.leave_solo_group();
            db.joining = Some(joining);
        } else {
            anyhow::ensure!(!offer.accepted, "Pairing already accepted");
            offer.denied = true;
        }
        self.save(&db)?;
        *committed = db;
        Ok(())
    }
}
pub(super) fn incoming(db: &Database, time: u64) -> Vec<Value> {
    if !db.can_join() || db.joining.is_some() {
        return vec![];
    }
    db.direct_incoming.iter().filter(|(_,o)|!o.denied&&!o.accepted&&o.joining.invitation.expires>time).map(|(id,o)|json!({"invitation":id,"computer":o.joining.invitation.administrator.name,"address":o.joining.invitation.administrator.endpoint,"code":verification(&o.joining.invitation,&o.joining.attempt.request.value).ok()})).collect()
}
pub(super) fn sent(db: &Database, time: u64) -> Vec<Value> {
    db.direct_sent.iter().filter(|(id,_)|db.invitations.get(*id).is_some_and(|r|r.expires>time&&!r.cancelled&&r.approved.is_none())).map(|(id,s)|json!({"invitation":id,"computer":s.request.member.name,"address":s.request.member.endpoint,"code":s.code})).collect()
}

// Used only to learn a certificate before sending an invitation. It never sends
// terminal credentials. Handshake signatures are checked; subsequent requests
// pin the observed certificate, and both people must confirm the identity code.
#[derive(Debug)]
struct DiscoveryCertificate {
    algorithms: rustls::crypto::WebPkiSupportedAlgorithms,
}
impl ServerCertVerifier for DiscoveryCertificate {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        s: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, s, &self.algorithms)
    }
    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        s: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, s, &self.algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}
async fn discover(address: &str) -> anyhow::Result<String> {
    let url = endpoint(address)?;
    let ip: std::net::IpAddr = url.host_str().unwrap().trim_matches(['[', ']']).parse()?;
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(DiscoveryCertificate {
            algorithms: provider.signature_verification_algorithms,
        }))
        .with_no_client_auth();
    let socket = TcpStream::connect((ip, url.port().unwrap())).await?;
    let socket = tokio_rustls::TlsConnector::from(Arc::new(config))
        .connect(rustls::pki_types::ServerName::IpAddress(ip.into()), socket)
        .await?;
    let cert = socket
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|c| c.first())
        .ok_or_else(|| anyhow::anyhow!("No peer certificate"))?;
    Ok(hash(cert.as_ref()))
}
