//! Versioned, read-only resource observations and explainable M1 placement.
//!
//! A registered node or a reported resource is not an execution Grant. Input is
//! read as a bounded set of typed fields; unknown JSON is never echoed publicly.
use crate::store::Store;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const INVENTORY_SCHEMA: &str = "loom.inventory.v1";
pub const DISCOVERY_BOUNDARY: &str = "capability discovery does not grant execution";
pub const HEARTBEAT_STALE_AFTER_SECONDS: i64 = 90;
const MAX_FACTS: usize = 64;
const MAX_WORKERS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactSource {
    UserDeclared,
    HostReported,
    ControllerProbed,
    Unverified,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Fresh,
    Stale,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FactConfidence {
    Available,
    Missing,
    Unknown,
    Incompatible,
    Denied,
    Offline,
    Busy,
    Error,
    Stale,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocationPolicy {
    LocalOnly,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FactValue {
    Text(String),
    Integer(i64),
    Boolean(bool),
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceFact {
    pub schema: String,
    pub resource: String,
    pub value: Option<FactValue>,
    pub source: FactSource,
    pub observed_at: Option<DateTime<Utc>>,
    pub freshness: Freshness,
    pub confidence: FactConfidence,
    pub location: LocationPolicy,
}
impl ResourceFact {
    pub fn unknown(resource: impl Into<String>) -> Self {
        Self {
            schema: INVENTORY_SCHEMA.to_owned(),
            resource: resource.into(),
            value: None,
            source: FactSource::Unverified,
            observed_at: None,
            freshness: Freshness::Unknown,
            confidence: FactConfidence::Unknown,
            location: LocationPolicy::LocalOnly,
        }
    }
    fn stale_if_reported(mut self, freshness: Freshness) -> Self {
        self.freshness = freshness;
        if freshness == Freshness::Stale && self.confidence == FactConfidence::Available {
            self.confidence = FactConfidence::Stale;
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallationIdentity {
    pub node_id: String,
    pub installation_id: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallationState {
    Installed,
    NeverInstalled,
    Revoked,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reachability {
    Online,
    Busy,
    Degraded,
    Offline,
    Stale,
    Revoked,
    NotInstalled,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeHealth {
    Available,
    Busy,
    Degraded,
    Offline,
    Missing,
    Revoked,
    Error,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    ReadSummary,
    EditFile,
    ModelDescriptor,
}
impl Capability {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "read_summary" | "file:read_summary" => Some(Self::ReadSummary),
            "edit_file" | "file:edit_file" => Some(Self::EditFile),
            "model_descriptor" | "file:model_descriptor" => Some(Self::ModelDescriptor),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadSummary => "read_summary",
            Self::ModelDescriptor => "model_descriptor",
            Self::EditFile => "edit_file",
        }
    }
    fn operation(self) -> &'static str {
        match self {
            Self::ReadSummary | Self::ModelDescriptor => "read",
            Self::EditFile => "write",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerView {
    pub worker_id: String,
    pub reachability: Reachability,
    pub capabilities: Vec<Capability>,
    pub supported_effects: Vec<String>,
    pub facts: Vec<ResourceFact>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InventoryIssue {
    pub code: String,
    pub resource: String,
    pub confidence: FactConfidence,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeView {
    pub schema: String,
    pub identity: InstallationIdentity,
    pub presence: InstallationState,
    pub reachability: Reachability,
    pub freshness: Freshness,
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub health: NodeHealth,
    pub facts: Vec<ResourceFact>,
    pub workers: Vec<WorkerView>,
    pub issues: Vec<InventoryIssue>,
    pub permission_boundary: String,
}

/// Absence of a record means "not registered at this coordinator", not proof
/// that software has never existed on a physical machine.
pub fn never_installed(identity: InstallationIdentity) -> NodeView {
    NodeView {
        schema: INVENTORY_SCHEMA.to_owned(),
        identity,
        presence: InstallationState::NeverInstalled,
        reachability: Reachability::NotInstalled,
        freshness: Freshness::Unknown,
        last_heartbeat: None,
        health: NodeHealth::Missing,
        facts: Vec::new(),
        workers: Vec::new(),
        issues: vec![issue(
            "not_registered",
            "installation",
            FactConfidence::Missing,
        )],
        permission_boundary: DISCOVERY_BOUNDARY.to_owned(),
    }
}

/// Both direct reads and placement use this exact heartbeat age calculation.
pub fn heartbeat_freshness(last_heartbeat: Option<&str>, now: DateTime<Utc>) -> Freshness {
    match last_heartbeat.and_then(|value| DateTime::parse_from_rfc3339(value).ok()) {
        Some(at)
            if (0..HEARTBEAT_STALE_AFTER_SECONDS).contains(
                &now.signed_duration_since(at.with_timezone(&Utc))
                    .num_seconds(),
            ) =>
        {
            Freshness::Fresh
        }
        Some(_) => Freshness::Stale,
        None => Freshness::Unknown,
    }
}
fn issue(code: &str, resource: &str, confidence: FactConfidence) -> InventoryIssue {
    InventoryIssue {
        code: code.to_owned(),
        resource: resource.to_owned(),
        confidence,
    }
}
fn bounded_text(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty() && value.len() <= max && value.chars().all(|c| !c.is_control())
        })
        .map(str::to_owned)
}
fn effect_capability(value: &str) -> Option<Capability> {
    match value {
        "file.read_summary" | "file.read" => Some(Capability::ReadSummary),
        "file.replace" | "file.write" => Some(Capability::EditFile),
        _ => None,
    }
}
fn worker_capabilities(worker: &Value, node: &Value) -> Vec<Capability> {
    let source = if worker.get("capabilities").is_some() {
        &worker["capabilities"]
    } else {
        &node["capabilities"]
    };
    let mut result = source
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| {
            value.as_str().and_then(Capability::parse).or_else(|| {
                value
                    .get("ticket_kind")
                    .and_then(Value::as_str)
                    .and_then(Capability::parse)
            })
        })
        .collect::<Vec<_>>();
    result.sort_by_key(|value| value.as_str());
    result.dedup();
    result
}
fn parse_numeric_field(
    value: &Value,
    field: &str,
    observed_at: Option<DateTime<Utc>>,
    issues: &mut Vec<InventoryIssue>,
) -> ResourceFact {
    match value.get(field) {
        None => ResourceFact::unknown(format!("hardware.{field}")),
        Some(Value::Number(value)) if value.as_u64().is_some() => ResourceFact {
            schema: INVENTORY_SCHEMA.to_owned(),
            resource: format!("hardware.{field}"),
            value: value
                .as_u64()
                .and_then(|value| i64::try_from(value).ok())
                .map(FactValue::Integer),
            source: FactSource::HostReported,
            observed_at,
            freshness: Freshness::Fresh,
            confidence: if value
                .as_u64()
                .and_then(|value| i64::try_from(value).ok())
                .is_some()
            {
                FactConfidence::Available
            } else {
                FactConfidence::Error
            },
            location: LocationPolicy::LocalOnly,
        },
        Some(_) => {
            issues.push(issue(
                "invalid_hardware_observation",
                &format!("hardware.{field}"),
                FactConfidence::Error,
            ));
            ResourceFact {
                confidence: FactConfidence::Error,
                source: FactSource::HostReported,
                observed_at,
                freshness: Freshness::Fresh,
                ..ResourceFact::unknown(format!("hardware.{field}"))
            }
        }
    }
}
fn hardware_facts(
    hardware: Option<&Value>,
    observed_at: Option<DateTime<Utc>>,
    issues: &mut Vec<InventoryIssue>,
) -> Vec<ResourceFact> {
    let mut facts = [("os", 64), ("arch", 64)]
        .into_iter()
        .map(|(field, max)| {
            let name = format!("hardware.{field}");
            let value = hardware
                .and_then(|value| value.get(field))
                .and_then(|value| bounded_text(Some(value), max))
                .filter(|value| {
                    value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                })
                .map(|value| FactValue::Text(value.to_ascii_lowercase()));
            let invalid = hardware.and_then(|value| value.get(field)).is_some() && value.is_none();
            if invalid {
                issues.push(issue(
                    "invalid_hardware_observation",
                    &name,
                    FactConfidence::Error,
                ));
            }
            ResourceFact {
                schema: INVENTORY_SCHEMA.to_owned(),
                resource: name,
                value,
                source: FactSource::HostReported,
                observed_at,
                freshness: Freshness::Fresh,
                confidence: if hardware.and_then(|value| value.get(field)).is_none() {
                    FactConfidence::Unknown
                } else if invalid {
                    FactConfidence::Error
                } else {
                    FactConfidence::Available
                },
                location: LocationPolicy::LocalOnly,
            }
        })
        .collect::<Vec<_>>();
    facts.push(parse_numeric_field(
        hardware.unwrap_or(&Value::Null),
        "memory_bytes",
        observed_at,
        issues,
    ));
    facts
}

/// Validate the fixed resource vocabulary rather than copying arbitrary JSON or
/// secret-shaped host fields into a public inventory view.
pub fn normalize_reported_facts(
    input: &[ResourceFact],
    freshness: Freshness,
) -> (Vec<ResourceFact>, Vec<InventoryIssue>) {
    let mut facts = Vec::new();
    let mut issues = Vec::new();
    for fact in input.iter().take(MAX_FACTS) {
        let valid_name = fact.resource.len() <= 160
            && !fact.resource.is_empty()
            && fact
                .resource
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
            && ["hardware.", "service.", "runtime.", "model."]
                .iter()
                .any(|prefix| fact.resource.starts_with(prefix));
        let valid_value = fact.value.as_ref().is_none_or(|value| match value {
            FactValue::Text(text) => {
                !text.is_empty() && text.len() <= 160 && text.chars().all(|c| !c.is_control())
            }
            FactValue::Integer(value) => *value >= 0,
            FactValue::Boolean(_) => true,
        });
        if !valid_name
            || !valid_value
            || fact.schema != INVENTORY_SCHEMA
            || fact.location != LocationPolicy::LocalOnly
        {
            issues.push(issue(
                "invalid_resource_observation",
                "reported_resources",
                FactConfidence::Error,
            ));
            continue;
        }
        let mut fact = fact.clone();
        // Reports are one observation channel: a nested self-assertion cannot
        // upgrade itself to a controller probe or a user declaration.
        fact.source = FactSource::HostReported;
        facts.push(fact.stale_if_reported(freshness));
    }
    if input.len() > MAX_FACTS {
        issues.push(issue(
            "too_many_resource_facts",
            "reported_resources",
            FactConfidence::Error,
        ));
    }
    (facts, issues)
}

pub fn node_view(
    identity: &InstallationIdentity,
    node: Option<&Value>,
    now: DateTime<Utc>,
) -> NodeView {
    let Some(node) = node.filter(|node| {
        node["id"] == identity.node_id && node["installation_id"] == identity.installation_id
    }) else {
        return never_installed(identity.clone());
    };
    let last = bounded_text(node.get("last_heartbeat"), 80);
    let last_heartbeat = last
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc));
    let freshness = heartbeat_freshness(last.as_deref(), now);
    let mut issues = Vec::new();
    if last_heartbeat.is_some_and(|at| at > now) {
        issues.push(issue(
            "heartbeat_from_future",
            "last_heartbeat",
            FactConfidence::Error,
        ));
    }
    if last.is_some() && last_heartbeat.is_none() {
        issues.push(issue(
            "invalid_heartbeat_timestamp",
            "last_heartbeat",
            FactConfidence::Error,
        ));
    }
    let revoked = !node["revoked_at"].is_null();
    let status = node["status"].as_str();
    let reachability = if revoked {
        Reachability::Revoked
    } else {
        match (freshness, status) {
            (Freshness::Stale, _) => Reachability::Stale,
            (Freshness::Unknown, _) => Reachability::Unknown,
            (_, Some("offline")) => Reachability::Offline,
            (_, Some("busy")) => Reachability::Busy,
            (_, Some("degraded")) => Reachability::Degraded,
            (_, Some("online")) => Reachability::Online,
            _ => {
                issues.push(issue(
                    "invalid_node_status",
                    "status",
                    FactConfidence::Error,
                ));
                Reachability::Unknown
            }
        }
    };
    let mut workers = Vec::new();
    for worker in node["workers"]
        .as_array()
        .into_iter()
        .flatten()
        .take(MAX_WORKERS)
    {
        let Some(worker_id) =
            bounded_text(worker.get("worker_id").or_else(|| worker.get("id")), 160)
        else {
            issues.push(issue("invalid_worker", "workers", FactConfidence::Error));
            continue;
        };
        let reachability = match worker["status"]
            .as_str()
            .unwrap_or(status.unwrap_or("unknown"))
        {
            "online" if freshness == Freshness::Fresh => Reachability::Online,
            "busy" if freshness == Freshness::Fresh => Reachability::Busy,
            "degraded" if freshness == Freshness::Fresh => Reachability::Degraded,
            "offline" => Reachability::Offline,
            value if freshness == Freshness::Stale => {
                let _ = value;
                Reachability::Stale
            }
            "online" | "busy" | "degraded" => Reachability::Unknown,
            _ => {
                issues.push(issue(
                    "invalid_worker_status",
                    &format!("worker:{worker_id}"),
                    FactConfidence::Error,
                ));
                Reachability::Unknown
            }
        };
        let supported_effects = worker["supported_effects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(16)
            .filter(|effect| effect_capability(effect).is_some())
            .map(str::to_owned)
            .collect();
        workers.push(WorkerView {
            worker_id,
            reachability,
            capabilities: worker_capabilities(worker, node),
            supported_effects,
            facts: Vec::new(),
        });
    }
    if node["workers"]
        .as_array()
        .is_some_and(|workers| workers.len() > MAX_WORKERS)
    {
        issues.push(issue("too_many_workers", "workers", FactConfidence::Error));
    }
    if node["workers"].as_array().is_some_and(Vec::is_empty) {
        issues.push(issue(
            "no_reported_workers",
            "workers",
            FactConfidence::Missing,
        ));
    }
    for worker in &workers {
        match worker.reachability {
            Reachability::Unknown => issues.push(issue(
                "worker_status_unknown",
                &format!("worker:{}", worker.worker_id),
                FactConfidence::Unknown,
            )),
            Reachability::Busy => issues.push(issue(
                "worker_busy",
                &format!("worker:{}", worker.worker_id),
                FactConfidence::Busy,
            )),
            Reachability::Offline => issues.push(issue(
                "worker_offline",
                &format!("worker:{}", worker.worker_id),
                FactConfidence::Offline,
            )),
            _ => {}
        }
    }
    // The registration wire format may contain a single worker without status.
    // Its declared supported effects still have to bound EditFile placement.
    // An actually reported empty worker list never turns into a default worker.
    if workers.is_empty()
        && node["workers"]
            .as_array()
            .is_none_or(|workers| workers.is_empty())
    {
        let capabilities = worker_capabilities(&Value::Null, node);
        let supported_effects = node["workers"]
            .as_array()
            .and_then(|workers| workers.first())
            .map(|worker| {
                worker["supported_effects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .filter(|effect| effect_capability(effect).is_some())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| {
                if capabilities.contains(&Capability::EditFile)
                    && node["capabilities"].as_array().is_some_and(|caps| {
                        caps.iter().any(|cap| {
                            cap.get("ticket_kind").and_then(Value::as_str) == Some("edit_file")
                        })
                    })
                {
                    vec!["file.replace".to_owned()]
                } else {
                    Vec::new()
                }
            });
        let worker_id = node["workers"]
            .as_array()
            .and_then(|workers| workers.first())
            .and_then(|worker| {
                bounded_text(worker.get("worker_id").or_else(|| worker.get("id")), 160)
            })
            .unwrap_or_else(|| "default".to_owned());
        let status = node["workers"]
            .as_array()
            .and_then(|workers| workers.first())
            .and_then(|worker| worker["status"].as_str())
            .unwrap_or_else(|| status.unwrap_or("unknown"));
        let reachability = if freshness == Freshness::Stale {
            Reachability::Stale
        } else {
            match status {
                "online" if freshness == Freshness::Fresh => Reachability::Online,
                "busy" if freshness == Freshness::Fresh => Reachability::Busy,
                "degraded" if freshness == Freshness::Fresh => Reachability::Degraded,
                "offline" => Reachability::Offline,
                "busy" => Reachability::Busy,
                "online" | "degraded" => Reachability::Unknown,
                _ => {
                    issues.push(issue(
                        "invalid_worker_status",
                        &format!("worker:{worker_id}"),
                        FactConfidence::Error,
                    ));
                    Reachability::Unknown
                }
            }
        };
        workers.push(WorkerView {
            worker_id,
            reachability,
            capabilities,
            supported_effects,
            facts: Vec::new(),
        });
    }
    let node_facts = hardware_facts(
        node["inventory"].get("hardware"),
        last_heartbeat,
        &mut issues,
    );
    let declared = node["inventory"]["resources"]
        .as_array()
        .map(|values| {
            let mut known = Vec::new();
            for value in values.iter().take(MAX_FACTS) {
                match serde_json::from_value::<ResourceFact>(value.clone()) {
                    Ok(fact) => known.push(fact),
                    Err(_) => issues.push(issue(
                        "invalid_resource_observation",
                        "reported_resources",
                        FactConfidence::Error,
                    )),
                }
            }
            known
        })
        .unwrap_or_default();
    let (mut reported, mut reported_issues) = normalize_reported_facts(&declared, freshness);
    issues.append(&mut reported_issues);
    let mut facts = node_facts
        .into_iter()
        .map(|fact| fact.stale_if_reported(freshness))
        .collect::<Vec<_>>();
    facts.append(&mut reported);
    for name in ["models", "runtimes", "services"] {
        if !facts.iter().any(|fact| {
            fact.resource != format!("{}.adapter", name.trim_end_matches('s'))
                && fact
                    .resource
                    .starts_with(&(name.trim_end_matches('s').to_owned() + "."))
        }) {
            facts.push(ResourceFact::unknown(name));
        }
    }
    let health = if revoked {
        NodeHealth::Revoked
    } else if matches!(reachability, Reachability::Offline | Reachability::Stale) {
        NodeHealth::Offline
    } else if matches!(reachability, Reachability::Busy) {
        NodeHealth::Busy
    } else if !issues.is_empty() || reachability == Reachability::Degraded {
        NodeHealth::Degraded
    } else if reachability == Reachability::Unknown {
        NodeHealth::Error
    } else {
        NodeHealth::Available
    };
    NodeView {
        schema: INVENTORY_SCHEMA.to_owned(),
        identity: identity.clone(),
        presence: if revoked {
            InstallationState::Revoked
        } else {
            InstallationState::Installed
        },
        reachability,
        freshness,
        last_heartbeat,
        health,
        facts,
        workers,
        issues,
        permission_boundary: DISCOVERY_BOUNDARY.to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareTarget {
    pub os: Option<String>,
    pub arch: Option<String>,
    pub minimum_memory_bytes: Option<u64>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementRequest {
    pub project_id: String,
    pub capability: String,
    pub worker_id: String,
    pub preferred_node_id: Option<String>,
    pub grant_id: String,
    pub project_binding_id: String,
    pub evaluated_at: DateTime<Utc>,
    pub hardware: Option<HardwareTarget>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementTarget {
    pub node_id: String,
    pub installation_id: String,
    pub worker_id: String,
    pub project_binding_id: String,
    pub root_scope: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementWait {
    pub code: String,
    pub source: FactSource,
    pub resource: String,
    pub confidence: FactConfidence,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlacementDecision {
    pub schema: String,
    pub selected: Option<PlacementTarget>,
    pub waiting: Vec<PlacementWait>,
    pub explanation: String,
    pub existing_grant_matching_passed: bool,
    pub permission_boundary: String,
}
fn wait(
    code: &str,
    source: FactSource,
    resource: &str,
    confidence: FactConfidence,
) -> PlacementWait {
    PlacementWait {
        code: code.to_owned(),
        source,
        resource: resource.to_owned(),
        confidence,
    }
}
fn exact_text(object: &Value, field: &str) -> bool {
    bounded_text(object.get(field), 4096).is_some_and(|value| value != "*")
}

/// Inspect the persisted Grant/binding and exact installed identity. Placement
/// is just a candidate explanation; assignment creation remains a separate act.
pub fn decide_placement(store: &Store, request: &PlacementRequest) -> Result<PlacementDecision> {
    let mut waiting = Vec::new();
    let Some(capability) = Capability::parse(&request.capability) else {
        return Ok(PlacementDecision {
            schema: INVENTORY_SCHEMA.to_owned(),
            selected: None,
            waiting: vec![wait(
                "unsupported_capability",
                FactSource::Unverified,
                &request.capability,
                FactConfidence::Unknown,
            )],
            explanation: "The requested capability is not a supported bounded file operation."
                .to_owned(),
            existing_grant_matching_passed: false,
            permission_boundary: DISCOVERY_BOUNDARY.to_owned(),
        });
    };
    let Some(grant) = store.get("grants", &request.grant_id)? else {
        return Ok(PlacementDecision {
            schema: INVENTORY_SCHEMA.to_owned(),
            selected: None,
            waiting: vec![wait(
                "grant_missing",
                FactSource::UserDeclared,
                &request.grant_id,
                FactConfidence::Missing,
            )],
            explanation: "No existing Grant can authorize this placement.".to_owned(),
            existing_grant_matching_passed: false,
            permission_boundary: DISCOVERY_BOUNDARY.to_owned(),
        });
    };
    let bindings = store.query(
        "SELECT * FROM project_bindings WHERE id=?1",
        [request.project_binding_id.as_str()],
    )?;
    let Some(binding) = bindings.first() else {
        return Ok(PlacementDecision {
            schema: INVENTORY_SCHEMA.to_owned(),
            selected: None,
            waiting: vec![wait(
                "project_binding_missing",
                FactSource::UserDeclared,
                &request.project_binding_id,
                FactConfidence::Missing,
            )],
            explanation: "An exact, non-revoked worker-root binding is required.".to_owned(),
            existing_grant_matching_passed: false,
            permission_boundary: DISCOVERY_BOUNDARY.to_owned(),
        });
    };
    let nodes = store.list("nodes")?;
    let identity = InstallationIdentity {
        node_id: binding["node_id"].as_str().unwrap_or_default().to_owned(),
        installation_id: binding["installation_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    };
    let record = nodes.iter().find(|node| {
        node["id"] == identity.node_id && node["installation_id"] == identity.installation_id
    });
    let view = node_view(&identity, record, request.evaluated_at);
    let preferred_for_matching = Some(identity.node_id.as_str());
    let matched = crate::maintenance::matching_physical_node(
        store,
        capability.as_str(),
        request
            .preferred_node_id
            .as_deref()
            .or(preferred_for_matching),
        &grant,
        &request.worker_id,
    )?;
    let existing_grant_matching_passed = matched.as_ref().is_some_and(|node| {
        node["id"] == identity.node_id && node["installation_id"] == identity.installation_id
    });
    if !existing_grant_matching_passed {
        waiting.push(wait(
            "existing_grant_matching_failed",
            FactSource::UserDeclared,
            &request.grant_id,
            FactConfidence::Denied,
        ));
    }
    if !binding["revoked_at"].is_null() {
        waiting.push(wait(
            "binding_revoked",
            FactSource::UserDeclared,
            &request.project_binding_id,
            FactConfidence::Denied,
        ));
    }
    if !grant["revoked_at"].is_null() {
        waiting.push(wait(
            "grant_revoked",
            FactSource::UserDeclared,
            &request.grant_id,
            FactConfidence::Denied,
        ));
    }
    if grant["project_id"] != request.project_id
        || binding["project_id"] != request.project_id
        || grant["project_binding_id"] != request.project_binding_id
    {
        waiting.push(wait(
            "grant_binding_project_mismatch",
            FactSource::UserDeclared,
            &request.project_id,
            FactConfidence::Denied,
        ));
    }
    if grant["node_id"] != "auto" && grant["node_id"] != identity.node_id {
        waiting.push(wait(
            "grant_node_mismatch",
            FactSource::UserDeclared,
            &identity.node_id,
            FactConfidence::Denied,
        ));
    }
    if !exact_text(&grant, "installation_id")
        || grant["installation_id"] != identity.installation_id
    {
        waiting.push(wait(
            "grant_installation_mismatch",
            FactSource::UserDeclared,
            &identity.installation_id,
            FactConfidence::Denied,
        ));
    }
    if grant["worker_id"] != request.worker_id || binding["worker_id"] != request.worker_id {
        waiting.push(wait(
            "grant_worker_mismatch",
            FactSource::UserDeclared,
            &request.worker_id,
            FactConfidence::Denied,
        ));
    }
    if !grant["operations"]
        .as_array()
        .is_some_and(|ops| ops.iter().any(|op| op == capability.operation()))
    {
        waiting.push(wait(
            "grant_operation_missing",
            FactSource::UserDeclared,
            capability.operation(),
            FactConfidence::Denied,
        ));
    }
    if !exact_text(binding, "node_id")
        || !exact_text(binding, "installation_id")
        || !exact_text(&grant, "worker_id")
    {
        waiting.push(wait(
            "binding_scope_not_exact",
            FactSource::UserDeclared,
            &request.project_binding_id,
            FactConfidence::Denied,
        ));
    }
    if request
        .preferred_node_id
        .as_ref()
        .is_some_and(|node| *node != identity.node_id)
    {
        waiting.push(wait(
            "preferred_node_mismatch",
            FactSource::UserDeclared,
            &identity.node_id,
            FactConfidence::Missing,
        ));
    }
    match view.presence {
        InstallationState::NeverInstalled => waiting.push(wait(
            "installation_never_registered",
            FactSource::Unverified,
            &identity.installation_id,
            FactConfidence::Missing,
        )),
        InstallationState::Revoked => waiting.push(wait(
            "node_revoked",
            FactSource::HostReported,
            &identity.node_id,
            FactConfidence::Denied,
        )),
        InstallationState::Installed => {}
    }
    match view.reachability {
        Reachability::Stale => waiting.push(wait(
            "stale_heartbeat",
            FactSource::HostReported,
            "last_heartbeat",
            FactConfidence::Stale,
        )),
        Reachability::Offline => waiting.push(wait(
            "node_offline",
            FactSource::HostReported,
            &identity.node_id,
            FactConfidence::Offline,
        )),
        Reachability::Busy => waiting.push(wait(
            "node_busy",
            FactSource::HostReported,
            &identity.node_id,
            FactConfidence::Busy,
        )),
        Reachability::Revoked | Reachability::NotInstalled => {}
        _ if view.freshness != Freshness::Fresh => waiting.push(wait(
            "heartbeat_unknown",
            FactSource::Unverified,
            "last_heartbeat",
            FactConfidence::Unknown,
        )),
        _ => {}
    }
    let worker = view
        .workers
        .iter()
        .find(|worker| worker.worker_id == request.worker_id);
    let Some(worker) = worker else {
        waiting.push(wait(
            "worker_not_installed",
            FactSource::HostReported,
            &request.worker_id,
            FactConfidence::Missing,
        ));
        return Ok(decision(None, waiting));
    };
    if !binding["root_scope"].as_str().is_some_and(|root| {
        !root.is_empty() && root != "*" && root.len() <= 4096 && !root.contains('\0')
    }) || binding["root_scope"].as_str()
        != record.and_then(|node| node["inventory"]["project_roots"][&request.project_id].as_str())
    {
        waiting.push(wait(
            "worker_root_not_declared_exactly",
            FactSource::HostReported,
            &request.project_id,
            FactConfidence::Missing,
        ));
    }
    match worker.reachability {
        Reachability::Busy => waiting.push(wait(
            "worker_busy",
            FactSource::HostReported,
            &request.worker_id,
            FactConfidence::Busy,
        )),
        Reachability::Offline | Reachability::Stale => waiting.push(wait(
            "worker_unavailable",
            FactSource::HostReported,
            &request.worker_id,
            FactConfidence::Offline,
        )),
        Reachability::Online => {}
        _ => waiting.push(wait(
            "worker_status_unknown",
            FactSource::Unverified,
            &request.worker_id,
            FactConfidence::Unknown,
        )),
    }
    if !worker.capabilities.contains(&capability)
        || (capability == Capability::EditFile
            && !worker
                .supported_effects
                .iter()
                .any(|effect| effect_capability(effect) == Some(Capability::EditFile)))
    {
        waiting.push(wait(
            "capability_or_effect_not_supported",
            FactSource::HostReported,
            capability.as_str(),
            FactConfidence::Missing,
        ));
    }
    if let Some(requirement) = &request.hardware {
        for field in ["os", "arch"] {
            let expected = if field == "os" {
                &requirement.os
            } else {
                &requirement.arch
            };
            if let Some(expected) = expected {
                check_hardware(
                    &view,
                    &format!("hardware.{field}"),
                    Some(FactValue::Text(expected.to_ascii_lowercase())),
                    None,
                    &mut waiting,
                );
            }
        }
        if let Some(minimum) = requirement.minimum_memory_bytes {
            check_hardware(
                &view,
                "hardware.memory_bytes",
                None,
                Some(minimum),
                &mut waiting,
            );
        }
    }
    waiting.sort_by(|a, b| a.code.cmp(&b.code).then(a.resource.cmp(&b.resource)));
    waiting.dedup_by(|a, b| a.code == b.code && a.resource == b.resource);
    let target = if waiting.is_empty() {
        Some(PlacementTarget {
            node_id: identity.node_id,
            installation_id: identity.installation_id,
            worker_id: request.worker_id.clone(),
            project_binding_id: request.project_binding_id.clone(),
            root_scope: binding["root_scope"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        })
    } else {
        None
    };
    Ok(decision(target, waiting))
}
fn check_hardware(
    view: &NodeView,
    name: &str,
    expected: Option<FactValue>,
    minimum: Option<u64>,
    waiting: &mut Vec<PlacementWait>,
) {
    let fact = view.facts.iter().find(|fact| fact.resource == name);
    let matches = fact.is_some_and(|fact| match (&fact.value, &expected, minimum) {
        (Some(actual), Some(expected), _) => actual == expected,
        (Some(FactValue::Integer(actual)), None, Some(minimum)) => {
            *actual >= 0 && (*actual as u64) >= minimum
        }
        _ => false,
    });
    if matches {
        return;
    }
    let (code, confidence) = match fact.map(|fact| fact.confidence) {
        Some(FactConfidence::Available)
            if fact.is_some_and(|fact| fact.freshness == Freshness::Fresh) =>
        {
            ("hardware_incompatible", FactConfidence::Incompatible)
        }
        _ => ("hardware_requirement_unknown", FactConfidence::Unknown),
    };
    waiting.push(wait(
        code,
        fact.map_or(FactSource::Unverified, |fact| fact.source),
        name,
        confidence,
    ));
}
fn decision(selected: Option<PlacementTarget>, waiting: Vec<PlacementWait>) -> PlacementDecision {
    let existing_grant_matching_passed = !waiting.iter().any(|reason| {
        matches!(
            reason.code.as_str(),
            "existing_grant_matching_failed"
                | "grant_revoked"
                | "grant_binding_project_mismatch"
                | "grant_node_mismatch"
                | "grant_installation_mismatch"
                | "grant_worker_mismatch"
                | "grant_operation_missing"
        )
    });
    let explanation = if let Some(target) = &selected {
        format!("Exact installed identity, declared worker root, capability and existing Grant scope match {} / {} / {}.", target.node_id, target.installation_id, target.worker_id)
    } else {
        "Placement waits on the reported reasons; discovery cannot replace authorization."
            .to_owned()
    };
    PlacementDecision {
        schema: INVENTORY_SCHEMA.to_owned(),
        selected,
        waiting,
        explanation,
        existing_grant_matching_passed,
        permission_boundary: DISCOVERY_BOUNDARY.to_owned(),
    }
}

/// Minimal canonical root scope matcher for callers that already resolved a
/// host observation. It performs no filesystem scan and never grants access.
pub fn declared_roots(node: &Value) -> BTreeMap<String, String> {
    node["inventory"]["project_roots"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(id, root)| {
            let root = bounded_text(Some(root), 4096)?;
            if id.is_empty() || id.len() > 160 || root.contains('\0') {
                None
            } else {
                Some((id.clone(), root))
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Mutex, OnceLock};
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
    fn identity() -> InstallationIdentity {
        InstallationIdentity {
            node_id: "node-host".into(),
            installation_id: "install-a".into(),
        }
    }
    fn placement_request(at: DateTime<Utc>) -> PlacementRequest {
        PlacementRequest {
            project_id: "project-a".into(),
            capability: "read_summary".into(),
            worker_id: "default".into(),
            preferred_node_id: None,
            grant_id: "grant-a".into(),
            project_binding_id: "binding-a".into(),
            evaluated_at: at,
            hardware: None,
        }
    }
    fn store_with_node(
        at: DateTime<Utc>,
        status: &str,
        _supported: bool,
    ) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project-a','synthetic','/synthetic','read_only',1,?1,'{}')", [at.to_rfc3339()]).unwrap();
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node-host','install-a','','',?1,?2,?3,?4,?5,?5)", rusqlite::params![status, json!([{"ticket_kind":"read_summary","permission":"read"}]).to_string(), json!([{"worker_id":"default","status":status}]).to_string(), json!({"project_roots":{"project-a":"/synthetic"},"hardware":{"os":"macos","arch":"arm64","memory_bytes":16777216u64,"token":"must-not-leak"},"token":"must-not-leak","resources":[{"schema":"loom.inventory.v1","resource":"model.adapter","value":null,"source":"host_reported","observed_at":null,"freshness":"fresh","confidence":"unknown","location":"local_only"}]}).to_string(), at.to_rfc3339()]).unwrap();
        // Worker/Node explicitly declares read only in this fixture.
        store.conn().execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding-a','project-a','node-host','install-a','default','/synthetic','digest',?1)", [at.to_rfc3339()]).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant-a','project-a','node-host','default','install-a','[\"read\"]',1,'digest',?1,'binding-a')", [at.to_rfc3339()]).unwrap();
        (dir, store)
    }
    #[test]
    fn inventory_busy_and_stale_worker_are_not_available_even_if_gpu_is_absent() {
        let _guard = lock();
        let at = Utc::now();
        let (_dir, store) = store_with_node(at, "busy", false);
        let view = node_view(&identity(), store.list("nodes").unwrap().first(), at);
        assert_eq!(view.health, NodeHealth::Busy);
        assert!(view
            .facts
            .iter()
            .any(|fact| fact.resource == "models" && fact.confidence == FactConfidence::Unknown));
        let decision = decide_placement(&store, &placement_request(at)).unwrap();
        assert!(decision
            .waiting
            .iter()
            .any(|reason| reason.code == "node_busy" || reason.code == "worker_busy"));
        let old = (at - chrono::Duration::seconds(90)).to_rfc3339();
        store
            .conn()
            .execute("UPDATE nodes SET last_heartbeat=?1,status='online'", [old])
            .unwrap();
        let decision = decide_placement(&store, &placement_request(at)).unwrap();
        assert!(decision
            .waiting
            .iter()
            .any(|reason| reason.code == "stale_heartbeat"));
        assert_eq!(
            heartbeat_freshness(Some(&at.to_rfc3339()), at),
            Freshness::Fresh
        );
    }
    #[test]
    fn inventory_wrong_installation_is_missing_not_another_hosts_offline_state() {
        let _guard = lock();
        let at = Utc::now();
        let (_dir, store) = store_with_node(at, "online", true);
        store
            .conn()
            .execute(
                "UPDATE project_bindings SET installation_id='install-b'",
                [],
            )
            .unwrap();
        let decision = decide_placement(&store, &placement_request(at)).unwrap();
        assert!(decision
            .waiting
            .iter()
            .any(|reason| reason.code == "installation_never_registered"));
        let node = store.list("nodes").unwrap().remove(0);
        assert_eq!(
            node_view(
                &InstallationIdentity {
                    node_id: "node-host".into(),
                    installation_id: "install-b".into()
                },
                Some(&node),
                at
            )
            .presence,
            InstallationState::NeverInstalled
        );
    }
    #[test]
    fn inventory_correct_capability_root_scope_hardware_and_grant_match() {
        let _guard = lock();
        let at = Utc::now();
        let (_dir, store) = store_with_node(at, "online", true);
        let mut request = placement_request(at);
        request.hardware = Some(HardwareTarget {
            os: Some("macos".into()),
            arch: Some("arm64".into()),
            minimum_memory_bytes: Some(1024),
        });
        let decision = decide_placement(&store, &request).unwrap();
        assert!(decision.selected.is_some(), "{:?}", decision.waiting);
        assert!(decision.existing_grant_matching_passed);
        assert_eq!(decision.permission_boundary, DISCOVERY_BOUNDARY);
        store
            .conn()
            .execute(
                "UPDATE project_bindings SET root_scope='/somewhere-else'",
                [],
            )
            .unwrap();
        assert!(decide_placement(&store, &request)
            .unwrap()
            .waiting
            .iter()
            .any(|reason| reason.code == "worker_root_not_declared_exactly"));
    }
    #[test]
    fn inventory_unsupported_capability_and_hardware_mismatch_have_distinct_reasons() {
        let _guard = lock();
        let at = Utc::now();
        let (_dir, store) = store_with_node(at, "online", true);
        let mut request = placement_request(at);
        request.capability = "generate_image".into();
        assert_eq!(
            decide_placement(&store, &request).unwrap().waiting[0].confidence,
            FactConfidence::Unknown
        );
        request.capability = "read_summary".into();
        request.hardware = Some(HardwareTarget {
            os: None,
            arch: Some("x86_64".into()),
            minimum_memory_bytes: None,
        });
        assert!(decide_placement(&store, &request)
            .unwrap()
            .waiting
            .iter()
            .any(|reason| reason.code == "hardware_incompatible"));
        request.hardware = Some(HardwareTarget {
            os: None,
            arch: None,
            minimum_memory_bytes: Some(1),
        });
        store
            .conn()
            .execute(
                "UPDATE nodes SET inventory='{\"project_roots\":{\"project-a\":\"/synthetic\"}}'",
                [],
            )
            .unwrap();
        assert!(decide_placement(&store, &request)
            .unwrap()
            .waiting
            .iter()
            .any(|reason| reason.code == "hardware_requirement_unknown"));
    }
    #[test]
    fn inventory_partial_hardware_error_and_secret_are_not_hidden_or_echoed() {
        let _guard = lock();
        let at = Utc::now();
        let node = json!({"id":"node-host","installation_id":"install-a","status":"degraded","last_heartbeat":at.to_rfc3339(),"capabilities":[{"ticket_kind":"read_summary"}],"workers":[{"worker_id":"default","status":"online","capabilities":[{"ticket_kind":"read_summary"}]}],"inventory":{"hardware":{"os":"macos","arch":"arm64","memory_bytes":"probably 16GB"},"token":"must-not-leak","credentials":{"api_key":"must-not-leak"}}});
        let view = node_view(&identity(), Some(&node), at);
        assert_eq!(view.health, NodeHealth::Degraded);
        assert!(view
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.os"
                && fact.confidence == FactConfidence::Available));
        assert!(view
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.memory_bytes"
                && fact.confidence == FactConfidence::Error));
        assert!(view
            .issues
            .iter()
            .any(|issue| issue.resource == "hardware.memory_bytes"));
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("must-not-leak"));
    }
    #[test]
    fn inventory_write_requires_bounded_supported_effect() {
        let _guard = lock();
        let at = Utc::now();
        let (_dir, store) = store_with_node(at, "online", true);
        let mut request = placement_request(at);
        request.capability = "edit_file".into();
        let decision = decide_placement(&store, &request).unwrap();
        assert!(!decision.existing_grant_matching_passed);
        assert!(decision
            .waiting
            .iter()
            .any(|reason| reason.code == "grant_operation_missing"));
    }
}
