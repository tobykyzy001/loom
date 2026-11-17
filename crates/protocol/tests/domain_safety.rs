use std::collections::BTreeSet;
use std::str::FromStr;

use chrono::{DateTime, TimeZone, Utc};
use loom_protocol::*;

fn at(seconds: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(1_800_000_000 + seconds, 0).unwrap()
}

fn path(value: &str) -> RelativePath {
    RelativePath::parse(value).unwrap()
}

fn ids() -> (NodeId, InstallationId, WorkerId, ProjectId) {
    (
        NodeId::parse("a".repeat(64)).unwrap(),
        InstallationId::parse("development-installation").unwrap(),
        WorkerId::parse("fixture-worker").unwrap(),
        ProjectId::from_str("53c19a95-d802-4010-9c16-8f9b7a000001").unwrap(),
    )
}

fn grant() -> Grant {
    let (node_id, installation_id, worker_id, project_id) = ids();
    Grant {
        id: uuid::Uuid::from_str("53c19a95-d802-4010-9c16-8f9b7a000002").unwrap(),
        version: 1,
        node_id,
        installation_id,
        worker_id,
        project_id,
        operations: BTreeSet::from([
            Operation::Read,
            Operation::ReadPath(path("src")),
            Operation::EditFile(path("notes/out.txt")),
        ]),
        issued_at: at(0),
        expires_at: Some(at(1_000)),
        revoked_at: None,
        superseded: None,
    }
}

fn fixture() -> (DomainState, Report) {
    let (node_id, installation_id, worker_id, project_id) = ids();
    let grant = grant();
    let mut ticket = Ticket::new(
        project_id,
        "Write the approved fixture",
        TicketKind::EditFile,
        Some(path("notes/out.txt")),
        node_id,
        installation_id,
        worker_id,
        &grant,
        at(10),
    )
    .unwrap();
    // The pending ticket is not a running authority until assignment is attached.
    ticket.status = TicketStatus::Pending;
    let lease = Lease {
        id: LeaseId::from_str("53c19a95-d802-4010-9c16-8f9b7a000003").unwrap(),
        assignment_id: AssignmentId::nil(),
        ticket_id: ticket.id,
        node_id: ticket.node_id.clone(),
        epoch: 7,
        issued_at: at(11),
        expires_at: at(200),
        revoked_at: None,
    };
    let assignment = Assignment::new(&ticket, &grant, lease.clone(), 1).unwrap();
    let assignment = Assignment {
        lease_id: lease.id,
        ..assignment
    };
    let lease = Lease {
        assignment_id: assignment.id,
        ..lease
    };
    ticket.attached_assignment(&assignment).unwrap();
    ticket.updated_at = at(11);
    let state = DomainState::new(ticket, assignment.clone(), grant, lease).unwrap();
    let report = Report {
        request_id: RequestId(from_str_uuid("53c19a95-d802-4010-9c16-8f9b7a000004")),
        report_id: ReportId(from_str_uuid("53c19a95-d802-4010-9c16-8f9b7a000005")),
        ticket_id: state.ticket.id,
        assignment_id: assignment.id,
        node_id: assignment.node_id.clone(),
        installation_id: assignment.installation_id.clone(),
        worker_id: assignment.worker_id.clone(),
        attempt: 1,
        lease_id: assignment.lease_id,
        lease_epoch: 7,
        sequence: 1,
        grant_digest: assignment.grant_digest.clone(),
        status: ReportStatus::Succeeded,
        summary: "Validated bytes written".into(),
        session: Some(SessionRef {
            harness_kind: HarnessKind::parse("dsh").unwrap(),
            profile_id: ProfileId::parse("test-profile").unwrap(),
            session_id: "synthetic-session".into(),
            revision: 1,
        }),
        artifacts: vec![artifact(
            "53c19a95-d802-4010-9c16-8f9b7a000006",
            "53c19a95-d802-4010-9c16-8f9b7a000007",
            &assignment,
        )],
        effects: vec![],
        cancel_acknowledged: false,
        created_at: at(20),
    };
    (state, report)
}

