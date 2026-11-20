use crate::binding::{prepare_owned_directory, Bindings};
use crate::client::NodeClient;
use crate::executor;
use crate::identity::Identity;
use crate::state::StateStore;
use crate::wire::Assignment;
use anyhow::{bail, Context, Result};
use loom_protocol::NodeStatus;
use serde_json::{json, Value};

use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct NodeOptions {
    pub coordinator: String,
    pub state_dir: PathBuf,
    pub artifact_dir: PathBuf,
    pub bindings: Bindings,
    pub wait_seconds: u64,
    pub enrollment_code: Option<String>,
}

pub struct LocalNodeRunner {
    // The OS releases this advisory lock on drop, even when the owner crashes.
    // Opening the same owned state directory twice during this lifetime refuses.
    _state_lock: std::fs::File,
    options: NodeOptions,
    client: NodeClient,
    identity: Identity,
    state: StateStore,
    last_heartbeat: Instant,
}

#[derive(Clone, Debug)]
pub enum TickStatus {
    Idle,
    Enrolled,
    Delivered,
    Deferred,
    Rejected,
    Unknown,
    Succeeded,
    Cancelled,
}

impl LocalNodeRunner {
    fn acquire_state_lock(state_dir: &Path) -> Result<std::fs::File> {
        let path = state_dir.join("runner.lock");
        let original = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    bail!("state ownership lock must be an ordinary single-linked file, not a symlink or non-file");
                }
                Some(metadata)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("cannot inspect the Node ownership lock"),
        };
        #[cfg(unix)]
        if let Some(metadata) = &original {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                bail!(
                    "state ownership lock must be an ordinary single-linked file, not a hard link"
                );
            }
        }
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(&path)
            .context("cannot open the local Node ownership lock")?;
        let opened = lock.metadata()?;
        if opened.file_type().is_symlink() || !opened.is_file() {
            bail!("state ownership lock must remain an ordinary single-linked file");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if opened.nlink() != 1 {
                bail!("state ownership lock must have exactly one filesystem link");
            }
            if let Some(before) = &original {
                if before.ino() != opened.ino() || before.dev() != opened.dev() {
                    bail!("state ownership lock was replaced while opening");
                }
            }
            let current = std::fs::symlink_metadata(&path)?;
            if current.file_type().is_symlink()
                || !current.is_file()
                || current.nlink() != 1
                || current.ino() != opened.ino()
                || current.dev() != opened.dev()
            {
                bail!("state ownership lock path changed while opening");
            }
        }
        if path.canonicalize()? != path {
            bail!("state ownership lock path was redirected while opening");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            lock.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        }
        match lock.try_lock() {
            Ok(()) => Ok(lock),
            Err(std::fs::TryLockError::WouldBlock) => {
                bail!("another LocalNodeRunner already owns this node state directory")
            }
            Err(std::fs::TryLockError::Error(error)) => {
                Err(error).context("cannot acquire the local node state ownership lock")
            }
        }
    }

    pub fn open(options: NodeOptions) -> Result<Self> {
        if !(1..=15).contains(&options.wait_seconds) {
            bail!("poll wait must be within [1,15] seconds");
        }
        if options.bindings.is_empty() {
            bail!("at least one explicit project-root mapping is required; cwd is never used as a project");
        }
        let state_dir = prepare_owned_directory(&options.state_dir, "node state directory")?;
        let artifact_dir =
            prepare_owned_directory(&options.artifact_dir, "node artifact directory")?;
        options
            .bindings
            .validate_separated_from(&state_dir, &artifact_dir)?;
        let _state_lock = Self::acquire_state_lock(&state_dir)?;
        let identity = Identity::open(&state_dir)?;
        let state = StateStore::open(&state_dir)?;
        let client = NodeClient::new(&options.coordinator)?;
        Ok(Self {
            _state_lock,
            options,
            client,
            identity,
            state,
            last_heartbeat: Instant::now() - Duration::from_secs(60 * 60),
        })
    }

    pub fn node_id(&self) -> &str {
        &self.identity.node_id
    }
    pub fn installation_id(&self) -> &str {
        &self.identity.installation_id
    }
    pub fn public_state(&self) -> Value {
        let completions: Vec<Value> = self.state.data.completions.values().map(|completion| {
            json!({"assignment_id":completion["assignment_id"],"state":completion["state"],
                "artifact_ids":completion["artifacts"],"recovered_from_restart":completion["recovered_from_restart"],
                "report_enqueued":completion["report_enqueued"]})
        }).collect();
        json!({"node_id":self.identity.node_id,"installation_id":self.identity.installation_id,
            "last_assignment_id":self.state.data.last_assignment_id,"outbox":self.state.data.outbox.len(),
            "completions":completions,"active_assignment_id":self.state.data.active_assignment_id,
            "proof_actions":{"outbox_durable":true,"private_identity_files":true,"effects_written_before_outcome":true}})
    }
    pub fn state_directory(&self) -> &Path {
        &self.options.state_dir
    }

    pub async fn start(&mut self) -> Result<Value> {
        if self.options.enrollment_code.is_some() || self.identity.token().is_err() {
            let code = self
                .options
                .enrollment_code
                .as_deref()
                .context("no persistent token; supply LOOM_ENROLLMENT_CODE")?;
            self.client
                .enroll(&mut self.identity, code, self.options.bindings.inventory())
                .await?;
        }
        let response = self
            .client
            .heartbeat_with_roots(
                &self.identity,
                NodeStatus::Online,
                self.options.bindings.inventory(),
            )
            .await?;
        self.state.data.heartbeat_at = Some(chrono::Utc::now().to_rfc3339());
        self.state.flush()?;
        // Wait for the normal poll below before transporting completed evidence.
        // Bare execution precedes its ordinary ACK, so a local outbox alone does
        // not prove that Concierge has durably admitted this Assignment. The poll
        // revalidates the current Grant/root/epoch/logical digest; a completed
        // success then gets its original (or first) admission before dispatch.
        // Transport attempts without an admission remain queued for that closure.
        self.last_heartbeat = Instant::now();
        self.heartbeat_if_due().await?;
        Ok(
            json!({"node_id":self.node_id(),"installation_id":self.installation_id(),"heartbeat":response.get("accepted")}),
        )
    }

    pub async fn heartbeat(&mut self) -> Result<()> {
        self.client
            .heartbeat_with_roots(
                &self.identity,
                NodeStatus::Online,
                self.options.bindings.inventory(),
            )
            .await?;
        self.state.data.heartbeat_at = Some(chrono::Utc::now().to_rfc3339());
        self.last_heartbeat = Instant::now();
        self.state.flush()
    }

    async fn heartbeat_if_due(&mut self) -> Result<()> {
        if self.last_heartbeat.elapsed() >= Duration::from_secs(15) {
            self.heartbeat().await?;
        }
        Ok(())
    }

    pub async fn once(&mut self) -> Result<TickStatus> {
        self.heartbeat_if_due().await?;
        let polled = self
            .client
            .poll(
                &self.identity,
                self.state.data.last_assignment_id.as_deref(),
                self.options.wait_seconds,
            )
            .await?;
        let Some(raw) = polled.assignment else {
            return self.dispatch_outbox().await;
        };
        let raw_id = raw["id"]
            .as_str()
            .or_else(|| raw["assignment_id"].as_str())
            .unwrap_or_default();
        if raw_id.is_empty() {
            bail!("poll assignment id is missing");
        }
        // Decode cancellation and identity before trusting any other field. Cancel
        // reports never grant execution permission and never expose a configured root.
        let preliminary = PreliminaryAssignment::decode(&raw, &self.identity)?;
        let has_completion = self.state.data.completions.contains_key(&preliminary.id);
        // Before responding to cancellation, apply the same grant/binding/lease and
        // relative-path validation as execution. Intent alone is not an authorization.
        let root = match self.options.bindings.require(&preliminary.project_id) {
            Ok(root) => root,
            Err(error) if has_completion => {
                return Err(error.context(
                    "completed assignment cannot be replayed under an invalid assignment",
                ))
            }
            Err(error) => return self.reject_assignment(preliminary, raw, error, true).await,
        };
        let assignment = match Assignment::decode(
            &raw,
            &self.identity.node_id,
            &self.identity.installation_id,
            root,
            chrono::Utc::now(),
        ) {
            Ok(assignment) => assignment,
            Err(error) if has_completion => {
                return Err(error.context(
                    "completed assignment cannot be replayed under an invalid assignment",
                ))
            }
            Err(error) => return self.reject_assignment(preliminary, raw, error, true).await,
        };
        if has_completion {
            // State::start compares this fully decoded packet with the original
            // immutable assignment-digest. It returns the existing completion without
            // running another executor, so a validated replay emits only its originals.
            // If decoding/digests fail, preserve the completed history and original
            // outbox rather than overwriting it with a generated rejection.
            if let Some(previous) = self.state.start(&assignment)? {
                if previous["state"] == "running" {
                    bail!("running assignment requires reconciliation before evidence replay");
                }
                if raw["purpose"] == "reconcile" && assignment.grant.revoked_at.is_some() {
                    // An immutable revoked frame carries evidence only. The local
                    // completed operation must never be started or re-ACKed anew.
                    if !self.state.record_revocation_race(&assignment)? {
                        bail!(
                            "revoked local history has no uniquely matching evidence-only Report"
                        );
                    }
                    self.state.data.last_assignment_id = Some(assignment.id.clone());
                    self.state.flush()?;
                    return self.dispatch_outbox().await;
                }
                if previous["state"] == "succeeded" {
                    // An ordinary acknowledgement may have needed a retry after
                    // transport loss. The server checks this same current lease,
                    // Grant and input before returning the original admission.
                    // Do not execute the completed local operation a second time.
                    if !self.client.acknowledge(&self.identity, &assignment, true, "Replay a completed local assignment; retry only the ordinary admission receipt").await.is_ok() {
                        return Ok(TickStatus::Deferred);
                    }
                }
                self.state.data.last_assignment_id = Some(assignment.id.clone());
                self.state.flush()?;
                self.dispatch_outbox().await?;
                return Ok(TickStatus::Deferred);
            }
            bail!("completed assignment replay does not match the original assignment evidence");
        }
        let cancel_now = if raw["purpose"] == "reconcile" {
            false
        } else {
            assignment.cancel_requested
                || self
                    .client
                    .cancellation_for(&self.identity, &assignment.id, &assignment.ticket_id)
                    .await
                    .unwrap_or(false)
        };
        if cancel_now {
            let mut cancelled = assignment.clone();
            cancelled.cancel_requested = true;
            self.state
                .data
                .assignments
                .insert(cancelled.id.clone(), raw);
            self.state.flush()?;
            let outcome = executor::cancel_before_effect(&cancelled, &mut self.state)?;
            let cancellation_acknowledged = self
                .client
                .cancellation_observed(
                    &self.identity,
                    &cancelled,
                    "Validated cancellation intent; no local file effect started",
                )
                .await
                .is_ok();
            self.state.data.last_assignment_id = Some(assignment.id.clone());
            self.state.flush()?;
            self.dispatch_outbox().await?;
            return Ok(
                if cancellation_acknowledged && outcome["state"] == "cancelled" {
                    TickStatus::Cancelled
                } else {
                    TickStatus::Unknown
                },
            );
        }
        if raw["purpose"] == "reconcile" && !has_completion {
            if self
                .state
                .data
                .outbox
                .iter()
                .any(|item| item.body["assignment_id"] == preliminary.id)
            {
                bail!("revoked assignment has durable outbox but no completion to correlate; retain original evidence without another acknowledgement");
            }
            return self
                .reject_assignment(
                    preliminary,
                    raw,
                    anyhow::anyhow!(
                        "a revoked reconcile frame cannot start a first local execution"
                    ),
                    false,
                )
                .await;
        }
        if let Some(previous) = self.state.start(&assignment)? {
            self.state.data.last_assignment_id = Some(assignment.id.clone());
            self.state.flush()?;
            if previous["state"] == "running" {
                bail!("concurrent/repeated assignment is forbidden; prior execution has not been reconciled");
            }
            self.dispatch_outbox().await?;
            return Ok(TickStatus::Deferred);
        }
        let signal = Arc::new(AtomicBool::new(false));
        let cancellation_witness = signal.clone();
        let mut execution_assignment = assignment.clone();
        let executor_signal = signal.clone();
        let execution_artifacts = self.options.artifact_dir.clone();
        let mut execution_state = self.state.clone();
        let mut task = tokio::task::spawn_blocking(move || {
            let outcome = executor::execute_cancellable(
                &execution_assignment,
                &execution_artifacts,
                &mut execution_state,
                &executor_signal,
            );
            execution_assignment.cancel_requested =
                execution_assignment.cancel_requested || executor_signal.load(Ordering::Acquire);
            (execution_state, outcome, execution_assignment)
        });
        let (completion_state, outcome, assignment) = loop {
            tokio::select! {
                result = &mut task => {
                    let (state,result,assignment)=result.context("deterministic executor thread failed")?;
                    break (state,result,assignment);
                }
                observed = self.client.cancellation_for(&self.identity, &assignment.id, &assignment.ticket_id) => {
                    if observed.unwrap_or(false) { cancellation_witness.store(true, Ordering::Release); }
                }
            }
        };
        let observed_cancellation = assignment.cancel_requested;
        let final_assignment = assignment;
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => bail!("durable/executor failure retained locally: {error}"),
        };
        self.state = completion_state;
        let assignment = final_assignment;
        // One last exact-attempt observation may beat the normal transport even
        // when the deterministic filesystem operation finished in microseconds.
        let observed_cancellation = observed_cancellation
            || self
                .client
                .cancellation_for(&self.identity, &assignment.id, &assignment.ticket_id)
                .await
                .unwrap_or(false);
        if observed_cancellation {
            self.state.record_cancellation_race(&assignment.id)?;
        }
        let mut assignment = assignment;
        assignment.cancel_requested = observed_cancellation;
        // Acknowledge only after executor completion and its effect/report facts are
        // durable. Delivery itself remains asynchronous and idempotent.
        let accepted = outcome["state"] == "succeeded";
        let acknowledged = if observed_cancellation {
            self.client.cancellation_observed(&self.identity, &assignment, "Cancellation intent observed after executor was already admitted; effect outcome remains unknown").await.is_ok()
        } else {
            self.client
                .acknowledge(
                    &self.identity,
                    &assignment,
                    accepted,
                    "Executor ended; structured outcome assigned to durable outbox",
                )
                .await
                .is_ok()
        };
        if accepted && !acknowledged {
            // The local file exists and remains owned by this worker. Without a
            // valid, affirmative admission receipt with a timestamp, it is not
            // time to upload its artifact or mark the work successfully admitted.
            return Ok(TickStatus::Deferred);
        }
        self.state.data.last_assignment_id = Some(assignment.id.clone());
        self.state.flush()?;
        let delivery = self.dispatch_outbox().await?;
        Ok(if matches!(delivery, TickStatus::Rejected) {
            TickStatus::Rejected
        } else {
            match outcome["state"].as_str().unwrap_or("unknown") {
                "succeeded" if acknowledged => TickStatus::Succeeded,
                "succeeded" => TickStatus::Deferred,
                "cancelled" => TickStatus::Cancelled,
                _ => TickStatus::Unknown,
            }
        })
    }

    async fn reject_assignment(
        &mut self,
        preliminary: PreliminaryAssignment,
        raw: Value,
        error: anyhow::Error,
        send_rejection_acknowledgement: bool,
    ) -> Result<TickStatus> {
        let mut stub = crate::wire::scoped_envelope(&raw, &Uuid::new_v4().to_string())?;
        self.state
            .data
            .assignments
            .insert(preliminary.id.clone(), raw);
        self.state.flush()?;
        let mut report = stub.clone();
        for key in ["requested_state", "state", "status"] {
            report.insert(key.to_owned(), json!("unknown"));
        }
        report.insert("report_id".into(), json!(Uuid::new_v4()));
        report.insert("sequence".into(), json!(1));
        report.insert(
            "summary".into(),
            json!(format!(
                "Assignment failed closed during local authorization: {error}"
            )),
        );
        report.insert("created_at".into(), json!(chrono::Utc::now()));
        report.insert("artifacts".into(), json!([]));
        report.insert("artifact_ids".into(), json!([]));
        report.insert("effects".into(), json!([{"effect_id":Uuid::new_v4(),"input_digest":preliminary.logical_digest(),"status":"unknown","evidence":[{"kind":"assignment_rejected"}]}]));
        report.insert("cancel_acknowledged".into(), json!(false));
        self.state.enqueue("report", Value::Object(report))?;
        // A reconciliation refusal must not gain ordinary Admission before a
        // revocation arrives. Its unknown evidence can be recorded on that path
        // without a successful, rejected or cancellation-flavoured assignment ACK.
        if send_rejection_acknowledgement {
            let _ = self
                .client
                .acknowledge_envelope(
                    &mut stub,
                    &self.identity,
                    false,
                    &format!("Rejected locally: {error}"),
                )
                .await;
        }
        let completion = json!({"assignment_id":preliminary.id,"digest":preliminary.logical_digest(),"state":"unknown","summary":error.to_string(),"artifacts":[],"effects":[],"report_enqueued":true,"cancel_acknowledged":false});
        self.state.complete(&preliminary.id, completion)?;
        self.dispatch_outbox().await?;
        Ok(TickStatus::Rejected)
    }

    pub async fn dispatch_outbox(&mut self) -> Result<TickStatus> {
        if self.state.data.outbox.iter().any(|item| {
            item.next_attempt_at != crate::state::HOLD_SCHEDULE
                && chrono::DateTime::parse_from_rfc3339(&item.next_attempt_at).is_err()
        }) {
            bail!(
                "invalid durable outbox schedule: retain undelivered evidence for reconciliation"
            );
        }
        let mut pending = false;
        let mut permanently_rejected = false;
        loop {
            let now = chrono::Utc::now();
            let Some(index) = self.state.data.outbox.iter().position(|item| {
                chrono::DateTime::parse_from_rfc3339(&item.next_attempt_at)
                    .is_ok_and(|at| at.with_timezone(&chrono::Utc) <= now)
            }) else {
                break;
            };
            // Snapshot by value because a failure mutates the delivery bookkeeping.
            let item = self.state.data.outbox[index].clone();
            match self
                .client
                .deliver(&self.identity, &item.kind, &item.body)
                .await
            {
                Ok(_) => self.state.mark_delivered(index)?,
                Err(error) => {
                    let retryable = error
                        .downcast_ref::<crate::client::HttpError>()
                        .is_some_and(|error| error.retryable);
                    self.state
                        .mark_delivery_error(index, &error.to_string(), retryable)?;
                    if retryable {
                        pending = true;
                        break; // Reports depend on earlier artifact acceptance for this attempt.
                    }
                    // Permanent fencing/validation receipts need operator review,
                    // not infinite resend. Keep evidence locally and let unrelated
                    // assignments make progress instead of poisoning the whole host.
                    permanently_rejected = true;
                    // A failed artifact cannot let a report for the same assignment
                    // jump over its provenance and pretend it was also accepted.
                    // Independent assignments keep their own delivery path open.
                    self.state
                        .hold_dependent_reports(&item.body["assignment_id"])?;
                }
            }
        }
        if pending {
            Ok(TickStatus::Deferred)
        } else if permanently_rejected {
            Ok(TickStatus::Rejected)
        } else if !self.state.data.outbox.is_empty() {
            // A future or intentionally quarantined item is still undelivered,
            // even when no local attempt is currently due.
            Ok(TickStatus::Deferred)
        } else {
            Ok(TickStatus::Delivered)
        }
    }

    // Restart reconciliation helpers live in StateStore, with no second authority here.
}

