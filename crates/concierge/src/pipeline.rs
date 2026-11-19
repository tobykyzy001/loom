//! Restricted two-stage document workflows. Real Grants, Tickets and immutable
//! Artifacts remain the authority. This is not a generic command/model engine.
use crate::{maintenance, sha256, store::Store};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
// The typed Phase and Definition enforce scope and graph shape directly.
use uuid::Uuid;

pub const SCHEMA: &str = "loom.document-pipeline.v1";
const MAX_SOURCE_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Operation {
    ReadSummary,
    EditFile,
}
impl Operation {
    // This small enum identifies only the two existing document permissions.
    fn permission(self) -> &'static str {
        match self {
            Self::ReadSummary => "read",
            Self::EditFile => "write",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Phase {
    stage_id: String,
    kind: Operation,
    grant_id: String,
    relative_path: String,
    #[serde(default)]
    output_id: Option<String>,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    node_id: Option<String>,
    #[serde(default)]
    worker_id: Option<String>,
    #[serde(default)]
    transform: Option<loom_protocol::TextTransform>,
    /// A single explicitly authorized loopback source, never an arbitrary endpoint.
    #[serde(default)]
    direct: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Definition {
    schema: String,
    version: u32,
    pipeline_id: Uuid,
    project_id: String,
    #[serde(default)]
    name: Option<String>,
    read: Phase,
    edit: Phase,
}

impl Definition {
    fn validate(&self) -> Result<()> {
        if self.schema != SCHEMA || self.version != 1 || self.pipeline_id.is_nil() {
            bail!("Only {SCHEMA} v1 with a non-nil pipeline UUID is supported");
        }
        if self
            .name
            .as_deref()
            .is_some_and(|name| name.len() > 120 || name.chars().any(|c| c.is_control()))
        {
            bail!("Invalid pipeline display name");
        }
        for phase in [&self.read, &self.edit] {
            loom_protocol::StageId::parse(phase.stage_id.clone())?;
            if !phase.relative_path.starts_with("docs/") {
                bail!("Only the explicit docs/ subtree is supported by this workflow");
            }
            crate::safe_relative(&phase.relative_path)?;
            let output =
                phase
                    .output_id
                    .as_deref()
                    .unwrap_or(if phase.kind == Operation::ReadSummary {
                        "source-summary"
                    } else {
                        "derived-document"
                    });
            loom_protocol::ArtifactOutputId::parse(output)?;
            if phase.grant_id.len() > 160 || phase.grant_id.is_empty() {
                bail!("An exact existing Grant is required for each phase");
            }
        }
        if self.read.kind != Operation::ReadSummary || self.edit.kind != Operation::EditFile {
            bail!("The bounded workflow is exactly read_summary then edit_file");
        }
        if self.read.stage_id == self.edit.stage_id
            || output_of(&self.read) == output_of(&self.edit)
        {
            bail!("Stages and output IDs must be distinct");
        }
        if !self.read.depends_on.is_empty()
            || self.edit.depends_on.as_slice() != [self.read.stage_id.as_str()]
        {
            bail!("The edit stage must explicitly depend on the read_summary stage");
        }
        if self.edit.transform.is_none() || self.read.transform.is_some() {
            bail!("Only the edit stage may have a supported text transform");
        }
        if (self.read.direct || self.edit.direct)
            && !(self.edit.direct
                && self.edit.transform == Some(loom_protocol::TextTransform::Trim)
                && !self.read.direct)
        {
            bail!("DirectArtifactOffer is restricted to the existing trim edit transform");
        }
        if self.read.grant_id == self.edit.grant_id {
            bail!("Each phase must have an independently selected existing Grant");
        }
        Ok(())
    }
}
fn output_of(phase: &Phase) -> &str {
    phase
        .output_id
        .as_deref()
        .unwrap_or(if phase.kind == Operation::ReadSummary {
            "source-summary"
        } else {
            "derived-document"
        })
}
fn name(definition: &Definition) -> &str {
    definition.name.as_deref().unwrap_or("Document review")
}

/// Authorize the exact current Registry scope. An optional preferred placement
/// can only narrow the already-selected Grant/Binding, never choose a new root.
fn scope(store: &Store, phase: &Phase, project: &str) -> Result<(String, String)> {
    let grant = store
        .get("grants", &phase.grant_id)?
        .context("Pipeline grant not found")?;
    if grant["project_id"] != project {
        bail!("Grant belongs to another project")
    }
    if grant["revoked_at"] != Value::Null {
        bail!("Pipeline grant is revoked")
    }
    let operation = phase.kind.permission();
    if !grant["operations"]
        .as_array()
        .is_some_and(|values| values.contains(&json!(operation)))
    {
        bail!("Grant does not permit the requested operation");
    }
    let binding_id = grant["project_binding_id"]
        .as_str()
        .context("Grant has no exact ProjectBinding")?;
    let binding = store
        .query(
            "SELECT * FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
            [binding_id],
        )?
        .into_iter()
        .next()
        .context("No active exact ProjectBinding")?;
    if binding["project_id"] != project
        || (grant["node_id"] != "auto" && binding["node_id"] != grant["node_id"])
        || binding["worker_id"] != grant["worker_id"]
        || binding["installation_id"] != grant["installation_id"]
    {
        bail!("Grant and Binding scopes differ");
    }
    loom_protocol::Sha256Digest::parse(
        grant["digest"].as_str().context("Grant digest is absent")?,
    )?;
    loom_protocol::Sha256Digest::parse(
        binding["binding_digest"]
            .as_str()
            .context("Binding digest is absent")?,
    )?;
    // The active exact binding ID and type/version locations above prove their
    // relation. grant.digest and location binding digest are distinct semantics.
    if grant["version"].as_i64().unwrap_or(0) <= 0 {
        bail!("Grant revision must be positive");
    }
    let node = binding["node_id"]
        .as_str()
        .context("No binding node")?
        .to_owned();
    let worker = binding["worker_id"]
        .as_str()
        .context("No binding worker")?
        .to_owned();
    if phase
        .node_id
        .as_ref()
        .is_some_and(|preferred| preferred != &node)
        || phase
            .worker_id
            .as_ref()
            .is_some_and(|preferred| preferred != &worker)
    {
        bail!("Requested placement exceeds the exact Grant/Binding scope");
    }
    let real_root = binding["root_scope"]
        .as_str()
        .context("Missing binding scope")?;
    if !std::fs::canonicalize(real_root)?.is_dir() {
        bail!("Binding root is not a real directory")
    }
    Ok((node, worker))
}

fn parse_definition(store: &Store, body: &Value) -> Result<Definition> {
    let definition: Definition = serde_json::from_value(body.clone())?;
    let project = store
        .get("projects", &definition.project_id)?
        .context("Pipeline project not registered")?;
    if definition.project_id.len() > 160 || project["mode"] != "read_write" {
        bail!("Document output requires a registered read_write Project");
    }
    definition.validate()?;
    // Check both grants before issuing the first Ticket, so an invalid successor
    // cannot leave an accidentally created first-phase execution behind.
    scope(store, &definition.read, &definition.project_id)?;
    scope(store, &definition.edit, &definition.project_id)?;
    Ok(definition)
}

fn run_row(store: &Store, pipeline_id: &str) -> Result<Option<Value>> {
    Ok(store
        .query(
            "SELECT * FROM document_pipeline_runs WHERE id=?1",
            [pipeline_id],
        )?
        .into_iter()
        .next())
}
fn stage_row(store: &Store, pipeline: &Uuid, stage: &Phase) -> Result<Option<Value>> {
    Ok(store
        .query(
            "SELECT * FROM document_pipeline_stages WHERE pipeline_id=?1 AND stage_id=?2",
            params![pipeline.to_string(), stage.stage_id],
        )?
        .into_iter()
        .next())
}

/// The single coordinator connection owns a real SQLite transaction while both
/// its task and its pipeline mapping are created. A failure commits neither.
fn with_transaction<T>(store: &mut Store, work: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = work(store);
    match result {
        Ok(value) => match store.conn().execute("COMMIT", []) {
            Ok(_) => Ok(value),
            Err(error) => {
                let _ = store.conn().execute("ROLLBACK", []);
                Err(error.into())
            }
        },
        Err(error) => {
            let rollback = store.conn().execute("ROLLBACK", []);
            match rollback {
                Ok(_) => Err(error),
                Err(failure) => {
                    Err(error.context(format!("pipeline transaction rollback failed: {failure}")))
                }
            }
        }
    }
}

/// Create the first actual Ticket and its immutable definition atomically.
pub fn create(store: &mut Store, body: &Value) -> Result<Value> {
    let definition = parse_definition(store, body)?;
    let pipeline_id = definition.pipeline_id.to_string();
    let digest = sha256(serde_json::to_string(&definition)?);
    if let Some(existing) = store.query("SELECT id,definition_digest FROM document_pipeline_runs WHERE id=?1 OR definition_digest=?2", params![&pipeline_id, digest])?.first().cloned() {
        if existing["id"] != pipeline_id || existing["definition_digest"] != digest {
            bail!("A pipeline UUID or definition digest cannot be reused for another definition");
        }
        return present(store, &pipeline_id);
    }
    let (node, worker) = scope(store, &definition.read, &definition.project_id)?;
    with_transaction(store, |store| {
        let ticket = maintenance::create_ticket(
            &mut *store,
            &definition.project_id,
            "read_summary",
            &format!("{}: {}", name(&definition), definition.read.stage_id),
            &definition.read.relative_path,
            None,
            &definition.read.grant_id,
            Some(&node),
            Some(&worker),
            Some("read_summary"),
            None,
            None,
            0,
        )?;
        let ticket_id = ticket["id"].as_str().context("First stage has no Ticket")?;
        store.conn().execute(
            "INSERT INTO document_pipeline_runs(id,project_id,name,definition_json,definition_digest,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
            params![&pipeline_id, &definition.project_id, name(&definition), serde_json::to_string(&definition)?, &digest, crate::now()],
        )?;
        for phase in [&definition.read, &definition.edit] {
            let assigned = if phase.stage_id == definition.read.stage_id {
                Some(ticket_id)
            } else {
                None
            };
            store.conn().execute(
            "INSERT INTO document_pipeline_stages(pipeline_id,stage_id,ticket_id,raw_grant_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
            params![&pipeline_id, &phase.stage_id, assigned, &phase.grant_id, crate::now()],
        )?;
        }
        // Parent run row exists before the corresponding phase foreign keys.
        store.audit(
            Some(ticket_id),
            "controller",
            "pipeline.started",
            &json!({
                "pipeline_id": pipeline_id, "definition_digest": digest, "ticket_id": ticket_id,
            }),
        )?;
        Ok(())
    })?;
    present(store, &pipeline_id)
}

fn definition_of(run: &Value) -> Result<Definition> {
    let json = run["definition_json"]
        .as_str()
        .context("Invalid pipeline definition")?;
    let definition: Definition = serde_json::from_str(json)
        .map_err(|error| anyhow::anyhow!("Invalid pipeline definition fields: {error}"))?;
    definition.validate()?;
    Ok(definition)
}

/// Only a currently assigned descendant may request this exact source. The
/// center, not the child, selects the producer and its public ordinary SessionRef.
pub fn delegated_source_proof(store: &Store, body: &Value) -> Result<Value> {
    let ticket_id = body["ticket_id"].as_str().context("Ticket is required")?;
    let source = input_for_assignment(store, ticket_id)?
        .context("Only an actual authorized pipeline descendant has a source")?;
    let expected = source["artifact_ref"].clone();
    if body["source_ref"] != expected {
        bail!("Source reference does not match the immutable parent assigned to this child");
    }
    let parent_ticket = expected["ticket_id"]
        .as_str()
        .context("Parent ticket missing")?;
    let current = store
        .get("tickets", ticket_id)?
        .context("Current child Ticket is missing")?;
    let parent = store
        .get("tickets", parent_ticket)?
        .context("Source producer Ticket is missing")?;
    if current["kind"] != "edit_file"
        || parent["kind"] != "read_summary"
        || parent["status"] != "succeeded"
        || parent["project_id"] != current["project_id"]
    {
        bail!("Source and descendant stage or project do not match");
    }
    let links = store.query(
        "SELECT c.pipeline_id FROM document_pipeline_stages c JOIN document_pipeline_stages p ON p.pipeline_id=c.pipeline_id WHERE c.ticket_id=?1 AND p.ticket_id=?2",
        params![ticket_id, parent_ticket],
    )?;
    if links.len() != 1 {
        bail!("The stated producer is not a parent in the stated pipeline");
    }
    let event = store.query(
        "SELECT session_ref FROM messages WHERE ticket_id=?1 AND kind='session_link' ORDER BY created_at DESC,id DESC LIMIT 1",
        [parent_ticket],
    )?.into_iter().next().context("The actual parent Agent SessionRef has not been published")?;
    let session = serde_json::from_str::<Value>(
        event["session_ref"]
            .as_str()
            .context("Parent session metadata is malformed")?,
    )
    .context("Parent session metadata is not valid JSON")?;
    if !session.is_object()
        || session["harness"] != "dsh"
        || session["protocol"] != "dsh-session-log"
        || Uuid::parse_str(
            session["session_id"]
                .as_str()
                .context("Parent Session ID is missing")?,
        )
        .is_err()
    {
        bail!("Parent SessionRef must identify an actual supported DSH AgentSession");
    }
    // Remote source reading does not itself let a child choose another parent
    // Session identity. Missing legacy refs retain their old behavior, but any
    // supplied Session/Ticket/sequence claim must match the stored producer.
    if let Some(claim) = body.get("parent_session_ref") {
        let identity_matches = claim["harness"] == session["harness"]
            && claim["protocol"] == session["protocol"]
            && claim["session_id"] == session["session_id"]
            && (claim["ticket_id"].is_null() || claim["ticket_id"] == parent_ticket);
        let host_matches = claim["host_api"].is_null() || claim["host_api"] == session["host_api"];
        let sequence_matches = claim["observed_seq"].is_null()
            || claim["observed_seq"].as_u64() >= session["observed_seq"].as_u64();
        if !identity_matches || !host_matches || !sequence_matches {
            bail!("parent_session_ref must match the actual producer's Session, Ticket and observed sequence");
        }
    }
    Ok(json!({
        "artifact_input": source,
        "parent_session_ref": {
            "harness": "dsh", "session_id": session["session_id"], "protocol": "dsh-session-log",
            "host_api": session["host_api"], "observed_seq": session["observed_seq"], "ticket_id": parent_ticket,
        }
    }))
}

/// An existing Artifact's immutable ID gives the only legal known storage basename.
fn artifact_bytes(store: &Store, artifact: &Value) -> Result<Vec<u8>> {
    let id = Uuid::parse_str(artifact["id"].as_str().context("Artifact ID missing")?)?.to_string();
    let filename = format!("{id}.artifact");
    if artifact["storage_name"] != filename
        || artifact["location"] != format!("loom://artifact/{id}")
    {
        bail!("Artifact has an uncontrolled storage location");
    }
    let bytes = std::fs::read(store.root.join("artifacts").join(filename))?;
    let digest = sha256(&bytes);
    if bytes.is_empty()
        || bytes.len() > MAX_SOURCE_BYTES
        || bytes.len() != artifact["size_bytes"].as_u64().context("Artifact size")? as usize
        || artifact["sha256"].as_str() != Some(&digest)
    {
        bail!("Artifact bytes do not match immutable size/digest");
    }
    Ok(bytes)
}
fn source_artifact(store: &Store, ticket_id: &str) -> Result<(Value, Vec<u8>)> {
    let artifacts = store.query("SELECT * FROM artifacts WHERE ticket_id=?1", [ticket_id])?;
    if artifacts.len() != 1 {
        bail!("A document producer needs exactly one validated output Artifact");
    }
    let artifact = artifacts.into_iter().next().unwrap();
    if artifact["ticket_id"] != ticket_id {
        bail!("Selected Artifact has a different producer Ticket");
    }
    let bytes = artifact_bytes(store, &artifact)?;
    for parent in artifact["lineage"].as_array().into_iter().flatten() {
        let known = store
            .get(
                "artifacts",
                parent["artifact_id"]
                    .as_str()
                    .context("Missing source ID")?,
            )
            .context("Parent Artifact not registered")?
            .context("Registered parent record missing")?;
        if parent["sha256"] != known["sha256"]
            || parent["origin_node_id"] != known["origin_node_id"]
            || parent["source_ticket_id"] != known["ticket_id"]
        {
            bail!("Artifact parent descriptor does not match immutable registry");
        }
    }
    Ok((artifact, bytes))
}
fn artifact_input_for_task(store: &Store, ticket_id: &str) -> Result<Value> {
    let (artifact, bytes) = source_artifact(store, ticket_id)?;
    let id = artifact["id"]
        .as_str()
        .context("Parent Artifact UUID missing")?;
    let reference = json!({
        "type": "artifact_ref",
        "artifact_id": id,
        "ticket_id": artifact["ticket_id"],
        "origin_node_id": artifact["origin_node_id"],
        "sha256": artifact["sha256"],
        "location": format!("loom://artifact/{id}"),
        "parents": artifact["lineage"],
    });
    Ok(json!({
        "artifact_ref": reference,
        "bytes_base64": STANDARD.encode(bytes),
    }))
}

/// The edit Ticket embeds only the immutable, controller-produced source payload.
/// It does not become a license to read the producer's local filesystem.
fn descend(store: &mut Store, definition: &Definition) -> Result<()> {
    let pipeline_id = definition.pipeline_id.to_string();
    let parent_row = stage_row(store, &definition.pipeline_id, &definition.read)?
        .context("Source stage is missing")?;
    let Some(parent_ticket) = parent_row["ticket_id"].as_str() else {
        return Ok(());
    };
    let parent = store
        .get("tickets", parent_ticket)?
        .context("Producer Ticket missing")?;
    if parent["kind"] != "read_summary" || parent["status"] != "succeeded" {
        return Ok(());
    }
    let edit_row = stage_row(store, &definition.pipeline_id, &definition.edit)?
        .context("Edit stage is missing")?;
    if !edit_row["ticket_id"].is_null() {
        store.conn().execute(
            "UPDATE document_pipeline_stages SET checkpoint_state=?1,updated_at=?2 WHERE pipeline_id=?3 AND stage_id=?4",
            params![edit_row["checkpoint_state"].as_str(), crate::now(), &pipeline_id, &definition.edit.stage_id],
        )?;
        return Ok(());
    }
    // Artifact existence, task link, IDs and actual bytes are prerequisites.
    let (input, text) = source_artifact(store, parent_ticket)?;
    if input["origin_node_id"] != parent["node_id"] {
        bail!("Producer origin differs from its Ticket");
    }
    let (node, worker) = scope(store, &definition.edit, &definition.project_id)?;
    let transform = definition
        .edit
        .transform
        .context("No bounded text transform")?;
    if definition.edit.direct {
        return with_transaction(store, |store| {
            let ticket = maintenance::create_ticket(
                &mut *store,
                &definition.project_id,
                "edit_file",
                &format!("{}: direct trim handoff", name(definition)),
                &definition.edit.relative_path,
                None,
                &definition.edit.grant_id,
                Some(&node),
                Some(&worker),
                Some("edit_file"),
                None,
                None,
                0,
            )?;
            let child_id = ticket["id"]
                .as_str()
                .context("Direct descendant needs a Ticket")?;
            store.conn().execute("UPDATE document_pipeline_stages SET ticket_id=?1,updated_at=?2 WHERE pipeline_id=?3 AND stage_id=?4", params![child_id, crate::now(), &pipeline_id, &definition.edit.stage_id])?;
            store.audit(Some(child_id), "controller", "pipeline.direct.issued", &json!({
                "pipeline_id": pipeline_id, "parent_artifact_id": input["id"], "parent_sha256": input["sha256"],
                "source_ticket_id": parent_ticket, "destination_ticket_id": child_id,
            }))?;
            Ok(())
        });
    }
    let text = std::str::from_utf8(&text).context("Input is not UTF-8 text")?;
    let content = loom_protocol::DocumentEdit::TextTransform { transform }.apply(text)?;
    if content.len() > MAX_SOURCE_BYTES {
        bail!("Derived document is too large");
    }
    with_transaction(store, |store| {
        let ticket = maintenance::create_ticket(
            &mut *store,
            &definition.project_id,
            "edit_file",
            &format!("{}: {}", name(definition), definition.edit.stage_id),
            &definition.edit.relative_path,
            Some(&content),
            &definition.edit.grant_id,
            Some(&node),
            Some(&worker),
            Some("edit_file"),
            None,
            None,
            0,
        )?;
        let child_id = ticket["id"]
            .as_str()
            .context("Derived stage has no Ticket")?;
        store.conn().execute(
        "UPDATE document_pipeline_stages SET ticket_id=?1,updated_at=?2 WHERE pipeline_id=?3 AND stage_id=?4",
        params![child_id, crate::now(), &pipeline_id, &definition.edit.stage_id],
    )?;
        store.audit(
        Some(child_id),
        "controller",
        "pipeline.next_stage_issued",
        &json!({
            "pipeline_id": pipeline_id, "stage_id": definition.edit.stage_id, "ticket_id": child_id,
            "parent_ticket": parent_ticket, "raw_grant_id": definition.edit.grant_id,
            "parent_artifact_id": input["id"], "parent_sha256": input["sha256"],
        }),
    )?;
        Ok(())
    })?;
    Ok(())
}
/// Bounded polling hook. Pipelines only advance from actual successful Task reports.
pub fn advance_all(store: &mut Store) -> Result<()> {
    let runs = store.query(
        "SELECT id,cancel_requested_at,definition_json FROM document_pipeline_runs ORDER BY created_at LIMIT 128",
        [],
    )?;
    for run in runs {
        if !run["cancel_requested_at"].is_null() {
            continue;
        }
        let definition = definition_of(&run)?;
        descend(store, &definition)?;
        let id = definition.pipeline_id.to_string();
        refresh(store, &id)?;
    }
    Ok(())
}
fn task_state(store: &Store, stage: &Value) -> Result<String> {
    match stage["ticket_id"].as_str() {
        None => Ok("waiting_approval".into()),
        Some(ticket) => Ok(store
            .get("tickets", ticket)?
            .context("Pipeline ticket not found")?["status"]
            .as_str()
            .context("Missing Ticket status")?
            .to_owned()),
    }
}
fn refresh(store: &Store, pipeline_id: &str) -> Result<()> {
    for stage in store.query(
        "SELECT * FROM document_pipeline_stages WHERE pipeline_id=?1",
        [pipeline_id],
    )? {
        let state = task_state(store, &stage)?;
        if stage["checkpoint_state"] != state {
            store.conn().execute("UPDATE document_pipeline_stages SET checkpoint_state=?1,updated_at=?2 WHERE pipeline_id=?3 AND stage_id=?4",
                params![state,crate::now(),pipeline_id,stage["stage_id"].as_str()])?;
        }
    }
    Ok(())
}
fn finished(states: &[String]) -> bool {
    !states.is_empty() && states.iter().all(|state| state == "succeeded")
}
fn present(store: &Store, pipeline_id: &str) -> Result<Value> {
    let mut run = run_row(store, pipeline_id)?.context("Pipeline not found")?;
    let definition = definition_of(&run)?;
    let stages = refresh_and_get(store, pipeline_id)?;
    run["stages"] = Value::Array(stages.clone());
    run["status"] = json!(overall_status(store, &run, &stages)?);
    run["definition"] = serde_json::to_value(definition)?;
    Ok(run)
}
fn refresh_and_get(store: &Store, id: &str) -> Result<Vec<Value>> {
    refresh(store, id)?;
    store.query(
        "SELECT * FROM document_pipeline_stages WHERE pipeline_id=?1 ORDER BY rowid",
        [id],
    )
}
fn overall_status(store: &Store, run: &Value, stages: &[Value]) -> Result<String> {
    let statuses = stages
        .iter()
        .map(|stage| task_state(store, stage))
        .collect::<Result<Vec<_>>>()?;
    if finished(&statuses) {
        return Ok("succeeded".into());
    }
    if statuses.iter().any(|state| state == "reconciling") {
        return Ok("reconciling".into());
    }
    if !run["cancel_requested_at"].is_null()
        || statuses.iter().any(|state| state == "cancel_requested")
    {
        return Ok(if statuses.iter().all(|state| state == "cancelled") {
            "cancelled".into()
        } else {
            "cancel_requested".into()
        });
    }
    if statuses.iter().any(|state| state == "failed") {
        return Ok("failed".into());
    }
    if statuses.iter().any(|state| state == "cancelled") {
        return Ok("cancelled".into());
    }
    if statuses.iter().any(|state| state == "running") {
        return Ok("running".into());
    }
    Ok("waiting_approval".into())
}
pub fn list(store: &Store) -> Result<Value> {
    let runs = store.query("SELECT id,name,project_id,created_at FROM document_pipeline_runs ORDER BY created_at DESC LIMIT 100", [])?;
    let mut entries = Vec::new();
    for run in runs {
        let stages = stage_row_status(store, &run)?;
        entries.push(json!({
            "id":run["id"], "project_id":run["project_id"], "name":run["name"],
            "created_at":run["created_at"], "status":overall_status(store, &run, &stages)?,
        }));
    }
    Ok(json!(entries))
}
fn stage_row_status(store: &Store, run: &Value) -> Result<Vec<Value>> {
    store.query(
        "SELECT * FROM document_pipeline_stages WHERE pipeline_id=?1",
        [run["id"].as_str().context("Pipeline ID missing")?],
    )
}
pub fn detail(store: &Store, id: &str) -> Result<Value> {
    present(store, id)
}
pub fn cancel(store: &Store, id: &str) -> Result<()> {
    let stages = stage_row_status(
        store,
        run_row(store, id)?.as_ref().context("Pipeline not found")?,
    )?;
    store.conn().execute(
        "UPDATE document_pipeline_runs SET cancel_requested_at=?1,updated_at=?1 WHERE id=?2",
        params![crate::now(), id],
    )?;
    for stage in stages {
        if let Some(ticket) = stage["ticket_id"].as_str() {
            let current = task_state(store, &stage)?;
            if ["running", "cancel_requested", "waiting_approval", "pending"]
                .contains(&current.as_str())
            {
                maintenance::cancel(store, ticket)?;
                store.audit(
                    Some(ticket),
                    "client",
                    "pipeline.cancel_requested",
                    &json!({"pipeline_id":id}),
                )?;
            }
        }
    }
    Ok(())
}

/// A Node receives this optional input only on its real descendant Assignment.
pub fn input_for_assignment(store: &Store, ticket_id: &str) -> Result<Option<Value>> {
    let Some(link) = store
        .query(
            "SELECT * FROM document_pipeline_stages WHERE ticket_id=?1",
            [ticket_id],
        )?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let run = run_row(store, link["pipeline_id"].as_str().context("Missing run")?)?
        .context("Pipeline not found")?;
    let definition = definition_of(&run)?;
    if link["stage_id"] == definition.read.stage_id {
        return Ok(None);
    }
    if link["stage_id"] != definition.edit.stage_id {
        bail!("Pipeline Ticket is mapped to an unknown stage");
    }
    let parent = stage_row(store, &definition.pipeline_id, &definition.read)?
        .context("Actual producer mapping missing")?;
    let Some(parent_ticket) = parent["ticket_id"].as_str() else {
        bail!("Derived stage has no producer Ticket")
    };
    if parent["raw_grant_id"] != definition.read.grant_id {
        bail!("Producer binding mismatched raw grant");
    }
    let ticket = store
        .get("tickets", parent_ticket)?
        .context("Producer lost")?;
    if ticket["status"] != "succeeded" {
        bail!("Descendant cannot start before a real successful producer");
    }
    let input = artifact_input_for_task(store, parent_ticket)?;
    if definition.edit.direct {
        return Ok(Some(
            json!({"direct_offer": true, "artifact_ref": input["artifact_ref"],
            "transform": "trim", "offer_scope": "recipient_current_lease_only"}),
        ));
    }
    Ok(Some(input))
}

pub fn present_handler(store: &Store, id: &str) -> Result<Value> {
    present(store, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_document_transform_is_available() {
        let sample = loom_protocol::DocumentEdit::TextTransform {
            transform: loom_protocol::TextTransform::CollapseWhitespace,
        };
        assert_eq!(
            sample.apply("alpha\n beta gamma").unwrap(),
            "alpha beta gamma"
        );
        let restricted = json!({
            "schema":SCHEMA,"version":1,
            "pipeline_id":Uuid::new_v4(),
            "project_id":"project_fixture",
            "read":{"stage_id":"source","kind":"read_summary","grant_id":"grant_a","relative_path":"docs/a.txt","depends_on":[]},
            "edit":{"stage_id":"derived","kind":"edit_file","grant_id":"grant_b","relative_path":"docs/b.txt","depends_on":["source"],"transform":"uppercase"},
        });
        let parsed: Definition = serde_json::from_value(restricted).unwrap();
        parsed.validate().unwrap();
        assert_eq!(
            parsed.edit.transform,
            Some(loom_protocol::TextTransform::Uppercase)
        );
    }
    #[test]
    fn nil_or_cross_dependency_is_not_a_ready_document_workflow() {
        let invalid = json!({
            "schema":SCHEMA,"version":1,"pipeline_id":Uuid::nil(),
            "project_id":"project_fixture",
            "read":{"stage_id":"source","kind":"read_summary","grant_id":"grant_a","relative_path":"docs/a.txt"},
            "edit":{"stage_id":"source","kind":"edit_file","grant_id":"grant_b","relative_path":"docs/b.txt","depends_on":[],"transform":"trim"},
        });
        let definition: Definition = serde_json::from_value(invalid).unwrap();
        assert!(definition.validate().is_err());
    }
}
