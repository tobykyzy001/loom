use crate::store::{hash, Store};
use crate::*;
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde_json::{json, Value};

pub(crate) struct SourceWork {
    pub event_id: String,
    pub project: String,
    pub event_digest: String,
    pub objective: String,
    pub path: String,
    pub spec: crate::source_work::TaskSpec,
}

pub fn grant_binding_for_placement(store: &Store, grant_id: &str) -> Result<Option<String>> {
    let Some(grant) = store.get("grants", grant_id)? else {
        return Ok(None);
    };
    let binding = grant["project_binding_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if binding.is_empty() {
        return Ok(None);
    }
    let root = store.query(
        "SELECT id FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
        [&binding],
    )?;
    if root.len() == 1 {
        Ok(Some(binding))
    } else {
        Ok(None)
    }
}

pub fn matching_physical_node(
    store: &Store,
    capability: &str,
    preferred: Option<&str>,
    grant: &Value,
    _worker: &str,
) -> Result<Option<Value>> {
    let nodes = store.list("nodes")?;
    Ok(nodes.into_iter().find(|node| {
        if node["revoked_at"] != Value::Null {
            return false;
        }
        if preferred.is_some_and(|wanted| wanted != node["id"].as_str().unwrap_or_default()) {
            return false;
        }
        if node["status"] == "offline" {
            return false;
        }
        if grant["revoked_at"] != Value::Null {
            return false;
        }
        if grant["node_id"] != "auto" && grant["node_id"] != node["id"] {
            return false;
        }
        if grant["installation_id"].as_str().is_some_and(|id| {
            id != "*" && id != node["installation_id"].as_str().unwrap_or_default()
        }) {
            return false;
        }
        if node["last_heartbeat"]
            .as_str()
            .and_then(|t| crate::parse_time(t).ok())
            .is_none_or(|t| chrono::Utc::now() - t >= chrono::Duration::seconds(90))
        {
            return false;
        }
        let worker_matches = grant["worker_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .is_none_or(|worker| {
                node["workers"].as_array().is_some_and(|workers| {
                    workers.iter().any(|candidate| {
                        candidate
                            .get("worker_id")
                            .or_else(|| candidate.get("id"))
                            .and_then(Value::as_str)
                            == Some(worker)
                    })
                }) || worker == "default"
                    && node["workers"]
                        .as_array()
                        .is_none_or(|workers| workers.is_empty())
            });
        if !worker_matches {
            return false;
        }
        node["capabilities"].as_array().is_some_and(|values| {
            values.iter().any(|value| {
                value.get("ticket_kind").and_then(Value::as_str) == Some(capability)
                    || value.as_str() == Some(capability)
                    || value.as_str() == Some(&format!("file:{capability}"))
            })
        })
    }))
}

#[allow(clippy::too_many_arguments)]
pub fn create_ticket(
    store: &mut Store,
    project_id: &str,
    kind: &str,
    objective: &str,
    path: &str,
    content: Option<&str>,
    grant_id: &str,
    preferred: Option<&str>,
    worker: Option<&str>,
    capability: Option<&str>,
    model_resource: Option<(&str, &str, Option<Value>)>,
    source_work: Option<SourceWork>,
    priority: i64,
) -> Result<Value> {
    if !(-100..=100).contains(&priority) {
        bail!("Ticket priority must be an integer between -100 and 100");
    }
    if let Some(work) = &source_work {
        if kind != "read_summary"
            || content.is_some()
            || model_resource.is_some()
            || preferred != Some(work.spec.value["node_id"].as_str().unwrap_or_default())
            || capability != Some("read_summary")
            || worker != Some(work.spec.value["worker_id"].as_str().unwrap_or_default())
            || work.project != project_id
            || work.objective != objective
            || work.path != path
            || work.event_digest
                != work.spec.value["event_request_digest"]
                    .as_str()
                    .unwrap_or_default()
            || work.spec.value["grant_id"] != grant_id
            || priority != 0
        {
            bail!("The frozen Source task specification does not match this Ticket request");
        }
    }
    let node_id = matching_physical_node(
        store,
        capability.unwrap_or(kind),
        preferred,
        &store.get("grants", grant_id)?.context("Grant not found")?,
        worker.unwrap_or("default"),
    )?;
    let model_content = if let Some((provider, model, ref binding)) = model_resource {
        let binding = binding.as_ref().ok_or_else(|| {
            anyhow::anyhow!("A registered model binding is mandatory for model_text")
        })?;
        Some(json!({"schema":"loom.model-text.v1","objective":objective,"provider":provider,"model":model,"model_binding":binding}).to_string())
    } else {
        None
    };
    if kind == "model_text" {
        let request: Value = serde_json::from_str(model_content.as_deref().unwrap_or_default())?;
        if request["model_binding"]
            != model_resource
                .as_ref()
                .map_or(Value::Null, |(_, _, binding)| {
                    binding.clone().unwrap_or(Value::Null)
                })
            || !request["model_binding"].is_object()
        {
            bail!("A registered immutable model binding is mandatory for model_text");
        }
    }
    let content = model_content.as_deref().or(content);
    if (kind == "model_text") != model_resource.is_some() {
        bail!(
            "Each text-model Ticket must have its explicit resource and no other kind may carry it"
        );
    }
    if let Some((provider, model, _)) = model_resource {
        if (provider, model) != ("loom-stub", "loom-stub-v1") {
            bail!("Only the explicitly observed text fixture is supported in this boundary");
        }
    }
    let now = crate::now();
    let ticket = source_work
        .as_ref()
        .and_then(|work| work.spec.value["ticket_id"].as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| id("tkt"));
    let binding = grant_binding_for_placement(store, grant_id)?;
    let mut placement = if let Some(binding_id) = &binding {
        crate::inventory::decide_placement(
            store,
            &crate::inventory::PlacementRequest {
                project_id: project_id.to_owned(),
                capability: capability.unwrap_or(kind).to_owned(),
                worker_id: worker.unwrap_or("default").to_owned(),
                preferred_node_id: preferred.map(ToOwned::to_owned),
                grant_id: grant_id.to_owned(),
                project_binding_id: binding_id.clone(),
                evaluated_at: chrono::Utc::now(),
                hardware: None,
            },
        )?
    } else {
        crate::inventory::PlacementDecision {
            schema: crate::inventory::INVENTORY_SCHEMA.to_owned(),
            selected: None,
            waiting: vec![],
            explanation: "No authorized ProjectBinding covers this placement.".to_owned(),
            existing_grant_matching_passed: false,
            permission_boundary: crate::inventory::DISCOVERY_BOUNDARY.to_owned(),
        }
    };
    placement.explanation = if binding.is_some() {
        placement.explanation
    } else {
        "No exact, authorized ProjectBinding covers this task.".to_owned()
    };
    let Some(node_id) = node_id else {
        let worker = worker.unwrap_or("default");
        let node = preferred.unwrap_or("waiting_for_host");
        let placement_node = if let Some(work) = &source_work {
            if work.event_digest
                != work.spec.value["event_request_digest"]
                    .as_str()
                    .unwrap_or_default()
                || work.spec.value["grant_digest"]
                    .as_str()
                    .unwrap_or_default()
                    .is_empty()
                || work.spec.value["installation_id"]
                    .as_str()
                    .unwrap_or_default()
                    .is_empty()
                || work.spec.value["grant_id"] != grant_id
                || work.spec.value["project_id"] != project_id
                || work.spec.value["node_id"] != node
                || work.spec.value["worker_id"] != worker
            {
                bail!("The actual Node cannot mutate the frozen Source work specification");
            }
            work.spec.value["node_id"].as_str().unwrap_or_default()
        } else {
            node
        };
        let tx = store.conn_mut().savepoint()?;
        tx.execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,created_at,updated_at,priority) VALUES(?1,?2,?3,?4,?5,?6,'waiting_approval',?7,?8,?9,?10,?11,?12,?12,?13)",params![ticket,project_id,objective,kind,path,content,grant_id,source_work.as_ref().map(|work| work.spec.value["grant_digest"].as_str().unwrap_or_default()).unwrap_or_default(),placement_node,source_work.as_ref().map(|work| work.spec.value["installation_id"].as_str().unwrap_or_default()).unwrap_or_default(),worker,now,priority])?;
        crate::store::audit_tx(
            &tx,
            Some(&ticket),
            "controller",
            "assignment.waiting",
            &json!({"required_capability":capability.unwrap_or(kind),"grant_id":grant_id,"priority":priority,"hint":"Wait for a covered node or explicitly reassign with a new Grant.","placement":&placement}),
        )?;
        if let Some(work) = source_work {
            crate::source_events::attach_event_to_ticket(&tx, &work)
                .map_err(|error| anyhow::anyhow!(error.message))?;
        }
        tx.commit()?;
        return store.detail(&ticket).context("new queued ticket");
    };
    let grant = store.get("grants", grant_id)?.context("Grant not found")?;
    let worker = worker.unwrap_or("default");
    if let Some(bound_worker) = grant["worker_id"].as_str().filter(|root| !root.is_empty()) {
        if bound_worker != worker {
            bail!("Worker placement exceeds Grant scope")
        }
    }
    let assignment = id("asg");
    let at = now;
    let expires = (chrono::Utc::now() + chrono::Duration::seconds(75)).to_rfc3339();
    let tx = store.conn_mut().savepoint()?;
    tx.execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at,priority) VALUES(?1,?2,?3,?4,?5,?6,'running',?7,(SELECT digest FROM grants WHERE id=?7),?8,?9,?10,1,?11,?11,?12)",params![ticket,project_id,objective,kind,path,content,grant_id,node_id["id"].as_str(),node_id["installation_id"].as_str(),worker,at,priority])?;
    tx.execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES(?1,?2,?3,?4,1,?5,1,?6,?7)",params![assignment,ticket,node_id["id"].as_str(),worker,id("lease"),expires,at])?;
    tx.execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,visibility,created_at) VALUES(?1,?2,'user','concierge','activity',?3,'summary',?4)",params![crate::id("msg"),ticket,"Ticket saved; an authorized assignment and lease were issued.",at])?;
    crate::store::audit_tx(
        &tx,
        Some(&ticket),
        "controller",
        "assignment.leased",
        &json!({"assignment_id":assignment,"node_id":node_id["id"],"grant_id":grant_id,"priority":priority,"placement":&placement}),
    )?;
    if let Some(work) = source_work {
        if work.event_digest
            != work.spec.value["event_request_digest"]
                .as_str()
                .unwrap_or_default()
            || work.spec.value["node_id"] != node_id["id"]
            || work.spec.value["installation_id"] != node_id["installation_id"]
        {
            bail!("The selected host or event no longer matches the immutable Source spec");
        }
        crate::source_events::attach_event_to_ticket(&tx, &work)
            .map_err(|error| anyhow::anyhow!(error.message))?;
        crate::store::audit_tx(
            &tx,
            Some(&ticket),
            "client",
            "source.ticket.linked",
            &json!({"source_event_id":work.event_id,"ticket_id":ticket,"task_digest":work.spec.digest,"binding":"independently_authorized_new_task"}),
        )?;
    }
    tx.commit()?;
    store.detail(&ticket)
}

const ELIGIBLE_ASSIGNMENTS: &str = r#"
WITH eligible AS (
    SELECT t.id AS ticket_id,t.project_id,t.kind,t.objective,t.relative_path,t.content,
           t.status,t.node_id,t.installation_id,t.worker_id,t.attempt,t.grant_digest,
           t.cancel_requested,t.priority,a.id AS assignment_id,a.lease_id,a.lease_epoch,
           a.lease_expires_at,g.operations AS grant_operations,
           g.revoked_at AS grant_revoked_at,a.created_at AS assignment_created_at,
           a.acknowledged_at
    FROM assignments a
    JOIN tickets t ON t.id=a.ticket_id
    JOIN grants g ON g.id=t.grant_id
    WHERE a.node_id=?1 AND t.attempt=a.lease_epoch
      AND (t.status IN ('running','cancel_requested')
           OR (t.status IN ('reconciling') AND a.last_report_at IS NULL))
      AND (g.revoked_at IS NULL
           OR (t.status='reconciling' AND t.kind='edit_file' AND t.cancel_requested=0
               AND a.acknowledged_at IS NOT NULL AND a.last_report_at IS NULL
               AND g.version=2 AND t.grant_digest=g.digest))
      AND (a.acknowledged_at IS NULL OR t.cancel_requested=1 OR t.status='reconciling')
)
SELECT ticket_id,project_id,kind,objective,relative_path,content,status,node_id,
       installation_id,worker_id,attempt,grant_digest,cancel_requested,assignment_id,
       lease_id,lease_epoch,lease_expires_at,grant_operations,grant_revoked_at
FROM eligible
WHERE TRUE"#;

