use loom_node::identity::Identity;
use loom_node::state::StateStore;
use loom_node::wire::{digest_json, Assignment};
use loom_node::{executor, Bindings, LocalNodeRunner, NodeOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn input(project: &std::path::Path) -> Value {
    let operations = json!(["read", "write"]);
    let binding = json!({"project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","root_scope":project});
    let binding_digest = digest_json(&binding);
    let grant = json!({"id":"grant_1","project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","binding":binding_digest,"operations":operations,"version":1});
    let grant_digest = digest_json(&grant);
    json!({"id":"asg_abc","assignment_id":"asg_abc","ticket_id":"tkt_1","project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","attempt":1,"lease_id":"lease_1","lease_epoch":1,"lease_expires_at":(chrono::Utc::now()+chrono::Duration::seconds(30)).to_rfc3339(),"grant_digest":grant_digest,"grant_version":1,"kind":"read_summary","relative_path":"README.md","content":null,"cancel_requested":false,"status":"running","protocol":"loom.node.v1","grant_status":true,"grant":{"id":"grant_1","project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","operations":operations,"version":1,"digest":grant_digest,"project_binding_id":"binding_1","created_at":chrono::Utc::now().to_rfc3339(),"revoked_at":null,"project_root":project},"resource":binding})
}

fn executable(
    tmp: &tempfile::TempDir,
    modifications: impl FnOnce(&mut Value),
) -> (Assignment, StateStore) {
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("README.md"), "Alpha\nfixed fact\n").unwrap();
    let artifacts = tmp.path().join("artifacts");
    std::fs::create_dir(&artifacts).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&artifacts, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::create_dir(tmp.path().join("state")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            tmp.path().join("state"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
    let mut raw = input(&project);
    modifications(&mut raw);
    let assignment = Assignment::decode(
        &raw,
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now(),
    )
    .unwrap();
    let state = StateStore::open(&tmp.path().join("state")).unwrap();
    (assignment, state)
}

#[test]
fn identity_is_raw_public_key_digest_and_key_persists_with_private_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("state");
    std::fs::create_dir(&root).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let identity = Identity::open(&root).unwrap();
    let again = Identity::open(&root).unwrap();
    assert_eq!(identity.node_id, again.node_id);
    assert_eq!(identity.installation_id, again.installation_id);
    assert_eq!(identity.node_id.len(), 64);
    assert_eq!(identity.node_id, identity.node_id.to_lowercase());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(root.join("identity.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert!(std::fs::read_to_string(root.join("identity.json"))
        .unwrap()
        .contains("private_key"));
    assert!(!format!("{identity:?}").contains("token"));
}

#[cfg(unix)]
#[test]
fn identity_rejects_publicly_readable_state() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::tempdir().unwrap();
    std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Identity::open(tmp.path()).is_err());
}

