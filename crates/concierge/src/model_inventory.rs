//! Strict read-only projection of the latest authenticated Node SDK catalogue.
//! Stored heartbeat observations are not a model registry or execution Grant.
use crate::inventory::{heartbeat_freshness, Freshness};
use crate::store::Store;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const CATALOG_SCHEMA: &str = "loom.model-inventory.v1";
pub const PREPARED_LOOKUP: &str = "ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall";
const MAX_ENTRIES: usize = 8;
const NOT_SUPPORTED: [&str; 6] = [
    "download",
    "install",
    "activate",
    "general_provider_registry",
    "image_generation",
    "model_execution_grants",
];

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCatalog {
    schema: String,
    revision: u64,
    worker_id: String,
    lookup_source: String,
    source: String,
    observed_at: String,
    #[serde(default, alias = "entries")]
    models: Vec<RawEntry>,
    #[serde(default)]
    findings: Vec<RawFinding>,
    policy: RawPolicy,
    #[serde(default)]
    node_presence: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawEntry {
    provider: String,
    model: String,
    source: String,
    observed_at: String,
    resource_state: String,
    prepared_call_observed: Option<BoolOrText>,
    generation_observed: Option<bool>,
    input_modalities: Option<Vec<String>>,
    #[serde(default)]
    context_window: Option<u64>,
    /// Optional enumeration acknowledgement, not execution permission.
    #[serde(default)]
    catalogued: Option<bool>,
    #[serde(default)]
    tools_skills_required: Option<bool>,
    #[serde(default)]
    activation: Option<String>,
    #[serde(default)]
    location: Option<String>,
    #[serde(default)]
    validation: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BoolOrText {
    Bool(bool),
    Text(String),
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFinding {
    state: String,
    provider: Option<String>,
    model: Option<String>,
    source: String,
    observed_at: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPolicy {
    install: bool,
    download: bool,
    activation: bool,
    generation: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogedModel {
    pub id: String,
    pub node_id: String,
    pub installation_id: String,
    pub worker_id: String,
    pub provider: String,
    pub model: String,
    pub catalogued: bool,
    pub prepared_call_observed: bool,
    pub generation_observed: bool,
    pub input_modalities: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    pub source: String,
    pub observed_at: String,
    pub resource_state: String,
    pub activated: bool,
    pub allowed: bool,
    pub executable: bool,
    pub controller_matches: bool,
    pub read_source: String,
    pub freshness: Freshness,
}
#[derive(Debug, Serialize)]
pub struct ModelFinding {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct ModelInventoryView {
    pub schema: String,
    pub revision: u64,
    pub models: Vec<CatalogedModel>,
    pub findings: Vec<ModelFinding>,
    pub resource_facts: Vec<Value>,
    pub policy: Value,
    pub confidence: String,
    pub node_id: String,
    pub installation_id: String,
    pub worker_id: String,
    pub read_source: String,
    pub lookup_source: String,
    pub controller_matches: bool,
    pub permission_granted: bool,
}
#[derive(Debug, Serialize)]
pub struct InventoryResponse {
    pub schema: String,
    pub revision: u64,
    pub models: Vec<CatalogedModel>,
    pub observations: Vec<ModelInventoryView>,
    pub policy: Value,
    pub policy_code: String,
}
fn policy() -> Value {
    json!({
        "schema": CATALOG_SCHEMA,
        "views": "observations",
        "supported_operations": ["read_catalog_only"],
        "install_support": "NOT_IMPLEMENTED",
        "activation_support": "NOT_IMPLEMENTED",
        "download_support": "NOT_IMPLEMENTED",
        "install": false, "download": false, "activation": false, "generation": false,
        "remote_delivery": false, "billing_effects": false,
        "universal_provider_registry": false, "not_supported": NOT_SUPPORTED
    })
}
fn timestamp(value: &str) -> bool {
    value.len() <= 80 && DateTime::parse_from_rfc3339(value).is_ok()
}
fn safe_name(value: Option<&str>) -> Option<String> {
    let value = value?;
    let secret_shape = ["token", "secret", "api_key", "password", "credential"];
    (value.len() <= 160
        && value.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.' | ':')
        })
        && value.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && value
            .chars()
            .last()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && !secret_shape.iter().any(|part| value.contains(part)))
    .then(|| value.to_owned())
}

/// All registered installations are bounded by the Store list ceiling. Invalid
/// model data never shadows another Node's valid observation. No SDK is called
/// on this read and no SQL model registry is created.
pub fn all(store: &Store, now: DateTime<Utc>) -> Result<InventoryResponse> {
    let mut observations = Vec::new();
    for node in store.list("nodes")? {
        if node["id"].as_str().is_some_and(|id| !id.is_empty()) {
            observations.push(project_node(&node, now));
        }
    }
    let models = observations
        .iter()
        .flat_map(|view| view.models.clone())
        .collect();
    Ok(InventoryResponse {
        schema: CATALOG_SCHEMA.to_owned(),
        revision: 1,
        models,
        observations,
        policy: policy(),
        policy_code: "observed_only_not_activation".to_owned(),
    })
}

/// Exact source selection is useful to callers that already know the Node
/// identity; no catalog-supplied Node or installation attributes can override it.
pub fn inventory(
    store: &Store,
    node_id: &str,
    installation_id: &str,
    worker_id: &str,
    now: DateTime<Utc>,
) -> Result<ModelInventoryView> {
    let nodes = store.query(
        "SELECT id,installation_id,workers,inventory,last_heartbeat,revoked_at,status FROM nodes WHERE id=?1 AND installation_id=?2",
        [node_id, installation_id],
    )?;
    if let Some(node) = nodes.first() {
        let exists = node["workers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|worker| {
                worker
                    .get("worker_id")
                    .or_else(|| worker.get("id"))
                    .and_then(Value::as_str)
                    == Some(worker_id)
            });
        if !exists {
            let node_id = node["id"].as_str().unwrap_or("unknown");
            let installation_id = node["installation_id"].as_str().unwrap_or("unknown");
            let mut view = empty_view(
                node_id,
                installation_id,
                "unknown_scope",
                "invalid_observation",
                "worker_mismatch",
                false,
            );
            view.findings
                .push(finding("worker_mismatch", None, None, None));
            return Ok(view);
        }
        return Ok(project_node_for_worker(node, worker_id, now));
    }
    Ok(empty_view(
        node_id,
        installation_id,
        worker_id,
        "missing_unknown",
        "installation_unknown",
        false,
    ))
}

fn project_node(node: &Value, now: DateTime<Utc>) -> ModelInventoryView {
    project_node_for_worker(node, "", now)
}
fn project_node_for_worker(
    node: &Value,
    selected_worker: &str,
    now: DateTime<Utc>,
) -> ModelInventoryView {
    let node_id = node["id"].as_str().unwrap_or_default().to_owned();
    let installation_id = node["installation_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let freshness = heartbeat_freshness(node["last_heartbeat"].as_str(), now);
    let confidence = if !node["revoked_at"].is_null() {
        "revoked_last_known"
    } else if node["status"] == "offline" {
        "offline_last_known"
    } else if freshness != Freshness::Fresh {
        "stale_last_known"
    } else {
        "fresh_observation"
    }
    .to_owned();
    let mut view = empty_view(
        &node_id,
        &installation_id,
        if selected_worker.is_empty() {
            "all_declared_workers"
        } else {
            selected_worker
        },
        &confidence,
        "model_catalog_missing",
        true,
    );
    view.confidence = confidence.clone();
    let mut resources = reported_resources(&node["inventory"]);
    if freshness != Freshness::Fresh {
        for fact in &mut resources {
            fact["freshness"] = json!("stale");
            if fact["confidence"] == "available" {
                fact["confidence"] = json!("stale");
            }
        }
    }
    view.resource_facts = resources;
    let catalog = match parse_catalog(&node["inventory"]) {
        Ok(catalog) => catalog,
        Err(code) => {
            view.findings.push(finding(code, None, None, None));
            view.confidence = if code == "model_catalog_missing" {
                "missing_unknown".to_owned()
            } else {
                "invalid_observation".to_owned()
            };
            return view;
        }
    };
    if catalog.schema != CATALOG_SCHEMA
        || catalog.revision != 1
        || catalog.source != "host_reported"
        || catalog.lookup_source != PREPARED_LOOKUP
        || !timestamp(&catalog.observed_at)
        || catalog
            .node_presence
            .as_deref()
            .is_some_and(|state| state != "present")
        || catalog.policy.install
        || catalog.policy.download
        || catalog.policy.activation
        || catalog.policy.generation
        || catalog.models.len() > MAX_ENTRIES
        || catalog.findings.len() > MAX_ENTRIES
    {
        view.confidence = "invalid_observation".to_owned();
        view.findings
            .push(finding("source_invalid", None, None, None));
        return view;
    }
    view.confidence = confidence.clone();
    view.lookup_source = PREPARED_LOOKUP.to_owned();
    let worker_exists = node["workers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|worker| {
            worker
                .get("worker_id")
                .or_else(|| worker.get("id"))
                .and_then(Value::as_str)
                == Some(catalog.worker_id.as_str())
                && harness_name(worker).is_some()
        });
    if !worker_exists {
        view.confidence = "invalid_observation".to_owned();
        view.worker_id = String::new();
        view.findings
            .push(finding("worker_mismatch", None, None, None));
        return view;
    }
    // One incoming catalog may describe only one actual worker. Never collapse
    // its distinct scope into a generic synthetic default worker.
    view.worker_id.clone_from(&catalog.worker_id);
    if !selected_worker.is_empty() && selected_worker != catalog.worker_id {
        view.confidence = "invalid_observation".to_owned();
        view.findings
            .push(finding("worker_mismatch", None, None, None));
        return view;
    }
    if selected_worker.is_empty() && catalog.worker_id != "default" {
        view.worker_id = catalog.worker_id.clone();
    }
    for raw in catalog.findings {
        if is_allowed_finding(&raw) {
            view.findings.push(finding(
                &raw.state,
                raw.provider,
                raw.model,
                Some(raw.observed_at),
            ));
        } else {
            view.confidence = "invalid_observation".to_owned();
            view.findings
                .push(finding("source_invalid", None, None, None));
        }
    }
    for entry in catalog.models {
        match admit(entry) {
            Some(model) => {
                let id = format!(
                    "catalog:{}",
                    Sha256::digest(
                        format!(
                            "{node_id}\0{installation_id}\0{}\0{}\0{}",
                            catalog.worker_id, model.provider, model.model
                        )
                        .as_bytes()
                    )
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
                );
                if !view.models.iter().any(|existing| existing.id == id) {
                    view.models.push(CatalogedModel {
                        id,
                        node_id: node_id.clone(),
                        installation_id: installation_id.clone(),
                        worker_id: catalog.worker_id.clone(),
                        provider: model.provider,
                        model: model.model,
                        catalogued: true,
                        prepared_call_observed: true,
                        generation_observed: false,
                        input_modalities: vec!["text".to_owned()],
                        context_window: model.context_window,
                        source: "host_reported".to_owned(),
                        observed_at: model.observed_at,
                        resource_state: if freshness == Freshness::Fresh
                            && node["revoked_at"].is_null()
                            && node["status"] != "offline"
                        {
                            "adapter_observed".to_owned()
                        } else {
                            "unavailable".to_owned()
                        },
                        activated: false,
                        allowed: false,
                        executable: false,
                        controller_matches: true,
                        read_source: "authenticated_node_heartbeat".to_owned(),
                        freshness,
                    });
                } else {
                    view.findings
                        .push(finding("duplicate_model_source", None, None, None));
                }
            }
            None => view.findings.push(finding("not_granted", None, None, None)),
        }
    }
    if view.models.is_empty() && view.findings.is_empty() {
        view.findings
            .push(finding("missing_unknown", None, None, None));
    }
    view
}
fn empty_view(
    node_id: &str,
    installation_id: &str,
    worker_id: &str,
    confidence: &str,
    _reason: &str,
    matches: bool,
) -> ModelInventoryView {
    ModelInventoryView {
        schema: CATALOG_SCHEMA.to_owned(),
        revision: 1,
        models: Vec::new(),
        findings: Vec::new(),
        resource_facts: Vec::new(),
        policy: policy(),
        confidence: confidence.to_owned(),
        node_id: node_id.to_owned(),
        installation_id: installation_id.to_owned(),
        worker_id: worker_id.to_owned(),
        read_source: "authenticated_node_heartbeat".to_owned(),
        lookup_source: "unverified_or_missing".to_owned(),
        controller_matches: matches,
        permission_granted: false,
    }
}
fn finding(
    state: &str,
    provider: Option<String>,
    model: Option<String>,
    observed_at: Option<String>,
) -> ModelFinding {
    ModelFinding {
        state: state.to_owned(),
        provider,
        model,
        observed_at,
    }
}
fn harness_name(worker: &Value) -> Option<String> {
    safe_name(worker["harness_kind"].as_str())
}
fn reported_resources(raw: &Value) -> Vec<Value> {
    let facts = raw["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|fact| serde_json::from_value(fact.clone()).ok())
        .collect::<Vec<_>>();
    let (facts, _) = crate::inventory::normalize_reported_facts(&facts, Freshness::Fresh);
    facts
        .into_iter()
        .filter_map(|fact| serde_json::to_value(fact).ok())
        .collect()
}
fn parse_catalog(raw_inventory: &Value) -> Result<RawCatalog, &'static str> {
    // Store::row_value already turns SQLite JSON text into Value::Object. Accept
    // the current field directly; only actual legacy JSON strings need a parse.
    let parsed;
    let raw = match raw_inventory {
        Value::Object(_) => raw_inventory,
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).map_err(|_| "source_invalid")?;
            &parsed
        }
        _ => return Err("source_invalid"),
    };
    let Some(raw) = raw.get("model_catalog") else {
        return Err("model_catalog_missing");
    };
    serde_json::from_value(raw.clone()).map_err(|_| "source_invalid")
}
fn is_allowed_finding(raw: &RawFinding) -> bool {
    raw.source == "host_reported"
        && timestamp(&raw.observed_at)
        && matches!(
            raw.state.as_str(),
            "prepared_call_ready"
                | "unsupported_provider"
                | "unsupported_model"
                | "unsupported_route"
                | "unsupported_modality"
                | "lookup_unavailable"
                | "lookup_failed"
                | "prepared_call_failed"
                | "requested_disabled"
                | "runtime_disposed"
                | "source_invalid"
                | "worker_mismatch"
        )
        && raw
            .provider
            .as_deref()
            .is_none_or(|value| safe_name(Some(value)).is_some())
        && raw
            .model
            .as_deref()
            .is_none_or(|value| safe_name(Some(value)).is_some())
}
struct ValidEntry {
    provider: String,
    model: String,
    observed_at: String,
    context_window: Option<u64>,
}
/// Deliberately one exact stub entry. Raw foreign-provider names are never fed
/// into an executable resource index or generalized from SDK enumeration.
fn admit(raw: RawEntry) -> Option<ValidEntry> {
    if raw.provider != "loom-stub"
        || raw.model != "loom-stub-v1"
        || raw.source != "host_reported"
        || !timestamp(&raw.observed_at)
        || raw.resource_state != "adapter_observed"
        || raw.generation_observed != Some(false)
        || raw.catalogued == Some(false)
        || raw.tools_skills_required.is_some_and(|required| required)
        || raw
            .activation
            .as_deref()
            .is_some_and(|state| state != "not_granted")
        || raw
            .location
            .as_deref()
            .is_some_and(|state| state != "local_only")
        || raw
            .validation
            .as_deref()
            .is_some_and(|state| !matches!(state, "prepared_call_succeeds" | "prepared_call_ready"))
        || raw
            .input_modalities
            .as_ref()
            .is_none_or(|modalities| modalities != &["text"])
        || raw
            .context_window
            .is_none_or(|size| size == 0 || size > 1_048_576)
    {
        return None;
    }
    let prepared = match raw.prepared_call_observed {
        Some(BoolOrText::Bool(value)) => value,
        Some(BoolOrText::Text(value)) => matches!(
            value.as_str(),
            "prepared_call_succeeds" | "prepared_call_ready"
        ),
        None => false,
    };
    prepared.then_some(ValidEntry {
        provider: raw.provider,
        model: raw.model,
        observed_at: raw.observed_at,
        context_window: raw.context_window,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use serde_json::json;
    const NODE: &str = "5d41402abc4b2a76b9719d911017c5925d41402abc4b2a76b9719d911017c592";
    fn catalog() -> Value {
        json!({
            "schema": "loom.model-inventory.v1", "revision":1,
            "worker_id":"default", "lookup_source":PREPARED_LOOKUP,
            "source":"host_reported", "observed_at":"2026-11-17T01:00:00Z",
            "models":[{"provider":"loom-stub","model":"loom-stub-v1","source":"host_reported","observed_at":"2026-11-17T01:00:00Z","resource_state":"adapter_observed","prepared_call_observed":true,"generation_observed":false,"input_modalities":["text"],"context_window":131072}],
            "findings":[{"state":"prepared_call_ready","provider":"loom-stub","model":"loom-stub-v1","source":"host_reported","observed_at":"2026-11-17T01:00:00Z"}],
            "policy":{"install":false,"download":false,"activation":false,"generation":false}
        })
    }
    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let workers = json!([{"worker_id":"default","harness_kind":"dsh-loom","profile_id":"isolated","status":"online"}]);
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES(?1,'installation','x','token','online','[]',?2,?3,?4,?4)", rusqlite::params![NODE, workers.to_string(), json!({"resources":[],"model_catalog":catalog()}).to_string(), Utc::now().to_rfc3339()]).unwrap();
        (dir, store)
    }
    fn get(store: &Store) -> Value {
        serde_json::to_value(inventory(store, NODE, "installation", "default", Utc::now()).unwrap())
            .unwrap()
    }
    fn update(store: &Store, catalog: Value) {
        store
            .conn()
            .execute(
                "UPDATE nodes SET inventory=?1 WHERE id=?2",
                rusqlite::params![
                    json!({"resources":[],"model_catalog":catalog}).to_string(),
                    NODE
                ],
            )
            .unwrap();
    }
    #[test]
    fn actual_helper_catalog_projects_with_no_activation() {
        let (_dir, store) = store();
        let value = get(&store);
        let model = &value["models"][0];
        assert_eq!(model["source"], "host_reported");
        assert_eq!(model["freshness"], "fresh");
        assert_eq!(model["context_window"], 131072);
        assert_eq!(model["observed_at"], "2026-11-17T01:00:00Z");
        assert_eq!(model["resource_state"], "adapter_observed");
        for property in ["activated", "allowed", "executable"] {
            assert_eq!(model[property], false);
        }
        assert_eq!(value["confidence"], "fresh_observation");
        assert_eq!(value["worker_id"], "default");
        assert_eq!(get(&store)["models"], value["models"]);
    }
    #[test]
    fn empty_catalog_findings_are_not_invalid_and_keep_disabled_policy() {
        let (_dir, store) = store();
        let mut raw = catalog();
        raw["models"] = json!([]);
        raw["findings"] = json!([{"state":"requested_disabled","source":"host_reported","observed_at":"2026-11-17T01:00:00Z"}]);
        update(&store, raw);
        let value = get(&store);
        assert!(value["models"].as_array().unwrap().is_empty());
        assert_eq!(value["confidence"], "fresh_observation");
        assert_eq!(value["findings"][0]["state"], "requested_disabled");
        assert_eq!(value["findings"][0]["observed_at"], "2026-11-17T01:00:00Z");
        assert_eq!(value["policy"]["activation"], false);
    }
    #[test]
    fn invalid_or_missing_latest_does_not_retain_fresh_old_model() {
        let (_dir, store) = store();
        let mut invalid = catalog();
        invalid["policy"]["activation"] = json!(true);
        update(&store, invalid);
        let bad = get(&store);
        assert!(bad["models"].as_array().unwrap().is_empty());
        assert_eq!(bad["confidence"], "invalid_observation");
        assert_eq!(bad["findings"][0]["state"], "source_invalid");
        store
            .conn()
            .execute("UPDATE nodes SET inventory='{}' WHERE id=?1", [NODE])
            .unwrap();
        assert_eq!(get(&store)["confidence"], "missing_unknown");
        update(&store, catalog());
        assert_eq!(get(&store)["models"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn untrusted_names_booleans_modalities_keys_and_workers_cannot_be_catalogued() {
        let (_dir, store) = store();
        let original = catalog();
        for (key, value) in [
            ("source", json!("controller_probed")),
            ("generation_observed", json!(true)),
            ("prepared_call_observed", json!(false)),
            ("input_modalities", json!(["image"])),
            ("api_key", json!("MUST_NOT_LEAK")),
            ("provider", json!("other-provider")),
            ("model", json!("deepseek-flash")),
        ] {
            let mut raw = original.clone();
            raw["models"][0][key] = value;
            update(&store, raw);
            let value = get(&store);
            assert!(value["models"].as_array().unwrap().is_empty(), "{key}");
            assert!(!serde_json::to_string(&value)
                .unwrap()
                .contains("MUST_NOT_LEAK"));
            assert!(!serde_json::to_string(&value)
                .unwrap()
                .contains("deepseek-flash"));
        }
        let mut raw = original.clone();
        raw["worker_id"] = json!("shadow-worker");
        update(&store, raw);
        assert_eq!(get(&store)["findings"][0]["state"], "worker_mismatch");
    }
    #[test]
    fn stored_heartbeat_reopen_preserves_source_and_stales_at_90_seconds() {
        let (dir, store) = store();
        let before = get(&store);
        drop(store);
        let store = Store::open(dir.path()).unwrap();
        let after = get(&store);
        assert_eq!(before, after);
        store
            .conn()
            .execute(
                "UPDATE nodes SET last_heartbeat=?1",
                [(Utc::now() - Duration::seconds(90)).to_rfc3339()],
            )
            .unwrap();
        let old = get(&store);
        assert_eq!(old["confidence"], "stale_last_known");
        assert_eq!(old["models"][0]["resource_state"], "unavailable");
        assert_eq!(old["models"][0]["observed_at"], "2026-11-17T01:00:00Z");
        assert_eq!(old["models"][0]["allowed"], false);
    }
}
