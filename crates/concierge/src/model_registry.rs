//! A bounded source descriptor registry and placement authorization ledger.
//! Neither registration nor authorization schedules, installs or runs a model.
use crate::api::ApiError;
use crate::store::{audit_tx_plan, Store};
use axum::http::StatusCode;
use rusqlite::{params, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
// Only referenced Artifact blobs are opened—never a source directory/path.

const MAX_BYTES: u64 = 8192;
fn bad(code: &'static str, message: &'static str) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, code, message)
}
fn denied(code: &'static str, message: &'static str) -> ApiError {
    ApiError::denied(code, message)
}
fn conflict(code: &'static str, message: &'static str) -> ApiError {
    ApiError::conflict(code, message)
}
fn unknown(message: &'static str) -> ApiError {
    ApiError::missing(message)
}
fn policy() -> Value {
    json!({
        "schema":"loom.model-registry.v1", "supported_source":"model_descriptor_complete_proof_artifact",
        "supported_provider":"fixture-local-text", "activation":false,
        "executable":false, "generation_observed":false, "runtime_executed":false,
        "placement_operation":"place_model", "location":"local_only",
        "authorize_does_not_install_or_execute":true,
        "not_supported":["model_loading","model_inference","model_download","model_weights","image_generation","remote_delivery"]
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterInput {
    schema: String,
    source_ticket_id: String,
    source_artifact_id: String,
    worker_id: String,
    reviewed_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Descriptor {
    schema: String,
    provider: String,
    revision: String,
    input_modalities: Vec<String>,
    local_only: bool,
    relative_path: String,
    source_kind: String,
    source_sha256: String,
    source_document: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginalDescriptor {
    schema: String,
    provider: String,
    revision: String,
    input_modalities: Vec<String>,
    local_only: bool,
}
// `OriginalDescriptor` prevents preview/action fields from entering source metadata.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantInput {
    grant_id: String,
    worker_id: String,
    node_id: Option<String>,
    installation_id: Option<String>,
    reviewed_sha256: String,
}
fn bounded_id(value: &str) -> Result<&str, ApiError> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
    {
        Ok(value)
    } else {
        Err(bad(
            "invalid_identifier",
            "Identity must be a bounded logical ID",
        ))
    }
}
fn worker_id(value: &str) -> Result<&str, ApiError> {
    bounded_id(value).and_then(|value| {
        loom_protocol::WorkerId::parse(value)
            .map(|_| value)
            .map_err(|_| {
                bad(
                    "invalid_worker",
                    "Worker identity is not a known bounded Worker",
                )
            })
    })
}
fn identifier(value: &str) -> Result<&str, ApiError> {
    if uuid::Uuid::parse_str(value).is_ok() {
        Ok(value)
    } else {
        Err(bad(
            "invalid_identifier",
            "Source identity must be a bounded UUID",
        ))
    }
}
fn digest(value: &str) -> Result<&str, ApiError> {
    if value.len() == 64
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
    {
        Ok(value)
    } else {
        Err(bad(
            "invalid_review_digest",
            "Review requires the exact full lowercase SHA-256 of the descriptor Artifact",
        ))
    }
}

/// The original descriptor-read Assignment ID is immutable registry evidence.
/// An Effect digest only corroborates this canonical logical-spec hash; it is
/// not its source, a source-file hash, proof SHA, or later invocation digest.
fn source_assignment_evidence(
    store: &Store,
    artifact_id: &str,
) -> Result<(String, String), ApiError> {
    let rows = store.query(
        "SELECT a.id,t.relative_path,t.node_id,a.attempt FROM assignments a JOIN tickets t ON t.id=a.ticket_id JOIN artifacts source ON source.ticket_id=t.id AND source.assignment_id=a.id WHERE source.id=?1",
        [artifact_id],
    )?;
    if rows.len() != 1 {
        return Err(denied(
            "source_assignment",
            "Exactly one actual source Assignment must back the descriptor Artifact",
        ));
    }
    let row = &rows[0];
    let assignment_id = row["id"].as_str().unwrap_or_default();
    bounded_id(assignment_id)?;
    if row["relative_path"] != "model.json"
        || row["attempt"].as_i64().is_none_or(|attempt| attempt <= 0)
    {
        return Err(denied(
            "source_assignment_scope",
            "Descriptor Assignment must match the original single-attempt model.json read",
        ));
    }
    // This is the actual JS local input specification: model_descriptor reads
    // have a persisted NULL content. It is not the source Document or file SHA.
    let canonical = format!(
        "{{\"assignment_id\":{},\"kind\":\"model_descriptor\",\"path\":\"model.json\",\"content\":null}}",
        serde_json::to_string(assignment_id)
            .map_err(|_| bad("invalid_identifier", "Assignment ID cannot be encoded"))?
    );
    let source_assignment_digest = crate::sha256(canonical.as_bytes());
    let effects = store.query(
        "SELECT id,input_digest FROM effects WHERE assignment_id=?1 AND ticket_id=(SELECT ticket_id FROM artifacts WHERE id=?2) AND node_id=?3 AND attempt=?4 AND status='confirmed'",
        params![assignment_id, artifact_id, row["node_id"].as_str().unwrap_or_default(),row["attempt"].as_i64().unwrap_or_default()],
    )?;
    if effects.is_empty()
        || effects
            .iter()
            .any(|effect| effect["input_digest"].as_str() != Some(&source_assignment_digest))
    {
        return Err(denied(
            "source_assignment_evidence",
            "The completed source Report must corroborate the canonical source Assignment input digest with every confirmed Effect",
        ));
    }
    Ok((assignment_id.to_owned(), source_assignment_digest))
}

fn descriptor_sha_actual(
    store: &Store,
    input: &RegisterInput,
) -> Result<(Value, Value, String, String), ApiError> {
    let ticket = store
        .get("tickets", &input.source_ticket_id)?
        .ok_or(unknown("Source Ticket is not registered"))?;
    let artifact = store
        .get("artifacts", &input.source_artifact_id)?
        .ok_or(unknown("Source Artifact is not registered"))?;
    if artifact["ticket_id"] != ticket["id"]
        || artifact["origin_node_id"] != ticket["node_id"]
        || artifact["assignment_id"]
            .as_str()
            .is_none_or(|id| id.is_empty())
        || ticket["status"] != "succeeded"
        || ticket["kind"] != "model_descriptor"
        || ticket["cancel_requested"] == true
        || input.worker_id != ticket["worker_id"].as_str().unwrap_or_default()
    {
        return Err(denied(
            "source_scope",
            "Descriptor needs its own completed model_descriptor Artifact and matching Worker",
        ));
    }
    let artifact_assignment = artifact["assignment_id"].as_str().unwrap_or_default();
    let (source_assignment_id, assignment_digest) =
        source_assignment_evidence(store, &input.source_artifact_id)?;
    let evidence = store.query("SELECT id,state,cancel_acknowledged FROM reports WHERE ticket_id=?1 AND assignment_id=?2 AND node_id=?3 AND state='succeeded' ORDER BY rowid DESC LIMIT 1", params![ticket["id"].as_str().unwrap_or_default(),artifact_assignment,ticket["node_id"].as_str().unwrap_or_default()])?;
    if evidence.is_empty() {
        return Err(denied(
            "source_report",
            "Descriptor requires a completed source Report",
        ));
    }
    let grant = store
        .get("grants", ticket["grant_id"].as_str().unwrap_or_default())?
        .ok_or(denied(
            "source_grant_revoked",
            "The original descriptor-read Grant must remain current",
        ))?;
    if grant["revoked_at"] != Value::Null
        || grant["operations"]
            .as_array()
            .is_none_or(|operations| !operations.contains(&json!("read")))
    {
        return Err(denied("source_grant_revoked", "An active ordinary read Grant is required for descriptor provenance; model placement is separate"));
    }
    let binding = current_binding(
        store,
        ticket["project_id"].as_str().unwrap_or_default(),
        ticket["node_id"].as_str().unwrap_or_default(),
        ticket["installation_id"].as_str().unwrap_or_default(),
        &input.worker_id,
    )?;
    if binding["id"] != grant["project_binding_id"] {
        return Err(denied(
            "source_binding_scope",
            "Original descriptor and Grant do not share the exact current binding",
        ));
    }
    verify_current_node(store, &grant, &input.worker_id)?;
    let bytes = verified_artifact_bytes(store, &artifact)?;
    let actual_sha = crate::sha256(&bytes);
    if actual_sha != input.reviewed_sha256 {
        return Err(denied(
            "review_hash_mismatch",
            "Reviewed SHA does not match the real source Artifact bytes",
        ));
    }
    let descriptor: Descriptor = serde_json::from_slice(&bytes).map_err(|_| {
        bad(
            "invalid_descriptor",
            "Only the explicit local model descriptor is supported",
        )
    })?;
    if descriptor.schema != "loom.model-descriptor.v1"
        || descriptor.provider != "fixture-local-text"
        || descriptor.revision != "v1"
        || descriptor.input_modalities != ["text"]
        || !descriptor.local_only
        || descriptor.relative_path != "model.json"
        || ticket["relative_path"] != descriptor.relative_path
        || descriptor.source_kind != "explicit_local_artifact_descriptor"
        || descriptor.source_sha256.len() != 64
        || !descriptor
            .source_sha256
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase() && c.is_ascii_hexdigit())
    {
        return Err(denied(
            "unsupported_descriptor",
            "Only the local-only text fixture v1 descriptor is supported",
        ));
    }
    if descriptor.source_document.len() > MAX_BYTES as usize
        || crate::sha256(descriptor.source_document.as_bytes()) != descriptor.source_sha256
    {
        return Err(denied(
            "source_digest_mismatch",
            "Source document bytes do not match the reported source SHA",
        ));
    }
    let source: OriginalDescriptor =
        serde_json::from_str(&descriptor.source_document).map_err(|_| {
            denied(
                "unsupported_descriptor",
                "Source document is not the exact supported JSON descriptor",
            )
        })?;
    if source.schema != "loom.model-descriptor.v1"
        || source.provider != "fixture-local-text"
        || source.revision != "v1"
        || source.input_modalities != ["text"]
        || !source.local_only
        || source.schema != descriptor.schema
        || source.provider != descriptor.provider
        || source.revision != descriptor.revision
        || source.input_modalities != descriptor.input_modalities
        || source.local_only != descriptor.local_only
    {
        return Err(denied(
            "unsupported_descriptor",
            "The source file must be the explicit local text descriptor",
        ));
    }
    let ticket_worker = ticket["worker_id"].as_str().unwrap_or_default().to_owned();
    let metadata = json!({
        "worker_id":ticket_worker, "node_id":ticket["node_id"],
        "installation_id":ticket["installation_id"], "project_id":ticket["project_id"],
        "source_ticket_id":ticket["id"], "source_artifact_id":artifact["id"],
        "source_kind":"explicit_local_artifact_descriptor",
        "source_assignment_digest":assignment_digest, "source_assignment_id":source_assignment_id
    });
    Ok((
        descriptor_json(&descriptor),
        metadata,
        actual_sha,
        assignment_digest,
    ))
}
fn verified_artifact_bytes(store: &Store, artifact: &Value) -> Result<Vec<u8>, ApiError> {
    if artifact["media_type"] != "application/json"
        || artifact["size_bytes"]
            .as_u64()
            .is_none_or(|size| size == 0 || size > MAX_BYTES)
    {
        return Err(denied(
            "descriptor_too_large",
            "Descriptor must be a bounded application/json Artifact",
        ));
    }
    identifier(
        artifact["storage_name"]
            .as_str()
            .and_then(|name| name.strip_suffix(".artifact"))
            .unwrap_or_default(),
    )?;
    let name = artifact["storage_name"].as_str().unwrap_or_default();
    if name != format!("{}.artifact", artifact["id"].as_str().unwrap_or_default()) {
        return Err(denied(
            "artifact_storage_scope",
            "Artifact storage does not agree with the immutable ID",
        ));
    }
    let directory = store.root.join("artifacts");
    let path = directory.join(name);
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
        conflict(
            "artifact_unavailable",
            "Descriptor Artifact storage cannot be read",
        )
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_BYTES {
        return Err(denied(
            "artifact_storage_scope",
            "Only regular bounded Artifact storage is accepted",
        ));
    }
    let bytes = std::fs::read(path).map_err(|_| {
        conflict(
            "artifact_unavailable",
            "Descriptor Artifact cannot be loaded",
        )
    })?;
    if crate::sha256(&bytes) != artifact["sha256"].as_str().unwrap_or_default() {
        return Err(conflict(
            "artifact_integrity",
            "Artifact content no longer matches its immutable SHA",
        ));
    }
    Ok(bytes)
}
fn descriptor_json(_descriptor: &Descriptor) -> Value {
    json!({
        "schema":"loom.model-descriptor.v1", "provider":"fixture-local-text", "revision":"v1",
        "input_modalities":["text"], "local_only":true,
        "media_type":"application/vnd.loom.text-model-descriptor+json"
    })
}
fn model(store: &Store, id: &str) -> Result<Value, ApiError> {
    store
        .query("SELECT * FROM models WHERE id=?1", [id])?
        .into_iter()
        .next()
        .ok_or(unknown("Model registration not found"))
}
fn mutable(store: &mut Store) -> Result<Transaction<'_>, ApiError> {
    store.conn_mut().unchecked_transaction().map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "registry_storage",
            "Cannot begin the registry transaction",
        )
    })
}
pub(crate) fn register(store: &mut Store, body: &Value) -> Result<Value, ApiError> {
    let input: RegisterInput = deserialize(body)?;
    if input.schema != "loom.model-registry.v1" {
        return Err(bad(
            "unsupported_schema",
            "Only loom.model-registry.v1 is accepted",
        ));
    }
    bounded_id(&input.source_ticket_id)?;
    identifier(&input.source_artifact_id)?;
    worker_id(&input.worker_id)?;
    digest(&input.reviewed_sha256)?;
    let (descriptor, metadata, actual_sha, assignment_digest) =
        descriptor_sha_actual(store, &input)?;
    if let Some(existing) = store
        .query(
            "SELECT * FROM models WHERE source_artifact_id=?1 AND worker_id=?2",
            params![input.source_artifact_id, input.worker_id],
        )?
        .into_iter()
        .next()
    {
        if existing["descriptor_sha256"] != input.reviewed_sha256 {
            return Err(denied(
                "review_hash_mismatch",
                "The source Artifact cannot be admitted under a different reviewed SHA",
            ));
        }
        if existing["assignment_digest"].as_str() != Some(assignment_digest.as_str())
            || existing["source_assignment_id"].as_str()
                != metadata["source_assignment_id"].as_str()
        {
            return Err(denied(
                "source_assignment_digest",
                "Duplicate registration requires the unchanged source Assignment input_digest",
            ));
        }
        return Ok(json!({"model":view(store, &existing)?,"duplicate":true}));
    }
    let id = crate::id("model");
    let time = crate::now();
    let transaction = mutable(store)?;
    transaction.execute("INSERT INTO models(id,name,revision,location,placement_policy,status,created_at,updated_at,node_id,installation_id,worker_id,project_id,source_ticket_id,source_artifact_id,descriptor_json,descriptor_sha256,source_kind,assignment_digest,source_assignment_id) VALUES(?1,'fixture-text-descriptor','v1','local_only','place_model','registered',?2,?2,?3,?4,?5,?6,?7,?8,?9,?10,'explicit_local_artifact_descriptor',?11,?12)", params![id,time,metadata["node_id"].as_str().unwrap_or_default(),metadata["installation_id"].as_str().unwrap_or_default(),metadata["worker_id"].as_str().unwrap_or_default(),metadata["project_id"].as_str().unwrap_or_default(),input.source_ticket_id,input.source_artifact_id,descriptor.to_string(),actual_sha,assignment_digest,metadata["source_assignment_id"].as_str().unwrap_or_default()])?;
    audit_tx_plan(
        &transaction,
        "client",
        "model.descriptor.registered",
        &json!({"model_id":id,"source_ticket_id":input.source_ticket_id,"source_artifact_id":input.source_artifact_id,"descriptor_sha256":actual_sha,"source_assignment_id":metadata["source_assignment_id"],"source_assignment_digest":assignment_digest,"provider":"fixture-local-text","revision":"v1"}),
    )?;
    transaction.commit().map_err(|_| {
        conflict(
            "registry_commit_failed",
            "Model registration was not persisted",
        )
    })?;
    let record = model(store, &id)?;
    Ok(json!({"model":view(store,&record)?,"duplicate":false}))
}
fn current_binding(
    store: &Store,
    project: &str,
    node: &str,
    installation: &str,
    worker: &str,
) -> Result<Value, ApiError> {
    if project.is_empty()
        || node.is_empty()
        || installation.is_empty()
        || worker.is_empty()
        || worker == "*"
    {
        return Err(denied(
            "exact_worker_scope",
            "Exact project, installation and Worker scope must be known",
        ));
    }
    let bindings = store.query("SELECT * FROM project_bindings WHERE project_id=?1 AND node_id=?2 AND installation_id=?3 AND worker_id=?4 AND revoked_at IS NULL", [project,node,installation,worker])?;
    if bindings.len() != 1 {
        return Err(denied(
            "binding_scope",
            "Exactly one exact current ProjectBinding is required",
        ));
    }
    Ok(bindings[0].clone())
}
fn verify_current_node(store: &Store, grant: &Value, worker: &str) -> Result<(), ApiError> {
    let node = crate::maintenance::matching_physical_node(
        store,
        "read_summary",
        Some(grant["node_id"].as_str().unwrap_or_default()),
        grant,
        worker,
    )?
    .ok_or(denied(
        "source_node_unavailable",
        "The source Node/Grant is not current for a bounded worker",
    ))?;
    let binding = current_binding(
        store,
        grant["project_id"].as_str().unwrap_or_default(),
        node["id"].as_str().unwrap_or_default(),
        node["installation_id"].as_str().unwrap_or_default(),
        worker,
    )?;
    if grant["installation_id"] != node["installation_id"]
        || grant["project_binding_id"] != binding["id"]
    {
        Err(denied(
            "binding_scope",
            "Installed identity and Grant binding do not match",
        ))
    } else {
        Ok(())
    }
}
fn authority(store: &Store, id: &str, body: &Value) -> Result<(Value, Value, Value), ApiError> {
    let input: GrantInput = deserialize(body)?;
    digest(&input.reviewed_sha256)?;
    worker_id(&input.worker_id)?;
    let model = model(store, id)?;
    if model["assignment_digest"]
        .as_str()
        .is_none_or(|value| digest(value).is_err())
    {
        return Err(denied(
            "source_assignment_digest",
            "Legacy metadata rows need real source Assignment provenance before placement",
        ));
    }
    if model["status"] != "registered" || model["descriptor_sha256"] != input.reviewed_sha256 {
        return Err(denied(
            "model_not_registered",
            "Model is retired or review SHA is different",
        ));
    }
    if model["worker_id"] != input.worker_id
        || input
            .node_id
            .as_deref()
            .is_some_and(|node| node != model["node_id"].as_str().unwrap_or_default())
        || input
            .installation_id
            .as_deref()
            .is_some_and(|installation| {
                installation != model["installation_id"].as_str().unwrap_or_default()
            })
    {
        return Err(denied(
            "model_scope",
            "Placement permission applies to the descriptor's exact installed Worker",
        ));
    }
    let grant = store.get("grants", &input.grant_id)?.ok_or(denied(
        "placement_grant_scope",
        "A separate active place_model Grant is required",
    ))?;
    if grant["revoked_at"] != Value::Null || grant["project_id"] != model["project_id"] {
        return Err(denied(
            "placement_grant_scope",
            "Placement Grant must be current and in the same Project",
        ));
    }
    if grant["operations"]
        .as_array()
        .is_none_or(|operations| !operations.contains(&json!("place_model")))
    {
        return Err(denied(
            "place_model_required",
            "Read, write or invoke_text Grants cannot authorize model placement",
        ));
    }
    let binding = current_binding(
        store,
        model["project_id"].as_str().unwrap_or_default(),
        model["node_id"].as_str().unwrap_or_default(),
        model["installation_id"].as_str().unwrap_or_default(),
        &input.worker_id,
    )?;
    if grant["project_binding_id"] != binding["id"] {
        return Err(denied(
            "binding_scope",
            "Placement Grant must use the same current project root binding",
        ));
    }
    verify_current_node(store, &grant, &input.worker_id)?;
    Ok((model, grant, binding))
}
pub(crate) fn approve(store: &mut Store, id: &str, body: &Value) -> Result<Value, ApiError> {
    let (model, grant, binding) = authority(store, id, body)?;
    let existing = store.query(
        "SELECT * FROM model_placement_authorizations WHERE model_id=?1",
        [id],
    )?;
    if let Some(existing) = existing.first() {
        if existing["reviewed_model_digest"] != model["descriptor_sha256"]
            || existing["grant_id"] != grant["id"]
            || existing["worker_id"] != model["worker_id"]
            || existing["grant_digest"] != grant["digest"]
            || existing["accepted_state"] != "approved_for_placement"
            || existing["binding_id"] != binding["id"]
        {
            return Err(conflict(
                "placement_scope_conflict",
                "An existing approval cannot be swapped for another source or scope",
            ));
        }
        return Ok(json!({"authorization":approval_view(store,existing)?,"duplicate":true}));
    }
    let id_record = crate::id("mpa");
    let created_at = crate::now();
    let transaction = mutable(store)?;
    transaction.execute("INSERT INTO model_placement_authorizations(id,model_id,grant_id,grant_digest,project_id,binding_id,node_id,installation_id,worker_id,accepted_state,reviewed_model_digest,approved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'approved_for_placement',?10,?11)", params![id_record,id,grant["id"].as_str().unwrap_or_default(),grant["digest"].as_str().unwrap_or_default(),model["project_id"].as_str().unwrap_or_default(),binding["id"].as_str().unwrap_or_default(),model["node_id"].as_str().unwrap_or_default(),model["installation_id"].as_str().unwrap_or_default(),model["worker_id"].as_str().unwrap_or_default(),model["descriptor_sha256"].as_str().unwrap_or_default(),created_at])?;
    audit_tx_plan(
        &transaction,
        "client",
        "model.placement.approved",
        &json!({"model_id":id,"grant_id":grant["id"],"grant_digest":grant["digest"],"binding_id":binding["id"],"reviewed_descriptor_sha256":model["descriptor_sha256"]}),
    )?;
    transaction.commit().map_err(|_| {
        conflict(
            "registry_commit_failed",
            "Placement approval cannot be persisted",
        )
    })?;
    let record = store
        .query(
            "SELECT * FROM model_placement_authorizations WHERE id=?1",
            [&id_record],
        )?
        .into_iter()
        .next()
        .ok_or(conflict(
            "registry_commit_failed",
            "Verified authorization is not available",
        ))?;
    Ok(json!({"authorization":approval_view(store,&record)?,"duplicate":false}))
}
fn approval_view(store: &Store, record: &Value) -> Result<Value, ApiError> {
    let model = model(store, record["model_id"].as_str().unwrap_or_default())?;
    let grant = store.get("grants", record["grant_id"].as_str().unwrap_or_default())?;
    Ok(json!({
        "id":record["id"], "model_id":record["model_id"], "grant_id":record["grant_id"],
        "grant_digest":record["grant_digest"], "project_id":record["project_id"], "binding_id":record["binding_id"],
        "node_id":record["node_id"], "installation_id":record["installation_id"], "worker_id":record["worker_id"],
        "reviewed_sha256":record["reviewed_model_digest"], "location":"local_only",
        "source_assignment_digest":model["assignment_digest"],
        "status":record["accepted_state"], "activated":false, "executable":false,
        "was_runtime_executed":false, "generation_observed":false,
        "current":model["status"] == "registered" && grant.is_some_and(|grant| grant["revoked_at"].is_null() && grant["project_binding_id"] == record["binding_id"] && grant["operations"].as_array().is_some_and(|operations| operations.contains(&json!("place_model"))) && grant["digest"] == record["grant_digest"]),
        "approved_at":record["approved_at"]
    }))
}
pub(crate) fn place(store: &mut Store, id: &str, body: &Value) -> Result<Value, ApiError> {
    let (model, grant, binding) = authority(store, id, body)?;
    let records = store.query("SELECT * FROM model_placement_authorizations WHERE model_id=?1 AND grant_id=?2 AND binding_id=?3", [id,grant["id"].as_str().unwrap_or_default(),binding["id"].as_str().unwrap_or_default()])?;
    if records.len() != 1 {
        return Err(denied(
            "placement_approval_required",
            "Exactly one approval for this model digest, Grant and binding is required before placement",
        ));
    }
    let record = &records[0];
    if record["reviewed_model_digest"] != model["descriptor_sha256"]
        || record["grant_digest"] != grant["digest"]
        || record["project_id"] != model["project_id"]
        || record["node_id"] != model["node_id"]
        || record["installation_id"] != model["installation_id"]
        || record["worker_id"] != model["worker_id"]
        || record["accepted_state"] != "approved_for_placement"
    {
        return Err(denied(
            "placement_approval_scope",
            "Authorization must match the entire current registered placement scope",
        ));
    }
    let approval = approval_view(store, record)?;
    if approval["current"] != true {
        return Err(denied(
            "placement_authorization_revoked",
            "Previous authorization is history, not current permission",
        ));
    }
    if let Some(existing) = store.query("SELECT id,model_id,node_id,location,status,reported_at FROM model_placements WHERE model_id=?1 AND node_id=?2 AND grant_id=?3 AND binding_id=?4 ORDER BY reported_at DESC", params![id,model["node_id"].as_str().unwrap_or_default(),grant["id"].as_str().unwrap_or_default(),binding["id"].as_str().unwrap_or_default()])?.into_iter().find(|row| row["status"] == "approved_for_placement" && row["location"] == "local_only") {
        return Ok(json!({"placement":placement_view(id,&model,&grant,&binding,&existing),"duplicate":true}));
    }
    let placement_id = crate::id("mpl");
    let transaction = mutable(store)?;
    transaction.execute("INSERT INTO model_placements(id,model_id,node_id,location,status,reported_at,grant_id,binding_id) VALUES(?1,?2,?3,'local_only','approved_for_placement',?4,?5,?6)", params![placement_id,id,model["node_id"].as_str().unwrap_or_default(),crate::now(),grant["id"].as_str().unwrap_or_default(),binding["id"].as_str().unwrap_or_default()])?;
    audit_tx_plan(
        &transaction,
        "client",
        "model.placement.acknowledged",
        &json!({"model_id":id,"grant_id":grant["id"],"reviewed_descriptor_sha256":model["descriptor_sha256"],"source_assignment_digest":model["assignment_digest"],"runtime_executed":false}),
    )?;
    transaction.commit().map_err(|_| {
        conflict(
            "registry_commit_failed",
            "Placement receipt was not persisted",
        )
    })?;
    let placement = json!({
        "id":placement_id,"model_id":id,"grant_id":grant["id"],"grant_model":"place_model",
        "status":"approved_for_placement","description":"批准放置授权（未运行）",
        "worker_id":model["worker_id"],"node_id":model["node_id"],"installation_id":model["installation_id"],
        "location":"local_only","executable":false,"activated":false,
        "generation_observed":false,"was_runtime_executed":false,
        "binding_id":binding["id"],"source_assignment_digest":model["assignment_digest"]
    });
    Ok(json!({"placement":placement,"duplicate":false}))
}
fn placement_view(id: &str, model: &Value, grant: &Value, binding: &Value, row: &Value) -> Value {
    json!({
        "id":row["id"],"model_id":id,"grant_id":grant["id"],"grant_model":"place_model",
        "status":row["status"],"description":"批准放置授权（未运行）",
        "worker_id":model["worker_id"],"node_id":model["node_id"],"installation_id":model["installation_id"],
        "location":"local_only","executable":false,"activated":false,
        "generation_observed":false,"was_runtime_executed":false,
        "binding_id":binding["id"],"source_assignment_digest":model["assignment_digest"],"reported_at":row["reported_at"]
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelBindingInput {
    schema: String,
    model_id: String,
    placement_id: String,
    placement_sha256: String,
    source_artifact_id: String,
    source_ticket_id: String,
    placement_grant_id: String,
    placement_grant_digest: String,
    project_id: String,
    node_id: String,
    installation_id: String,
    worker_id: String,
    source_assignment_digest: String,
}

/// Revalidate registration facts for a later, separately authorized invocation.
/// The catalog check observes only the stored, authenticated Node heartbeat.
/// It never probes the SDK, renews time, performs discovery or creates a Grant.
/// The caller adds the subsequent invocation permission check; this observation
/// precondition alone is not execution permission. The caller has already
/// matched the current Assignment/Grant; this is the model precondition.
pub(crate) fn bound_for_invocation(store: &Store, assignment: &Value) -> Result<Value, ApiError> {
    let binding: ModelBindingInput =
        deserialize(assignment.get("model_binding").ok_or_else(|| {
            bad(
                "invalid_model_binding",
                "A strict loom.model-binding.v1 object is required",
            )
        })?)?;
    if binding.schema != "loom.model-binding.v1" {
        return Err(bad(
            "unsupported_model_binding",
            "Only loom.model-binding.v1 is supported",
        ));
    }
    for id in [
        &binding.model_id,
        &binding.placement_id,
        &binding.source_ticket_id,
        &binding.placement_grant_id,
        &binding.project_id,
        &binding.node_id,
        &binding.installation_id,
        &binding.worker_id,
    ] {
        bounded_id(id)?;
    }
    identifier(&binding.source_artifact_id)?;
    digest(&binding.placement_sha256)?;
    digest(&binding.source_assignment_digest)?;
    digest(&binding.placement_grant_digest)?;
    let source_ticket = store
        .get("tickets", &binding.source_ticket_id)?
        .ok_or(denied(
            "source_ticket_scope",
            "Source Ticket is required before binding",
        ))?;
    let current_assignment_id = assignment["id"].as_str().unwrap_or_default();
    bounded_id(current_assignment_id)?;
    let current_ticket = store
        .get(
            "tickets",
            assignment["ticket_id"].as_str().unwrap_or_default(),
        )?
        .ok_or(denied(
            "model_binding_assignment_scope",
            "Current Ticket is required",
        ))?;
    if store.get("assignments", current_assignment_id)?.is_none()
        || source_ticket["id"] == current_ticket["id"]
        || assignment["project_id"] != binding.project_id
        || assignment["node_id"] != binding.node_id
        || assignment["worker_id"] != binding.worker_id
        || assignment["installation_id"] != binding.installation_id
        || current_ticket["project_id"] != binding.project_id
        || current_ticket["node_id"] != binding.node_id
        || current_ticket["worker_id"] != binding.worker_id
        || current_ticket["installation_id"] != binding.installation_id
        || current_ticket["kind"] != "model_text"
    {
        return Err(denied(
            "model_binding_assignment_scope",
            "Binding must match a real separate model_text Ticket/Assignment and installed Worker scope",
        ));
    }
    // These are the fixed provider route, never arbitrary request-provider input.
    if assignment["provider"].as_str() != Some("loom-stub")
        || assignment["model"].as_str() != Some("loom-stub-v1")
    {
        return Err(denied(
            "unsupported_model_route",
            "This binding is only for the fixed loom-stub/loom-stub-v1 text route",
        ));
    }
    let model = model(store, &binding.model_id)?;
    if model["status"] != "registered"
        || model["descriptor_sha256"] != binding.placement_sha256
        || model["assignment_digest"] != binding.source_assignment_digest
        || model["source_assignment_id"]
            .as_str()
            .is_none_or(|id| bounded_id(id).is_err())
    {
        return Err(denied(
            "registered_model_mismatch",
            "Exact registered model descriptor and original source Assignment digest are required",
        ));
    }
    for (field, actual) in [
        ("source_ticket_id", &binding.source_ticket_id),
        ("source_artifact_id", &binding.source_artifact_id),
        ("project_id", &binding.project_id),
        ("node_id", &binding.node_id),
        ("installation_id", &binding.installation_id),
        ("worker_id", &binding.worker_id),
    ] {
        if model[field].as_str() != Some(actual.as_str()) {
            return Err(denied(
                "registered_model_scope",
                "Model source and invocation must share the exact registered scope",
            ));
        }
    }
    // The checked descriptor remains a local-only v1 text fixture. Its body
    // provider is deliberately distinct from the SDK's loom-stub model route.
    let descriptor: Value = serde_json::from_str(
        model["descriptor_json"].as_str().unwrap_or_default(),
    )
    .map_err(|_| {
        conflict(
            "registry_metadata_corrupt",
            "Stored descriptor cannot be read",
        )
    })?;
    if descriptor
        != json!({
            "schema":"loom.model-descriptor.v1", "provider":"fixture-local-text", "revision":"v1",
            "input_modalities":["text"], "local_only":true,
            "media_type":"application/vnd.loom.text-model-descriptor+json"
        })
    {
        return Err(denied(
            "unsupported_descriptor",
            "Only the registered local text descriptor v1 can bind the fixture route",
        ));
    }
    let artifact = store
        .get("artifacts", &binding.source_artifact_id)?
        .ok_or(denied(
            "source_artifact_scope",
            "The original source Artifact must remain registered",
        ))?;
    let original_proof_bytes = verified_artifact_bytes(store, &artifact)?;
    if crate::sha256(&original_proof_bytes) != binding.placement_sha256 {
        return Err(conflict(
            "source_artifact_integrity",
            "Registered source Artifact bytes no longer match the approved immutable digest",
        ));
    }
    let ticket = source_ticket;
    let read_grant = store
        .get("grants", ticket["grant_id"].as_str().unwrap_or_default())?
        .ok_or(denied(
            "source_grant_revoked",
            "Original read Grant is unavailable",
        ))?;
    let read_root = current_binding(
        store,
        ticket["project_id"].as_str().unwrap_or_default(),
        ticket["node_id"].as_str().unwrap_or_default(),
        ticket["installation_id"].as_str().unwrap_or_default(),
        ticket["worker_id"].as_str().unwrap_or_default(),
    )?;
    if read_grant["revoked_at"] != Value::Null
        || read_grant["project_binding_id"] != read_root["id"]
        || read_grant["operations"]
            .as_array()
            .is_none_or(|operations| !operations.contains(&json!("read")))
    {
        return Err(denied(
            "source_grant_revoked",
            "The completed descriptor-read Grant/root must remain current; placement is separate",
        ));
    }
    verify_current_node(
        store,
        &read_grant,
        ticket["worker_id"].as_str().unwrap_or_default(),
    )?;
    if artifact["ticket_id"] != ticket["id"]
        || artifact["id"] != model["source_artifact_id"]
        || artifact["origin_node_id"] != model["node_id"]
        || ticket["kind"] != "model_descriptor"
        || ticket["status"] != "succeeded"
        || ticket["cancel_requested"] == true
        || ticket["project_id"] != model["project_id"]
        || ticket["node_id"] != model["node_id"]
        || ticket["installation_id"] != model["installation_id"]
        || ticket["worker_id"] != model["worker_id"]
        || artifact["assignment_id"] != model["source_assignment_id"]
        || artifact["assignment_id"] == current_assignment_id
        || source_assignment_evidence(store, &binding.source_artifact_id)?
            != (
                model["source_assignment_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                binding.source_assignment_digest.clone(),
            )
    {
        return Err(denied(
            "source_artifact_scope",
            "Source Artifact, Ticket and original Assignment must remain the registered evidence",
        ));
    }
    // Placement selects one current approval by model/source digest/scope, not
    // an ordinary invoke Grant nor a caller-supplied meta.binding_nonce.
    let approvals = store.query(
        "SELECT * FROM model_placement_authorizations WHERE model_id=?1 AND reviewed_model_digest=?2 AND project_id=?3 AND node_id=?4 AND installation_id=?5 AND worker_id=?6",
        params![binding.model_id,binding.placement_sha256,binding.project_id,binding.node_id,binding.installation_id,binding.worker_id],
    )?;
    if approvals.len() != 1 {
        return Err(denied(
            "current_placement_approval",
            "Exactly one full-scope model placement approval is required",
        ));
    }
    let approval = &approvals[0];
    let grant = store
        .get("grants", approval["grant_id"].as_str().unwrap_or_default())?
        .ok_or(denied(
            "current_placement_approval",
            "Placement Grant is unavailable",
        ))?;
    let root = current_binding(
        store,
        &binding.project_id,
        &binding.node_id,
        &binding.installation_id,
        &binding.worker_id,
    )?;
    if approval["accepted_state"] != "approved_for_placement"
        || approval["grant_id"] != binding.placement_grant_id
        || approval["grant_digest"] != binding.placement_grant_digest
        || grant["digest"] != binding.placement_grant_digest
        || approval["binding_id"] != root["id"]
        || approval["grant_digest"] != grant["digest"]
        || grant["project_binding_id"] != root["id"]
        || grant["project_id"] != binding.project_id
        || grant["node_id"] != binding.node_id
        || grant["installation_id"] != binding.installation_id
        || grant["worker_id"] != binding.worker_id
        || grant["revoked_at"] != Value::Null
        || grant["operations"]
            .as_array()
            .is_none_or(|operations| !operations.contains(&json!("place_model")))
    {
        return Err(denied(
            "current_placement_approval",
            "Current root binding and an unchanged active place_model Grant must match the approval",
        ));
    }
    let placements = store.query(
        "SELECT * FROM model_placements WHERE id=?1 AND model_id=?2 AND node_id=?3 AND grant_id=?4 AND binding_id=?5 AND location='local_only' AND status='approved_for_placement'",
        params![binding.placement_id,binding.model_id,binding.node_id,grant["id"].as_str().unwrap_or_default(),root["id"].as_str().unwrap_or_default()],
    )?;
    if placements.len() != 1 {
        return Err(denied(
            "current_placement",
            "Binding must identify the one active authorized local placement receipt",
        ));
    }
    verify_current_node(store, &grant, &binding.worker_id)?;
    let catalog = crate::model_inventory::inventory(
        store,
        &binding.node_id,
        &binding.installation_id,
        &binding.worker_id,
        chrono::Utc::now(),
    )
    .map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "model_inventory_unavailable",
            "Stored model observation cannot be read",
        )
    })?;
    if catalog.schema != crate::model_inventory::CATALOG_SCHEMA
        || catalog.revision != 1
        || catalog.node_id != binding.node_id
        || catalog.installation_id != binding.installation_id
        || catalog.worker_id != binding.worker_id
        || catalog.confidence != "fresh_observation"
        || !catalog.controller_matches
        || catalog.permission_granted
        || catalog.read_source != "authenticated_node_heartbeat"
    {
        return Err(denied(
            "current_adapter_observation",
            "A fresh, valid catalog observation for the exact current Worker is required",
        ));
    }
    let adapters: Vec<_> = catalog
        .models
        .iter()
        .filter(|adapter| adapter.provider == "loom-stub" && adapter.model == "loom-stub-v1")
        .collect();
    if adapters.len() != 1
        || !adapters.iter().all(|adapter| {
            adapter.node_id == binding.node_id
                && adapter.installation_id == binding.installation_id
                && adapter.worker_id == binding.worker_id
                && adapter.catalogued
                && adapter.prepared_call_observed
                && !adapter.generation_observed
                && !adapter.activated
                && !adapter.allowed
                && !adapter.executable
                && adapter.source == "host_reported"
                && adapter.read_source == "authenticated_node_heartbeat"
                && adapter.freshness == crate::inventory::Freshness::Fresh
                && adapter.resource_state == "adapter_observed"
                && adapter.input_modalities == ["text"]
                && adapter.controller_matches
        })
    {
        return Err(denied(
            "current_adapter_observation",
            "Exactly one fresh prepared-call adapter observation is required; it grants nothing",
        ));
    }
    Ok(json!({
        "schema":"loom.model-binding.v1",
        "model":{
            "id":model["id"],
            "source_ticket_id":model["source_ticket_id"],
            "source_artifact_id":model["source_artifact_id"],
            "source_assignment_id":model["source_assignment_id"],
            "source_assignment_digest":model["assignment_digest"]
        },
        "placement":{"id":placements[0]["id"],"grant_id":grant["id"]},
        "placement_auditable":true
    }))
}

pub(crate) fn retire(store: &mut Store, id: &str, body: &Value) -> Result<Value, ApiError> {
    let input = deserialize::<ReviewOnly>(body)?;
    digest(&input.reviewed_sha256)?;
    let record = model(store, id)?;
    if record["descriptor_sha256"] != input.reviewed_sha256 {
        return Err(denied(
            "review_hash_mismatch",
            "Retirement must review the exact unchanged descriptor",
        ));
    }
    if record["status"] == "registered" {
        let transaction = mutable(store)?;
        transaction.execute(
            "UPDATE models SET status='retired',updated_at=?1 WHERE id=?2 AND status='registered'",
            params![crate::now(), id],
        )?;
        audit_tx_plan(
            &transaction,
            "client",
            "model.descriptor.retired",
            &json!({"model_id":id,"reviewed_descriptor_sha256":record["descriptor_sha256"],"artifact_deleted":false,"runtime_executed":false}),
        )?;
        transaction.commit().map_err(|_| {
            conflict(
                "registry_commit_failed",
                "Descriptor retirement cannot be persisted",
            )
        })?;
    }
    let record = model(store, id)?;
    Ok(json!({"model":view(store,&record)?}))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewOnly {
    reviewed_sha256: String,
}
pub(crate) fn one(store: &Store, id: &str) -> Result<Value, ApiError> {
    view(store, &model(store, id)?)
}
pub(crate) fn list(store: &Store) -> Result<Value, ApiError> {
    let rows = store.query("SELECT * FROM models ORDER BY created_at LIMIT 500", [])?;
    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        models.push(view(store, &row)?);
    }
    Ok(json!({"models":models,"policy":policy()}))
}
fn view(store: &Store, row: &Value) -> Result<Value, ApiError> {
    let descriptor = match row["descriptor_json"].as_str() {
        Some(encoded) => serde_json::from_str(encoded).map_err(|_| {
            conflict(
                "registry_metadata_corrupt",
                "Stored descriptor representation is unreadable",
            )
        })?,
        None => Value::Null,
    };
    let mut base = json!({
        "id":row["id"],"name":row["name"],"revision":row["revision"],
        "status":row["status"],"location":"local_only","descriptor_sha256":row["descriptor_sha256"],
        "descriptor":descriptor, "source_kind":row["source_kind"],
        "source_ticket_id":row["source_ticket_id"], "source_artifact_id":row["source_artifact_id"],
        // Original source-read logical input digest, not model proof/input SHA.
        "source_assignment_id":row["source_assignment_id"],
        "source_assignment_digest":row["assignment_digest"],
        "project_id":row["project_id"], "node_id":row["node_id"],
        "installation_id":row["installation_id"], "worker_id":row["worker_id"],
        "created_at":row["created_at"], "updated_at":row["updated_at"],
        "activation":false,"executable":false,"installed":false,"generation_observed":false
    });
    if row["source_ticket_id"].is_null() {
        base["policy"] = json!({"legacy_metadata_only":true,"evidence_present":false});
    }
    let authorizations = store.query(
        "SELECT * FROM model_placement_authorizations WHERE model_id=?1 ORDER BY approved_at",
        [row["id"].as_str().unwrap_or_default()],
    )?;
    base["placement_authorizations"] = authorizations
        .iter()
        .map(|row| approval_view(store, row))
        .collect::<Result<Vec<_>, _>>()?
        .into();
    base["runtime_executed"] = json!(false);
    Ok(base)
}
fn deserialize<T: serde::de::DeserializeOwned>(body: &Value) -> Result<T, ApiError> {
    serde_json::from_value(body.clone()).map_err(|_| {
        bad(
            "invalid_request",
            "Unknown fields or invalid bounded values are not accepted",
        )
    })
}

/// An immutable legacy v8 sample models row is left untouched by v10. New rows
/// carry exact source evidence without trusting paths or downloaded model names.
#[cfg(test)]
mod tests {
    use super::*;
    fn source_assignment_digest() -> String {
        crate::sha256(
            br#"{"assignment_id":"assignment","kind":"model_descriptor","path":"model.json","content":null}"#,
        )
    }
    fn store() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        (directory, store)
    }
    #[test]
    fn v8_record_preserves_get_model_without_activation() {
        let (_dir, store) = store();
        store.conn().execute("INSERT INTO models(id,name,revision,location,placement_policy,status,created_at,updated_at) VALUES('legacy','legacy','old','legacy','legacy','legacy','old','old')",[]).unwrap();
        store.conn().execute("PRAGMA user_version=8", []).unwrap();
        drop(store);
        let store = Store::open(_dir.path()).unwrap();
        let view = one(&store, "legacy").unwrap();
        assert_eq!(view["status"], "legacy");
        assert_eq!(view["activation"], false);
        assert_eq!(view["executable"], false);
        assert_eq!(
            store
                .conn()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            10
        );
        assert_eq!(view["source_assignment_digest"], Value::Null);
    }
    fn verified_source(outer: Value) -> (tempfile::TempDir, Store, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let at = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','fixture','fixture-scope','read_only',1,?1,'{}')", [&at]).unwrap();
        let worker = json!([{"worker_id":"default","harness_kind":"dsh-loom","status":"online","capabilities":[{"ticket_kind":"read_summary"}]}]);
        let catalog = json!({
            "schema":"loom.model-inventory.v1","revision":1,"worker_id":"default",
            "lookup_source":crate::model_inventory::PREPARED_LOOKUP,"source":"host_reported","observed_at":at,
            "models":[{"provider":"loom-stub","model":"loom-stub-v1","source":"host_reported","observed_at":at,"resource_state":"adapter_observed","prepared_call_observed":true,"generation_observed":false,"input_modalities":["text"],"context_window":131072}],
            "findings":[{"state":"prepared_call_ready","provider":"loom-stub","model":"loom-stub-v1","source":"host_reported","observed_at":at}],
            "policy":{"install":false,"download":false,"activation":false,"generation":false}
        });
        let roots = json!({"project_roots":{"project":"/synthetic/model-descriptor-source"},"model_catalog":catalog});
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES(?1,'installation','synthetic-key','redacted','online',NULL,?2,?3,?4,?5,?5)", params!["a".repeat(64),json!([{"ticket_kind":"read_summary"}]).to_string(),worker.to_string(),roots.to_string(),at]).unwrap();
        store.conn().execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project',?1,'installation','default','/synthetic/model-descriptor-source','digest',?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project',?1,'default','installation','[\"read\"]',1,'digest',?2,'binding')", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('tkt-proof','project','read descriptor','model_descriptor','model.json',NULL,'succeeded','grant','digest',?1,'installation','default',1,?2,?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('assignment','tkt-proof',?1,'default',1,'lease',1,'2099-01-01T00:00:00Z',?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) VALUES('report','assignment','tkt-proof',?1,1,'report','succeeded','descriptor read proof','[]',NULL,0,?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO effects(id,ticket_id,assignment_id,node_id,attempt,input_digest,status,evidence,artifacts,created_at,updated_at) VALUES('source-effect','tkt-proof','assignment',?1,1,?2,'confirmed','[]','[]',?3,?3)", params!["a".repeat(64),source_assignment_digest(),at]).unwrap();
        let artifact = uuid::Uuid::new_v4().to_string();
        let bytes = serde_json::to_vec(&outer).unwrap();
        let proof_sha = crate::sha256(&bytes);
        store.conn().execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES(?1,'tkt-proof','assignment',?2,'proof.json','application/json',?3,?4,?5,'remote-proof','[]',?6)", params![artifact,"a".repeat(64),bytes.len(),proof_sha,format!("{artifact}.artifact"),at]).unwrap();
        std::fs::write(
            store
                .root
                .join("artifacts")
                .join(format!("{artifact}.artifact")),
            &bytes,
        )
        .unwrap();
        let input = json!({"schema":"loom.model-registry.v1","source_ticket_id":"tkt-proof","source_artifact_id":artifact,"worker_id":"default","reviewed_sha256":proof_sha});
        (dir, store, input)
    }
    #[test]
    fn actual_artifact_and_original_hashes_validate_without_model_execution() {
        let source_document = json!({"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}).to_string() + "\n";
        let source_sha256 = crate::sha256(source_document.as_bytes());
        let outer = json!({"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true,"source_kind":"explicit_local_artifact_descriptor","relative_path":"model.json","source_sha256":source_sha256,"source_document":source_document});
        let (_dir, mut store, mut input) = verified_source(outer.clone());
        let created = register(&mut store, &input).unwrap();
        let model = &created["model"];
        assert_eq!(model["descriptor"]["provider"], "fixture-local-text");
        assert_eq!(
            model["source_assignment_digest"],
            source_assignment_digest()
        );
        assert_eq!(model["source_assignment_id"], "assignment");
        assert!(model["descriptor"].is_object());
        assert!(!model["descriptor"].get("source_document").is_some());
        assert_ne!(model["descriptor_sha256"], source_sha256);
        assert_eq!(model["activation"], false);
        let duplicate = register(&mut store, &input).unwrap();
        assert_eq!(duplicate["duplicate"], true);
        store
            .conn()
            .execute(
                "UPDATE effects SET input_digest=?1 WHERE id='source-effect'",
                ["d".repeat(64)],
            )
            .unwrap();
        assert!(register(&mut store, &input).is_err());
        store
            .conn()
            .execute("DELETE FROM effects WHERE id='source-effect'", [])
            .unwrap();
        assert!(register(&mut store, &input).is_err());
        store.conn().execute("INSERT INTO effects(id,ticket_id,assignment_id,node_id,attempt,input_digest,status,evidence,artifacts,created_at,updated_at) VALUES('source-effect','tkt-proof','assignment',?1,1,?2,'confirmed','[]','[]',?3,?3)", params!["a".repeat(64),source_assignment_digest(),crate::now()]).unwrap();
        store
            .conn()
            .execute(
                "UPDATE models SET source_assignment_id='other' WHERE id=?1",
                [&model["id"].as_str().unwrap()],
            )
            .unwrap();
        assert!(register(&mut store, &input).is_err());
        store
            .conn()
            .execute(
                "UPDATE models SET source_assignment_id='assignment' WHERE id=?1",
                [&model["id"].as_str().unwrap()],
            )
            .unwrap();
        input["reviewed_sha256"] = json!("A".repeat(64));
        assert!(register(&mut store, &input).is_err());
        input["reviewed_sha256"] = json!("0".repeat(64));
        assert!(register(&mut store, &input).is_err());
        input["reviewed_sha256"] = model["descriptor_sha256"].clone();
        assert!(store.audits(None).is_ok_and(|rows| rows
            .iter()
            .all(|row| row["action"] != "model.placement.approved")));
        for (key, value) in [
            ("provider", "other-provider"),
            ("api_key", "MUST_NOT_RETURN"),
        ] {
            let mut source_doc: Value = serde_json::from_str(&source_document).unwrap();
            source_doc[key] = json!(value);
            let mut outer = outer.clone();
            outer["source_document"] = json!(source_doc.to_string());
            outer["source_sha256"] = json!(crate::sha256(source_doc.to_string().as_bytes()));
            let (_dir, _store, _input) = verified_source(outer);
            let mut store = _store;
            assert!(
                register(&mut store, &_input).is_err(),
                "{key} must not create a registered model"
            );
        }
    }
    fn fixture() -> Value {
        let document = json!({"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}).to_string() + "\n";
        json!({"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true,"source_kind":"explicit_local_artifact_descriptor","relative_path":"model.json","source_sha256":crate::sha256(document.as_bytes()),"source_document":document})
    }
    struct Authorized {
        _dir: tempfile::TempDir,
        store: Store,
        model_id: String,
        assignment: Value,
        place_input: Value,
    }
    fn authorized_fixture() -> Authorized {
        let (dir, mut store, input) = verified_source(fixture());
        let created = register(&mut store, &input).unwrap();
        let model_id = created["model"]["id"].as_str().unwrap().to_owned();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('placement-grant','project',?1,'default','installation','[\"place_model\"]',1,?3,?2,'binding')", params!["a".repeat(64),crate::now(),crate::sha256(b"test placement Grant digest")]).unwrap();
        let place_input = json!({"grant_id":"placement-grant","worker_id":"default","node_id":"a".repeat(64),"installation_id":"installation","reviewed_sha256":created["model"]["descriptor_sha256"]});
        approve(&mut store, &model_id, &place_input).unwrap();
        let placed = place(&mut store, &model_id, &place_input).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('invoke-grant','project',?1,'default','installation','[\"invoke_text\"]',1,?2,?1,'binding')", params!["a".repeat(64),crate::sha256(b"test invocation Grant digest")]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('current-ticket','project','invoke independently','model_text','',NULL,'running','invoke-grant',?1,?2,'installation','default',1,?3,?3)", params![crate::sha256(b"test invocation Grant digest"),"a".repeat(64),crate::now()]).unwrap();
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('current-invocation','current-ticket',?1,'default',1,'current-lease',1,'2099-01-01T00:00:00Z',?2)", params!["a".repeat(64),crate::now()]).unwrap();
        let assignment = json!({
            "id":"current-invocation","assignment_id":"current-invocation","ticket_id":"current-ticket","project_id":"project", "node_id":"a".repeat(64),
            "installation_id":"installation", "worker_id":"default", "provider":"loom-stub", "model":"loom-stub-v1",
            "input_digest":"d".repeat(64),
            "model_binding":{
                "schema":"loom.model-binding.v1","model_id":model_id,"placement_id":placed["placement"]["id"],
                "placement_sha256":created["model"]["descriptor_sha256"],"source_artifact_id":input["source_artifact_id"],
                "source_ticket_id":input["source_ticket_id"],"placement_grant_id":"placement-grant","placement_grant_digest":crate::sha256(b"test placement Grant digest"),"project_id":"project",
                "node_id":"a".repeat(64),"installation_id":"installation","worker_id":"default",
                "source_assignment_digest":source_assignment_digest()
            }
        });
        Authorized {
            _dir: dir,
            store,
            model_id,
            assignment,
            place_input,
        }
    }
    #[test]
    fn binding_rechecks_source_placement_scope_and_fresh_catalog() {
        let authorized = authorized_fixture();
        let value = bound_for_invocation(&authorized.store, &authorized.assignment).unwrap();
        assert_eq!(value["schema"], "loom.model-binding.v1");
        assert_eq!(value["model"]["id"], authorized.model_id);
        assert_eq!(
            value["model"]["source_assignment_digest"],
            source_assignment_digest()
        );
        assert_eq!(value["model"]["source_assignment_id"], "assignment");
        assert_ne!(
            value["model"]["source_assignment_digest"],
            authorized.assignment["input_digest"]
        );
        assert_eq!(value["placement"]["grant_id"], "placement-grant");
        assert_eq!(value["placement_auditable"], true);
        assert!(value.get("grant").is_none());
        assert!(!serde_json::to_string(&value).unwrap().contains("api_key"));
        let before = authorized.store.audits(None).unwrap().len();
        assert_eq!(
            bound_for_invocation(&authorized.store, &authorized.assignment).unwrap(),
            value
        );
        assert_eq!(before, authorized.store.audits(None).unwrap().len());
    }
    #[test]
    fn binding_never_survives_corrupted_immutable_source_proof() {
        let authorized = authorized_fixture();
        let proof_sha = authorized.assignment["model_binding"]["placement_sha256"]
            .as_str()
            .unwrap()
            .to_owned();
        let storage_name = authorized
            .store
            .get(
                "artifacts",
                authorized.assignment["model_binding"]["source_artifact_id"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
            .unwrap()["storage_name"]
            .as_str()
            .unwrap()
            .to_owned();
        let artifact_path = authorized.store.root.join("artifacts").join(storage_name);
        std::fs::write(
            &artifact_path,
            b"{\"not\":\"the registered immutable proof\"}",
        )
        .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        let source_document = json!({"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}).to_string() + "\n";
        let outer = json!({"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true,"source_kind":"explicit_local_artifact_descriptor","relative_path":"model.json","source_sha256":crate::sha256(source_document.as_bytes()),"source_document":source_document});
        let original_bytes = serde_json::to_vec(&outer).unwrap();
        assert_eq!(crate::sha256(&original_bytes), proof_sha);
        std::fs::write(&artifact_path, original_bytes).unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_ok());
    }
    #[test]
    fn malformed_or_cross_scope_binding_cannot_copy_current_facts() {
        let mut authorized = authorized_fixture();
        let expected = authorized.assignment.clone();
        authorized.assignment["model_binding"]["unknown"] = json!("not-accepted");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        for field in ["project_id", "node_id", "installation_id", "worker_id"] {
            authorized.assignment["model_binding"][field] = json!("other");
            assert!(
                bound_for_invocation(&authorized.store, &authorized.assignment).is_err(),
                "{field}"
            );
            authorized.assignment = expected.clone();
        }
        authorized.assignment["id"] = json!("assignment");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        authorized.assignment["id"] = json!("unknown-current-assignment");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        authorized.assignment["ticket_id"] = json!("tkt-proof");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        authorized.assignment["ticket_id"] = json!("unknown-current-ticket");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        authorized.assignment["id"] = json!("short id with spaces");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        authorized.assignment["model"] = json!("other-model");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        authorized.assignment["provider"] = json!("arbitrary-provider");
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized.assignment = expected.clone();
        for (field, value) in [
            (
                "source_artifact_id",
                json!(uuid::Uuid::new_v4().to_string()),
            ),
            ("source_ticket_id", json!("unknown-ticket")),
            ("model_id", json!("unknown-model")),
            ("placement_id", json!("unknown-placement")),
            ("placement_grant_id", json!("grant")),
            ("placement_grant_digest", json!("e".repeat(64))),
            ("placement_sha256", json!("e".repeat(64))),
            ("source_assignment_digest", json!("ABC")),
            ("source_assignment_digest", json!("d".repeat(64))),
        ] {
            authorized.assignment["model_binding"][field] = value;
            assert!(
                bound_for_invocation(&authorized.store, &authorized.assignment).is_err(),
                "{field}"
            );
            authorized.assignment = expected.clone();
        }
    }
    #[test]
    fn retired_revoked_stale_missing_or_invalid_catalog_cannot_bind() {
        let mut authorized = authorized_fixture();
        retire(
            &mut authorized.store,
            &authorized.model_id,
            &json!({"reviewed_sha256":authorized.assignment["model_binding"]["placement_sha256"]}),
        )
        .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at=?1 WHERE id='placement-grant'",
                [crate::now()],
            )
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at=?1 WHERE id='grant'",
                [crate::now()],
            )
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute("UPDATE nodes SET status='offline'", [])
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute(
                "UPDATE project_bindings SET revoked_at=?1 WHERE id='binding'",
                [crate::now()],
            )
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute("UPDATE nodes SET last_heartbeat='2000-01-01T00:00:00Z'", [])
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute("UPDATE nodes SET inventory='{}'", [])
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        for (field, value) in [
            ("source", json!("controller_probed")),
            ("provider", json!("arbitrary-provider")),
            ("prepared_call_observed", json!(false)),
            ("generation_observed", json!(true)),
        ] {
            authorized = authorized_fixture();
            authorized.store.conn().execute(&format!("UPDATE nodes SET inventory=json_set(inventory,'$.model_catalog.models[0].{field}',json(?1))"), [value.to_string()]).unwrap();
            assert!(
                bound_for_invocation(&authorized.store, &authorized.assignment).is_err(),
                "{field}"
            );
        }
    }
    #[test]
    fn model_approval_requires_original_source_and_exact_current_scope() {
        let mut authorized = authorized_fixture();
        authorized
            .store
            .conn()
            .execute(
                "UPDATE grants SET operations='[\"invoke_text\"]' WHERE id='placement-grant'",
                [],
            )
            .unwrap();
        assert!(bound_for_invocation(&authorized.store, &authorized.assignment).is_err());
        authorized
            .store
            .conn()
            .execute(
                "UPDATE grants SET operations='[\"place_model\"]' WHERE id='placement-grant'",
                [],
            )
            .unwrap();
        authorized
            .store
            .conn()
            .execute("DELETE FROM model_placement_authorizations", [])
            .unwrap();
        assert!(place(
            &mut authorized.store,
            &authorized.model_id,
            &authorized.place_input
        )
        .is_err());
        for (field, update) in [
            (
                "worker_id",
                "UPDATE model_placement_authorizations SET worker_id='other'",
            ),
            (
                "project_id",
                "UPDATE model_placement_authorizations SET project_id=(SELECT project_id FROM models LIMIT 1),node_id='other'",
            ),
            (
                "binding_id",
                "INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) SELECT 'other',project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at FROM project_bindings WHERE id='binding';UPDATE model_placement_authorizations SET binding_id='other'",
            ),
        ] {
            authorized = authorized_fixture();
            authorized.store.conn().execute(update, []).unwrap();
            assert!(
                bound_for_invocation(&authorized.store, &authorized.assignment).is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn mismatched_path_and_grant_cannot_create_registry_authority() {
        let (_dir, mut store) = store();
        let value: Value = serde_json::from_str("{}").unwrap();
        assert!(approve(&mut store, "missing", &value).is_err());
        assert_eq!(crate::sha256(b"descriptor").len(), 64);
    }
}
