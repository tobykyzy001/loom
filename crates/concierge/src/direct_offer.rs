//! One bounded parent Artifact -> current edit Assignment offer. The center
//! authenticates identities and scope but never reads or transports the peer bytes.
use crate::store::Store;
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde_json::{json, Value};

pub const SCHEMA: &str = "loom.direct-offer.v1";

pub fn issue(store: &Store, body: &Value, node_id: &str, installation_id: &str) -> Result<Value> {
    let recipient_ticket = body["ticket_id"]
        .as_str()
        .context("Current recipient ticket_id required")?;
    let assignment = store
        .query(
            "SELECT * FROM assignments WHERE ticket_id=?1 AND node_id=?2",
            params![recipient_ticket, node_id],
        )?
        .into_iter()
        .next()
        .context("Only the assignment owning Node can request a DirectOffer")?;
    let ticket = store
        .get("tickets", recipient_ticket)?
        .context("Recipient Ticket missing")?;
    if ticket["installation_id"] != installation_id
        || ticket["status"] != "running"
        || ticket["kind"] != "edit_file"
        || ticket["cancel_requested"] == true
        || assignment["attempt"] != ticket["attempt"]
        || assignment["lease_epoch"] != ticket["attempt"]
    {
        bail!("DirectOffer needs the exact current running edit Ticket/Installation/Lease");
    }
    if crate::parse_time(
        assignment["lease_expires_at"]
            .as_str()
            .context("Lease expiry missing")?,
    )? <= chrono::Utc::now()
    {
        bail!("DirectOffer leases may not be expired");
    }
    let source = crate::pipeline::input_for_assignment(store, recipient_ticket)?
        .context("DirectOffer needs an existing explicitly direct pipeline descendant")?;
    if source["direct_offer"] != true
        || source["transform"] != "trim"
        || source["bytes_base64"] != Value::Null
    {
        bail!("DirectOffer does not carry coordinator source bytes or arbitrary tasks");
    }
    let reference = &source["artifact_ref"];
    let artifact = store
        .get(
            "artifacts",
            reference["artifact_id"]
                .as_str()
                .context("Source UUID missing")?,
        )?
        .context("DirectOffer source Artifact must exist")?;
    if artifact["ticket_id"] != reference["ticket_id"]
        || artifact["origin_node_id"] != reference["origin_node_id"]
        || artifact["sha256"] != reference["sha256"]
        || artifact["location"] != reference["location"]
        || artifact["size_bytes"].as_u64().unwrap_or(0) == 0
        || artifact["size_bytes"].as_u64().unwrap_or(0) > 1_048_576
        || artifact["sha256"].as_str().is_none_or(|hash| {
            hash.len() != 64
                || !hash
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
    {
        bail!("DirectArtifactRef failed immutable size/hash lineage checks");
    }
    if let Some(requested) = body["artifact_id"].as_str() {
        if requested != artifact["id"] {
            bail!("Requested Artifact is not the pipeline-assigned parent");
        }
    }
    let parent_ticket = store
        .get(
            "tickets",
            artifact["ticket_id"]
                .as_str()
                .context("Source Ticket missing")?,
        )?
        .context("Source Ticket missing")?;
    if parent_ticket["status"] != "succeeded"
        || parent_ticket["kind"] != "read_summary"
        || parent_ticket["project_id"] != ticket["project_id"]
        || parent_ticket["node_id"] != artifact["origin_node_id"]
    {
        bail!("Direct offer source is not the real successful Artifact Task in this Project");
    }
    let mut permissions = Vec::new();
    for (scope_ticket, operation) in [(&parent_ticket, "read"), (&ticket, "write")] {
        let grant = store
            .get(
                "grants",
                scope_ticket["grant_id"]
                    .as_str()
                    .context("Grant ID missing")?,
            )?
            .context("Grant missing")?;
        if scope_ticket["grant_id"] != grant["id"]
            || grant["revoked_at"] != Value::Null
            || grant["project_id"] != scope_ticket["project_id"]
            || (grant["node_id"] != "auto" && grant["node_id"] != scope_ticket["node_id"])
            || grant["installation_id"] != scope_ticket["installation_id"]
            || grant["version"].as_i64().unwrap_or(0) <= 0
            || !grant["operations"]
                .as_array()
                .is_some_and(|ops| ops.contains(&json!(operation)))
        {
            bail!(
                "DirectOffer requires independent current source-read and destination-write Grants"
            );
        }
        if grant["digest"] != scope_ticket["grant_digest"] {
            bail!("Grant and Ticket identity differ");
        }
        let binding_id = grant["project_binding_id"]
            .as_str()
            .context("Exact ProjectBinding missing")?;
        let binding = store
            .query(
                "SELECT * FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
                [binding_id],
            )?
            .into_iter()
            .next()
            .context("Active ProjectBinding required")?;
        if binding["project_id"] != scope_ticket["project_id"]
            || binding["node_id"] != scope_ticket["node_id"]
            || binding["installation_id"] != scope_ticket["installation_id"]
            || binding["worker_id"] != scope_ticket["worker_id"]
            || !std::fs::canonicalize(
                binding["root_scope"]
                    .as_str()
                    .context("Binding root missing")?,
            )?
            .is_dir()
        {
            bail!("Ticket, Grant, Node, Installation, Worker or ProjectBinding root disagree");
        }
        permissions.push((grant, binding));
    }
    if permissions[0].0["id"] == permissions[1].0["id"]
        || permissions[0].1["id"] == permissions[1].1["id"]
    {
        bail!("Direct handoff needs distinctly selected read/write scopes");
    }
    let source_node = store
        .query(
            "SELECT public_key,revoked_at FROM nodes WHERE id=?1",
            [parent_ticket["node_id"]
                .as_str()
                .context("Source Node missing")?],
        )?
        .into_iter()
        .next()
        .context("Source Node is not registered")?;
    if source_node["revoked_at"] != Value::Null {
        bail!("A revoked source Node may not originate a new offer");
    }
    let source_key = source_node["public_key"]
        .as_str()
        .context("Source public key absent")?
        .to_owned();
    if loom_protocol::NodePublicKey::from_base64url(&source_key)?
        .node_id()?
        .as_str()
        != artifact["origin_node_id"].as_str().unwrap_or_default()
    {
        bail!("Source Node public key differs from the actual Artifact origin");
    }
    let recipient_key = loom_protocol::NodePublicKey::from_base64url(
        store
            .query(
                "SELECT public_key FROM nodes WHERE id=?1 AND installation_id=?2",
                params![node_id, installation_id],
            )?
            .into_iter()
            .next()
            .context("Recipient Node key not registered")?["public_key"]
            .as_str()
            .context("Recipient public key absent")?,
    )?;
    if recipient_key.node_id()?.as_str() != node_id {
        bail!("Recipient public-key binding changed");
    }
    if parent_ticket["node_id"] == node_id {
        bail!("DirectOffer requires two independent Nodes");
    }
    if let Some(existing) = store
        .query(
            "SELECT * FROM direct_offers WHERE ticket_id=?1 AND lease_epoch=?2",
            params![
                recipient_ticket,
                ticket["attempt"]
                    .as_i64()
                    .context("Ticket attempt required")? as u64
            ],
        )?
        .into_iter()
        .next()
    {
        if existing["definition_json"].is_string() {
            let mut output: Value =
                serde_json::from_str(existing["definition_json"].as_str().unwrap())?;
            output["nonce"] = existing["nonce"].clone();
            output["recipient_public_key"] = existing["recipient_public_key"].clone();
            output["source_public_key"] = json!(source_key);
            scope_state(store, &output)?;
            return Ok(json!({"direct_offer":output}));
        }
    }
    let nonce = crate::store::hex(crate::random32());
    let grant_bounds = permissions
        .iter()
        .map(|(grant, _)| grant["version"].clone())
        .collect::<Vec<_>>();
    let output = json!({
        "schema":SCHEMA, "offer_id":crate::id("direct_offer"),
        "protocol":"loom.node.v1", "nonce":nonce,
        "artifact_ref":reference, "artifact_id":artifact["id"], "artifact_sha256":artifact["sha256"],
        "size_bytes":artifact["size_bytes"], "media_type":artifact["media_type"],
        "source_ticket_id":artifact["ticket_id"], "origin_node_id":artifact["origin_node_id"],
        "source_installation_id":parent_ticket["installation_id"], "source_worker_id":parent_ticket["worker_id"],
        "recipient_node_id":node_id, "recipient_installation_id":installation_id,
        "recipient_worker_id":ticket["worker_id"], "ticket_id":recipient_ticket,
        "assignment_id":assignment["id"], "lease_id":assignment["lease_id"], "lease_epoch":ticket["attempt"],
        "expires_at":std::cmp::min(crate::parse_time(assignment["lease_expires_at"].as_str().unwrap())?, chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339(),
        "source_binding_id":permissions[0].1["id"], "destination_binding_id":permissions[1].1["id"],
        "source_grant_id":permissions[0].0["id"], "destination_grant_id":permissions[1].0["id"],
        "source_grant_digest":permissions[0].0["digest"], "destination_grant_digest":permissions[1].0["digest"],
        "source_grant_version":grant_bounds[0], "destination_grant_version":grant_bounds[1],
        "source_public_key":source_key, "recipient_public_key":recipient_key.to_base64url(),
        "transport":"loopback-explicit-configuration", "byte_limit":1_048_576,
    });
    let mut definition = output.clone();
    definition.as_object_mut().unwrap().remove("nonce");
    definition
        .as_object_mut()
        .unwrap()
        .remove("recipient_public_key");
    definition
        .as_object_mut()
        .unwrap()
        .remove("source_public_key");
    store.conn().execute("INSERT INTO direct_offers(id,ticket_id,lease_epoch,artifact_id,origin_node_id,recipient_node_id,nonce,recipient_public_key,definition_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)", params![output["offer_id"].as_str().context("Offer ID required")?,recipient_ticket,ticket["attempt"].as_i64().context("Ticket attempt required")? as u64,artifact["id"].as_str().context("Artifact ID required")?,artifact["origin_node_id"].as_str().context("Artifact origin required")?,node_id,&nonce,output["recipient_public_key"].as_str().context("Recipient public key required")?,serde_json::to_string(&definition)?,crate::now()])?;
    store.audit(Some(recipient_ticket), "controller", "direct_offer.issued", &json!({"offer_id":output["offer_id"],"artifact_id":artifact["id"],"origin_node_id":artifact["origin_node_id"],"recipient_node_id":node_id,"transport":"loopback_only"}))?;
    Ok(
        json!({"direct_offer":output, "issuer":"concierge_scope_only", "artifact_bytes_included":false}),
    )
}

/// A retained offer is durable, not a perpetual authorization after a Grant is revoked.
pub fn scope_state(store: &Store, offer: &Value) -> Result<(Value, String)> {
    let target_ticket = offer["ticket_id"]
        .as_str()
        .context("DirectOffer recipient ticket is missing")?;
    let recipient = offer["recipient_node_id"]
        .as_str()
        .context("DirectOffer recipient Node is missing")?;
    let lease_epoch = offer["lease_epoch"]
        .as_u64()
        .context("DirectOffer lease epoch is not an unsigned integer")?;
    let assignment = store
        .query(
            "SELECT * FROM assignments WHERE id=?1 AND node_id=?2 AND lease_epoch=?3",
            params![offer["assignment_id"].as_str(), recipient, lease_epoch],
        )?
        .into_iter()
        .next()
        .context("Recipient Assignment/Lease is no longer current")?;
    let ticket = store
        .get("tickets", target_ticket)?
        .context("Recipient Ticket no longer exists")?;
    if ticket["status"] != "running"
        || ticket["cancel_requested"] == true
        || ticket["attempt"].as_u64() != Some(lease_epoch)
        || assignment["lease_epoch"].as_u64() != Some(lease_epoch)
        || ticket["node_id"] != recipient
        || ticket["installation_id"] != offer["recipient_installation_id"]
        || assignment["worker_id"] != offer["recipient_worker_id"]
    {
        bail!("Recipient task was cancelled, changed or is not the live edit Assignment");
    }
    if crate::parse_time(
        assignment["lease_expires_at"]
            .as_str()
            .context("Current Lease expiry missing")?,
    )? <= chrono::Utc::now()
        || crate::parse_time(
            offer["expires_at"]
                .as_str()
                .context("Offer expiry missing")?,
        )? <= chrono::Utc::now()
    {
        bail!("DirectOffer or current recipient Lease has expired");
    }
    for (kind, operation) in [("source_grant", "read"), ("destination_grant", "write")] {
        let grant = store
            .get(
                "grants",
                offer[format!("{kind}_id")]
                    .as_str()
                    .context("Offer Grant binding missing")?,
            )?
            .context("Offer Grant no longer exists")?;
        if grant["revoked_at"] != Value::Null
            || grant["version"] != offer[format!("{kind}_version")]
            || grant["digest"] != offer[format!("{kind}_digest")]
            || !grant["operations"]
                .as_array()
                .is_some_and(|ops| ops.contains(&json!(operation)))
        {
            bail!("Offer's {operation} Grant is revoked, superseded or mismatched");
        }
        let binding_key = if operation == "read" {
            "source_binding_id"
        } else {
            "destination_binding_id"
        };
        let node_key = if operation == "read" {
            "origin_node_id"
        } else {
            "recipient_node_id"
        };
        let worker_key = if operation == "read" {
            "source_worker_id"
        } else {
            "recipient_worker_id"
        };
        let binding = store
            .query(
                "SELECT * FROM project_bindings WHERE id=?1 AND revoked_at IS NULL",
                [offer[binding_key].as_str()],
            )?
            .into_iter()
            .next()
            .context("Offer ProjectBinding revoked")?;
        if binding["worker_id"] != offer[worker_key]
            || binding["node_id"] != offer[node_key]
            || binding["installation_id"] != grant["installation_id"]
            || (grant["node_id"] != "auto" && grant["node_id"] != binding["node_id"])
        {
            bail!("Offer worker, installation or root binding changed");
        }
    }
    let artifact = store
        .get(
            "artifacts",
            offer["artifact_id"]
                .as_str()
                .context("Offer Artifact missing")?,
        )?
        .context("Offer Artifact is unknown")?;
    if artifact["sha256"] != offer["artifact_sha256"]
        || artifact["origin_node_id"] != offer["origin_node_id"]
        || artifact["ticket_id"] != offer["source_ticket_id"]
    {
        bail!("Offer Artifact origin, SHA or producer changed");
    }
    Ok((
        offer.clone(),
        offer["nonce"]
            .as_str()
            .context("Offer nonce missing")?
            .to_owned(),
    ))
}

pub fn peek(store: &Store, body: &Value, node_id: &str, installation_id: &str) -> Result<Value> {
    let reference = body["artifact_ref"]
        .as_object()
        .context("Full immutable artifact_ref required")?;
    if reference.get("artifact_id").and_then(Value::as_str) != body["artifact_id"].as_str()
        || reference.get("sha256").and_then(Value::as_str) != body["sha256"].as_str()
        || reference.get("ticket_id").and_then(Value::as_str) != body["source_ticket_id"].as_str()
        || reference.get("origin_node_id").and_then(Value::as_str)
            != body["origin_node_id"].as_str()
        || body["node_id"] != node_id
        || body["installation_id"] != installation_id
    {
        bail!("Received request is not for this Node / Artifact production scope");
    }
    let existing = store
        .query(
            "SELECT * FROM direct_offers WHERE artifact_id=?1 AND origin_node_id=?2 AND nonce=?3",
            params![
                body["artifact_id"]
                    .as_str()
                    .context("Artifact ID required")?,
                node_id,
                body["nonce"].as_str().context("Offer nonce required")?
            ],
        )?
        .into_iter()
        .next()
        .context("No trusted source-side original offer")?;
    let mut output: Value = serde_json::from_str(
        existing["definition_json"]
            .as_str()
            .context("Offer missing")?,
    )?;
    output["nonce"] = existing["nonce"].clone();
    output["recipient_public_key"] = existing["recipient_public_key"].clone();
    output["source_public_key"] = json!(
        store
            .query("SELECT public_key FROM nodes WHERE id=?1", [node_id])?
            .into_iter()
            .next()
            .context("Source key missing")?["public_key"]
    );
    for key in [
        "recipient_node_id",
        "recipient_installation_id",
        "recipient_worker_id",
        "ticket_id",
        "assignment_id",
        "lease_id",
        "source_ticket_id",
        "origin_node_id",
        "artifact_id",
    ] {
        if body[key] != output[key] {
            bail!("Stored direct recipient and Artifact scope differ");
        }
    }
    let (output, _) = scope_state(store, &output)?;
    Ok(output)
}
