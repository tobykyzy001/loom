use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct Assignment {
    pub id: String,
    pub ticket_id: String,
    pub project_id: String,
    pub node_id: String,
    pub installation_id: String,
    pub worker_id: String,
    pub attempt: u64,
    pub lease_id: String,
    pub lease_epoch: u64,
    pub lease_expires_at: DateTime<Utc>,
    pub grant_digest: String,
    pub grant_version: u64,
    pub kind: String,
    pub relative_path: String,
    pub content: Option<String>,
    pub cancel_requested: bool,
    pub status: String,
    pub grant: Grant,
    pub binding_root: std::path::PathBuf,
    pub raw: Value,
}

#[derive(Clone, Debug)]
pub struct Grant {
    pub id: String,
    pub version: u64,
    pub node_id: String,
    pub installation_id: String,
    pub worker_id: String,
    pub project_id: String,
    pub binding_id: String,
    pub binding_digest: String,
    pub operations: Vec<String>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

impl Assignment {
    /// Validate the current Concierge v1 dynamic response. Shared Rust typed v1
    /// Assignment/Grant DTOs have different fields and cannot be substituted here.
    pub fn decode(
        value: &Value,
        node_id: &str,
        installation_id: &str,
        host_root: &std::path::Path,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        let object = value
            .as_object()
            .context("assignment must be a JSON object")?;
        reject_duplicate_alias(object, "id", "assignment_id")?;
        let id = required(value, "id")?.to_owned();
        require_identifier(&id, "assignment.id")?;
        let ticket_id = required(value, "ticket_id")?.to_owned();
        require_identifier(&ticket_id, "assignment.ticket_id")?;
        let project_id = required(value, "project_id")?.to_owned();
        require_identifier(&project_id, "assignment.project_id")?;
        let assigned_node = required(value, "node_id")?;
        if assigned_node != node_id {
            bail!("assignment belongs to another node");
        }
        let assigned_installation = required(value, "installation_id")?;
        if assigned_installation != installation_id {
            bail!("assignment belongs to another installation");
        }
        let worker_id = required(value, "worker_id")?.to_owned();
        require_identifier(&worker_id, "assignment.worker_id")?;
        let lease_id = required(value, "lease_id")?.to_owned();
        require_identifier(&lease_id, "assignment.lease_id")?;
        let attempt = unsigned(value, "attempt")?;
        let lease_epoch = unsigned(value, "lease_epoch")?;
        if attempt == 0 || lease_epoch == 0 || attempt != lease_epoch {
            bail!("invalid assignment attempt/lease epoch");
        }
        let lease_expires_at = timestamp(
            required(value, "lease_expires_at")?,
            "assignment.lease_expires_at",
        )?;
        if lease_expires_at <= now
            && value.get("purpose").and_then(Value::as_str) != Some("reconcile")
            && !(value.get("purpose").and_then(Value::as_str) == Some("execute")
                && value.get("cancel_requested").and_then(Value::as_bool) == Some(true)
                && matches!(
                    value.get("status").and_then(Value::as_str),
                    Some("cancel_requested" | "cancelled")
                ))
        {
            bail!("assignment lease is expired");
        }
        let grant_digest = required(value, "grant_digest")?.to_owned();
        validate_digest(&grant_digest)?;
        let grant_version = unsigned(value, "grant_version")?;
        if grant_version == 0 {
            bail!("grant version must be positive");
        }
        let kind = required(value, "kind")?.to_owned();
        if !matches!(
            kind.as_str(),
            "read_summary" | "edit_file" | "model_descriptor"
        ) {
            bail!("unsupported assignment kind {kind}");
        }
        let relative_path = required(value, "relative_path")?.to_owned();
        if kind == "model_descriptor" && relative_path != "model.json" {
            bail!("model_descriptor only accepts the exact read-only model.json target");
        }
        loom_protocol::RelativePath::parse(relative_path.clone())?;
        if relative_path.len() > 1000 {
            bail!("relative target is too long");
        }
        let content = match value.get("content") {
            None | Some(Value::Null) => None,
            Some(Value::String(content)) if content.len() <= 1_048_576 => Some(content.clone()),
            _ => bail!("assignment content must be a bounded string"),
        };
        if kind == "edit_file" && content.is_none() {
            bail!("edit_file has no content");
        }
        if kind == "model_descriptor" && content.is_some() {
            bail!("model_descriptor does not accept supplied content");
        }
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let cancel_requested = value
            .get("cancel_requested")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || matches!(status.as_str(), "cancel_requested" | "cancelled");
        let grant_value = value
            .get("grant")
            .context("assignment has no controller-issued grant")?;
        let mut grant = Grant::decode(grant_value)?;
        if grant.node_id != node_id && grant.node_id != "auto" {
            bail!("grant node mismatch");
        }
        if grant.installation_id != installation_id {
            bail!("grant installation mismatch");
        }
        if grant.worker_id != worker_id {
            bail!("grant worker mismatch");
        }
        if grant.project_id != project_id {
            bail!("grant project mismatch");
        }
        // A revoked stop retains the original Grant/digest at the top level,
        // while its current snapshot records the separate revocation version.
        // Only this explicitly scoped reconcile may read that pairing. It is not
        // authority to execute a fresh operation or to accept other grant moves.
        let revoked_reconcile = value.get("purpose").and_then(Value::as_str) == Some("reconcile")
            && kind == "edit_file"
            && status == "reconciling"
            && !cancel_requested
            && grant_version == 1
            && grant.version == 2
            && grant.revoked_at.is_some();
        if !revoked_reconcile && (grant.version != grant_version || grant.revoked_at.is_some()) {
            bail!("grant version moved during delivery or was revoked");
        }
        if grant.expires_at.is_some_and(|expiry| expiry <= now) {
            bail!("grant is expired");
        }
        if grant.created_at > now + chrono::Duration::minutes(5) {
            bail!("grant issuance is implausibly in the future");
        }
        let required_permission = if kind == "edit_file" { "write" } else { "read" };
        if !grant
            .operations
            .iter()
            .any(|operation| operation == required_permission)
        {
            bail!("grant does not authorize {required_permission}");
        }
        if grant
            .operations
            .iter()
            .any(|operation| operation != "read" && operation != "write")
        {
            bail!("grant contains an unsupported operation");
        }
        if value.get("grant_status").and_then(Value::as_bool) != Some(grant.revoked_at.is_none()) {
            bail!(
                "controller grant state does not match execution or explicit revoke reconciliation"
            );
        }
        let resource = value
            .get("resource")
            .context("assignment has no exact approved ProjectBinding")?;
        if required(resource, "project_id")? != project_id
            || required(resource, "node_id")? != node_id
            || required(resource, "installation_id")? != installation_id
            || required(resource, "worker_id")? != worker_id
        {
            bail!("approved ProjectBinding identity/scope mismatch");
        }
        let granted_root = value["grant"]
            .get("project_root")
            .and_then(Value::as_str)
            .context("approved grant has no host project mapping")?;
        if std::path::Path::new(granted_root) != host_root {
            bail!(
                "controller-approved project root differs from the operator-configured host root"
            );
        }
        if value["grant"]["project_binding_id"].as_str() != Some(&grant.binding_id) {
            bail!("grant binding pointer mismatch");
        }
        grant.binding_digest = raw_binding_digest(resource)?;
        if revoked_reconcile {
            let reported_digest = grant_value
                .get("digest")
                .and_then(Value::as_str)
                .context("revoke reconcile must carry the immutable original grant digest")?;
            if reported_digest != grant_digest {
                bail!("current grant digest differs from the original assignment input");
            }
        }
        // The revoked current snapshot records v2, while the immutable original
        // assignment retained its creation-v1 digest. Rebuild that creation-time
        // grant for this narrow frame only; do not re-sign a different revision.
        let digest_grant = if revoked_reconcile {
            Grant {
                version: grant_version,
                ..grant.clone()
            }
        } else {
            grant.clone()
        };
        if recompute_grant_digest(&digest_grant)? != grant_digest {
            bail!("grant digest is not a verifiable controller signature");
        }
        Ok(Self {
            id,
            ticket_id,
            project_id,
            node_id: node_id.to_owned(),
            installation_id: installation_id.to_owned(),
            worker_id,
            attempt,
            lease_id,
            lease_epoch,
            lease_expires_at,
            grant_digest,
            grant_version,
            kind,
            relative_path,
            content,
            cancel_requested,
            status,
            grant,
            binding_root: host_root.to_owned(),
            raw: value.clone(),
        })
    }

