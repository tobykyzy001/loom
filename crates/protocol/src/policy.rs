use chrono::{DateTime, Utc};

use crate::core::{NodeId, TicketId};
use crate::domain::{Assignment, Grant, Lease, Report, ReportStatus, Ticket, TicketStatus};
use crate::error::{ProtocolError, ProtocolResult};
use crate::node::{NodeEnvelopeHeader, ReportDisposition};
use crate::state::ReportOutcome;

trait ReportIdentity {
    fn envelope_header(&self) -> NodeEnvelopeHeader;
}

impl ReportIdentity for Report {
    fn envelope_header(&self) -> NodeEnvelopeHeader {
        NodeEnvelopeHeader {
            protocol: crate::core::ProtocolVersion::v1(),
            node_id: self.node_id.clone(),
            installation_id: self.installation_id.clone(),
            request_id: self.request_id,
        }
    }
}

/// Center-side storage preconditions. Implement these queries in one SQLite
/// transaction via the application service. Return target-scoped records only.
pub trait AuthorizationStore {
    fn authenticated_node_matches(&self) -> bool;
    fn grant(&self) -> &Grant;
    fn lease(&self) -> &Lease;
    fn assignment(&self) -> &Assignment;
    fn ticket(&self) -> &Ticket;
}

/// Execution/assignment report gate. It never grants a project resource by
/// itself; Host file canonicalization and sandboxing must use the same Grant.
pub fn authorize_report<S: AuthorizationStore>(
    store: &S,
    authenticated_node: &NodeId,
    report: &Report,
    now: DateTime<Utc>,
) -> ProtocolResult<()> {
    let ticket = store.ticket();
    let assignment = store.assignment();
    let lease = store.lease();
    let grant = store.grant();
    let identity = report.envelope_header();

    // Token node and authenticated installation must be checked by the server,
    // before this gate. The payload can never select another authority.
    if !store.authenticated_node_matches() || authenticated_node != &identity.node_id {
        return Err(ProtocolError::NodeIdentityMismatch);
    }
    if assignment.node_id != report.node_id || assignment.installation_id != report.installation_id
    {
        return Err(ProtocolError::NodeIdentityMismatch);
    }
    assignment.validate_for_ticket(ticket)?;
    validate_report_links(report, ticket, assignment)?;
    if report.lease_epoch < assignment.lease_epoch {
        return Err(ProtocolError::StaleLease {
            expected: assignment.lease_epoch,
            actual: report.lease_epoch,
        });
    }
    if report.lease_epoch > assignment.lease_epoch {
        return Err(ProtocolError::StaleLease {
            expected: assignment.lease_epoch,
            actual: report.lease_epoch,
        });
    }
    if let Some(revoked_at) = grant.revoked_at {
        // Revocation always fences an older immutable digest, even though the
        // new Grant version naturally cannot digest-equal the assignment pin.
        if report.grant_digest == assignment.grant_digest {
            return Err(ProtocolError::GrantRevoked { revoked_at });
        }
    }
    if report.grant_digest != assignment.grant_digest || grant.digest()? != assignment.grant_digest
    {
        return Err(ProtocolError::GrantFenced);
    }
    validate_report_cancel_gate(ticket, report)?;

    if matches!(report.status, ReportStatus::Cancelled) {
        // Cancellation is a durable control-plane decision. Its acknowledgement
        // may arrive after expiry/revocation, but only for the exact old attempt.
        validate_cancel_lease(assignment, lease)?;
        return Ok(());
    }
    if ticket.cancel_requested && report.cancel_acknowledged {
        // Unknown/failed observations of the interrupted attempt are intentionally
        // retained; they never become new execution authorization.
        validate_cancel_lease(assignment, lease)?;
        return Ok(());
    }
    if lease.revoked_at.is_some() {
        return Err(ProtocolError::LeaseRevoked);
    }
    if lease.expires_at <= now {
        return Err(ProtocolError::LeaseExpired);
    }
    grant.authorize(
        &assignment.node_id,
        &assignment.installation_id,
        &assignment.worker_id,
        &ticket.project_id,
        &ticket.operation,
        now,
    )?;
    Ok(())
}

