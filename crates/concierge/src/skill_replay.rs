//! Bounded, byte-exact replay proof for the existing deterministic read_summary
//! executor. This module records evidence, never a standing Grant or a skill
//! runtime. The controller reads stored artifacts, not a user's project root.
use crate::maintenance;
use crate::store::Store;
use crate::{now, safe_relative, sha256};
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const SCHEMA: &str = "loom.skill-replay.v1";
const MAX_SOURCE_BYTES: u64 = 1_048_576;
const SAMPLE_SCHEMA: &str = "loom.synthetic_summary.v1";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ReplaySample {
    schema: String,
    path: String,
    byte_length: u64,
    /// New workers attest the raw read bytes. Legacy summaries stay parseable
    /// but a missing field must not be treated as source-byte provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_sha256: Option<String>,
    line_count: usize,
    lines: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ReplayDefinition {
    schema: String,
    version: u64,
    operation: String,
    relative_path: String,
    project_id: String,
    node_id: String,
    installation_id: String,
    worker_id: String,
    grant_id: String,
    grant_version: u64,
    grant_digest: String,
    project_binding_id: String,
    sample_digest: String,
    line_count: usize,
    source_ticket_id: String,
    source_artifact_id: String,
}

#[derive(Clone, Debug)]
struct SourceProof {
    definition: ReplayDefinition,
    expected_sha256: String,
    sample: ReplaySample,
}

/// Only a pending candidate may issue a new replay. An accepted or pending
/// candidate may reread existing proof; undo does not revive an execution or
/// create a different normal task assignment.
pub fn create_or_get(store: &Store, candidate_id: &str, body: &Value) -> Result<Value> {
    if candidate_id.len() > 160
        || body
            .as_object()
            .is_none_or(|object| object.keys().any(|key| key != "source_ticket_id"))
    {
        bail!("Replay accepts only a bounded candidate ID and exact source_ticket_id");
    }
    let source_ticket_id = body["source_ticket_id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 160)
        .context("Replay requires source_ticket_id already present in candidate source_refs")?;
    let candidate = candidate(store, candidate_id)?;
    if candidate["kind"] != "skill" {
        bail!("Only a Skill candidate can use the bounded read_summary replay")
    }
    let source_refs: Value = serde_json::from_str(
        candidate["source_refs"]
            .as_str()
            .context("Candidate has malformed source_refs")?,
    )?;
    if !source_bound(
        &source_refs,
        source_ticket_id,
        candidate["scope"].as_str().unwrap_or_default(),
    ) {
        bail!("The requested source is not actually bound into this Skill candidate");
    }
    if let Some(existing) = store
        .query(
            "SELECT candidate_id FROM skill_replays WHERE candidate_id=?1",
            [candidate_id],
        )?
        .first()
    {
        return present(store, existing["candidate_id"].as_str().unwrap_or_default());
    }
    if candidate["status"] != "pending" {
        bail!("Only a pending Skill candidate can start a replay");
    }
    let source = verify_source(store, source_ticket_id)?;
    let definition = source.definition.clone();
    if definition.project_id != candidate["scope"].as_str().unwrap_or_default() {
        bail!("This candidate scope cannot borrow a source Ticket from another project");
    }
    let definition_json = serde_json::to_string(&definition)?;
    // The full authorize + Ticket + Assignment sequence is atomic. create_ticket
    // itself performs the current physical placement and existing-Grant checks.
    with_transaction(store, |store| {
        let placement = crate::inventory::decide_placement(
            store,
            &crate::inventory::PlacementRequest {
                project_id: definition.project_id.clone(),
                capability: "read_summary".into(),
                worker_id: definition.worker_id.clone(),
                preferred_node_id: Some(definition.node_id.clone()),
                grant_id: definition.grant_id.clone(),
                project_binding_id: definition.project_binding_id.clone(),
                evaluated_at: chrono::Utc::now(),
                hardware: None,
            },
        )?;
        if placement.selected.is_none() {
            bail!("Replay cannot use stale, revoked or different node/worker/root Grant placement: {}", placement.explanation);
        }
        let objective = format!(
            "Exact deterministic read_summary replay for candidate {candidate_id}; source {}",
            source_ticket_id
        );
        let replay_ticket = maintenance::create_ticket(
            store,
            &definition.project_id,
            "read_summary",
            &objective,
            &definition.relative_path,
            None,
            &definition.grant_id,
            Some(&definition.node_id),
            Some(&definition.worker_id),
            Some("read_summary"),
            None,
        )?;
        if replay_ticket["kind"] != "read_summary"
            || replay_ticket["status"] != "running"
            || replay_ticket["node_id"] != definition.node_id
            || replay_ticket["installation_id"] != definition.installation_id
            || replay_ticket["worker_id"] != definition.worker_id
            || replay_ticket["grant_id"] != definition.grant_id
            || replay_ticket["grant_digest"] != definition.grant_digest
            || replay_ticket["relative_path"] != definition.relative_path
            || replay_ticket["assignments"]
                .as_array()
                .is_none_or(|assignments| assignments.len() != 1)
        {
            bail!("Replay did not obtain a fresh ordinary read_summary Ticket with a live exact-scope Assignment");
        }
        let replay_ticket_id = replay_ticket["id"]
            .as_str()
            .context("Replay Ticket ID missing")?;
        let at = now();
        store.conn().execute(
            "INSERT INTO skill_replays(candidate_id,source_ticket_id,source_artifact_id,grant_id,project_id,node_id,installation_id,worker_id,replay_ticket_id,expected_sha256,expected_sample,sample_digest,status,definition_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'awaiting_execution',?13,?14,?14)",
            params![candidate_id,source_ticket_id,definition.source_artifact_id,definition.grant_id,definition.project_id,definition.node_id,definition.installation_id,definition.worker_id,replay_ticket_id,source.expected_sha256,serde_json::to_string(&source.sample)?,definition.sample_digest,definition_json,at],
        )?;
        store.audit(Some(replay_ticket_id), "client", "skill.replay.issued", &json!({
            "candidate_id":candidate_id,"source_ticket_id":source_ticket_id,
            "source_artifact_id":definition.source_artifact_id,"source_sha256":source.expected_sha256,
            "replay_ticket_id":replay_ticket_id,"grant_id":definition.grant_id,
            "operation":"read_summary","purpose":"awaiting_ordinary_worker_execution","authority_created":false
        }))?;
        Ok(())
    })?;
    present(store, candidate_id)
}

/// Refresh an existing attempt from its independent ordinary Artifact history.
/// This path never authorizes, fakes or repeats a worker execution if revoked,
/// cancelled, stale, mismatched, or assigned to a different project/worker/root.
pub fn present(store: &Store, candidate_id: &str) -> Result<Value> {
    let Some(row) = store
        .query(
            "SELECT * FROM skill_replays WHERE candidate_id=?1",
            [candidate_id],
        )?
        .first()
        .cloned()
    else {
        bail!("Replay proof is not established for this candidate")
    };
    let old_status = row["status"].as_str().unwrap_or_default();
    let mut status = old_status.to_owned();
    let mut reason = row["reason"].clone();
    let mut replay_artifact_id = row["replay_artifact_id"].clone();
    if !matches!(old_status, "verified" | "sample_mismatch") {
        match ordinary_artifact(store, &row)? {
            ArtifactState::Succeeded(artifact) => {
                replay_artifact_id = artifact["id"].clone();
                let definition: ReplayDefinition = serde_json::from_str(
                    row["definition_json"]
                        .as_str()
                        .context("Replay definition missing")?,
                )?;
                let actual = artifact_bytes(
                    store,
                    artifact["id"]
                        .as_str()
                        .context("Fresh artifact ID missing")?,
                    1_048_576,
                )?;
                let expected: ReplaySample = serde_json::from_str(
                    row["expected_sample"]
                        .as_str()
                        .context("Replay expected sample missing")?,
                )?;
                match evaluate_sample(&definition, &actual, &expected) {
                    Ok((actual_sha, actual_sample)) => {
                        status = "verified".into();
                        reason = Value::Null;
                        if artifact["sha256"] != actual_sha {
                            bail!("Artifact store bytes differ from its registered digest; cannot verify replay")
                        }
                        store.audit(
                            Some(&replay_ticket_id(&row)?), "controller", "skill.replay.verified", &json!({
                                "candidate_id":candidate_id,"source_artifact_id":row["source_artifact_id"],
                                "source_sha256":row["expected_sha256"],"replay_artifact_id":artifact["id"],
                                "replay_sha256":actual_sha,"byte_equal":true,"sample_digest":definition.sample_digest,
                                "sample":actual_sample,"standing_grant_created":false
                            }),
                        )?;
                    }
                    Err(mismatch) => {
                        status = "sample_mismatch".into();
                        reason = json!(bounded_text(&mismatch));
                        store.audit(
                            Some(&replay_ticket_id(&row)?),
                            "controller",
                            "skill.replay.sample_mismatch",
                            &json!({
                                "candidate_id":candidate_id,"reason":reason,"promoted":false
                            }),
                        )?;
                    }
                }
            }
            ArtifactState::Awaiting(message) => {
                status = match ticket_state(store, &row)?.as_str() {
                    "running" | "waiting_approval" => "awaiting_execution".into(),
                    "reconciling" => "reconciling".into(),
                    _ => "failed".into(),
                };
                reason = json!(bounded_text(&message));
            }
        }
    }
    let at = now();
    let verified_at = if status == "verified" {
        row["verified_at"]
            .as_str()
            .filter(|value| !value.is_empty())
            .unwrap_or(&at)
    } else {
        row["verified_at"].as_str().unwrap_or("")
    };
    let revoked = store
        .get("grants", row["grant_id"].as_str().unwrap_or_default())?
        .is_none_or(|grant| grant["revoked_at"] != Value::Null);
    let current_project = store
        .get("projects", row["project_id"].as_str().unwrap_or_default())?
        .is_some_and(|project| project["id"] == row["project_id"]);
    let denial = if revoked {
        if row["grant_revocation_denied_at"].is_null() {
            store.audit(
                None, "controller", "skill.replay.revocation_denied",
                &json!({"candidate_id":candidate_id,"grant_id":row["grant_id"],"new_execution":false}),
            )?;
        }
        Some(now())
    } else {
        None
    };
    let revoked_at = row["grant_revocation_denied_at"]
        .as_str()
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or(denial);
    let revocation_changed = revoked_at.as_deref().unwrap_or_default()
        != row["grant_revocation_denied_at"]
            .as_str()
            .unwrap_or_default();
    if status != old_status || reason != row["reason"] || revocation_changed {
        store.conn().execute(
            "UPDATE skill_replays SET replay_artifact_id=?1,status=?2,reason=?3,updated_at=?4,verified_at=?5,grant_revocation_denied_at=COALESCE(?6,grant_revocation_denied_at) WHERE candidate_id=?7",
            params![replay_artifact_id.as_str(),status,reason.as_str(),at,verified_at,revoked_at,candidate_id],
        )?;
    }
    let mut result = store
        .query(
            "SELECT * FROM skill_replays WHERE candidate_id=?1",
            [candidate_id],
        )?
        .first()
        .cloned()
        .context("Skill replay disappeared")?;
    result["schema"] = json!(SCHEMA);
    result["expected_sample"] =
        serde_json::from_str::<Value>(row["expected_sample"].as_str().unwrap_or("{}"))?;
    result["sample"] = json!({
        "path":result["expected_sample"]["path"],"line_count":result["expected_sample"]["line_count"],
        "lines":result["expected_sample"]["lines"],"digest":result["sample_digest"]
    });
    result["current_project_valid"] = json!(current_project);
    result["authority_created"] = json!(false);
    result["runtime"] = json!("bounded_exact_deterministic_read_summary_only");
    result["source_assignment_id"] = store
        .query(
            "SELECT id FROM assignments WHERE ticket_id=?1",
            [row["source_ticket_id"].as_str()],
        )?
        .first()
        .map(|assignment| assignment["id"].clone())
        .unwrap_or(Value::Null);
    result["source_report_id"] = store
        .query(
            "SELECT id FROM reports WHERE ticket_id=?1",
            [row["source_ticket_id"].as_str()],
        )?
        .first()
        .map(|report| report["id"].clone())
        .unwrap_or(Value::Null);
    Ok(result)
}

pub fn list(store: &Store) -> Result<Value> {
    let replays = store
        .query("SELECT candidate_id FROM skill_replays", [])?
        .iter()
        .filter_map(|row| row["candidate_id"].as_str().map(ToOwned::to_owned))
        .map(|id| present(store, &id))
        .collect::<Result<Vec<_>>>()?;
    let skills = store.query("SELECT * FROM skills ORDER BY created_at DESC", [])?;
    Ok(json!({"skill_replays":replays,"skills":skills,"standing_grant":false}))
}

fn candidate(store: &Store, candidate_id: &str) -> Result<Value> {
    store
        .get("candidates", candidate_id)?
        .context("Candidate not found")
}

fn verify_source(store: &Store, ticket_id: &str) -> Result<SourceProof> {
    let ticket = store.detail(ticket_id)?;
    if ticket["kind"] != "read_summary"
        || ticket["status"] != "succeeded"
        || ticket["cancel_requested"] == true
    {
        bail!("Only a completed, uncancelled read_summary source can seed a bounded replay");
    }
    let grant_id = required_text(&ticket, "grant_id")?;
    let grant = store
        .get("grants", &grant_id)?
        .context("Original Grant is missing")?;
    let binding_id = required_text(&grant, "project_binding_id")?;
    let binding = active_binding(store, &binding_id)?;
    let project_id = required_text(&ticket, "project_id")?;
    if grant["project_id"] != project_id
        || binding["project_id"] != project_id
        || grant["node_id"] != ticket["node_id"]
        || grant["installation_id"] != ticket["installation_id"]
        || grant["worker_id"] != ticket["worker_id"]
        || binding["node_id"] != ticket["node_id"]
        || binding["installation_id"] != ticket["installation_id"]
        || binding["worker_id"] != ticket["worker_id"]
        || binding["root_scope"].as_str().is_none_or(|root| {
            root.is_empty() || root.len() > 4096 || root.contains('\0') || root == "*"
        })
    {
        bail!("Original ticket does not share its exact project/node/worker/binding with the current Grant");
    }
    let grant_version = grant["version"]
        .as_u64()
        .context("Original Grant version missing")?;
    let grant_digest = required_text(&grant, "digest")?;
    if grant_digest.len() != 64
        || ticket["grant_digest"] != grant_digest
        || grant["operations"]
            .as_array()
            .is_none_or(|operations| !operations.iter().any(|op| op == "read"))
    {
        bail!("Original Grant no longer authorizes this read or was not used by the source Ticket");
    }
    let assignments = ticket["assignments"]
        .as_array()
        .context("Source Assignment list missing")?;
    if assignments.len() != 1 {
        bail!("Source must have one actual assignment, not an unassigned producer");
    }
    let assignment_id = required_text(&assignments[0], "id")?;
    let reports = ticket["reports"]
        .as_array()
        .context("Source structured Report missing")?;
    if reports.len() != 1
        || reports[0]["state"] != "succeeded"
        || reports[0]["assignment_id"] != assignment_id
        || reports[0]["ticket_id"] != ticket_id
        || reports[0]["node_id"] != ticket["node_id"]
        || reports[0]["lease_epoch"] != ticket["attempt"]
    {
        bail!("Original successful worker Report cannot be proven");
    }
    let relative_path = required_text(&ticket, "relative_path")?;
    safe_relative(&relative_path)?;
    let artifacts = ticket["artifacts"]
        .as_array()
        .context("Source Artifact list missing")?;
    if artifacts.len() != 1 {
        bail!("Source must have exactly one ordinary worker-produced Artifact");
    }
    for artifact in artifacts {
        if artifact["media_type"] != "application/json"
            || artifact["size_bytes"]
                .as_u64()
                .is_none_or(|size| size == 0 || size > MAX_SOURCE_BYTES)
            || artifact["origin_node_id"] != ticket["node_id"]
            || artifact["assignment_id"] != assignment_id
            || artifact["ticket_id"] != ticket_id
        {
            continue;
        }
        let artifact_id = required_text(artifact, "id")?;
        let bytes = artifact_bytes(store, &artifact_id, MAX_SOURCE_BYTES)?;
        let digest = sha256(&bytes);
        let sample = required_summary(&relative_path, &bytes)
            .map_err(|error| anyhow::anyhow!("Bounded source Artifact sample rejected: {error}"))?;
        {
            if artifact["sha256"] == digest {
                let expected_sample = sample.clone();
                uuid::Uuid::parse_str(&artifact_id)?;
                let source_definition = ReplayDefinition {
                    schema: SCHEMA.into(),
                    version: 1,
                    operation: "read_summary".into(),
                    relative_path: relative_path.clone(),
                    project_id,
                    node_id: required_text(&ticket, "node_id")?,
                    installation_id: required_text(&ticket, "installation_id")?,
                    worker_id: required_text(&ticket, "worker_id")?,
                    grant_id,
                    grant_version,
                    grant_digest,
                    project_binding_id: binding_id,
                    sample_digest: sample_digest_from_bytes(&bytes, &relative_path)?,
                    line_count: sample.line_count,
                    source_ticket_id: ticket_id.into(),
                    source_artifact_id: artifact_id,
                };
                return Ok(SourceProof {
                    definition: source_definition,
                    expected_sha256: digest,
                    sample: expected_sample,
                });
            }
        }
    }
    bail!("No actual original worker Artifact reproduces the admitted bounded read_summary sample");
}

// Only ordinary worker ingress supplies this evidence. No coordinator filesystem
// project read side-channel is introduced, even when a Grant is later revoked.

fn ordinary_artifact(store: &Store, replay: &Value) -> Result<ArtifactState> {
    let definition: ReplayDefinition = serde_json::from_str(
        replay["definition_json"]
            .as_str()
            .context("Replay definition missing")?,
    )
    .context("Ordinary replay typed definition must be preserved")?;
    let ticket = store.detail(&replay_ticket_id(replay)?)?;
    if ticket["id"] != replay["replay_ticket_id"]
        || ticket["kind"] != "read_summary"
        || ticket["project_id"] != replay["project_id"]
        || ticket["node_id"] != replay["node_id"]
        || ticket["installation_id"] != replay["installation_id"]
        || ticket["worker_id"] != replay["worker_id"]
        || ticket["grant_id"] != replay["grant_id"]
        || ticket["grant_digest"] != definition.grant_digest
        || ticket["relative_path"] != definition.relative_path
    {
        bail!("Replay lineage cannot be replaced by a different ordinary Ticket");
    }
    let assignments = ticket["assignments"]
        .as_array()
        .context("Replay Assignment missing")?;
    if assignments.len() != 1 {
        bail!("Replay must retain one actual live Assignment lineage");
    }
    let reports = ticket["reports"]
        .as_array()
        .context("Replay Report missing")?;
    if reports.is_empty() {
        return Ok(ArtifactState::Awaiting(
            "Ordinary worker has not emitted a structured Report".into(),
        ));
    }
    let live_assignment = &assignments[0];
    let lease_id = required_text(live_assignment, "lease_id")?;
    let lease_epoch = live_assignment["lease_epoch"]
        .as_i64()
        .filter(|epoch| *epoch > 0)
        .context("Replay Assignment lease epoch is invalid")?;
    crate::parse_time(&required_text(live_assignment, "lease_expires_at")?)?;
    if reports.len() != 1 || reports[0]["state"] != "succeeded" {
        return Ok(ArtifactState::Awaiting(format!(
            "Replay outcome is {}, not verified execution evidence",
            ticket["status"]
        )));
    }
    if ticket["status"] != "succeeded"
        || ticket["cancel_requested"] == true
        || reports[0]["assignment_id"] != live_assignment["id"]
        || live_assignment["node_id"] != ticket["node_id"]
        || live_assignment["worker_id"] != ticket["worker_id"]
        || live_assignment["attempt"] != ticket["attempt"]
        || live_assignment["lease_epoch"].as_i64() != Some(lease_epoch)
        || reports[0]["ticket_id"] != ticket["id"]
        || reports[0]["node_id"] != ticket["node_id"]
        || reports[0]["lease_epoch"].as_i64() != Some(lease_epoch)
    {
        bail!("Replay Report does not match its own real assignment/lease/node lineage")
    }
    // lease_id proves this Report stayed on its issued ordinary Assignment,
    // not a newly pair-keyed Task/binding with only matching IDs. Fresh receipt
    // authority at the accept boundary is checked with the current Grant and
    // ProjectBinding, rather than pretending a long-lived immutable grant.
    debug_assert!(!lease_id.is_empty());
    let artifacts = ticket["artifacts"]
        .as_array()
        .context("Replay Artifact list missing")?;
    if artifacts.len() != 1 {
        return Ok(ArtifactState::Awaiting(
            "A fresh successful replay must contain exactly one actual Artifact".into(),
        ));
    }
    let artifact = &artifacts[0];
    if artifact["ticket_id"] != ticket["id"]
        || artifact["assignment_id"] != assignments[0]["id"]
        || artifact["origin_node_id"] != ticket["node_id"]
        || artifact["media_type"] != "application/json"
        || artifact["size_bytes"]
            .as_u64()
            .is_none_or(|size| size == 0 || size > MAX_SOURCE_BYTES)
    {
        bail!("Fresh replay Artifact has mismatched identity, scope or size bounds");
    }
    if let Some(previous) = &replay["replay_artifact_id"].as_str() {
        if *previous != artifact["id"] {
            bail!("A replay cannot switch to a different Artifact after provenance was registered");
        }
    }
    uuid::Uuid::parse_str(&required_text(artifact, "id")?)?;
    ordinary_artifact_hash(store, artifact)?;
    Ok(ArtifactState::Succeeded(artifact.clone()))
}

fn ordinary_artifact_hash(store: &Store, artifact: &Value) -> Result<()> {
    let bytes = artifact_bytes(store, &required_text(artifact, "id")?, MAX_SOURCE_BYTES)?;
    if sha256(&bytes) != artifact["sha256"].as_str().unwrap_or_default() {
        bail!("Replay bytes do not match their immutable registry hash");
    }
    Ok(())
}

fn artifact_bytes(store: &Store, artifact_id: &str, limit: u64) -> Result<Vec<u8>> {
    uuid::Uuid::parse_str(artifact_id)?;
    let record = store
        .get("artifacts", artifact_id)?
        .context("Artifact is not registered")?;
    if record["storage_name"] != format!("{artifact_id}.artifact") {
        bail!("Artifact storage identity mismatch");
    }
    // storage_name is now a fixed UUID-derived controlled filename, not a path
    // accepted from the candidate. Never select a project_file or arbitrary URL.
    if record["size_bytes"]
        .as_u64()
        .is_none_or(|size| size == 0 || size > limit)
    {
        bail!("Artifact exceeds the bounded replay byte limit");
    }
    let bytes = std::fs::read(
        store
            .root
            .join("artifacts")
            .join(format!("{artifact_id}.artifact")),
    )?;
    if bytes.is_empty() || bytes.len() as u64 > limit || sha256(&bytes) != record["sha256"] {
        bail!("Artifact bytes exceed limits or disagree with the immutable digest");
    }
    Ok(bytes)
}

fn required_summary(relative_path: &str, bytes: &[u8]) -> Result<ReplaySample> {
    let sample: ReplaySample = serde_json::from_slice(bytes)?;
    if sample.schema != SAMPLE_SCHEMA
        || sample.path != relative_path
        || sample.lines.len() > 20
        || sample.byte_length != 0 && sample.line_count == 0
        || sample.byte_length > MAX_SOURCE_BYTES
        || sample.input_sha256.as_deref() == Some(crate::sha256(bytes).as_str())
        || sample.input_sha256.as_deref().is_some_and(|digest| {
            digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        || sample.lines.iter().any(|line| {
            line.trim().is_empty()
                || line.chars().count() > 200
                || line.contains('\n')
                || line.contains('\r')
        })
    {
        bail!("Artifact is not a well-formed bounded read_summary for the exact original relative_path");
    }
    if serde_json::to_vec_pretty(&sample)? != bytes {
        bail!(
            "read_summary evidence must retain the exact deterministic pretty-JSON representation"
        );
    }
    Ok(sample)
}

// Read-only source-verification uses only artifacts, not a second filesystem path.
// This intentionally no longer follows a candidate's project/root string.
fn active_binding(store: &Store, binding_id: &str) -> Result<Value> {
    let binding = store
        .query(
            "SELECT * FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
            [binding_id],
        )?
        .into_iter()
        .next()
        .context("Original approved ProjectBinding is missing or revoked")?;
    Ok(binding)
}

fn source_bound(refs: &Value, ticket_id: &str, scope: &str) -> bool {
    let Some(entries) = refs.as_array() else {
        return false;
    };
    let ids: BTreeSet<&str> = entries
        .iter()
        .filter_map(|entry| match entry {
            Value::String(id) => Some(id.as_str()),
            Value::Object(object) if object.get("ticket_id").and_then(Value::as_str).is_some() => {
                object.get("ticket_id").and_then(Value::as_str)
            }
            _ => None,
        })
        .collect();
    !ids.is_empty()
        && ids.len() <= 32
        && entries.len() <= 32
        && ids.contains(ticket_id)
        && scope.len() <= 160
        && entries.iter().all(|entry| {
            entry.as_str().is_some_and(|id| id.len() <= 160)
                || entry.as_object().is_some_and(|object| {
                    object.keys().all(|key| key == "ticket_id" || key == "kind")
                        && object
                            .get("kind")
                            .and_then(Value::as_str)
                            .is_none_or(|kind| kind == "source_ticket")
                })
        })
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn sample_digest_from_bytes(bytes: &[u8], relative_path: &str) -> Result<String> {
    Ok(sha256(serde_json::to_vec(&required_summary(
        relative_path,
        bytes,
    )?)?))
}

fn evaluate_sample(
    definition: &ReplayDefinition,
    actual: &[u8],
    expected: &ReplaySample,
) -> std::result::Result<(String, ReplaySample), String> {
    if actual.len() as u64 > MAX_SOURCE_BYTES {
        return Err("Replay artifact exceeds 1 MiB".into());
    }
    let actual_sample = required_summary(&definition.relative_path, actual)
        .map_err(|error| format!("Fresh bytes are not a valid exact read_summary: {error}"))?;
    let actual_sha = sha256(actual);
    let expected_sha =
        sha256(serde_json::to_vec_pretty(expected).map_err(|error| error.to_string())?);
    if actual
        != serde_json::to_vec_pretty(expected)
            .map_err(|error| error.to_string())?
            .as_slice()
    {
        return Err(format!("Fresh SHA {actual_sha} differs from source SHA {expected_sha}; semantic_sample_equal=false"));
    }
    if actual_sample != *expected
        || sample_digest_from_bytes(actual, &definition.relative_path)
            .map_err(|error| error.to_string())?
            != definition.sample_digest
    {
        return Err("Fresh summary fields differ from the source sample".into());
    }
    Ok((actual_sha, actual_sample))
}

fn required_text(value: &Value, key: &str) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty() && text.len() <= 4096)
        .map(ToOwned::to_owned)
        .with_context(|| format!("Missing bounded field {key}"))
}
fn replay_ticket_id(row: &Value) -> Result<String> {
    required_text(row, "replay_ticket_id")
}
fn ticket_state(store: &Store, row: &Value) -> Result<String> {
    required_text(
        &store
            .get("tickets", &replay_ticket_id(row)?)?
            .context("Replay Ticket missing")?,
        "status",
    )
}
fn bounded_text(message: &str) -> String {
    message.chars().take(1000).collect()
}

enum ArtifactState {
    Succeeded(Value),
    Awaiting(String),
}

/// BEGIN IMMEDIATE remains on the existing single Store connection. It never
/// recursively requests State::lock or starts a second SQLite transaction.
fn with_transaction<T>(store: &Store, work: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    match work(store) {
        Ok(value) => {
            store.conn().execute("COMMIT", [])?;
            Ok(value)
        }
        Err(error) => {
            let rollback = store.conn().execute("ROLLBACK", []);
            match rollback {
                Ok(_) => Err(error),
                Err(failure) => Err(error.context(format!(
                    "skill replay transaction rollback failed: {failure}"
                ))),
            }
        }
    }
}

pub fn verified_for_accept(store: &Store, candidate_id: &str) -> Result<(Value, Value)> {
    let row = present(store, candidate_id)?;
    if row["status"] != "verified"
        || row["current_project_valid"] != true
        || row["replay_artifact_id"] == row["source_artifact_id"]
        || row["replay_ticket_id"] == row["source_ticket_id"]
    {
        bail!("Skill acceptance requires a different ordinary replay Ticket and Artifact with verified byte equality");
    }
    // Re-derive both sides from immutable ordinary task records; a row saying
    // verified=true is not enough if its source lineage/project is inconsistent.
    let candidate = candidate(store, candidate_id)?;
    if candidate["kind"] != "skill" || candidate["scope"] != row["project_id"] {
        bail!("Skill scope and proof project disagree");
    }
    let attached_refs: Value = serde_json::from_str(
        candidate["source_refs"]
            .as_str()
            .context("Candidate source_refs became malformed")?,
    )
    .context("Candidate source_refs must remain a bounded JSON array")?;
    if !source_bound(
        &attached_refs,
        required_text(&row, "source_ticket_id")?.as_str(),
        candidate["scope"].as_str().unwrap_or_default(),
    ) {
        bail!("Candidate no longer names the actual source used for this replay");
    }
    let source = verify_source(store, required_text(&row, "source_ticket_id")?.as_str())
        .context("Acceptance source lineage could not be rederived")?;
    let source_definition: ReplayDefinition =
        serde_json::from_str(row["definition_json"].as_str().unwrap_or("{}"))
            .context("Acceptance proof must preserve the typed ReplayDefinition")?;
    if source.definition != source_definition {
        bail!("Replay definition does not re-derive the original actual Ticket/Grant/binding incarnation");
    }
    let original_sample: ReplaySample = serde_json::from_value(row["expected_sample"].clone())
        .context("Acceptance expected sample must preserve read_summary.v1")?;
    if original_sample != source.sample || row["expected_sha256"] != source.expected_sha256 {
        bail!("Source expected sample and actual original worker Artifact diverge");
    }
    if !matches!(
        ordinary_artifact(store, &row).context("Ordinary replay lineage could not be rederived")?,
        ArtifactState::Succeeded(_)
    ) {
        bail!("Fresh ordinary replay no longer has a verified producer lineage");
    }
    let source_hash = ordinary_hash_by_id(store, required_text(&row, "source_artifact_id")?)?;
    let replay_hash = ordinary_hash_by_id(store, required_text(&row, "replay_artifact_id")?)?;
    if source_hash != replay_hash {
        bail!("Skill replay actual fresh bytes are not equal to the original artifact bytes");
    }
    let grant = store
        .get("grants", row["grant_id"].as_str().unwrap_or_default())?
        .context("Replay Grant missing")?;
    if grant["revoked_at"] != Value::Null
        || source_definition.grant_digest != grant["digest"].as_str().unwrap_or_default()
        || source_definition.grant_version != grant["version"].as_u64().unwrap_or(0)
        || !grant["operations"]
            .as_array()
            .is_some_and(|ops| ops.contains(&json!("read")))
    {
        bail!("The original Grant must still be valid when first saving this verified Skill");
    }
    let binding = active_binding(store, &source_definition.project_binding_id)
        .context("The source ProjectBinding must remain active at first acceptance")?;
    if binding["project_id"] != source_definition.project_id
        || binding["node_id"] != source_definition.node_id
        || binding["installation_id"] != source_definition.installation_id
        || binding["worker_id"] != source_definition.worker_id
    {
        bail!("Replay ProjectBinding no longer matches the exact original work scope");
    }
    // First saving a new skill must not convert a historically possible read
    // into a fresh permission after Grant/binding/worker/root are revoked or
    // moved. Reuse the deterministic current placement checks, without issuing
    // any new Ticket as part of this query.
    let placement = crate::inventory::decide_placement(
        store,
        &crate::inventory::PlacementRequest {
            project_id: source_definition.project_id.clone(),
            capability: "read_summary".into(),
            worker_id: source_definition.worker_id.clone(),
            preferred_node_id: Some(source_definition.node_id.clone()),
            grant_id: source_definition.grant_id.clone(),
            project_binding_id: source_definition.project_binding_id.clone(),
            evaluated_at: chrono::Utc::now(),
            hardware: None,
        },
    )?;
    if placement.selected.is_none() {
        bail!(
            "The original read Grant and current ProjectBinding are required for first acceptance"
        );
    }
    if grant["project_id"] != row["project_id"]
        || grant["worker_id"] != row["worker_id"]
        || grant["node_id"] != row["node_id"]
        || grant["installation_id"] != row["installation_id"]
    {
        bail!("Skill proof changed its project/node/worker/incarnation scope");
    }
    Ok((
        row.clone(),
        json!({
            "schema":"loom.skill.v1","bounded_operation":"read_summary","replay_verified":true,
            "source_ticket_id":row["source_ticket_id"],"source_artifact_id":row["source_artifact_id"],
            "replay_ticket_id":row["replay_ticket_id"],"replay_artifact_id":row["replay_artifact_id"],
            "sha256":replay_hash,"sample":row["sample"],"grant_id":row["grant_id"],
            "grant_revocation_denied":!row["grant_revocation_denied_at"].is_null(),
            "standing_grant":false,"activation":false
        }),
    ))
}
fn ordinary_hash_by_id(store: &Store, artifact_id: String) -> Result<String> {
    Ok(sha256(artifact_bytes(
        store,
        &artifact_id,
        MAX_SOURCE_BYTES,
    )?))
}

#[cfg(test)]
mod byte_representation_tests {
    use super::*;
    #[test]
    fn exact_worker_summary_shape_is_replay_compatible() {
        let raw = br##"{
  "schema": "loom.synthetic_summary.v1",
  "path": "input.txt",
  "byte_length": 75,
  "line_count": 3,
  "lines": [
    "Real isolated project input.",
    "No LLM, DSH host or network model was called."
  ]
}"##;

        required_summary("input.txt", raw).unwrap();
    }

    #[test]
    fn new_source_digest_is_optional_for_legacy_and_never_reuses_artifact_hash() {
        let sample = ReplaySample {
            schema: SAMPLE_SCHEMA.into(),
            path: "input.txt".into(),
            byte_length: 75,
            input_sha256: None,
            line_count: 3,
            lines: vec![
                "Real isolated project input.".into(),
                "No LLM, DSH host or network model was called.".into(),
            ],
        };
        let legacy = serde_json::to_vec_pretty(&sample).unwrap();
        assert_eq!(
            required_summary("input.txt", &legacy).unwrap().input_sha256,
            None
        );
        let source =
            b"Real isolated project input.\nNo LLM, DSH host or network model was called.\n";
        let input_sha256 = sha256(source);
        assert_ne!(input_sha256, sha256(&legacy));
        let augmented = serde_json::to_vec_pretty(&ReplaySample {
            input_sha256: Some(sha256(source)),
            ..sample
        })
        .unwrap();
        assert_eq!(
            required_summary("input.txt", &augmented)
                .unwrap()
                .input_sha256
                .as_deref(),
            Some(sha256(source).as_str())
        );
        let mut invalid: Value = serde_json::from_slice(&augmented).unwrap();
        invalid["input_sha256"] = Value::String(sha256(&augmented));
        // Self-attesting that the summary hash is its own source proof is rejected.
        required_summary("input.txt", &serde_json::to_vec_pretty(&invalid).unwrap()).unwrap_err();
    }
}
