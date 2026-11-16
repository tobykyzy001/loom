use std::path::{Path, PathBuf};

use loom_protocol::*;

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../protocol/fixtures/node/v1")
        .join(name);
    std::fs::read(path).unwrap()
}

fn parse<T: serde::de::DeserializeOwned>(name: &str) -> T {
    from_json_strict::<T>(&fixture(name)).unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn roundtrip<T>(name: &str)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let original = parse::<T>(name);
    let bytes = to_canonical_json(&original).unwrap();
    assert_eq!(original, from_json_strict(&bytes).unwrap(), "{name}");
    assert!(!Path::new(name).is_absolute());
}

#[test]
fn registration_and_challenge_roundtrip_and_have_real_signature() {
    roundtrip::<ChallengeRequest>("challenge.request.json");
    roundtrip::<ChallengeResponse>("challenge.response.json");
    roundtrip::<RegisterNodeRequest>("register.request.json");
    roundtrip::<RegisterNodeResponse>("register.response.json");
    roundtrip::<HeartbeatRequest>("heartbeat.request.json");
    roundtrip::<AssignmentPollRequest>("poll.request.json");
    roundtrip::<AssignmentPayload>("assignment.response.json");
    roundtrip::<ReportRequest>("report.request.json");
    roundtrip::<ReportResponse>("report.response.json");
    roundtrip::<ReportRequest>("unknown-report.request.json");
    roundtrip::<ArtifactUploadRequest>("artifact.request.json");
    let request = parse::<RegisterNodeRequest>("register.request.json");
    request.validate().unwrap();
    let challenge_request = parse::<ChallengeRequest>("challenge.request.json");
    let challenge_response = parse::<ChallengeResponse>("challenge.response.json");
    challenge_request.validate().unwrap();
    let challenge = RegistrationChallenge {
        challenge_id: challenge_response.challenge_id,
        node_id: challenge_request.node_id,
        installation_id: challenge_request.installation_id,
        public_key: challenge_request.public_key,
        nonce: challenge_response.nonce,
        expires_at: challenge_response.expires_at,
        used_at: None,
    };
    let identity = NodeIdentity::from_registration(
        &request,
        &challenge,
        true,
        chrono::DateTime::parse_from_rfc3339("2027-01-15T08:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc),
    )
    .unwrap();
    assert_eq!(identity.node_id, request.node_id);
}

#[test]
fn reports_and_artifact_preserve_ids_payload_and_unknown_is_not_success() {
    let report = parse::<ReportRequest>("report.request.json");
    let domain = report.into_report().unwrap();
    assert_eq!(domain.status, ReportStatus::Succeeded);
    assert_eq!(domain.ticket_status(), TicketStatus::Succeeded);
    assert_eq!(
        domain.effects[0].artifacts[0],
        domain.artifacts[0].artifact_id
    );
    assert_eq!(domain.artifacts[0].size_bytes, 6);
    domain.artifacts[0].verify_payload(b"hello\n").unwrap();
    let unknown = parse::<ReportRequest>("unknown-report.request.json");
    let report = unknown.into_report().unwrap();
    assert_eq!(report.status, ReportStatus::Unknown);
    assert_eq!(report.ticket_status(), TicketStatus::Reconciling);
    assert_eq!(report.effects[0].status, EffectStatus::Unknown);
    let upload = parse::<ArtifactUploadRequest>("artifact.request.json");
    upload.payload.validate().unwrap();
}

#[test]
fn unsupported_protocol_mismatched_key_and_bad_signature_are_rejected() {
    assert!(
        from_json_strict::<ChallengeRequest>(&fixture("protocol-unsupported.invalid.json"))
            .is_err()
    );
    let wrong: ChallengeRequest = from_json_strict(&fixture("key-mismatch.invalid.json")).unwrap();
    assert_eq!(wrong.validate(), Err(ProtocolError::NodeKeyMismatch));
    let bad: RegisterNodeRequest =
        from_json_strict(&fixture("bad-signature.invalid.json")).unwrap();
    assert!(bad.validate().is_err());
}

#[test]
fn strict_parser_rejects_duplicate_members_recursively_and_accepts_scalars() {
    assert!(from_json_strict::<bool>(b"true").unwrap());
    assert_eq!(from_json_strict::<u64>(b"0").unwrap(), 0);
    assert_eq!(from_json_strict::<Option<u64>>(b"null").unwrap(), None);
    assert_eq!(
        from_json_strict::<serde_json::Value>(br#"{"a":1,"a":2}"#),
        Err(ProtocolError::DuplicateJsonKey)
    );
    assert_eq!(
        from_json_strict::<serde_json::Value>(br#"{"a":[{"b":1,"b":2}]}"#),
        Err(ProtocolError::DuplicateJsonKey)
    );
    assert!(from_json_strict::<serde_json::Value>(br#"{"a":[{"b":1},{"b":2}]}"#).is_ok());
    assert!(from_json_strict::<serde_json::Value>(b"[true,false,1,2.5,\"x\",null]").is_ok());
}

#[test]
fn optional_sent_at_and_report_state_alias_accept_legacy_wire() {
    let poll: serde_json::Value = serde_json::from_slice(&fixture("poll.request.json")).unwrap();
    assert_eq!(poll["sent_at"], serde_json::Value::Null);
    let poll: AssignmentPollRequest =
        from_json_strict(&serde_json::to_vec(&poll).unwrap()).unwrap();
    assert_eq!(poll.sent_at, None);
    let mut report: serde_json::Value =
        serde_json::from_slice(&fixture("unknown-report.request.json")).unwrap();
    report["requested_state"] = report["status"].clone();
    report.as_object_mut().unwrap().remove("status");
    let parsed: ReportRequest = from_json_strict(&serde_json::to_vec(&report).unwrap()).unwrap();
    assert_eq!(parsed.payload.status, ReportStatus::Unknown);
}
