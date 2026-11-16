use std::fmt;
use std::path::{Component, Path};
use std::str::FromStr;

use chrono::{DateTime, Utc};
use serde::{de, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{ProtocolError, ProtocolResult};

/// The wire version recognized by this crate. Dispatch unknown versions first.
pub const NODE_PROTOCOL_V1: &str = "loom.node.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolVersion(String);

impl ProtocolVersion {
    pub fn v1() -> Self {
        Self(NODE_PROTOCOL_V1.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn reject_unknown(&self) -> ProtocolResult<()> {
        (self.0 == NODE_PROTOCOL_V1)
            .then_some(())
            .ok_or_else(|| ProtocolError::UnsupportedProtocolVersion(self.0.clone()))
    }
}

impl Default for ProtocolVersion {
    fn default() -> Self {
        Self::v1()
    }
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for ProtocolVersion {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ProtocolVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value != NODE_PROTOCOL_V1 {
            return Err(de::Error::custom(format!(
                "unsupported protocol version `{value}`"
            )));
        }
        Ok(Self(value))
    }
}

macro_rules! uuid_id {
    ($name:ident, $field:literal) => {
        #[derive(
            Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }

            pub fn nil() -> Self {
                Self(Uuid::nil())
            }

            pub fn into_inner(self) -> Uuid {
                self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                self.0.fmt(f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                value.parse().map(Self)
            }
        }

        impl From<$name> for Uuid {
            fn from(value: $name) -> Self {
                value.0
            }
        }

        impl AsRef<Uuid> for $name {
            fn as_ref(&self) -> &Uuid {
                &self.0
            }
        }

        impl $name {
            #[doc = concat!("SQL column name for a stored ", $field, " UUID.")]
            pub const SQL_COLUMN: &'static str = $field;
        }
    };
}

uuid_id!(ProjectId, "project_id");
uuid_id!(TicketId, "ticket_id");
uuid_id!(AssignmentId, "assignment_id");
uuid_id!(LeaseId, "lease_id");
uuid_id!(RequestId, "request_id");
uuid_id!(ArtifactId, "artifact_id");
uuid_id!(EffectId, "effect_id");
uuid_id!(ChallengeId, "challenge_id");
uuid_id!(ReportId, "report_id");

/// Fingerprint identity: lowercase SHA-256 of the raw 32-byte Ed25519 public key.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct NodeId(String);

impl NodeId {
    pub fn parse(value: impl Into<String>) -> ProtocolResult<Self> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ProtocolError::InvalidIdentity(
                "node_id must be 64 lowercase hexadecimal characters",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("NodeId").field(&self.0).finish()
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for NodeId {
    type Error = ProtocolError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<NodeId> for String {
    fn from(value: NodeId) -> Self {
        value.0
    }
}

macro_rules! bounded_name {
    ($name:ident, $max:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> ProtocolResult<Self> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > $max
                    || !value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
                    })
                {
                    return Err(ProtocolError::InvalidIdentity(concat!(
                        stringify!($name),
                        " must be 1..=",
                        stringify!($max),
                        " non-control ASCII identifier characters"
                    )));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl TryFrom<String> for $name {
            type Error = ProtocolError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

bounded_name!(WorkerId, 128);
bounded_name!(InstallationId, 128);
bounded_name!(HarnessKind, 64);
bounded_name!(ProfileId, 128);

/// A logical, slash-separated target, never an OS filesystem path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct RelativePath(String);

impl RelativePath {
    pub fn parse(value: impl Into<String>) -> ProtocolResult<Self> {
        let value = value.into();
        if value.is_empty() {
            return Err(ProtocolError::SensitiveTargetRequired);
        }
        if value.contains('\0')
            || value.contains('\\')
            || value.starts_with('/')
            || value
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err(ProtocolError::UnsafeRelativePath { path: value });
        }
        let path = Path::new(&value);
        if path.is_absolute()
            || path.components().any(|part| {
                !matches!(part, Component::Normal(_))
                    || part.as_os_str() == "."
                    || part.as_os_str() == ".."
            })
            || value.split('/').any(|part| part.is_empty())
        {
            return Err(ProtocolError::UnsafeRelativePath { path: value });
        }
        // Windows drive prefixes and reserved UNC syntax must not become paths
        // merely because validation happened on a POSIX host.
        if value
            .split('/')
            .next()
            .is_some_and(|first| first.as_bytes().get(1) == Some(&b':'))
        {
            return Err(ProtocolError::UnsafeRelativePath { path: value });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_within(&self, root: &RelativePath) -> bool {
        self == root
            || self
                .0
                .strip_prefix(root.as_str())
                .is_some_and(|tail| tail.starts_with('/'))
    }
}

impl TryFrom<String> for RelativePath {
    type Error = ProtocolError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<RelativePath> for String {
    fn from(value: RelativePath) -> Self {
        value.0
    }
}

/// Lowercase hex SHA-256, represented without `0x` or algorithm aliases.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn parse(value: impl Into<String>) -> ProtocolResult<Self> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ProtocolError::InvalidDigest(
                "SHA-256 must be 64 lowercase hexadecimal characters",
            ));
        }
        Ok(Self(value))
    }

    pub fn from_bytes(bytes: impl AsRef<[u8]>) -> Self {
        Self(format!("{:x}", Sha256::digest(bytes.as_ref())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Sha256Digest").field(&self.0).finish()
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for Sha256Digest {
    type Error = ProtocolError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<Sha256Digest> for String {
    fn from(value: Sha256Digest) -> Self {
        value.0
    }
}

/// Canonical SHA-256 of the stored immutable Grant JSON, not a new trust source.
pub type GrantDigest = Sha256Digest;

pub(crate) fn validate_expiry(
    issued_at: DateTime<Utc>,
    expires_at: Option<DateTime<Utc>>,
) -> ProtocolResult<()> {
    if expires_at.is_some_and(|expiry| expiry <= issued_at) {
        return Err(ProtocolError::InvalidLifecycle(
            "expiry must be later than issuance",
        ));
    }
    Ok(())
}
