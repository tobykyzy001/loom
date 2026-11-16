use std::collections::BTreeSet;
use std::path::Path;
use std::str::FromStr;

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, TimeZone, Utc};
use ed25519_dalek::SigningKey;
use loom_protocol::*;

fn at(seconds: i64) -> DateTime<Utc> {
    Utc.timestamp_opt(seconds, 0).unwrap()
}

fn uuid(s: &str) -> uuid::Uuid {
    uuid::Uuid::from_str(s).unwrap()
}

fn write<T: serde::Serialize>(directory: &Path, name: &str, value: &T) {
    let json = serde_json::to_string_pretty(value).unwrap() + "\n";
    std::fs::write(directory.join(name), json).unwrap();
}

fn write_value(directory: &Path, name: &str, value: serde_json::Value) {
    write(directory, name, &value);
}

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/node/v1");
    let directory = root.as_path();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let key = NodePublicKey::from_signing_key(&signing_key);
    let public_key = key.to_base64url();
    let node_id = key.node_id().unwrap();
    let installation_id = InstallationId::parse("fixture-installation").unwrap();
    let challenge_nonce = ChallengeNonce::from_bytes([9; 32]);
    let signature = NodePublicKey::sign(&signing_key, &challenge_nonce);
    let challenge = ChallengeRequest {
        protocol: ProtocolVersion::v1(),
        node_id: node_id.clone(),
        installation_id: installation_id.clone(),
        public_key: public_key.clone(),
    };
    write(directory, "challenge.request.json", &challenge);
    write(
        directory,
        "challenge.response.json",
        &ChallengeResponse {
            challenge_id: ChallengeId(uuid("99999999-9999-4999-8999-999999999901")),
            nonce: challenge_nonce.clone(),
            expires_at: at(1_800_000_100),
        },
    );
    let registration = RegisterNodeRequest {
        protocol: ProtocolVersion::v1(),
        node_id: node_id.clone(),
        installation_id: installation_id.clone(),
        public_key: public_key.clone(),
        enrollment_code: "synthetic-enrollment-code".into(),
        nonce: challenge_nonce.clone(),
        signed_challenge: signature.clone(),
        request_id: RequestId(uuid("99999999-9999-4999-8999-999999999902")),
        capabilities: vec![
            Capability {
                ticket_kind: TicketKind::ReadSummary,
                permission: Permission::Read,
            },
            Capability {
                ticket_kind: TicketKind::EditFile,
                permission: Permission::Write,
            },
        ],
        worker_id: WorkerId::parse("fixture-worker").unwrap(),
        harness_kind: HarnessKind::parse("dsh").unwrap(),
        profile_id: ProfileId::parse("fixture-profile").unwrap(),
    };
    registration.validate().unwrap();
    write(directory, "register.request.json", &registration);
    write(
        directory,
        "register.response.json",
        &RegisterNodeResponse {
            node_id: node_id.clone(),
            token: "synthetic-node-token-not-a-secret".into(),
            grant_digest: None,
        },
    );

    write(
        directory,
        "heartbeat.request.json",
        &HeartbeatRequest {
            protocol: ProtocolVersion::v1(),
            node_id: node_id.clone(),
            installation_id: installation_id.clone(),
            request_id: RequestId(uuid("99999999-9999-4999-8999-999999999903")),
            sent_at: Some(at(1_800_000_020)),
            payload: Heartbeat {
                status: NodeStatus::Online,
                workers: vec![WorkerSnapshot {
                    worker_id: WorkerId::parse("fixture-worker").unwrap(),
                    harness_kind: HarnessKind::parse("dsh").unwrap(),
                    profile_id: ProfileId::parse("fixture-profile").unwrap(),
                    status: NodeStatus::Online,
                    capabilities: vec![Capability {
                        ticket_kind: TicketKind::ReadSummary,
                        permission: Permission::Read,
                    }],
                    observed_at: at(1_800_000_020),
                    supported_effects: vec!["atomic_file_replace".into()],
                }],
            },
        },
    );
    write(
        directory,
        "poll.request.json",
        &AssignmentPollRequest {
            protocol: ProtocolVersion::v1(),
            node_id: node_id.clone(),
            installation_id: installation_id.clone(),
            request_id: RequestId(uuid("99999999-9999-4999-8999-999999999904")),
            sent_at: None,
            payload: AssignmentPoll {
                last_assignment_id: None,
                wait_seconds: 20,
            },
        },
    );
    let ticket_id = TicketId(uuid("99999999-9999-4999-8999-999999999910"));
    let assignment_id = AssignmentId(uuid("99999999-9999-4999-8999-999999999911"));
    let lease_id = LeaseId(uuid("99999999-9999-4999-8999-999999999912"));
    let operations = BTreeSet::from([Operation::EditFile(
        RelativePath::parse("notes/out.txt").unwrap(),
    )]);
    let grant = Grant {
        id: uuid("99999999-9999-4999-8999-999999999913"),
        version: 1,
        node_id: node_id.clone(),
        installation_id: installation_id.clone(),
        worker_id: WorkerId::parse("fixture-worker").unwrap(),
        project_id: ProjectId(uuid("99999999-9999-4999-8999-999999999914")),
        operations,
        issued_at: at(1_800_000_000),
        expires_at: Some(at(1_800_001_000)),
        revoked_at: None,
        superseded: None,
    };
    let grant_digest = grant.digest().unwrap();
    let assignment = Assignment {
        id: assignment_id,
        ticket_id,
        node_id: node_id.clone(),
        installation_id: installation_id.clone(),
        worker_id: WorkerId::parse("fixture-worker").unwrap(),
        attempt: 1,
        lease_id,
        lease_epoch: 1,
        lease_expires_at: at(1_800_000_200),
        grant_digest: grant_digest.clone(),
        operation: Some(Operation::EditFile(
            RelativePath::parse("notes/out.txt").unwrap(),
        )),
        session: Some(SessionRef {
            harness_kind: HarnessKind::parse("dsh").unwrap(),
            profile_id: ProfileId::parse("fixture-profile").unwrap(),
            session_id: "synthetic-session".into(),
            revision: 1,
        }),
    };
    write(
        directory,
        "assignment.response.json",
        &AssignmentPayload {
            assignment: assignment.clone(),
            project_id: grant.project_id,
            objective: "Write the synthetic hello fixture".into(),
            kind: TicketKind::ReadSummary,
            ticket_id,
        },
    );
    let artifact = ArtifactRef {
        schema: ArtifactRef::SCHEMA_V1.into(),
        artifact_id: ArtifactId(uuid("99999999-9999-4999-8999-999999999915")),
        ticket_id,
        assignment_id,
        origin_node_id: node_id.clone(),
        location: "loom-artifact://local/99999999-9999-4999-8999-999999999915".into(),
        media_type: "text/plain".into(),
        size_bytes: 6,
        sha256: Sha256Digest::from_bytes(b"hello\n"),
        parents: vec![],
        evidence: vec![EvidenceRef {
            kind: "atomic_file_replace".into(),
            digest: Sha256Digest::from_bytes(b"fixture-effect"),
            uri: None,
        }],
    };
    artifact.verify_payload(b"hello\n").unwrap();
    let report = Report {
        request_id: RequestId(uuid("99999999-9999-4999-8999-999999999916")),
        report_id: ReportId(uuid("99999999-9999-4999-8999-999999999917")),
        ticket_id,
        assignment_id,
        node_id: node_id.clone(),
        installation_id: installation_id.clone(),
        worker_id: WorkerId::parse("fixture-worker").unwrap(),
        attempt: 1,
        lease_id,
        lease_epoch: 1,
        sequence: 1,
        grant_digest: grant_digest.clone(),
        status: ReportStatus::Succeeded,
        summary: "Synthetic contract fixture completed".into(),
        session: assignment.session.clone(),
        artifacts: vec![artifact.clone()],
        effects: vec![Effect {
            effect_id: EffectId(uuid("99999999-9999-4999-8999-999999999918")),
            ticket_id,
            assignment_id,
            node_id: node_id.clone(),
            attempt: 1,
            input_digest: Sha256Digest::from_bytes(b"fixture-effect"),
            status: EffectStatus::Confirmed,
            evidence: artifact.evidence.clone(),
            artifacts: vec![artifact.artifact_id],
        }],
        cancel_acknowledged: false,
        created_at: at(1_800_000_040),
    };
    write(
        directory,
        "report.request.json",
        &ReportRequest::from_report(report, at(1_800_000_041)).unwrap(),
    );
    write(
        directory,
        "report.response.json",
        &ReportResponse {
            request_id: RequestId(uuid("99999999-9999-4999-8999-999999999916")),
            disposition: ReportDisposition::Accepted,
            ticket_status: TicketStatus::Succeeded,
        },
    );
    let mut unknown = fixture_report(&assignment, grant_digest.clone());
    unknown.status = ReportStatus::Unknown;
    unknown.summary = "Connection lost; host effect not yet verified".into();
    write(
        directory,
        "unknown-report.request.json",
        &ReportRequest::from_report(unknown, at(1_800_000_051)).unwrap(),
    );
    write(
        directory,
        "artifact.request.json",
        &ArtifactUploadRequest {
            protocol: ProtocolVersion::v1(),
            node_id: node_id.clone(),
            installation_id: installation_id.clone(),
            request_id: RequestId(uuid("99999999-9999-4999-8999-999999999920")),
            sent_at: Some(at(1_800_000_039)),
            payload: ArtifactUpload {
                ticket_id,
                artifact_id: artifact.artifact_id,
                assignment_id,
                lease_id,
                lease_epoch: 1,
                grant_digest,
                metadata: artifact.clone(),
                bytes_base64: STANDARD.encode(b"hello\n"),
            },
        },
    );
    write_value(
        directory,
        "protocol-unsupported.invalid.json",
        challenge_wire_without_version("loom.node.v2", &node_id, &installation_id, &public_key)
            .expect("bad challenge fixture must still be a serializable object"),
    );
    let invalid = serde_json::json!({
        "protocol": "loom.node.v1",
        "node_id": "00".repeat(32),
        "installation_id": installation_id,
        "public_key": public_key,
    });
    write_value(directory, "key-mismatch.invalid.json", invalid);
    let mut signature_tampered = serde_json::to_value(&registration).unwrap();
    signature_tampered["signed_challenge"] = serde_json::Value::String(STANDARD.encode([1; 64]));
    write_value(directory, "bad-signature.invalid.json", signature_tampered);
    println!(
        "generated {}, node_id={} signature={}",
        directory.display(),
        node_id,
        signature
    );
}

