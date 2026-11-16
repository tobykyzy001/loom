use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum ProtocolError {
    #[error("unsupported protocol version: {0}")]
    UnsupportedProtocolVersion(String),
    #[error("invalid identity: {0}")]
    InvalidIdentity(&'static str),
    #[error("a sensitive operation requires an explicit target")]
    SensitiveTargetRequired,
    #[error("unsafe relative path: {path}")]
    UnsafeRelativePath { path: String },
    #[error("invalid digest: {0}")]
    InvalidDigest(&'static str),
    #[error("invalid object lifecycle: {0}")]
    InvalidLifecycle(&'static str),
    #[error("grant is unknown or has a different version")]
    GrantVersionMismatch,
    #[error("grant has expired")]
    GrantExpired,
    #[error("grant is revoked")]
    GrantRevoked { revoked_at: DateTime<Utc> },
    #[error("grant does not authorize this node/worker/project operation")]
    OperationNotGranted,
    #[error("target is outside the granted project/path scope")]
    OutsideGrantScope,
    #[error("grant digest is not the digest pinned to the assignment")]
    GrantFenced,
    #[error("node envelope identity does not match the assigned node")]
    NodeIdentityMismatch,
    #[error("assignment identity, ticket, worker or attempt does not match")]
    AssignmentMismatch,
    #[error("lease is revoked")]
    LeaseRevoked,
    #[error("lease is expired")]
    LeaseExpired,
    #[error("stale lease epoch: expected {expected}, got {actual}")]
    StaleLease { expected: u64, actual: u64 },
    #[error("report is routed to the wrong lease")]
    LeaseMismatch,
    #[error("ticket already has a terminal outcome")]
    TicketTerminal { status: crate::domain::TicketStatus },
    #[error("report sequence must increase within a lease")]
    StaleReport,
    #[error("request_id was already used with a different payload")]
    IdempotencyConflict { request_id: Uuid },
    #[error("report has already been superseded by a terminal report")]
    ReportTerminal,
    #[error("report evidence is inconsistent: {0}")]
    InvalidReport(&'static str),
    #[error("artifact reference is invalid: {0}")]
    InvalidArtifact(&'static str),
    #[error("artifact content hash or byte length does not match the reference")]
    ArtifactIntegrity,
    #[error("artifact origin or ticket/assignment lineage does not match")]
    ArtifactLineageMismatch,
    #[error("effect identity or input lineage does not match its report/assignment")]
    EffectLineageMismatch,
    #[error("effect transition is invalid: {0}")]
    InvalidEffectTransition(&'static str),
    #[error("cancellation requested; reject new report/effect work except cancellation")]
    Cancelled,
    #[error("cancellation acknowledgment is only valid after cancellation was requested")]
    CancellationNotRequested,
    #[error("report does not contain a cancel acknowledgement: {0}")]
    CancelGate(&'static str),
    #[error("retry attempt must be exactly one greater than the previous attempt")]
    InvalidRetry,
    #[error("challenge is missing, expired, already used or bound to another identity")]
    InvalidChallenge,
    #[error("node identity is revoked")]
    NodeRevoked,
    #[error("Ed25519 key or signature is invalid")]
    InvalidSignature,
    #[error("node public key does not match node_id")]
    NodeKeyMismatch,
    #[error("poll wait_seconds must be in 0..=20")]
    InvalidPollWindow,
    #[error("JSON object contains a duplicate key")]
    DuplicateJsonKey,
    #[error("protocol encoding error: {0}")]
    Encoding(String),
    #[error("authorized transition cannot rewind or cross object lineage")]
    InvalidTransition(&'static str),
}

pub type ProtocolResult<T> = Result<T, ProtocolError>;
