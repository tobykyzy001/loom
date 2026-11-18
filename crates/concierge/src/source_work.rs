//! A new Source-linked Ticket has an independently authorized, frozen work spec.
//! An intake-time ticket reference remains a historical hint, not this object.

use crate::store::Store;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub(crate) struct TaskSpec {
    pub value: Value,
    pub digest: String,
}

/// Derive the job from real stored Grant/Binding/Node identity, never from a
/// Source message. These reads do not silently select a different root, worker
/// or installation. The caller separately requires current availability for new
/// work; replay of a stored spec is not permission to run it again.
#[allow(clippy::too_many_arguments)]
pub(crate) fn for_ticket(
    store: &Store,
    project_id: &str,
    kind: &str,
    objective: &str,
    path: &str,
    event_id: &str,
    event_digest: &str,
    ticket_id: &str,
    grant_id: &str,
    node_id: &str,
    worker: &str,
) -> Result<TaskSpec> {
    let grant = store
        .get("grants", grant_id)?
        .context("Grant not found for Source work")?;
    let binding_id = grant["project_binding_id"]
        .as_str()
        .context("Source work needs an explicit ProjectBinding")?;
    // Lookup derives the binding only from the persisted Grant and Project.
    let binding = store
        .query(
            "SELECT * FROM project_bindings WHERE id=?1 AND project_id=?2",
            rusqlite::params![binding_id, project_id],
        )?
        .pop()
        .context("The Grant's ProjectBinding is missing or belongs to another project")?;
    let node = store
        .get("nodes", node_id)?
        .context("The explicitly selected physical Node is not registered")?;
    if grant["revoked_at"] != Value::Null
        || binding["revoked_at"] != Value::Null
        || grant["operations"]
            .as_array()
            .is_none_or(|operations| !operations.iter().any(|op| op == "read"))
    {
        bail!("Source work needs a currently unrevoked Grant and Binding with the actual read operation");
    }
    let installation = node["installation_id"].as_str().unwrap_or_default();
    for (row, key, wanted) in [
        (&grant, "project_id", project_id),
        (&grant, "node_id", node_id),
        (&grant, "installation_id", installation),
        (&binding, "node_id", node_id),
        (&binding, "installation_id", installation),
        (&binding, "worker_id", worker),
    ] {
        if row[key] != wanted {
            bail!("scope mismatch: {key}");
        }
    }
    if node["installation_id"] != binding["installation_id"]
        || grant["worker_id"] != worker
        || binding["root_scope"].as_str().is_none_or(str::is_empty)
    {
        bail!("Source work needs exact current Node, installation, worker and root identities");
    }
    let value = json!({
        "schema":"loom.source-work-spec.v1",
        "source_event_id":event_id,
        "event_request_digest":event_digest,
        "ticket_id":ticket_id,
        "created_at":crate::now(),
        "digest":Option::<String>::None,
        "project_id":project_id, "kind":kind, "objective":objective,
        "relative_path":path, "content":Value::Null,
        "grant_id":grant_id, "grant_digest":grant["digest"], "grant_version":grant["version"],
        "project_binding_id":binding_id, "binding_digest":binding["binding_digest"], "root_scope":binding["root_scope"],
        "node_id":node_id, "installation_id":node["installation_id"], "worker_id":worker,
    });
    complete_spec(value)
}

pub(crate) fn authorize_current_scope(store: &Store, spec: &Value) -> Result<()> {
    let text = |key| spec[key].as_str().unwrap_or_default();
    if spec["kind"] != "read_summary" || spec["content"] != Value::Null || spec["digest"].is_null()
    {
        bail!("Source work must use the bounded read specification with its complete digest");
    }
    let current = for_ticket(
        store,
        text("project_id"),
        "read_summary",
        text("objective"),
        text("relative_path"),
        text("source_event_id"),
        text("event_request_digest"),
        text("ticket_id"),
        text("grant_id"),
        text("node_id"),
        text("worker_id"),
    )?;
    if current.value["root_scope"] != spec["root_scope"]
        || current.value["grant_digest"] != spec["grant_digest"]
        || current.value["binding_digest"] != spec["binding_digest"]
        || current.value["grant_version"] != spec["grant_version"]
        || current.value["installation_id"] != spec["installation_id"]
        || current.value["project_binding_id"] != spec["project_binding_id"]
    {
        bail!("The current Grant, Binding, installation or root no longer matches the authorized Source work");
    }
    Ok(())
}

pub(crate) fn new_source_job_is_dispatchable(store: &Store, spec: &Value) -> Result<()> {
    let grant = store
        .get("grants", spec["grant_id"].as_str().unwrap_or_default())?
        .context("Current read Grant is missing")?;
    if crate::maintenance::matching_physical_node(
        store,
        "read_summary",
        Some(spec["node_id"].as_str().unwrap_or_default()),
        &grant,
        spec["worker_id"].as_str().unwrap_or_default(),
    )?
    .is_none()
    {
        bail!("The originally selected Node/Worker is not currently available for read_summary");
    }
    authorize_current_scope(store, spec)
}

pub(crate) fn from_stored(value: Value, expected_digest: &str, raw: &str) -> Result<TaskSpec> {
    let parsed: loom_protocol::SourceWorkSpecV1 = serde_json::from_value(value.clone())?;
    let actual_digest = parsed
        .digest
        .clone()
        .context("Source work digest missing")?;
    let mut unhashed = parsed.clone();
    unhashed.digest = None;
    let canonical_unsigned = loom_protocol::canonical::json(&serde_json::to_value(unhashed)?)?;
    if crate::sha256(&canonical_unsigned) != actual_digest {
        bail!("Stored Source digest differs from its canonical specification");
    }
    if actual_digest != expected_digest {
        bail!("Stored Source digest column was replaced");
    }
    if loom_protocol::canonical::json(&value)? != raw {
        bail!("Stored Source spec is not the canonical immutable representation");
    }
    if !parsed.validate() || parsed.grant_version == 0 {
        bail!("Stored Source specification is malformed or incomplete");
    }
    Ok(TaskSpec {
        value,
        digest: actual_digest,
    })
}

pub(crate) fn complete_spec(value: Value) -> Result<TaskSpec> {
    let spec: loom_protocol::SourceWorkSpecV1 = serde_json::from_value(value)?;
    if spec.digest.is_some() || spec.created_at.is_none() || !spec.validate() {
        bail!("Source work spec is missing immutable identity, timing or a valid current scope");
    }
    let canonical = spec
        .with_computed_digest()
        .context("Source work spec is not canonical")?;
    let digest = canonical.digest.clone().context("Digest missing")?;
    Ok(TaskSpec {
        value: serde_json::to_value(canonical)?,
        digest,
    })
}
