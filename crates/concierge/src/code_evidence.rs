//! Bounded public evidence for the existing fixture-code Artifact/Report flow.
//!
//! The center vouches only for authenticated Node-reported fields which match
//! immutable Ticket/Artifact scope and the stored verification bytes. It does
//! **not** claim that the center ran Git, `node:test`, a shell or the edit. This
//! projection creates no Ticket kind, Grant, permission or additional file effect.

use crate::store::Store;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Component, Path};

const PATH: &str = "src/calc.js";
const CHANGE: &str = "loom_fixture_code_edit";
const VERIFY: &str = "loom_fixture_verify";
const MAX_SOURCE: u64 = 32_768;
const MAX_OUTPUT: usize = 8_192;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionEvidence {
    pub harness: String,
    pub session_id: String,
    pub host_api: String,
    pub protocol: String,
    pub observed_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CommandEvidence {
    pub file: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChangeEvidence {
    pub schema: String,
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    pub call_id: String,
    pub call_seq: u64,
    pub result_id: String,
    pub result_seq: u64,
    pub session: SessionEvidence,
    pub path: String,
    pub previous_sha256: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VerifyReference {
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    pub call_id: String,
    pub call_seq: u64,
    pub result_id: String,
    pub result_seq: u64,
    pub session: SessionEvidence,
    pub code_change_artifact_id: String,
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VerificationBody {
    pub schema: String,
    pub path: String,
    pub sha256: String,
    pub source_change_artifact_id: String,
    pub edit_tool_result: String,
    pub verification_tool_result: String,
    pub command: CommandEvidence,
    pub runner: String,
    pub cwd_scope: String,
    pub execution_status: String,
    pub exit_code: u8,
    pub passed: bool,
    pub previous_test_exit_code: u8,
    pub stdout: String,
    pub stderr: String,
    pub dsh_session: SessionEvidence,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectEvidence {
    #[serde(flatten)]
    pub change: ChangeEvidence,
    pub verification_artifact_id: String,
    pub test_tool_result_id: String,
    pub test_exit_code: u8,
}

/// Strictly projects one already-validated, fixed-name Node tool record.
/// Ordinary metadata without `metadata.evidence` is unchanged (`Ok(None)`).
/// Once either fixed tool name is present, malformed or additional records are
/// rejected rather than silently ignored. The input is never modified, and no
/// raw transcript, tool arguments, provider, environment or URL is copied.
pub fn projected_metadata(metadata: &Value) -> Result<Option<String>> {
    let Some(evidence) = metadata.get("evidence") else {
        return Ok(None);
    };
    if evidence.is_null() {
        return Ok(None);
    }
    if !evidence.is_array() {
        let fixed_marker = evidence
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| matches!(name, CHANGE | VERIFY));
        if fixed_marker {
            bail!("fixed-name evidence must be a single tool record in an array");
        }
        // Older/unrelated private evidence must not gain a new shape requirement.
        return Ok(None);
    }
    let records = evidence.as_array().context("evidence must be an array")?;
    let known = records.iter().any(|record| {
        record
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| matches!(name, CHANGE | VERIFY))
    });
    if !known {
        return Ok(None);
    }
    if records.len() != 1 {
        bail!("evidence must contain exactly one fixed-name tool record");
    }
    let record = &records[0];
    match required_string(record, "name")? {
        CHANGE => {
            let change: ChangeEvidence = decode(record.clone(), "change evidence")?;
            validate_change(&change)?;
            Ok(Some(
                json!({
                    "schema":"loom.code-provenance.v1", "kind":"change",
                    "call_id":change.call_id, "call_seq":change.call_seq,
                    "result_id":change.result_id, "result_seq":change.result_seq,
                    "session":change.session, "path":change.path,
                    "previous_sha256":change.previous_sha256, "sha256":change.sha256,
                    "size_bytes":change.size_bytes,
                })
                .to_string(),
            ))
        }
        VERIFY => {
            let reference: VerifyReference = decode(record.clone(), "verification evidence")?;
            validate_verify_reference(&reference)?;
            let mut projection = common_projection(
                &reference.call_id,
                reference.call_seq,
                &reference.result_id,
                reference.result_seq,
                &reference.session,
                &reference.path,
                &reference.sha256,
            );
            projection.insert("kind".into(), json!("verification"));
            projection.insert(
                "source_change_artifact_id".into(),
                json!(reference.code_change_artifact_id),
            );
            Ok(Some(Value::Object(projection).to_string()))
        }
        _ => bail!("name must identify a supported fixed code tool"),
    }
}

/// Reads a validated nullable Artifact projection without accepting arbitrary
/// JSON. Both the internal checker and the API integration use this same shape.
pub fn projection(value: &Value) -> Result<Option<Value>> {
    let Some(value) = value.get("code_evidence_json").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let value = match value {
        Value::Object(_) => value.clone(),
        Value::String(text) => decode(text.clone(), "stored code evidence")?,
        _ => bail!("code_evidence_json must be an object"),
    };
    exact_fields(&value, "code_evidence_json")?;
    let kind = required_string(&value, "kind")?;
    if !matches!(kind, "change" | "verification")
        || required_string(&value, "schema")? != "loom.code-provenance.v1"
        || required_string(&value, "path")? != PATH
    {
        bail!("code_evidence_json has invalid schema, kind or path");
    }
    tool_id(&value, "call_id")?;
    tool_id(&value, "result_id")?;
    sequence(&value, "call_seq")?;
    ordered(&value)?;
    session(&value["session"])?;
    sha(&value, "sha256")?;
    match kind {
        "change" => {
            sha(&value, "previous_sha256")?;
            if value["previous_sha256"] == value["sha256"] {
                bail!("previous_sha256 must differ from sha256");
            }
            let size = sequence(&value, "size_bytes")?;
            if size == 0 || size > MAX_SOURCE {
                bail!("size_bytes must be in 1..=32768");
            }
        }
        _ => uuid(&value, "source_change_artifact_id")?,
    }
    Ok(Some(value))
}

fn common_projection(
    call_id: &str,
    call_seq: u64,
    result_id: &str,
    result_seq: u64,
    session: &SessionEvidence,
    path: &str,
    sha256: &str,
) -> Map<String, Value> {
    let mut value = Map::new();
    for (key, item) in [
        ("schema", json!("loom.code-provenance.v1")),
        ("call_id", json!(call_id)),
        ("call_seq", json!(call_seq)),
        ("result_id", json!(result_id)),
        ("result_seq", json!(result_seq)),
        ("session", json!(session)),
        ("path", json!(path)),
        ("sha256", json!(sha256)),
    ] {
        value.insert(key.to_owned(), item);
    }
    value
}

fn validate_change(change: &ChangeEvidence) -> Result<()> {
    if change.schema != "loom.code-change.v1"
        || change.record_type != "dsh-tool-result"
        || change.name != CHANGE
        || change.path != PATH
    {
        bail!("change record has invalid schema, type, name or path");
    }
    ordered_event(
        change.call_seq,
        change.result_seq,
        change.session.observed_seq,
    )?;
    if change.previous_sha256 == change.sha256 {
        bail!("previous_sha256 must differ from sha256");
    }
    validate_common(
        &change.call_id,
        &change.result_id,
        &change.session,
        &change.previous_sha256,
        &change.sha256,
    )?;
    if change.size_bytes == 0 || change.size_bytes > MAX_SOURCE {
        bail!("size_bytes must be in 1..=32768");
    }
    Ok(())
}

fn validate_verify_reference(reference: &VerifyReference) -> Result<()> {
    if reference.record_type != "dsh-tool-result"
        || reference.name != VERIFY
        || reference.path != PATH
    {
        bail!("verification type, name or path is invalid");
    }
    ordered_event(
        reference.call_seq,
        reference.result_seq,
        reference.session.observed_seq,
    )?;
    validate_common(
        &reference.call_id,
        &reference.result_id,
        &reference.session,
        &reference.sha256,
        &reference.sha256,
    )?;
    uuid_text(
        &reference.code_change_artifact_id,
        "code_change_artifact_id",
    )?;
    Ok(())
}

fn validate_common(
    call_id: &str,
    result_id: &str,
    session: &SessionEvidence,
    previous: &str,
    current: &str,
) -> Result<()> {
    tool_id_text(call_id, "call_id")?;
    tool_id_text(result_id, "result_id")?;
    validate_session(session)?;
    sha_text(previous, "previous_sha256")?;
    sha_text(current, "sha256")?;
    Ok(())
}

fn validate_session(session: &SessionEvidence) -> Result<()> {
    if session.harness != "dsh"
        || session.host_api != "0.2.2-rc.3"
        || session.protocol != "dsh-session-log"
    {
        bail!("session requires the fixed harness, host_api and protocol");
    }
    uuid_text(&session.session_id, "session.session_id")
}

fn ordered_event(call_seq: u64, result_seq: u64, observed_seq: u64) -> Result<()> {
    const MAX_SAFE: u64 = (1_u64 << 53) - 1;
    if [call_seq, result_seq, observed_seq]
        .into_iter()
        .any(|value| value > MAX_SAFE)
    {
        bail!("call_seq, result_seq and observed_seq must be safe integers");
    }
    if result_seq <= call_seq {
        bail!("result_seq must be greater than call_seq");
    }
    if observed_seq < result_seq {
        bail!("session.observed_seq must be at least result_seq");
    }
    Ok(())
}

fn validate_body(body: &VerificationBody) -> Result<()> {
    if body.schema != "loom.code-verification.v1"
        || body.path != PATH
        || body.runner != "node:test"
        || body.cwd_scope != "authorized_project_root"
        || body.execution_status != "completed"
        || body.command.file != "node"
        || body.command.args != ["--test", "test/calc.test.js"]
    {
        bail!("verification body has invalid fixed schema, command or scope");
    }
    if body.previous_test_exit_code == 0 {
        bail!("previous_test_exit_code must be positive");
    }
    if body.passed != (body.exit_code == 0) {
        bail!("passed must equal exit_code == 0");
    }
    if body.stdout.len() > MAX_OUTPUT || body.stderr.len() > MAX_OUTPUT {
        bail!("stdout and stderr must each be at most 8192 bytes");
    }
    sha_text(&body.sha256, "sha256")?;
    uuid_text(&body.source_change_artifact_id, "source_change_artifact_id")?;
    tool_id_text(&body.edit_tool_result, "edit_tool_result")?;
    tool_id_text(&body.verification_tool_result, "verification_tool_result")?;
    validate_session(&body.dsh_session)
}

fn decode<T: serde::de::DeserializeOwned>(value: impl serde::Serialize, label: &str) -> Result<T> {
    if let Ok(text) = serde_json::to_string(&value) {
        // Keep denials to safe field/expectation messages, never raw payloads.
        serde_json::from_str(&text)
            .map_err(|_| anyhow::anyhow!("{label}: malformed fixed evidence shape"))
    } else {
        bail!("{label} must be valid JSON")
    }
}

fn exact_fields<'a>(record: &'a Value, label: &str) -> Result<&'a Map<String, Value>> {
    let fields = record
        .as_object()
        .with_context(|| format!("{label} must be an object"))?;
    let common = [
        "schema",
        "kind",
        "call_id",
        "call_seq",
        "result_id",
        "result_seq",
        "session",
        "path",
        "sha256",
    ];
    let expected = match fields.get("kind").and_then(Value::as_str) {
        Some("change") => [common.to_vec(), vec!["previous_sha256", "size_bytes"]].concat(),
        Some("verification") => [common.to_vec(), vec!["source_change_artifact_id"]].concat(),
        _ => bail!("code_evidence_json.kind must be change or verification"),
    };
    if fields.len() != expected.len() || !expected.iter().all(|key| fields.contains_key(*key)) {
        bail!("{label} must have exactly its selected public fields");
    }
    Ok(fields)
}

fn required_string<'a>(record: &'a Value, field: &str) -> Result<&'a str> {
    record
        .get(field)
        .and_then(Value::as_str)
        .with_context(|| format!("{field} must be a string"))
}
fn sequence(record: &Value, field: &str) -> Result<u64> {
    let value = record
        .get(field)
        .and_then(Value::as_u64)
        .with_context(|| format!("{field} must be a nonnegative safe integer"))?;
    if value > (1_u64 << 53) - 1 {
        bail!("{field} must be a safe integer");
    }
    Ok(value)
}
fn ordered(record: &Value) -> Result<()> {
    let call = sequence(record, "call_seq")?;
    let result = sequence(record, "result_seq")?;
    if call >= result {
        bail!("result_seq must be greater than call_seq");
    }
    let session = record
        .get("session")
        .and_then(Value::as_object)
        .context("session must be an object")?;
    let observed = sequence(&Value::Object(session.clone()), "observed_seq")?;
    if observed < result {
        bail!("session.observed_seq must be at least result_seq");
    }
    Ok(())
}
fn session(value: &Value) -> Result<SessionEvidence> {
    let session: SessionEvidence = decode(value.clone(), "session")?;
    validate_session(&session)?;
    Ok(session)
}
fn tool_id(record: &Value, field: &str) -> Result<()> {
    tool_id_text(required_string(record, field)?, field)
}
fn tool_id_text(value: &str, field: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        bail!("{field} must be a nonempty bounded ASCII tool identifier");
    }
    Ok(())
}
fn uuid(record: &Value, field: &str) -> Result<()> {
    uuid_text(required_string(record, field)?, field)
}
fn uuid_text(value: &str, field: &str) -> Result<()> {
    uuid::Uuid::parse_str(value).with_context(|| format!("{field} must be a real UUID"))?;
    Ok(())
}
fn sha(record: &Value, field: &str) -> Result<()> {
    sha_text(required_string(record, field)?, field)
}
fn sha_text(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be 64 lowercase hexadecimal characters");
    }
    Ok(())
}