fn from_str_uuid(value: &str) -> uuid::Uuid {
    uuid::Uuid::from_str(value).unwrap()
}

fn artifact(id: &str, effect: &str, assignment: &Assignment) -> ArtifactRef {
    let _ = effect;
    ArtifactRef {
        schema: ArtifactRef::SCHEMA_V1.into(),
        artifact_id: ArtifactId(from_str_uuid(id)),
        ticket_id: assignment.ticket_id,
        assignment_id: assignment.id,
        origin_node_id: assignment.node_id.clone(),
        location: "loom-artifact://local/artifact-1".into(),
        media_type: "text/plain".into(),
        size_bytes: 5,
        sha256: Sha256Digest::from_bytes(b"hello"),
        parents: vec![],
        evidence: vec![EvidenceRef {
            kind: "atomic_write".into(),
            digest: Sha256Digest::from_bytes(b"effect-1"),
            uri: None,
        }],
    }
}

fn report(state: &DomainState, status: ReportStatus) -> Report {
    let assignment = &state.assignment;
    Report {
        request_id: RequestId::new(),
        report_id: ReportId::new(),
        ticket_id: state.ticket.id,
        assignment_id: assignment.id,
        node_id: assignment.node_id.clone(),
        installation_id: assignment.installation_id.clone(),
        worker_id: assignment.worker_id.clone(),
        attempt: assignment.attempt,
        lease_id: assignment.lease_id,
        lease_epoch: assignment.lease_epoch,
        sequence: 1,
        grant_digest: assignment.grant_digest.clone(),
        status,
        summary: "Synthetic evidence".into(),
        session: None,
        artifacts: vec![],
        effects: if status == ReportStatus::Failed || status == ReportStatus::Unknown {
            vec![effect(state)]
        } else {
            vec![]
        },
        cancel_acknowledged: false,
        created_at: at(20),
    }
}

fn effect(state: &DomainState) -> Effect {
    Effect {
        effect_id: EffectId::new(),
        ticket_id: state.ticket.id,
        assignment_id: state.assignment.id,
        node_id: state.assignment.node_id.clone(),
        attempt: state.assignment.attempt,
        input_digest: Sha256Digest::from_bytes(b"effect-input"),
        status: EffectStatus::Unknown,
        evidence: vec![EvidenceRef {
            kind: "host_pending".into(),
            digest: Sha256Digest::from_bytes(b"result-pending"),
            uri: None,
        }],
        artifacts: vec![],
    }
}

#[test]
fn paths_are_logical_portable_targets_and_empty_write_is_rejected() {
    for invalid in [
        "",
        "../secret",
        "src/../../x",
        "./x",
        "/etc/passwd",
        "src//x",
        "src/./x",
        "src\\x",
        "C:/x",
        "c:bad",
        "\0bad",
    ] {
        RelativePath::parse(invalid).unwrap_err();
    }
    for valid in ["src/main.rs", "README.md", "src/.well-known/config.json"] {
        RelativePath::parse(valid).unwrap();
    }
    assert!(path("src/main.rs").is_within(&path("src")));
    assert!(!path("src-old/private").is_within(&path("src")));
    let (node_id, installation_id, worker_id, project_id) = ids();
    let error = Ticket::new(
        project_id,
        "Do not guess a target",
        TicketKind::EditFile,
        None,
        node_id,
        installation_id,
        worker_id,
        &grant(),
        at(1),
    );
    assert_eq!(error.unwrap_err(), ProtocolError::SensitiveTargetRequired);
    assert_eq!(
        grant().authorize(
            &ids().0,
            &ids().1,
            &ids().2,
            &ids().3,
            &Operation::EditFile(path("notes/escape.txt")),
            at(50)
        ),
        Err(ProtocolError::OutsideGrantScope)
    );
    assert_eq!(
        grant().authorize(
            &ids().0,
            &ids().1,
            &ids().2,
            &ids().3,
            &Operation::EditFile(path("src/main.rs")),
            at(50)
        ),
        Err(ProtocolError::OutsideGrantScope)
    );
}

