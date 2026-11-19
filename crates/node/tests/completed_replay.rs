use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use loom_node::identity::Identity;
use loom_node::state::StateStore;
use loom_node::storage::atomic_json;
use loom_node::wire::{digest_json, Assignment};
use loom_node::{Bindings, LocalNodeRunner, NodeOptions, TickStatus};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

const TOKEN: &str = "owned-loopback-native-replay-token";
const ASSIGNMENT: &str = "asg_native_replay";

#[derive(Clone)]
struct Call {
    path: String,
    body: Value,
}

#[derive(Clone)]
struct TransportState {
    packet: Arc<Mutex<Value>>,
    calls: Arc<Mutex<Vec<Call>>>,
    delivery_attempts: Arc<AtomicUsize>,
    acknowledgement: Arc<Mutex<Option<Value>>>,
    artifact_receipt: Arc<Mutex<Option<Value>>>,
    report_receipt: Arc<Mutex<Option<Value>>>,
}

struct Transport {
    _job: JoinHandle<()>,
}

impl Drop for Transport {
    fn drop(&mut self) {
        self._job.abort();
    }
}

impl TransportState {
    async fn serve(original: &Value) -> (Self, String, JoinHandle<()>) {
        let state = Self {
            packet: Arc::new(Mutex::new(original.clone())),
            calls: Arc::new(Mutex::new(Vec::new())),
            delivery_attempts: Arc::new(AtomicUsize::new(0)),
            acknowledgement: Arc::new(Mutex::new(None)),
            artifact_receipt: Arc::new(Mutex::new(None)),
            report_receipt: Arc::new(Mutex::new(None)),
        };
        let app = Router::new()
            .fallback(post(answer))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let job = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (state, url, job)
    }

    fn calls(&self, suffix: &str) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.path.ends_with(suffix))
            .map(|call| call.body.clone())
            .collect()
    }
}

async fn answer(
    State(state): State<TransportState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> impl IntoResponse {
    let path = uri.path().to_owned();
    state.calls.lock().unwrap().push(Call {
        path: path.clone(),
        body: body.clone(),
    });
    if headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        != Some(&format!("Bearer {TOKEN}"))
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":{"code":"owned_fixture_auth"}})),
        );
    }
    if path.ends_with("/heartbeat") {
        return (StatusCode::OK, Json(json!({"accepted":true})));
    }
    if path.ends_with("/assignments/poll") {
        return (
            StatusCode::OK,
            Json(json!({"assignment":state.packet.lock().unwrap().clone()})),
        );
    }
    if path.ends_with("/artifacts") {
        if state.delivery_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    json!({"error":{"code":"owned_pending_fixture","message":"retain the first delivery in local outbox"}}),
                ),
            );
        }
        let receipt = state
            .artifact_receipt
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| json!({"artifact_id":body["artifact_id"],"duplicate":true}));
        return (StatusCode::OK, Json(receipt));
    }
    if path.ends_with("/reports") {
        if state.delivery_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    json!({"error":{"code":"owned_pending_fixture","message":"retain the first delivery in local outbox"}}),
                ),
            );
        }
        let receipt = state
            .report_receipt
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| json!({"accepted":true,"duplicate":true}));
        return (StatusCode::OK, Json(receipt));
    }
    if path.ends_with("/acknowledge") {
        let acknowledgement = state
            .acknowledgement
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(
                || json!({"accepted":true,"acknowledged_at":chrono::Utc::now(),"duplicate":false}),
            );
        return (StatusCode::OK, Json(acknowledgement));
    }
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error":{"code":"unexpected_owned_fixture_route","message":path}})),
    )
}

struct Fixture {
    _owned: tempfile::TempDir,
    project: PathBuf,
    state: PathBuf,
    artifacts: PathBuf,
    original: Value,
    coordinator: String,
    _transport: Transport,
    server: TransportState,
}