/// PRE-check for the existing Report transaction. This is read-only: it does
/// not mutate SQLite/Artifacts, issue a Grant, run Git/tests/shell, or infer a
/// parent/source relationship. The generic Report ownership and unknown-effect
/// rules remain in force in `api.rs`.
pub fn validate_outcome(
    store: &Store,
    ticket_id: &str,
    assignment_id: &str,
    artifact_ids: &[Value],
    effects: &[Value],
    state: &str,
) -> Result<()> {
    let scoped = store.query(
        "SELECT * FROM artifacts WHERE ticket_id=?1 AND assignment_id=?2 ORDER BY id",
        rusqlite::params![ticket_id, assignment_id],
    )?;
    let assignment = store.query(
        "SELECT node_id FROM assignments WHERE id=?1 AND ticket_id=?2",
        rusqlite::params![assignment_id, ticket_id],
    )?;
    let assignment = assignment.first();
    let nonlocal_projection = artifact_ids.iter().any(|id| {
        let Some(id) = id.as_str() else { return false };
        let nominated = store.query(
            "SELECT ticket_id,assignment_id,code_evidence_json FROM artifacts WHERE id=?1",
            [id],
        );
        nominated.is_ok_and(|rows| {
            rows.first().is_some_and(|row| {
                !row["code_evidence_json"].is_null()
                    && (row["ticket_id"] != ticket_id || row["assignment_id"] != assignment_id)
            })
        })
    });
    if nonlocal_projection {
        bail!("Report cites code evidence outside its exact Ticket and Assignment scope");
    }
    let mut projected = Vec::new();
    for row in scoped {
        if let Some(value) = projection(&row)? {
            projected.push((row, value));
        }
    }
    if projected.is_empty() {
        return Ok(());
    }
    if projected.len() != 2 || artifact_ids.len() != 2 {
        bail!("code evidence requires exactly one linked change and verification pair");
    }
    let mut ids = std::collections::BTreeSet::new();
    for id in artifact_ids {
        let Some(id) = id.as_str() else {
            bail!("artifact_ids must contain UUID strings");
        };
        if !ids.insert(id) || !projected.iter().any(|(row, _)| row["id"] == id) {
            bail!("Report must nominate each projected Artifact exactly once and no other set");
        }
    }
    let changes: Vec<_> = projected
        .iter()
        .filter(|(_, proof)| proof["kind"] == "change")
        .collect();
    let verifications: Vec<_> = projected
        .iter()
        .filter(|(_, proof)| proof["kind"] == "verification")
        .collect();
    if changes.len() != 1 || verifications.len() != 1 {
        bail!("code evidence requires one change and one verification");
    }
    let (change_row, change) = changes[0];
    let (verify_row, verify) = verifications[0];
    // The API authenticates the same Assignment/Node before entering this helper.
    let node = assignment
        .and_then(|assignment| assignment["node_id"].as_str())
        .context("code evidence Assignment or origin Node scope is invalid")?;
    if !projected.iter().all(|(row, _)| {
        row["ticket_id"] == ticket_id
            && row["assignment_id"] == assignment_id
            && row["origin_node_id"] == node
    }) || change_row["origin_node_id"] != verify_row["origin_node_id"]
    {
        bail!("code evidence Artifact ticket, assignment or origin_node_id scope differs");
    }
    let change_id = change_row["id"]
        .as_str()
        .context("change Artifact id is required")?;
    if verify["source_change_artifact_id"] != change_id {
        bail!("verification must reference the exact change Artifact UUID");
    }
    for (field, expected) in [
        ("path", PATH),
        ("sha256", change["sha256"].as_str().unwrap()),
    ] {
        if change[field] != expected || verify[field] != expected {
            bail!("change and verification path/source hash must match");
        }
    }
    // Each record observes its own event position (e.g. edit 12, test 17).
    // Compare identity/protocol, not the unrelated per-result observed_seq.
    let change_session: SessionEvidence = decode(change["session"].clone(), "change session")?;
    let verify_session: SessionEvidence = decode(verify["session"].clone(), "verify session")?;
    for field in ["harness", "session_id", "host_api", "protocol"] {
        if change["session"][field] != verify["session"][field] {
            bail!("change and verification must share the same DSH session identity");
        }
    }
    ordered_event(
        change["call_seq"].as_u64().unwrap_or_default(),
        change["result_seq"].as_u64().unwrap_or_default(),
        change_session.observed_seq,
    )?;
    ordered_event(
        verify["call_seq"].as_u64().unwrap_or_default(),
        verify["result_seq"].as_u64().unwrap_or_default(),
        verify_session.observed_seq,
    )?;
    if change["result_seq"].as_u64().unwrap_or_default()
        >= verify["call_seq"].as_u64().unwrap_or_default()
    {
        bail!("verification must be called strictly after the source edit result");
    }
    if change["session"]["observed_seq"] != json!(change_session.observed_seq)
        || verify["session"]["observed_seq"] != json!(verify_session.observed_seq)
    {
        bail!("session observed_seq must remain an exact bounded integer");
    }
    let ticket = store
        .get("tickets", ticket_id)?
        .context("code evidence Ticket not found")?;
    if ticket["kind"] != "edit_file" || ticket["relative_path"] != PATH {
        bail!("code evidence requires the existing edit_file scope exactly at src/calc.js");
    }
    let content = ticket["content"]
        .as_str()
        .context("Ticket.content bytes are required for code evidence")?
        .as_bytes();
    if content.is_empty() || content.len() > MAX_SOURCE as usize {
        bail!("Ticket.content must be bounded source bytes");
    }
    if change["sha256"] != crate::sha256(content)
        || change["size_bytes"].as_u64() != Some(content.len() as u64)
    {
        bail!("change source hash and size must match exact Ticket.content bytes");
    }
    if change["previous_sha256"] == change["sha256"] {
        bail!("previous_sha256 must differ from current source sha256");
    }
    let bytes = verification_artifact(store, verify_row)?;
    let raw: Value =
        serde_json::from_slice(&bytes).context("verification body must be valid JSON")?;
    let body: VerificationBody = decode(raw, "verification body")?;
    validate_body(&body)?;
    if body.source_change_artifact_id != change_id
        || body.edit_tool_result != change["result_id"].as_str().unwrap_or_default()
        || body.verification_tool_result != verify["result_id"].as_str().unwrap_or_default()
        || body.path != PATH
        || body.sha256 != change["sha256"].as_str().unwrap_or_default()
        || body.dsh_session != verify_session
    {
        bail!("verification body must exactly match both projections, source and session");
    }
    let matching: Vec<_> = effects
        .iter()
        .filter(|effect| effect_has_known_evidence(effect))
        .collect();
    if effects.len() != 1 || matching.len() != 1 {
        bail!("code evidence requires exactly one code-change Effect");
    }
    let effect = matching[0];
    let effect_status = effect["status"].as_str().unwrap_or_default();
    if (state == "unknown" && effect_status != "unknown")
        || (state != "unknown" && effect_status != "confirmed")
    {
        bail!(
            "code evidence Effect status must preserve the report's unknown or confirmed outcome"
        );
    }
    if effect["artifacts"] != json!([change_id]) {
        bail!("confirmed Effect.artifacts must contain only the change Artifact UUID");
    }
    let evidence = bounded_effect_evidence(effect)?;
    if evidence.len() != 1 {
        bail!("Effect.evidence must contain exactly one code-change record");
    }
    let evidence: EffectEvidence = decode(evidence[0].clone(), "Effect evidence")?;
    validate_change(&evidence.change)?;
    if serde_json::to_value(&evidence.change)?
        != json!({
            "schema":"loom.code-change.v1", "type":"dsh-tool-result", "name":CHANGE,
            "call_id":change["call_id"], "call_seq":change["call_seq"],
            "result_id":change["result_id"], "result_seq":change["result_seq"],
            "session":change["session"], "path":change["path"],
            "previous_sha256":change["previous_sha256"], "sha256":change["sha256"],
            "size_bytes":change["size_bytes"],
        })
        || evidence.verification_artifact_id != verify_row["id"].as_str().unwrap_or_default()
        || evidence.test_tool_result_id != verify["result_id"].as_str().unwrap_or_default()
        || evidence.test_exit_code != body.exit_code
    {
        bail!("Effect evidence must exactly agree with both public projections");
    }
    uuid_text(
        &evidence.verification_artifact_id,
        "verification_artifact_id",
    )?;
    if (body.passed && !matches!(state, "succeeded" | "unknown"))
        || (!body.passed && !matches!(state, "failed" | "unknown"))
    {
        bail!("verification exit code and requested Report state disagree");
    }
    // Deliberately no promotion: api.rs still rejects unknown + confirmed.
    Ok(())
}