#[test]
fn revoked_reconciliation_keeps_original_grant_digest_without_new_execute_permission() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let base = input(&project);
    let good = |packet: &mut Value| {
        packet["kind"] = json!("edit_file");
        packet["content"] = json!("already written under the earlier Grant\n");
        packet["status"] = json!("reconciling");
        packet["purpose"] = json!("reconcile");
        packet["grant_status"] = json!(false);
        packet["lease_expires_at"] = json!("2000-01-01T00:00:00Z");
        packet["grant"]["version"] = json!(2);
        packet["grant"]["revoked_at"] = json!(chrono::Utc::now().to_rfc3339());
        packet.clone()
    };
    let accepted = Assignment::decode(
        &good(&mut base.clone()),
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now(),
    )
    .expect("the exact revoke frame preserves original Grant v1 and its current v2 snapshot");
    assert_eq!(accepted.grant.version, 2);
    assert!(accepted.grant.revoked_at.is_some());
    assert_eq!(accepted.grant_version, 1);
    assert_eq!(accepted.kind, "edit_file");
    for (label, mutation) in [
        (
            "wrong execution purpose",
            (|packet: &mut Value| {
                packet["purpose"] = json!("execute");
            }) as fn(&mut Value),
        ),
        ("not the original creation version", |packet: &mut Value| {
            packet["grant"]["version"] = json!(3);
        }),
        ("wrong immutable digest", |packet: &mut Value| {
            packet["grant"]["digest"] = json!("0".repeat(64));
        }),
        ("wrong original top-level version", |packet: &mut Value| {
            packet["grant_version"] = json!(2);
        }),
        ("no current revocation fact", |packet: &mut Value| {
            packet["grant"]["revoked_at"] = Value::Null;
        }),
        ("read-only Grant cannot write", |packet: &mut Value| {
            packet["grant"]["operations"] = json!(["read"]);
        }),
        ("unsupported kind", |packet: &mut Value| {
            packet["kind"] = json!("read_summary");
        }),
        ("wrong working state", |packet: &mut Value| {
            packet["status"] = json!("running");
        }),
        (
            "explicit cancellation intent is not revocation",
            |packet: &mut Value| {
                packet["cancel_requested"] = json!(true);
            },
        ),
        ("reported authority mismatch", |packet: &mut Value| {
            packet["grant_status"] = json!(true);
        }),
    ] {
        let mut altered = good(&mut base.clone());
        mutation(&mut altered);
        let rejected = Assignment::decode(
            &altered,
            &"a".repeat(64),
            "installation-one",
            &project,
            chrono::Utc::now(),
        );
        assert!(
            rejected.is_err(),
            "{label}: v2/current Grant claims must not become a fresh execute permission"
        );
    }
    let mut ordinary = base;
    ordinary["grant_status"] = json!(false);
    assert!(
        Assignment::decode(
            &ordinary,
            &"a".repeat(64),
            "installation-one",
            &project,
            chrono::Utc::now(),
        )
        .is_err(),
        "an active execute Grant must still explicitly be marked active"
    );
}

#[test]
fn digest_reject_project_binding_and_grant_mismatches() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let raw = input(&project);
    for (label, change) in [
        (
            "node",
            Box::new(|v: &mut Value| v["node_id"] = json!("b".repeat(64)))
                as Box<dyn FnOnce(&mut Value)>,
        ),
        (
            "installation",
            Box::new(|v: &mut Value| v["installation_id"] = json!("wrong")),
        ),
        (
            "worker",
            Box::new(|v: &mut Value| v["worker_id"] = json!("other")),
        ),
        (
            "revoked",
            Box::new(|v: &mut Value| v["grant"]["revoked_at"] = json!(chrono::Utc::now())),
        ),
        (
            "scope",
            Box::new(|v: &mut Value| v["grant"]["operations"] = json!(["write"])),
        ),
        (
            "binding",
            Box::new(|v: &mut Value| v["resource"]["root_scope"] = json!("/another/root")),
        ),
        (
            "lease",
            Box::new(|v: &mut Value| v["lease_expires_at"] = json!("2000-01-01T00:00:00Z")),
        ),
    ] {
        let mut bad = raw.clone();
        change(&mut bad);
        assert!(
            Assignment::decode(
                &bad,
                &"a".repeat(64),
                "installation-one",
                &project,
                chrono::Utc::now()
            )
            .is_err(),
            "{label}"
        );
    }
    assert!(Assignment::decode(
        &raw,
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now()
    )
    .is_ok());
}

#[test]
fn relative_traversal_and_symlinks_fail_closed() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let mut raw = input(&project);
    raw["relative_path"] = json!("../README.md");
    let error = Assignment::decode(
        &raw,
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now(),
    );
    assert!(error.is_err());
}

#[test]
fn bare_rejects_unvalidated_artifact_input_before_any_effect() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |raw| {
        raw["artifact_input"] = json!({"artifact_ref":{"type":"artifact_ref","artifact_id":"not-a-uuid"},"bytes_base64":"unverified"});
    });
    let error = executor::execute(
        &assignment,
        tmp.path().join("artifacts").as_path(),
        &mut state,
    )
    .unwrap_err();
    assert!(error.to_string().contains("unvalidated ArtifactInput"));
    assert!(std::fs::read_dir(tmp.path().join("artifacts"))
        .unwrap()
        .next()
        .is_none());
}

