//! Invitation pairing is separate from agent messages and the local native terminal engine.
mod board_host;
mod crypto;
mod direct;
pub(super) mod discovery;
mod inboxes;
mod storage;
mod sync;
#[cfg(test)]
mod tests;
pub(super) mod transport;

use super::*;
use crypto::{hash, secret, verification, verify, Identity};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::RwLock,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct Member {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub signing: String,
    pub encryption: String,
    pub certificate: String,
}
impl Member {
    fn validate(&self) -> anyhow::Result<()> {
        name(&self.name)?;
        endpoint(&self.endpoint)?;
        anyhow::ensure!(
            self.id == hash(crypto::decode(&self.signing)?)
                && crypto::decode(&self.signing)?.len() == 32
                && crypto::decode(&self.encryption)?.len() == 32,
            "Invalid machine identity"
        );
        fingerprint(&self.certificate)?;
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Signed<T> {
    pub value: T,
    pub signature: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Membership {
    id: String,
    name: String,
    administrator: String,
    version: u64,
    members: BTreeMap<String, Member>,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Invitation {
    id: String,
    secret: String,
    expires: u64,
    mesh_id: String,
    mesh_name: String,
    administrator: Member,
}
impl Invitation {
    fn link(&self) -> anyhow::Result<String> {
        Ok(format!(
            "switchboard://join#{}",
            crypto::encode(serde_json::to_vec(self)?)
        ))
    }
    fn parse(link: &str, now: u64) -> anyhow::Result<Self> {
        anyhow::ensure!(link.len() <= 8192, "Invitation link is too long");
        let url =
            url::Url::parse(link.trim()).map_err(|_| anyhow::anyhow!("Invalid invitation link"))?;
        anyhow::ensure!(
            url.scheme() == "switchboard"
                && url.host_str() == Some("join")
                && url.path().is_empty()
                && url.query().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.port().is_none(),
            "Invalid invitation link"
        );
        let invite: Self =
            serde_json::from_slice(&crypto::decode(url.fragment().ok_or_else(|| {
                anyhow::anyhow!("Invitation is missing its pairing information")
            })?)?)?;
        invite.administrator.validate()?;
        name(&invite.mesh_name)?;
        anyhow::ensure!(
            crypto::decode(&invite.secret)?.len() == 32
                && invite.expires > now
                && invite.expires <= now + 600 + CLOCK_SKEW,
            "Invitation expired; create a new invitation"
        );
        Ok(invite)
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct InviteRecord {
    // The shareable invitation secret is never returned from the ordinary status API.
    secret_hash: String,
    expires: u64,
    cancelled: bool,
    approved: Option<String>,
    requests: BTreeMap<String, Pending>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct JoinRequest {
    invitation: String,
    request: String,
    member: Member,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct JoinAttempt {
    secret: String,
    request: Signed<JoinRequest>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    request: JoinRequest,
    code: String,
    denied: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct EnvelopeHeader {
    pub issuer: String,
    pub recipient: String,
    pub purpose: String,
    pub version: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Envelope {
    pub header: EnvelopeHeader,
    pub encapsulated: String,
    pub ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Credential {
    terminal: String,
    gateway: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Installed {
    version: u64,
    envelope_hash: String,
    credential: Credential,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Approved {
    #[serde(default)]
    board_hosts: Vec<board_host::Selection>,
    membership: Signed<Membership>,
    credential: Envelope,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(super) enum Decision {
    Pending { code: String },
    Approved { approved: Approved },
    Denied,
}
#[derive(Clone, Serialize, Deserialize)]
struct Joining {
    invitation: Invitation,
    attempt: JoinAttempt,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Database {
    #[serde(default)]
    board_hosts: Vec<board_host::Selection>,
    local: Option<Member>,
    membership: Option<Signed<Membership>>,
    invitations: BTreeMap<String, InviteRecord>,
    incoming: BTreeMap<String, Installed>,
    outgoing: BTreeMap<String, Credential>,
    joining: Option<Joining>,
    #[serde(default)]
    direct_incoming: BTreeMap<String, direct::Offer>,
    #[serde(default)]
    direct_sent: BTreeMap<String, direct::Sent>,
}

impl Database {
    /// Creating an invitation makes a group holding only this computer. Until
    /// another computer joins it, that group must not block joining another one.
    fn can_join(&self) -> bool {
        match (&self.membership, &self.local) {
            (None, _) => true,
            (Some(membership), Some(local)) => {
                membership.value.members.len() == 1
                    && membership.value.members.contains_key(&local.id)
                    && self.board_hosts.is_empty()
                    && self.incoming.is_empty()
                    && self.outgoing.is_empty()
            },
            _ => false,
        }
    }
    /// Only on this computer's own explicit join or approval.
    fn leave_solo_group(&mut self) {
        if self.membership.is_some() && self.can_join() {
            self.membership = None;
            self.board_hosts.clear();
            self.invitations.clear();
            self.direct_sent.clear();
        }
    }
}

pub(super) trait TokenIssuer: Send + Sync {
    fn issue(&self, peer: &str) -> anyhow::Result<String>;
}
struct NativeIssuer;
impl TokenIssuer for NativeIssuer {
    fn issue(&self, peer: &str) -> anyhow::Result<String> {
        let name = format!("switchboard-{peer}-{}", secret());
        zellij_utils::web_authentication_tokens::create_token(Some(name), false)
            .map(|(token, _)| token)
            .map_err(|_| anyhow::anyhow!("Cannot issue a peer terminal credential"))
    }
}

pub(super) struct Mesh {
    identity: Identity,
    storage: storage::Storage,
    database: Mutex<Database>,
    catalog: RwLock<BTreeMap<String, Arc<Host>>>,
    issued: RwLock<BTreeMap<String, Arc<Host>>>,
    local_engine: Arc<Host>,
    issuer: Arc<dyn TokenIssuer>,
    gateway: Mutex<Option<String>>,
    enrollment: Mutex<()>,
    pub(super) bridge: RwLock<Option<(storage::Storage, u16, String)>>,
}
impl Mesh {
    pub async fn open(root: PathBuf, local_engine: Arc<Host>) -> anyhow::Result<Arc<Self>> {
        Self::with_issuer(root, local_engine, Arc::new(NativeIssuer)).await
    }
    async fn with_issuer(
        root: PathBuf,
        local_engine: Arc<Host>,
        issuer: Arc<dyn TokenIssuer>,
    ) -> anyhow::Result<Arc<Self>> {
        anyhow::ensure!(
            local_engine.is_local_engine(),
            "Mesh gateway requires a loopback or pinned HTTPS engine on a local interface"
        );
        let storage = storage::Storage::open(&root)?;
        let identity = match storage.read("identity.json")? {
            Some(identity) => identity,
            None => {
                let identity = Identity::generate()?;
                storage.write("identity.json", &identity)?;
                identity
            },
        };
        let database = storage.read("state.json")?.unwrap_or_default();
        let mesh = Arc::new(Self {
            identity,
            storage,
            database: Mutex::new(database),
            catalog: RwLock::new(BTreeMap::new()),
            issued: RwLock::new(BTreeMap::new()),
            local_engine,
            issuer,
            gateway: Mutex::new(None),
            enrollment: Mutex::new(()),
            bridge: RwLock::new(None),
        });
        {
            let db = mesh.database.lock().await;
            mesh.catalog(&db)?;
        }
        Ok(mesh)
    }
    pub fn attach_bridge(&self, port: u16) -> anyhow::Result<()> {
        let storage = storage::Storage::open(&peer_bridge::directory(
            self.local_engine
                .origin
                .port_or_known_default()
                .unwrap_or(8082),
        ))?;
        *self.bridge.write().unwrap() = Some((storage, port, secret()));
        Ok(())
    }
    pub fn hosts(&self) -> Vec<Arc<Host>> {
        self.catalog.read().unwrap().values().cloned().collect()
    }
    pub fn host(&self, id: &str) -> Option<Arc<Host>> {
        self.catalog.read().unwrap().get(id).cloned()
    }
    fn save(&self, db: &Database) -> anyhow::Result<()> {
        // Immutable versioned credential files are staged before the atomic manifest switch.
        // A restarted relay reconstructs its catalog from this one committed manifest.
        for (id, installed) in &db.incoming {
            self.storage.bytes(
                &format!("{id}-{}-terminal", installed.version),
                installed.credential.terminal.as_bytes(),
            )?;
            self.storage.bytes(
                &format!("{id}-{}-gateway", installed.version),
                installed.credential.gateway.as_bytes(),
            )?;
        }
        for (peer, credential) in &db.outgoing {
            self.storage.bytes(
                &format!("issued-{peer}-terminal"),
                credential.terminal.as_bytes(),
            )?;
        }
        self.storage.write("state.json", db)?;
        self.catalog(db)
    }
    fn catalog(&self, db: &Database) -> anyhow::Result<()> {
        let mut hosts = BTreeMap::new();
        if let Some(membership) = &db.membership {
            for (id, installed) in &db.incoming {
                let member = membership
                    .value
                    .members
                    .get(id)
                    .ok_or_else(|| anyhow::anyhow!("Credential issuer is not a member"))?;
                let path = |purpose| {
                    self.storage
                        .root
                        .join(format!("{id}-{}-{purpose}", installed.version))
                        .to_string_lossy()
                        .to_string()
                };
                let config = HostConfig {
                    id: format!("mesh-{id}"),
                    name: member.name.clone(),
                    url: member.endpoint.clone(),
                    token_file: path("terminal"),
                    gateway_token_file: Some(path("gateway")),
                    tls_fingerprint: Some(member.certificate.clone()),
                    artifact_urls: Value::Null,
                    escape_transport: Some("gateway".into()),
                    zellij_binary: None,
                };
                let current = self.catalog.read().unwrap().get(&config.id).cloned();
                let host = match current {
                    Some(host)
                        if host.config.url == config.url
                            && host.config.token_file == config.token_file
                            && host.config.name == config.name
                            && host.config.tls_fingerprint == config.tls_fingerprint =>
                    {
                        host
                    },
                    _ => Arc::new(Host::new(config)?),
                };
                hosts.insert(host.config.id.clone(), host);
            }
        }
        let mut issued = BTreeMap::new();
        for peer in db.outgoing.keys() {
            let mut config = self.local_engine.config.clone();
            config.escape_transport = Some("local".into());
            config.token_file = self
                .storage
                .root
                .join(format!("issued-{peer}-terminal"))
                .to_string_lossy()
                .to_string();
            let host = self
                .issued
                .read()
                .unwrap()
                .get(peer)
                .cloned()
                .unwrap_or(Arc::new(Host::new(config)?));
            issued.insert(peer.clone(), host);
        }
        *self.issued.write().unwrap() = issued;
        *self.catalog.write().unwrap() = hosts;
        Ok(())
    }
    async fn configure(
        self: &Arc<Self>,
        computer_name: String,
        address: String,
    ) -> anyhow::Result<()> {
        name(&computer_name)?;
        endpoint(&address)?;
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let first_configuration = db.local.is_none();
        let mut member = self.identity.member(computer_name, address)?;
        if let Some(existing) = &db.local {
            member.certificate = existing.certificate.clone();
        }
        if let Some(existing) = &db.local {
            anyhow::ensure!(
                existing == &member,
                "This computer is already configured; use its existing name and address"
            );
        } else {
            db.local = Some(member);
            self.save(&db)?;
            *committed = db;
        }
        drop(committed);
        let result = self.start_gateway().await;
        if result.is_err() && first_configuration {
            let mut committed = self.database.lock().await;
            let mut db = committed.clone();
            db.local = None;
            self.save(&db)?;
            *committed = db;
        }
        result
    }
    async fn create(&self, mesh_name: String, now: u64) -> anyhow::Result<Value> {
        name(&mesh_name)?;
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let local = db
            .local
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Configure this computer first"))?;
        if db.membership.is_none() {
            let membership = Membership {
                id: secret(),
                name: mesh_name.clone(),
                administrator: local.id.clone(),
                version: 1,
                members: [(local.id.clone(), local.clone())].into_iter().collect(),
            };
            db.membership = Some(self.identity.sign(membership)?);
        }
        let membership = &db.membership.as_ref().unwrap().value;
        anyhow::ensure!(membership.name == mesh_name, "Use the existing mesh name");
        let invite = Invitation {
            id: secret(),
            secret: secret(),
            expires: now + 600,
            mesh_id: membership.id.clone(),
            mesh_name,
            administrator: local,
        };
        db.invitations
            .retain(|_, v| v.expires > now || v.approved.is_some());
        db.invitations.insert(
            invite.id.clone(),
            InviteRecord {
                secret_hash: hash(&invite.secret),
                expires: invite.expires,
                cancelled: false,
                approved: None,
                requests: BTreeMap::new(),
            },
        );
        self.save(&db)?;
        *committed = db;
        Ok(json!({ "id": invite.id, "link": invite.link()?, "expires": invite.expires }))
    }
    fn record<'a>(
        db: &'a mut Database,
        attempt: &JoinAttempt,
    ) -> anyhow::Result<&'a mut InviteRecord> {
        verify(&attempt.request, &attempt.request.value.member)?;
        attempt.request.value.member.validate()?;
        let record = db
            .invitations
            .get_mut(&attempt.request.value.invitation)
            .ok_or_else(|| anyhow::anyhow!("Invitation unavailable; request a new link"))?;
        // Constant-time compare after hashing avoids comparing bearer secrets directly.
        use subtle::ConstantTimeEq;
        anyhow::ensure!(
            bool::from(
                hash(&attempt.secret)
                    .as_bytes()
                    .ct_eq(record.secret_hash.as_bytes())
            ),
            "Invitation rejected"
        );
        Ok(record)
    }
    async fn request(&self, attempt: JoinAttempt, now: u64) -> anyhow::Result<Decision> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let local = db
            .local
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Inviter unavailable"))?;
        let membership = db
            .membership
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Mesh unavailable"))?;
        let value = &attempt.request.value;
        if let Some(sent) = db.direct_sent.get(&value.invitation) {
            anyhow::ensure!(
                &sent.request == value,
                "Pairing request differs from the selected computer"
            );
        }
        let record = Self::record(&mut db, &attempt)?;
        if record.approved.as_deref() == Some(&value.request) {
            anyhow::ensure!(
                record
                    .requests
                    .get(&value.request)
                    .is_some_and(|p| &p.request == value),
                "Approved pairing request changed"
            );
            let credential = db
                .outgoing
                .get(&value.member.id)
                .ok_or_else(|| anyhow::anyhow!("Enrollment incomplete; retry"))?;
            return Ok(Decision::Approved {
                approved: Approved {
                    board_hosts: db.board_hosts.clone(),
                    membership: self.identity.sign(membership.value)?,
                    credential: self.identity.seal(&local, &value.member, 1, credential)?,
                },
            });
        }
        anyhow::ensure!(
            record.approved.is_none() && !record.cancelled && record.expires > now,
            "Invitation consumed, cancelled or expired; request a new link"
        );
        if let Some(pending) = record.requests.get(&value.request) {
            anyhow::ensure!(&pending.request == value, "Pairing request changed");
            return Ok(if pending.denied {
                Decision::Denied
            } else {
                Decision::Pending {
                    code: pending.code.clone(),
                }
            });
        }
        anyhow::ensure!(
            record.requests.len() < 8,
            "Too many pairing requests; cancel and create a new invitation"
        );
        let invite = Invitation {
            id: value.invitation.clone(),
            secret: String::new(),
            expires: record.expires,
            mesh_id: membership.value.id,
            mesh_name: membership.value.name,
            administrator: local,
        };
        let code = verification(&invite, value)?;
        record.requests.insert(
            value.request.clone(),
            Pending {
                request: value.clone(),
                code: code.clone(),
                denied: false,
            },
        );
        // Add computer already chose this exact request (checked above); its
        // acceptance completes pairing.
        let chosen = db.direct_sent.contains_key(&value.invitation);
        let (invitation, request) = (value.invitation.clone(), value.request.clone());
        self.save(&db)?;
        *committed = db;
        drop(committed);
        if chosen {
            self.approve(&invitation, &request, &code, true, now)
                .await?;
            return Box::pin(self.request(attempt, now)).await;
        }
        Ok(Decision::Pending { code })
    }
    async fn approve(
        &self,
        invite_id: &str,
        request_id: &str,
        code: &str,
        allow: bool,
        now: u64,
    ) -> anyhow::Result<()> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        anyhow::ensure!(db.local.is_some(), "Computer unavailable");
        let mut membership = db
            .membership
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Mesh unavailable"))?
            .value
            .clone();
        let record = db
            .invitations
            .get_mut(invite_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown invitation"))?;
        anyhow::ensure!(
            !record.cancelled && record.expires > now && record.approved.is_none(),
            "Invitation consumed, cancelled or expired"
        );
        let pending = record
            .requests
            .get_mut(request_id)
            .ok_or_else(|| anyhow::anyhow!("Unknown pairing request"))?;
        anyhow::ensure!(!pending.denied, "Pairing was denied");
        anyhow::ensure!(
            pending.code == code,
            "Verification code does not match; deny this request"
        );
        if !allow {
            pending.denied = true;
            self.save(&db)?;
            *committed = db;
            return Ok(());
        }
        let member = pending.request.member.clone();
        anyhow::ensure!(
            !membership
                .members
                .values()
                .any(|m| m.name.eq_ignore_ascii_case(&member.name) || m.id == member.id),
            "Computer name or identity already belongs to the mesh"
        );
        // Consumption, membership and the exact issued credential commit together under one lock.
        let credential = Credential {
            terminal: self.issuer.issue(&member.id)?,
            gateway: secret(),
        };
        record.approved = Some(request_id.into());
        membership.version += 1;
        membership.members.insert(member.id.clone(), member.clone());
        db.membership = Some(self.identity.sign(membership)?);
        db.outgoing.insert(member.id, credential);
        self.save(&db)?;
        *committed = db;
        Ok(())
    }
    async fn install(
        &self,
        approved: Approved,
        invitation: &Invitation,
    ) -> anyhow::Result<Envelope> {
        verify(&approved.membership, &invitation.administrator)?;
        let membership = &approved.membership.value;
        anyhow::ensure!(
            membership.id == invitation.mesh_id
                && membership.name == invitation.mesh_name
                && membership.members.get(&invitation.administrator.id)
                    == Some(&invitation.administrator),
            "Membership does not match the invitation"
        );
        for member in membership.members.values() {
            member.validate()?;
        }
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let local = db
            .local
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Local identity unavailable"))?;
        anyhow::ensure!(
            membership.members.get(&local.id) == Some(&local),
            "Approval belongs to another computer"
        );
        if let Some(current) = &db.membership {
            anyhow::ensure!(
                current.value.id == membership.id && current.value.version <= membership.version,
                "Older or unrelated membership rejected"
            );
        }
        let credential =
            self.identity
                .open(&invitation.administrator, &local, &approved.credential)?;
        Self::install_credential(&mut db, &approved.credential, credential)?;
        db.membership = Some(approved.membership);
        self.merge_board_hosts(&mut db, &approved.board_hosts)?;
        if !db.outgoing.contains_key(&invitation.administrator.id) {
            db.outgoing.insert(
                invitation.administrator.id.clone(),
                Credential {
                    terminal: self.issuer.issue(&invitation.administrator.id)?,
                    gateway: secret(),
                },
            );
        }
        self.save(&db)?;
        let envelope = self.identity.seal(
            &local,
            &invitation.administrator,
            1,
            &db.outgoing[&invitation.administrator.id],
        )?;
        *committed = db;
        Ok(envelope)
    }
    fn install_credential(
        db: &mut Database,
        envelope: &Envelope,
        credential: Credential,
    ) -> anyhow::Result<()> {
        let digest = hash(serde_json::to_vec(envelope)?);
        if let Some(current) = db.incoming.get(&envelope.header.issuer) {
            anyhow::ensure!(
                envelope.header.version >= current.version,
                "Older credential version rejected"
            );
            if envelope.header.version == current.version {
                // Re-sealing on a transport retry changes ciphertext, but may not change a current credential.
                anyhow::ensure!(
                    current.credential.terminal == credential.terminal
                        && current.credential.gateway == credential.gateway,
                    "Conflicting current credential rejected"
                );
                return Ok(());
            }
        }
        anyhow::ensure!(
            envelope.header.version > 0
                && !credential.terminal.is_empty()
                && crypto::decode(&credential.gateway)?.len() == 32,
            "Invalid credential"
        );
        db.incoming.insert(
            envelope.header.issuer.clone(),
            Installed {
                version: envelope.header.version,
                envelope_hash: digest,
                credential,
            },
        );
        Ok(())
    }
    async fn complete(&self, envelope: Envelope) -> anyhow::Result<()> {
        let mut committed = self.database.lock().await;
        let mut db = committed.clone();
        let local = db
            .local
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Local computer unavailable"))?;
        let membership = db
            .membership
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Mesh unavailable"))?;
        let issuer = membership
            .value
            .members
            .get(&envelope.header.issuer)
            .ok_or_else(|| anyhow::anyhow!("Unauthorized credential issuer"))?;
        let credential = self.identity.open(issuer, local, &envelope)?;
        Self::install_credential(&mut db, &envelope, credential)?;
        self.save(&db)?;
        *committed = db;
        Ok(())
    }
    async fn status(&self) -> Value {
        let gateway_available = self.gateway.lock().await.is_some();
        let db = self.database.lock().await;
        let pending: Vec<_> = db.invitations.iter().flat_map(|(id, record)| record.requests.values().filter(|p| !p.denied && record.approved.is_none() && !record.cancelled && record.expires > now()).map(move |p| json!({"invitation": id, "request": p.request.request, "computer": p.request.member.name, "address": p.request.member.endpoint, "code": p.code}))).collect();
        let members: Vec<_> = db.membership.as_ref().map(|m| m.value.members.values().map(|member| json!({ "id": member.id, "name": member.name, "address": member.endpoint, "local": db.local.as_ref().is_some_and(|l| l.id == member.id), "state": if db.incoming.contains_key(&member.id) { "paired" } else { "credential_distribution_pending" } })).collect()).unwrap_or_default();
        json!({"board_host":self.board_host_status(&db),"incoming":direct::incoming(&db,now()),"sent":direct::sent(&db,now()),"configured": db.local.is_some(), "gateway_available": gateway_available, "computer": db.local.as_ref().map(|m| json!({"name":m.name,"address":m.endpoint})), "mesh": db.membership.as_ref().map(|m| &m.value.name), "administrator": true, "can_invite":true, "group_sync":true, "requests":pending, "members":members, "joining": db.joining.as_ref().map(|j| json!({"computer":j.invitation.administrator.name,"mesh":j.invitation.mesh_name,"code":verification(&j.invitation,&j.attempt.request.value).ok()}))})
    }
}

fn name(value: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.trim().is_empty() && value.len() <= 80 && !value.chars().any(char::is_control),
        "Use a computer or mesh name of 1 to 80 characters"
    );
    Ok(())
}
fn endpoint(value: &str) -> anyhow::Result<url::Url> {
    let url = url::Url::parse(value).map_err(|_| {
        anyhow::anyhow!("Use an HTTPS address with a fixed LAN or private-network IP and port")
    })?;
    anyhow::ensure!(
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.port().is_some(),
        "Use an HTTPS origin with an explicit gateway port"
    );
    let address: std::net::IpAddr = url
        .host_str()
        .unwrap()
        .trim_matches(['[', ']'])
        .parse()
        .map_err(|_| anyhow::anyhow!("Use a fixed LAN or private-network IP address"))?;
    anyhow::ensure!(
        !address.is_loopback() && !address.is_unspecified() && !address.is_multicast(),
        "Gateway address must be reachable by the other computer"
    );
    Ok(url)
}
/// Seconds a computer's clock may run ahead of another's; Windows clocks drift.
const CLOCK_SKEW: u64 = 300;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