fn role_packet(identity: &Identity, project: &Path, cancelled: bool) -> Value {
    let operations = json!(["read", "write"]);
    let binding = json!({"project_id":"project_alpha","node_id":identity.node_id,
        "installation_id":identity.installation_id,"worker_id":"default","root_scope":project});
    let binding_digest = digest_json(&binding);
    let grant = json!({"id":"grant_native_replay","project_id":"project_alpha",
        "node_id":identity.node_id,"installation_id":identity.installation_id,
        "worker_id":"default","binding":binding_digest,"operations":operations,"version":1});
    let grant_digest = digest_json(&grant);
    let kind = if cancelled {
        "edit_file"
    } else {
        "read_summary"
    };
    json!({"id":ASSIGNMENT,"assignment_id":ASSIGNMENT,"ticket_id":"tkt_native_replay",
        "project_id":"project_alpha","node_id":identity.node_id,"installation_id":identity.installation_id,
        "worker_id":"default","attempt":1,"lease_id":"lease_native_replay","lease_epoch":1,
        "lease_expires_at":(chrono::Utc::now()+chrono::Duration::seconds(30)).to_rfc3339(),
        "grant_digest":grant_digest,"grant_version":1,"kind":kind,"relative_path":"README.md",
        "content":if cancelled {json!("must never be written")} else {Value::Null},
        "cancel_requested":cancelled,"status":if cancelled {"cancel_requested"} else {"running"},
        "protocol":"loom.node.v1","grant_status":true,
        "grant":{"id":"grant_native_replay","project_id":"project_alpha","node_id":identity.node_id,
            "installation_id":identity.installation_id,"worker_id":"default","operations":operations,
            "version":1,"digest":grant_digest,"project_binding_id":"binding_native_replay",
            "created_at":chrono::Utc::now().to_rfc3339(),"revoked_at":null,"project_root":project},
        "resource":binding})
}

