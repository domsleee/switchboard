//! RFC 9180 HPKE Auth mode; no local key agreement or AEAD construction.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable,
    Kem as KemTrait, OpModeR, OpModeS, Serializable,
};
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
type Kem = X25519HkdfSha256;

pub(super) fn encode(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub(super) fn decode(value: &str) -> anyhow::Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| anyhow::anyhow!("Invalid encoded identity"))
}
pub(super) fn hash(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub(super) fn secret() -> String {
    use mesh_rand::RngCore;
    let mut bytes = [0; 32];
    mesh_rand::rng().fill_bytes(&mut bytes);
    encode(bytes)
}

#[derive(Serialize, Deserialize)]
pub(super) struct Identity {
    signing: String,
    encryption: String,
    pub certificate: String,
    pub tls_key: String,
}
impl Identity {
    pub fn generate() -> anyhow::Result<Self> {
        let signing = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .map_err(|_| anyhow::anyhow!("Cannot generate machine identity"))?;
        let (encryption, _) = Kem::gen_keypair(&mut mesh_rand::rng());
        let cert = rcgen::generate_simple_self_signed(vec!["switchboard.mesh".into()])?;
        Ok(Self {
            signing: encode(signing.as_ref()),
            encryption: encode(encryption.to_bytes()),
            certificate: encode(cert.cert.der()),
            tls_key: cert.signing_key.serialize_pem(),
        })
    }
    fn signing_key(&self) -> anyhow::Result<Ed25519KeyPair> {
        Ed25519KeyPair::from_pkcs8(&decode(&self.signing)?)
            .map_err(|_| anyhow::anyhow!("Invalid machine identity"))
    }
    pub fn member(&self, name: String, endpoint: String) -> anyhow::Result<Member> {
        let signing = encode(self.signing_key()?.public_key().as_ref());
        let encryption = Kem::sk_to_pk(&<Kem as KemTrait>::PrivateKey::from_bytes(&decode(
            &self.encryption,
        )?)?);
        Ok(Member {
            id: hash(decode(&signing)?),
            name,
            endpoint,
            signing,
            encryption: encode(encryption.to_bytes()),
            certificate: hash(decode(&self.certificate)?),
        })
    }
    pub fn sign<T: Serialize>(&self, value: T) -> anyhow::Result<Signed<T>> {
        let signature = encode(
            self.signing_key()?
                .sign(&serde_json::to_vec(&value)?)
                .as_ref(),
        );
        Ok(Signed { value, signature })
    }
    pub fn seal(
        &self,
        issuer: &Member,
        recipient: &Member,
        version: u64,
        credential: &Credential,
    ) -> anyhow::Result<Envelope> {
        let header = EnvelopeHeader {
            issuer: issuer.id.clone(),
            recipient: recipient.id.clone(),
            version,
            purpose: "switchboard-terminal-v1".into(),
        };
        let private = <Kem as KemTrait>::PrivateKey::from_bytes(&decode(&self.encryption)?)?;
        let public = Kem::sk_to_pk(&private);
        let recipient_key =
            <Kem as KemTrait>::PublicKey::from_bytes(&decode(&recipient.encryption)?)?;
        let mode = OpModeS::Auth((private, public));
        let (encapsulated, mut sender) = hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, Kem, _>(
            &mode,
            &recipient_key,
            b"switchboard credential envelope v1",
            &mut mesh_rand::rng(),
        )?;
        let ciphertext = sender.seal(
            &serde_json::to_vec(credential)?,
            &serde_json::to_vec(&header)?,
        )?;
        Ok(Envelope {
            header,
            encapsulated: encode(encapsulated.to_bytes()),
            ciphertext: encode(ciphertext),
        })
    }
    pub fn open(
        &self,
        issuer: &Member,
        recipient: &Member,
        envelope: &Envelope,
    ) -> anyhow::Result<Credential> {
        anyhow::ensure!(
            envelope.header.issuer == issuer.id
                && envelope.header.recipient == recipient.id
                && envelope.header.purpose == "switchboard-terminal-v1",
            "Credential identity mismatch"
        );
        let issuer_key = <Kem as KemTrait>::PublicKey::from_bytes(&decode(&issuer.encryption)?)?;
        let private = <Kem as KemTrait>::PrivateKey::from_bytes(&decode(&self.encryption)?)?;
        let encapsulated =
            <Kem as KemTrait>::EncappedKey::from_bytes(&decode(&envelope.encapsulated)?)?;
        let mut receiver = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(
            &OpModeR::Auth(issuer_key),
            &private,
            &encapsulated,
            b"switchboard credential envelope v1",
        )?;
        let plaintext = receiver.open(
            &decode(&envelope.ciphertext)?,
            &serde_json::to_vec(&envelope.header)?,
        )?;
        Ok(serde_json::from_slice(&plaintext)?)
    }
}

pub(super) fn verify<T: Serialize>(signed: &Signed<T>, member: &Member) -> anyhow::Result<()> {
    anyhow::ensure!(
        member.id == hash(decode(&member.signing)?),
        "Machine identity mismatch"
    );
    UnparsedPublicKey::new(&ED25519, decode(&member.signing)?)
        .verify(
            &serde_json::to_vec(&signed.value)?,
            &decode(&signed.signature)?,
        )
        .map_err(|_| anyhow::anyhow!("Machine signature rejected"))
}

pub(super) fn verification(invite: &Invitation, request: &JoinRequest) -> anyhow::Result<String> {
    let digest = hash(serde_json::to_vec(&(
        "switchboard verification v1",
        &invite.id,
        &invite.administrator,
        request,
    ))?);
    Ok(format!("{}-{}-{}", &digest[..4], &digest[4..8], &digest[8..12]).to_uppercase())
}

pub(super) fn same(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    hash(a).as_bytes().ct_eq(hash(b).as_bytes()).into()
}