#[test]
fn model_descriptor_is_explicit_read_only_model_json_target() {
    assert_eq!(
        TicketKind::ModelDescriptor.required_permission(),
        Permission::Read
    );
    assert!(TicketKind::ModelDescriptor.requires_explicit_target());
    let target = path("model.json");
    let operation =
        Operation::for_ticket(TicketKind::ModelDescriptor, Some(target.clone())).unwrap();
    assert_eq!(operation, Operation::ReadPath(target.clone()));
    assert_eq!(operation.required_permission(), Permission::Read);
    for invalid in [
        None,
        Some(path("weights.json")),
        Some(path("nested/model.json")),
    ] {
        assert!(Operation::for_ticket(TicketKind::ModelDescriptor, invalid).is_err());
    }
    assert!(RelativePath::parse("../model.json").is_err());
    let mut grant = grant();
    grant
        .operations
        .insert(Operation::ReadPath(path("model.json")));
    let ticket = Ticket::create(
        TicketSpec {
            project_id: ids().3,
            objective: "Observe descriptor; do not run a model".into(),
            kind: TicketKind::ModelDescriptor,
            relative_path: Some(target),
        },
        Placement {
            node_id: ids().0,
            installation_id: ids().1,
            worker_id: ids().2,
        },
        &grant,
        at(10),
    )
    .unwrap();
    assert_eq!(ticket.kind, TicketKind::ModelDescriptor);
    assert_eq!(ticket.operation.required_permission(), Permission::Read);
}

#[test]
fn grant_revocation_and_digest_change_fence_execution() {
    let (mut state, report) = fixture();
    let result = state
        .accept_report(&report.node_id, report.clone(), at(30))
        .unwrap();
    assert_eq!(result.status, TicketStatus::Succeeded);
    let (mut state, report) = fixture();
    state.grant = state.grant.revoked(at(15), &state.assignment.grant_digest);
    assert!(matches!(
        state.accept_report(&report.node_id.clone(), report, at(30)),
        Err(ProtocolError::GrantRevoked { .. })
    ));
    assert_eq!(state.ticket.status, TicketStatus::Running);
    let (mut state, report) = fixture();
    state.grant.version += 1;
    state.grant.expires_at = Some(at(900));
    assert_eq!(
        state.accept_report(&report.node_id.clone(), report, at(30)),
        Err(ProtocolError::GrantFenced)
    );
}

#[test]
fn stale_foreign_and_expired_leases_are_refused_without_mutation() {
    let (mut state, mut report) = fixture();
    report.lease_epoch -= 1;
    assert_eq!(
        state.accept_report(&report.node_id.clone(), report, at(30)),
        Err(ProtocolError::StaleLease {
            expected: 7,
            actual: 6
        })
    );
    assert_eq!(state.last_sequence, 0);
    let (mut state, report) = fixture();
    state.lease.revoked_at = Some(at(12));
    assert_eq!(
        state.accept_report(&report.node_id.clone(), report, at(30)),
        Err(ProtocolError::LeaseRevoked)
    );
    let (mut state, report) = fixture();
    assert_eq!(
        state.accept_report(&report.node_id.clone(), report, at(200)),
        Err(ProtocolError::LeaseExpired)
    );
    // Lease+grant digest-only check deliberately authorizes no project access.
    state.lease.revoked_at = None;
    assert_eq!(
        state
            .assignment
            .authorize_for_ticket(&state.ticket, &state.grant, &state.lease, at(200)),
        Err(ProtocolError::LeaseExpired)
    );
}