impl Fixture {
    async fn new(cancelled: bool) -> Self {
        let owned = tempfile::tempdir().unwrap();
        let project = owned.path().join("project");
        let state = owned.path().join("state");
        let artifacts = owned.path().join("artifacts");
        #[cfg(unix)]
        for path in [&project, &state, &artifacts] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::create_dir(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        #[cfg(not(unix))]
        for path in [&project, &state, &artifacts] {
            std::fs::create_dir(path).unwrap();
        }
        std::fs::write(
            project.join("README.md"),
            "native replay project\noriginal fixture bytes\n",
        )
        .unwrap();
        let project = std::fs::canonicalize(project).unwrap();
        let state = std::fs::canonicalize(state).unwrap();
        let artifacts = std::fs::canonicalize(artifacts).unwrap();
        let identity = Identity::open(&state).unwrap();
        let identity_path = state.join("identity.json");
        let mut stored: Value =
            serde_json::from_slice(&std::fs::read(&identity_path).unwrap()).unwrap();
        stored["token"] = json!(TOKEN);
        atomic_json(&identity_path, &stored).unwrap();
        let original = role_packet(&identity, &project, cancelled);
        assert!(Bindings::load_as(
            &[format!("project_alpha={}", project.display())],
            None,
            Some((
                identity.node_id.as_str(),
                identity.installation_id.as_str(),
                identity.public_key(),
            )),
        )
        .is_ok());
        assert!(Assignment::decode(
            &original,
            &identity.node_id,
            &identity.installation_id,
            &project,
            chrono::Utc::now()
        )
        .is_ok());
        let (server, coordinator, job) = TransportState::serve(&original).await;
        Self {
            _owned: owned,
            project,
            state,
            artifacts,
            original,
            coordinator,
            _transport: Transport { _job: job },
            server,
        }
    }

    async fn try_runner(&self) -> anyhow::Result<LocalNodeRunner> {
        LocalNodeRunner::open(NodeOptions {
            coordinator: self.coordinator.clone(),
            state_dir: self.state.clone(),
            artifact_dir: self.artifacts.clone(),
            bindings: Bindings::load_as(
                &[format!("project_alpha={}", self.project.display())],
                None,
                None,
            )
            .unwrap(),
            wait_seconds: 1,
            enrollment_code: None,
        })
    }

    async fn runner(&self) -> LocalNodeRunner {
        self.try_runner().await.unwrap()
    }

    async fn tick(&self, packet: Value) -> anyhow::Result<TickStatus> {
        *self.server.packet.lock().unwrap() = packet;
        self.runner().await.once().await
    }

    fn history(&self) -> Value {
        let root: Value =
            serde_json::from_slice(&std::fs::read(self.state.join("node-state.json")).unwrap())
                .unwrap();
        json!({"assignment":root["assignments"][ASSIGNMENT],"completion":root["completions"][ASSIGNMENT],
            "outbox":root["outbox"],"last_assignment_id":root["last_assignment_id"],
            "active_assignment_id":root["active_assignment_id"]})
    }

    async fn preserve_pending_against(&self, altered: Value, description: &str) {
        let before = self.history();
        let before_calls = self.server.calls.lock().unwrap().len();
        let result = self.tick(altered).await;
        assert!(
            result.is_err(),
            "{description}: unverified packet must not play completed evidence"
        );
        assert_eq!(
            self.history(),
            before,
            "{description}: original history must not be overwritten"
        );
        let extra = &self.server.calls.lock().unwrap()[before_calls..];
        assert!(
            extra.iter().all(|call| call.path.ends_with("/heartbeat")
                || call.path.ends_with("/assignments/poll")),
            "{description}: no new ack/report/artifact or replacement cancellation evidence"
        );
        let effect_files = std::fs::read_dir(&self.artifacts)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".effect.json")
            })
            .count();
        assert_eq!(
            effect_files,
            usize::from(!self.original["cancel_requested"].as_bool().unwrap()),
            "{description}: no another real local effect"
        );
    }

    fn due_original_outbox(&self) {
        let mut state = StateStore::open(&self.state).unwrap();
        for item in &mut state.data.outbox {
            item.next_attempt_at = (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
        }
        state.flush().unwrap();
    }

    async fn exact_replay_retains_original_bodies(&self) {
        let original = StateStore::open(&self.state).unwrap().data.outbox.clone();
        self.due_original_outbox();
        assert!(matches!(
            self.tick(self.original.clone()).await.unwrap(),
            TickStatus::Deferred
        ));
        let kind = if self.original["cancel_requested"].as_bool().unwrap() {
            "reports"
        } else {
            "artifacts"
        };
        let attempts = self.server.calls(&format!("/{kind}"));
        assert_eq!(attempts.len(), 2);
        assert_eq!(
            attempts[0], original[0].body,
            "first HTTP attempt is the actual original body"
        );
        assert_eq!(
            attempts[1], original[0].body,
            "replay does not generate a replacement request/effect ID"
        );
        assert_eq!(StateStore::open(&self.state).unwrap().data.outbox.len(), 0);
        for entry in &original {
            let endpoint = match entry.kind.as_str() {
                "artifact" => "/artifacts",
                "report" => "/reports",
                other => panic!("unexpected fixture outbox kind {other}"),
            };
            assert!(
                self.server
                    .calls(endpoint)
                    .iter()
                    .any(|body| body == &entry.body),
                "each originally queued {} body reaches transport unchanged",
                entry.kind
            );
        }
    }
}

#[tokio::test]
async fn ordinary_admission_receipt_is_checked_before_delivery_and_retried_without_extra_effects() {
    for bad in [
        json!({"accepted":true}),
        json!({"accepted":true,"acknowledged_at":"not-an-rfc3339-time"}),
        json!({"accepted":false,"acknowledged_at":chrono::Utc::now()}),
    ] {
        let fixture = Fixture::new(false).await;
        *fixture.server.acknowledgement.lock().unwrap() = Some(bad.clone());
        assert!(matches!(
            fixture.tick(fixture.original.clone()).await.unwrap(),
            TickStatus::Deferred
        ));
        assert!(fixture.server.calls("/artifacts").is_empty());
        assert!(fixture.server.calls("/reports").is_empty());
        assert_eq!(
            StateStore::open(&fixture.state).unwrap().data.outbox.len(),
            2
        );
        let actual_effect_bytes = std::fs::read_dir(&fixture.artifacts)
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|value| value == "bin")
            })
            .count();
        assert_eq!(
            actual_effect_bytes, 1,
            "the local read happens only once before repeated bad receipts"
        );
        assert_eq!(fixture.server.calls("/acknowledge").len(), 1);
        let original = StateStore::open(&fixture.state)
            .unwrap()
            .data
            .outbox
            .clone();
        *fixture.server.acknowledgement.lock().unwrap() = None;
        for _ in 0..4 {
            if StateStore::open(&fixture.state)
                .unwrap()
                .data
                .outbox
                .is_empty()
            {
                break;
            }
            fixture.due_original_outbox();
            assert!(matches!(
                fixture.tick(fixture.original.clone()).await.unwrap(),
                TickStatus::Deferred
            ));
        }
        assert!(StateStore::open(&fixture.state)
            .unwrap()
            .data
            .outbox
            .is_empty());
        assert!(fixture.server.calls("/acknowledge").len() >= 2);
        for entry in &original {
            let endpoint = if entry.kind == "artifact" {
                "/artifacts"
            } else {
                "/reports"
            };
            assert!(fixture
                .server
                .calls(endpoint)
                .iter()
                .all(|body| body == &entry.body));
            assert!(!fixture.server.calls(endpoint).is_empty());
        }
        assert_eq!(std::fs::read_dir(&fixture.artifacts).unwrap().count(), 2);
        assert!(fixture
            .server
            .calls("/acknowledge")
            .iter()
            .all(|body| body["assignment_id"] == ASSIGNMENT));
    }
}