pub fn assignment_for_poll(store: &mut Store, node_id: &str) -> Result<Option<Value>> {
    crate::pipeline::advance_all(store)?;
    let stop = store.query(
        &format!("{ELIGIBLE_ASSIGNMENTS} AND (status='reconciling' OR cancel_requested=1) ORDER BY assignment_created_at DESC LIMIT 1"),
        [node_id],
    )?;
    let assignment = if let Some(stop) = stop.into_iter().next() {
        Some(stop)
    } else {
        store.query(
            &format!("{ELIGIBLE_ASSIGNMENTS} AND acknowledged_at IS NULL AND status='running' AND cancel_requested=0 ORDER BY priority DESC,assignment_created_at DESC LIMIT 1"),
            [node_id],
        )?
        .into_iter()
        .next()
    };
    if let Some(mut assignment) = assignment {
        crate::source_events::ensure_source_work_approval(
            store,
            assignment["ticket_id"].as_str().unwrap_or_default(),
        )?;
        let current = assignment["lease_epoch"].as_i64().unwrap_or(0);
        let id = assignment["assignment_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        if assignment["status"] == "running" {
            store.conn().execute(
                "UPDATE assignments SET lease_expires_at=?1 WHERE id=?2 AND lease_epoch=?3",
                params![
                    (chrono::Utc::now() + chrono::Duration::seconds(45)).to_rfc3339(),
                    id,
                    current
                ],
            )?;
            assignment["lease_expires_at"] =
                json!((chrono::Utc::now() + chrono::Duration::seconds(45)).to_rfc3339());
        }
        assignment["purpose"] = json!(if assignment["status"] == "reconciling" {
            "reconcile"
        } else {
            "execute"
        });
        assignment["protocol"] = json!("loom.node.v1");
        assignment["id"] = assignment["assignment_id"].clone();
        assignment["node_id"] = json!(node_id);
        assignment["grant_status"] = json!(true);
        assignment["operation"] = json!({"kind":assignment["kind"],"path":assignment["relative_path"],"write":assignment["kind"]=="edit_file"});
        if assignment["kind"] == "model_text" {
            let input: Value = serde_json::from_str(
                assignment["content"]
                    .as_str()
                    .context("A text-model Ticket must contain its bounded immutable request")?,
            )?;
            if input["schema"] != "loom.model-text.v1"
                || input["objective"] != assignment["objective"]
                || input["provider"].as_str() != Some("loom-stub")
                || input["model"].as_str() != Some("loom-stub-v1")
            {
                bail!("Text-model request metadata changed or is not the authorized fixture");
            }
            assignment["provider"] = input["provider"].clone();
            assignment["model"] = input["model"].clone();
            assignment["model_binding"] = input["model_binding"].clone();
            if !assignment["model_binding"].is_object() {
                bail!("A registered model binding is required for every text-model Assignment");
            }
        }
        if assignment["kind"] == "credential_ref" {
            let ticket = store
                .get(
                    "tickets",
                    assignment["ticket_id"].as_str().unwrap_or_default(),
                )?
                .ok_or_else(|| anyhow::anyhow!("Credential task Ticket is absent"))?;
            let verified = crate::credential_ref::authority(
                store,
                assignment["ticket_id"].as_str().unwrap_or_default(),
                &assignment,
            )?;
            assignment["project_id"] = ticket["project_id"].clone();
            assignment["installation_id"] = ticket["installation_id"].clone();
            assignment["credential_ref"] = verified["credential_ref"].clone();
            assignment["grant_credential_ref"] = verified["grant_credential_ref"].clone();
            assignment["credential_revoke_expected"] =
                verified["credential_revoke_expected"].clone();
            assignment["credential_action"] = verified["action"].clone();
        }
        assignment["grant"] = json!(store
            .query(
                "SELECT * FROM grants WHERE id=(SELECT grant_id FROM tickets WHERE id=?1)",
                [assignment["ticket_id"].as_str().unwrap_or_default()]
            )?
            .into_iter()
            .next());
        let revoked_stop = !assignment["grant_revoked_at"].is_null();
        // Grants are created at version 1. The sole production version mutation is
        // revoke_grant's single increment, and the revoked selection above also
        // requires the Ticket's original digest to match. Preserve that admitted
        // version for the node-side identity fence; the Grant object separately
        // exposes its current version and revoked status. Never infer other deltas.
        assignment["grant_version"] = if revoked_stop {
            json!(1)
        } else {
            assignment["grant"]["version"].clone()
        };
        assignment["grant_digest"] = assignment["grant"]["digest"].clone();
        assignment["grants"] = json!([assignment["grant"]]);
        if assignment["kind"] == "model_text" {
            let verified = crate::model_registry::bound_for_invocation(store, &assignment)?;
            if verified["placement_auditable"] != true {
                bail!("The invocation did not produce an auditable current placement binding");
            }
            let place_grant = store
                .get(
                    "grants",
                    assignment["model_binding"]["placement_grant_id"]
                        .as_str()
                        .unwrap_or_default(),
                )?
                .ok_or_else(|| anyhow::anyhow!("The current placement Grant is absent"))?;
            assignment["grants"] = json!([assignment["grant"], place_grant]);
        }
        let binding = store.query(
            "SELECT root_scope,project_id,node_id,installation_id,worker_id FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
            [assignment["grant"]["project_binding_id"].as_str().unwrap_or_default()],
        )?.into_iter().next().ok_or_else(|| anyhow::anyhow!("The assignment's exact project binding is gone"))?;
        if revoked_stop {
            let exact_physical_binding = [
                ("project_id", "project_id"),
                ("node_id", "node_id"),
                ("installation_id", "installation_id"),
                ("worker_id", "worker_id"),
            ]
            .into_iter()
            .all(|(binding_key, ticket_key)| binding[binding_key] == assignment[ticket_key]);
            let root = binding["root_scope"].as_str().unwrap_or_default();
            if !exact_physical_binding || !root.starts_with('/') || root == "/" {
                bail!("A revoked assignment requires its original exact physical project binding");
            }
            // This stop is only for deterministic file work, not the reissued
            // source-input or special model/credential authority paths.
            if crate::pipeline::input_for_assignment(
                store,
                assignment["ticket_id"].as_str().unwrap_or_default(),
            )?
            .is_some()
            {
                bail!("A revoked stop cannot carry a derived source-work authority path");
            }
        }
        if assignment["kind"] != "credential_ref" {
            assignment["grant"]["project_root"] = binding["root_scope"].clone();
        }
        assignment["resource"] = binding;
        if let Some(source) = crate::pipeline::input_for_assignment(
            store,
            assignment["ticket_id"].as_str().unwrap_or_default(),
        )? {
            assignment["artifact_input"] = source;
        }
        assignment["grant_status"] = json!(assignment["grant"]["revoked_at"].is_null());
        Ok(Some(assignment))
    } else {
        Ok(None)
    }
}

pub fn cancel(store: &Store, ticket: &str) -> Result<()> {
    let t = store.get("tickets", ticket)?.context("ticket not found")?;
    let status = t["status"].as_str().unwrap_or_default();
    if t["cancel_requested"] == true || status == "cancel_requested" {
        return Ok(());
    }
    if status == "succeeded" {
        return Ok(());
    }
    if matches!(status, "pending" | "waiting_approval") {
        store.conn().execute(
            "UPDATE tickets SET status='cancelled',cancel_requested=1,updated_at=?1 WHERE id=?2",
            params![crate::now(), ticket],
        )?;
    } else {
        store.conn().execute("UPDATE tickets SET status='cancel_requested',cancel_requested=1,updated_at=?1 WHERE id=?2",params![crate::now(),ticket])?;
    }
    store.conn().execute("UPDATE assignments SET cancelled_at=?1,lease_expires_at=?1 WHERE ticket_id=?2 AND cancelled_at IS NULL",params![crate::now(),ticket])?;
    Ok(())
}
#[derive(Clone, Copy)]
pub(crate) struct ApprovalContext<'a> {
    pub approval_id: &'a str,
    pub reason: &'a str,
}

#[derive(Clone, Copy)]
enum AttemptMode<'a> {
    FailedRetry,
    Approval {
        context: Option<ApprovalContext<'a>>,
    },
}

pub fn retry(store: &Store, ticket: &str) -> Result<()> {
    issue_next_attempt(store, ticket, AttemptMode::FailedRetry)
}

/// Compatibility entry point for the original in-process approval helper. Unlike
/// the authenticated HTTP decision it carries no user reason and no grant audit.
#[allow(dead_code)]
pub fn retry_after_approval(store: &Store, ticket: &str) -> Result<()> {
    issue_next_attempt(store, ticket, AttemptMode::Approval { context: None })
}

pub fn approve_ticket(store: &Store, ticket: &str, context: ApprovalContext<'_>) -> Result<()> {
    issue_next_attempt(
        store,
        ticket,
        AttemptMode::Approval {
            context: Some(context),
        },
    )
}

pub fn reject_ticket(store: &Store, ticket: &str, context: ApprovalContext<'_>) -> Result<()> {
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> Result<()> {
        let current = store.get("tickets", ticket)?.context("ticket not found")?;
        if current["status"] == "reconciling" {
            bail!("Unresolved outcomes require effect reconciliation, not blind retry.")
        }
        if current["cancel_requested"] == true {
            bail!("Durable stop intent cannot be overwritten by an automatic retry")
        }
        if current["status"] != "waiting_approval" {
            bail!("Only an exactly waiting-for-approval Ticket can be reviewed")
        }
        store.audit(
            Some(ticket),
            "client",
            "task.approval_rejected",
            &json!({
                "approval_id":context.approval_id,
                "reason":context.reason,
                "decision":"reject",
                "assignment_created":false,
                "remains":"waiting_approval",
            }),
        )?;
        Ok(())
    })();
    finish_attempt_transaction(store, result)
}

fn issue_next_attempt(store: &Store, ticket: &str, mode: AttemptMode<'_>) -> Result<()> {
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> Result<()> {
        // Status, authority and immutable work are all read again in this write
        // transaction. A previously loaded API response is not the decision input.
        let t = store.get("tickets", ticket)?.context("ticket not found")?;
        if t["status"] == "reconciling" {
            bail!("Unresolved outcomes require effect reconciliation, not blind retry.")
        }
        if t["cancel_requested"] == true {
            bail!("Durable stop intent cannot be overwritten by an automatic retry")
        }
        match mode {
            AttemptMode::FailedRetry if t["status"] != "failed" => {
                bail!("Only a failed Ticket can be retried")
            }
            AttemptMode::Approval { .. } if t["status"] != "waiting_approval" => {
                bail!("Only an exactly waiting-for-approval Ticket can issue its first attempt")
            }
            AttemptMode::FailedRetry => {}
            AttemptMode::Approval { .. } if t["attempt"].as_i64() != Some(0) => {
                bail!("Approval can only issue the first attempt of a waiting Ticket")
            }
            _ => {}
        }
        if store
            .query(
                "SELECT id FROM grants WHERE id=?1 AND revoked_at IS NULL",
                [t["grant_id"].as_str().unwrap_or_default()],
            )?
            .is_empty()
        {
            bail!("Grant revoked; cannot reactivate authorization through retry")
        }
        let context = match mode {
            AttemptMode::Approval { context } => context,
            AttemptMode::FailedRetry => None,
        };
        if context.is_some() {
            crate::source_events::ensure_source_work_approval(store, ticket)
                .map_err(anyhow::Error::new)?;
        }
        let attempt = t["attempt"].as_i64().unwrap_or(0);
        let epoch = attempt
            .checked_add(1)
            .context("Ticket attempt cannot be advanced without overflow")?;
        let asg = id("asg");
        let lease = id("lease");
        let program = store
            .get(
                "projects",
                t["project_id"]
                    .as_str()
                    .context("Ticket project required")?,
            )?
            .context("Ticket project not found")?;
        let at = crate::now();
        let updated = store.conn().execute(
            "UPDATE tickets SET status='running',attempt=?1,updated_at=?2 WHERE id=?3 AND status=?4 AND attempt=?5 AND cancel_requested=0",
            params![epoch, at, ticket, t["status"].as_str().unwrap_or_default(), attempt],
        )?;
        if updated != 1 {
            bail!("Ticket changed before its retry could be issued; no attempt was created")
        }
        let inserted = store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) SELECT ?1,id,node_id,worker_id,?2,?3,?2,?4,?5 FROM tickets WHERE id=?6 AND status='running' AND attempt=?2",params![asg,epoch,lease,(chrono::Utc::now()+chrono::Duration::seconds(75)).to_rfc3339(),at,ticket])?;
        if inserted != 1 {
            bail!("The current Ticket did not produce exactly one real Assignment")
        }
        store.audit(
            Some(ticket),
            "client",
            "assignment.retried",
            &json!({
                "assignment_id":asg,
                "lease_id":lease,
                "lease_epoch":epoch,
                "attempt":epoch,
                "node_id":t["node_id"],
                "project_revision":program["inventory"]["revision"],
            }),
        )?;
        match mode {
            AttemptMode::FailedRetry => {
                store.audit(Some(ticket), "client", "ticket.retried", &json!({}))?;
            }
            AttemptMode::Approval {
                context: Some(context),
            } => {
                store.audit(
                    Some(ticket),
                    "client",
                    "task.approval_granted",
                    &json!({
                        "approval_id":context.approval_id,
                        "reason":context.reason,
                        "decision":"approve",
                        "assignment_id":asg,
                        "lease_id":lease,
                        "lease_epoch":epoch,
                        "attempt":epoch,
                        "node_id":t["node_id"],
                        "grant_id":t["grant_id"],
                        "grant_digest":t["grant_digest"],
                        "source_authority_preserved":true,
                        "grant_created":false,
                    }),
                )?;
            }
            AttemptMode::Approval { context: None } => {}
        }
        Ok(())
    })();
    finish_attempt_transaction(store, result)
}