#[test]
fn report_idempotency_is_exact_payload_not_only_request_id() {
    let (mut state, report) = fixture();
    let original = state
        .accept_report(&report.node_id, report.clone(), at(30))
        .unwrap();
    assert_eq!(original.artifacts.len(), 1);
    let duplicate = state
        .accept_report(&report.node_id, report.clone(), at(31))
        .unwrap();
    assert_eq!(duplicate.disposition, ReportDisposition::Duplicate);
    assert_eq!(duplicate.artifacts.len(), 1);
    assert_eq!(duplicate.status, TicketStatus::Succeeded);
    let mut changed = report;
    changed.summary = "conflict".into();
    assert_eq!(
        state.accept_report(&changed.node_id.clone(), changed, at(32)),
        Err(ProtocolError::IdempotencyConflict {
            request_id: from_str_uuid("53c19a95-d802-4010-9c16-8f9b7a000004")
        })
    );
    // The conflict has no timing-wins side effect and the original still replays.
    assert_eq!(
        state.last_report.as_ref().unwrap().summary,
        "Validated bytes written"
    );
}

#[test]
fn unknown_is_reconciling_with_unresolved_effect_not_failed() {
    let (mut state, report) = fixture();
    let mut unknown = report;
    unknown.status = ReportStatus::Unknown;
    unknown.summary = "Connection lost after atomic replace request".into();
    unknown.effects = vec![effect(&state)];
    unknown.artifacts.clear();
    let outcome = state
        .accept_report(&unknown.node_id.clone(), unknown, at(30))
        .unwrap();
    assert_eq!(outcome.disposition, ReportDisposition::Reconciling);
    assert_eq!(outcome.status, TicketStatus::Reconciling);
    assert!(!outcome.status.is_terminal());
    assert_eq!(
        state.ticket.status,
        M0StateMachine::project_report(ReportStatus::Unknown)
    );
    assert!(!ReconciliationRule::retry_allowed(&state.ticket, 1));
    assert_eq!(
        M0StateMachine::reconcile_effect(EffectStatus::Unknown, HostEffectFact::Confirmed).unwrap(),
        EffectStatus::Confirmed
    );
    assert_eq!(
        M0StateMachine::reconcile_effect(EffectStatus::Unknown, HostEffectFact::NeedsPerson)
            .unwrap(),
        EffectStatus::NeedsPerson
    );
}

#[test]
fn cancellation_persists_blocks_new_work_but_accepts_exact_acknowledgement() {
    let (mut state, success) = fixture();
    cancel_assignment(&mut state.ticket, &mut state.lease, at(15)).unwrap();
    assert!(state.ticket.cancel_requested);
    assert_eq!(
        state.accept_report(&success.node_id.clone(), success, at(30)),
        Err(ProtocolError::Cancelled)
    );
    assert_eq!(state.ticket.status, TicketStatus::Running);
    let mut ack = report(&state, ReportStatus::Running);
    assert_eq!(
        state.accept_report(&ack.node_id, ack.clone(), at(30)),
        Err(ProtocolError::Cancelled)
    );
    ack.status = ReportStatus::Cancelled;
    ack.cancel_acknowledged = true;
    let accepted = state
        .accept_report(&ack.node_id, ack.clone(), at(300))
        .unwrap();
    assert_eq!(accepted.status, TicketStatus::Cancelled);
    assert_eq!(state.ticket.updated_at, at(300));
    // A duplicate cancellation acknowledgement remains idempotent, not a new task.
    assert_eq!(
        state
            .accept_report(&ack.node_id.clone(), ack, at(301))
            .unwrap()
            .disposition,
        ReportDisposition::Duplicate
    );
    assert!(!ReconciliationRule::retry_allowed(&state.ticket, 0));
}

#[test]
fn improper_cancel_acknowledgement_is_rejected() {
    let (mut state, _) = fixture();
    let mut ack = report(&state, ReportStatus::Cancelled);
    ack.cancel_acknowledged = true;
    assert_eq!(
        state.accept_report(&ack.node_id.clone(), ack, at(30)),
        Err(ProtocolError::CancellationNotRequested)
    );
}

