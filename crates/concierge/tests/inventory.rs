use chrono::{Duration, Utc};
use loom_concierge::inventory::{
    never_installed, node_view, FactConfidence, Freshness, InstallationIdentity, NodeHealth,
    INVENTORY_SCHEMA,
};
use serde_json::json;

fn observed(at: chrono::DateTime<Utc>, hardware: serde_json::Value) -> serde_json::Value {
    json!({
        "id": "node-a", "installation_id": "installation-a", "status": "online",
        "last_heartbeat": at.to_rfc3339(), "capabilities": [],
        "workers": [{"worker_id": "default", "status": "online", "capabilities": [{"ticket_kind":"read_summary"}]}],
        "inventory": {"hardware": hardware}
    })
}
#[test]
fn inventory_public_snapshot_preserves_missing_heartbeat_staleness_and_unknown_models() {
    let at = Utc::now();
    let identity = InstallationIdentity {
        node_id: "node-a".into(),
        installation_id: "installation-a".into(),
    };
    let fresh = observed(at, json!({"os": "macos"}));
    let view = node_view(&identity, Some(&fresh), at);
    assert_eq!(view.freshness, Freshness::Fresh);
    assert!(
        view.facts
            .iter()
            .any(|fact| fact.resource == "hardware.arch"
                && fact.confidence == FactConfidence::Unknown)
    );
    assert!(view
        .facts
        .iter()
        .any(|fact| fact.resource == "models" && fact.confidence == FactConfidence::Unknown));
    assert_eq!(view.health, NodeHealth::Available);
    let stale = observed(at - Duration::seconds(90), json!({}));
    let stale = node_view(&identity, Some(&stale), at);
    assert_eq!(stale.freshness, Freshness::Stale);
    assert!(stale
        .facts
        .iter()
        .filter(|fact| fact.resource.starts_with("hardware."))
        .all(|fact| fact.freshness == Freshness::Stale));
    let mut missing = fresh.clone();
    missing["last_heartbeat"] = json!(null);
    let missing = node_view(&identity, Some(&missing), at);
    assert_eq!(missing.freshness, Freshness::Unknown);
    assert_eq!(
        missing.reachability,
        loom_concierge::inventory::Reachability::Unknown
    );
}
#[test]
fn inventory_unregistered_installation_has_explicit_semantics_and_no_authority() {
    let _unused = Utc::now();
    let view = never_installed(InstallationIdentity {
        node_id: "not-registered".into(),
        installation_id: "missing".into(),
    });
    assert_eq!(
        view.presence,
        loom_concierge::inventory::InstallationState::NeverInstalled
    );
    assert_eq!(view.health, NodeHealth::Missing);
    assert!(!view.permission_boundary.is_empty());
    assert_eq!(view.schema, INVENTORY_SCHEMA);
}