fn effect_has_known_evidence(effect: &Value) -> bool {
    bounded_effect_evidence(effect).is_ok_and(|records| {
        records.iter().any(|record| {
            record.get("schema") == Some(&json!("loom.code-change.v1"))
                || record
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| matches!(name, CHANGE | VERIFY))
        })
    })
}

fn bounded_effect_evidence(effect: &Value) -> Result<Vec<Value>> {
    let value = match effect.get("evidence") {
        Some(Value::String(text)) => {
            if text.len() > 32_768 {
                bail!("Effect.evidence exceeds its byte bound");
            }
            serde_json::from_str::<Value>(text)
                .context("Effect.evidence must be valid bounded JSON")?
        }
        Some(Value::Array(_)) | Some(Value::Object(_)) => effect["evidence"].clone(),
        _ => bail!("Effect.evidence must be a JSON string, array or one object"),
    };
    if value.to_string().len() > 32_768 {
        bail!("Effect.evidence exceeds its byte bound");
    }
    match value {
        Value::Array(records) => Ok(records),
        Value::Object(_) => Ok(vec![value]),
        _ => bail!("Effect.evidence must contain JSON objects"),
    }
}

fn verification_artifact(store: &Store, row: &Value) -> Result<Vec<u8>> {
    let storage = row["storage_name"]
        .as_str()
        .context("verification storage_name is required")?;
    let path = Path::new(storage);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || path.components().count() != 1
    {
        bail!("verification storage_name must be one ordinary relative filename");
    }
    let file = store.root.join("artifacts").join(path);
    let metadata =
        std::fs::symlink_metadata(&file).context("verification Artifact storage unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 128 * 1024 {
        bail!("verification Artifact must be a bounded ordinary non-symlink file");
    }
    let bytes = std::fs::read(file).context("verification Artifact bytes unavailable")?;
    if row["sha256"].as_str() != Some(crate::sha256(&bytes).as_str()) {
        bail!("verification Artifact bytes do not match immutable row.sha256");
    }
    if row["size_bytes"].as_u64() != Some(bytes.len() as u64) {
        bail!("verification Artifact size does not match actual bytes");
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    const CORRECTED: &str = "export function add(a, b) {\n  return a + b;\n}\n";
    const CHANGE_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const VERIFY_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SESSION: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    const CHANGE_FIELDS: [&str; 12] = [
        "schema",
        "type",
        "name",
        "call_id",
        "call_seq",
        "result_id",
        "result_seq",
        "session",
        "path",
        "previous_sha256",
        "sha256",
        "size_bytes",
    ];
    fn session(observed: u64) -> Value {
        json!({"harness":"dsh","session_id":SESSION,"host_api":"0.2.2-rc.3","protocol":"dsh-session-log","observed_seq":observed})
    }
    fn change() -> Value {
        json!({"schema":"loom.code-change.v1","type":"dsh-tool-result","name":CHANGE,
            "call_id":"loom_fixture_code_edit-loom-stub-1","call_seq":10,
            "result_id":"edit-result-loom-stub-1","result_seq":11,"session":session(12),
            "path":PATH,"previous_sha256":crate::sha256(b"export function add(a, b) {\n  return a - b;\n}\n"),
            "sha256":crate::sha256(CORRECTED),"size_bytes":CORRECTED.len()})
    }
    fn reference() -> Value {
        json!({"type":"dsh-tool-result","name":VERIFY,"call_id":"loom_fixture_verify-loom-stub-1",
            "call_seq":16,"result_id":"verify-result-loom-stub-1","result_seq":17,
            "session":session(17),"code_change_artifact_id":CHANGE_ID,"path":PATH,"sha256":crate::sha256(CORRECTED)})
    }
    fn body(passed: bool) -> Value {
        json!({"schema":"loom.code-verification.v1","path":PATH,"sha256":crate::sha256(CORRECTED),
            "source_change_artifact_id":CHANGE_ID,"edit_tool_result":"edit-result-loom-stub-1",
            "verification_tool_result":"verify-result-loom-stub-1",
            "command":{"file":"node","args":["--test","test/calc.test.js"]},"runner":"node:test",
            "cwd_scope":"authorized_project_root","execution_status":"completed",
            "exit_code":if passed {0} else {1},"passed":passed,"previous_test_exit_code":1,
            "stdout":if passed {"# pass 1\n"} else {"# fail 1\n"},"stderr":"","dsh_session":session(17)})
    }
    fn artifacts(passed: bool) -> (Vec<u8>, Vec<u8>) {
        (
            b"diff --git a/src/calc.js b/src/calc.js\n-  return a - b;\n+  return a + b;\n"
                .to_vec(),
            serde_json::to_vec_pretty(&body(passed)).unwrap(),
        )
    }
    fn fixture(passed: bool) -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let at = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','fixture','fixture-root','read_write',1,?1,'{}')",[&at]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','project','node','default','installation','[\"read\",\"write\"]',1,'digest',?1)",[&at]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('ticket','project','bounded fixture','edit_file',?1,?2,'running','grant','digest','node','installation','default',1,?3,?3)",params![PATH,CORRECTED,at]).unwrap();
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('assignment','ticket','node','default',1,'lease',1,'2099-01-01T00:00:00Z',?1)",[&at]).unwrap();
        let (diff, proof) = artifacts(passed);
        insert_artifact(
            &store,
            CHANGE_ID,
            "change.diff",
            "text/x-diff",
            &diff,
            &change(),
        );
        insert_artifact(
            &store,
            VERIFY_ID,
            "verification.json",
            "application/json",
            &proof,
            &reference(),
        );
        std::fs::write(
            directory
                .path()
                .join("artifacts")
                .join(format!("{CHANGE_ID}.artifact")),
            diff,
        )
        .unwrap();
        std::fs::write(
            directory
                .path()
                .join("artifacts")
                .join(format!("{VERIFY_ID}.artifact")),
            proof,
        )
        .unwrap();
        (directory, store)
    }
    fn insert_artifact(
        store: &Store,
        id: &str,
        name: &str,
        media: &str,
        bytes: &[u8],
        evidence: &Value,
    ) {
        let evidence = projected_metadata(&json!({"evidence":[evidence]})).unwrap();
        store.conn().execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at,code_evidence_json) VALUES(?1,'ticket','assignment','node',?2,?3,?4,?5,?6,?7,'[]',?8,?9)",
            params![id,name,media,bytes.len(),crate::sha256(bytes),format!("{id}.artifact"),format!("loom://artifact/{id}"),crate::now(),evidence]).unwrap();
    }
    fn effects(exit: i64) -> Vec<Value> {
        let mut evidence = change();
        evidence["verification_artifact_id"] = json!(VERIFY_ID);
        evidence["test_tool_result_id"] = json!("verify-result-loom-stub-1");
        evidence["test_exit_code"] = json!(exit);
        vec![
            json!({"effect_id":"effect-1","input_digest":"input","status":"confirmed","evidence":[evidence],"artifacts":[CHANGE_ID]}),
        ]
    }
    fn ids() -> Vec<Value> {
        vec![json!(CHANGE_ID), json!(VERIFY_ID)]
    }

    #[test]
    fn ordinary_metadata_is_unchanged_and_known_records_are_strict() {
        for metadata in [
            json!({}),
            json!({"name":"other"}),
            json!({"evidence":[]}),
            json!({"evidence":[{"name":"unrelated","host":"private"}]}),
        ] {
            assert_eq!(projected_metadata(&metadata).unwrap(), None);
        }
        for record in [
            {
                let mut v = change();
                v["host"] = json!("never project private host");
                v["path"] = json!("../../other");
                v
            },
            {
                let mut v = change();
                v.as_object_mut().unwrap().remove("call_seq");
                v
            },
            {
                let mut v = change();
                v["call_seq"] = json!(-1);
                v
            },
            {
                let mut v = change();
                v["previous_sha256"] = v["sha256"].clone();
                v
            },
            {
                let mut v = change();
                v["session"]["host_api"] = json!("https://private.invalid");
                v
            },
        ] {
            assert!(projected_metadata(&json!({"evidence":[record]})).is_err());
        }
        assert!(
            projected_metadata(&json!({"evidence":[reference(),{"name":"ordinary"}]})).is_err()
        );
        assert_eq!(
            projected_metadata(&json!({"evidence":{"kind":"legacy_metadata"}})).unwrap(),
            None
        );
        assert!(
            projected_metadata(&json!({"evidence":{"name":CHANGE,"secret":"forbidden"}})).is_err()
        );
        for (label, record) in [
            ("unsafe integer", {
                let mut v = change();
                v["call_seq"] = json!(9_007_199_254_740_992_u64);
                v
            }),
            ("wrong call name", {
                let mut v = change();
                v["call_id"] = json!("loom Fixture with whitespace");
                v
            }),
            ("large size", {
                let mut v = change();
                v["size_bytes"] = json!(32_769);
                v
            }),
            ("wrong host api", {
                let mut v = change();
                v["session"]["host_api"] = json!("0.2.1");
                v
            }),
            ("unknown session key", {
                let mut v = change();
                v["session"]["provider_url"] = json!("private");
                v
            }),
            ("wrong seq", {
                let mut v = change();
                v["result_seq"] = v["call_seq"].clone();
                v
            }),
        ] {
            let error =
                projected_metadata(&json!({"evidence":[{"name":CHANGE,"secret":"value"},record]}))
                    .err();
            assert!(
                error.is_some(),
                "{label} plus a known record must not drop an invalid record"
            );
            let error = projected_metadata(&json!({"evidence":[record]}))
                .unwrap_err()
                .to_string();
            assert!(
                !error.contains("private") && !error.contains("secret"),
                "{label} denial leaks a payload"
            );
        }
        let mut array = change();
        array["call_id"] = json!("a".repeat(129));
        assert!(projected_metadata(&json!({"evidence":[array]})).is_err());
        let mut uuid_upper = reference();
        uuid_upper["code_change_artifact_id"] = json!("invalid-parent");
        assert!(projected_metadata(&json!({"evidence":[uuid_upper]})).is_err());
    }

    #[test]
    fn projection_selects_exact_fields_and_matches_real_fixture_shape() {
        let original = change();
        let json = projected_metadata(&json!({"evidence":[original.clone()]}))
            .unwrap()
            .unwrap();
        assert_eq!(original, change());
        let projected: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(projected["schema"], "loom.code-provenance.v1");
        assert_eq!(projected["kind"], "change");
        assert_eq!(projected["size_bytes"], CORRECTED.len());
        assert_eq!(projected["call_id"], "loom_fixture_code_edit-loom-stub-1");
        assert!(projected.get("name").is_none());
        assert!(projected.get("metadata").is_none());
        let verification: Value = serde_json::from_str(
            &projected_metadata(&json!({"evidence":[reference()]}))
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(verification["source_change_artifact_id"], CHANGE_ID);
        assert_eq!(verification["result_seq"], 17);
        assert!(verification.get("schema").is_some());
        assert_eq!(
            projection(&json!({"code_evidence_json": &verification})).unwrap(),
            Some(verification)
        );
    }

    #[test]
    fn exact_byte_backed_pair_and_effect_pass_and_failure_are_valid() {
        for (passed, state) in [(true, "succeeded"), (false, "failed")] {
            let (_directory, store) = fixture(passed);
            validate_outcome(
                &store,
                "ticket",
                "assignment",
                &ids(),
                &effects(if passed { 0 } else { 1 }),
                state,
            )
            .unwrap();
            // The helper never upgrade unknown; the existing generic Report gate does that rejection.
            assert!(validate_outcome(
                &store,
                "ticket",
                "assignment",
                &ids(),
                &effects(0),
                "running"
            )
            .is_err());
        }
        let (_directory, store) = fixture(true);
        let mut uncertain = effects(0);
        uncertain[0]["status"] = json!("unknown");
        validate_outcome(
            &store,
            "ticket",
            "assignment",
            &ids(),
            &uncertain,
            "unknown",
        )
        .unwrap();
        assert!(validate_outcome(
            &store,
            "ticket",
            "assignment",
            &ids(),
            &effects(0),
            "unknown"
        )
        .is_err());
    }

    #[test]
    fn legacy_and_unrelated_outcomes_remain_no_op() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        validate_outcome(&store, "absent", "absent", &[], &[], "succeeded").unwrap();
        let (_directory, store) = fixture(true);
        store
            .conn()
            .execute("UPDATE artifacts SET code_evidence_json=NULL", [])
            .unwrap();
        validate_outcome(&store, "ticket", "assignment", &[], &[], "succeeded").unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) SELECT 'other',project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at FROM tickets WHERE id='ticket'",[]).unwrap();
        store
            .conn()
            .execute("UPDATE artifacts SET ticket_id='other'", [])
            .unwrap();
        validate_outcome(&store, "ticket", "assignment", &[], &[], "succeeded").unwrap();
    }

    #[test]
    fn incomplete_unlinked_or_cross_scope_projections_are_rejected() {
        let (_directory, store) = fixture(true);
        assert!(validate_outcome(
            &store,
            "ticket",
            "assignment",
            &[],
            &effects(0),
            "succeeded"
        )
        .is_err());
        for (label, sql, submitted) in [
            (
                "one projected row",
                "DELETE FROM artifacts WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'",
                ids(),
            ),
            (
                "different pair node",
                "UPDATE artifacts SET origin_node_id='other-node' WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
                ids(),
            ),
        ] {
            let (_directory, store) = fixture(true);
            store.conn().execute(sql, []).unwrap();
            assert!(
                validate_outcome(
                    &store,
                    "ticket",
                    "assignment",
                    &submitted,
                    &effects(0),
                    "succeeded"
                )
                .is_err(),
                "{label}"
            );
        }
        for bad in [
            vec![json!(CHANGE_ID)],
            vec![json!(VERIFY_ID)],
            vec![json!(CHANGE_ID), json!(CHANGE_ID)],
        ] {
            let (_directory, store) = fixture(true);
            assert!(validate_outcome(
                &store,
                "ticket",
                "assignment",
                &bad,
                &effects(0),
                "succeeded"
            )
            .is_err());
        }
    }

    #[test]
    fn every_effect_field_and_artifact_relation_must_match() {
        for field in CHANGE_FIELDS {
            let (_directory, store) = fixture(true);
            let mut submitted = effects(0);
            submitted[0]["evidence"][0][field] = match field {
                "type" => json!("dsh-session-log"),
                "name" => json!(VERIFY),
                "schema" => json!("loom.code-change.v2"),
                "call_id" => json!("different-call"),
                "call_seq" => json!(9),
                "result_id" => json!("different-edit-result"),
                "result_seq" => json!(12),
                "session" => session(13),
                "path" => json!("test/calc.test.js"),
                "previous_sha256" | "sha256" => json!(crate::sha256(b"substitute")),
                "size_bytes" => json!(CORRECTED.len() + 1),
                _ => unreachable!(),
            };
            assert!(
                validate_outcome(
                    &store,
                    "ticket",
                    "assignment",
                    &ids(),
                    &submitted,
                    "succeeded"
                )
                .is_err(),
                "{field}"
            );
        }
        let (_directory, store) = fixture(true);
        let mut wrong = reference();
        wrong["session"]["observed_seq"] = json!(99);
        store
            .conn()
            .execute(
                "UPDATE artifacts SET code_evidence_json=?1 WHERE id=?2",
                params![
                    projected_metadata(&json!({"evidence":[wrong]})).unwrap(),
                    VERIFY_ID
                ],
            )
            .unwrap();
        assert!(validate_outcome(
            &store,
            "ticket",
            "assignment",
            &ids(),
            &effects(0),
            "succeeded"
        )
        .is_err());
        // Ordinary per-record ordering is insufficient if verification can be
        // moved before the edit it purports to measure.
        for (call_seq, result_seq) in [(10, 11), (11, 16)] {
            let (_directory, store) = fixture(true);
            let mut verify = reference();
            verify["call_seq"] = json!(call_seq);
            verify["result_seq"] = json!(result_seq);
            store
                .conn()
                .execute(
                    "UPDATE artifacts SET code_evidence_json=?1 WHERE id=?2",
                    params![
                        projected_metadata(&json!({"evidence":[verify]})).unwrap(),
                        VERIFY_ID
                    ],
                )
                .unwrap();
            assert!(validate_outcome(
                &store,
                "ticket",
                "assignment",
                &ids(),
                &effects(0),
                "succeeded"
            )
            .is_err());
        }
        for (label, mutate) in [
            ("unknown evidence field", "unknown"),
            ("unknown session identity", "session"),
            ("wrong verification id", "identity"),
            ("wrong output limit", "output"),
            ("not confirmed", "status"),
            ("additional effect", "count"),
        ] {
            let (_directory, store) = fixture(true);
            let mut submitted = effects(0);
            match mutate {
                "unknown" => submitted[0]["evidence"][0]["new_private"] = json!("never accept"),
                "session" => {
                    submitted[0]["evidence"][0]["session"]["session_id"] =
                        json!("dddddddd-dddd-4ddd-8ddd-dddddddddddd")
                }
                "identity" => {
                    submitted[0]["evidence"][0]["verification_artifact_id"] = json!(CHANGE_ID)
                }
                "output" => submitted[0]["evidence"][0]["test_exit_code"] = json!(1),
                "status" => submitted[0]["status"] = json!("recorded"),
                _ => {}
            }
            if mutate == "count" {
                submitted.push(submitted[0].clone());
            }
            assert!(
                validate_outcome(
                    &store,
                    "ticket",
                    "assignment",
                    &ids(),
                    &submitted,
                    "succeeded"
                )
                .is_err(),
                "{label}"
            );
        }
    }

    #[test]
    fn unknown_remains_for_generic_report_rejection_without_promotion() {
        let (_directory, store) = fixture(true);
        let mut uncertain = effects(0);
        uncertain[0]["status"] = json!("unknown");
        validate_outcome(
            &store,
            "ticket",
            "assignment",
            &ids(),
            &uncertain,
            "unknown",
        )
        .unwrap();
        let promoted = effects(0);
        assert!(
            validate_outcome(&store, "ticket", "assignment", &ids(), &promoted, "unknown").is_err()
        );
        assert!(validate_outcome(
            &store,
            "ticket",
            "assignment",
            &ids(),
            &uncertain,
            "running"
        )
        .is_err());
        // Existing generic api.rs rejects this particular draft with "effect_unknown";
        // validate_outcome never upgrades it to succeeded/failed or grants confidence.
    }

    #[test]
    fn validation_never_creates_grant_or_additional_file_effect() {
        let (_directory, store) = fixture(false);
        let file = store
            .root
            .join("artifacts")
            .join(format!("{VERIFY_ID}.artifact"));
        let before = std::fs::read(&file).unwrap();
        validate_outcome(
            &store,
            "ticket",
            "assignment",
            &ids(),
            &effects(1),
            "failed",
        )
        .unwrap();
        assert_eq!(store.query("SELECT * FROM grants", []).unwrap().len(), 1);
        assert!(store.query("SELECT * FROM effects", []).unwrap().is_empty());
        assert_eq!(std::fs::read(file).unwrap(), before);
    }

    #[test]
    fn tampered_bytes_and_unknown_verification_fields_are_rejected() {
        for mutation in ["hash", "unknown"] {
            let (_directory, store) = fixture(true);
            let mut corrupted = body(true);
            if mutation == "unknown" {
                corrupted["private_environment"] = json!("must-not-be-accepted");
            } else {
                corrupted["exit_code"] = json!(1);
            }
            let bytes = serde_json::to_vec(&corrupted).unwrap();
            if mutation == "hash" {
                store
                    .conn()
                    .execute(
                        "UPDATE artifacts SET sha256=?1 WHERE id=?2",
                        params![crate::sha256(&bytes), VERIFY_ID],
                    )
                    .unwrap();
            }
            std::fs::write(
                store
                    .root
                    .join("artifacts")
                    .join(format!("{VERIFY_ID}.artifact")),
                bytes,
            )
            .unwrap();
            if mutation == "hash" {
                store
                    .conn()
                    .execute(
                        "UPDATE artifacts SET sha256=?1 WHERE id=?2",
                        params![crate::sha256(b"different"), VERIFY_ID],
                    )
                    .unwrap();
            }
            assert!(
                validate_outcome(
                    &store,
                    "ticket",
                    "assignment",
                    &ids(),
                    &effects(0),
                    "succeeded"
                )
                .is_err(),
                "{mutation}"
            );
        }
    }
}
