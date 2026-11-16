#![cfg(feature = "fixture-signing")]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{TimeZone, Utc};
use ed25519_dalek::SigningKey;
use loom_protocol::*;

fn at(seconds: i64) -> chrono::DateTime<Utc> {
    Utc.timestamp_opt(seconds, 0).unwrap()
}

fn request() -> (SigningKey, RegistrationChallenge, RegisterNodeRequest) {
    let key = SigningKey::from_bytes(&[7; 32]);
    let public_key = NodePublicKey::from_signing_key(&key);
    let node_id = public_key.node_id().unwrap();
    let installation_id = InstallationId::parse("fixture-installation").unwrap();
    let nonce = ChallengeNonce::from_bytes([9; 32]);
    let signed_challenge = NodePublicKey::sign(&key, &nonce);
    let public_key = public_key.to_base64url();
    let challenge = RegistrationChallenge {
        challenge_id: ChallengeId::nil(),
        node_id: node_id.clone(),
        installation_id: installation_id.clone(),
        public_key: public_key.clone(),
        nonce: nonce.clone(),
        expires_at: at(100),
        used_at: None,
    };
    let request = RegisterNodeRequest {
        protocol: ProtocolVersion::v1(),
        node_id,
        installation_id,
        public_key,
        enrollment_code: "synthetic-enrollment-code".into(),
        nonce,
        signed_challenge,
        request_id: RequestId::nil(),
        capabilities: vec![Capability {
            ticket_kind: TicketKind::ReadSummary,
            permission: Permission::Read,
        }],
        worker_id: WorkerId::parse("fixture-worker").unwrap(),
        harness_kind: HarnessKind::parse("dsh").unwrap(),
        profile_id: ProfileId::parse("fixture-profile").unwrap(),
    };
    (key, challenge, request)
}

#[test]
fn raw_key_binds_node_id_and_valid_challenge_binds_identity_not_grant() {
    let (_, challenge, request) = request();
    request.validate().unwrap();
    let identity = NodeIdentity::from_registration(&request, &challenge, true, at(20)).unwrap();
    assert_eq!(identity.node_id, request.node_id);
    assert!(!identity.revoked);
    // Enrollment doesn't fabricate a GrantDigest or project scope.
    assert_eq!(identity.registered_at, at(20));
    assert_eq!(
        NodeIdentity::from_registration(&request, &challenge, false, at(20)),
        Err(ProtocolError::OperationNotGranted)
    );
}

#[test]
fn expired_used_misbound_and_tampered_challenges_fail() {
    let (_, challenge, request) = request();
    assert_eq!(
        challenge.consume(&request, at(100)),
        Err(ProtocolError::InvalidChallenge)
    );
    let mut used = challenge.clone();
    used.used_at = Some(at(19));
    assert_eq!(
        used.consume(&request, at(20)),
        Err(ProtocolError::InvalidChallenge)
    );
    let mut wrong = challenge.clone();
    wrong.node_id = NodeId::parse("00".repeat(32)).unwrap();
    assert_eq!(
        wrong.consume(&request, at(20)),
        Err(ProtocolError::InvalidChallenge)
    );
    let mut tampered = request.clone();
    tampered.signed_challenge = URL_SAFE_NO_PAD.encode([3; 64]);
    assert_eq!(
        challenge.consume(&tampered, at(20)),
        Err(ProtocolError::InvalidSignature)
    );
    let mut invalid_key = request;
    invalid_key.public_key = URL_SAFE_NO_PAD.encode([1; 32]);
    // This can deserialize, but a mismatched node digest or a weak key is refused.
    assert!(matches!(
        invalid_key.validate(),
        Err(ProtocolError::NodeKeyMismatch | ProtocolError::InvalidSignature)
    ));
}

#[test]
fn revocation_and_cross_profile_prevent_token_rotation() {
    let (_, _, request) = request();
    let key = NodePublicKey::from_base64url(&request.public_key).unwrap();
    let mut identity = NodeIdentity {
        node_id: request.node_id.clone(),
        installation_id: request.installation_id.clone(),
        public_key: key,
        worker_id: request.worker_id.clone(),
        harness_kind: request.harness_kind.clone(),
        profile_id: request.profile_id.clone(),
        registered_at: at(10),
        revoked: false,
    };
    assert_eq!(
        identity.authorize_session_rotation(&request, false, at(20)),
        Err(ProtocolError::OperationNotGranted)
    );
    identity
        .authorize_session_rotation(&request, true, at(20))
        .unwrap();
    identity.revoked = true;
    assert_eq!(
        identity.authorize_session_rotation(&request, true, at(20)),
        Err(ProtocolError::NodeRevoked)
    );
    identity.revoked = false;
    let mut other_profile = request;
    other_profile.profile_id = ProfileId::parse("another-profile").unwrap();
    assert_eq!(
        identity.authorize_session_rotation(&other_profile, true, at(20)),
        Err(ProtocolError::NodeIdentityMismatch)
    );
}

#[test]
fn subsequent_envelopes_require_node_authentication_and_installation_binding() {
    let (_, challenge, request) = request();
    let identity = NodeIdentity::from_registration(&request, &challenge, true, at(20)).unwrap();
    let header = NodeEnvelopeHeader {
        protocol: ProtocolVersion::v1(),
        node_id: identity.node_id.clone(),
        installation_id: identity.installation_id.clone(),
        request_id: RequestId::nil(),
    };
    identity.validate_continuation(&header, true).unwrap();
    assert_eq!(
        identity.validate_continuation(&header, false),
        Err(ProtocolError::OperationNotGranted)
    );
    let mut wrong = header;
    wrong.installation_id = InstallationId::parse("other-installation").unwrap();
    assert_eq!(
        identity.validate_continuation(&wrong, true),
        Err(ProtocolError::NodeIdentityMismatch)
    );
}

#[test]
fn protocol_version_and_poll_window_are_explicit() {
    let _: serde_json::Error =
        serde_json::from_str::<ProtocolVersion>("\"loom.node.v2\"").unwrap_err();
    let poll = AssignmentPoll {
        last_assignment_id: None,
        wait_seconds: 20,
    };
    assert!(poll.validate().is_ok());
    let poll = AssignmentPoll {
        last_assignment_id: None,
        wait_seconds: 21,
    };
    assert_eq!(poll.validate(), Err(ProtocolError::InvalidPollWindow));
}
