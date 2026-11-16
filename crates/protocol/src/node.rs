use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::de::{DeserializeOwned, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use crate::core::{
    validate_expiry, ArtifactId, AssignmentId, GrantDigest, HarnessKind, InstallationId, NodeId,
    ProfileId, ProjectId, ProtocolVersion, RequestId, TicketId, WorkerId,
};
use crate::domain::{ArtifactRef, Effect, Permission, Report, ReportStatus, TicketKind};
use crate::error::{ProtocolError, ProtocolResult};
use crate::identity::{ChallengeNonce, NodePublicKey};

/// `request_id` is mandatory for every envelope, including registration,
/// heartbeats and polls. Bearer authentication is deliberately out of JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeEnvelope<T> {
    pub protocol: ProtocolVersion,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub request_id: RequestId,
    #[serde(default)]
    pub sent_at: Option<DateTime<Utc>>,
    #[serde(flatten)]
    pub payload: T,
}

impl<T> NodeEnvelope<T> {
    pub fn validate(&self) -> ProtocolResult<()> {
        self.protocol.reject_unknown()
    }

    pub fn header(&self) -> NodeEnvelopeHeader {
        NodeEnvelopeHeader {
            protocol: self.protocol.clone(),
            node_id: self.node_id.clone(),
            installation_id: self.installation_id.clone(),
            request_id: self.request_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeEnvelopeHeader {
    pub protocol: ProtocolVersion,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub request_id: RequestId,
}

pub type HeartbeatRequest = NodeEnvelope<Heartbeat>;
pub type AssignmentPollRequest = NodeEnvelope<AssignmentPoll>;
pub type ReportRequest = NodeEnvelope<ReportPayload>;
pub type ArtifactUploadRequest = NodeEnvelope<ArtifactUpload>;
pub type NodeEventRequest = NodeEnvelope<NodeEvent>;
pub type AcknowledgeRequest = NodeEnvelope<AssignmentAcknowledge>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Online,
    Busy,
    Degraded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub ticket_kind: TicketKind,
    pub permission: Permission,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkerSnapshot {
    pub worker_id: WorkerId,
    pub harness_kind: HarnessKind,
    pub profile_id: ProfileId,
    pub status: NodeStatus,
    pub capabilities: Vec<Capability>,
    pub observed_at: DateTime<Utc>,
    #[serde(default)]
    pub supported_effects: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Heartbeat {
    pub status: NodeStatus,
    pub workers: Vec<WorkerSnapshot>,
}

impl Heartbeat {
    pub fn validate(&self) -> ProtocolResult<()> {
        if self.workers.is_empty() && matches!(self.status, NodeStatus::Online | NodeStatus::Busy) {
            return Err(ProtocolError::InvalidLifecycle(
                "online/busy heartbeat must contain at least one worker",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssignmentPoll {
    pub last_assignment_id: Option<AssignmentId>,
    pub wait_seconds: u64,
}

impl AssignmentPoll {
    pub fn validate(&self) -> ProtocolResult<()> {
        if self.wait_seconds > 20 {
            return Err(ProtocolError::InvalidPollWindow);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChallengeRequest {
    pub protocol: ProtocolVersion,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub public_key: String,
}

impl ChallengeRequest {
    pub fn validate(&self) -> ProtocolResult<()> {
        self.protocol.reject_unknown()?;
        let key = NodePublicKey::from_base64url(&self.public_key)?;
        if key.node_id()? != self.node_id {
            return Err(ProtocolError::NodeKeyMismatch);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChallengeResponse {
    pub challenge_id: crate::core::ChallengeId,
    pub nonce: ChallengeNonce,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterNodeRequest {
    pub protocol: ProtocolVersion,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub public_key: String,
    pub enrollment_code: String,
    pub nonce: ChallengeNonce,
    pub signed_challenge: String,
    pub request_id: RequestId,
    pub capabilities: Vec<Capability>,
    pub worker_id: WorkerId,
    pub harness_kind: HarnessKind,
    pub profile_id: ProfileId,
}

impl RegisterNodeRequest {
    pub fn validate(&self) -> ProtocolResult<()> {
        self.protocol.reject_unknown()?;
        let key = NodePublicKey::from_base64url(&self.public_key)?;
        if key.node_id()? != self.node_id {
            return Err(ProtocolError::NodeKeyMismatch);
        }
        if self.capabilities.is_empty() || self.enrollment_code.is_empty() {
            return Err(ProtocolError::OperationNotGranted);
        }
        // Encoding and nonce validation are performed here; freshness and consuming
        // the matching challenge must be a single server-side DB transaction.
        key.verify_challenge(&self.nonce, &self.signed_challenge)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegisterNodeResponse {
    pub node_id: NodeId,
    pub token: String,
    pub grant_digest: Option<GrantDigest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssignmentPayload {
    pub assignment: crate::domain::Assignment,
    pub ticket_id: TicketId,
    pub project_id: ProjectId,
    pub objective: String,
    pub kind: TicketKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportPayload {
    pub report_id: crate::core::ReportId,
    pub ticket_id: TicketId,
    pub assignment_id: AssignmentId,
    pub worker_id: WorkerId,
    pub attempt: u64,
    pub lease_id: crate::core::LeaseId,
    pub lease_epoch: u64,
    pub sequence: u64,
    pub grant_digest: GrantDigest,
    #[serde(alias = "requested_state")]
    pub status: ReportStatus,
    pub summary: String,
    pub session: Option<crate::domain::SessionRef>,
    #[serde(default)]
    pub artifacts: Vec<ArtifactRef>,
    #[serde(default)]
    pub effects: Vec<Effect>,
    pub cancel_acknowledged: bool,
    pub created_at: DateTime<Utc>,
}

impl<T> NodeEnvelope<T> {
    pub fn sent_at(&self) -> Option<DateTime<Utc>> {
        self.sent_at
    }
}

impl NodeEnvelope<ReportPayload> {
    pub fn into_report(self) -> ProtocolResult<Report> {
        self.validate()?;
        let report = Report {
            request_id: self.request_id,
            report_id: self.payload.report_id,
            ticket_id: self.payload.ticket_id,
            assignment_id: self.payload.assignment_id,
            node_id: self.node_id,
            installation_id: self.installation_id,
            worker_id: self.payload.worker_id,
            attempt: self.payload.attempt,
            lease_id: self.payload.lease_id,
            lease_epoch: self.payload.lease_epoch,
            sequence: self.payload.sequence,
            grant_digest: self.payload.grant_digest,
            status: self.payload.status,
            summary: self.payload.summary,
            session: self.payload.session,
            artifacts: self.payload.artifacts,
            effects: self.payload.effects,
            cancel_acknowledged: self.payload.cancel_acknowledged,
            created_at: self.payload.created_at,
        };
        report.validate()?;
        Ok(report)
    }

    pub fn from_report(report: Report, sent_at: DateTime<Utc>) -> ProtocolResult<Self> {
        report.validate()?;
        let envelope = Self {
            protocol: ProtocolVersion::v1(),
            node_id: report.node_id.clone(),
            installation_id: report.installation_id.clone(),
            request_id: report.request_id,
            sent_at: Some(sent_at),
            payload: ReportPayload {
                report_id: report.report_id,
                ticket_id: report.ticket_id,
                assignment_id: report.assignment_id,
                worker_id: report.worker_id,
                attempt: report.attempt,
                lease_id: report.lease_id,
                lease_epoch: report.lease_epoch,
                sequence: report.sequence,
                grant_digest: report.grant_digest,
                status: report.status,
                summary: report.summary,
                session: report.session,
                artifacts: report.artifacts,
                effects: report.effects,
                cancel_acknowledged: report.cancel_acknowledged,
                created_at: report.created_at,
            },
        };
        Ok(envelope)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportDisposition {
    Accepted,
    Reconciling,
    Duplicate,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportResponse {
    pub request_id: RequestId,
    pub disposition: ReportDisposition,
    pub ticket_status: crate::domain::TicketStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArtifactUpload {
    pub ticket_id: TicketId,
    pub artifact_id: ArtifactId,
    pub assignment_id: AssignmentId,
    pub lease_id: crate::core::LeaseId,
    pub lease_epoch: u64,
    pub grant_digest: GrantDigest,
    pub metadata: ArtifactRef,
    /// Bounded M0 transport payload. HTTP adapter must enforce its own size limit.
    pub bytes_base64: String,
}

impl ArtifactUpload {
    pub fn validate(&self) -> ProtocolResult<()> {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        self.metadata.validate()?;
        if self.metadata.artifact_id != self.artifact_id
            || self.metadata.ticket_id != self.ticket_id
            || self.metadata.assignment_id != self.assignment_id
        {
            return Err(ProtocolError::ArtifactLineageMismatch);
        }
        let bytes = STANDARD
            .decode(&self.bytes_base64)
            .map_err(|_| ProtocolError::InvalidArtifact("invalid standard base64"))?;
        if STANDARD.encode(&bytes) != self.bytes_base64 {
            return Err(ProtocolError::InvalidArtifact("noncanonical base64"));
        }
        self.metadata.verify_payload(&bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NodeEvent {
    pub ticket_id: TicketId,
    pub assignment_id: AssignmentId,
    pub lease_id: crate::core::LeaseId,
    pub lease_epoch: u64,
    pub session: Option<crate::domain::SessionRef>,
    pub activity: String,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Acknowledgement {
    Accepted,
    Rejected,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AssignmentAcknowledge {
    pub ticket_id: TicketId,
    pub assignment_id: AssignmentId,
    pub lease_id: crate::core::LeaseId,
    pub lease_epoch: u64,
    pub worker_id: WorkerId,
    pub acknowledgement: Acknowledgement,
    pub reason: String,
}

pub fn validate_challenge_expiry(
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
) -> ProtocolResult<()> {
    validate_expiry(created_at, Some(expires_at))
}

/// Deterministic JSON used for digesting protocol objects. Object map ordering is
/// canonical; callers must not digest pretty-printed HTTP bytes interchangeably.
pub fn to_canonical_json<T: Serialize>(value: &T) -> ProtocolResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(|error| ProtocolError::Encoding(error.to_string()))
}

/// Parse JSON while rejecting duplicate object member names (last-write-wins
/// would make signature/digest security ambiguous).
pub fn from_json_strict<T: DeserializeOwned>(json: &[u8]) -> ProtocolResult<T> {
    validate_json_unique_members(json)?;
    serde_json::from_slice(json).map_err(|error| ProtocolError::Encoding(error.to_string()))
}

fn validate_json_unique_members(json: &[u8]) -> ProtocolResult<()> {
    use serde::de::Error as DeError;
    use std::collections::BTreeSet;
    use std::fmt;

    struct StrictVisitor;
    impl<'de> Visitor<'de> for StrictVisitor {
        type Value = ();

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("JSON without duplicate member names")
        }

        fn visit_bool<E>(self, _: bool) -> Result<(), E> {
            Ok(())
        }
        fn visit_i64<E>(self, _: i64) -> Result<(), E> {
            Ok(())
        }
        fn visit_u64<E>(self, _: u64) -> Result<(), E> {
            Ok(())
        }
        fn visit_f64<E>(self, _: f64) -> Result<(), E> {
            Ok(())
        }
        fn visit_str<E>(self, _: &str) -> Result<(), E> {
            Ok(())
        }
        fn visit_string<E>(self, _: String) -> Result<(), E> {
            Ok(())
        }
        fn visit_none<E>(self) -> Result<(), E> {
            Ok(())
        }
        fn visit_unit<E>(self) -> Result<(), E> {
            Ok(())
        }
        fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
            d.deserialize_any(self)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
            while seq.next_element::<Strict>()?.is_some() {}
            Ok(())
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
            let mut keys = BTreeSet::new();
            while let Some(key) = map.next_key::<String>()? {
                if !keys.insert(key) {
                    return Err(A::Error::custom("duplicate JSON member"));
                }
                map.next_value::<Strict>()?;
            }
            Ok(())
        }
    }

    struct Strict;
    impl<'de> Deserialize<'de> for Strict {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct SeqVisitor;
            impl<'de> Visitor<'de> for SeqVisitor {
                type Value = Strict;
                fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str("JSON")
                }
                fn visit_bool<E>(self, _: bool) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_i64<E>(self, _: i64) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_u64<E>(self, _: u64) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_f64<E>(self, _: f64) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_str<E>(self, _: &str) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_string<E>(self, _: String) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_unit<E>(self) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_none<E>(self) -> Result<Strict, E> {
                    Ok(Strict)
                }
                fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Strict, D::Error> {
                    Strict::deserialize(d)
                }
                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Strict, A::Error> {
                    while seq.next_element::<Strict>()?.is_some() {}
                    Ok(Strict)
                }
                fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Strict, A::Error> {
                    StrictVisitor.visit_map(map)?;
                    Ok(Strict)
                }
            }
            deserializer.deserialize_any(SeqVisitor).map(|_| Strict)
        }
    }
    let _: Option<StrictVisitor> = None;
    let _: Option<Strict> = None;
    let _: Option<BTreeSet<String>> = None;
    let mut deserializer = serde_json::Deserializer::from_slice(json);
    Strict::deserialize(&mut deserializer).map_err(|error| {
        if error.to_string().contains("duplicate JSON member") {
            ProtocolError::DuplicateJsonKey
        } else {
            ProtocolError::Encoding(error.to_string())
        }
    })?;
    deserializer
        .end()
        .map_err(|error| ProtocolError::Encoding(error.to_string()))
}