#[derive(Clone, Debug)]
struct PreliminaryAssignment {
    id: String,
    project_id: String,
    lease_epoch: u64,
    grant_digest: String,
    kind: String,
    relative_path: String,
}
impl PreliminaryAssignment {
    fn decode(raw: &Value, identity: &Identity) -> Result<Self> {
        let id = raw["id"]
            .as_str()
            .or_else(|| raw["assignment_id"].as_str())
            .context("assignment id is required")?
            .to_owned();
        if raw["node_id"].as_str() != Some(&identity.node_id)
            || raw["installation_id"].as_str() != Some(&identity.installation_id)
        {
            bail!("assignment identity does not match authenticated local identity");
        }
        Ok(Self {
            id,
            project_id: required(raw, "project_id")?,
            lease_epoch: number(raw, "lease_epoch")?,
            grant_digest: required(raw, "grant_digest")?,
            kind: required(raw, "kind")?,
            relative_path: required(raw, "relative_path")?,
        })
    }
    fn logical_digest(&self) -> String {
        crate::wire::digest_json(
            &json!({"assignment_id":self.id,"lease_epoch":self.lease_epoch,"grant_digest":self.grant_digest,"kind":self.kind,"relative_path":self.relative_path}),
        )
    }
}

// Recovery UUIDs have a single specification in wire::restart_reconciliation_report.

fn required(raw: &Value, key: &str) -> Result<String> {
    crate::wire::required(raw, key).map(str::to_owned)
}
fn number(raw: &Value, key: &str) -> Result<u64> {
    raw[key]
        .as_u64()
        .with_context(|| format!("{key} must be an integer"))
}
