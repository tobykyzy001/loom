use crate::{api::ApiError, maintenance, store::Store};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

/// Resource metadata for a host-owned credential record, never its value or a
/// plaintext secret reference. A grant permits a specifically scoped action.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ActionInput {
    action: String,
    grant_id: String,
    binding_id: Option<String>,
    inspection_ticket_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetScope {
    node_id: String,
    installation_id: String,
    worker_id: String,
    project_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    schema: String,
    id: String,
    reference_id: String,
    owner: String,
    scope: TargetScope,
    value_exposed: bool,
    record_key: String,
    action: String,
    expect_present: bool,
    node_id: String,
    installation_id: String,
    worker_id: String,
    project_id: String,
    binding_id: String,
    binding_digest: String,
    #[serde(default)]
    inspection_proof: Value,
}

pub(crate) fn create(store: &mut Store, project_id: &str, body: &Value) -> Result<Value, ApiError> {
    let input: ActionInput = deserialize(body)?;
    let project = store
        .get("projects", project_id)?
        .ok_or_else(|| ApiError::missing("Project not found"))?;
    if input.action != "inspect" && input.action != "revoke" {
        return Err(ApiError::bad(
            "Only credential-record inspect or explicitly consented revoke is supported",
        ));
    }
    let grant = store
        .get("grants", &input.grant_id)?
        .ok_or_else(|| ApiError::bad("The selected credential Grant is missing"))?;
    let binding = selected_binding(store, project_id, &input, grant.clone(), Some(&project))?;
    let present_proof = if input.action == "revoke" {
        Some(verified_present_proof(store, project_id, &input, &binding)?)
    } else {
        if input.inspection_ticket_id.is_some() {
            return Err(ApiError::bad(
                "Inspection request does not need a source observation TicketId",
            ));
        }
        None
    };
    let namespace = crate::sha256(
        format!(
            "{}\0{}",
            binding["id"].as_str().unwrap_or_default(),
            binding["binding_digest"].as_str().unwrap_or_default()
        )
        .as_bytes(),
    );
    // DSH permits both letters and digits throughout a record ID. The host guard
    // must not require its first digest character to be alphabetic.
    let record_name = format!("refid-{}", &namespace[..24]);
    // Protocol reference: `cref_` plus the existing crate's 32 lowercase hex UUID.
    // Never lengthen the fixed prefix or change the validator's exact grammar.
    let identifier = crate::id("cref");
    let reference = json!({
        "schema":"loom.credential-reference.v1",
        "id":identifier, "reference_id":identifier,
        "owner":"loom-local-node",
        // This namespace is derived by the Coordinator. Never supply arbitrary
        // Host record IDs or secret values through the public task API.
        "record_key":record_name,
        "node_id":binding["node_id"], "installation_id":binding["installation_id"],
        "worker_id":binding["worker_id"], "project_id":project_id,
        "scope": {
            "node_id":binding["node_id"], "installation_id":binding["installation_id"],
            "worker_id":binding["worker_id"], "project_id":project_id
        },
        "binding_id":binding["id"], "binding_digest":binding["binding_digest"],
        "action":input.action, "expect_present":present_proof.is_some(),
        "inspection_proof":present_proof,
        "value_exposed":false
    });
    let content = json!({"schema":"loom.credential-action.v1", "credential_ref":reference, "credential_action":input.action}).to_string();
    let objective = if input.action == "revoke" {
        "Revoke only the exact record whose current matching inspection proved presence; never search or expose credentials."
    } else {
        "Inspect the explicitly scoped host record only; no secret extraction, Clone or arbitrary provider action."
    };
    let request = maintenance::create_ticket(
        &mut *store,
        project_id,
        "credential_ref",
        objective,
        "credential-metadata",
        Some(&content),
        &input.grant_id,
        Some(grant["node_id"].as_str().unwrap_or_default()),
        Some(grant["worker_id"].as_str().unwrap_or_default()),
        Some("credential_ref"),
        None,
        None,
    )?;
    Ok(json!({"ticket":request, "credential_ref":reference, "lookup_performed":false}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObservationResult {
    schema: String,
    record_id: String,
    record_subject: Value,
    record_key: String,
    action: String,
    state: String,
    configured: bool,
    writable: Value,
    kind: Value,
    credential_owner: String,
    source: String,
    configured_state: String,
    value_exposed: bool,
    grant_created: bool,
    permission_granted: bool,
    matching_scope_only: bool,
}

fn verified_present_proof(
    store: &Store,
    project_id: &str,
    input: &ActionInput,
    binding: &Value,
) -> Result<Value, ApiError> {
    let ticket_id = input.inspection_ticket_id.as_deref().ok_or_else(|| {
        ApiError::denied(
            "inspection_proof_required",
            "Revocation must name the matching already-completed inspection Ticket",
        )
    })?;
    let ticket = store.get("tickets", ticket_id)?.ok_or_else(|| {
        ApiError::denied(
            "inspection_proof_required",
            "Inspection Ticket must be registered as proof",
        )
    })?;
    if ticket["status"] != "succeeded"
        || ticket["kind"] != "credential_ref"
        || ticket["project_id"] != project_id
    {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Only a completed credential-ref inspection can support revocation",
        ));
    }
    let source = serde_json::from_str::<Value>(ticket["content"].as_str().unwrap_or_default())
        .map_err(|_| ApiError::bad("Invalid immutable reference inspection metadata"))?;
    let reference = &source["credential_ref"];
    let source_grant = store
        .get("grants", ticket["grant_id"].as_str().unwrap_or_default())?
        .ok_or_else(|| {
            ApiError::denied(
                "inspection_proof_required",
                "The inspection Grant is unavailable",
            )
        })?;
    for field in ["project_id", "node_id", "installation_id", "worker_id"] {
        if reference[field] != binding[field] {
            return Err(ApiError::denied(
                "inspection_proof_required",
                "Inspection belongs to another root, Worker or project",
            ));
        }
    }
    if reference["binding_id"] != binding["id"]
        || reference["binding_digest"] != binding["binding_digest"]
        || source_grant["project_binding_id"] != binding["id"]
        || !source_grant["revoked_at"].is_null()
        || !source_grant["operations"]
            .as_array()
            .is_some_and(|ops| ops.len() == 1 && ops[0] == "credential_inspect")
        || source["credential_action"].as_str() != Some("inspect")
    {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Inspection Grant, binding and action must remain the same current scope",
        ));
    }
    let assignment_id =
        store.query("SELECT id FROM assignments WHERE ticket_id=?1", [ticket_id])?;
    if assignment_id.len() != 1 || store.query("SELECT id FROM reports WHERE ticket_id=?1 AND assignment_id=?2 AND state='succeeded'", params![ticket_id, assignment_id[0]["id"].as_str().unwrap_or_default()])?.is_empty() {
        return Err(ApiError::denied("inspection_proof_required", "A succeeded Report for its exact inspection Assignment is required"));
    }
    let artifacts = store.query("SELECT * FROM artifacts WHERE ticket_id=?1", [ticket_id])?;
    if artifacts.len() != 1 || artifacts[0]["assignment_id"] != assignment_id[0]["id"] {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "The completed inspection needs exactly one scoped metadata Artifact",
        ));
    }
    let source_artifact = &artifacts[0];
    if source_artifact["media_type"] != "application/json"
        || uuid::Uuid::parse_str(source_artifact["id"].as_str().unwrap_or_default()).is_err()
        || source_artifact["storage_name"]
            != format!(
                "{}.artifact",
                source_artifact["id"].as_str().unwrap_or_default()
            )
    {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Inspection Artifact storage identity is outside the immutable namespace",
        ));
    }
    let path = store
        .root
        .join("artifacts")
        .join(source_artifact["storage_name"].as_str().unwrap_or_default());
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| {
        ApiError::denied(
            "inspection_proof_required",
            "Inspection Artifact storage is unavailable",
        )
    })?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 16_384
        || metadata.len() != source_artifact["size_bytes"].as_u64().unwrap_or_default()
    {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Inspection Artifact is not immutable bounded ordinary storage",
        ));
    }
    #[cfg(unix)]
    if std::os::unix::fs::MetadataExt::nlink(&metadata) != 1 {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Inspection Artifact cannot be a hardlinked alternative file",
        ));
    }
    let bytes = std::fs::read(path).map_err(|_| {
        ApiError::denied(
            "inspection_proof_required",
            "Actual inspection bytes are required",
        )
    })?;
    let digest = crate::sha256(&bytes);
    if digest != source_artifact["sha256"].as_str().unwrap_or_default() {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Inspection bytes no longer match their immutable SHA",
        ));
    }
    let observation: ObservationResult = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::denied(
            "inspection_proof_required",
            "Inspection result must be its bounded safe metadata, not raw credentials",
        )
    })?;
    if observation.schema != "loom.credential-reference-result.v1"
        || observation.action != "inspect"
        || observation.state != "present"
        || observation.record_id != reference["id"].as_str().unwrap_or_default()
        || observation.record_key != reference["record_key"].as_str().unwrap_or_default()
        || observation.record_subject["reference_id"] != reference["reference_id"]
        || observation.record_subject["binding_id"] != reference["binding_id"]
        || observation.record_subject["grant_credential_ref"]["id"] != reference["id"]
        || observation.record_subject["grant_credential_ref"]["binding_id"]
            != reference["binding_id"]
        || observation.record_subject["grant_credential_ref"]["scope"] != reference["scope"]
        || observation.credential_owner != "loom-local-node"
        || observation.source != "host_dsh_credentials"
        || observation.kind.as_str() != Some("grant")
        || observation.writable != json!(true)
        || !observation.configured
        || observation.configured_state != "present_metadata"
        || observation.value_exposed
        || observation.grant_created
        || observation.permission_granted
        || !observation.matching_scope_only
    {
        return Err(ApiError::denied(
            "inspection_proof_required",
            "Inspection metadata does not prove this exact present reference without new authority",
        ));
    }
    Ok(
        json!({"source_ticket_id":ticket_id, "source_artifact_id":source_artifact["id"], "copy_sha256":digest,
        "state":"present", "source":"host_dsh_credentials", "verified_current_binding":true,
        "present_proof": reference}),
    )
}

