//! Versioned operator plans over explicit synthetic Inventory. This module never
//! contacts, installs, discovers or grants authority to a physical Host.
use crate::store::Store;
use anyhow::{bail, Context, Result};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const SCHEMA: &str = "loom.install-plan.v1";
const DIGEST: &str = "1c9dc260a2d689602a6e133b9017561d9b69c30136834e08f51aaa05de3542c5";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    schema: String,
    source: String,
    component: Component,
    targets: Vec<InventoryTarget>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct Component {
    kind: String,
    version: String,
    sha256: String,
    source: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct InventoryTarget {
    host_key: String,
    os: String,
    arch: String,
    baseline_version: String,
    requested_version: String,
    #[serde(default)]
    selected: bool,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApproveInput {
    target_id: String,
    reviewed_plan_digest: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RollbackInput {
    target_id: String,
    operation_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObserveInput {
    target_id: String,
    operation: String,
    outcome: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Observation {
    operation_id: String,
    operation: String,
    outcome: String,
    reported_at: String,
    report_kind: String,
    simulated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Target {
    id: String,
    host_key: String,
    os: String,
    arch: String,
    baseline_version: String,
    requested_version: String,
    selected: bool,
    status: String,
    current_version: String,
    current_operation_id: Option<String>,
    rollback_parent_operation_id: Option<String>,
    approved_at: Option<String>,
    observations: Vec<Observation>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plan {
    id: String,
    schema: String,
    version: u64,
    plan_digest: String,
    proof_kind: String,
    source: String,
    component: Component,
    authorization_revision: String,
    host_execution: bool,
    created_at: String,
    updated_at: String,
    targets: Vec<Target>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}
fn version(value: &str) -> bool {
    let fields: Vec<_> = value.split('.').collect();
    fields.len() == 3
        && fields.iter().all(|part| {
            !part.is_empty() && part.len() <= 2 && part.bytes().all(|b| b.is_ascii_digit())
        })
}
fn simulated_enabled() -> bool {
    std::env::var("LOOM_INSTALL_SIMULATION").ok().as_deref() == Some("synthetic_inventory")
}
fn policy() -> Value {
    json!({"simulation_only":true,"fixture_reporting":simulated_enabled(),"remote_execution":false,"proof_kind":"synthetic_plan_only"})
}
fn save(
    store: &Store,
    plan: &Plan,
    action: &str,
    target: Option<&str>,
    operation: Option<&str>,
) -> Result<()> {
    let tx = store.conn().unchecked_transaction()?;
    tx.execute("INSERT INTO install_plans(id,plan_json,created_at,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET plan_json=excluded.plan_json,updated_at=excluded.updated_at", params![plan.id,serde_json::to_string(plan)?,plan.created_at,plan.updated_at])?;
    for target_row in &plan.targets {
        tx.execute("INSERT INTO install_targets(plan_id,target_id,target_json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(plan_id,target_id) DO UPDATE SET target_json=excluded.target_json,updated_at=excluded.updated_at", params![plan.id,target_row.id,serde_json::to_string(target_row)?,plan.updated_at])?;
    }
    crate::store::audit_tx_plan(
        &tx,
        "admin_client",
        action,
        &json!({"plan_id":plan.id,"plan_digest":plan.plan_digest,"target_id":target,"operation_id":operation,"proof_kind":"synthetic_plan_only","host_execution":false}),
    )?;
    tx.commit()?;
    Ok(())
}
fn save_with_parent(
    store: &Store,
    plan: &Plan,
    action: &str,
    target_id: &str,
    operation_id: &str,
    parent_operation_id: &str,
) -> Result<()> {
    let tx = store.conn().unchecked_transaction()?;
    tx.execute(
        "UPDATE install_plans SET plan_json=?2,updated_at=?3 WHERE id=?1",
        params![plan.id, serde_json::to_string(plan)?, plan.updated_at],
    )?;
    for target in &plan.targets {
        tx.execute("UPDATE install_targets SET target_json=?3,updated_at=?4 WHERE plan_id=?1 AND target_id=?2", params![plan.id,target.id,serde_json::to_string(target)?,plan.updated_at])?;
    }
    crate::store::audit_tx_plan(
        &tx,
        "admin_client",
        action,
        &json!({"plan_id":plan.id,"plan_digest":plan.plan_digest,"target_id":target_id,"operation_id":operation_id,"parent_operation_id":parent_operation_id,"reviewed_apply_operation_id":parent_operation_id,"proof_kind":"synthetic_plan_only","host_execution":false}),
    )?;
    tx.commit()?;
    Ok(())
}
fn load(store: &Store, id: &str) -> Result<Plan> {
    let row = store
        .query("SELECT plan_json FROM install_plans WHERE id=?1", [id])?
        .into_iter()
        .next()
        .context("Install plan not found")?;
    let mut plan: Plan = serde_json::from_str(
        row["plan_json"]
            .as_str()
            .context("Stored install plan JSON is missing")?,
    )?;
    plan.targets = store
        .query(
            "SELECT target_json FROM install_targets WHERE plan_id=?1 ORDER BY target_id",
            [id],
        )?
        .iter()
        .map(|row| {
            serde_json::from_str(row["target_json"].as_str().unwrap_or("{}"))
                .context("Stored target JSON is invalid")
        })
        .collect::<Result<_>>()?;
    Ok(plan)
}
pub fn create(store: &Store, input: CreateInput) -> Result<Value> {
    if input.schema != SCHEMA || input.source != "explicit_admin_inventory_manifest" {
        bail!("The exact versioned synthetic Inventory source is required")
    }
    if input.component.kind != "bare_host"
        || input.component.version != "0.1.0"
        || input.component.sha256 != DIGEST
        || input.component.source != "local_package_candidate"
    {
        bail!("Only the immutable current local Bare package candidate is admitted")
    }
    if input.targets.is_empty() || input.targets.len() > 4 {
        bail!("One through four explicit Inventory targets are required")
    }
    let at = crate::now();
    let id = crate::id("plan");
    let mut seen = BTreeSet::new();
    let mut targets = Vec::with_capacity(input.targets.len());
    for (ordinal, target) in input.targets.into_iter().enumerate() {
        if !identifier(&target.host_key) || !target.host_key.starts_with("fixture-") {
            bail!("Targets must be explicit fixture-local Inventory entries")
        }
        if !seen.insert(target.host_key.clone()) {
            bail!("Duplicate Inventory host_key")
        }
        if !version(&target.requested_version) || !version(&target.baseline_version) {
            bail!("Versions must be three bounded numeric components")
        }
        if target.os.is_empty()
            || target.arch.is_empty()
            || target.os.len() > 32
            || target.arch.len() > 32
        {
            bail!("Inventory OS and architecture must be bounded")
        }
        let exact = target.requested_version == input.component.version;
        let compatible = target.os == "darwin" && target.arch == "arm64";
        let status = if !target.selected {
            "not_selected"
        } else if !exact || !compatible {
            "incompatible"
        } else {
            "pending_approval"
        };
        targets.push(Target {
            id: format!("{id}-target-{ordinal}"),
            host_key: target.host_key,
            os: target.os,
            arch: target.arch,
            baseline_version: target.baseline_version.clone(),
            requested_version: target.requested_version,
            selected: target.selected,
            status: status.into(),
            current_version: target.baseline_version,
            current_operation_id: None,
            rollback_parent_operation_id: None,
            approved_at: None,
            observations: vec![],
        });
    }
    let plan_digest = crate::sha256(serde_json::to_vec(
        &json!({"schema":SCHEMA,"source":input.source,"component":input.component,"targets":targets}),
    )?);
    let plan = Plan {
        id,
        schema: SCHEMA.into(),
        version: 1,
        plan_digest,
        proof_kind: "synthetic_plan_only".into(),
        source: input.source,
        component: input.component,
        authorization_revision: "admin_plan_review_not_execution_grant".into(),
        host_execution: false,
        created_at: at.clone(),
        updated_at: at,
        targets,
    };
    save(store, &plan, "install_plan.created", None, None)?;
    Ok(json!({"plan":plan,"policy":policy()}))
}
pub fn list(store: &Store) -> Result<Value> {
    let ids: Vec<String> = store
        .query(
            "SELECT id FROM install_plans ORDER BY created_at DESC LIMIT 32",
            [],
        )?
        .iter()
        .filter_map(|row| row["id"].as_str().map(ToOwned::to_owned))
        .collect();
    let plans = ids
        .iter()
        .map(|id| load(store, id))
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"plans":plans,"policy":policy()}))
}
pub fn detail(store: &Store, id: &str) -> Result<Value> {
    Ok(json!({"plan":load(store,id)?,"policy":policy()}))
}
fn target<'a>(plan: &'a mut Plan, id: &str) -> Result<&'a mut Target> {
    plan.targets
        .iter_mut()
        .find(|target| target.id == id)
        .context("Install target not found")
}
pub fn approve(store: &Store, id: &str, input: ApproveInput) -> Result<Value> {
    let mut plan = load(store, id)?;
    if input.reviewed_plan_digest != plan.plan_digest {
        bail!("Approval does not match the immutable source manifest")
    }
    let component_version = plan.component.version.clone();
    let target = target(&mut plan, &input.target_id)?;
    if target.status != "pending_approval"
        || !target.selected
        || target.requested_version != component_version
        || target.os != "darwin"
        || target.arch != "arm64"
    {
        bail!("Only the selected compatible pending Inventory target can be approved")
    }
    let operation_id = crate::id("installop");
    target.current_operation_id = Some(operation_id.clone());
    target.rollback_parent_operation_id = None;
    target.approved_at = Some(crate::now());
    target.status = "approved".into();
    plan.updated_at = crate::now();
    save(
        store,
        &plan,
        "install_plan.target_approved",
        Some(&input.target_id),
        Some(&operation_id),
    )?;
    Ok(json!({"plan":plan,"policy":policy()}))
}
pub fn rollback_approve(store: &Store, id: &str, input: RollbackInput) -> Result<Value> {
    let mut plan = load(store, id)?;
    let target = target(&mut plan, &input.target_id)?;
    if !matches!(target.status.as_str(), "healthy_observed" | "health_failed")
        || target.current_operation_id.as_deref() != Some(input.operation_id.as_str())
        || !target.observations.last().is_some_and(|observation| {
            observation.operation_id == input.operation_id && observation.operation == "apply"
        })
    {
        bail!("Rollback requires a healthy or health-failed prior apply and its exact operation")
    }
    let operation_id = crate::id("installop");
    target.current_operation_id = Some(operation_id.clone());
    target.rollback_parent_operation_id = Some(input.operation_id.clone());
    target.status = "rollback_approved".into();
    target.approved_at = Some(crate::now());
    plan.updated_at = crate::now();
    save_with_parent(
        store,
        &plan,
        "install_plan.rollback_approved",
        &input.target_id,
        &operation_id,
        &input.operation_id,
    )?;
    Ok(json!({"plan":plan,"policy":policy()}))
}
pub fn observe(store: &Store, id: &str, input: ObserveInput) -> Result<Value> {
    if !simulated_enabled() {
        bail!("Fixture observation is disabled; actual Host execution is not implemented")
    }
    let mut plan = load(store, id)?;
    let target = target(&mut plan, &input.target_id)?;
    let current_operation = target
        .current_operation_id
        .as_ref()
        .context("Approved operation not found")?
        .clone();
    let required_status = match input.operation.as_str() {
        "apply" => "approved",
        "rollback" => "rollback_approved",
        _ => bail!("Only the controlled apply or rollback operation is supported"),
    };
    if target
        .observations
        .iter()
        .any(|observation| observation.operation_id == current_operation)
    {
        if target.status == "unknown"
            && target.observations.last().is_some_and(|observation| {
                observation.operation_id == current_operation
                    && observation.operation == input.operation
                    && observation.outcome == input.outcome
            })
        {
            // A repeated Unknown observation is a read-only receipt, never a retry.
            return Ok(
                json!({"plan":plan,"duplicate":true,"report":{"simulated":true,"host_execution":false},"policy":policy()}),
            );
        }
        bail!("An already-observed operation cannot be reclassified or blindly retried")
    }
    if target.status != required_status {
        bail!("Observation does not match the current approved operation")
    }
    if input.outcome == "connection_lost" {
        target.status = "unknown".into();
    } else if input.operation == "apply" && input.outcome == "healthy" {
        target.current_version = target.requested_version.clone();
        target.status = "healthy_observed".into();
    } else if input.operation == "apply" && input.outcome == "health_failed" {
        target.status = "health_failed".into();
    } else if input.operation == "rollback" && input.outcome == "healthy" {
        target.current_version = target.baseline_version.clone();
        target.status = "rolled_back_observed".into();
    } else {
        bail!("Unsupported operation/outcome combination")
    }
    target.observations.push(Observation {
        operation_id: current_operation.clone(),
        operation: input.operation.clone(),
        outcome: input.outcome.clone(),
        reported_at: crate::now(),
        report_kind: "manual_synthetic_inventory_report".into(),
        simulated: true,
    });
    plan.updated_at = crate::now();
    save(
        store,
        &plan,
        "install_plan.fixture_observed",
        Some(&input.target_id),
        Some(&current_operation),
    )?;
    Ok(
        json!({"plan":plan,"report":{"simulated":true,"host_execution":false,"outcome":input.outcome,"source":"manual_synthetic_inventory_report"},"policy":policy()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    static ENVIRONMENT: std::sync::Mutex<()> = std::sync::Mutex::new(());
    struct Simulation;
    impl Simulation {
        fn on() -> Self {
            std::env::set_var("LOOM_INSTALL_SIMULATION", "synthetic_inventory");
            Self
        }
    }
    impl Drop for Simulation {
        fn drop(&mut self) {
            std::env::remove_var("LOOM_INSTALL_SIMULATION");
        }
    }
    fn create_input(id: &str) -> Value {
        json!({"schema":SCHEMA,"source":"explicit_admin_inventory_manifest","component":{"kind":"bare_host","version":"0.1.0","sha256":DIGEST,"source":"local_package_candidate"},"targets":[
            {"host_key":format!("fixture-{id}"),"os":"darwin","arch":"arm64","baseline_version":"0.0.0","requested_version":"0.1.0","selected":true},
            {"host_key":"fixture-not-selected","os":"darwin","arch":"arm64","baseline_version":"0.0.0","requested_version":"0.1.0","selected":false},
            {"host_key":"fixture-linux","os":"linux","arch":"arm64","baseline_version":"0.0.0","requested_version":"0.1.0","selected":true}]})
    }
    fn add(store: &Store, name: &str) -> Plan {
        let response = create(store, serde_json::from_value(create_input(name)).unwrap()).unwrap();
        serde_json::from_value(response["plan"].clone()).unwrap()
    }
    #[test]
    fn plan_is_not_task_authority_and_survives_reopen() {
        let _guard = ENVIRONMENT.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let plan = add(&store, "success");
        assert!(store.query("SELECT * FROM grants", []).unwrap().is_empty());
        assert!(store.query("SELECT * FROM tickets", []).unwrap().is_empty());
        let approved = approve(
            &store,
            &plan.id,
            ApproveInput {
                target_id: plan.targets[0].id.clone(),
                reviewed_plan_digest: plan.plan_digest.clone(),
            },
        )
        .unwrap();
        let operation_id = approved["plan"]["targets"][0]["current_operation_id"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(rollback_approve(
            &store,
            &plan.id,
            RollbackInput {
                target_id: plan.targets[0].id.clone(),
                operation_id: operation_id.clone()
            }
        )
        .is_err());
        let _simulation = Simulation::on();
        assert_eq!(
            observe(
                &store,
                &plan.id,
                ObserveInput {
                    target_id: plan.targets[0].id.clone(),
                    operation: "apply".into(),
                    outcome: "healthy".into()
                }
            )
            .unwrap()["plan"]["targets"][0]["current_version"],
            "0.1.0"
        );
        let rollback = rollback_approve(
            &store,
            &plan.id,
            RollbackInput {
                target_id: plan.targets[0].id.clone(),
                operation_id,
            },
        )
        .unwrap();
        assert_eq!(
            rollback["plan"]["targets"][0]["status"],
            "rollback_approved"
        );
        assert_eq!(
            observe(
                &store,
                &plan.id,
                ObserveInput {
                    target_id: plan.targets[0].id.clone(),
                    operation: "rollback".into(),
                    outcome: "healthy".into()
                }
            )
            .unwrap()["plan"]["targets"][0]["current_version"],
            "0.0.0"
        );
        drop(store);
        let reopened = Store::open(directory.path()).unwrap();
        assert_eq!(
            load(&reopened, &plan.id).unwrap().targets[0].current_version,
            "0.0.0"
        );
        assert!(reopened.verify_audit().unwrap());
        drop(_simulation);
    }
    #[test]
    fn unknown_is_terminal_and_identical_receipt_is_read_only() {
        let _guard = ENVIRONMENT.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let plan = add(&store, "unknown");
        approve(
            &store,
            &plan.id,
            ApproveInput {
                target_id: plan.targets[0].id.clone(),
                reviewed_plan_digest: plan.plan_digest.clone(),
            },
        )
        .unwrap();
        let _simulation = Simulation::on();
        let first = observe(
            &store,
            &plan.id,
            ObserveInput {
                target_id: plan.targets[0].id.clone(),
                operation: "apply".into(),
                outcome: "connection_lost".into(),
            },
        )
        .unwrap();
        assert_eq!(first["plan"]["targets"][0]["status"], "unknown");
        let audits = store.query("SELECT * FROM audits", []).unwrap().len();
        assert_eq!(
            observe(
                &store,
                &plan.id,
                ObserveInput {
                    target_id: plan.targets[0].id.clone(),
                    operation: "apply".into(),
                    outcome: "connection_lost".into()
                }
            )
            .unwrap()["duplicate"],
            true
        );
        assert_eq!(
            audits,
            store.query("SELECT * FROM audits", []).unwrap().len()
        );
        assert!(observe(
            &store,
            &plan.id,
            ObserveInput {
                target_id: plan.targets[0].id.clone(),
                operation: "apply".into(),
                outcome: "healthy".into()
            }
        )
        .is_err());
        assert_eq!(load(&store, &plan.id).unwrap().targets[0].status, "unknown");
        drop(_simulation);
    }
    #[test]
    fn v6_records_upgrade_through_v7_then_v8_then_v9_then_v10_then_v11_then_v12() {
        let directory = tempfile::tempdir().unwrap();
        let raw = rusqlite::Connection::open(directory.path().join("loom.sqlite3")).unwrap();
        raw.execute_batch("PRAGMA user_version=6;CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,inventory TEXT NOT NULL);CREATE TABLE grants(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,node_id TEXT NOT NULL,worker_id TEXT NOT NULL,installation_id TEXT NOT NULL,operations TEXT NOT NULL,version INTEGER NOT NULL,digest TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE tickets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,objective TEXT NOT NULL,kind TEXT NOT NULL,relative_path TEXT NOT NULL,content TEXT,status TEXT NOT NULL,grant_id TEXT NOT NULL,grant_digest TEXT NOT NULL,node_id TEXT NOT NULL,installation_id TEXT NOT NULL,worker_id TEXT NOT NULL,attempt INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE assignments(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,node_id TEXT NOT NULL,worker_id TEXT NOT NULL,attempt INTEGER NOT NULL,lease_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE artifacts(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,assignment_id TEXT NOT NULL,origin_node_id TEXT NOT NULL,name TEXT NOT NULL,media_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,storage_name TEXT NOT NULL,location TEXT NOT NULL,lineage TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE reports(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,ticket_id TEXT NOT NULL,node_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,evidence TEXT NOT NULL,session_ref TEXT,cancel_acknowledged INTEGER NOT NULL,created_at TEXT NOT NULL);CREATE TABLE candidates(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,content TEXT NOT NULL,source_refs TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);INSERT INTO projects VALUES('old','old','/fixture','read_only',1,'2026-01-01T00:00:00Z','{}');INSERT INTO grants VALUES('old-grant','old','node','default','installation','[\"read\"]',1,'digest','2026-01-01T00:00:00Z');INSERT INTO tickets VALUES('old-ticket','old','objective','read_summary','README.md',NULL,'succeeded','old-grant','digest','node','installation','default',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');INSERT INTO assignments VALUES('old-assignment','old-ticket','node','default',1,'old-lease',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');INSERT INTO reports VALUES('old-report','old-assignment','old-ticket','node',1,'request','succeeded','summary','[]',NULL,0,'2026-01-01T00:00:00Z');INSERT INTO artifacts VALUES('00000000-0000-4000-8000-000000000015','old-ticket','old-assignment','node','summary.json','application/json',1,'sha','00000000-0000-4000-8000-000000000015.artifact','loom://artifact/00000000-0000-4000-8000-000000000015','[]','2026-01-01T00:00:00Z');INSERT INTO candidates VALUES('legacy-skill','skill','p','{}','[]','pending',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');").unwrap();
        drop(raw);
        let store = Store::open(directory.path()).unwrap();
        let schema: i64 = store
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(schema, 12);
        assert_eq!(
            store
                .query("SELECT * FROM skill_replays", [])
                .unwrap()
                .len(),
            0
        );
        assert_eq!(store.query("SELECT * FROM skills", []).unwrap().len(), 0);
        assert_eq!(
            store.get("grants", "old-grant").unwrap().unwrap()["digest"],
            "digest"
        );
        assert_eq!(
            store
                .get("artifacts", "00000000-0000-4000-8000-000000000015")
                .unwrap()
                .unwrap()["sha256"],
            "sha"
        );
    }
    #[test]
    fn v7_legacy_grant_and_skill_survive_schema_twelve() {
        let directory = tempfile::tempdir().unwrap();
        {
            let store = Store::open(directory.path()).unwrap();
            store
                .conn()
                .execute_batch(
                    "DROP TABLE install_targets;DROP TABLE install_plans;PRAGMA user_version=6;",
                )
                .unwrap();
            let migrated = Store::open(directory.path()).unwrap();
            migrated
                .conn()
                .execute_batch(
                    "DROP TABLE install_targets;DROP TABLE install_plans;PRAGMA user_version=7;",
                )
                .unwrap();
            drop(migrated);
            let store = Store::open(directory.path()).unwrap();
            store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('legacy-project','legacy','/fixture','read_only',1,'2026-01-01T00:00:00Z','{}')", []).unwrap();
            store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('legacy-grant','legacy-project','legacy-node','default','legacy-installation','[\"read\"]',1,'original-digest','2026-01-01T00:00:00Z')", []).unwrap();
            store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES('legacy-skill','skill','legacy-project','{}','[]','pending',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", []).unwrap();
        }
        let store = Store::open(directory.path()).unwrap();
        let schema: i64 = store
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(schema, 12);
        assert_eq!(
            store.get("grants", "legacy-grant").unwrap().unwrap()["digest"],
            "original-digest"
        );
        assert_eq!(
            store.get("candidates", "legacy-skill").unwrap().unwrap()["status"],
            "pending"
        );
        assert!(store
            .query("SELECT * FROM install_plans", [])
            .unwrap()
            .is_empty());
    }
    #[test]
    fn unknown_fields_duplicates_and_bad_scope_create_no_plan() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        assert!(serde_json::from_value::<CreateInput>(json!({"schema":SCHEMA,"source":"explicit_admin_inventory_manifest","component":{"kind":"bare_host","version":"0.1.0","sha256":DIGEST,"source":"local_package_candidate"},"targets":[],"ssh_private_key":"do-not-copy"})).is_err());
        assert!(create(
            &store,
            serde_json::from_value(create_input("bad"))
                .map(|mut input: CreateInput| {
                    input.component.version = "0.2.0".into();
                    input
                })
                .unwrap()
        )
        .is_err());
        let mut duplicate = create_input("duplicate");
        duplicate["targets"][1] = duplicate["targets"][0].clone();
        assert!(create(&store, serde_json::from_value(duplicate).unwrap()).is_err());
        let mut wrong = create_input("wrong");
        wrong["targets"][0]["host_key"] = json!("actual-host");
        assert!(create(&store, serde_json::from_value(wrong).unwrap()).is_err());
        assert!(store
            .query("SELECT * FROM install_plans", [])
            .unwrap()
            .is_empty());
    }
    #[test]
    fn disabled_simulation_cannot_report_a_live_result() {
        let _guard = ENVIRONMENT.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path()).unwrap();
        let plan = add(&store, "disabled");
        approve(
            &store,
            &plan.id,
            ApproveInput {
                target_id: plan.targets[0].id.clone(),
                reviewed_plan_digest: plan.plan_digest,
            },
        )
        .unwrap();
        std::env::remove_var("LOOM_INSTALL_SIMULATION");
        assert!(observe(
            &store,
            &plan.id,
            ObserveInput {
                target_id: plan.targets[0].id.clone(),
                operation: "apply".into(),
                outcome: "healthy".into()
            }
        )
        .is_err());
    }
}