#[tokio::test]
async fn delivery_receipts_preserve_original_queue_without_artifact_id_or_unused_report_success() {
    for reject_report in [false, true] {
        let fixture = Fixture::new(false).await;
        fixture.server.delivery_attempts.store(1, Ordering::SeqCst);
        if reject_report {
            *fixture.server.report_receipt.lock().unwrap() = Some(json!({"accepted":false}));
        } else {
            *fixture.server.artifact_receipt.lock().unwrap() = Some(json!({
                "artifact_id":"00000000-0000-0000-0000-000000000000", "duplicate":true
            }));
        }
        let rejected = fixture.tick(fixture.original.clone()).await.unwrap();
        assert!(
            matches!(rejected, TickStatus::Rejected),
            "{rejected:?}: {:?}",
            StateStore::open(&fixture.state).unwrap().data.outbox
        );
        let retained = StateStore::open(&fixture.state)
            .unwrap()
            .data
            .outbox
            .clone();
        let original = retained.clone();
        if reject_report {
            assert_eq!(retained.len(), 1);
            assert_eq!(retained[0].kind, "report");
            assert_eq!(
                retained[0].next_attempt_at,
                "+999999999-12-31T23:59:59Z",
                "a rejected delivery keeps the serialized hold sentinel, not an ordinary retry time"
            );
        } else {
            assert_eq!(retained.len(), 2);
            assert_eq!(
                retained[0].next_attempt_at,
                "+999999999-12-31T23:59:59Z",
                "a rejected delivery keeps the serialized hold sentinel, not an ordinary retry time"
            );
            assert_eq!(retained[1].body, original[1].body);
        }
        assert_eq!(retained[0].body, original[0].body);
        assert!(fixture
            .server
            .calls("/acknowledge")
            .iter()
            .all(|body| body["assignment_id"] == ASSIGNMENT));

        if reject_report {
            *fixture.server.report_receipt.lock().unwrap() = None;
        } else {
            *fixture.server.artifact_receipt.lock().unwrap() = None;
        }
        fixture.due_original_outbox();
        assert!(matches!(
            fixture.tick(fixture.original.clone()).await.unwrap(),
            TickStatus::Deferred
        ));
        assert!(StateStore::open(&fixture.state)
            .unwrap()
            .data
            .outbox
            .is_empty());
        for entry in &original {
            let endpoint = if entry.kind == "artifact" {
                "/artifacts"
            } else {
                "/reports"
            };
            assert!(!fixture.server.calls(endpoint).is_empty());
            assert!(fixture
                .server
                .calls(endpoint)
                .iter()
                .all(|body| body == &entry.body));
        }
        assert_eq!(std::fs::read_dir(&fixture.artifacts).unwrap().count(), 2);
    }
}