fn selected_binding(
    store: &Store,
    project_id: &str,
    input: &ActionInput,
    grant: Value,
    project: Option<&Value>,
) -> Result<Value, ApiError> {
    if grant["project_id"] != project_id || !grant["revoked_at"].is_null() {
        return Err(ApiError::denied(
            "credential_scope",
            "Credential action must remain within a current Project Grant",
        ));
    }
    let wanted = if input.action == "inspect" {
        "credential_inspect"
    } else {
        "credential_revoke"
    };
    if !grant["operations"]
        .as_array()
        .is_some_and(|ops| ops.len() == 1 && ops[0] == wanted)
    {
        return Err(ApiError::denied(
            "credential_scope",
            "inspect and revoke require separate, different credential Grant operations",
        ));
    }
    let scope_id = input
        .binding_id
        .as_deref()
        .or_else(|| grant["project_binding_id"].as_str())
        .unwrap_or_default();
    let binding = store
        .query(
            "SELECT * FROM project_bindings WHERE id=?1 AND project_id=?2 AND revoked_at IS NULL",
            params![scope_id, project_id],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| {
            ApiError::denied(
                "credential_binding",
                "The precise current project Binding is required",
            )
        })?;
    if grant["project_binding_id"] != binding["id"]
        || grant["node_id"] != binding["node_id"]
        || grant["installation_id"] != binding["installation_id"]
        || grant["worker_id"] != binding["worker_id"]
        || binding["worker_id"]
            .as_str()
            .is_none_or(|worker| worker == "*")
    {
        return Err(ApiError::denied(
            "credential_scope",
            "Node, Installation and Worker of the selected Grant must match its current Binding",
        ));
    }
    if project.is_some() && project.unwrap()["id"] != project_id {
        return Err(ApiError::bad(
            "Credential project identity is not the selected Project",
        ));
    }
    Ok(binding)
}