#[cfg(unix)]
#[test]
fn executor_rejects_a_symlink_target_without_creating_an_artifact() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |_| {});
    std::fs::remove_file(assignment.binding_root.join("README.md")).unwrap();
    std::os::unix::fs::symlink(
        tmp.path().join("state"),
        assignment.binding_root.join("README.md"),
    )
    .unwrap();
    // File access errors are retained as unknown reconciliation evidence, not success.
    let outcome = executor::execute(
        &assignment,
        tmp.path().join("artifacts").as_path(),
        &mut state,
    )
    .unwrap();
    assert_eq!(outcome["state"], "unknown");
    assert!(std::fs::read_dir(tmp.path().join("artifacts"))
        .unwrap()
        .all(|entry| !entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "bin")));
}

#[test]
fn source_hash_is_from_original_bytes_before_lossy_utf8_decoding() {
    for raw in [b"Alpha\nfixed fact\n".as_slice(), &[0xff, b'a', 0xfe, b'b']] {
        let tmp = tempfile::tempdir().unwrap();
        let (assignment, mut state) = executable(&tmp, |_| {});
        std::fs::write(assignment.binding_root.join("README.md"), raw).unwrap();
        executor::execute(&assignment, &tmp.path().join("artifacts"), &mut state).unwrap();
        let bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            state.data.outbox[0].body["bytes_base64"].as_str().unwrap(),
        )
        .unwrap();
        let summary: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            summary["input_sha256"],
            format!("{:x}", Sha256::digest(raw))
        );
        assert_ne!(
            summary["input_sha256"],
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert_eq!(summary["byte_length"], raw.len());
    }
}

#[test]
fn read_summary_and_edit_emit_uuid_artifact_and_exact_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |_| {});
    let artifacts = tmp.path().join("artifacts");
    let outcome = executor::execute(&assignment, &artifacts, &mut state).unwrap();
    assert_eq!(outcome["state"], "succeeded");
    assert_eq!(state.data.outbox.len(), 2);
    let upload = &state.data.outbox[0].body;
    assert_eq!(state.data.outbox[0].kind, "artifact");
    assert_eq!(state.data.outbox[1].kind, "report");
    assert_eq!(upload["lease_id"], "lease_1");
    assert_eq!(upload["grant_digest"], assignment.grant_digest);
    let artifact_id: uuid::Uuid = serde_json::from_value(upload["artifact_id"].clone()).unwrap();
    let artifact_id = artifact_id.to_string();
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let base = STANDARD
        .decode(upload["bytes_base64"].as_str().unwrap())
        .unwrap();
    assert_eq!(
        base,
        std::fs::read(artifacts.join(format!("{artifact_id}.bin"))).unwrap()
    );
    assert_eq!(
        upload["metadata"]["sha256"],
        format!("{:x}", Sha256::digest(&base))
    );
    let summary: Value = serde_json::from_slice(&base).unwrap();
    assert_eq!(summary["path"], "README.md");
    assert_eq!(summary["lines"][0], "Alpha");
    let source = std::fs::read(assignment.binding_root.join("README.md")).unwrap();
    assert_eq!(
        summary["input_sha256"],
        format!("{:x}", Sha256::digest(&source))
    );
    assert_ne!(summary["input_sha256"], upload["metadata"]["sha256"]);
    assert_eq!(summary["byte_length"], source.len());
    let report = &state.data.outbox[1].body;
    assert_eq!(report["requested_state"], "succeeded");
    assert_eq!(report["worker_id"], "default");
    assert_eq!(report["attempt"], 1);
    assert!(report["report_id"].is_string());
    // Persisted delivery can repeat exactly the same request/effect/artifact IDs.
    let first_request = state.data.outbox[0].body["request_id"].clone();
    assert!(!state.enqueue("artifact", upload.clone()).unwrap());
    assert_eq!(state.data.outbox[0].body["request_id"], first_request);
}

