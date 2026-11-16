//! Scoped observations derived from an actual Artifact registration, not a model registry.
//! Controller-persisted source and byte relationships are distinct from host claims.
use crate::store::Store;
use anyhow::{bail, Context, Result};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
use uuid::Uuid;

pub(crate) fn from_registration(
    store: &Store,
    ticket_id: &str,
    assignment_id: &str,
    node_id: &str,
    artifact_id: &str,
    artifact_digest: &str,
    metadata: &Value,
) -> Result<Option<Value>> {
    let raw = &metadata["model_ref"];
    if raw == &Value::Null {
        return Ok(None);
    }
    let reference = raw
        .as_object()
        .context("model_ref must be a bounded observation object")?;
    if reference.get("schema").and_then(Value::as_str) != Some("loom.model-ref.v1")
        || reference.get("kind").and_then(Value::as_str) != Some("model_ref")
        || reference.get("source").and_then(Value::as_str) != Some("host_reported")
    {
        bail!("Only a scoped host-observed loom.model-ref.v1 is supported");
    }
    let ticket = store
        .get("tickets", ticket_id)?
        .context("The producing Ticket is missing")?;
    if ticket["kind"] != "model_text" || ticket["node_id"] != node_id {
        bail!("A model observation must match a real model_text Ticket at this producer");
    }
    let assignment = store
        .query(
            "SELECT id FROM assignments WHERE ticket_id=?1 AND id=?2 AND node_id=?3",
            params![ticket_id, assignment_id, node_id],
        )?
        .into_iter()
        .next()
        .context("Model evidence belongs to a different Assignment/Node")?;
    let requested: Value = serde_json::from_str(ticket["content"].as_str().unwrap_or_default())
        .context("Original model_text content cannot establish its requested resource")?;
    for key in ["provider", "model"] {
        let value = reference
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default();
        if value.len() > 160 || value != requested[key].as_str().unwrap_or_default() {
            bail!("Model observation cannot select a different provider or model");
        }
        if requested[key].as_str().unwrap_or_default().is_empty() {
            bail!("Original model selection is absent or unbounded");
        }
    }
    if requested["schema"] != json!("loom.model-text.v1")
        || raw["input_modalities"] != json!(["text"])
        || raw["artifact_sha256"] != json!(artifact_digest)
    {
        bail!("Model observation must match the original text mode and actual output bytes");
    }
    let grant = store
        .get("grants", ticket["grant_id"].as_str().unwrap_or_default())?
        .context("Original text Grant is missing")?;
    if raw["grant"]["id"] != grant["id"]
        || raw["grant"]["operation"] != json!("invoke_text")
        || !grant["operations"]
            .as_array()
            .is_some_and(|entries| entries.contains(&json!("invoke_text")))
    {
        bail!("Model observation must retain the original invoke_text Grant; file read/write is not a substitute");
    }
    for key in ["execution_observed", "output_observed"] {
        if !raw[key].is_boolean() {
            bail!("Model observation booleans cannot be omitted or coerced");
        }
    }
    let observed_at = raw["observed_at"]
        .as_str()
        .context("Model observation time is missing")?;
    if observed_at.len() > 80 {
        bail!("Model observation time is unbounded");
    }
    crate::parse_time(observed_at)?;
    let not_live_llm = raw["not_live_llm"].as_bool();
    if raw["not_live_llm"] != Value::Null && not_live_llm.is_none() {
        bail!("Model observation requires null or true rather than unverified live-model claims");
    }
    // The original versioned ticket content remains the selector reference.
    if requested["provider"] == "loom-stub" && not_live_llm != Some(true) {
        bail!("The testing provider must not silently claim a live LLM");
    }
    let session_id = metadata["evidence"]
        .as_array()
        .and_then(|entries| entries.first())
        .map(|entry| entry["session"]["session_id"].as_str().unwrap_or_default())
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value).context("Model evidence must use an actual Session UUID")?;
            Ok::<String, anyhow::Error>(value.to_owned())
        })
        .transpose()?;
    let mut observation = json!({
        "schema": "loom.model-observation.v1", "artifact_id": artifact_id,
        "artifact_sha256": artifact_digest, "ticket_id": ticket_id,
        "assignment_id": assignment["id"], "origin_node_id": node_id,
        "provider": requested["provider"], "model": requested["model"],
        "input_modalities": ["text"], "source": "host_reported",
        "execution_observed": raw["execution_observed"], "output_observed": raw["output_observed"],
        "not_live_llm": not_live_llm, "observed_at": observed_at,
        "grant_id": grant["id"], "operation": "invoke_text",
        "session_id": session_id, "observation_kind": "host_reported_text_invocation"
    });
    // A timestamp in a model report was neither issued nor reset by a UI request.
    observation["observed_at"] = raw["observed_at"].clone();
    Ok(Some(observation))
}