/// Verify this exact task again at every poll, before handing a Host any scope.
pub(crate) fn delivery(
    store: &Store,
    ticket: &Value,
    assignment: &Value,
) -> Result<Value, ApiError> {
    // Legacy Assignments omit installation_id. Recover it only from their
    // immutable Ticket's selected physical Node, not from a caller/default.
    let assignment_node_id = assignment["node_id"].as_str().unwrap_or_default();
    if assignment_node_id.is_empty() {
        return Err(ApiError::denied(
            "credential_scope",
            "Assigned physical Node id is missing",
        ));
    }
    let assignment_node = store
        .get("nodes", assignment_node_id)?
        .ok_or_else(|| ApiError::denied("credential_scope", "Assigned physical Node is unknown"))?;
    let mut exact_assignment = assignment.clone();
    exact_assignment["installation_id"] = assignment_node["installation_id"].clone();
    exact_assignment["project_id"] = ticket["project_id"].clone();
    let assignment = &exact_assignment;
    let raw = serde_json::from_str::<Value>(ticket["content"].as_str().unwrap_or_default())
        .map_err(|_| ApiError::bad("Invalid immutable credential-action metadata"))?;
    let target: Target = deserialize(
        raw.get("credential_ref")
            .ok_or_else(|| ApiError::bad("Credential action reference is required"))?,
    )?;
    if target.schema != "loom.credential-reference.v1"
        || target.action != raw["credential_action"].as_str().unwrap_or_default()
        || target.owner != "loom-local-node"
        || target.id != target.reference_id
        || target.id.is_empty()
        || target.id.len() > 64
        || target.value_exposed
        || target.scope.node_id != target.node_id
        || target.scope.installation_id != target.installation_id
        || target.scope.worker_id != target.worker_id
        || target.scope.project_id != target.project_id
        || (target.action != "inspect" && target.action != "revoke")
        || target.expect_present != (target.action == "revoke")
        || target.project_id != assignment["project_id"]
        || target.node_id != assignment["node_id"]
        || target.worker_id != assignment["worker_id"]
        || target.installation_id != assignment["installation_id"]
        || ticket["kind"] != "credential_ref"
        || ticket["node_id"] != target.node_id
        || ticket["installation_id"] != target.installation_id
        || ticket["worker_id"] != target.worker_id
        || ticket["project_id"] != target.project_id
    {
        return Err(ApiError::denied(
            "credential_scope",
            "Credential action does not match its persisted Worker/project binding",
        ));
    }
    let grant = store
        .get("grants", ticket["grant_id"].as_str().unwrap_or_default())?
        .ok_or_else(|| ApiError::denied("credential_scope", "Task Grant is not registered"))?;
    let input = ActionInput {
        action: target.action.clone(),
        grant_id: ticket["grant_id"].as_str().unwrap_or_default().to_owned(),
        binding_id: Some(target.binding_id.clone()),
        inspection_ticket_id: target.inspection_proof["source_ticket_id"]
            .as_str()
            .map(str::to_owned),
    };
    let binding = selected_binding(store, &target.project_id, &input, grant.clone(), None)?;
    if target.action == "revoke" {
        let verified = verified_present_proof(store, &target.project_id, &input, &binding)?;
        if verified["state"] != "present" {
            return Err(ApiError::denied(
                "inspection_proof_required",
                "A current exact inspection must prove presence before deletion",
            ));
        }
    }
    let key = crate::sha256(format!("{}\0{}", target.binding_id, target.binding_digest).as_bytes());
    if binding["id"] != target.binding_id
        || binding["node_id"] != target.node_id
        || binding["installation_id"] != target.installation_id
        || binding["worker_id"] != target.worker_id
        || target.record_key != format!("refid-{}", &key[..24])
    {
        return Err(ApiError::denied(
            "credential_scope",
            "Credential reference or derived root namespace changed",
        ));
    }
    let mut descriptor = raw["credential_ref"].clone();
    descriptor["verified_current_scope"] = json!(true);
    descriptor["value_exposed"] = json!(false);
    let grant_credential_ref = json!({
        "id": descriptor["id"], "name_scope":"source",
        "record_key": descriptor["record_key"], "binding_id": descriptor["binding_id"],
        "scope": descriptor["scope"]
    });
    let revoke_expected = if target.action == "revoke" {
        let proof = &descriptor["inspection_proof"];
        json!({
            "expect_present": descriptor["expect_present"],
            "source_ticket_id": proof["source_ticket_id"],
            "source_artifact_id": proof["source_artifact_id"],
            "source_sha256": proof["copy_sha256"],
            "source_reference_id": proof["present_proof"]["reference_id"],
            "scope": descriptor["scope"]
        })
    } else {
        Value::Null
    };
    Ok(json!({
        "protocol": "loom.node.v1", "action":target.action,
        "credential_ref": descriptor, "grant":grant,
        "grant_credential_ref":grant_credential_ref,
        "credential_revoke_expected":revoke_expected,
        "assignment_id":assignment["id"], "ticket_id":ticket["id"],
        "lease_epoch": assignment["lease_epoch"]
    }))
}