fn finish_attempt_transaction(store: &Store, result: Result<()>) -> Result<()> {
    let outcome = match result {
        Ok(()) => store
            .conn()
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(Into::into),
        Err(error) => Err(error),
    };
    if let Err(error) = outcome {
        // Commit is attempted only after the write closure succeeds. A failed
        // COMMIT gets one rollback attempt; a successful COMMIT never does.
        let rollback = store.conn().execute("ROLLBACK", []);
        return match rollback {
            Ok(_) => Err(error),
            Err(rollback) => Err(error.context(format!(
                "Attempt transaction rollback failed after unsuccessful storage/audit write: {rollback}"
            ))),
        };
    }
    Ok(())
}

fn matching_candidate(
    store: &Store,
    fingerprint: &str,
    scope: &str,
    kind: &str,
) -> Result<Option<Value>> {
    let rows=store.query("SELECT * FROM candidates WHERE scope=?1 AND kind=?2 AND status IN ('pending','accepted','rejected','later','never') ORDER BY created_at DESC,id DESC",rusqlite::params![scope,kind])?;
    for candidate in rows {
        let value: Value = match serde_json::from_str(candidate["content"].as_str().unwrap_or("{}"))
        {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value["fingerprint"].as_str() == Some(fingerprint) {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

pub fn observation_candidate(store: &Store, body: &Value) -> Result<Value> {
    let input = crate::observation_input::validate(store, body)?;
    let project = input["project_id"].as_str().unwrap_or_default().to_owned();
    store
        .get("projects", &project)?
        .context("Observation scope unknown")?;
    let kind = input["kind"].as_str().unwrap_or_default();
    let value = input["value"].as_str().unwrap_or_default();
    let fingerprint = hash(&json!({"project_id":project,"kind":kind,"value":value}).to_string());
    let source_refs = input["source_refs"].to_string();
    let now = chrono::Utc::now();
    let expires = (now + chrono::Duration::days(7)).to_rfc3339();
    let existing = store
        .query(
            "SELECT * FROM observations WHERE fingerprint=?1",
            [&fingerprint],
        )?
        .into_iter()
        .next();
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> Result<Value> {
        let mut occurrences = 1_i64;
        let mut merged_refs = input["source_refs"].clone();
        let mut prior_occurrences = None;
        if let Some(row) = existing {
            if row["scope"] != project {
                bail!("Observation fingerprint is not confined to its actual project")
            }
            prior_occurrences = row["occurrences"].as_i64();
            let outdated = crate::observation_input::expired(
                row["expires_at"].as_str().unwrap_or_default(),
                &now.to_rfc3339(),
            )?;
            let old_refs: Value =
                serde_json::from_str(row["source_refs"].as_str().unwrap_or("[]"))?;
            if !outdated {
                merged_refs =
                    crate::observation_input::union_ref_ids(&old_refs, &input["source_refs"])?;
                if merged_refs == old_refs {
                    let previous = matching_candidate(store, &fingerprint, &project, kind)?
                        .into_iter()
                        .next();
                    store.conn().execute("ROLLBACK", [])?;
                    return Ok(
                        json!({"candidate":previous,"existing_candidate":previous.is_some(),
                        "observations":row["occurrences"],"promotion":"retained_history_not_auto_promoted",
                        "reason":"Only a new explicit source Ticket can increase repetition",
                        "duplicate_source_observation":true,"no_standing_permission":true}),
                    );
                }
            }
            let merged_refs_json: String = serde_json::to_string(&merged_refs)?;
            let row_id: String = row["id"].as_str().unwrap_or_default().to_owned();
            let update = if outdated {
                store.audit(None,"client","memory.observation_reset_after_expiry",
                    &json!({"fingerprint":fingerprint,"previous_occurrences":prior_occurrences,"new_source_only":true}))?;
                store.conn().execute("UPDATE observations SET occurrences=1,source_refs=:refs,expires_at=:expires WHERE id=:id AND fingerprint=:fingerprint",
                    rusqlite::named_params!{":refs":merged_refs_json,":expires":expires,":id":&row_id,":fingerprint":&fingerprint})?
            } else {
                occurrences = row["occurrences"].as_i64().unwrap_or(0) + 1;
                store.conn().prepare("UPDATE observations SET occurrences=occurrences+1,source_refs=:refs WHERE id=:id AND fingerprint=:fingerprint")?
                    .execute(rusqlite::named_params!{":refs":merged_refs.to_string(),":id":&row_id,":fingerprint":&fingerprint})?
            };
            if update != 1 {
                bail!("Observation row no longer matches the original id and fingerprint; no overwritten observations")
            }
        } else {
            store.conn().execute("INSERT INTO observations(id,fingerprint,scope,occurrences,source_refs,expires_at,created_at) VALUES(?1,?2,?3,1,?4,?5,?5)",
                params![crate::id("observation"),fingerprint,project,source_refs,expires])?;
        }
        store.audit(None,"client","memory.observation_source_recorded",
            &json!({"scope":project,"occurrences":occurrences,"sources":merged_refs,"kind":kind,"authority_created":false}))?;
        let previous = matching_candidate(store, &fingerprint, &project, kind)?
            .into_iter()
            .next();
        if prior_occurrences.is_some() {
            if let Some(candidate) = previous {
                if !candidate["id"].is_null() {
                    store.conn().execute("COMMIT", [])?;
                    return Ok(
                        json!({"candidate":candidate,"existing_candidate":true,"occurrences":occurrences,
                            "promotion":"retained_history_not_auto_promoted","no_standing_permission":true}),
                    );
                }
            }
        }
        let minimum_sources = if kind == "skill" { 1 } else { 3 };
        if occurrences < minimum_sources {
            store.conn().execute("COMMIT", [])?;
            return Ok(json!({"candidate":null,"observations":occurrences,
                "reason":"Not enough consistent observations","no_standing_permission":true}));
        }
        let id = crate::id("candidate");
        let mut candidate = json!({"content":value,"fingerprint":fingerprint,"project_id":project,"kind":kind,
            "source":"repeated_explicit_choices","replay_state":"unverified"});
        if kind == "memory" {
            candidate["schema"] = json!("loom.memory-candidate.v1");
        }
        store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'pending',1,?6,?6)",
            params![id,kind,project,serde_json::to_string(&candidate)?,merged_refs.to_string(),crate::now()])?;
        store.audit(None,"client","candidate.proposed",&json!({"candidate_id":id,"scope":project,"source_refs":merged_refs,"authority_created":false}))?;
        store.conn().execute("COMMIT", [])?;
        Ok(
            json!({"candidate":store.query("SELECT * FROM candidates WHERE id=?1",[id])?.first(),"preview_required":true,"placement_grant_created":false}),
        )
    })();
    match result {
        Ok(candidate) => Ok(candidate),
        Err(error) => {
            let rollback = store.conn().execute("ROLLBACK", []);
            match rollback {
                Ok(_) => Err(error),
                Err(rollback) => {
                    Err(error.context(format!("Observation rollback failed: {rollback}")))
                }
            }
        }
    }
}

pub fn review_candidate(store: &Store, candidate_id: &str, body: &Value) -> Result<Value> {
    let rows = store.query("SELECT * FROM candidates WHERE id=?1", [candidate_id])?;
    let candidate = rows.first().context("candidate not found")?;
    if body["decision"].as_str() == Some("edit") {
        if candidate["kind"] != "memory" {
            bail!("Only a source-bound MemoryCandidate supports text editing");
        }
        return edit_memory_candidate(store, candidate, body);
    }
    if candidate["kind"] == "memory" {
        return review_memory_candidate(store, candidate, body);
    }
    if candidate["kind"] == "route" && matches!(body["decision"].as_str(), Some("accept" | "undo"))
    {
        bail!("A route candidate is not a portable memory or executable permission");
    }
    let action = body["decision"].as_str().unwrap_or_default();
    if !matches!(action, "accept" | "reject" | "later" | "never" | "undo") {
        bail!("unknown candidate review decision")
    }
    if action == "accept" {
        if candidate["status"] != "pending" {
            bail!("Only a pending candidate can be accepted once; repeat review creates no authority or extra memory/skill record");
        }
        if candidate["kind"] != "skill" {
            bail!("Only an explicit MemoryCandidate or separately verified SkillCandidate can be accepted");
        }
        let content: Value = serde_json::from_str(candidate["content"].as_str().unwrap_or("{}"))?;
        let kind = candidate["kind"].as_str().unwrap_or("memory");
        store.conn().execute("BEGIN IMMEDIATE", [])?;
        let result = (|| -> Result<Value> {
            if kind == "skill" {
                // The body boolean never matters. Byte-for-byte proof is reread from
                // both actual immutable artifacts at this exact acceptance boundary.
                let (replay, proof) =
                    crate::skill_replay::verified_for_accept(store, candidate_id)?;
                let summary = content["content"]
                    .as_str()
                    .unwrap_or("Bounded deterministic read_summary");
                if summary.len() > 500
                    || summary.contains("http://")
                    || summary.contains("https://")
                    || summary.contains("private_key")
                    || summary.contains("SECRET")
                    || summary.contains("api_key")
                {
                    bail!("Only a bounded public skill summary can be attached to replay evidence");
                }
                if let Some(extra) = body["content"].as_str() {
                    let supplied = body
                        .get("content")
                        .map(Value::to_string)
                        .unwrap_or_default();
                    if extra.len() > 500
                        || extra.contains("private_key")
                        || extra.contains("SECRET")
                        || extra.contains("api_key")
                        || extra.contains("http://")
                        || extra.contains("https://")
                        || supplied.len() > 1024
                    {
                        bail!("Unbounded/private client metadata is forbidden in a Skill record");
                    }
                }
                let definition = json!({"schema":"loom.skill-definition.v1","operation":"read_summary","summary":summary,
                    "scope":candidate["scope"],"replay_candidate_id":candidate_id,"general_workflow":false});
                let skill_id = crate::id("skill");
                store.conn().execute(
                    "INSERT INTO skills(id,candidate_id,scope,kind,source_ticket_id,source_artifact_id,replay_ticket_id,replay_artifact_id,grant_id,definition_json,proof_json,created_at) VALUES(?1,?2,?3,'skill',?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![skill_id,candidate_id,candidate["scope"].as_str(),replay["source_ticket_id"].as_str(),replay["source_artifact_id"].as_str(),replay["replay_ticket_id"].as_str(),replay["replay_artifact_id"].as_str(),replay["grant_id"].as_str(),definition.to_string(),proof.to_string(),crate::now()],
                )?;
                store.audit(None,"client","candidate.skill.accepted",&json!({"candidate_id":candidate_id,"skill_id":skill_id,
                    "source_artifact_sha256":proof["sha256"],"replay_artifact_sha256":proof["sha256"],
                    "grant_created":false,"standing_permission":false,"memory_created":false}))?;
            } else {
                // Legacy Memory review flow remains unchanged and never consults a Skill proof.
                store.conn().execute("INSERT INTO memories(id,project_id,content,scope,version,created_at,updated_at) VALUES(?1,?2,?3,?4,1,?5,?5)",params![crate::id("memory"),content["project_id"].as_str(),body["content"].as_str().or_else(||content["content"].as_str()).unwrap_or("Reviewed workflow"),candidate["scope"].as_str(),crate::now()])?;
                store.audit(
                    None,
                    "client",
                    "candidate.accepted",
                    &json!({"candidate_id":candidate_id,"grant_created":false}),
                )?;
            }
            store.conn().execute(
                "UPDATE candidates SET status='accepted',updated_at=?1,version=version+1 WHERE id=?2 AND status='pending'",
                params![crate::now(), candidate_id],
            )?;
            store.conn().execute("COMMIT", [])?;
            Ok(store
                .query("SELECT * FROM candidates WHERE id=?1", [candidate_id])?
                .first()
                .cloned()
                .unwrap_or(json!(null)))
        })();
        match result {
            Ok(updated) => Ok(updated),
            Err(error) => {
                let rollback = store.conn().execute("ROLLBACK", []);
                match rollback {
                    Ok(_) => Err(error),
                    Err(failure) => {
                        Err(error
                            .context(format!("candidate acceptance rollback failed: {failure}")))
                    }
                }
            }
        }
    } else {
        if candidate["kind"] == "skill" && candidate["status"] == "accepted" && action != "undo" {
            bail!("An accepted Skill cannot be rewritten as a suggestion decision without explicit undo");
        }
        if action == "undo" {
            if candidate["kind"] == "skill"
                && !matches!(candidate["status"].as_str(), Some("accepted" | "never"))
            {
                bail!("Only an accepted Skill, or an independently suppressed pending Skill, can be undone")
            }
            if candidate["status"] == "accepted"
                && store
                    .conn()
                    .execute("DELETE FROM skills WHERE candidate_id=?1", [candidate_id])?
                    != 1
            {
                bail!("The exact saved Skill proof is required; no other history is withdrawn")
            }
        }
        let status = if action == "later" {
            "later"
        } else if action == "undo" {
            "pending"
        } else if action == "never" {
            "never"
        } else {
            "rejected"
        };
        if candidate["status"] != status {
            store.conn().execute(
                "UPDATE candidates SET status=?1,updated_at=?2,version=version+1 WHERE id=?3",
                params![status, crate::now(), candidate_id],
            )?;
            store.audit(
                None,
                "client",
                "candidate.reviewed",
                &json!({"candidate_id":candidate_id,"decision":action,"permission_changed":false}),
            )?;
        }
        Ok(store
            .query("SELECT * FROM candidates WHERE id=?1", [candidate_id])?
            .first()
            .cloned()
            .unwrap_or(json!(null)))
    }
}

fn edit_memory_candidate(store: &Store, candidate: &Value, body: &Value) -> Result<Value> {
    const TEXT_ERROR: &str = "Memory candidate edit requires nonempty public text of at most 500 bytes, without credentials or resource locators";
    const VERSION_ERROR: &str =
        "MemoryCandidate version conflict; refresh the candidate before editing";

    let payload = body
        .as_object()
        .context("MemoryCandidate edit requires an object payload")?;
    if payload.len() != 3
        || payload
            .keys()
            .any(|key| !matches!(key.as_str(), "decision" | "content" | "expected_version"))
    {
        bail!("MemoryCandidate edit accepts only decision, content and expected_version; scope and source evidence cannot be changed");
    }
    let content = payload["content"].as_str().context(TEXT_ERROR)?;
    if content.trim().is_empty()
        || content.len() > 500
        || ["SECRET", "api_key", "private_key", "http://", "https://"]
            .iter()
            .any(|fragment| content.contains(fragment))
    {
        bail!(TEXT_ERROR);
    }
    let expected_version = payload["expected_version"]
        .as_i64()
        .filter(|_| payload["expected_version"].is_i64())
        .context("MemoryCandidate edit expected_version must be a JSON integer")?;
    let id = candidate["id"]
        .as_str()
        .context("MemoryCandidate identity required")?;
    if !matches!(candidate["status"].as_str(), Some("pending" | "later")) {
        bail!("Only a pending or postponed MemoryCandidate can be edited; accepted, rejected and never history requires its separate review semantics");
    }
    if candidate["version"].as_i64() != Some(expected_version) {
        return Err(
            crate::api::ApiError::conflict("candidate_version_conflict", VERSION_ERROR).into(),
        );
    }

    let mut parsed: Value = serde_json::from_str(
        candidate["content"]
            .as_str()
            .context("MemoryCandidate content proof is invalid")?,
    )
    .context("MemoryCandidate content proof is invalid")?;
    let scope = candidate["scope"]
        .as_str()
        .filter(|scope| !scope.is_empty())
        .context("MemoryCandidate source scope is invalid")?;
    if !parsed.is_object()
        || parsed["schema"] != "loom.memory-candidate.v1"
        || parsed["source"] != "repeated_explicit_choices"
        || parsed["project_id"].as_str() != Some(scope)
        || parsed["fingerprint"]
            .as_str()
            .is_none_or(|fingerprint| fingerprint.is_empty())
    {
        bail!("Only an intact source-bound loom.memory-candidate.v1 can be edited");
    }
    let refs: Value = serde_json::from_str(
        candidate["source_refs"]
            .as_str()
            .context("MemoryCandidate source proof is invalid")?,
    )
    .context("MemoryCandidate source proof is invalid")?;
    let refs = refs
        .as_array()
        .filter(|refs| !refs.is_empty())
        .context("MemoryCandidate editing requires its original nonempty source proof")?;
    for reference in refs {
        let ticket_id = reference
            .as_str()
            .context("MemoryCandidate source proof is invalid")?;
        let ticket = store
            .get("tickets", ticket_id)?
            .context("MemoryCandidate source Ticket not found")?;
        if ticket["project_id"].as_str() != Some(scope) {
            bail!("MemoryCandidate editing cannot transfer evidence to another project");
        }
    }
    if parsed["content"] == content {
        return store
            .get("candidates", id)?
            .context("MemoryCandidate not found after review");
    }
    parsed["content"] = json!(content);
    let serialized = serde_json::to_string(&parsed)?;
    let updated_at = crate::now();
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> Result<Value> {
        // The optimistic fence is rechecked inside the same immediate transaction
        // as the content write and its single provenance-only audit event.
        let current = store
            .get("candidates", id)?
            .context("MemoryCandidate not found during edit")?;
        if current != *candidate {
            return Err(crate::api::ApiError::conflict(
                "candidate_version_conflict",
                VERSION_ERROR,
            )
            .into());
        }
        let changed = store.conn().execute(
            "UPDATE candidates SET content=?1,version=version+1,updated_at=?2 WHERE id=?3 AND version=?4 AND status IN ('pending','later')",
            params![serialized,updated_at,id,expected_version],
        )?;
        if changed != 1 {
            return Err(crate::api::ApiError::conflict(
                "candidate_version_conflict",
                VERSION_ERROR,
            )
            .into());
        }
        store.audit(
            None,
            "client",
            "candidate.memory.edited",
            &json!({
                "candidate_id":id,
                "scope":scope,
                "fingerprint":parsed["fingerprint"],
                "source_refs":refs,
                "previous_version":expected_version,
                "version":expected_version+1,
                "content_changed":true,
                "accepted_memory_created":false,
                "authority_created":false
            }),
        )?;
        store.conn().execute("COMMIT", [])?;
        store
            .get("candidates", id)?
            .context("Edited MemoryCandidate not found after commit")
    })();
    match result {
        Ok(candidate) => Ok(candidate),
        Err(error) => {
            let rollback = store.conn().execute("ROLLBACK", []);
            match rollback {
                Ok(_) => Err(error),
                Err(rollback) => {
                    Err(error.context(format!("MemoryCandidate edit rollback failed: {rollback}")))
                }
            }
        }
    }
}

