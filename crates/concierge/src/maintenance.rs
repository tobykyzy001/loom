use crate::store::{hash, Store};
use crate::*;
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde_json::{json, Value};

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
    store: &Store,
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
) -> Result<Value> {
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
    let ticket = id("tkt");
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
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'waiting_approval',?7,'',?8,'',?9,?10,?10)",params![ticket,project_id,objective,kind,path,content,grant_id,node,worker,now])?;
        store.audit(Some(&ticket),"controller","assignment.waiting",&json!({"required_capability":capability.unwrap_or(kind),"grant_id":grant_id,"hint":"Wait for a covered node or explicitly reassign with a new Grant.","placement":&placement}))?;
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
    store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'running',?7,(SELECT digest FROM grants WHERE id=?7),?8,?9,?10,1,?11,?11)",params![ticket,project_id,objective,kind,path,content,grant_id,node_id["id"].as_str(),node_id["installation_id"].as_str(),worker,at])?;
    store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES(?1,?2,?3,?4,1,?5,1,?6,?7)",params![assignment,ticket,node_id["id"].as_str(),worker,id("lease"),expires,at])?;
    store.conn().execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,visibility,created_at) VALUES(?1,?2,'user','concierge','activity',?3,'summary',?4)",params![crate::id("msg"),ticket,"Ticket saved; an authorized assignment and lease were issued.",at])?;
    store.audit(
        Some(&ticket),
        "controller",
        "assignment.leased",
        &json!({"assignment_id":assignment,"node_id":node_id["id"],"grant_id":grant_id,"placement":&placement}),
    )?;
    store.detail(&ticket)
}

pub fn assignment_for_poll(store: &Store, node_id: &str) -> Result<Option<Value>> {
    crate::pipeline::advance_all(store)?;
    let assignment=store.query("SELECT t.id as ticket_id,t.project_id,t.kind,t.objective,t.relative_path,t.content,t.status,t.node_id,t.installation_id,t.worker_id,t.attempt,t.grant_digest,t.cancel_requested,a.id as assignment_id,a.lease_id,a.lease_epoch,a.lease_expires_at, g.operations as grant_operations FROM assignments a JOIN tickets t ON t.id=a.ticket_id JOIN grants g ON g.id=t.grant_id WHERE a.node_id=?1 AND t.attempt=a.lease_epoch AND (t.status IN ('running','cancel_requested') OR (t.status IN ('reconciling') AND a.last_report_at IS NULL)) AND g.revoked_at IS NULL AND (a.acknowledged_at IS NULL OR t.cancel_requested=1 OR t.status='reconciling') ORDER BY a.created_at DESC LIMIT 1",[node_id])?.into_iter().next();
    if let Some(mut assignment) = assignment {
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
        assignment["grant_version"] = assignment["grant"]["version"].clone();
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
pub fn retry(store: &Store, ticket: &str) -> Result<()> {
    let t = store.get("tickets", ticket)?.context("ticket not found")?;
    if t["status"] == "reconciling" {
        bail!("Unresolved outcomes require effect reconciliation, not blind retry.")
    }
    if t["cancel_requested"] == true {
        bail!("Durable stop intent cannot be overwritten by an automatic retry")
    }
    let status = t["status"].as_str().unwrap_or_default();
    if status == "succeeded" {
        return Ok(());
    }
    if !store
        .query(
            "SELECT id FROM grants WHERE id=?1 AND revoked_at IS NULL",
            [t["grant_id"].as_str().unwrap_or_default()],
        )?
        .is_empty()
    {
        let epoch = t["attempt"].as_i64().unwrap_or(0) + 1;
        let asg = id("asg");
        let program = store
            .get("projects", t["project_id"].as_str().unwrap())?
            .unwrap_or(Value::Null);
        store.conn().execute(
            "UPDATE tickets SET status='running',attempt=?1,updated_at=?2 WHERE id=?3",
            params![epoch, crate::now(), ticket],
        )?;
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) SELECT ?1,id,node_id,worker_id,?2,?3,?2,?4,?5 FROM tickets WHERE id=?6",params![asg,epoch,id("lease"),(chrono::Utc::now()+chrono::Duration::seconds(75)).to_rfc3339(),crate::now(),ticket])?;
        store.audit(Some(ticket),"client","assignment.retried",&json!({"attempt":epoch,"node_id":t["node_id"],"project_revision":program["inventory"]["revision"]}))?;
    } else {
        bail!("Grant revoked; cannot reactivate authorization through retry")
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
        if parsed["schema"].is_string() && parsed["schema"] != "loom.memory-candidate.v1" {
            bail!("Unsupported MemoryCandidate schema cannot be treated as legacy");
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
}
