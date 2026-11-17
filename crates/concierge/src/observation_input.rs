//! Bounded observation input and source-reference helpers.
//! Source Tickets are evidence only; validation creates no Grant or execution.
use crate::store::Store;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub fn validate(store: &Store, input: &Value) -> Result<Value> {
    let input = input
        .as_object()
        .context("Observation input must be an object")?;
    if input.keys().any(|key| {
        !matches!(
            key.as_str(),
            "project_id" | "kind" | "value" | "source_refs"
        )
    }) {
        bail!("Observation input contains an unsupported field");
    }
    let project_id = input
        .get("project_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .context("Observation requires a nonempty project_id")?;
    let kind = input
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| matches!(*kind, "memory" | "skill" | "route"))
        .context("Observation kind must be memory, skill or route")?;
    let value = input
        .get("value")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .context("Observation value must be nonempty")?;
    if value.len() > 500
        || ["SECRET", "api_key", "private_key", "http://", "https://"]
            .iter()
            .any(|forbidden| value.contains(forbidden))
    {
        bail!("Sensitive or excessive content must not become an observation");
    }
    let source_refs = checked_refs(
        input
            .get("source_refs")
            .context("Observation requires source_refs")?,
        false,
    )?;
    if source_refs.is_empty() {
        bail!("Observation requires at least one source Ticket");
    }
    for source_id in &source_refs {
        let ticket = store
            .get("tickets", source_id)?
            .context("Observation source Ticket not found")?;
        if ticket["project_id"].as_str() != Some(project_id) {
            bail!("Observation source Ticket belongs to another project");
        }
    }
    Ok(json!({
        "project_id": project_id,
        "kind": kind,
        "value": value,
        "source_refs": source_refs,
    }))
}

/// Merge existing refs and newly validated refs without changing first-seen order.
/// `current` may be either an array or the database's serialized JSON array.
pub fn union_ref_ids(current: &Value, new: &Value) -> Result<Value> {
    let current = match current {
        Value::String(serialized) => serde_json::from_str::<Value>(serialized)
            .context("Stored source_refs must contain a JSON array")?,
        Value::Null => Value::Array(Vec::new()),
        other => other.clone(),
    };
    let mut merged = Vec::new();
    for refs in [checked_refs(&current, true)?, checked_refs(new, true)?] {
        for id in refs {
            if !merged.contains(&id) {
                merged.push(id);
            }
        }
    }
    if merged.len() > 32 {
        bail!("Observation source_refs cannot exceed 32 unique Ticket IDs");
    }
    Ok(Value::Array(
        merged.into_iter().map(Value::String).collect(),
    ))
}

/// Checks whether the expiry instant has arrived at the supplied current time.
pub fn expired(expires_at: &str, now_iso: &str) -> Result<bool> {
    let expires_at = crate::parse_time(expires_at)?;
    let now = crate::parse_time(now_iso)?;
    Ok(expires_at <= now)
}

fn checked_refs(value: &Value, allow_empty: bool) -> Result<Vec<String>> {
    let refs = value
        .as_array()
        .context("Observation source_refs must be a JSON array")?;
    if refs.len() > 32 || (!allow_empty && refs.is_empty()) {
        bail!("Observation source_refs must contain 1 through 32 Ticket IDs");
    }
    let mut result = Vec::with_capacity(refs.len());
    for entry in refs {
        let id = entry
            .as_str()
            .filter(|id| !id.trim().is_empty() && id.len() <= 160)
            .filter(|id| !id.chars().any(char::is_control))
            .context(
                "Source Ticket IDs must be nonempty, noncontrol strings of at most 160 bytes",
            )?;
        if result.iter().any(|existing| existing == id) {
            bail!("Source Ticket IDs must be unique");
        }
        result.push(id.to_owned());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;
    use rusqlite::params;

    fn fixture() -> Result<(tempfile::TempDir, Store)> {
        let temporary = tempfile::tempdir()?;
        let store = Store::open(temporary.path())?;
        for project in ["project-a", "project-b"] {
            store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES(?1,'fixture',?2,'read_only',1,?3,'[]')", params![project,format!("/synthetic/{project}"),crate::now()])?;
            store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,revoked_at,digest,created_at) VALUES(?1,?2,'node','default','installation','[]',1,NULL,'digest',?3)", params![format!("grant-{project}"),project,crate::now()])?;
            store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,created_at,updated_at) VALUES(?1,?2,'fixture','read_summary','input.txt',NULL,'succeeded',?3,'digest','node','installation','default',?4,?4)", params![format!("source-{project}"),project,format!("grant-{project}"),crate::now()])?;
        }
        Ok((temporary, store))
    }

    #[test]
    fn validates_sources_and_merges_refs_without_new_authority() -> Result<()> {
        let (_temporary, store) = fixture()?;
        let input = json!({"project_id":"project-a","kind":"memory","value":"Short summaries","source_refs":["source-project-a"]});
        assert_eq!(validate(&store, &input)?, input);
        for invalid in [
            json!({"project_id":"project-a","kind":"route","value":"x","source_refs":["missing"]}),
            json!({"project_id":"project-a","kind":"route","value":"x","source_refs":["source-project-b"]}),
            json!({"project_id":"project-a","kind":"memory","value":"https://private","source_refs":["source-project-a"]}),
            json!({"project_id":"project-a","kind":"route","value":"x","source_refs":["source-project-a","source-project-a"]}),
            json!({"project_id":"project-a","kind":"route","value":"x","source_refs":["source-project-a"],"extra":true}),
        ] {
            assert!(validate(&store, &invalid).is_err());
        }
        let merged = union_ref_ids(
            &json!(r#"["source-project-a","old-ticket"]"#),
            &json!(["old-ticket", "new-ticket"]),
        )?;
        assert_eq!(
            merged,
            json!(["source-project-a", "old-ticket", "new-ticket"])
        );
        assert!(union_ref_ids(
            &json!([]),
            &json!((0..33).map(|n| n.to_string()).collect::<Vec<_>>())
        )
        .is_err());
        assert!(union_ref_ids(&json!(["bad\0id"]), &json!([])).is_err());
        assert!(union_ref_ids(&json!([1]), &json!([])).is_err());
        assert_eq!(union_ref_ids(&json!([]), &json!([]))?, json!([]));
        assert!(expired("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")?);
        assert!(!expired("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z")?);
        assert!(expired("not-a-time", "2026-01-01T00:00:00Z").is_err());
        Ok(())
    }
}