pub(crate) fn insert(tx: &Transaction<'_>, observation: &Value) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO model_observations(artifact_id,artifact_sha256,ticket_id,assignment_id,origin_node_id,provider,model,input_modalities,source,execution_observed,output_observed,not_live_llm,grant_id,operation,observed_at,recorded_at,session_id,observation_kind) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
        params![observation["artifact_id"].as_str(), observation["artifact_sha256"].as_str(), observation["ticket_id"].as_str(), observation["assignment_id"].as_str(), observation["origin_node_id"].as_str(), observation["provider"].as_str(), observation["model"].as_str(), observation["input_modalities"].to_string(), observation["source"].as_str(), observation["execution_observed"].as_bool(), observation["output_observed"].as_bool(), observation["not_live_llm"].as_bool(), observation["grant_id"].as_str(), observation["operation"].as_str(), observation["observed_at"].as_str(), crate::now(), observation["session_id"].as_str(), observation["observation_kind"].as_str()],
    )?;
    Ok(())
}

pub(crate) fn for_ticket(store: &Store, ticket_id: &str) -> crate::api::ApiResult<Option<Value>> {
    let rows = store.query(
        "SELECT * FROM model_observations WHERE ticket_id=?1 ORDER BY recorded_at DESC LIMIT 1",
        [ticket_id],
    )?;
    let Some(mut observation) = rows.into_iter().next() else {
        return Ok(None);
    };
    observation["schema"] = json!("loom.model-observation.v1");
    for key in ["execution_observed", "output_observed"] {
        observation[key] = json!(observation[key].as_i64() == Some(1));
    }
    if observation["not_live_llm"] != Value::Null {
        observation["not_live_llm"] = json!(observation["not_live_llm"].as_i64() == Some(1));
    }
    observation["input_modalities"] =
        serde_json::from_str(observation["input_modalities"].as_str().unwrap_or("[]"))
            .map_err(|_| crate::api::ApiError::bad("Stored model modalities are unrecognized"))?;
    let grant = store.get(
        "grants",
        observation["grant_id"].as_str().unwrap_or_default(),
    )?;
    observation["grant_current"] =
        json!(grant.is_some_and(|entry| entry["revoked_at"] == Value::Null));
    if observation["session_id"] == Value::Null {
        observation.as_object_mut().unwrap().remove("session_id");
    }
    Ok(Some(observation))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store, String, Value, Value) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let node = "a".repeat(64);
        let artifact = Uuid::new_v4().to_string();
        let session = Uuid::new_v4().to_string();
        let digest = crate::sha256(b"a synthetic text result");
        let content = json!({"schema":"loom.model-text.v1","objective":"synthetic fixture","provider":"loom-stub","model":"loom-stub-v1"});
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','test','fixture-root','read_write',1,?1,'[]')", [crate::now()]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,revoked_at,digest,created_at) VALUES('grant','project',?1,'default','installation','[\"invoke_text\"]',1,NULL,?2,?3)", params![node,digest,crate::now()]).unwrap();
        store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('tkt','project','fixture','model_text','not-a-file-operation',?2,'running','grant',?3,?1,'installation','default',1,0,?4,?4)", params![node,content.to_string(),digest,crate::now()]).unwrap();
        store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('asg','tkt',?1,'default',1,'lease',1,'2099-01-01T00:00:00Z',?2)", params![node,crate::now()]).unwrap();
        let reference = json!({
            "schema":"loom.model-ref.v1","kind":"model_ref","source":"host_reported",
            "provider":"loom-stub","model":"loom-stub-v1","input_modalities":["text"],
            "execution_observed":true,"output_observed":true,"not_live_llm":true,
            "artifact_sha256":digest,"observed_at":crate::now(),
            "grant":{"id":"grant","operation":"invoke_text"}
        });
        let metadata =
            json!({"model_ref":reference,"evidence":[{"session":{"session_id":session}}]});
        (
            tmp,
            store,
            node,
            json!({"artifact_id":artifact,"digest":digest}),
            metadata,
        )
    }

    #[test]
    fn limited_model_evidence_rejects_other_resources_and_survives_revocation() {
        let (_tmp, mut store, node, identity, metadata) = fixture();
        let artifact = identity["artifact_id"].as_str().unwrap();
        let digest = identity["digest"].as_str().unwrap();
        let observation =
            from_registration(&store, "tkt", "asg", &node, artifact, digest, &metadata)
                .unwrap()
                .unwrap();
        assert_eq!(observation["execution_observed"], true);
        assert_eq!(observation["grant"]["id"], Value::Null);
        assert_eq!(observation["grant_id"], "grant");
        assert!(observation.get("secret").is_none());
        for (key, replacement) in [("provider", "another-provider"), ("model", "another-model")] {
            let mut invalid = metadata.clone();
            invalid["model_ref"][key] = json!(replacement);
            assert!(
                from_registration(&store, "tkt", "asg", &node, artifact, digest, &invalid).is_err()
            );
        }
        let mut revoked = metadata.clone();
        revoked["model_ref"]["grant"]["id"] = json!("someone-elses-grant");
        assert!(
            from_registration(&store, "tkt", "asg", &node, artifact, digest, &revoked).is_err()
        );
        let mut falsified = metadata.clone();
        falsified["model_ref"]["not_live_llm"] = json!(false);
        assert!(
            from_registration(&store, "tkt", "asg", &node, artifact, digest, &falsified).is_err()
        );
        let mut wrong_digest = metadata.clone();
        wrong_digest["model_ref"]["artifact_sha256"] = json!("b".repeat(64));
        assert!(
            from_registration(&store, "tkt", "asg", &node, artifact, digest, &wrong_digest)
                .is_err()
        );
        let mut wrong_mode = metadata.clone();
        wrong_mode["model_ref"]["input_modalities"] = json!(["text", "image"]);
        assert!(
            from_registration(&store, "tkt", "asg", &node, artifact, digest, &wrong_mode).is_err()
        );
        let tx = store.conn_mut().transaction().unwrap();
        let artifact_id = identity["artifact_id"].as_str().unwrap();
        tx.execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES(?1,'tkt','asg',?2,'result.json','application/json',23,?3,'result.artifact',?4,'[]',?5)", params![artifact_id,node,digest,format!("loom://artifact/{artifact_id}"),crate::now()]).unwrap();
        insert(&tx, &observation).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            for_ticket(&store, "tkt").unwrap().unwrap()["grant_current"],
            true
        );
        store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at=?1 WHERE id='grant'",
                [crate::now()],
            )
            .unwrap();
        let history = for_ticket(&store, "tkt").unwrap().unwrap();
        assert_eq!(history["grant_current"], false);
        assert_eq!(history["artifact_id"], identity["artifact_id"]);
        assert_eq!(history["provider"], "loom-stub");
        assert_eq!(history["input_modalities"], json!(["text"]));
        assert_eq!(history["execution_observed"], true);
        assert!(history.get("session_id").is_some());
    }
}