#[tokio::test]
async fn failed_artifact_holds_only_its_own_report_not_an_independent_assignment() {
    let fixture = Fixture::new(false).await;
    fixture.server.delivery_attempts.store(1, Ordering::SeqCst);
    *fixture.server.artifact_receipt.lock().unwrap() = Some(json!({
        "artifact_id":"00000000-0000-0000-0000-000000000000", "duplicate":true
    }));
    assert!(matches!(
        fixture.tick(fixture.original.clone()).await.unwrap(),
        TickStatus::Rejected
    ));
    let failed_slice = StateStore::open(&fixture.state)
        .unwrap()
        .data
        .outbox
        .clone();
    assert_eq!(failed_slice.len(), 2);
    let mut independent = fixture.original.clone();
    independent["id"] = json!("asg_independent_replay");
    independent["assignment_id"] = json!("asg_independent_replay");
    independent["ticket_id"] = json!("tkt_independent_replay");
    independent["lease_id"] = json!("lease_independent_replay");
    assert!(loom_node::wire::Assignment::decode(
        &independent,
        fixture.original["node_id"].as_str().unwrap(),
        fixture.original["installation_id"].as_str().unwrap(),
        &fixture.project,
        chrono::Utc::now(),
    )
    .is_ok());
    *fixture.server.artifact_receipt.lock().unwrap() = None;
    assert!(matches!(
        fixture.tick(independent).await.unwrap(),
        TickStatus::Succeeded
    ));
    let remaining = StateStore::open(&fixture.state)
        .unwrap()
        .data
        .outbox
        .clone();
    assert_eq!(remaining.len(), 2);
    for (actual, original) in remaining.iter().zip(failed_slice.iter()) {
        assert_eq!(actual.body, original.body);
        assert_eq!(actual.body["assignment_id"], ASSIGNMENT);
        assert_eq!(actual.next_attempt_at, "+999999999-12-31T23:59:59Z");
    }
    for endpoint in ["/artifacts", "/reports"] {
        let received = fixture.server.calls(endpoint);
        assert_eq!(
            received
                .iter()
                .filter(|body| body["assignment_id"] == "asg_independent_replay")
                .count(),
            1,
            "the independent assignment has its own exact accepted {endpoint}"
        );
    }
    assert_eq!(std::fs::read_dir(&fixture.artifacts).unwrap().count(), 4,
        "the independent assignment reads and publishes once; the failed assignment is not reexecuted");
}

#[tokio::test]
async fn two_runners_sharing_a_node_state_directory_must_not_execute_the_same_assignment_twice() {
    let fixture = Fixture::new(false).await;
    fixture.server.delivery_attempts.store(1, Ordering::SeqCst);
    let mut first = fixture.try_runner().await.unwrap();
    let original_history = fixture.history();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::metadata(fixture.state.join("runner.lock"))
            .unwrap()
            .permissions();
        assert_eq!(permissions.mode() & 0o777, 0o600);
    }
    let refusal = fixture
        .try_runner()
        .await
        .err()
        .expect("the competing owner must be refused")
        .to_string();
    assert!(
        refusal.contains("already owns this node state directory"),
        "simultaneous ownership must fail: {refusal}"
    );
    assert_eq!(fixture.history(), original_history);
    assert!(fixture.server.calls("/artifacts").is_empty());
    assert!(matches!(first.once().await.unwrap(), TickStatus::Succeeded));
    let other = Fixture::new(false).await;
    other.server.delivery_attempts.store(1, Ordering::SeqCst);
    assert_ne!(other.state, fixture.state);
    let mut other_runner = other
        .try_runner()
        .await
        .expect("a separate owned directory must remain independently usable");
    assert!(matches!(
        other_runner.once().await.unwrap(),
        TickStatus::Succeeded
    ));
    let other_artifacts = std::fs::read_dir(&other.artifacts)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "bin")
        })
        .count();
    assert_eq!(
        other_artifacts, 1,
        "a distinct owned state directory still executes once while the first lock is held"
    );
    drop(other_runner);
    drop(first);
    assert!(matches!(
        fixture.tick(fixture.original.clone()).await.unwrap(),
        TickStatus::Deferred
    ));
    let artifact_files = std::fs::read_dir(&fixture.artifacts)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "bin")
        })
        .count();
    assert_eq!(artifact_files, 1);
    let after_reopen = std::fs::read_dir(&fixture.artifacts)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "bin")
        })
        .count();
    assert_eq!(
        after_reopen, 1,
        "released lock must allow evidence replay without another file effect"
    );
}