    pub fn logical_digest(&self) -> String {
        digest_json(
            &json!({"assignment_id":self.id,"lease_id":self.lease_id,"lease_epoch":self.lease_epoch,
            "grant_digest":self.grant_digest,"kind":self.kind,"relative_path":self.relative_path,"content":self.content}),
        )
    }

    pub fn envelope(
        &self,
        request_id: &str,
        node_id: &str,
        installation_id: &str,
    ) -> Map<String, Value> {
        let mut map = Map::new();
        map.insert("protocol".into(), json!("loom.node.v1"));
        map.insert("node_id".into(), json!(node_id));
        map.insert("installation_id".into(), json!(installation_id));
        map.insert("request_id".into(), json!(request_id));
        map.insert("sent_at".into(), json!(Utc::now()));
        map.insert("ticket_id".into(), json!(self.ticket_id));
        map.insert("assignment_id".into(), json!(self.id));
        map.insert("lease_id".into(), json!(self.lease_id));
        map.insert("lease_epoch".into(), json!(self.lease_epoch));
        map.insert("worker_id".into(), json!(self.worker_id));
        map.insert("attempt".into(), json!(self.attempt));
        map.insert("grant_digest".into(), json!(self.grant_digest));
        map
    }
}

impl Grant {
    fn decode(value: &Value) -> Result<Self> {
        let operations = value
            .get("operations")
            .and_then(Value::as_array)
            .context("grant.operations must be an array")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .context("grant operation must be a string")
            })
            .collect::<Result<Vec<_>>>()?;
        if operations.is_empty() {
            bail!("grant is empty");
        }
        let revocation = optional_timestamp(value, "revoked_at")?;
        Ok(Self {
            id: required(value, "id")?.to_owned(),
            version: unsigned(value, "version")?,
            node_id: required(value, "node_id")?.to_owned(),
            installation_id: required(value, "installation_id")?.to_owned(),
            worker_id: required(value, "worker_id")?.to_owned(),
            project_id: required(value, "project_id")?.to_owned(),
            binding_id: required(value, "project_binding_id")?.to_owned(),
            binding_digest: String::new(),
            operations,
            revoked_at: revocation,
            expires_at: optional_timestamp(value, "expires_at")?,
            created_at: timestamp(required(value, "created_at")?, "grant.created_at")?,
        })
    }
}