fn review_memory_candidate(store: &Store, candidate: &Value, body: &Value) -> Result<Value> {
    let id = candidate["id"]
        .as_str()
        .context("Memory candidate ID required")?;
    let decision = body["decision"].as_str().unwrap_or_default();
    if !matches!(decision, "accept" | "reject" | "later" | "never" | "undo") {
        bail!("Unknown Memory candidate review decision");
    }
    if decision == "accept" {
        if !matches!(candidate["status"].as_str(), Some("pending" | "later")) {
            bail!("Only a pending or postponed MemoryCandidate can be accepted; there is no second Memory");
        }
        let scope = candidate["scope"]
            .as_str()
            .context("Candidate requires exact project scope")?;
        if let Some(edited_scope) = body["scope"].as_str() {
            if edited_scope != scope {
                bail!("This preview cannot move evidence to another project or User/Host");
            }
        }
        if body["project_id"].is_string() && body["project_id"] != candidate["scope"] {
            bail!("Memory scope cannot be changed away from the evidence project");
        }
        if store.get("projects", scope)?.is_none() {
            bail!("Candidate's source project no longer exists");
        }
        let refs: Value = serde_json::from_str(
            candidate["source_refs"]
                .as_str()
                .context("Candidate sources invalid")?,
        )?;
        let refs = refs
            .as_array()
            .context("MemoryCandidate source list invalid")?;
        if refs.len() > 32 {
            bail!("MemoryCandidate cannot cite more than 32 actual Tickets");
        }
        for reference in refs {
            let ticket_id = reference
                .as_str()
                .context("Source Tickets must have immutable identifiers")?;
            let ticket = store
                .get("tickets", ticket_id)?
                .context("Memory candidate source Ticket is not known")?;
            if ticket["project_id"] != scope {
                bail!("Memory candidate cannot use a different project's history");
            }
        }
        let parsed: Value = serde_json::from_str(candidate["content"].as_str().unwrap_or("{}"))?;
        if parsed
            .get("schema")
            .is_some_and(|schema| schema != "loom.memory-candidate.v1")
        {
            bail!("Unsupported or non-text MemoryCandidate schema cannot be treated as legacy");
        }
        if refs.is_empty() && parsed["schema"] == "loom.memory-candidate.v1" {
            bail!("A source-bound MemoryCandidate cannot invoke the empty-ref legacy exception");
        }
        let value = body["content"]
            .as_str()
            .or_else(|| parsed["content"].as_str())
            .unwrap_or_default()
            .to_owned();
        if value.trim().is_empty()
            || value.len() > 500
            || value.contains("SECRET")
            || value.contains("api_key")
            || value.contains("private_key")
            || value.contains("http://")
            || value.contains("https://")
        {
            bail!("Memory candidate accepts only a bounded public project preference, not credentials or a resource locator");
        }
        let refs_json = serde_json::to_string(&refs)?;
        let memory_id = crate::id("memory");
        let source_ticket_id = refs.first().and_then(Value::as_str).map(str::to_owned);
        let created_at = crate::now();
        store.conn().execute("BEGIN IMMEDIATE", [])?;
        let result = (|| -> Result<Value> {
            store.conn().execute("INSERT INTO memories(id,project_id,content,scope,version,created_at,updated_at,source_ticket_id) VALUES(?1,?2,?3,'project',1,?4,?4,?5)",
                params![memory_id.clone(),scope,value,created_at,source_ticket_id])?;
            if refs.is_empty() {
                store.audit(
                    None,
                    "client",
                    "candidate.memory.legacy_accepted_without_ticket_provenance",
                    &json!({"candidate_id":id,"scope":scope,"new_ticket_or_grant_created":false}),
                )?;
            }
            store.conn().execute("INSERT INTO candidate_memory_links(candidate_id,memory_id,source_refs,created_at) VALUES(?1,?2,?3,?4)",
                params![id,memory_id,refs_json,created_at])?;
            let changed = store.conn().execute("UPDATE candidates SET status='accepted',version=version+1,updated_at=?1 WHERE id=?2 AND status IN ('pending','later')",
                params![created_at,id])?;
            if changed != 1 {
                bail!("Another review completed this candidate already")
            }
            store.audit(None,"client","candidate.memory.accepted",
                &json!({"candidate_id":id,"memory_id":memory_id,"source_refs":refs,"scope":scope,"authority_created":false}))?;
            store.conn().execute("COMMIT", [])?;
            let mut candidate = store
                .get("candidates", id)?
                .context("Accepted candidate lost its binding")?;
            candidate["derived_memory_id"] = json!(memory_id);
            candidate["source_ticket_id"] = json!(source_ticket_id);
            if source_ticket_id.is_none() {
                candidate["source_evidence"] = json!("legacy_manual_without_ticket_provenance");
            }
            Ok(candidate)
        })();
        return match result {
            Ok(candidate) => Ok(candidate),
            Err(error) => {
                let rollback = store.conn().execute("ROLLBACK", []);
                match rollback {
                    Ok(_) => Err(error),
                    Err(rollback) => Err(error.context(format!(
                        "Memory candidate acceptance rollback failed: {rollback}"
                    ))),
                }
            }
        };
    }
    if decision == "undo" {
        if candidate["status"] == "never" {
            store.audit(
                None,
                "client",
                "candidate.never.withdrawn",
                &json!({"candidate_id":id,"execution_authority_changed":false}),
            )?;
            store.conn().execute("UPDATE candidates SET status='pending',version=version+1,updated_at=?1 WHERE id=?2", params![crate::now(),id])?;
        } else {
            if candidate["status"] != "accepted" {
                bail!("Only an accepted project Memory can be withdrawn");
            }
            let links = store.query(
                "SELECT * FROM candidate_memory_links WHERE candidate_id=?1",
                [id],
            )?;
            if links.len() != 1 {
                bail!("Legacy memory history has no exact candidate link; unknown records are not deleted");
            }
            withdraw_linked_candidate(store, candidate)?;
        }
    } else {
        if candidate["status"] == "accepted" && decision != "undo" {
            bail!("An accepted Memory is not overwritten by another suggestion state; use explicit undo");
        }
        if candidate["status"] == "never" && decision != "never" {
            bail!("A never-suggest MemoryCandidate can only restore review explicitly; never cannot become another decision");
        }
        if candidate["status"] == "rejected" && decision != "reject" {
            bail!("A rejected source suggestion is history and cannot become pending, later, accepted or undo");
        }
        let status = match decision {
            "NEVER" | "never" => "never",
            "later" => "later",
            _ => "rejected",
        };
        if candidate["status"] != status {
            store.conn().execute(
                "UPDATE candidates SET status=?1,version=version+1,updated_at=?2 WHERE id=?3",
                params![status, crate::now(), id],
            )?;
            store.audit(
                None,
                "client",
                "candidate.reviewed",
                &json!({"candidate_id":id,"decision":decision,"permission_changed":false}),
            )?;
        }
    }
    Ok(store.get("candidates", id)?.unwrap_or(json!(null)))
}