#[tokio::test]
async fn a_corrupt_identity_releases_the_owner_lock_without_silently_creating_a_new_identity() {
    let fixture = Fixture::new(false).await;
    let identity_path = fixture.state.join("identity.json");
    let original_bytes = std::fs::read(&identity_path).unwrap();
    let mut identity: Value = serde_json::from_slice(&original_bytes).unwrap();
    identity["public_key"] = json!("A".repeat(43));
    atomic_json(&identity_path, &identity).unwrap();
    let corrupt_bytes = std::fs::read(&identity_path).unwrap();
    for _ in 0..2 {
        let error = fixture
            .try_runner()
            .await
            .err()
            .expect("invalid identity must refuse to start")
            .to_string();
        assert!(
            error.contains("private and public node keys do not match"),
            "{error}"
        );
        assert!(
            !error.contains("already owns this node state directory"),
            "{error}"
        );
        let actual = std::fs::read(&identity_path).unwrap();
        assert_eq!(actual, corrupt_bytes);
    }
    atomic_json(
        &identity_path,
        &serde_json::from_slice::<Value>(&original_bytes).unwrap(),
    )
    .unwrap();
    let mut recovered = fixture
        .try_runner()
        .await
        .expect("identity repair must allow reacquiring after two failed starts");
    assert!(matches!(
        recovered.once().await.unwrap(),
        TickStatus::Succeeded
    ));
    let artifacts = std::fs::read_dir(&fixture.artifacts)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "bin")
        })
        .count();
    assert_eq!(
        artifacts, 1,
        "identity repair must allow only one genuine read and Artifact"
    );
    assert_eq!(std::fs::read(identity_path).unwrap(), original_bytes);
}

#[cfg(unix)]
#[tokio::test]
async fn a_preexisting_lock_link_must_not_redirect_or_alias_the_state_owner() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    for linked_kind in ["symlink", "hardlink"] {
        let fixture = Fixture::new(false).await;
        let external = fixture
            ._owned
            .path()
            .join(format!("external-{linked_kind}.txt"));
        std::fs::write(&external, b"untouched external bytes").unwrap();
        std::fs::set_permissions(&external, std::fs::Permissions::from_mode(0o644)).unwrap();
        let lock = fixture.state.join("runner.lock");
        if linked_kind == "symlink" {
            symlink(&external, &lock).unwrap();
        } else {
            std::fs::hard_link(&external, &lock).unwrap();
        }
        let result = fixture.try_runner().await;
        if let Err(error) = &result {
            assert!(
                error.to_string().contains("ordinary single-linked"),
                "{linked_kind}: {error}"
            );
        } else {
            let metadata = std::fs::metadata(&external).unwrap();
            panic!(
                "a preexisting {linked_kind} was accepted; external mode is {:o}, originally 644",
                metadata.mode() & 0o777
            );
        }
        let metadata = std::fs::metadata(&external).unwrap();
        assert_eq!(metadata.mode() & 0o777, 0o644);
        assert_eq!(
            std::fs::read(&external).unwrap(),
            b"untouched external bytes"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn non_file_lock_paths_are_rejected_without_blocking_or_changing_mode() {
    use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
    for object_kind in ["directory", "fifo"] {
        let fixture = Fixture::new(false).await;
        let path = fixture.state.join("runner.lock");
        if object_kind == "directory" {
            std::fs::create_dir(&path).unwrap();
        } else {
            let status = std::process::Command::new("/usr/bin/mkfifo")
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success(), "{status}");
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        let before = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(before.mode() & 0o777, 0o640);
        let before_state = std::fs::read(fixture.state.join("node-state.json")).ok();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), fixture.try_runner())
            .await
            .expect("a non-file lock path must not block");
        let error = result
            .err()
            .expect("{object_kind} must not become the owner lock");
        assert!(
            error.to_string().contains("ordinary single-linked"),
            "{object_kind}: {error}"
        );
        let after = std::fs::symlink_metadata(&path).unwrap();
        assert_eq!(after.mode() & 0o777, 0o640);
        assert_eq!(after.is_dir(), object_kind == "directory");
        assert_eq!(after.file_type().is_fifo(), object_kind == "fifo");
        assert_eq!(
            std::fs::read(fixture.state.join("node-state.json")).ok(),
            before_state
        );
        assert_eq!(fixture.server.calls("/register").len(), 0);
    }
}