// Digests are binding evidence checked by the center. This reconstructs precisely
// the controller's v1 deterministic digest input after decoding all actual fields.
fn recompute_grant_digest(grant: &Grant) -> Result<String> {
    let operations = if grant.operations.iter().any(|op| op == "read")
        && grant.operations.iter().any(|op| op == "write")
    {
        json!(["read", "write"])
    } else {
        json!(grant.operations)
    };
    let raw = grant.raw_json(operations);
    Ok(digest_json(&raw))
}

fn raw_binding_digest(resource: &Value) -> Result<String> {
    Ok(digest_json(
        &json!({"project_id":required(resource,"project_id")?,"node_id":required(resource,"node_id")?,
        "installation_id":required(resource,"installation_id")?,"worker_id":required(resource,"worker_id")?,
        "root_scope":required(resource,"root_scope")?}),
    ))
}

impl Grant {
    fn raw_json(&self, operations: Value) -> Value {
        json!({"id":self.id,"project_id":self.project_id,"node_id":self.node_id,"worker_id":self.worker_id,
            "installation_id":self.installation_id,"binding":self.binding_digest,"operations":operations,"version":self.version})
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChallengeResponse {
    pub nonce: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct RegisterResponse {
    pub token: String,
}
#[derive(Clone, Debug, Deserialize)]
pub struct PollResponse {
    pub assignment: Option<Value>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ApiErrorBody {
    pub error: ApiErrorDetail,
}
#[derive(Clone, Debug, Serialize)]
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
}

pub fn scoped_envelope(raw: &Value, request_id: &str) -> Result<Map<String, Value>> {
    let mut body = Map::new();
    body.insert("protocol".into(), json!("loom.node.v1"));
    body.insert("node_id".into(), json!(required(raw, "node_id")?));
    body.insert(
        "installation_id".into(),
        json!(required(raw, "installation_id")?),
    );
    body.insert("request_id".into(), json!(request_id));
    body.insert("sent_at".into(), json!(Utc::now()));
    body.insert("ticket_id".into(), json!(required(raw, "ticket_id")?));
    body.insert(
        "assignment_id".into(),
        json!(required(raw, "id").or_else(|_| required(raw, "assignment_id"))?),
    );
    body.insert("lease_id".into(), json!(required(raw, "lease_id")?));
    body.insert(
        "lease_epoch".into(),
        json!(raw["lease_epoch"].as_u64().context("integer lease_epoch")?),
    );
    body.insert("worker_id".into(), json!(required(raw, "worker_id")?));
    body.insert(
        "attempt".into(),
        json!(raw["attempt"].as_u64().context("integer attempt")?),
    );
    body.insert("grant_digest".into(), json!(required(raw, "grant_digest")?));
    Ok(body)
}

/// Recovery is evidence transmission only. It neither reauthorizes the Grant nor
/// runs a local file effect. IDs are deterministic across a persisted outbox retry.
pub fn restart_reconciliation_report(raw: &Value, assignment_id: &str) -> Result<Value> {
    let mut body = Map::new();
    for (field, value) in [
        ("protocol", json!("loom.node.v1")),
        ("node_id", json!(required(raw, "node_id")?)),
        ("installation_id", json!(required(raw, "installation_id")?)),
        (
            "request_id",
            json!(stable_recovery_uuid("restart-request", assignment_id)),
        ),
        ("sent_at", json!(Utc::now())),
        ("ticket_id", json!(required(raw, "ticket_id")?)),
        ("assignment_id", json!(assignment_id)),
        ("lease_id", json!(required(raw, "lease_id")?)),
        (
            "lease_epoch",
            json!(raw["lease_epoch"]
                .as_u64()
                .context("recovery lease epoch")?),
        ),
        ("worker_id", json!(required(raw, "worker_id")?)),
        (
            "attempt",
            json!(raw["attempt"].as_u64().context("recovery attempt")?),
        ),
        ("grant_digest", json!(required(raw, "grant_digest")?)),
        ("requested_state", json!("unknown")),
        ("state", json!("unknown")),
        ("status", json!("unknown")),
        (
            "summary",
            json!(
                "Node restart recovered an unconfirmed local outcome; no operation was reexecuted."
            ),
        ),
        (
            "report_id",
            json!(stable_recovery_uuid("restart-report", assignment_id)),
        ),
        ("sequence", json!(1)),
        ("created_at", json!(Utc::now())),
        ("cancel_acknowledged", json!(false)),
        ("artifacts", json!([])),
        ("artifact_ids", json!([])),
        (
            "effects",
            json!([{"effect_id":stable_recovery_uuid("restart-effect",assignment_id),"input_digest":digest_json(raw),"status":"unknown",
            "evidence":[{"kind":"restart_recovery"}],"artifacts":[]}]),
        ),
        (
            "evidence",
            json!([{"kind":"restart_recovery","assignment_id":assignment_id}]),
        ),
    ] {
        body.insert(field.to_owned(), value);
    }
    Ok(Value::Object(body))
}

fn stable_recovery_uuid(kind: &str, assignment_id: &str) -> uuid::Uuid {
    let digest = Sha256::digest(format!("loom.node.restart.v1:{kind}:{assignment_id}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Uuid::from_bytes(bytes)
}

pub fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= 4096)
        .with_context(|| format!("missing/invalid {key}"))
}
fn unsigned(value: &Value, key: &str) -> Result<u64> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .with_context(|| format!("{key} must be a non-negative integer"))
}
fn optional_timestamp(value: &Value, key: &str) -> Result<Option<DateTime<Utc>>> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(timestamp(value, key)?)),
        _ => bail!("{key} must be an RFC3339 timestamp or null"),
    }
}
fn timestamp(value: &str, key: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)
        .with_context(|| format!("invalid {key}"))?
        .with_timezone(&Utc))
}
fn require_identifier(value: &str, label: &str) -> Result<()> {
    if value.len() > 160
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        bail!("{label} is not a supported identifier");
    }
    Ok(())
}
fn validate_digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("expected lowercase SHA-256 digest");
    }
    Ok(())
}
fn reject_duplicate_alias(object: &Map<String, Value>, a: &str, b: &str) -> Result<()> {
    if object.get(a).filter(|v| !v.is_null()).is_some()
        && object.get(b).filter(|v| !v.is_null()).is_some()
        && object[a] != object[b]
    {
        bail!("conflicting {a}/{b}");
    }
    Ok(())
}
pub fn digest_json<T: Serialize + ?Sized>(value: &T) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).expect("JSON encoding"))
    )
}
pub fn decode_body<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    serde_json::from_slice(bytes).context("decode coordinator response")
}