/// One authoritative withdrawal for both candidate undo and the ordinary
/// Memory deletion control. It removes only a linked preference, never Ticket,
/// Artifact, an original observation or an execution permission.
pub fn delete_linked_memory(store: &Store, memory_id: &str) -> Result<Option<Value>> {
    let links = store.query(
        "SELECT candidate_id FROM candidate_memory_links WHERE memory_id=?1",
        [memory_id],
    )?;
    if links.is_empty() {
        return Ok(None);
    }
    if links.len() != 1 {
        bail!("A derived Memory must have one exact candidate link");
    }
    let rows = store.query(
        "SELECT * FROM candidates WHERE id=?1",
        [links[0]["candidate_id"]
            .as_str()
            .context("Linked candidate identity required")?],
    )?;
    let candidate = rows.first().context("Linked MemoryCandidate is missing")?;
    if candidate["kind"] != "memory" || candidate["status"] != "accepted" {
        bail!("Linked candidate is not an accepted Memory; preserve the uncertain historical link")
    }
    withdraw_linked_candidate(store, candidate)?;
    Ok(Some(
        json!({"deleted":true,"candidate_withdrawal":true,"candidate_id":candidate["id"],
        "candidate_status":"pending","grants_changed":false,"ticket_or_artifact_rollback":false}),
    ))
}

fn withdraw_linked_candidate(store: &Store, candidate: &Value) -> Result<()> {
    let id = candidate["id"]
        .as_str()
        .context("MemoryCandidate identity required")?;
    let links = store.query(
        "SELECT * FROM candidate_memory_links WHERE candidate_id=?1",
        [id],
    )?;
    if links.len() != 1 {
        bail!("Legacy memory has no exact link; its history cannot be silently withdrawn");
    }
    let memory_id = links[0]["memory_id"]
        .as_str()
        .context("Exact derived Memory ID required")?;
    if candidate["scope"]
        .as_str()
        .is_none_or(|scope| scope.is_empty())
    {
        bail!("Linked candidate must retain its identified project scope");
    }
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> Result<()> {
        if store.conn().execute(
            "DELETE FROM candidate_memory_links WHERE candidate_id=:candidate_id",
            rusqlite::named_params! {":candidate_id":id},
        )? != 1
        {
            bail!("Candidate link changed before withdrawal");
        }
        if store.conn().execute(
            "DELETE FROM memories WHERE id=:memory_id",
            rusqlite::named_params! {":memory_id":memory_id},
        )? != 1
        {
            bail!("Exact derived Memory no longer has its original project scope; preserve the history");
        }
        if store.conn().execute("UPDATE candidates SET status='pending',version=version+1,updated_at=:time WHERE id=:id AND status='accepted'",
            rusqlite::named_params!{":time":crate::now(),":id":id})? != 1 {
            bail!("Candidate changed before withdrawal; no partial delete is committed");
        }
        store.audit(None,"client","candidate.memory.withdrawn",
            &json!({"candidate_id":id,"memory_id":memory_id,"previous_effect_undone":false,"grants_changed":false}))?;
        store.conn().execute("COMMIT", [])?;
        Ok(())
    })();
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            store.conn().execute("ROLLBACK", [])?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod observation_tests {
    use super::*;

    #[test]
    fn same_source_is_idempotent_and_fresh_source_ranges_commit() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let time = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('p','p','/private-fixture-only','read_only',1,?1,'{}')", [&time]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','p','node','default','installation','[\"read\"]',1,'digest',?1)", [&time]).unwrap();
        for id in ["source-a", "source-b"] {
            store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES(?1,'p','test source','read_summary','input.txt','running','grant','digest','node','installation','default',1,?2,?2)",
                params![id, time]).unwrap();
        }
        let first = json!({"project_id":"p","kind":"memory","value":"Bounded synthetic preference","source_refs":["source-a"]});
        assert_eq!(
            observation_candidate(&store, &first).unwrap()["observations"],
            1
        );
        assert_eq!(
            observation_candidate(&store, &first).unwrap()["observations"],
            1
        );
        let second = json!({"project_id":"p","kind":"memory","value":"Bounded synthetic preference","source_refs":["source-b"]});
        let result = observation_candidate(&store, &second).unwrap();
        assert_eq!(result["observations"], 2);
        assert_eq!(
            store
                .query("SELECT count(*) AS count FROM candidate_memory_links", [])
                .unwrap()[0]["count"],
            0
        );
        let rows = store
            .query("SELECT occurrences,source_refs FROM observations", [])
            .unwrap();
        assert_eq!(rows[0]["occurrences"], 2);
        assert_eq!(
            serde_json::from_str::<Value>(rows[0]["source_refs"].as_str().unwrap()).unwrap(),
            json!(["source-a", "source-b"])
        );
    }

    #[test]
    fn review_status_and_strict_schema_cannot_rewrite_provenance_or_other_memories() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let time = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('p','Strict fixture','/owned-test-project','read_only',1,?1,'{}')",[&time]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','p','node','default','installation','[\"read\"]',1,'digest',?1)",[&time]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('source-a','p','Actual stored ticket','read_summary','input.txt','running','grant','digest','node','installation','default',1,?1,?1)",[&time]).unwrap();
        store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES('reviewed','memory','p',?1,'[\"source-a\"]','pending',1,?2,?2)",
            params![json!({"schema":"loom.memory-candidate.v1","content":"Bounded reviewed preference"}).to_string(),time]).unwrap();
        assert_eq!(
            review_candidate(&store, "reviewed", &json!({"decision":"accept"})).unwrap()["status"],
            "accepted"
        );
        for decision in ["accept", "never", "reject"] {
            assert!(review_candidate(&store, "reviewed", &json!({"decision":decision})).is_err());
            assert_eq!(store.list("memories").unwrap().len(), 1);
        }
        assert_eq!(
            review_candidate(&store, "reviewed", &json!({"decision":"undo"})).unwrap()["status"],
            "pending"
        );
        assert_eq!(
            review_candidate(&store, "reviewed", &json!({"decision":"never"})).unwrap()["status"],
            "never"
        );
        let suppressed = store.get("candidates", "reviewed").unwrap().unwrap();
        let suppressed_audit = store.audits(None).unwrap();
        assert!(review_candidate(&store, "reviewed", &json!({"decision":"never"})).is_ok());
        assert_eq!(
            store.audits(None).unwrap(),
            suppressed_audit,
            "An idempotent never has no additional audit write"
        );
        assert_eq!(
            store.get("candidates", "reviewed").unwrap().unwrap(),
            suppressed,
            "Repeated never changes neither status nor version"
        );
        for decision in ["later", "reject", "accept"] {
            assert!(
                review_candidate(&store, "reviewed", &json!({"decision":decision})).is_err(),
                "never -> {decision} must not become a new permission or preference"
            );
        }
        assert_eq!(
            store.get("candidates", "reviewed").unwrap().unwrap()["status"],
            "never"
        );
        assert_eq!(
            review_candidate(&store, "reviewed", &json!({"decision":"undo"})).unwrap()["status"],
            "pending"
        );
        assert_eq!(
            review_candidate(&store, "reviewed", &json!({"decision":"reject"})).unwrap()["status"],
            "rejected"
        );
        let rejected = store.get("candidates", "reviewed").unwrap().unwrap();
        for decision in ["accept", "later", "never", "undo"] {
            assert!(
                review_candidate(&store, "reviewed", &json!({"decision":decision})).is_err(),
                "rejected -> {decision} cannot revive suppressed history"
            );
            assert_eq!(
                store.get("candidates", "reviewed").unwrap().unwrap(),
                rejected
            );
        }
        assert_eq!(
            review_candidate(&store, "reviewed", &json!({"decision":"reject"})).unwrap(),
            rejected
        );
        assert_eq!(store.list("memories").unwrap().len(), 0);
        assert_eq!(store.list("grants").unwrap().len(), 1);

        for (idx, schema, refs) in [
            (0, Value::Null, "[]"),
            (1, json!(1), "[]"),
            (2, json!("some-unknown-schema"), "[]"),
            (3, json!("loom.memory-candidate.v1"), "[]"),
            (4, json!("loom.memory-candidate.v1"), "{malformed"),
        ] {
            let id = format!("invalid-v1-{idx}");
            let content = json!({"schema":schema,"content":"Unproven preference","project_id":"p"});
            store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES(?1,'memory','p',?2,?3,'pending',1,?4,?4)",
                params![id,content.to_string(),refs,time]).unwrap();
            assert!(review_candidate(&store, &id, &json!({"decision":"accept"})).is_err());
        }
        assert_eq!(store.list("memories").unwrap().len(), 0);
        assert_eq!(
            store
                .query("SELECT * FROM candidate_memory_links", [])
                .unwrap()
                .len(),
            0
        );

        store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES('legacy-unlinked','memory','p','{\"content\":\"Historical legacy\"}','[]','accepted',1,?1,?1)",[&time]).unwrap();
        store.conn().execute("INSERT INTO memories(id,project_id,content,scope,version,created_at,updated_at) VALUES('unrelated-memory','p','Explicitly unrelated memory','project',1,?1,?1)",[&time]).unwrap();
        assert!(review_candidate(&store, "legacy-unlinked", &json!({"decision":"undo"})).is_err());
        assert_eq!(store.list("memories").unwrap().len(), 1);
        assert_eq!(store.list("memories").unwrap()[0]["id"], "unrelated-memory");
        assert_eq!(
            store.get("candidates", "legacy-unlinked").unwrap().unwrap()["status"],
            "accepted"
        );
        assert!(
            !store.audits(None).unwrap().is_empty(),
            "Only real accepted/retracted and reviewed commands are audited"
        );
        assert!(store.verify_audit().unwrap());
    }
}

#[cfg(test)]
mod memory_candidate_edit_tests {
    use super::*;

    struct Fixture {
        _directory: tempfile::TempDir,
        store: Store,
        candidate: Value,
    }

