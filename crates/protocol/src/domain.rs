use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::core::{
    validate_expiry, ArtifactId, AssignmentId, EffectId, GrantDigest, InstallationId, LeaseId,
    NodeId, ProjectId, RelativePath, ReportId, RequestId, Sha256Digest, TicketId, WorkerId,
};
use crate::error::{ProtocolError, ProtocolResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketStatus {
    Pending,
    Running,
    WaitingApproval,
    Reconciling,
    Succeeded,
    Failed,
    Cancelled,
}

impl TicketStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TicketKind {
    ReadSummary,
    EditFile,
    /// A read-only proof of an explicit local model.json descriptor, not model execution.
    ModelDescriptor,
}

impl TicketKind {
    pub const fn required_permission(self) -> Permission {
        match self {
            Self::ReadSummary | Self::ModelDescriptor => Permission::Read,
            Self::EditFile => Permission::Write,
        }
    }

    pub const fn requires_explicit_target(self) -> bool {
        matches!(self, Self::EditFile | Self::ModelDescriptor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Read,
    Write,
}

/// A target is explicit for writes. `None` means no workspace target for read_only.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Read,
    ReadPath(RelativePath),
    EditFile(RelativePath),
}

impl Operation {
    pub fn required_permission(&self) -> Permission {
        match self {
            Self::Read | Self::ReadPath(_) => Permission::Read,
            Self::EditFile(_) => Permission::Write,
        }
    }

    pub fn target(&self) -> Option<&RelativePath> {
        match self {
            Self::Read => None,
            Self::ReadPath(target) | Self::EditFile(target) => Some(target),
        }
    }

    pub fn for_ticket(kind: TicketKind, target: Option<RelativePath>) -> ProtocolResult<Self> {
        match (kind, target) {
            (TicketKind::ReadSummary, path) => Ok(path.map_or(Self::Read, Self::ReadPath)),
            (TicketKind::EditFile, Some(path)) => Ok(Self::EditFile(path)),
            (TicketKind::EditFile, None) => Err(ProtocolError::SensitiveTargetRequired),
            (TicketKind::ModelDescriptor, Some(path)) if path.as_str() == "model.json" => {
                Ok(Self::ReadPath(path))
            }
            (TicketKind::ModelDescriptor, _) => Err(ProtocolError::InvalidLifecycle(
                "model_descriptor requires exactly model.json as its read target",
            )),
        }
    }
}

/// Immutable versioned authorization. Revocation advances `version` and never
/// revives operations or changes the immutable digest of a leased Grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub id: UuidCompat,
    pub version: u64,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
    pub project_id: ProjectId,
    pub operations: BTreeSet<Operation>,
    pub issued_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded: Option<GrantDigest>,
}

/// Storage-friendly UUID scalar for Grant IDs, distinct from request idempotency.
pub type UuidCompat = uuid::Uuid;

impl Grant {
    pub fn validate(&self) -> ProtocolResult<()> {
        if self.version == 0 || self.operations.is_empty() {
            return Err(ProtocolError::InvalidLifecycle(
                "grant version must be positive and operations explicit",
            ));
        }
        validate_expiry(self.issued_at, self.expires_at)?;
        if self.revoked_at.is_some_and(|at| at < self.issued_at) {
            return Err(ProtocolError::InvalidLifecycle(
                "revocation cannot precede issuance",
            ));
        }
        Ok(())
    }

    /// Canonical encoding for v1. Digest changes require a new immutable lease pin.
    pub fn digest(&self) -> ProtocolResult<GrantDigest> {
        self.validate()?;
        Ok(Sha256Digest::from_bytes(crate::node::to_canonical_json(
            self,
        )?))
    }

    pub fn revoked(self, revoked_at: DateTime<Utc>, digest: &GrantDigest) -> Self {
        Self {
            version: self.version.saturating_add(1),
            revoked_at: Some(revoked_at),
            superseded: Some(digest.clone()),
            ..self
        }
    }

    pub fn permits(&self, operation: &Operation) -> bool {
        self.operations.iter().any(|granted| {
            if granted.required_permission() != operation.required_permission() {
                return false;
            }
            match (granted.target(), operation.target()) {
                (None, None) => true,
                (Some(root), Some(target)) => target.is_within(root),
                // A path-specific permission is not blanket project access.
                (None, Some(_)) | (Some(_), None) => false,
            }
        })
    }

    pub fn authorize(
        &self,
        node_id: &NodeId,
        installation_id: &InstallationId,
        worker_id: &WorkerId,
        project_id: &ProjectId,
        operation: &Operation,
        now: DateTime<Utc>,
    ) -> ProtocolResult<()> {
        self.validate()?;
        if let Some(revoked_at) = self.revoked_at {
            return Err(ProtocolError::GrantRevoked { revoked_at });
        }
        if self.expires_at.is_some_and(|expiry| expiry <= now) {
            return Err(ProtocolError::GrantExpired);
        }
        if self.node_id != *node_id
            || self.installation_id != *installation_id
            || self.worker_id != *worker_id
            || self.project_id != *project_id
        {
            return Err(ProtocolError::OperationNotGranted);
        }
        if !self.permits(operation) {
            return Err(ProtocolError::OutsideGrantScope);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lease {
    pub id: LeaseId,
    pub assignment_id: AssignmentId,
    pub ticket_id: TicketId,
    pub node_id: NodeId,
    pub epoch: u64,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Lease {
    pub fn validate(&self) -> ProtocolResult<()> {
        if self.epoch == 0 {
            return Err(ProtocolError::InvalidLifecycle("lease epoch starts at 1"));
        }
        if self.expires_at <= self.issued_at {
            return Err(ProtocolError::InvalidLifecycle(
                "lease expiry must be later than issuance",
            ));
        }
        if self.revoked_at.is_some_and(|at| at < self.issued_at) {
            return Err(ProtocolError::InvalidLifecycle("invalid lease revocation"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assignment {
    pub id: AssignmentId,
    pub ticket_id: TicketId,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
    pub attempt: u64,
    pub lease_id: LeaseId,
    pub lease_epoch: u64,
    pub lease_expires_at: DateTime<Utc>,
    pub grant_digest: GrantDigest,
    pub operation: Option<Operation>,
    pub session: Option<SessionRef>,
}

impl Assignment {
    pub fn new(ticket: &Ticket, grant: &Grant, lease: Lease, attempt: u64) -> ProtocolResult<Self> {
        if ticket.status != TicketStatus::Pending || ticket.attempt != 0 || attempt != 1 {
            return Err(ProtocolError::InvalidTransition(
                "new assignment requires a pending, never-assigned ticket",
            ));
        }
        ticket.authorize(grant)?;
        grant.authorize(
            &ticket.node_id,
            &ticket.installation_id,
            &ticket.worker_id,
            &ticket.project_id,
            &ticket.operation,
            lease.issued_at,
        )?;
        Self::for_attempt(ticket, grant, lease, attempt, None)
    }

    pub fn for_attempt(
        ticket: &Ticket,
        grant: &Grant,
        lease: Lease,
        attempt: u64,
        session: Option<SessionRef>,
    ) -> ProtocolResult<Self> {
        lease.validate()?;
        if lease.ticket_id != ticket.id
            || lease.node_id != ticket.node_id
            || attempt == 0
            || (ticket.status == TicketStatus::Pending
                && matches!(ticket.kind, TicketKind::EditFile)
                && ticket.operation.target().is_none())
        {
            return Err(ProtocolError::AssignmentMismatch);
        }
        Ok(Self {
            id: AssignmentId::new(),
            ticket_id: ticket.id,
            node_id: ticket.node_id.clone(),
            installation_id: ticket.installation_id.clone(),
            worker_id: ticket.worker_id.clone(),
            attempt,
            lease_id: lease.id,
            lease_epoch: lease.epoch,
            lease_expires_at: lease.expires_at,
            grant_digest: grant.digest()?,
            operation: Some(ticket.operation.clone()),
            session,
        })
    }

    pub fn validate_for_ticket(&self, ticket: &Ticket) -> ProtocolResult<()> {
        if self.ticket_id != ticket.id
            || self.node_id != ticket.node_id
            || self.installation_id != ticket.installation_id
            || self.worker_id != ticket.worker_id
            || self.attempt != ticket.attempt
            || self.operation.as_ref() != Some(&ticket.operation)
            || self.grant_digest != ticket.grant_digest
        {
            return Err(ProtocolError::AssignmentMismatch);
        }
        Ok(())
    }

    /// Only immutable lease and digest checks are performed without a Ticket.
    /// Project authorization **must** call `authorize_for_ticket` instead.
    pub fn authorize(&self, grant: &Grant, lease: &Lease) -> ProtocolResult<()> {
        authorize_assignment(self, grant, lease)
    }

    pub fn authorize_for_ticket(
        &self,
        ticket: &Ticket,
        grant: &Grant,
        lease: &Lease,
        now: DateTime<Utc>,
    ) -> ProtocolResult<()> {
        self.validate_for_ticket(ticket)?;
        self.authorize(grant, lease)?;
        if lease.revoked_at.is_some() {
            return Err(ProtocolError::LeaseRevoked);
        }
        if lease.expires_at <= now {
            return Err(ProtocolError::LeaseExpired);
        }
        grant.authorize(
            &self.node_id,
            &self.installation_id,
            &self.worker_id,
            &ticket.project_id,
            &ticket.operation,
            now,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    pub id: TicketId,
    pub project_id: ProjectId,
    pub objective: String,
    pub kind: TicketKind,
    pub operation: Operation,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
    pub status: TicketStatus,
    pub attempt: u64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub cancel_requested: bool,
    pub cancel_requested_at: Option<DateTime<Utc>>,
    pub cancel_acknowledged_at: Option<DateTime<Utc>>,
    pub grant_digest: GrantDigest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketSpec {
    pub project_id: ProjectId,
    pub objective: String,
    pub kind: TicketKind,
    pub relative_path: Option<RelativePath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
}

impl Ticket {
    pub fn create(
        spec: TicketSpec,
        placement: Placement,
        grant: &Grant,
        now: DateTime<Utc>,
    ) -> ProtocolResult<Self> {
        Self::new(
            spec.project_id,
            spec.objective,
            spec.kind,
            spec.relative_path,
            placement.node_id,
            placement.installation_id,
            placement.worker_id,
            grant,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        project_id: ProjectId,
        objective: impl Into<String>,
        kind: TicketKind,
        relative_path: Option<RelativePath>,
        node_id: NodeId,
        installation_id: InstallationId,
        worker_id: WorkerId,
        grant: &Grant,
        now: DateTime<Utc>,
    ) -> ProtocolResult<Self> {
        let objective = objective.into();
        if objective.trim().is_empty() {
            return Err(ProtocolError::InvalidLifecycle(
                "ticket objective cannot be empty",
            ));
        }
        let operation = Operation::for_ticket(kind, relative_path)?;
        grant.authorize(
            &node_id,
            &installation_id,
            &worker_id,
            &project_id,
            &operation,
            now,
        )?;
        let grant_digest = grant.digest()?;
        let mut ticket = Self {
            id: TicketId::new(),
            project_id,
            objective,
            kind,
            operation,
            node_id,
            installation_id,
            worker_id,
            status: TicketStatus::Pending,
            attempt: 0,
            created_at: now,
            updated_at: now,
            cancel_requested: false,
            cancel_requested_at: None,
            cancel_acknowledged_at: None,
            grant_digest,
        };
        ticket.authorize(grant)?;
        // Move attempt to zero only until Assignment::new performs its strict check.
        ticket.attempt = 0;
        Ok(ticket)
    }

    pub fn authorize(&self, grant: &Grant) -> ProtocolResult<()> {
        if self.grant_digest != grant.digest()? {
            return Err(ProtocolError::GrantFenced);
        }
        grant.authorize(
            &self.node_id,
            &self.installation_id,
            &self.worker_id,
            &self.project_id,
            &self.operation,
            self.created_at,
        )
    }

    pub fn attached_assignment(&mut self, assignment: &Assignment) -> ProtocolResult<()> {
        if self.status != TicketStatus::Pending || self.attempt != 0 {
            return Err(ProtocolError::InvalidTransition("ticket already assigned"));
        }
        if assignment.ticket_id != self.id || assignment.attempt != 1 {
            return Err(ProtocolError::AssignmentMismatch);
        }
        self.attempt = 1;
        self.status = TicketStatus::Running;
        self.updated_at = assignment.lease_expires_at;
        Ok(())
    }

    /// DB implementation must update the ticket and revoked lease atomically.
    pub fn request_cancel(&mut self, now: DateTime<Utc>) -> ProtocolResult<()> {
        if self.status.is_terminal() {
            return Err(ProtocolError::TicketTerminal {
                status: self.status,
            });
        }
        if !self.cancel_requested {
            self.cancel_requested = true;
            self.cancel_requested_at = Some(now);
            self.updated_at = now;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRef {
    pub harness_kind: crate::core::HarnessKind,
    pub profile_id: crate::core::ProfileId,
    pub session_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Running,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}

impl ReportStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Running | Self::Unknown)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub schema: String,
    pub artifact_id: ArtifactId,
    pub ticket_id: TicketId,
    pub assignment_id: AssignmentId,
    pub origin_node_id: NodeId,
    /// Controlled location; protocol consumers must not treat file paths as URIs.
    pub location: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: Sha256Digest,
    pub parents: Vec<ArtifactId>,
    pub evidence: Vec<EvidenceRef>,
}

impl ArtifactRef {
    pub const SCHEMA_V1: &'static str = "loom.artifact.v1";

    pub fn validate(&self) -> ProtocolResult<()> {
        if self.schema != Self::SCHEMA_V1 {
            return Err(ProtocolError::InvalidArtifact("unsupported schema"));
        }
        let location = self.location.parse::<url_lite::ControlledUri>()?;
        if location.is_filesystem_path() {
            return Err(ProtocolError::InvalidArtifact(
                "local path is not a global artifact URI",
            ));
        }
        if self.media_type.trim().is_empty() || self.size_bytes == 0 {
            return Err(ProtocolError::InvalidArtifact(
                "media_type and nonzero size_bytes are required",
            ));
        }
        if self.parents.contains(&self.artifact_id) {
            return Err(ProtocolError::InvalidArtifact(
                "artifact cannot parent itself",
            ));
        }
        Ok(())
    }

    pub fn verify_payload(&self, bytes: &[u8]) -> ProtocolResult<()> {
        if bytes.len() as u64 != self.size_bytes || Sha256Digest::from_bytes(bytes) != self.sha256 {
            return Err(ProtocolError::ArtifactIntegrity);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub kind: String,
    pub digest: Sha256Digest,
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectStatus {
    Recorded,
    Unknown,
    Confirmed,
    NeedsPerson,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Effect {
    pub effect_id: EffectId,
    pub ticket_id: TicketId,
    pub assignment_id: AssignmentId,
    pub node_id: NodeId,
    pub attempt: u64,
    pub input_digest: Sha256Digest,
    pub status: EffectStatus,
    pub evidence: Vec<EvidenceRef>,
    pub artifacts: Vec<ArtifactId>,
}

impl Effect {
    pub fn transition(&mut self, next: EffectStatus) -> ProtocolResult<()> {
        if self.status == next {
            return Ok(());
        }
        let allowed = matches!(
            (self.status, next),
            (EffectStatus::Recorded, EffectStatus::Unknown)
                | (EffectStatus::Recorded, EffectStatus::Confirmed)
                | (EffectStatus::Unknown, EffectStatus::Confirmed)
                | (EffectStatus::Unknown, EffectStatus::NeedsPerson)
        );
        if !allowed {
            return Err(ProtocolError::InvalidEffectTransition(
                "confirmed/needs_person are immutable; recorded cannot become human review",
            ));
        }
        if matches!(next, EffectStatus::Confirmed | EffectStatus::NeedsPerson)
            && self.evidence.is_empty()
        {
            return Err(ProtocolError::InvalidEffectTransition(
                "terminal effect outcomes require evidence",
            ));
        }
        self.status = next;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Report {
    pub request_id: RequestId,
    pub report_id: ReportId,
    pub ticket_id: TicketId,
    pub assignment_id: AssignmentId,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
    pub attempt: u64,
    pub lease_id: LeaseId,
    pub lease_epoch: u64,
    pub sequence: u64,
    pub grant_digest: GrantDigest,
    pub status: ReportStatus,
    pub summary: String,
    pub session: Option<SessionRef>,
    pub artifacts: Vec<ArtifactRef>,
    pub effects: Vec<Effect>,
    pub cancel_acknowledged: bool,
    pub created_at: DateTime<Utc>,
}

impl Report {
    pub fn validate(&self) -> ProtocolResult<()> {
        if self.sequence == 0 || self.summary.trim().is_empty() {
            return Err(ProtocolError::InvalidReport(
                "sequence must be positive and summary nonempty",
            ));
        }
        if matches!(self.status, ReportStatus::Failed | ReportStatus::Unknown)
            && self.effects.is_empty()
            && self.artifacts.is_empty()
            && self.session.is_none()
        {
            return Err(ProtocolError::InvalidReport(
                "unknown/failed report must include structured evidence/session",
            ));
        }
        if self.status == ReportStatus::Cancelled && !self.cancel_acknowledged {
            return Err(ProtocolError::CancelGate(
                "cancelled status requires cancellation acknowledgment",
            ));
        }
        for artifact in &self.artifacts {
            artifact.validate()?;
            if artifact.ticket_id != self.ticket_id
                || artifact.assignment_id != self.assignment_id
                || artifact.origin_node_id != self.node_id
            {
                return Err(ProtocolError::ArtifactLineageMismatch);
            }
        }
        for effect in &self.effects {
            if effect.ticket_id != self.ticket_id
                || effect.assignment_id != self.assignment_id
                || effect.node_id != self.node_id
                || effect.attempt != self.attempt
            {
                return Err(ProtocolError::EffectLineageMismatch);
            }
            if effect
                .artifacts
                .iter()
                .any(|id| !self.artifacts.iter().any(|a| a.artifact_id == *id))
            {
                return Err(ProtocolError::EffectLineageMismatch);
            }
        }
        Ok(())
    }

    pub fn ticket_status(&self) -> TicketStatus {
        match self.status {
            ReportStatus::Running => TicketStatus::Running,
            ReportStatus::Succeeded => TicketStatus::Succeeded,
            ReportStatus::Failed => TicketStatus::Failed,
            ReportStatus::Cancelled => TicketStatus::Cancelled,
            ReportStatus::Unknown => TicketStatus::Reconciling,
        }
    }
}

pub fn authorize_assignment(
    assignment: &Assignment,
    grant: &Grant,
    lease: &Lease,
) -> ProtocolResult<()> {
    lease.validate()?;
    if lease.id != assignment.lease_id
        || lease.assignment_id != assignment.id
        || lease.ticket_id != assignment.ticket_id
        || lease.node_id != assignment.node_id
        || lease.epoch != assignment.lease_epoch
        || lease.expires_at != assignment.lease_expires_at
    {
        return Err(ProtocolError::AssignmentMismatch);
    }
    if grant.digest()? != assignment.grant_digest {
        return Err(ProtocolError::GrantFenced);
    }
    // No expiry/revocation/scope decision is made here: callers handling actual
    // work use `authorize_for_ticket`/`authorize_report`, with real project data.
    Ok(())
}

mod url_lite {
    use crate::error::{ProtocolError, ProtocolResult};

    pub struct ControlledUri(String);

    impl ControlledUri {
        pub fn is_filesystem_path(&self) -> bool {
            let lower = self.0.to_ascii_lowercase();
            self.0.starts_with('/')
                || lower.starts_with("file:")
                || lower.starts_with("\\\\")
                || self.0.as_bytes().get(1) == Some(&b':')
        }
    }

    impl std::str::FromStr for ControlledUri {
        type Err = ProtocolError;

        fn from_str(value: &str) -> ProtocolResult<Self> {
            let Some((scheme, rest)) = value.split_once(':') else {
                return Err(ProtocolError::InvalidArtifact(
                    "location must be a controlled absolute URI",
                ));
            };
            if scheme.is_empty()
                || !scheme.bytes().enumerate().all(|(i, byte)| {
                    byte.is_ascii_alphabetic()
                        || (i > 0 && matches!(byte, b'+' | b'-' | b'.')
                            || (i > 0 && byte.is_ascii_digit()))
                })
                || rest.is_empty()
                || value.chars().any(char::is_whitespace)
                || value.contains('#')
            {
                return Err(ProtocolError::InvalidArtifact("invalid controlled URI"));
            }
            if matches!(scheme.to_ascii_lowercase().as_str(), "http" | "https")
                && !rest.starts_with("//")
            {
                return Err(ProtocolError::InvalidArtifact("HTTP URI requires //host"));
            }
            Ok(Self(value.to_owned()))
        }
    }
}
