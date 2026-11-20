use crate::storage::{atomic_json, read_json};
use crate::wire::digest_json;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub(crate) const HOLD_SCHEDULE: &str = "+999999999-12-31T23:59:59Z";

#[derive(Clone, Debug)]
pub struct Persisted {
    pub version: u64,
    pub assignments: BTreeMap<String, Value>,
    pub completions: BTreeMap<String, Value>,
    pub outbox: Vec<OutboxItem>,
    pub deliveries: Vec<Value>,
    pub last_assignment_id: Option<String>,
    pub active_assignment_id: Option<String>,
    pub heartbeat_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct OutboxItem {
    pub kind: String,
    pub body: Value,
    pub digest: String,
    pub attempts: u64,
    pub next_attempt_at: String,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct StateStore {
    file: PathBuf,
    pub data: Persisted,
}

impl StateStore {
    pub fn open(state_dir: &Path) -> Result<Self> {
        let file = state_dir.join("node-state.json");
        let mut data = match read_json(&file)? {
            Some(value) => decode(value)?,
            None => Persisted::empty(),
        };
        let active = data.active_assignment_id.clone();
        if let Some(id) = active {
            if let Some(completion) = data.completions.get_mut(&id) {
                completion["state"] = json!("unknown");
                completion["report_enqueued"] = json!(false);
                completion["summary"] = json!("Node restarted while local execution outcome was unconfirmed; reconciliation is required.");
                completion["recovered_from_restart"] = json!(true);
            }
            data.active_assignment_id = None;
        }
        for completion in data.completions.values_mut() {
            if matches!(completion["state"].as_str(), Some("running" | "restarting")) {
                *completion = json!({"assignment_id":completion["assignment_id"],"digest":completion["digest"],"state":"unknown",
                    "summary":"Node restarted before execution outcome was confirmed; reconciliation is required.","recovered_from_restart":true,
                    "artifacts":completion["artifacts"],"effects":completion["effects"],"report_enqueued":false,"cancel_acknowledged":false});
            }
        }
        let mut store = Self { file, data };
        store.enqueue_restart_reports()?;
        store.flush()?;
        Ok(store)
    }

    fn enqueue_restart_reports(&mut self) -> Result<()> {
        let recovered: Vec<String> = self
            .data
            .completions
            .iter()
            .filter(|(_, completion)| {
                completion["recovered_from_restart"] == true
                    && completion["report_enqueued"] == false
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in recovered {
            let assignment = match self.data.assignments.get(&id) {
                Some(assignment) => assignment.clone(),
                None => continue,
            };
            self.enqueue(
                "report",
                crate::wire::restart_reconciliation_report(&assignment, &id)?,
            )?;
            if let Some(completion) = self.data.completions.get_mut(&id) {
                completion["report_enqueued"] = json!(true);
            }
        }
        Ok(())
    }

    pub fn flush(&self) -> Result<()> {
        atomic_json(&self.file, &encode(&self.data))
    }

    pub fn enqueue(&mut self, kind: &str, body: Value) -> Result<bool> {
        if !matches!(kind, "artifact" | "report") {
            bail!("unsupported durable outbox kind");
        }
        let digest = outbox_body_digest(&body);
        if self
            .data
            .outbox
            .iter()
            .any(|item| item.kind == kind && item.digest == digest)
            || self
                .data
                .deliveries
                .iter()
                .any(|item| item["kind"] == kind && item["digest"] == digest)
        {
            return Ok(false);
        }
        self.data.outbox.push(OutboxItem {
            kind: kind.to_owned(),
            body,
            digest,
            attempts: 0,
            next_attempt_at: chrono::Utc::now().to_rfc3339(),
            last_error: None,
        });
        self.flush()?;
        Ok(true)
    }

    pub fn mark_delivered(&mut self, index: usize) -> Result<()> {
        let item = self.data.outbox.remove(index);
        self.data.deliveries.push(json!({"kind":item.kind,"digest":item.digest,"request_id":item.body["request_id"],"delivered_at":chrono::Utc::now()}));
        if self.data.deliveries.len() > 500 {
            self.data
                .deliveries
                .drain(..self.data.deliveries.len() - 500);
        }
        self.flush()
    }

    pub fn hold_dependent_reports(&mut self, assignment_id: &Value) -> Result<()> {
        let mut changed = false;
        for item in &mut self.data.outbox {
            if item.kind == "report"
                && item.body["assignment_id"] == *assignment_id
                && item.next_attempt_at != HOLD_SCHEDULE
            {
                item.next_attempt_at = HOLD_SCHEDULE.to_owned();
                changed = true;
            }
        }
        if changed {
            self.flush()?;
        }
        Ok(())
    }

    pub fn mark_delivery_error(
        &mut self,
        index: usize,
        message: &str,
        retryable: bool,
    ) -> Result<()> {
        let item = self
            .data
            .outbox
            .get_mut(index)
            .context("outbox index no longer exists")?;
        item.attempts = item.attempts.saturating_add(1);
        item.last_error = Some(sanitize_error(message));
        item.next_attempt_at = if retryable {
            (chrono::Utc::now()
                + chrono::Duration::seconds(2_i64.pow(item.attempts.min(5) as u32).min(60)))
            .to_rfc3339()
        } else {
            HOLD_SCHEDULE.to_owned()
        };
        self.flush()
    }

    pub fn start(&mut self, assignment: &crate::wire::Assignment) -> Result<Option<Value>> {
        if let Some(previous) = self.data.assignments.get(&assignment.id) {
            let old_epoch = previous["lease_epoch"].as_u64().unwrap_or(0);
            let old_digest = previous["grant_digest"].as_str().unwrap_or_default();
            if assignment.lease_epoch < old_epoch || old_digest != assignment.grant_digest {
                bail!("assignment lease/grant moved backwards or changed");
            }
        }
        if let Some(previous) = self.data.completions.get(&assignment.id) {
            if previous["digest"] != assignment.logical_digest() {
                bail!("assignment id reused with different input");
            }
            return Ok(Some(previous.clone()));
        }
        if self.data.active_assignment_id.is_some() {
            bail!("local concurrency is limited to one active assignment");
        }
        let pending = json!({"assignment_id":assignment.id,"digest":assignment.logical_digest(),"state":"running",
            "summary":"Deterministic local operation is in progress.","artifacts":[],"effects":[],"report_enqueued":false,"cancel_acknowledged":false});
        self.data
            .assignments
            .insert(assignment.id.clone(), assignment.raw.clone());
        self.data.completions.insert(assignment.id.clone(), pending);
        self.data.active_assignment_id = Some(assignment.id.clone());
        self.data.last_assignment_id = Some(assignment.id.clone());
        self.flush()?;
        Ok(None)
    }

    pub fn complete(&mut self, id: &str, completion: Value) -> Result<()> {
        self.data.completions.insert(id.to_owned(), completion);
        self.data.active_assignment_id = None;
        self.flush()
    }

    /// A completed file effect can race cancellation before transport. Keep its
    /// immutable request identity, but remove any claim of confirmed delivery and
    /// quarantine the normal artifact upload. Local bytes remain in artifact storage.
    pub fn record_cancellation_race(&mut self, assignment_id: &str) -> Result<bool> {
        let mut changed = false;
        for item in &mut self.data.outbox {
            if item.kind != "report"
                || item.body["assignment_id"] != assignment_id
                || item.body["requested_state"] != "succeeded"
            {
                continue;
            }
            let artifact_evidence = item.body["artifacts"].clone();
            let original_effect = item.body["effects"].clone();
            if let Some(effects) = item.body["effects"].as_array_mut() {
                for effect in effects {
                    effect["status"] = json!("unknown");
                    effect["artifacts"] = json!([]);
                }
            }
            item.body["requested_state"] = json!("unknown");
            item.body["state"] = json!("unknown");
            item.body["status"] = json!("unknown");
            item.body["summary"] = json!("Cancellation raced the completed local effect before normal delivery; report is evidence for reconciliation, not confirmed success.");
            item.body["artifacts"] = json!([]);
            item.body["artifact_ids"] = json!([]);
            item.body["cancel_acknowledged"] = json!(false);
            item.body["evidence"] = json!([{"kind":"cancellation_race","local_artifacts":artifact_evidence,
                "original_effect_evidence":original_effect,"effect_file_remains_unconfirmed":true}]);
            item.digest = digest_json(&item.body);
            item.next_attempt_at = chrono::Utc::now().to_rfc3339();
            changed = true;
        }
        if let Some(completion) = self.data.completions.get_mut(assignment_id) {
            if completion["state"] == "succeeded" {
                completion["state"] = json!("unknown");
                completion["summary"] = json!("Local effect completed before cancellation was observed; delivery outcome is unknown pending reconciliation.");
                if let Some(effects) = completion["effects"].as_array_mut() {
                    for effect in effects {
                        effect["status"] = json!("unknown");
                        effect["artifacts"] = json!([]);
                    }
                }
                changed = true;
            }
        }
        if changed {
            for item in &mut self.data.outbox {
                if item.kind == "artifact" && item.body["assignment_id"] == assignment_id {
                    item.last_error = Some("Normal artifact transport was quarantined because cancellation raced the local effect; bytes and metadata are retained locally for reconciliation.".to_owned());
                    item.next_attempt_at = HOLD_SCHEDULE.to_owned();
                    changed = true;
                }
            }
            self.flush()?;
        }
        Ok(changed)
    }

    /// Revoked recovery is scoped evidence, not another execution permission.
    /// Before any mutation, tie this completion to exactly one original Report.
    /// Missing, duplicate or unrelated history is retained on disk and refused.
    pub fn record_revocation_race(&mut self, assignment: &crate::wire::Assignment) -> Result<bool> {
        let id = &assignment.id;
        if self
            .data
            .outbox
            .iter()
            .filter(|item| item.kind == "report" && item.body["assignment_id"] == id.as_str())
            .count()
            != 1
        {
            return Ok(false);
        }
        let completion = self.data.completions.get(id).cloned();
        let mut matched_unknown = false;
        let mut indices = Vec::new();
        for (index, item) in self.data.outbox.iter().enumerate() {
            if item.kind != "report"
                || !report_scope_matches(item, assignment)
                || item.digest != outbox_body_digest(&item.body)
            {
                continue;
            }
            let state = item.body["requested_state"].as_str();
            if state == Some("succeeded")
                && completion.as_ref().is_some_and(|c| {
                    report_relations_match(&item.body, c, assignment)
                        && c["assignment_id"] == assignment.id
                        && c["digest"] == assignment.logical_digest()
                        && c["state"] == "succeeded"
                })
            {
                indices.push(index);
            } else if state == Some("unknown")
                && completion
                    .as_ref()
                    .is_some_and(|c| converted_unknown_evidence_matches(&item.body, c, assignment))
            {
                // Only the traced conversion of the previously verified success
                // may retry. Unrelated unknown/restart history is not promoted by
                // this new revocation frame.
                matched_unknown = true;
            }
        }
        if matched_unknown {
            return self.quarantine_revoked_artifacts(assignment);
        }
        if indices.len() != 1 {
            return Ok(false);
        }
        let index = indices[0];
        let item = &mut self.data.outbox[index];
        let original_artifacts = item.body["artifacts"].clone();
        let original_effects = item.body["effects"].clone();
        for effect in item.body["effects"].as_array_mut().into_iter().flatten() {
            effect["status"] = json!("unknown");
            effect["artifacts"] = json!([]);
        }
        item.body["requested_state"] = json!("unknown");
        item.body["state"] = json!("unknown");
        item.body["status"] = json!("unknown");
        item.body["summary"] = json!("The Grant was revoked after the local edit completed. Original success cannot be promoted under the revoked Grant; retain its local effect evidence for reconciliation without another operation.");
        item.body["artifacts"] = json!([]);
        item.body["artifact_ids"] = json!([]);
        item.body["cancel_acknowledged"] = json!(false);
        item.body["evidence"] = json!([{
            "kind":"grant_revoked","assignment_id":id,"local_artifacts":original_artifacts,
            "original_effect_evidence":original_effects,
            "ordinary_delivery_blocked_by_revocation":true,"artifact_transport":"quarantined"
        }]);
        item.digest = outbox_body_digest(&item.body);
        item.next_attempt_at = chrono::Utc::now().to_rfc3339();
        if let Some(local) = self.data.completions.get_mut(id) {
            local["state"] = json!("unknown");
            local["summary"] = json!(
                "Local file effect preceded revocation. Ordinary admission cannot be promoted after that authority change; reconcile its evidence."
            );
            let effects = local["effects"].clone();
            for effect in local["effects"].as_array_mut().into_iter().flatten() {
                effect["status"] = json!("unknown");
                effect["artifacts"] = json!([]);
            }
            local["evidence"] = json!([{
                "kind":"grant_revoked","assignment_id":id,
                "original_effect_evidence":effects,"ordinary_artifact_transport":"quarantined"
            }]);
        }
        self.quarantine_revoked_artifacts(assignment)?;
        Ok(true)
    }

    fn quarantine_revoked_artifacts(
        &mut self,
        assignment: &crate::wire::Assignment,
    ) -> Result<bool> {
        let assignment_id = &assignment.id;
        for item in &mut self.data.outbox {
            if item.kind == "artifact" && item.body["assignment_id"] == assignment_id.as_str() {
                item.last_error = Some("Normal artifact delivery is quarantined because the Grant was revoked before ordinary admission; local bytes remain evidence.".to_owned());
                item.next_attempt_at = HOLD_SCHEDULE.to_owned();
            }
        }
        // Persist only after the whole history and all relations are verified.
        // The completed input is unchanged, while the revoked snapshot and
        // reconcile purpose remain recoverable in the same atomic state flush.
        self.data
            .assignments
            .insert(assignment_id.clone(), assignment.raw.clone());
        self.flush()?;
        Ok(true)
    }

    pub fn set_cancel_requested(&mut self, id: &str, value: bool) -> Result<()> {
        if let Some(assignment) = self.data.assignments.get_mut(id) {
            assignment["cancel_requested"] = json!(value);
        }
        self.flush()
    }
}

fn outbox_body_digest(body: &Value) -> String {
    let mut logical = body.clone();
    if let Some(object) = logical.as_object_mut() {
        object.insert("sent_at".into(), Value::Null);
    }
    digest_json(&logical)
}

fn uuid_is_valid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn report_scope_matches(item: &OutboxItem, assignment: &crate::wire::Assignment) -> bool {
    item.kind == "report"
        && item.body["protocol"] == "loom.node.v1"
        && item.body["ticket_id"] == assignment.ticket_id
        && item.body["assignment_id"] == assignment.id
        && item.body["node_id"] == assignment.node_id
        && item.body["installation_id"] == assignment.installation_id
        && item.body["worker_id"] == assignment.worker_id
        && item.body["grant_digest"] == assignment.grant_digest
        && item.body["lease_id"] == assignment.lease_id
        && item.body["lease_epoch"].as_u64() == Some(assignment.lease_epoch)
        && item.body["attempt"].as_u64() == Some(assignment.attempt)
        && ["request_id", "report_id"]
            .into_iter()
            .all(|name| item.body[name].as_str().is_some_and(uuid_is_valid))
}

fn converted_unknown_evidence_matches(
    report: &Value,
    completion: &Value,
    assignment: &crate::wire::Assignment,
) -> bool {
    // A transport retry may only reuse the evidence produced by the previously
    // validated success conversion. A generic/restart unknown is not proof that
    // this known success existed, and must stay locally unresolved instead.
    if completion["state"] != "unknown"
        || completion["assignment_id"] != assignment.id
        || completion["digest"] != assignment.logical_digest()
        || completion["evidence"][0]["kind"] != "grant_revoked"
        || report["requested_state"] != "unknown"
        || report["state"] != "unknown"
        || report["status"] != "unknown"
        || report["cancel_acknowledged"] != false
        || report["artifacts"] != json!([])
        || report["artifact_ids"] != json!([])
    {
        return false;
    }
    let conversion = &report["evidence"][0];
    if conversion["kind"] != "grant_revoked"
        || conversion["artifact_transport"] != "quarantined"
        || conversion["ordinary_delivery_blocked_by_revocation"] != true
        || conversion["original_effect_evidence"]
            != completion["evidence"][0]["original_effect_evidence"]
    {
        return false;
    }
    let operation_digest = digest_json(&json!({
        "assignment_id":assignment.id,"kind":assignment.kind,
        "relative_path":assignment.relative_path,"content":assignment.content
    }));
    let operation = operation_digest.as_str();
    let artifacts = completion["artifacts"].as_array();
    let original_artifacts = conversion["local_artifacts"].as_array();
    let old_effects = conversion["original_effect_evidence"].as_array();
    let new_effects = report["effects"].as_array();
    let local_effects = completion["effects"].as_array();
    let (
        Some(artifacts),
        Some(original_artifacts),
        Some(old_effects),
        Some(new_effects),
        Some(local_effects),
    ) = (
        artifacts,
        original_artifacts,
        old_effects,
        new_effects,
        local_effects,
    )
    else {
        return false;
    };
    if artifacts.len() != 1
        || original_artifacts.len() != 1
        || old_effects.len() != 1
        || new_effects.len() != 1
        || local_effects.len() != 1
        || artifacts[0].as_str() != original_artifacts[0]["artifact_id"].as_str()
        || !artifacts[0].as_str().is_some_and(uuid_is_valid)
        || original_artifacts[0]["origin_node_id"] != assignment.node_id
        || original_artifacts[0]["assignment_id"] != assignment.id
    {
        return false;
    }
    let old = &old_effects[0];
    let new = &new_effects[0];
    let local = &local_effects[0];
    let matched_fields = |effect: &Value| {
        effect["assignment_id"] == assignment.id
            && effect["ticket_id"] == assignment.ticket_id
            && effect["node_id"] == assignment.node_id
            && effect["attempt"].as_u64() == Some(assignment.attempt)
            && effect["input_digest"] == operation
    };
    matched_fields(old)
        && matched_fields(new)
        && matched_fields(local)
        && old["status"] == "confirmed"
        && new["status"] == "unknown"
        && local["status"] == "unknown"
        && old["artifacts"] == completion["artifacts"]
        && new["artifacts"] == json!([])
        && local["artifacts"] == json!([])
        && old["effect_id"] == new["effect_id"]
        && new["effect_id"] == local["effect_id"]
        && old["effect_id"].as_str().is_some_and(uuid_is_valid)
        && old["evidence"] == new["evidence"]
        && old["evidence"][0]["kind"] == "artifact"
        && old["evidence"][0]["digest"] == original_artifacts[0]["sha256"]
        && original_artifacts[0]["sha256"]
            .as_str()
            .is_some_and(|digest| {
                digest.len() == 64
                    && digest
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
}

fn report_relations_match(
    report: &Value,
    completion: &Value,
    assignment: &crate::wire::Assignment,
) -> bool {
    // Effect input identifies the executed operation; the separate completion
    // digest additionally identifies lease/grant admission. They are not aliases.
    let operation_input = json!({
        "assignment_id":assignment.id,"kind":assignment.kind,
        "relative_path":assignment.relative_path,"content":assignment.content
    });
    let operation_digest = digest_json(&operation_input);
    let Some(artifacts) = completion["artifacts"].as_array() else {
        return false;
    };
    let Some(artifact_ids) = artifacts
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let Some(reported_ids) = report["artifact_ids"]
        .as_array()
        .and_then(|values| values.iter().map(Value::as_str).collect::<Option<Vec<_>>>())
    else {
        return false;
    };
    if artifact_ids != reported_ids {
        return false;
    }
    let Some(metadata) = report["artifacts"].as_array() else {
        return false;
    };
    if metadata.len() != artifacts.len() {
        return false;
    }
    for (entry, expected_id) in metadata.iter().zip(&artifact_ids) {
        if entry["artifact_id"].as_str() != Some(*expected_id)
            || entry["sha256"].as_str().is_none()
            || entry["origin_node_id"] != report["node_id"]
            || entry["assignment_id"] != report["assignment_id"]
        {
            return false;
        }
    }
    let Some(original_effects) = report["effects"].as_array() else {
        return false;
    };
    let Some(expected_effects) = completion["effects"].as_array() else {
        return false;
    };
    if original_effects.len() != expected_effects.len() {
        return false;
    }
    original_effects
        .iter()
        .zip(expected_effects)
        .all(|(effect, local)| {
            effect["effect_id"] == local["effect_id"]
                && effect["status"] == local["status"]
                && effect["input_digest"] == local["input_digest"]
                && effect["input_digest"] == operation_digest
                && effect["attempt"] == local["attempt"]
                && effect["artifacts"] == completion["artifacts"]
                && effect["effect_id"].as_str().is_some_and(uuid_is_valid)
        })
}

impl Persisted {
    fn empty() -> Self {
        Self {
            version: 1,
            assignments: BTreeMap::new(),
            completions: BTreeMap::new(),
            outbox: Vec::new(),
            deliveries: Vec::new(),
            last_assignment_id: None,
            active_assignment_id: None,
            heartbeat_at: None,
        }
    }
}

fn decode(value: Value) -> Result<Persisted> {
    if value["version"] != 1 {
        bail!("unsupported node state version");
    }
    let object = value
        .as_object()
        .context("node state must be a JSON object")?;
    let completions = object
        .get("completions")
        .and_then(Value::as_object)
        .context("invalid completions")?;
    let assignments = object
        .get("assignments")
        .and_then(Value::as_object)
        .context("invalid assignments")?;
    let outbox = object
        .get("outbox")
        .and_then(Value::as_array)
        .context("invalid outbox")?
        .iter()
        .map(decode_outbox)
        .collect::<Result<Vec<_>>>()?;
    let deliveries = object
        .get("deliveries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let last_assignment_id = object
        .get("last_assignment_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let active_assignment_id = object
        .get("active_assignment_id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let heartbeat_at = object
        .get("heartbeat_at")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Persisted {
        version: 1,
        assignments: assignments
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        completions: completions
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        outbox,
        deliveries,
        last_assignment_id,
        active_assignment_id,
        heartbeat_at,
    })
}

fn decode_outbox(value: &Value) -> Result<OutboxItem> {
    Ok(OutboxItem {
        kind: value["kind"].as_str().context("outbox kind")?.to_owned(),
        body: value["body"].clone(),
        digest: value["digest"]
            .as_str()
            .context("outbox digest")?
            .to_owned(),
        attempts: value["attempts"].as_u64().unwrap_or(0),
        next_attempt_at: value["next_attempt_at"]
            .as_str()
            .context("outbox.next_attempt_at must be a persistent timestamp string")?
            .to_owned(),
        last_error: value["last_error"].as_str().map(str::to_owned),
    })
}

fn encode(data: &Persisted) -> Value {
    json!({"version":1,"assignments":data.assignments,"completions":data.completions,
        "outbox":data.outbox.iter().map(|item|json!({"kind":item.kind,"body":item.body,"digest":item.digest,"attempts":item.attempts,"next_attempt_at":item.next_attempt_at,"last_error":item.last_error})).collect::<Vec<_>>(),
        "deliveries":data.deliveries,"last_assignment_id":data.last_assignment_id,"active_assignment_id":data.active_assignment_id,"heartbeat_at":data.heartbeat_at})
}

fn sanitize_error(error: &str) -> String {
    error
        .replace(char::is_control, " ")
        .chars()
        .take(1000)
        .collect()
}