#[test]
fn artifact_hash_bytes_uri_and_lineage_are_hard_gates() {
    let (_, report) = fixture();
    let mut item = report.artifacts[0].clone();
    item.verify_payload(b"hello").unwrap();
    assert_eq!(
        item.verify_payload(b"nope!"),
        Err(ProtocolError::ArtifactIntegrity)
    );
    assert_eq!(
        item.verify_payload(b"hell"),
        Err(ProtocolError::ArtifactIntegrity)
    );
    item.sha256 = Sha256Digest::from_bytes(b"other");
    assert_eq!(
        item.verify_payload(b"hello"),
        Err(ProtocolError::ArtifactIntegrity)
    );
    let mut item = report.artifacts[0].clone();
    item.artifact_id = ArtifactId::new();
    let mut report = report;
    report.artifacts[0] = item;
    assert_ne!(report.artifacts[0].artifact_id, ArtifactId::nil());
    report.artifacts[0].origin_node_id = NodeId::parse("b".repeat(64)).unwrap();
    assert_eq!(
        report.validate(),
        Err(ProtocolError::ArtifactLineageMismatch)
    );
    let mut report = fixture().1;
    report.artifacts[0].location = "/Users/private/file".into();
    assert!(matches!(
        report.validate(),
        Err(ProtocolError::InvalidArtifact(_))
    ));
    report.artifacts[0].location = "file:///secret".into();
    assert_eq!(
        report.validate(),
        Err(ProtocolError::InvalidArtifact(
            "local path is not a global artifact URI"
        ))
    );
}

#[test]
fn effects_cannot_cross_assignments_or_regress_confirmed_state() {
    let (_, mut report) = fixture();
    let mut effect = effect(&fixture().0);
    effect.assignment_id = report.assignment_id;
    effect.ticket_id = report.ticket_id;
    effect.node_id = report.node_id.clone();
    report.effects = vec![effect.clone()];
    report.artifacts = vec![];
    report.effects[0].node_id = NodeId::parse("b".repeat(64)).unwrap();
    assert_eq!(report.validate(), Err(ProtocolError::EffectLineageMismatch));
    effect.status = EffectStatus::Confirmed;
    effect.evidence.clear();
    assert_eq!(
        effect.transition(EffectStatus::Recorded),
        Err(ProtocolError::InvalidEffectTransition(
            "confirmed/needs_person are immutable; recorded cannot become human review"
        ))
    );
}

#[test]
fn node_worker_attempt_correlation_is_not_optional() {
    let (mut state, report) = fixture();
    let mut wrong = report.clone();
    wrong.attempt = 99;
    assert_eq!(
        state.accept_report(&wrong.node_id.clone(), wrong, at(30)),
        Err(ProtocolError::LeaseMismatch)
    );
    let mut wrong = report.clone();
    wrong.worker_id = WorkerId::parse("other-worker").unwrap();
    assert_eq!(
        state.accept_report(&wrong.node_id.clone(), wrong, at(30)),
        Err(ProtocolError::LeaseMismatch)
    );
    let other = NodeId::parse("b".repeat(64)).unwrap();
    assert_eq!(
        state.accept_report(&other, report, at(30)),
        Err(ProtocolError::NodeIdentityMismatch)
    );
}

#[test]
fn failed_task_needs_explicit_incremented_retry_without_unknown_effects() {
    let (mut state, _) = fixture();
    let mut failed = report(&state, ReportStatus::Failed);
    failed.effects[0].status = EffectStatus::Recorded;
    let result = state
        .accept_report(&failed.node_id.clone(), failed, at(30))
        .unwrap();
    assert_eq!(result.status, TicketStatus::Failed);
    assert_eq!(ReconciliationRule::next_attempt(&state.ticket).unwrap(), 2);
    state.ticket.attempt = 2;
    assert!(ReconciliationRule::retry_allowed(&state.ticket, 0));
    assert!(!ReconciliationRule::retry_allowed(&state.ticket, 1));
}

#[test]
fn tokio_can_be_used_by_server_adapters_without_global_core_runtime() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    assert_eq!(
        rt.block_on(async { M0StateMachine::project_report(ReportStatus::Unknown) }),
        TicketStatus::Reconciling
    );
}
