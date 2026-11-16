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
    model_resource: Option<(&str, &str)>,
) -> Result<Value> {
    let node_id = matching_physical_node(
        store,
        capability.unwrap_or(kind),
        preferred,
        &store.get("grants", grant_id)?.context("Grant not found")?,
        worker.unwrap_or("default"),
    )?;
    let model_content = model_resource.map(|(provider, model)| {
        json!({"schema":"loom.model-text.v1","objective":objective,"provider":provider,"model":model}).to_string()
    });
    let content = model_content.as_deref().or(content);
    if (kind == "model_text") != model_resource.is_some() {
        bail!(
            "Each text-model Ticket must have its explicit resource and no other kind may carry it"
        );
    }
    if let Some((provider, model)) = model_resource {
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
    let assignment=store.query("SELECT t.id as ticket_id,t.project_id,t.kind,t.objective,t.relative_path,t.content,t.status,t.node_id,t.installation_id,t.worker_id,t.attempt,t.grant_digest,t.cancel_requested,a.id as assignment_id,a.lease_id,a.lease_epoch,a.lease_expires_at, g.operations as grant_operations FROM assignments a JOIN tickets t ON t.id=a.ticket_id JOIN grants g ON g.id=t.grant_id WHERE a.node_id=?1 AND t.attempt=a.lease_epoch AND (t.status IN ('running','cancel_requested') OR (t.status IN ('reconciling') AND a.last_report_at IS NULL)) AND g.revoked_at IS NULL ORDER BY a.created_at DESC LIMIT 1",[node_id])?.into_iter().next();
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
        let binding = store.query(
            "SELECT root_scope,project_id,node_id,installation_id,worker_id FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
            [assignment["grant"]["project_binding_id"].as_str().unwrap_or_default()],
        )?.into_iter().next().ok_or_else(|| anyhow::anyhow!("The assignment's exact project binding is gone"))?;
        assignment["grant"]["project_root"] = binding["root_scope"].clone();
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

pub fn observation_candidate(store: &Store, body: &Value) -> Result<Value> {
    let project = body["project_id"]
        .as_str()
        .context("Observation needs a scoped project")?;
    store
        .get("projects", project)?
        .context("Observation scope unknown")?;
    let value = body["value"]
        .as_str()
        .context("Bounded observation value required")?;
    if value.len() > 500
        || value.contains("SECRET")
        || value.contains("api_key")
        || store
            .query("SELECT ?1 LIKE '%private_key%'", [value])?
            .first()
            .is_some_and(|r| r["'%private_key%'"] == 0)
    {
        bail!("Sensitive or excessive content must not become a standing suggestion")
    }
    let fingerprint =
        hash(&json!({"project_id":project,"kind":body["kind"],"value":value}).to_string());
    let expires = (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339();
    let changed = store.conn().execute(
        "UPDATE observations SET occurrences=occurrences+1,source_refs=?2 WHERE fingerprint=?1",
        params![fingerprint, body["source_refs"].to_string()],
    )?;
    if changed == 0 {
        store.conn().execute("INSERT INTO observations(id,fingerprint,scope,occurrences,source_refs,expires_at,created_at) VALUES(?1,?2,?3,1,?4,?5,?5)",params![crate::id("observation"),fingerprint,project,body["source_refs"].to_string(),expires])?;
    }
    let row = store
        .query(
            "SELECT * FROM observations WHERE fingerprint=?1",
            [&fingerprint],
        )?
        .into_iter()
        .next()
        .unwrap();
    if row["occurrences"].as_i64().unwrap_or(0) < 3 {
        return Ok(
            json!({"candidate":null,"observations":row["occurrences"],"reason":"Not enough consistent observations"}),
        );
    }
    let id = crate::id("candidate");
    let kind = body["kind"].as_str().unwrap_or("memory");
    if !matches!(kind, "memory" | "skill" | "route") {
        bail!("invalid candidate kind")
    }
    let previous_candidates = store.query(
        "SELECT id FROM candidates WHERE content LIKE ?1 AND status IN ('pending','accepted','rejected')",
        [format!("%{fingerprint}%")],
    )?;
    if !previous_candidates.is_empty() {
        return Ok(json!({"duplicate_or_blocked":true,"no_standing_permission":true}));
    }
    let candidate = json!({"content":value,"fingerprint":fingerprint,"project_id":project,"kind":kind,"source":"repeated_explicit_choices","replay_state":"unverified"});
    store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'pending',1,?6,?6)",params![id,kind,project,serde_json::to_string(&candidate)?,body["source_refs"].to_string(),crate::now()])?;
    Ok(
        json!({"candidate":store.query("SELECT * FROM candidates WHERE id=?1",[id])?.first(),"preview_required":true,"placement_grant_created":false}),
    )
}

pub fn review_candidate(store: &Store, candidate_id: &str, body: &Value) -> Result<Value> {
    let rows = store.query("SELECT * FROM candidates WHERE id=?1", [candidate_id])?;
    let candidate = rows.first().context("candidate not found")?;
    let action = body["decision"].as_str().unwrap_or_default();
    if !matches!(action, "accept" | "reject" | "later" | "never" | "undo") {
        bail!("unknown candidate review decision")
    }
    if action == "never" && candidate["version"].as_i64().unwrap_or(0) > 1 {
        bail!("do_not_suggest state is retained as audit but suppresses duplicate candidates")
    }
    if action == "accept" {
        if candidate["status"] != "pending" {
            bail!("Only a pending candidate can be accepted once; repeat review creates no authority or extra memory/skill record");
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
        if action == "undo" {
            if candidate["kind"] == "skill" && candidate["status"] != "accepted" {
                bail!("Only an explicitly accepted Skill can be undone")
            }
            // Retraction is separate from proof. It does not repeat the Ticket or Grant.
            store
                .conn()
                .execute("DELETE FROM skills WHERE candidate_id=?1", [candidate_id])?;
        }
        let status = if action == "later" {
            "later"
        } else if action == "undo" {
            "pending"
        } else {
            "rejected"
        };
        store.conn().execute(
            "UPDATE candidates SET status=?1,updated_at=?2,version=version+1 WHERE id=?3",
            params![status, crate::now(), candidate_id],
        )?;
        Ok(store
            .query("SELECT * FROM candidates WHERE id=?1", [candidate_id])?
            .first()
            .cloned()
            .unwrap_or(json!(null)))
    }
}