fn validate_cancel_lease(assignment: &Assignment, lease: &Lease) -> ProtocolResult<()> {
    if lease.id != assignment.lease_id
        || lease.assignment_id != assignment.id
        || lease.ticket_id != assignment.ticket_id
        || lease.node_id != assignment.node_id
        || lease.epoch != assignment.lease_epoch
    {
        return Err(ProtocolError::AssignmentMismatch);
    }
    Ok(())
}

pub fn validate_report_links(
    report: &Report,
    ticket: &Ticket,
    assignment: &Assignment,
) -> ProtocolResult<()> {
    if report.ticket_id != ticket.id
        || report.assignment_id != assignment.id
        || report.worker_id != assignment.worker_id
        || report.attempt != assignment.attempt
        || report.lease_id != assignment.lease_id
    {
        return Err(ProtocolError::LeaseMismatch);
    }
    if ticket.id != assignment.ticket_id {
        return Err(ProtocolError::AssignmentMismatch);
    }
    Ok(())
}

pub fn validate_report_cancel_gate(ticket: &Ticket, report: &Report) -> ProtocolResult<()> {
    if ticket.cancel_requested {
        if report.status == ReportStatus::Cancelled && !report.cancel_acknowledged {
            return Err(ProtocolError::CancelGate("cancel acknowledgement missing"));
        }
        if report.status == ReportStatus::Running
            || report.status == ReportStatus::Succeeded
            || (report.status == ReportStatus::Failed && !report.cancel_acknowledged)
            || (report.status == ReportStatus::Unknown && !report.cancel_acknowledged)
        {
            return Err(ProtocolError::Cancelled);
        }
    } else if report.cancel_acknowledged || report.status == ReportStatus::Cancelled {
        return Err(ProtocolError::CancellationNotRequested);
    }
    if ticket.cancel_requested && report.status.is_terminal() {
        let cancelled = report.status == ReportStatus::Cancelled
            || report.status == ReportStatus::Unknown
            || report.status == ReportStatus::Failed;
        if !cancelled {
            return Err(ProtocolError::Cancelled);
        }
    }
    Ok(())
}

/// Pure in-memory M0 reducer useful for unit tests and transaction adapters.
/// It is **not** the task authority itself; persistent single-writer transactions
/// and unique `(node_id, request_id)` / unique effect rows remain required.
#[derive(Debug, Clone)]
pub struct DomainState {
    pub ticket: Ticket,
    pub assignment: Assignment,
    pub grant: Grant,
    pub lease: Lease,
    pub last_sequence: u64,
    pub last_request_id: Option<crate::core::RequestId>,
    pub last_report: Option<Box<Report>>,
    pub last_outcome: Option<ReportOutcome>,
}

impl DomainState {
    pub fn new(
        ticket: Ticket,
        assignment: Assignment,
        grant: Grant,
        lease: Lease,
    ) -> ProtocolResult<Self> {
        assignment.validate_for_ticket(&ticket)?;
        if assignment.attempt != ticket.attempt || ticket.status != TicketStatus::Running {
            return Err(ProtocolError::InvalidTransition(
                "initial domain state must be running on the same attempt",
            ));
        }
        Ok(Self {
            ticket,
            assignment,
            grant,
            lease,
            last_sequence: 0,
            last_request_id: None,
            last_report: None,
            last_outcome: None,
        })
    }