#[test]
fn edit_is_atomic_and_no_project_terminal_is_possible_by_scheme() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |v| {
        v["kind"] = json!("edit_file");
        v["content"] = json!("fixed replacement");
        v["relative_path"] = json!("nested/out.txt");
    });
    let outcome = executor::execute(
        &assignment,
        tmp.path().join("artifacts").as_path(),
        &mut state,
    )
    .unwrap();
    assert_eq!(outcome["state"], "succeeded");
    assert_eq!(
        std::fs::read_to_string(assignment.binding_root.join("nested/out.txt")).unwrap(),
        "fixed replacement"
    );
    let artifact = std::fs::read_dir(tmp.path().join("artifacts"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|p| p.extension().is_some_and(|x| x == "bin"))
        .unwrap();
    let result: Value = serde_json::from_slice(&std::fs::read(artifact).unwrap()).unwrap();
    assert_eq!(result["operation"], "replaced_project_file");
    assert_eq!(result["path"], "nested/out.txt");
}

#[test]
fn restart_running_completion_turns_unknown_and_does_not_reexecute() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |_| {});
    state.start(&assignment).unwrap();
    drop(state);
    let reopened = StateStore::open(&tmp.path().join("state")).unwrap();
    assert_eq!(reopened.data.completions["asg_abc"]["state"], "unknown");
    assert_eq!(
        reopened.data.completions["asg_abc"]["recovered_from_restart"],
        true
    );
    assert!(reopened.data.active_assignment_id.is_none());
}

#[test]
fn transport_cancellation_race_is_reconciliation_not_success_or_reexecution() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |_| {});
    executor::execute(&assignment, &tmp.path().join("artifacts"), &mut state).unwrap();
    let request = state.data.outbox[1].body["request_id"].clone();
    assert!(state.record_cancellation_race(&assignment.id).unwrap());
    assert_eq!(
        state.data.completions[assignment.id.as_str()]["state"],
        "unknown"
    );
    let report = state
        .data
        .outbox
        .iter()
        .find(|item| item.kind == "report")
        .unwrap();
    assert_eq!(report.body["request_id"], request);
    assert_eq!(report.body["requested_state"], "unknown");
    assert_eq!(report.body["artifact_ids"], json!([]));
    assert_eq!(report.body["effects"][0]["status"], "unknown");
    assert_eq!(report.body["effects"][0]["artifacts"], json!([]));
    assert_eq!(report.body["cancel_acknowledged"], false);
    assert!(!state.record_cancellation_race(&assignment.id).unwrap());
}

#[test]
fn observed_abort_before_read_is_unknown_not_success_or_cancel_acknowledgement() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |_| {});
    let signal = std::sync::atomic::AtomicBool::new(true);
    let outcome = executor::execute_cancellable(
        &assignment,
        &tmp.path().join("artifacts"),
        &mut state,
        &signal,
    )
    .unwrap();
    assert_eq!(outcome["state"], "unknown");
    assert_eq!(outcome["cancel_acknowledged"], false);
    assert_eq!(
        state.data.outbox.last().unwrap().body["effects"][0]["status"],
        "unknown"
    );
    assert!(state.data.outbox.iter().all(|item| item.kind != "artifact"));
}

#[test]
fn observed_abort_before_replace_preserves_existing_file() {
    let tmp = tempfile::tempdir().unwrap();
    let (assignment, mut state) = executable(&tmp, |v| {
        v["kind"] = json!("edit_file");
        v["content"] = json!("must not be written");
    });
    let target = assignment.binding_root.join("README.md");
    let original = std::fs::read(&target).unwrap();
    let signal = std::sync::atomic::AtomicBool::new(true);
    let outcome = executor::execute_cancellable(
        &assignment,
        &tmp.path().join("artifacts"),
        &mut state,
        &signal,
    )
    .unwrap();
    assert_eq!(outcome["state"], "unknown");
    assert_eq!(std::fs::read(&target).unwrap(), original);
    assert!(!target.parent().unwrap().read_dir().unwrap().any(|p| p
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".loom-node-")));
}