    fn source_fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let time = crate::now();
        store.conn().execute_batch("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project-a','Source-bound edit','/synthetic/project-a','read_only',1,'2026-01-01T00:00:00Z','{}'),('project-b','Other project','/synthetic/project-b','read_only',1,'2026-01-01T00:00:00Z','{}'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant-a','project-a','node-a','worker-a','installation-a','[\"read\"]',1,'grant-digest','2026-01-01T00:00:00Z');").unwrap();
        for source in ["source-a", "source-b", "source-c"] {
            store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES(?1,'project-a','Fixture source evidence','read_summary','input.txt','succeeded','grant-a','grant-digest','node-a','installation-a','worker-a',1,?2,?2)",params![source,time]).unwrap();
        }
        for source in ["source-a", "source-b", "source-c"] {
            let result = observation_candidate(
                &store,
                &json!({"project_id":"project-a","kind":"memory","value":"  Original bounded preference\n","source_refs":[source]}),
            )
            .unwrap();
            if source != "source-c" {
                assert_eq!(result["candidate"], Value::Null);
            } else {
                let candidate = result["candidate"].clone();
                assert_eq!(candidate["version"], 1);
                return Fixture {
                    _directory: directory,
                    store,
                    candidate,
                };
            }
        }
        unreachable!("three real observation sources create a bounded candidate")
    }

    fn id(fixture: &Fixture) -> &str {
        fixture.candidate["id"].as_str().unwrap()
    }

    fn edit_body(fixture: &Fixture, content: Value) -> Value {
        json!({"decision":"edit","content":content,"expected_version":fixture.candidate["version"]})
    }

    fn edit_audits(store: &Store) -> Vec<Value> {
        store
            .audits(None)
            .unwrap()
            .into_iter()
            .filter(|entry| entry["action"] == "candidate.memory.edited")
            .collect()
    }

    fn assert_unchanged(fixture: &Fixture, before: &Value, result: Result<Value>) {
        assert!(result.is_err());
        assert_eq!(
            fixture.store.get("candidates", id(fixture)).unwrap(),
            Some(before.clone())
        );
        assert!(edit_audits(&fixture.store).is_empty());
        assert!(fixture.store.list("memories").unwrap().is_empty());
        assert_eq!(fixture.store.list("grants").unwrap().len(), 1);
        assert!(fixture
            .store
            .query("SELECT * FROM candidate_memory_links", [])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn source_bound_pending_edit_preserves_identity_and_writes_one_audit() {
        let fixture = source_fixture();
        let original = fixture.candidate.clone();
        let original_parsed: Value =
            serde_json::from_str(original["content"].as_str().unwrap()).unwrap();
        let before_audits = fixture.store.audits(None).unwrap();
        let updated = review_candidate(
            &fixture.store,
            id(&fixture),
            &edit_body(&fixture, json!("  Human reviewed preference\n")),
        )
        .unwrap();
        assert_eq!(updated["id"], original["id"]);
        assert_eq!(updated["version"], 2);
        assert_eq!(updated["status"], "pending");
        assert_eq!(updated["scope"], original["scope"]);
        assert_eq!(updated["source_refs"], original["source_refs"]);
        assert_eq!(updated["kind"], original["kind"]);
        assert!(
            updated["updated_at"].as_str().unwrap() >= original["updated_at"].as_str().unwrap()
        );
        let parsed: Value = serde_json::from_str(updated["content"].as_str().unwrap()).unwrap();
        assert_eq!(parsed["content"], "  Human reviewed preference\n");
        for key in [
            "schema",
            "source",
            "project_id",
            "fingerprint",
            "kind",
            "replay_state",
        ] {
            assert_eq!(parsed[key], original_parsed[key], "immutable {key}");
        }
        assert_eq!(fixture.store.list("memories").unwrap().len(), 0);
        assert_eq!(fixture.store.list("grants").unwrap().len(), 1);
        assert!(fixture
            .store
            .query("SELECT * FROM candidate_memory_links", [])
            .unwrap()
            .is_empty());
        let audits = fixture.store.audits(None).unwrap();
        assert_eq!(audits.len(), before_audits.len() + 1);
        let edits = edit_audits(&fixture.store);
        assert_eq!(edits.len(), 1);
        let stored_audit: Value =
            serde_json::from_str(edits[0]["evidence"].as_str().unwrap()).unwrap();
        let evidence = &stored_audit["evidence"];
        for (key, expected) in [
            ("candidate_id", original["id"].clone()),
            ("scope", original["scope"].clone()),
            ("fingerprint", original_parsed["fingerprint"].clone()),
            ("source_refs", json!(["source-a", "source-b", "source-c"])),
            ("previous_version", json!(1)),
            ("version", json!(2)),
            ("content_changed", json!(true)),
            ("accepted_memory_created", json!(false)),
            ("authority_created", json!(false)),
        ] {
            assert_eq!(evidence[key], expected, "audit {key}");
        }
        let details = evidence.to_string();
        assert!(!details.contains("Human reviewed preference"));
        assert!(!details.contains("Original bounded preference"));
        assert!(fixture.store.verify_audit().unwrap());
    }

    #[test]
    fn postponed_edit_and_identical_content_idempotence_keep_separate_semantics() {
        let mut fixture = source_fixture();
        fixture.candidate =
            review_candidate(&fixture.store, id(&fixture), &json!({"decision":"later"})).unwrap();
        assert_eq!(fixture.candidate["status"], "later");
        assert_eq!(fixture.candidate["version"], 2);
        let updated = review_candidate(
            &fixture.store,
            id(&fixture),
            &edit_body(&fixture, json!("Postponed human edit")),
        )
        .unwrap();
        assert_eq!(updated["status"], "later");
        assert_eq!(updated["version"], 3);
        let before_audits = fixture.store.audits(None).unwrap();
        let noop = review_candidate(&fixture.store, id(&fixture), &json!({"decision":"edit","content":"  Original bounded preference\n","expected_version":2})).unwrap_err();
        assert!(noop
            .downcast_ref::<crate::api::ApiError>()
            .is_some_and(|error| error.status == axum::http::StatusCode::CONFLICT));
        assert_eq!(
            fixture
                .store
                .get("candidates", id(&fixture))
                .unwrap()
                .unwrap(),
            updated
        );
        assert_eq!(fixture.store.audits(None).unwrap(), before_audits);
        let noop = review_candidate(
            &fixture.store,
            id(&fixture),
            &json!({"decision":"edit","content":"Postponed human edit","expected_version":3}),
        )
        .unwrap();
        assert_eq!(noop, updated);
        assert_eq!(fixture.store.audits(None).unwrap(), before_audits);
    }

    #[test]
    fn stale_version_and_terminal_status_never_write_or_revive() {
        let fixture = source_fixture();
        let before = fixture
            .store
            .get("candidates", id(&fixture))
            .unwrap()
            .unwrap();
        let stale = review_candidate(
            &fixture.store,
            id(&fixture),
            &json!({"decision":"edit","content":"stale edit","expected_version":0}),
        );
        assert_unchanged(&fixture, &before, stale);
        for status in ["accepted", "rejected", "never"] {
            let mut fixture = source_fixture();
            fixture.candidate = review_candidate(
                &fixture.store,
                id(&fixture),
                &json!({"decision":match status { "accepted" => "accept", "rejected" => "reject", _ => "never" }}),
            )
            .unwrap();
            let before = fixture
                .store
                .get("candidates", id(&fixture))
                .unwrap()
                .unwrap();
            let before_audits = fixture.store.audits(None).unwrap();
            let error = review_candidate(
                &fixture.store,
                id(&fixture),
                &edit_body(&fixture, json!("Cannot revive by edit")),
            )
            .unwrap_err();
            assert_eq!(error.to_string(), "Only a pending or postponed MemoryCandidate can be edited; accepted, rejected and never history requires its separate review semantics");
            assert_eq!(
                fixture
                    .store
                    .get("candidates", id(&fixture))
                    .unwrap()
                    .unwrap(),
                before
            );
            assert_eq!(fixture.store.audits(None).unwrap(), before_audits);
            let memories = fixture.store.list("memories").unwrap();
            assert_eq!(memories.len(), usize::from(status == "accepted"));
            assert_eq!(fixture.store.list("grants").unwrap().len(), 1);
        }
    }

    #[test]
    fn edit_rejects_missing_bad_or_sensitive_text_and_unauthorized_payloads() {
        let fixture = source_fixture();
        let before = fixture
            .store
            .get("candidates", id(&fixture))
            .unwrap()
            .unwrap();
        for body in [
            json!({"decision":"edit","expected_version":1}),
            json!({"decision":"edit","content":null,"expected_version":1}),
            json!({"decision":"edit","content":1,"expected_version":1}),
            json!({"decision":"edit","content":" \n\t ","expected_version":1}),
            json!({"decision":"edit","content":"x".repeat(501),"expected_version":1}),
            json!({"decision":"edit","content":"SECRET","expected_version":1}),
            json!({"decision":"edit","content":"api_key","expected_version":1}),
            json!({"decision":"edit","content":"private_key","expected_version":1}),
            json!({"decision":"edit","content":"http://example.invalid","expected_version":1}),
            json!({"decision":"edit","content":"https://example.invalid","expected_version":1}),
            json!({"decision":"edit","content":"valid","expected_version":1.0}),
            json!({"decision":"edit","content":"valid","expected_version":"1"}),
            json!({"decision":"edit","content":"valid","expected_version":null}),
            json!({"decision":"edit","content":"valid","expected_version":1,"scope":"project-b"}),
            json!({"decision":"edit","content":"valid","expected_version":1,"project_id":"project-a"}),
            json!({"decision":"edit","content":"valid","expected_version":1,"source_refs":["source-a"]}),
            json!({"decision":"edit","content":"valid","expected_version":1,"status":"accepted"}),
            json!({"decision":"edit","content":"valid","expected_version":1,"grant_created":true}),
        ] {
            let result = review_candidate(&fixture.store, id(&fixture), &body);
            assert_unchanged(&fixture, &before, result);
        }
    }

    #[test]
    fn edit_refuses_non_memory_and_invalid_or_unbound_memory_provenance() {
        let fixture = source_fixture();
        let time = crate::now();
        for (index, kind) in ["route", "skill"].iter().enumerate() {
            let candidate_id = format!("non-memory-{index}");
            fixture.store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES(?1,?2,'project-a','{\"content\":\"unchanged\"}','[]','pending',1,?3,?3)",params![candidate_id,kind,time]).unwrap();
            let result = review_candidate(
                &fixture.store,
                &candidate_id,
                &json!({"decision":"edit","content":"Human text","expected_version":1}),
            );
            assert!(result.is_err());
            assert_eq!(
                fixture
                    .store
                    .get("candidates", &candidate_id)
                    .unwrap()
                    .unwrap()["version"],
                1
            );
        }
        let valid: Value =
            serde_json::from_str(fixture.candidate["content"].as_str().unwrap()).unwrap();
        for (index, content, refs) in [
            (0, "{malformed".to_owned(), "[\"source-a\"]".to_owned()),
            (1, json!(["not an object"]).to_string(), "[\"source-a\"]".to_owned()),
            (2, json!({"content":"no schema","fingerprint":valid["fingerprint"],"source":"repeated_explicit_choices","project_id":"project-a"}).to_string(), "[\"source-a\"]".to_owned()),
            (3, valid.to_string(), "[]".to_owned()),
            (4, valid.to_string(), "{malformed".to_owned()),
            (5, json!({"schema":"loom.memory-candidate.v1","content":"bad project","fingerprint":valid["fingerprint"],"source":"repeated_explicit_choices","project_id":"project-b"}).to_string(), "[\"source-a\"]".to_owned()),
        ] {
            let candidate_id = format!("invalid-proof-{index}");
            fixture.store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES(?1,'memory','project-a',?2,?3,'pending',1,?4,?4)",params![candidate_id,content,refs,time]).unwrap();
            let before = fixture.store.get("candidates", &candidate_id).unwrap().unwrap();
            let result = review_candidate(&fixture.store, &candidate_id, &json!({"decision":"edit","content":"Human text","expected_version":1}));
            assert!(result.is_err());
            assert_eq!(fixture.store.get("candidates", &candidate_id).unwrap().unwrap(), before);
        }
    }

    #[test]
    fn injected_edit_audit_failure_rolls_back_content_version_and_timestamp() {
        let fixture = source_fixture();
        let before = fixture
            .store
            .get("candidates", id(&fixture))
            .unwrap()
            .unwrap();
        let before_audits = fixture.store.audits(None).unwrap();
        fixture.store.conn().execute("CREATE TRIGGER fail_memory_candidate_edit_audit BEFORE INSERT ON audits WHEN NEW.action='candidate.memory.edited' BEGIN SELECT RAISE(ABORT,'owned candidate edit audit failure'); END", []).unwrap();
        let result = review_candidate(
            &fixture.store,
            id(&fixture),
            &edit_body(&fixture, json!("Rolled back human edit")),
        );
        assert_unchanged(&fixture, &before, result);
        assert_eq!(fixture.store.audits(None).unwrap(), before_audits);
        fixture
            .store
            .conn()
            .execute("DROP TRIGGER fail_memory_candidate_edit_audit", [])
            .unwrap();
        assert!(fixture.store.verify_audit().unwrap());
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    struct Fixture {
        _directory: tempfile::TempDir,
        store: Store,
    }

    fn insert_ticket(store: &Store, id: &str, status: &str, attempt: i64, cancel: bool) {
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES(?1,'project-a','Original bounded objective','edit_file','src/original.txt','Original immutable input',?2,'grant-a','immutable-grant-digest','node-a','installation-a','worker-a',?3,?4,'2026-01-01T00:00:00Z','2026-01-01T00:01:00Z')",params![id,status,attempt,cancel]).unwrap();
    }

    fn fixture(status: &str, attempt: i64, cancel: bool) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        store.conn().execute_batch("BEGIN; INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project-a','Original project','/owned/project-a','read_write',4,'2026-01-01T00:00:00Z','{\"revision\":\"original-revision\"}'); INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding-a','project-a','node-a','installation-a','worker-a','/owned/project-a','binding-digest-a','2026-01-01T00:00:00Z'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant-a','project-a','node-a','worker-a','installation-a','[\"edit_file\"]',1,'immutable-grant-digest','2026-01-01T00:00:00Z','binding-a'); COMMIT; PRAGMA foreign_keys=ON;").unwrap();
        insert_ticket(&store, "ticket-a", status, attempt, cancel);
        insert_ticket(&store, "unrelated-ticket", "failed", 3, false);
        for (assignment, ticket) in [
            ("original-assignment", "ticket-a"),
            ("unrelated-assignment", "unrelated-ticket"),
        ] {
            store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,acknowledged_at,created_at,cancelled_at,last_report_at) VALUES(?1,?2,'node-a','worker-a',1,?3,1,'2026-01-01T01:00:00Z','2026-01-01T00:30:00Z','2026-01-01T00:10:00Z',NULL,'2026-01-01T00:50:00Z')",params![assignment,ticket,format!("lease-{assignment}")]).unwrap();
        }
        if attempt > 0 {
            store.conn().execute("UPDATE assignments SET attempt=?1,lease_epoch=?1 WHERE id='original-assignment'", [attempt]).unwrap();
        }
        store.conn().execute("INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) VALUES('original-report','original-assignment','ticket-a','node-a',?1,'original-request','failed','Original failure report','[{\"proof\":\"original\"}]','session-original',0,'2026-01-01T00:50:00Z')",[attempt.max(1)]).unwrap();
        store.conn().execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES('original-artifact','ticket-a','original-assignment','node-a','original.txt','text/plain',17,'original-artifact-sha','original.storage','loom://artifact/original-artifact','[]','2026-01-01T00:51:00Z')",[]).unwrap();
        store.conn().execute("INSERT INTO effects(id,ticket_id,assignment_id,node_id,attempt,input_digest,status,evidence,artifacts,created_at,updated_at) VALUES('original-effect','ticket-a','original-assignment','node-a',?1,'original-input-digest','confirmed','[{\"proof\":\"original-effect\"}]','[\"original-artifact\"]','2026-01-01T00:52:00Z','2026-01-01T00:52:00Z')",[attempt.max(1)]).unwrap();
        if matches!(status, "pending" | "waiting_approval") {
            for table in ["reports", "artifacts", "effects"] {
                store
                    .conn()
                    .execute(
                        &format!("DELETE FROM {table} WHERE ticket_id='ticket-a'"),
                        [],
                    )
                    .unwrap();
            }
        }
        store
            .audit(
                Some("ticket-a"),
                "node",
                "original.history",
                &json!({"immutable":true}),
            )
            .unwrap();
        Fixture {
            _directory: directory,
            store,
        }
    }

    fn assert_retry_refused(fixture: &Fixture, id: &str, expected: Option<&str>) {
        let store = &fixture.store;
        let ticket = store.get("tickets", id).unwrap().unwrap();
        let history = store.detail(id).unwrap();
        let audits = store.audits(None).unwrap();
        let grants = store.list("grants").unwrap();
        let projects = store.list("projects").unwrap();
        let bindings = store.query("SELECT * FROM project_bindings", []).unwrap();
        let unrelated = store.detail("unrelated-ticket").unwrap();
        let error = retry(store, id).unwrap_err();
        if let Some(expected) = expected {
            assert_eq!(error.to_string(), expected);
        }
        assert_eq!(store.get("tickets", id).unwrap().unwrap(), ticket);
        assert_eq!(store.detail(id).unwrap(), history);
        assert_eq!(store.audits(None).unwrap(), audits);
        assert_eq!(store.list("grants").unwrap(), grants);
        assert_eq!(store.list("projects").unwrap(), projects);
        assert_eq!(
            store.query("SELECT * FROM project_bindings", []).unwrap(),
            bindings
        );
        assert_eq!(store.detail("unrelated-ticket").unwrap(), unrelated);
        assert!(
            !store.audits(Some(id)).unwrap().iter().any(|entry| matches!(
                entry["action"].as_str(),
                Some("ticket.retried" | "assignment.retried")
            ))
        );
    }

    #[test]
    fn public_retry_rejects_non_failed_and_stopped_states_without_any_mutation() {
        for (status, cancel) in [
            ("pending", false),
            ("running", false),
            ("waiting_approval", false),
            ("cancel_requested", false),
            ("cancelled", false),
            ("succeeded", false),
            ("reconciling", false),
            ("unknown", false),
            ("stopped", false),
            ("future_arbitrary_status", false),
            ("failed", true),
            ("running", true),
        ] {
            let fixture = fixture(status, 1, cancel);
            let expected = match (status, cancel) {
                ("reconciling", _) => {
                    Some("Unresolved outcomes require effect reconciliation, not blind retry.")
                }
                (_, true) => {
                    Some("Durable stop intent cannot be overwritten by an automatic retry")
                }
                _ => None,
            };
            assert_retry_refused(&fixture, "ticket-a", expected);
        }
    }

    #[test]
    fn failed_retry_issues_a_distinct_second_attempt_and_preserves_original_history() {
        let fixture = fixture("failed", 1, false);
        let store = fixture.store;
        let before = store.detail("ticket-a").unwrap();
        let audits = store.audits(None).unwrap();
        let grants = store.list("grants").unwrap();
        let projects = store.list("projects").unwrap();
        let bindings = store.query("SELECT * FROM project_bindings", []).unwrap();
        let unrelated = store.detail("unrelated-ticket").unwrap();

        retry(&store, "ticket-a").unwrap();
        assert_eq!(store.audits(None).unwrap().len(), audits.len() + 2);

        let after = store.detail("ticket-a").unwrap();
        assert_eq!(after["status"], "running");
        assert_eq!(after["attempt"], 2);
        assert_eq!(after["cancel_requested"], false);
        for field in [
            "id",
            "project_id",
            "objective",
            "kind",
            "relative_path",
            "content",
            "grant_id",
            "grant_digest",
            "node_id",
            "installation_id",
            "worker_id",
            "created_at",
        ] {
            assert_eq!(
                after[field], before[field],
                "immutable Ticket field {field}"
            );
        }
        let assignments = after["assignments"].as_array().unwrap();
        assert_eq!(assignments.len(), 2);
        assert_eq!(assignments[0]["id"], "original-assignment");
        assert_eq!(assignments[0]["lease_id"], "lease-original-assignment");
        assert_eq!(before["assignments"][0], assignments[0]);
        let current = assignments
            .iter()
            .find(|assignment| assignment["id"] != "original-assignment")
            .unwrap();
        assert_eq!(current["attempt"], 2);
        assert_eq!(current["lease_epoch"], 2);
        assert_eq!(current["node_id"], "node-a");
        assert_eq!(current["worker_id"], "worker-a");
        assert_ne!(current["lease_id"], "lease-original-assignment");
        assert_eq!(after["reports"], before["reports"]);
        assert_eq!(after["artifacts"], before["artifacts"]);
        assert_eq!(after["effects"], before["effects"]);
        assert_eq!(store.list("grants").unwrap(), grants);
        assert_eq!(store.list("projects").unwrap(), projects);
        assert_eq!(
            store.query("SELECT * FROM project_bindings", []).unwrap(),
            bindings
        );
        assert_eq!(store.detail("unrelated-ticket").unwrap(), unrelated);
        let audits = store.audits(Some("ticket-a")).unwrap();
        assert_eq!(
            audits
                .iter()
                .filter(|entry| entry["action"] == "assignment.retried")
                .count(),
            1
        );
        assert_eq!(
            audits
                .iter()
                .filter(|entry| entry["action"] == "ticket.retried")
                .count(),
            1,
            "The API's former outer audit is now part of this same atomic domain completion"
        );
        assert!(store.verify_audit().unwrap());
    }

    #[test]
    fn negative_priority_retry_retains_ticket_value_and_all_immutable_history() {
        let fixture = fixture("failed", 1, false);
        let store = fixture.store;
        store
            .conn()
            .execute(
                "INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at,priority) SELECT 'negative-priority',project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at,-37 FROM tickets WHERE id='ticket-a'",
                [],
            )
            .unwrap();
        store
            .conn()
            .execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,acknowledged_at,created_at,last_report_at) SELECT 'negative-original','negative-priority',node_id,worker_id,1,'negative-lease',1,lease_expires_at,acknowledged_at,created_at,last_report_at FROM assignments WHERE id='original-assignment'", [])
            .unwrap();
        store
            .conn()
            .execute("INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) SELECT 'negative-report','negative-original','negative-priority',node_id,1,'negative-request',state,summary,evidence,session_ref,0,created_at FROM reports WHERE id='original-report'", [])
            .unwrap();
        let before = store.detail("negative-priority").unwrap();
        let grant = store.get("grants", "grant-a").unwrap().unwrap();
        assert_eq!(before["priority"], -37);
        retry(&store, "negative-priority").unwrap();
        let after = store.detail("negative-priority").unwrap();
        assert_eq!(after["priority"], -37);
        assert_eq!(after["attempt"], 2);
        assert_eq!(after["grant_digest"], grant["digest"]);
        assert_eq!(after["reports"], before["reports"]);
        assert_eq!(after["artifacts"], before["artifacts"]);
        assert_eq!(after["effects"], before["effects"]);
        assert_eq!(after["assignments"].as_array().unwrap().len(), 2);
        assert_eq!(store.audits(Some("negative-priority")).unwrap().len(), 2);
        assert!(store.verify_audit().unwrap());
    }

    #[test]
    fn approval_audits_roll_back_ticket_assignment_and_lease_together() {
        for action in ["assignment.retried", "task.approval_granted"] {
            let fixture = fixture("waiting_approval", 0, false);
            let store = fixture.store;
            store
                .conn()
                .execute("DELETE FROM assignments WHERE ticket_id='ticket-a'", [])
                .unwrap();
            let before = store.detail("ticket-a").unwrap();
            let audits = store.audits(None).unwrap();
            store
                .conn()
                .execute(
                    &format!("CREATE TRIGGER fail_approval_audit BEFORE INSERT ON audits WHEN NEW.action='{action}' BEGIN SELECT RAISE(ABORT,'owned approval audit failure'); END"),
                    [],
                )
                .unwrap();
            let error = approve_ticket(
                &store,
                "ticket-a",
                ApprovalContext {
                    approval_id: "approval-regression",
                    reason: "Audit must be inseparable from actual execution",
                },
            )
            .unwrap_err();
            assert!(error.to_string().contains("owned approval audit failure"));
            assert_eq!(store.detail("ticket-a").unwrap(), before);
            assert_eq!(store.audits(None).unwrap(), audits);
            assert!(store.verify_audit().unwrap());
            store
                .conn()
                .execute("DROP TRIGGER fail_approval_audit", [])
                .unwrap();
            approve_ticket(
                &store,
                "ticket-a",
                ApprovalContext {
                    approval_id: "approval-regression",
                    reason: " Audit is committed with execution ",
                },
            )
            .unwrap();
            let after = store.detail("ticket-a").unwrap();
            assert_eq!(after["status"], "running");
            assert_eq!(after["attempt"], 1);
            assert_eq!(after["assignments"].as_array().unwrap().len(), 1);
            let audit_rows = store.audits(Some("ticket-a")).unwrap();
            assert_eq!(audit_rows.len(), 3);
            let granted: Value =
                serde_json::from_str(audit_rows[2]["evidence"].as_str().unwrap()).unwrap();
            assert_eq!(
                granted["evidence"]["reason"],
                " Audit is committed with execution "
            );
            assert_eq!(granted["evidence"]["approval_id"], "approval-regression");
            assert_eq!(granted["evidence"]["decision"], "approve");
            assert_eq!(granted["evidence"]["grant_created"], false);
            assert!(store.verify_audit().unwrap());
        }
    }

    #[test]
    fn failed_retry_ticket_audit_is_atomic_and_legacy_approval_stays_generic() {
        let failed = fixture("failed", 1, false);
        let store = failed.store;
        let before = store.detail("ticket-a").unwrap();
        let audits = store.audits(None).unwrap();
        store.conn().execute("CREATE TRIGGER fail_retry_audit BEFORE INSERT ON audits WHEN NEW.action='ticket.retried' BEGIN SELECT RAISE(ABORT,'owned retry audit failure'); END", []).unwrap();
        assert!(retry(&store, "ticket-a").is_err());
        assert_eq!(store.detail("ticket-a").unwrap(), before);
        assert_eq!(store.audits(None).unwrap(), audits);
        store
            .conn()
            .execute("DROP TRIGGER fail_retry_audit", [])
            .unwrap();
        retry(&store, "ticket-a").unwrap();
        assert_eq!(store.detail("ticket-a").unwrap()["attempt"], 2);

        let legacy = fixture("waiting_approval", 0, false);
        let store = legacy.store;
        store
            .conn()
            .execute("DELETE FROM assignments WHERE ticket_id='ticket-a'", [])
            .unwrap();
        retry_after_approval(&store, "ticket-a").unwrap();
        let actions = store
            .audits(Some("ticket-a"))
            .unwrap()
            .into_iter()
            .map(|row| row["action"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(actions, vec!["original.history", "assignment.retried"]);
    }

    #[test]
    fn rejected_decision_is_a_transactional_hold_with_its_actual_reason() {
        let fixture = fixture("waiting_approval", 0, false);
        let store = fixture.store;
        store
            .conn()
            .execute("DELETE FROM assignments WHERE ticket_id='ticket-a'", [])
            .unwrap();
        let before = store.detail("ticket-a").unwrap();
        let audits = store.audits(None).unwrap();
        store.conn().execute("CREATE TRIGGER fail_reject_audit BEFORE INSERT ON audits WHEN NEW.action='task.approval_rejected' BEGIN SELECT RAISE(ABORT,'owned rejection audit failure'); END", []).unwrap();
        assert!(reject_ticket(
            &store,
            "ticket-a",
            ApprovalContext {
                approval_id: "reject-failure",
                reason: "not yet"
            }
        )
        .is_err());
        assert_eq!(store.detail("ticket-a").unwrap(), before);
        assert_eq!(store.audits(None).unwrap(), audits);
        store
            .conn()
            .execute("DROP TRIGGER fail_reject_audit", [])
            .unwrap();
        reject_ticket(
            &store,
            "ticket-a",
            ApprovalContext {
                approval_id: "reject-persisted",
                reason: "Need a human review first",
            },
        )
        .unwrap();
        assert_eq!(
            store.detail("ticket-a").unwrap()["status"],
            "waiting_approval"
        );
        assert_eq!(
            store.detail("ticket-a").unwrap()["assignments"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        let entries = store.audits(Some("ticket-a")).unwrap();
        let evidence: Value =
            serde_json::from_str(entries[1]["evidence"].as_str().unwrap()).unwrap();
        assert_eq!(evidence["evidence"]["approval_id"], "reject-persisted");
        assert_eq!(evidence["evidence"]["reason"], "Need a human review first");
        assert_eq!(evidence["evidence"]["decision"], "reject");
        assert_eq!(evidence["evidence"]["assignment_created"], false);
    }

    #[test]
    fn absent_or_revoked_grant_cannot_interpolate_another_scope() {
        for revoke_only in [false, true] {
            let fixture = fixture("failed", 1, false);
            let store = fixture.store;
            store.conn().execute_batch("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding-b','project-a','node-b','installation-b','worker-b','/owned/project-a','binding-digest-b','2026-01-01T00:00:00Z'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant-b','project-a','node-b','worker-b','installation-b','[\"edit_file\"]',1,'alternate-grant-digest','2026-01-01T00:00:00Z','binding-b');").unwrap();
            if revoke_only {
                store.conn().execute("UPDATE grants SET revoked_at='2026-01-01T02:00:00Z',version=2 WHERE id='grant-a'",[]).unwrap();
            } else {
                store.conn().execute("PRAGMA foreign_keys=OFF", []).unwrap();
                store
                    .conn()
                    .execute("DELETE FROM grants WHERE id='grant-a'", [])
                    .unwrap();
                store.conn().execute("PRAGMA foreign_keys=ON", []).unwrap();
            }
            let fixture = Fixture {
                _directory: fixture._directory,
                store,
            };
            assert_retry_refused(
                &fixture,
                "ticket-a",
                Some("Grant revoked; cannot reactivate authorization through retry"),
            );
        }
    }
}

#[cfg(test)]
mod priority_tests {
    use super::*;

    struct Fixture {
        _directory: tempfile::TempDir,
        store: Store,
    }

    fn insert_ticket(store: &Store, id: &str, priority: i64) {
        store
            .conn()
            .execute(
                "INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at,priority) VALUES(?1,'project',?1,'read_summary','README.md',NULL,'running','grant','grant-digest','node','installation','default',1,0,?2,?2,?3)",
                params![id, format!("2026-01-01T00:00:{id}Z"), priority],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) SELECT 'assignment-' || id,id,'node','default',1,'lease-' || id,1,'2100-01-01T00:00:00Z',created_at FROM tickets WHERE id=?1",
                [id],
            )
            .unwrap();
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let at = crate::now();
        store.conn().execute_batch("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Priority fixture','/owned/priority','read_only',1,'2026-01-01T00:00:00Z','{}'); INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','default','/owned/priority','binding-digest','2026-01-01T00:00:00Z'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','default','installation','[\"read\"]',1,'grant-digest','2026-01-01T00:00:00Z','binding');").unwrap();
        store
            .conn()
            .execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','public','token','online','[\"read_summary\"]','[]','{}',?1,?1)", [&at])
            .unwrap();
        Fixture {
            _directory: directory,
            store,
        }
    }

    fn acknowledge(store: &Store, assignment: &Value) {
        assert_eq!(
            store
                .conn()
                .execute(
                    "UPDATE assignments SET acknowledged_at=?1 WHERE id=?2 AND acknowledged_at IS NULL",
                    params![crate::now(), assignment["assignment_id"].as_str().unwrap()],
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn priority_orders_only_unacknowledged_normal_assignments_with_zero_tie_unchanged() {
        let mut fixture = fixture();
        insert_ticket(&fixture.store, "01", 80);
        insert_ticket(&fixture.store, "02", 0);
        insert_ticket(&fixture.store, "03", 0);
        let selected = assignment_for_poll(&mut fixture.store, "node")
            .unwrap()
            .unwrap();
        assert_eq!(selected["ticket_id"], "01");
        assert!(selected.get("priority").is_none());
        assert!(selected["operation"].get("priority").is_none());
        acknowledge(&fixture.store, &selected);
        let selected = assignment_for_poll(&mut fixture.store, "node")
            .unwrap()
            .unwrap();
        assert_eq!(
            selected["ticket_id"], "03",
            "newer zero remains newest first"
        );
        acknowledge(&fixture.store, &selected);
        let selected = assignment_for_poll(&mut fixture.store, "node")
            .unwrap()
            .unwrap();
        assert_eq!(selected["ticket_id"], "02");
        acknowledge(&fixture.store, &selected);
        assert!(assignment_for_poll(&mut fixture.store, "node")
            .unwrap()
            .is_none());
    }

    #[test]
    fn stop_first_includes_acknowledged_and_first_delivery_pre_cancel() {
        for acknowledged in [true, false] {
            let mut fixture = fixture();
            insert_ticket(&fixture.store, "01", -100);
            insert_ticket(&fixture.store, "02", 100);
            if acknowledged {
                fixture.store.conn().execute("UPDATE assignments SET acknowledged_at='2026-01-01T00:01:00Z' WHERE ticket_id='01'", []).unwrap();
            }
            fixture
                .store
                .conn()
                .execute(
                    "UPDATE tickets SET status='cancel_requested',cancel_requested=1 WHERE id='01'",
                    [],
                )
                .unwrap();
            let selected = assignment_for_poll(&mut fixture.store, "node")
                .unwrap()
                .unwrap();
            assert_eq!(selected["ticket_id"], "01", "acknowledged={acknowledged}");
            assert_eq!(selected["cancel_requested"], true);
            assert!(selected.get("priority").is_none());
            fixture.store.conn().execute("UPDATE assignments SET last_report_at='2026-01-01T00:02:00Z' WHERE ticket_id='01'", []).unwrap();
            fixture
                .store
                .conn()
                .execute("UPDATE tickets SET status='cancelled' WHERE id='01'", [])
                .unwrap();
            let selected = assignment_for_poll(&mut fixture.store, "node")
                .unwrap()
                .unwrap();
            assert_eq!(selected["ticket_id"], "02");
            assert!(assignment_for_poll(&mut fixture.store, "intruder")
                .unwrap()
                .is_none());
        }
    }
}

#[cfg(test)]
mod revoked_assignment_tests {
    use super::*;

    struct Fixture {
        _directory: tempfile::TempDir,
        store: Store,
    }

    fn fixture(kind: &str) -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let created = crate::now();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Bounded fixture','/private/poll-fixture','read_write',1,?1,'{}')", [&created]).unwrap();
        store.conn().execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','default','/private/poll-fixture','binding-digest',?1)", [&created]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','default','installation','[\"write\"]',1,'original-grant-digest',?1,'binding')", [&created]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('ticket','project','Bounded original work',?1,'src/calc.js','original task input','running','grant','original-grant-digest','node','installation','default',1,?2,?2)", params![kind,created]).unwrap();
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('assignment','ticket','node','default',1,'lease',1,?1,?2)", params![created,created]).unwrap();
        Fixture {
            _directory: directory,
            store,
        }
    }

    fn revoke_running(fixture: &Fixture, acknowledged: bool) {
        let at = crate::now();
        fixture
            .store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at=?1,version=version+1 WHERE id='grant'",
                [&at],
            )
            .unwrap();
        fixture
            .store
            .conn()
            .execute(
                "UPDATE tickets SET status='reconciling',updated_at=?1 WHERE id='ticket'",
                [&at],
            )
            .unwrap();
        fixture
            .store
            .conn()
            .execute(
                "UPDATE assignments SET lease_expires_at=?1,acknowledged_at=?2 WHERE id='assignment'",
                params![&at, acknowledged.then_some(&at)],
            )
            .unwrap();
    }

    #[test]
    fn admitted_revoked_edit_file_gets_repeatable_stop_without_lease_or_identity_change() {
        let fixture = fixture("edit_file");
        let mut mutable_store = fixture.store;
        let initial = assignment_for_poll(&mut mutable_store, "node")
            .unwrap()
            .unwrap();
        assert_eq!(initial["purpose"], "execute");
        assert_eq!(initial["grant_status"], true);
        assert_eq!(initial["grant_version"], 1);

        mutable_store
            .conn()
            .execute(
                "UPDATE assignments SET acknowledged_at=?1 WHERE id='assignment'",
                [crate::now()],
            )
            .unwrap();
        let fixture = Fixture {
            _directory: fixture._directory,
            store: mutable_store,
        };
        revoke_running(&fixture, true);
        let expired = fixture
            .store
            .get("assignments", "assignment")
            .unwrap()
            .unwrap()["lease_expires_at"]
            .clone();
        let mut mutable_store = fixture.store;
        let stop = assignment_for_poll(&mut mutable_store, "node")
            .unwrap()
            .unwrap();
        let repeated = assignment_for_poll(&mut mutable_store, "node")
            .unwrap()
            .unwrap();

        for frame in [&stop, &repeated] {
            assert_eq!(initial["id"], frame["id"]);
            assert_eq!(initial["ticket_id"], frame["ticket_id"]);
            assert_eq!(initial["lease_id"], frame["lease_id"]);
            assert_eq!(initial["lease_epoch"], frame["lease_epoch"]);
            assert_eq!(initial["attempt"], frame["attempt"]);
            assert_eq!(initial["objective"], frame["objective"]);
            assert_eq!(initial["content"], frame["content"]);
            assert_eq!(initial["operation"], frame["operation"]);
            assert_eq!(initial["grant_digest"], frame["grant_digest"]);
            assert_eq!(initial["grant_version"], frame["grant_version"]);
            assert_eq!(frame["purpose"], "reconcile");
            assert_eq!(frame["grant_status"], false);
            assert_eq!(frame["cancel_requested"], false);
            assert_eq!(frame["lease_expires_at"], expired);
            assert_eq!(frame["grant"]["version"], 2);
            assert!(frame["grant"]["revoked_at"].is_string());
            assert_eq!(frame["grant"]["project_root"], "/private/poll-fixture");
            assert_eq!(frame["resource"]["node_id"], "node");
            assert_eq!(frame["resource"]["installation_id"], "installation");
            assert_eq!(frame["resource"]["worker_id"], "default");
        }
        assert_eq!(stop, repeated);
        assert_eq!(
            mutable_store
                .get("assignments", "assignment")
                .unwrap()
                .unwrap()["lease_expires_at"],
            expired,
            "the expired revoked lease must not be renewed"
        );
    }

    #[test]
    fn revoked_assignment_needs_admission_and_an_unreported_bounded_edit_shape() {
        for (kind, acknowledged, reported) in [
            ("edit_file", false, false),
            ("edit_file", true, true),
            ("read_summary", true, false),
            ("model_text", true, false),
            ("model_descriptor", true, false),
            ("credential_ref", true, false),
            ("dsh_agent_turn", true, false),
        ] {
            let fixture = fixture(kind);
            revoke_running(&fixture, acknowledged);
            if reported {
                fixture
                    .store
                    .conn()
                    .execute(
                        "UPDATE assignments SET last_report_at=?1 WHERE id='assignment'",
                        [crate::now()],
                    )
                    .unwrap();
            }
            let mut store = fixture.store;
            assert!(
                assignment_for_poll(&mut store, "node").unwrap().is_none(),
                "kind={kind}, acknowledged={acknowledged}, reported={reported} must not redeliver a revoked Assignment"
            );
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap()["last_report_at"]
                    .is_null(),
                !reported
            );
        }
    }

    #[test]
    fn a_changed_grant_or_explicit_cancel_cannot_become_a_revocation_snapshot() {
        for mutation in [
            "UPDATE grants SET version=3 WHERE id='grant'",
            "UPDATE grants SET digest='changed-grant-digest' WHERE id='grant'",
            "UPDATE tickets SET grant_digest='changed-grant-digest' WHERE id='ticket'",
            "UPDATE tickets SET cancel_requested=1 WHERE id='ticket'",
        ] {
            let fixture = fixture("edit_file");
            revoke_running(&fixture, true);
            fixture.store.conn().execute(mutation, []).unwrap();
            let mut store = fixture.store;
            assert!(assignment_for_poll(&mut store, "node").unwrap().is_none());
        }
    }
}
