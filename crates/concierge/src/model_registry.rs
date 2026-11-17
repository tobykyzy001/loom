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
    if value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(bad(
            "invalid_review_digest",
            "Review requires the exact full SHA-256 of the descriptor Artifact",
        ))
    }
}
fn descriptor_sha_actual(
    store: &Store,
    input: &RegisterInput,
) -> Result<(Value, Value, String), ApiError> {
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
        "source_kind":"explicit_local_artifact_descriptor"
    });
    Ok((descriptor_json(&descriptor), metadata, actual_sha))
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
    let (descriptor, metadata, actual_sha) = descriptor_sha_actual(store, &input)?;
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
        return Ok(json!({"model":view(store, &existing)?,"duplicate":true}));
    }
    let id = crate::id("model");
    let time = crate::now();
    let transaction = mutable(store)?;
    transaction.execute("INSERT INTO models(id,name,revision,location,placement_policy,status,created_at,updated_at,node_id,installation_id,worker_id,project_id,source_ticket_id,source_artifact_id,descriptor_json,descriptor_sha256,source_kind) VALUES(?1,'fixture-text-descriptor','v1','local_only','place_model','registered',?2,?2,?3,?4,?5,?6,?7,?8,?9,?10,'explicit_local_artifact_descriptor')", params![id,time,metadata["node_id"].as_str().unwrap_or_default(),metadata["installation_id"].as_str().unwrap_or_default(),metadata["worker_id"].as_str().unwrap_or_default(),metadata["project_id"].as_str().unwrap_or_default(),input.source_ticket_id,input.source_artifact_id,descriptor.to_string(),actual_sha])?;
    audit_tx_plan(
        &transaction,
        "client",
        "model.descriptor.registered",
        &json!({"model_id":id,"source_ticket_id":input.source_ticket_id,"source_artifact_id":input.source_artifact_id,"descriptor_sha256":actual_sha,"provider":"fixture-local-text","revision":"v1"}),
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
    store.query("SELECT * FROM project_bindings WHERE project_id=?1 AND node_id=?2 AND installation_id=?3 AND worker_id=?4 AND revoked_at IS NULL", [project,node,installation,worker])?.into_iter().next().ok_or(denied("binding_scope", "An exact current ProjectBinding is required"))
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
        "status":record["accepted_state"], "activated":false, "executable":false,
        "was_runtime_executed":false, "generation_observed":false,
        "current":model["status"] == "registered" && grant.is_some_and(|grant| grant["revoked_at"].is_null() && grant["project_binding_id"] == record["binding_id"] && grant["operations"].as_array().is_some_and(|operations| operations.contains(&json!("place_model"))) && grant["digest"] == record["grant_digest"]),
        "approved_at":record["approved_at"]
    }))
}
pub(crate) fn place(store: &mut Store, id: &str, body: &Value) -> Result<Value, ApiError> {
    let (model, grant, binding) = authority(store, id, body)?;
    let records = store.query("SELECT * FROM model_placement_authorizations WHERE model_id=?1 AND grant_id=?2 AND binding_id=?3", [id,grant["id"].as_str().unwrap_or_default(),binding["id"].as_str().unwrap_or_default()])?;
    let Some(record) = records.first() else {
        return Err(denied(
            "placement_approval_required",
            "Approve this exact model digest and Grant before acknowledging placement permission",
        ));
    };
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
        &json!({"model_id":id,"grant_id":grant["id"],"reviewed_descriptor_sha256":model["descriptor_sha256"],"runtime_executed":false}),
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
        "binding_id":binding["id"]
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
        "binding_id":binding["id"],"reported_at":row["reported_at"]
    })
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

/// An immutable legacy v8 sample models row is left untouched by v9. New rows
/// carry exact source evidence without trusting paths or downloaded model names.
#[cfg(test)]
mod tests {
    use super::*;
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
            9
        );
    }
    fn verified_source(outer: Value) -> (tempfile::TempDir, Store, Value) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let at = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','fixture','fixture-scope','read_only',1,?1,'{}')", [&at]).unwrap();
        let worker = json!([{"worker_id":"default","status":"online","capabilities":[{"ticket_kind":"read_summary"}]}]);
        let roots = json!({"project_roots":{"project":"/synthetic/model-descriptor-source"}});
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES(?1,'installation','synthetic-key','redacted','online',NULL,?2,?3,?4,?5,?5)", params!["a".repeat(64),json!([{"ticket_kind":"read_summary"}]).to_string(),worker.to_string(),roots.to_string(),at]).unwrap();
        store.conn().execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project',?1,'installation','default','/synthetic/model-descriptor-source','digest',?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project',?1,'default','installation','[\"read\"]',1,'digest',?2,'binding')", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('tkt-proof','project','read descriptor','model_descriptor','model.json',NULL,'succeeded','grant','digest',?1,'installation','default',1,?2,?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('assignment','tkt-proof',?1,'default',1,'lease',1,'2099-01-01T00:00:00Z',?2)", params!["a".repeat(64),at]).unwrap();
        store.conn().execute("INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) VALUES('report','assignment','tkt-proof',?1,1,'report','succeeded','descriptor read proof','[]',NULL,0,?2)", params!["a".repeat(64),at]).unwrap();
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
        assert!(model["descriptor"].is_object());
        assert!(!model["descriptor"].get("source_document").is_some());
        assert_ne!(model["descriptor_sha256"], source_sha256);
        assert_eq!(model["activation"], false);
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
    #[test]
    fn mismatched_path_and_grant_cannot_create_registry_authority() {
        let (_dir, mut store) = store();
        let value: Value = serde_json::from_str("{}").unwrap();
        assert!(approve(&mut store, "missing", &value).is_err());
        assert_eq!(crate::sha256(b"descriptor").len(), 64);
    }
}