#[tokio::test]
async fn native_completed_replay_checks_full_input_before_evidence_delivery() {
    let fixture = Fixture::new(false).await;
    assert!(matches!(
        fixture.tick(fixture.original.clone()).await.unwrap(),
        TickStatus::Succeeded
    ));
    assert_eq!(
        StateStore::open(&fixture.state).unwrap().data.outbox.len(),
        2
    );

    let mut changed_cancel_input = fixture.original.clone();
    changed_cancel_input["kind"] = json!("edit_file");
    changed_cancel_input["content"] = json!("a different input must not borrow prior evidence");
    changed_cancel_input["cancel_requested"] = json!(true);
    changed_cancel_input["status"] = json!("cancel_requested");
    fixture
        .preserve_pending_against(changed_cancel_input, "valid-but-different cancelled work")
        .await;

    let mut changed_epoch = fixture.original.clone();
    changed_epoch["lease_epoch"] = json!(2);
    changed_epoch["attempt"] = json!(2);
    fixture
        .preserve_pending_against(changed_epoch, "different lease/input digest")
        .await;

    let mut revoked = fixture.original.clone();
    revoked["grant"]["revoked_at"] = json!(chrono::Utc::now());
    fixture
        .preserve_pending_against(revoked, "revoked grant view")
        .await;

    let mut expired = fixture.original.clone();
    expired["lease_expires_at"] = json!("2000-01-01T00:00:00Z");
    fixture
        .preserve_pending_against(expired, "invalid lease")
        .await;

    let saved_digest =
        StateStore::open(&fixture.state).unwrap().data.completions[ASSIGNMENT]["digest"].clone();
    let mut absent_digest = StateStore::open(&fixture.state).unwrap();
    absent_digest.data.completions.get_mut(ASSIGNMENT).unwrap()["digest"] = Value::Null;
    absent_digest.flush().unwrap();
    fixture
        .preserve_pending_against(fixture.original.clone(), "missing original digest")
        .await;
    let mut repaired_test_fixture = StateStore::open(&fixture.state).unwrap();
    repaired_test_fixture
        .data
        .completions
        .get_mut(ASSIGNMENT)
        .unwrap()["digest"] = saved_digest;
    repaired_test_fixture.flush().unwrap();
    fixture.exact_replay_retains_original_bodies().await;
}

#[tokio::test]
async fn non_string_or_missing_outbox_schedule_never_becomes_an_immediate_due() {
    let fixture = Fixture::new(false).await;
    assert!(matches!(
        fixture.tick(fixture.original.clone()).await.unwrap(),
        TickStatus::Succeeded
    ));
    let path = fixture.state.join("node-state.json");
    let valid: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let artifact_attempts = fixture.server.calls("/artifacts").len();
    let report_attempts = fixture.server.calls("/reports").len();

    for invalid in [Some(Value::Null), Some(json!(17)), None] {
        let mut stored = valid.clone();
        if let Some(value) = invalid {
            stored["outbox"][0]["next_attempt_at"] = value;
        } else {
            assert!(stored["outbox"][0]
                .as_object_mut()
                .unwrap()
                .remove("next_attempt_at")
                .is_some());
        }
        atomic_json(&path, &stored).unwrap();
        let before = std::fs::read(&path).unwrap();
        let error = match StateStore::open(&fixture.state) {
            Ok(state) => panic!(
                "an invalid schedule must not become the immediate deadline {}",
                state.data.outbox[0].next_attempt_at
            ),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("outbox.next_attempt_at must be a persistent timestamp string"),
            "{error:#}"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "a rejected structural scheduling field must not be silently normalized on disk"
        );
        assert_eq!(
            fixture.server.calls("/artifacts").len(),
            artifact_attempts,
            "an unreadable queue cannot send an Artifact merely because its deadline is now"
        );
        assert_eq!(
            fixture.server.calls("/reports").len(),
            report_attempts,
            "an unreadable queue cannot send its Report either"
        );
        atomic_json(&path, &valid).unwrap();
    }
    assert_eq!(
        StateStore::open(&fixture.state).unwrap().data.outbox.len(),
        2,
        "the original valid pending evidence remains openable after each negative fixture"
    );
}

