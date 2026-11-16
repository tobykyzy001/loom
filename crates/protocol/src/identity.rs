use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::core::{
    ChallengeId, HarnessKind, InstallationId, NodeId, ProfileId, RequestId, WorkerId,
};
use crate::error::{ProtocolError, ProtocolResult};
use crate::node::{Capability, NodeEnvelopeHeader, RegisterNodeRequest};

/// Exactly 64 lowercase hex chars; never a secret or an authorization token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct ChallengeNonce(String);

impl ChallengeNonce {
    pub fn parse(value: impl Into<String>) -> ProtocolResult<Self> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(ProtocolError::InvalidChallenge);
        }
        Ok(Self(value))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    pub fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for ChallengeNonce {
    type Error = ProtocolError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<ChallengeNonce> for String {
    fn from(value: ChallengeNonce) -> Self {
        value.0
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct NodePublicKey(VerifyingKey);

impl NodePublicKey {
    pub fn from_bytes(bytes: [u8; 32]) -> ProtocolResult<Self> {
        VerifyingKey::from_bytes(&bytes)
            .map(Self)
            .map_err(|_| ProtocolError::InvalidSignature)
    }

    pub fn from_base64url(value: &str) -> ProtocolResult<Self> {
        let bytes = URL_SAFE_NO_PAD
            .decode(value)
            .map_err(|_| ProtocolError::InvalidSignature)?;
        let raw: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| ProtocolError::InvalidSignature)?;
        Self::from_bytes(raw).and_then(|key| {
            (key.to_base64url() == value)
                .then_some(key)
                .ok_or(ProtocolError::InvalidSignature)
        })
    }

    pub fn to_base64url(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.0.as_bytes())
    }

    pub fn node_id(&self) -> ProtocolResult<NodeId> {
        NodeId::parse(format!("{:x}", Sha256::digest(self.0.as_bytes())))
    }

    pub fn verify_challenge(&self, nonce: &ChallengeNonce, signature: &str) -> ProtocolResult<()> {
        let bytes = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| ProtocolError::InvalidSignature)?;
        let raw: [u8; 64] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| ProtocolError::InvalidSignature)?;
        if URL_SAFE_NO_PAD.encode(raw) != signature {
            return Err(ProtocolError::InvalidSignature);
        }
        let signature = Signature::from_bytes(&raw);
        self.0
            .verify(nonce.as_bytes(), &signature)
            .map_err(|_| ProtocolError::InvalidSignature)
    }

    #[cfg(test)]
    pub fn signing_key(seed: [u8; 32]) -> ed25519_dalek::SigningKey {
        ed25519_dalek::SigningKey::from_bytes(&seed)
    }

    #[cfg(any(test, feature = "fixture-signing"))]
    pub fn from_signing_key(signing_key: &ed25519_dalek::SigningKey) -> Self {
        Self(signing_key.verifying_key())
    }

    #[cfg(any(test, feature = "fixture-signing"))]
    pub fn sign(signing_key: &ed25519_dalek::SigningKey, nonce: &ChallengeNonce) -> String {
        use ed25519_dalek::Signer;
        URL_SAFE_NO_PAD.encode(signing_key.sign(nonce.as_bytes()).to_bytes())
    }
}

impl std::fmt::Debug for NodePublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NodePublicKey(..)")
    }
}

impl Serialize for NodePublicKey {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_base64url())
    }
}

impl<'de> Deserialize<'de> for NodePublicKey {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::from_base64url(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeIdentity {
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub public_key: NodePublicKey,
    pub worker_id: WorkerId,
    pub harness_kind: HarnessKind,
    pub profile_id: ProfileId,
    pub registered_at: DateTime<Utc>,
    pub revoked: bool,
}

impl NodeIdentity {
    pub fn from_registration(
        request: &RegisterNodeRequest,
        challenge: &RegistrationChallenge,
        enrollment_code_present: bool,
        now: DateTime<Utc>,
    ) -> ProtocolResult<Self> {
        challenge.consume(request, now)?;
        if !enrollment_code_present {
            return Err(ProtocolError::OperationNotGranted);
        }
        let public_key = NodePublicKey::from_base64url(&request.public_key)?;
        Ok(Self {
            node_id: public_key.node_id()?,
            installation_id: request.installation_id.clone(),
            public_key,
            worker_id: request.worker_id.clone(),
            harness_kind: request.harness_kind.clone(),
            profile_id: request.profile_id.clone(),
            registered_at: now,
            revoked: false,
        })
    }

    /// Authenticate the existing bearer token outside this crate. Challenge and
    /// enrollment code are not used for token rotation; the raw key must match.
    pub fn authorize_session_rotation(
        &self,
        request: &RegisterNodeRequest,
        authenticated_bearer: bool,
        now: DateTime<Utc>,
    ) -> ProtocolResult<()> {
        if !authenticated_bearer {
            return Err(ProtocolError::OperationNotGranted);
        }
        if self.revoked {
            return Err(ProtocolError::NodeRevoked);
        }
        if self.registered_at > now
            || request.node_id != self.node_id
            || request.installation_id != self.installation_id
            || request.public_key != self.public_key.to_base64url()
            || request.worker_id != self.worker_id
            || request.harness_kind != self.harness_kind
            || request.profile_id != self.profile_id
        {
            return Err(ProtocolError::NodeIdentityMismatch);
        }
        Ok(())
    }

    pub fn validate_continuation(
        &self,
        header: &NodeEnvelopeHeader,
        authenticated_bearer: bool,
    ) -> ProtocolResult<()> {
        if !authenticated_bearer {
            return Err(ProtocolError::OperationNotGranted);
        }
        if self.revoked {
            return Err(ProtocolError::NodeRevoked);
        }
        if self.node_id != header.node_id || self.installation_id != header.installation_id {
            return Err(ProtocolError::NodeIdentityMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrationChallenge {
    pub challenge_id: ChallengeId,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub public_key: String,
    pub nonce: ChallengeNonce,
    pub expires_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
}

impl RegistrationChallenge {
    pub fn consume(&self, request: &RegisterNodeRequest, now: DateTime<Utc>) -> ProtocolResult<()> {
        if self.used_at.is_some()
            || self.expires_at <= now
            || self.node_id != request.node_id
            || self.installation_id != request.installation_id
            || self.public_key != request.public_key
            || self.nonce != request.nonce
        {
            return Err(ProtocolError::InvalidChallenge);
        }
        let public_key = NodePublicKey::from_base64url(&request.public_key)?;
        if public_key.node_id()? != request.node_id {
            return Err(ProtocolError::NodeKeyMismatch);
        }
        public_key.verify_challenge(&request.nonce, &request.signed_challenge)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisteredCapabilities(pub Vec<Capability>);

impl RegisteredCapabilities {
    pub fn validate(&self) -> ProtocolResult<()> {
        if self.0.is_empty() {
            return Err(ProtocolError::InvalidLifecycle(
                "registration requires at least one capability",
            ));
        }
        Ok(())
    }
}

/// A server trait boundary: it must securely generate randomness and atomically
/// persist/consume the challenge. No in-memory singleton or fake key store here.
pub trait ChallengeStore {
    fn random_challenge_id(&self) -> ChallengeId;
    fn random_nonce(&self) -> ProtocolResult<ChallengeNonce>;
}

/// Registration must be an atomic DB transaction with unique node identity,
/// challenge row consumed and enrollment-code hash checked by the server.
pub fn registration_request_id(request: &RegisterNodeRequest) -> RequestId {
    request.request_id
}
