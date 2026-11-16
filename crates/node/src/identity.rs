use crate::storage::{atomic_json, read_json};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Locally generated identity. Its Debug/Serialize projection never includes key or token.
#[derive(Clone)]
pub struct Identity {
    file: PathBuf,
    pub node_id: String,
    pub installation_id: String,
    public_key: String,
    signing_key: SigningKey,
    token: Option<String>,
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Identity")
            .field("node_id", &self.node_id)
            .field("installation_id", &self.installation_id)
            .finish_non_exhaustive()
    }
}

impl Identity {
    pub fn open(state_dir: &Path) -> Result<Self> {
        let file = state_dir.join("identity.json");
        let mut generated = false;
        let data = match read_json(&file)? {
            Some(value) => value,
            None => {
                let mut secret = [0u8; 32];
                getrandom::getrandom(&mut secret).map_err(|_| {
                    anyhow::anyhow!("secure random source unavailable for node identity")
                })?;
                let key = SigningKey::from_bytes(&secret);
                let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
                let node_id = format!("{:x}", Sha256::digest(key.verifying_key().as_bytes()));
                let value = json!({
                    "version": 1,
                    "node_id": node_id,
                    "installation_id": Uuid::new_v4().simple().to_string(),
                    "public_key": public_key,
                    "private_key": URL_SAFE_NO_PAD.encode(secret),
                });
                generated = true;
                value
            }
        };
        if data["version"] != 1 {
            bail!("unsupported persistent node identity version");
        }
        let public_key = required_string(&data, "public_key")?.to_owned();
        let raw_public = decode_fixed::<32>(&public_key)?;
        if URL_SAFE_NO_PAD.encode(raw_public) != public_key {
            bail!("noncanonical node public key");
        }
        let private = required_string(&data, "private_key")?;
        let secret = decode_fixed::<32>(private)?;
        let signing_key = SigningKey::from_bytes(&secret);
        if signing_key.verifying_key().as_bytes() != &raw_public {
            bail!("persistent private and public node keys do not match");
        }
        let node_id = required_string(&data, "node_id")?.to_owned();
        if node_id != format!("{:x}", Sha256::digest(raw_public)) {
            bail!("node id is not lowercase SHA-256 of the raw Ed25519 public key");
        }
        loom_protocol::NodeId::parse(node_id.clone())?;
        let installation_id = required_string(&data, "installation_id")?.to_owned();
        loom_protocol::InstallationId::parse(installation_id.clone())?;
        if generated {
            if file.exists() {
                bail!("identity was concurrently created; refusing to replace it");
            }
            atomic_json(&file, &data)?;
        }
        let token = match data.get("token") {
            None | Some(Value::Null) => None,
            Some(Value::String(token)) if token.len() >= 16 && token.len() <= 4096 => {
                Some(token.clone())
            }
            _ => bail!("persistent node token is invalid"),
        };
        Ok(Self {
            file,
            node_id,
            installation_id,
            public_key,
            signing_key,
            token,
        })
    }

    pub fn public_request(&self) -> Value {
        json!({"protocol":"loom.node.v1","node_id":self.node_id,"installation_id":self.installation_id,"public_key":self.public_key})
    }

    pub fn sign_challenge(&self, nonce: &str) -> Result<String> {
        if nonce.len() != 64
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            bail!("registration challenge nonce is not 64 lowercase hex characters");
        }
        Ok(URL_SAFE_NO_PAD.encode(self.signing_key.sign(nonce.as_bytes()).to_bytes()))
    }

    pub fn public_key(&self) -> &str {
        &self.public_key
    }

    pub fn sign_binding_declaration(&self, canonical_json: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(self.signing_key.sign(canonical_json).to_bytes())
    }

    pub fn token(&self) -> Result<&str> {
        self.token.as_deref().context(
            "node is not enrolled; provide an enrollment code through LOOM_ENROLLMENT_CODE",
        )
    }

    pub fn set_token(&mut self, token: &str) -> Result<()> {
        if token.len() < 16 || token.len() > 4096 || token.chars().any(char::is_whitespace) {
            bail!("registration response contains an invalid node token");
        }
        let data = json!({
            "version": 1,
            "node_id": self.node_id,
            "installation_id": self.installation_id,
            "public_key": self.public_key,
            "private_key": URL_SAFE_NO_PAD.encode(self.signing_key.to_bytes()),
            "token": token,
            "enrolled_at": chrono::Utc::now(),
        });
        atomic_json(&self.file, &data)?;
        self.token = Some(token.to_owned());
        Ok(())
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .with_context(|| format!("persistent identity has no valid {key}"))
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N]> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .context("invalid base64url key")?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("incorrect key length"))
}