#[tokio::test]
async fn invalid_durable_outbox_schedule_is_not_delivered() {
    let fixture = Fixture::new(false).await;
    assert!(matches!(
        fixture.tick(fixture.original.clone()).await.unwrap(),
        TickStatus::Succeeded
    ));
    let mut state = StateStore::open(&fixture.state).unwrap();
    assert_eq!(state.data.outbox.len(), 2);
    for item in &mut state.data.outbox {
        // Reuse actual persisted pending evidence, not a fabricated completion.
        // A corrupt persisted clock must not cause an immediate unsafe send.
        item.next_attempt_at = "not-an-rfc3339-persisted-deadline".to_owned();
    }
    state.flush().unwrap();
    let before = fixture.history();
    let artifact_attempts = fixture.server.calls("/artifacts").len();
    let report_attempts = fixture.server.calls("/reports").len();
    let before_effects = std::fs::read_dir(&fixture.artifacts)
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".effect.json")
        })
        .count();
    let error = fixture.tick(Value::Null).await.expect_err(
        "a retained queue with an unparseable deadline cannot report that it was delivered",
    );
    assert!(
        error
            .to_string()
            .contains("invalid durable outbox schedule"),
        "{error:#}"
    );
    assert_eq!(
        fixture.history(),
        before,
        "retain the complete original queue and history, including its error evidence"
    );
    assert_eq!(fixture.server.calls("/artifacts").len(), artifact_attempts);
    assert_eq!(fixture.server.calls("/reports").len(), report_attempts);
    assert_eq!(
        std::fs::read_dir(&fixture.artifacts)
            .unwrap()
            .filter(|entry| entry
                .as_ref()
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".effect.json"))
            .count(),
        before_effects
    );
    let mut reopened = StateStore::open(&fixture.state).unwrap();
    for item in &mut reopened.data.outbox {
        item.next_attempt_at = (chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339();
    }
    reopened.flush().unwrap();
    let future = fixture.history();
    assert!(matches!(
        fixture.tick(Value::Null).await.unwrap(),
        TickStatus::Deferred
    ));
    assert_eq!(
        fixture.history(),
        future,
        "a valid not-yet-due queue stays pending unchanged"
    );
    assert_eq!(fixture.server.calls("/artifacts").len(), artifact_attempts);
    assert_eq!(fixture.server.calls("/reports").len(), report_attempts);
    let mut held = StateStore::open(&fixture.state).unwrap();
    for index in 0..held.data.outbox.len() {
        held.mark_delivery_error(index, "owned fixture permanent rejection", false)
            .unwrap();
    }
    held.flush().unwrap();
    assert!(held
        .data
        .outbox
        .iter()
        .all(|item| item.next_attempt_at == "+999999999-12-31T23:59:59Z"));
    let preserved_hold = fixture.history();
    assert!(
        matches!(
            fixture.tick(Value::Null).await.unwrap(),
            TickStatus::Deferred
        ),
        "an intentional permanent local hold must not be classified as corrupt or delivered"
    );
    assert_eq!(
        fixture.history(),
        preserved_hold,
        "the exact quarantine and its error evidence are untouched"
    );
    assert_eq!(fixture.server.calls("/artifacts").len(), artifact_attempts);
    assert_eq!(fixture.server.calls("/reports").len(), report_attempts);
}

#[tokio::test]
async fn native_cancel_completion_does_not_generate_a_second_cancel_report() {
    let fixture = Fixture::new(true).await;
    assert!(matches!(
        fixture.tick(fixture.original.clone()).await.unwrap(),
        TickStatus::Cancelled
    ));
    assert!(!fixture.project.join("README2").exists());
    let state = StateStore::open(&fixture.state).unwrap();
    assert_eq!(state.data.completions[ASSIGNMENT]["state"], "cancelled");
    assert_eq!(state.data.outbox.len(), 1);
    assert_eq!(state.data.outbox[0].kind, "report");
    drop(state);

    let mut changed = fixture.original.clone();
    changed["content"] = json!("different cancelled input");
    fixture
        .preserve_pending_against(changed, "different input after pre-start cancellation")
        .await;
    assert_eq!(
        std::fs::read_to_string(fixture.project.join("README.md")).unwrap(),
        "native replay project\noriginal fixture bytes\n"
    );
    fixture.exact_replay_retains_original_bodies().await;
}