    pub fn accept_report(
        &mut self,
        authenticated_node: &NodeId,
        report: Report,
        now: DateTime<Utc>,
    ) -> ProtocolResult<ReportOutcome> {
        if report.node_id != *authenticated_node {
            return Err(ProtocolError::NodeIdentityMismatch);
        }
        if self.last_request_id == Some(report.request_id) {
            let previous = self
                .last_report
                .as_ref()
                .ok_or(ProtocolError::InvalidReport(
                    "idempotency record without report",
                ))?;
            if previous.as_ref() == &report {
                return self
                    .last_outcome
                    .clone()
                    .map(|outcome| outcome.duplicate())
                    .ok_or(ProtocolError::InvalidReport(
                        "idempotency record without outcome",
                    ));
            }
            return Err(ProtocolError::IdempotencyConflict {
                request_id: report.request_id.into_inner(),
            });
        }
        authorize_report(&DomainView(self), authenticated_node, &report, now)?;
        if report.sequence <= self.last_sequence {
            return Err(ProtocolError::StaleReport);
        }
        if self.ticket.status == TicketStatus::Succeeded && !self.ticket.cancel_requested {
            return Err(ProtocolError::ReportTerminal);
        }
        if self.ticket.status == TicketStatus::Cancelled && !self.ticket.cancel_requested {
            return Err(ProtocolError::ReportTerminal);
        }
        let old_status = self.ticket.status;
        let next_status = report.ticket_status();
        if old_status == next_status
            && matches!(
                next_status,
                TicketStatus::Succeeded | TicketStatus::Cancelled
            )
        {
            return Err(ProtocolError::ReportTerminal);
        }
        self.ticket.status = next_status;
        self.ticket.updated_at = now;
        if report.cancel_acknowledged {
            self.ticket.cancel_acknowledged_at = Some(now);
        }
        // No independent authenticated heartbeat proves this report retry intent;
        // ticket/attempt/node binding above is what preserves cross-worker isolation.
        let disposition = match next_status {
            TicketStatus::Reconciling => ReportDisposition::Reconciling,
            TicketStatus::Cancelled => ReportDisposition::Cancelled,
            _ => ReportDisposition::Accepted,
        };
        let outcome = ReportOutcome {
            disposition,
            status: next_status,
            request_id: report.request_id,
            artifacts: report.artifacts.clone(),
            effects: report.effects.clone(),
        };
        self.last_sequence = report.sequence;
        self.last_request_id = Some(report.request_id);
        self.last_report = Some(Box::new(report));
        self.last_outcome = Some(outcome.clone());
        Ok(outcome)
    }
}

struct DomainView<'a>(&'a DomainState);

impl AuthorizationStore for DomainView<'_> {
    fn authenticated_node_matches(&self) -> bool {
        true
    }

    fn grant(&self) -> &Grant {
        &self.0.grant
    }

    fn lease(&self) -> &Lease {
        &self.0.lease
    }

    fn assignment(&self) -> &Assignment {
        &self.0.assignment
    }

    fn ticket(&self) -> &Ticket {
        &self.0.ticket
    }
}

/// Artifact checks are separate because reference arrival and content arrival may
/// be on separate endpoints. Store the transactionally validated reference first.
pub fn validate_report_artifacts(report: &Report, assignment: &Assignment) -> ProtocolResult<()> {
    if report.assignment_id != assignment.id {
        return Err(ProtocolError::ArtifactLineageMismatch);
    }
    report.validate()
}

/// Cancellation may fence an active lease without expiring Grant independently.
pub fn cancel_assignment(
    ticket: &mut Ticket,
    lease: &mut Lease,
    now: DateTime<Utc>,
) -> ProtocolResult<()> {
    ticket.request_cancel(now)?;
    lease.revoked_at = Some(now);
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationRule;

impl ReconciliationRule {
    pub fn retry_allowed(ticket: &Ticket, unresolved_effects: usize) -> bool {
        matches!(
            ticket.status,
            TicketStatus::Failed | TicketStatus::Reconciling
        ) && !ticket.cancel_requested
            && unresolved_effects == 0
            && ticket.status != TicketStatus::Reconciling
    }

    pub fn next_attempt(ticket: &Ticket) -> ProtocolResult<u64> {
        if ticket.status != TicketStatus::Failed || ticket.cancel_requested {
            return Err(ProtocolError::InvalidRetry);
        }
        ticket
            .attempt
            .checked_add(1)
            .ok_or(ProtocolError::InvalidRetry)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportStoreRecord {
    pub ticket_id: TicketId,
    pub sequence: u64,
    pub digest: crate::core::Sha256Digest,
}

#[allow(dead_code)]
fn _ensure_ticket_status_copy(_: TicketStatus) {}
