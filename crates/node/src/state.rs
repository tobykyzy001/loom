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
        let mut logical = body.clone();
        if let Some(object) = logical.as_object_mut() {
            object.insert("sent_at".into(), Value::Null);
        }
        let digest = digest_json(&logical);
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

    pub fn set_cancel_requested(&mut self, id: &str, value: bool) -> Result<()> {
        if let Some(assignment) = self.data.assignments.get_mut(id) {
            assignment["cancel_requested"] = json!(value);
        }
        self.flush()
    }
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