pub(crate) fn authority(
    store: &Store,
    ticket_id: &str,
    assignment: &Value,
) -> Result<Value, ApiError> {
    let ticket = store
        .get("tickets", ticket_id)?
        .ok_or_else(|| ApiError::denied("credential_scope", "Credential Ticket not found"))?;
    let checked = delivery(store, &ticket, assignment)?;
    let ticket_ref = checked["credential_ref"].clone();
    if let Some(proof) = ticket_ref["inspection_proof"].as_object() {
        let source = proof["present_proof"].clone();
        if source["schema"] != "loom.credential-reference.v1"
            || source["id"] != source["reference_id"]
            || source["owner"] != "loom-local-node"
            || source["action"] != "inspect"
            || source["expect_present"] != false
            || source["binding_digest"] != ticket_ref["binding_digest"]
        {
            return Err(ApiError::denied(
                "inspection_proof_required",
                "The source Reference and immutable Binding identity must agree",
            ));
        }
    }
    Ok(checked)
}

pub(crate) fn validate_outcome(
    store: &Store,
    ticket_id: &str,
    body: &Value,
) -> Result<(), ApiError> {
    let ticket = store
        .get("tickets", ticket_id)?
        .ok_or_else(|| ApiError::denied("credential_scope", "Credential Ticket not found"))?;
    let raw: Value =
        serde_json::from_str(ticket["content"].as_str().unwrap_or_default()).map_err(|_| {
            ApiError::denied(
                "credential_evidence",
                "Malformed persisted credential action",
            )
        })?;
    let reference = &raw["credential_ref"];
    let action = raw["credential_action"].as_str().unwrap_or_default();
    if ticket["kind"] != "credential_ref" || !matches!(action, "inspect" | "revoke") {
        return Err(ApiError::denied(
            "credential_evidence",
            "This is not a supported credential outcome",
        ));
    }
    let state = body["requested_state"].as_str().unwrap_or_default();
    let effects = body["effects"].as_array().cloned().unwrap_or_default();
    if state == "unknown" && (action != "revoke" || effects.len() != 1) {
        return Err(ApiError::denied(
            "credential_evidence",
            "An incomplete credential deletion needs one scoped unknown Effect; no other action can use this path",
        ));
    }
    if state != "succeeded" && state != "failed" && state != "unknown" {
        return Err(ApiError::bad(
            "Interrupted credential outcomes stay reconciling until independently observed",
        ));
    }
    let ids = body["artifact_ids"].as_array().cloned().unwrap_or_default();
    if state == "failed" {
        if !effects.is_empty() || !ids.is_empty() {
            return Err(ApiError::denied(
                "credential_evidence",
                "A refused credential action has no confirmed Effect or result",
            ));
        }
        return Ok(());
    }
    if ids.len() != 1 || (action == "revoke") != (effects.len() == 1) {
        return Err(ApiError::denied(
            "credential_evidence",
            "Result and Effect cardinality does not match the operation",
        ));
    }
    let stored = store
        .get("artifacts", ids[0].as_str().unwrap_or_default())?
        .ok_or_else(|| ApiError::bad("Credential Artifact is not registered"))?;
    let path = store
        .root
        .join("artifacts")
        .join(stored["storage_name"].as_str().unwrap_or_default());
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| ApiError::bad("Credential Artifact storage unavailable"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16_384 {
        return Err(ApiError::bad(
            "Credential Artifact is not bounded ordinary storage",
        ));
    }
    #[cfg(unix)]
    if std::os::unix::fs::MetadataExt::nlink(&metadata) != 1 {
        return Err(ApiError::bad("Credential Artifact must not be hardlinked"));
    }
    let bytes =
        std::fs::read(&path).map_err(|_| ApiError::bad("Credential Artifact bytes unavailable"))?;
    if crate::sha256(&bytes) != stored["sha256"] {
        return Err(ApiError::bad("Credential Artifact digest mismatch"));
    }
    let result: ObservationResult = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad("Credential Artifact must be the exact safe result schema"))?;
    if result.schema != "loom.credential-reference-result.v1"
        || result.record_id != reference["id"]
        || result.record_key != reference["record_key"]
        || result.record_subject["reference_id"] != reference["reference_id"]
        || result.record_subject["binding_id"] != reference["binding_id"]
        || result.action != action
        || result.credential_owner != reference["owner"]
        || result.source != "host_dsh_credentials"
        || result.value_exposed
        || result.grant_created
        || result.permission_granted
        || !result.matching_scope_only
        || result.record_subject["grant_credential_ref"]["id"] != reference["id"]
        || result.record_subject["grant_credential_ref"]["record_key"] != reference["record_key"]
        || result.record_subject["grant_credential_ref"]["scope"] != reference["scope"]
        || result.record_subject["grant_credential_ref"]["name_scope"] != "source"
    {
        return Err(ApiError::denied(
            "credential_evidence",
            "Result subject does not match the immutable credential action",
        ));
    }
    if action == "inspect" {
        if !matches!(result.state.as_str(), "present" | "missing")
            || result.configured != (result.state == "present")
            || result.configured_state
                != if result.configured {
                    "present_metadata"
                } else {
                    "missing"
                }
            || (result.state == "missing" && !result.kind.is_null())
        {
            return Err(ApiError::denied(
                "credential_evidence",
                "Inspection metadata is not actual present/missing evidence",
            ));
        }
        return Ok(());
    }
    if state == "unknown"
        && (result.state != "unknown"
            || result.configured_state != "present_metadata"
            || !result.configured)
    {
        return Err(ApiError::denied(
            "credential_evidence",
            "Unknown revocation cannot assert rechecked presence or missing metadata",
        ));
    }
    if state == "succeeded"
        && (result.state != "revoked" || result.configured || result.configured_state != "missing")
    {
        return Err(ApiError::denied(
            "credential_evidence",
            "A confirmed revoke must report rechecked missing metadata",
        ));
    }
    let grant = store
        .get("grants", ticket["grant_id"].as_str().unwrap_or_default())?
        .ok_or_else(|| {
            ApiError::denied("credential_evidence", "Referenced Grant is unavailable")
        })?;
    let fields = [
        ("asset_action", json!("revoke")),
        ("binding_id", reference["binding_id"].clone()),
        ("ref_recordkey", reference["record_key"].clone()),
        ("installation_id", reference["installation_id"].clone()),
        ("node_id", reference["node_id"].clone()),
        ("project_id", reference["project_id"].clone()),
        ("worker_id", reference["worker_id"].clone()),
    ];
    let digest_input = Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    );
    let input_digest = crate::sha256(canonical_bytes(&digest_input));
    let expected_effect_status = match state {
        "succeeded" => "confirmed",
        _ => "unknown",
    };
    let effect = &effects[0];
    let evidence = &effect["evidence"];
    if effect["status"] != expected_effect_status
        || effect["effect_id"].as_str()
            != Some(
                credential_effect_id(
                    &input_digest,
                    body["assignment_id"].as_str().unwrap_or_default(),
                )
                .as_str(),
            )
        || effect["input_digest"] != input_digest
        || effect["artifacts"] != json!([ids[0]])
        || evidence["asset_action"] != "revoke"
        || evidence["binding_id"] != reference["binding_id"]
        || evidence["record_id"] != reference["id"]
        || evidence["reference_id"] != reference["reference_id"]
        || evidence["grant_version"] != grant["version"]
        || evidence["grant_digest"] != grant["digest"]
        || evidence["input_sha256"] != input_digest
        || evidence["value_exposed"] != false
    {
        return Err(ApiError::denied(
            "credential_evidence",
            "Confirmed revocation and its scoped hash must agree",
        ));
    }
    Ok(())
}