fn challenge_wire_without_version(
    version: &str,
    node_id: &NodeId,
    installation_id: &InstallationId,
    public_key: &str,
) -> Option<serde_json::Value> {
    Some(serde_json::json!({
        "protocol": version,
        "node_id": node_id,
        "installation_id": installation_id,
        "public_key": public_key
    }))
}

fn fixture_report(assignment: &Assignment, grant_digest: GrantDigest) -> Report {
    Report {
        request_id: RequestId(uuid("99999999-9999-4999-8999-999999999919")),
        report_id: ReportId(uuid("99999999-9999-4999-8999-999999999921")),
        ticket_id: assignment.ticket_id,
        assignment_id: assignment.id,
        node_id: assignment.node_id.clone(),
        installation_id: assignment.installation_id.clone(),
        worker_id: assignment.worker_id.clone(),
        attempt: assignment.attempt,
        lease_id: assignment.lease_id,
        lease_epoch: assignment.lease_epoch,
        sequence: 2,
        grant_digest,
        status: ReportStatus::Running,
        summary: "Synthetic fixture".into(),
        session: assignment.session.clone(),
        artifacts: vec![],
        effects: vec![Effect {
            effect_id: EffectId(uuid("99999999-9999-4999-8999-999999999922")),
            ticket_id: assignment.ticket_id,
            assignment_id: assignment.id,
            node_id: assignment.node_id.clone(),
            attempt: assignment.attempt,
            input_digest: Sha256Digest::from_bytes(b"pending"),
            status: EffectStatus::Unknown,
            evidence: vec![EvidenceRef {
                kind: "host_pending".into(),
                digest: Sha256Digest::from_bytes(b"ledger-reference"),
                uri: None,
            }],
            artifacts: vec![],
        }],
        cancel_acknowledged: false,
        created_at: at(1_800_000_050),
    }
}