#[test]
fn signed_binding_files_reject_tampering_and_wrong_identity() {
    let tmp = tempfile::tempdir().unwrap();
    let state =
        loom_node::binding::prepare_owned_directory(&tmp.path().join("state"), "test state")
            .unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let identity = Identity::open(&state).unwrap();
    let path = loom_node::binding::write_signed_binding(
        &state,
        &identity,
        &[format!("logical={}", project.display())],
    )
    .unwrap();
    let loaded = Bindings::load_as(
        &[],
        Some(&path),
        Some((
            &identity.node_id,
            &identity.installation_id,
            identity.public_key(),
        )),
    )
    .unwrap();
    assert_eq!(
        loaded.require("logical").unwrap(),
        project.canonicalize().unwrap()
    );
    let mut tampered: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let root = tampered["bindings"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    tampered["bindings"][root] = json!("other_project");
    loom_node::storage::atomic_json(&path, &tampered).unwrap();
    assert!(Bindings::load_as(
        &[],
        Some(&path),
        Some((
            &identity.node_id,
            &identity.installation_id,
            identity.public_key()
        ))
    )
    .is_err());
    assert!(Bindings::load_as(
        &[],
        Some(&path),
        Some((
            "f".repeat(64).as_str(),
            "wrong-installation",
            identity.public_key()
        ))
    )
    .is_err());
}

#[test]
fn only_exact_controller_mapping_executes_and_project_has_no_cwd_default() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("real");
    std::fs::create_dir(&project).unwrap();
    let other = tmp.path().join("other");
    std::fs::create_dir(&other).unwrap();
    let bindings = Bindings::load(&[format!("logical={}", project.display())], None).unwrap();
    assert_eq!(
        bindings.require("logical").unwrap(),
        project.canonicalize().unwrap()
    );
    assert!(bindings.require("unknown").is_err());
    let state = tmp.path().join("state");
    let artifacts = tmp.path().join("artifacts");
    let options = NodeOptions {
        coordinator: "http://127.0.0.1:1".into(),
        state_dir: state,
        artifact_dir: artifacts,
        bindings,
        wait_seconds: 1,
        enrollment_code: None,
    };
    if let Err(error) = LocalNodeRunner::open(options) {
        panic!("runner open failed: {error:#}");
    }
}

#[test]
fn model_descriptor_only_admits_exact_metadata_file_and_no_injected_content() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let mut raw = input(&project);
    raw["kind"] = json!("model_descriptor");
    raw["relative_path"] = json!("model.json");
    let decoded = Assignment::decode(
        &raw,
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now(),
    )
    .unwrap();
    assert_eq!(decoded.kind, "model_descriptor");
    assert_eq!(decoded.content, None);
    for invalid in [
        json!("other.json"),
        json!("nested/model.json"),
        json!("/model.json"),
    ] {
        raw["relative_path"] = invalid;
        assert!(Assignment::decode(
            &raw,
            &"a".repeat(64),
            "installation-one",
            &project,
            chrono::Utc::now()
        )
        .is_err());
    }
    raw["relative_path"] = json!("model.json");
    raw["content"] = json!("not a source override");
    assert!(Assignment::decode(
        &raw,
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now()
    )
    .is_err());
    raw["content"] = Value::Null;
    raw["grant"]["operations"] = json!(["invoke_text"]);
    assert!(Assignment::decode(
        &raw,
        &"a".repeat(64),
        "installation-one",
        &project,
        chrono::Utc::now()
    )
    .is_err());
}

#[test]
fn cancelled_assignment_does_not_execute_file_effect() {
    let tmp = tempfile::tempdir().unwrap();
    let (mut assignment, mut state) = executable(&tmp, |v| {
        v["kind"] = json!("edit_file");
        v["content"] = json!("must not appear");
        v["relative_path"] = json!("cancelled.txt");
    });
    assignment.cancel_requested = true;
    let result = executor::cancel_before_effect(&assignment, &mut state).unwrap();
    assert_eq!(result["state"], "cancelled");
    assert_eq!(result["cancel_acknowledged"], true);
    assert!(!assignment.binding_root.join("cancelled.txt").exists());
    assert_eq!(
        state.data.outbox.last().unwrap().body["requested_state"],
        "cancelled"
    );
}
