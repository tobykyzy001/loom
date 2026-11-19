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
    if path.ends_with("/artifacts") || path.ends_with("/reports") {
        // First attempt leaves the original, real bare outbox pending. Any next
        // delivery must still have exactly those original bodies/request IDs.
        if state.delivery_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    json!({"error":{"code":"owned_pending_fixture","message":"retain the first delivery in local outbox"}}),
                ),
            );
        }
        return (
            StatusCode::OK,
            Json(json!({"accepted":true,"duplicate":true})),
        );
    }
    if path.ends_with("/acknowledge") {
        return (
            StatusCode::OK,
            Json(json!({"accepted":true,"acknowledged_at":chrono::Utc::now(),"duplicate":false})),
        );
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

    async fn runner(&self) -> LocalNodeRunner {
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
        .unwrap()
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