fn credential_effect_id(input_digest: &str, assignment_id: &str) -> String {
    let hash =
        crate::sha256(format!("{input_digest}:credential-revoke:v1:{assignment_id}").as_bytes());
    let variant =
        b"89ab"[usize::from_str_radix(&hash[16..17], 16).expect("hex variant") % 4] as char;
    format!(
        "{}-{}-4{}-{}{}-{}",
        &hash[..8],
        &hash[8..12],
        &hash[13..16],
        variant,
        &hash[17..20],
        &hash[20..32]
    )
}

fn canonical_bytes(value: &Value) -> Vec<u8> {
    fn normalize(value: Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.into_iter()
                    .map(|(key, value)| (key, normalize(value)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
            scalar => scalar,
        }
    }
    serde_json::to_vec(&normalize(value.clone())).expect("canonical JSON values are serializable")
}

fn deserialize<T: serde::de::DeserializeOwned>(body: &Value) -> Result<T, ApiError> {
    serde_json::from_value(body.clone())
        .map_err(|_| ApiError::bad("Exact bounded credential action fields are required"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effect_uuid_matches_host_scope_without_truncation_mistakes() {
        assert_eq!(
            credential_effect_id(&"a".repeat(64), "test-assignment"),
            "807876ab-42df-4e45-8bd2-44383d8d564a"
        );
        assert_eq!(
            credential_effect_id(&"a".repeat(64), "test-0"),
            "5de934f1-7a2b-4389-99be-c274782d47ab"
        );
        assert_eq!(
            credential_effect_id(&"a".repeat(64), "test-7"),
            "310dfcc3-74cc-4dc5-b975-6b693ecc8271"
        );
    }

    #[test]
    fn credential_metadata_needs_precise_scope_and_separate_actions() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let at = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','fixture','/fixture','read_write',1,?1,'{}')", [&at]).unwrap();
        let roots = json!({"project_roots":{"project":"/fixture"}});
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','synthetic','redacted','online',NULL,?1,?2,?3,?4,?5)", params![json!([{"ticket_kind":"credential_ref"}]).to_string(),json!([{"worker_id":"default"}]).to_string(),roots.to_string(),at,at]).unwrap();
        store.conn().execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('root-binding','project','node','installation','default','/fixture','digest',?1)", [&at]).unwrap();
        for (id, operations) in [
            ("inspect-grant", "[\"credential_inspect\"]"),
            ("revoke-grant", "[\"credential_revoke\"]"),
            ("file-grant", "[\"read\"]"),
        ] {
            store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,revoked_at,digest,created_at,project_binding_id) VALUES(?1,'project','node','default','installation',?2,1,NULL,?3,?4,'root-binding')", params![id,operations,crate::sha256(id.as_bytes()),at]).unwrap();
        }
        let inspected = create(
            &mut store,
            "project",
            &json!({"action":"inspect","grant_id":"inspect-grant"}),
        )
        .unwrap();
        assert_eq!(inspected["ticket"]["kind"], "credential_ref");
        assert_eq!(inspected["credential_ref"]["owner"], "loom-local-node");
        assert!(inspected["lookup_performed"] == false);
        let request: Value =
            serde_json::from_str(inspected["ticket"]["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            request["credential_ref"]["record_key"],
            inspected["credential_ref"]["record_key"]
        );
        let asg = inspected["ticket"]["assignments"][0].clone();
        assert_eq!(asg["node_id"], "node");
        let delivered = delivery(&store, &inspected["ticket"], &asg).unwrap();
        assert_eq!(delivered["action"], "inspect");
        assert_eq!(delivered["credential_ref"]["verified_current_scope"], true);
        assert_eq!(delivered["credential_ref"]["value_exposed"], false);
        for wrong in [
            ("inspect", "file-grant"),
            ("revoke", "inspect-grant"),
            ("inspect", "revoke-grant"),
        ] {
            assert!(create(
                &mut store,
                "project",
                &json!({"action":wrong.0,"grant_id":wrong.1})
            )
            .is_err());
        }
        store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at=?1 WHERE id='inspect-grant'",
                [&at],
            )
            .unwrap();
        assert!(delivery(&store, &inspected["ticket"], &asg).is_err());
        assert!(create(
            &mut store,
            "project",
            &json!({"action":"inspect","grant_id":"inspect-grant"})
        )
        .is_err());
        assert!(
            validate_outcome(
                &store,
                inspected["ticket"]["id"].as_str().unwrap(),
                &json!({"requested_state":"unknown", "effects":[{"status":"unknown"}]}),
            )
            .is_err(),
            "Inspection cannot use the deliberately narrow unknown-revocation outcome"
        );
    }
}
