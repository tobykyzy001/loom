//! Explicit, small read-only inventory probes. This module does not discover
//! projects, enumerate directories, scan for credentials, or invoke a model.
use crate::inventory::{
    FactConfidence, FactSource, FactValue, Freshness, InventoryIssue, ResourceFact,
    INVENTORY_SCHEMA,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, process::Command};

pub const LOCAL_HARDWARE_ENV: &str = "LOOM_ENABLE_LOCAL_HARDWARE_PROBE";
const MAX_PROBE_BYTES: u64 = 64 * 1024;
const MAX_PROJECT_ROOT_BYTES: u64 = 33312;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectForm {
    WorkingTree,
    Documents,
    GeneratedWorkspace,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialLocation {
    HostCredentialStore,
    NodeCredentialBroker,
    None,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectProbeInput {
    pub host_id: String,
    pub root: PathBuf,
    pub form: ProjectForm,
    pub canonical_remote: Option<String>,
    /// Revision and dirty state are supplied by a trusted host or the existing
    /// controller probe; this module does not run Git or inspect file content.
    pub revision: Option<String>,
    pub dirty: Option<bool>,
    pub credential_location: Option<CredentialLocation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectProbe {
    pub host_id: String,
    pub root: String,
    pub form: ProjectForm,
    pub canonical_remote: Option<String>,
    pub revision: Option<String>,
    pub dirty: Option<bool>,
    /// This is a typed storage-class reference, never credential contents.
    pub credential_location: String,
    pub permission_granted: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalHardwareInspector {
    Uname,
    MacSystemProfiler,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalProbeRequest {
    pub host_id: String,
    pub inspector: LocalHardwareInspector,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeReport {
    pub schema: String,
    pub host_id: String,
    pub source: FactSource,
    pub probed_at: DateTime<Utc>,
    pub inspector: Option<String>,
    pub facts: Vec<ResourceFact>,
    /// Probe failures remain public summaries but never raw process stderr.
    pub issues: Vec<InventoryIssue>,
    pub permission_granted: bool,
}
fn fact(
    resource: &str,
    value: Option<FactValue>,
    confidence: FactConfidence,
    observed_at: DateTime<Utc>,
    source: FactSource,
) -> ResourceFact {
    ResourceFact {
        schema: INVENTORY_SCHEMA.to_owned(),
        resource: resource.to_owned(),
        value,
        source,
        observed_at: Some(observed_at),
        freshness: Freshness::Fresh,
        confidence,
        location: crate::inventory::LocationPolicy::LocalOnly,
    }
}
fn issue(resource: &str, code: &str, confidence: FactConfidence) -> InventoryIssue {
    InventoryIssue {
        code: code.to_owned(),
        resource: resource.to_owned(),
        confidence,
    }
}
fn bounded(value: Option<&str>, max: usize) -> Option<String> {
    value
        .filter(|value| {
            !value.is_empty() && value.len() <= max && value.chars().all(|c| !c.is_control())
        })
        .map(str::to_owned)
}
fn valid_selector(selector: &str) -> bool {
    !selector.is_empty()
        && selector.len() <= 80
        && selector
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}
/// Typed value parser for bounded host/service/runtime observations. Callers
/// serialize explicitly selected observations; arbitrary JSON is ignored.
pub fn normalize_host_facts(
    selector: &str,
    encoded: &str,
    observed_at: DateTime<Utc>,
    source: FactSource,
) -> ProbeReport {
    let mut report = ProbeReport {
        schema: INVENTORY_SCHEMA.to_owned(),
        host_id: selector.to_owned(),
        source,
        probed_at: observed_at,
        inspector: None,
        facts: Vec::new(),
        issues: Vec::new(),
        permission_granted: false,
    };
    if !valid_selector(selector) || encoded.len() > MAX_PROBE_BYTES as usize {
        report
            .issues
            .push(issue("host", "invalid_probe_input", FactConfidence::Error));
        return report;
    }
    let values = match serde_json::from_str::<Value>(encoded) {
        Ok(Value::Array(values)) => values,
        _ => {
            report.issues.push(issue(
                "reported_resources",
                "malformed_observation",
                FactConfidence::Error,
            ));
            return report;
        }
    };
    let values = values
        .into_iter()
        .filter_map(
            |value| match serde_json::from_value::<ResourceFact>(value) {
                Ok(fact) => Some(fact),
                Err(_) => {
                    report.issues.push(issue(
                        "reported_resources",
                        "malformed_observation",
                        FactConfidence::Error,
                    ));
                    None
                }
            },
        )
        .collect::<Vec<_>>();
    let (facts, issues) = crate::inventory::normalize_reported_facts(&values, Freshness::Fresh);
    report.facts = facts
        .into_iter()
        .map(|mut fact| {
            // A caller-provided timestamp does not impersonate a controller probe.
            fact.observed_at = Some(observed_at);
            fact.source = source;
            fact
        })
        .collect();
    report.issues = issues;
    report
}
/// Normalize one explicitly identified local root, with its Git state kept
/// separate from its form and credential-storage class.
pub fn probe_project(input: &ProjectProbeInput) -> std::io::Result<ProjectProbe> {
    if !valid_selector(&input.host_id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "host id is not valid",
        ));
    }
    if input.root.as_os_str().len() > MAX_PROJECT_ROOT_BYTES as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "project root is too long",
        ));
    }
    // Only canonicalize this named existing path; no parent/child enumeration.
    let canonical = fs::canonicalize(&input.root)?;
    if !canonical.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "project root is not a directory",
        ));
    }
    let revision = bounded(input.revision.as_deref(), 128)
        .filter(|value| value.len() >= 7 && value.chars().all(|c| c.is_ascii_hexdigit()));
    let remote = bounded(input.canonical_remote.as_deref(), 512)
        .filter(|value| !value.contains(char::is_whitespace) && !value.contains('@') && !matches!(value, value if value.to_ascii_lowercase().contains("token=") || value.to_ascii_lowercase().contains("password=")));
    Ok(ProjectProbe {
        host_id: input.host_id.clone(),
        root: canonical.to_string_lossy().into_owned(),
        form: input.form,
        canonical_remote: remote,
        revision,
        dirty: input.dirty,
        credential_location: match input.credential_location {
            Some(CredentialLocation::HostCredentialStore) => "host_credential_store",
            Some(CredentialLocation::NodeCredentialBroker) => "node_credential_broker",
            Some(CredentialLocation::None) => "none",
            None => "not_provided",
        }
        .to_owned(),
        permission_granted: false,
    })
}

/// On this host explicit `uname` supplies OS/arch. macOS can additionally use
/// only system_profiler SP {Hardware,Displays}DataType; Linux/Windows hardware
/// adapters are not claimed here. Opt-in is checked on every call.
pub fn probe_local_hardware(
    request: &LocalProbeRequest,
    observed_at: DateTime<Utc>,
) -> ProbeReport {
    let mut report = ProbeReport {
        schema: INVENTORY_SCHEMA.to_owned(),
        host_id: request.host_id.clone(),
        source: FactSource::ControllerProbed,
        probed_at: observed_at,
        inspector: Some(
            match request.inspector {
                LocalHardwareInspector::Uname => "uname",
                LocalHardwareInspector::MacSystemProfiler => "system_profiler",
            }
            .to_owned(),
        ),
        facts: Vec::new(),
        issues: Vec::new(),
        permission_granted: false,
    };
    if !valid_selector(&request.host_id) {
        report
            .issues
            .push(issue("host", "invalid_host_id", FactConfidence::Error));
        return report;
    }
    if std::env::var_os(LOCAL_HARDWARE_ENV).is_none_or(|value| value != "1") {
        report.issues.push(issue(
            "hardware",
            "local_probe_disabled",
            FactConfidence::Denied,
        ));
        return report;
    }
    if request.inspector == LocalHardwareInspector::MacSystemProfiler
        && std::env::consts::OS != "macos"
    {
        report.issues.push(issue(
            "hardware",
            "mac_probe_unavailable_on_this_platform",
            FactConfidence::Incompatible,
        ));
        return report;
    }
    let command_name = match request.inspector {
        LocalHardwareInspector::Uname => "uname",
        LocalHardwareInspector::MacSystemProfiler => "system_profiler",
    };
    let args: &[&str] = match request.inspector {
        LocalHardwareInspector::Uname => &["-sm"],
        LocalHardwareInspector::MacSystemProfiler => &["SPHardwareDataType", "SPDisplaysDataType"],
    };
    let mut command = Command::new(command_name);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .env_clear();
    command
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C");
    #[cfg(unix)]
    {
        command.env("HOME", "/var/empty");
    }
    let output = command.output();
    match output {
        Err(_) => report
            .issues
            .push(issue("hardware", "inspector_failed", FactConfidence::Error)),
        Ok(output)
            if output.status.code() != Some(0)
                || output.stdout.len() > MAX_PROBE_BYTES as usize =>
        {
            report.issues.push(issue(
                "hardware",
                if output.stdout.len() > MAX_PROBE_BYTES as usize {
                    "inspector_output_too_large"
                } else {
                    "inspector_failed"
                },
                FactConfidence::Error,
            ));
        }
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            match request.inspector {
                LocalHardwareInspector::Uname => {
                    // macOS: `Darwin arm64`; Linux: `Linux x86_64`.
                    let fields = text.split_whitespace().collect::<Vec<_>>();
                    if fields.len() != 2
                        || fields.iter().any(|field| {
                            field.len() > 64
                                || !field.chars().all(|c| {
                                    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')
                                })
                        })
                    {
                        report.issues.push(issue(
                            "hardware",
                            "unexpected_uname_output",
                            FactConfidence::Error,
                        ));
                    } else {
                        let os = match fields[0] {
                            "Darwin" => "macos",
                            "Linux" => "linux",
                            other => other,
                        };
                        report.facts.push(fact(
                            "hardware.os",
                            Some(FactValue::Text(os.to_owned())),
                            FactConfidence::Available,
                            observed_at,
                            FactSource::ControllerProbed,
                        ));
                        report.facts.push(fact(
                            "hardware.arch",
                            Some(FactValue::Text(fields[1].to_owned())),
                            FactConfidence::Available,
                            observed_at,
                            FactSource::ControllerProbed,
                        ));
                    }
                }
                LocalHardwareInspector::MacSystemProfiler => {
                    parse_mac_system_profiler(&text, observed_at, &mut report)
                }
            }
        }
    }
    report
}
fn memory_bytes(value: &str) -> Option<u64> {
    let mut parts = value.split_whitespace();
    let amount = parts.next()?.parse::<u64>().ok()?;
    let unit = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    amount.checked_mul(match unit {
        "GB" => 1_000_000_000,
        "MB" => 1_000_000,
        "TB" => 1_000_000_000_000,
        _ => return None,
    })
}
fn parse_mac_system_profiler(text: &str, observed_at: DateTime<Utc>, report: &mut ProbeReport) {
    let mut invalid_lines = 0;
    for line in text.lines().take(1000) {
        let trimmed = line.trim();
        // Values (including device names) can contain colons; section and
        // footnote lines do not establish an observation.
        if trimmed.is_empty() || trimmed.ends_with(':') || trimmed.starts_with("Generated on") {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            if invalid_lines == 0 {
                report.issues.push(issue(
                    "hardware",
                    "unrecognized_profiler_section",
                    FactConfidence::Unknown,
                ));
            }
            invalid_lines += 1;
            continue;
        };
        let value = value.trim();
        if value.len() > 160 || value.chars().any(|c| c.is_control()) {
            report.issues.push(issue(
                "hardware",
                "unexpected_profiler_output",
                FactConfidence::Error,
            ));
            continue;
        }
        match key.trim() {
            // Both sections are bounded by the fixed command arguments.
            "Memory" => match memory_bytes(value) {
                Some(bytes) => {
                    report.facts.push(fact(
                        "hardware.memory_bytes",
                        Some(FactValue::Integer(bytes.min(i64::MAX as u64) as i64)),
                        FactConfidence::Available,
                        observed_at,
                        FactSource::ControllerProbed,
                    ));
                    // Only memory quantity is reported, not device compatibility.
                }
                None => report.issues.push(issue(
                    "hardware.memory_bytes",
                    "unexpected_memory_observation",
                    FactConfidence::Error,
                )),
            },
            "Chipset Model" | "Device Name" | "Model Name" | "Model Identifier"
            | "Machine Name" => {
                report.facts.push(fact(
                    "hardware.note",
                    Some(FactValue::Text(value.to_owned())),
                    FactConfidence::Available,
                    observed_at,
                    FactSource::ControllerProbed,
                ));
            }
            // These observations deliberately do not claim GPU acceleration,
            // image generation, model presence or a runtime adapter.
            _ => {}
        }
        invalid_lines = 0;
    }
    if report.facts.is_empty() {
        report.issues.push(issue(
            "hardware",
            "no_supported_hardware_observations",
            FactConfidence::Unknown,
        ));
    }
}

/// A model adapter that has not been verified is absence of knowledge, not a
/// fabricated unavailable/live model installation.
pub fn unverified_model_adapter(observed_at: DateTime<Utc>) -> ProbeReport {
    ProbeReport {
        schema: INVENTORY_SCHEMA.to_owned(),
        host_id: "unspecified".to_owned(),
        source: FactSource::Unverified,
        probed_at: observed_at,
        inspector: None,
        facts: vec![fact(
            "model.adapter",
            None,
            FactConfidence::Unknown,
            observed_at,
            FactSource::Unverified,
        )],
        issues: Vec::new(),
        permission_granted: false,
    }
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
    #[test]
    fn inventory_probe_normalizes_specific_root_and_separates_repository_state() {
        let _guard = lock();
        let dir = tempfile::tempdir().unwrap();
        let result = probe_project(&ProjectProbeInput {
            host_id: "host-a".into(),
            root: dir.path().to_path_buf(),
            form: ProjectForm::WorkingTree,
            canonical_remote: Some("https://example.invalid/project.git".into()),
            revision: Some("abc1234".into()),
            dirty: Some(true),
            credential_location: Some(CredentialLocation::HostCredentialStore),
        })
        .unwrap();
        assert_eq!(
            result.root,
            fs::canonicalize(dir.path()).unwrap().to_string_lossy()
        );
        assert_eq!(result.form, ProjectForm::WorkingTree);
        assert_eq!(result.dirty, Some(true));
        assert_eq!(result.credential_location, "host_credential_store");
        assert!(!result.permission_granted);
    }
    #[test]
    fn inventory_probe_missing_model_is_unknown_not_invented_and_no_credentials_leak() {
        let _guard = lock();
        let at = Utc::now();
        let report = normalize_host_facts("host-a", &json!([{"schema":"loom.inventory.v1","resource":"service.inference","source":"host_reported","observed_at":at,"freshness":"fresh","confidence":"available","location":"local_only","value":"running"}]).to_string(), at, FactSource::HostReported);
        assert_eq!(report.facts[0].resource, "service.inference");
        assert!(!report.permission_granted);
        let report = normalize_host_facts("host-a", &json!([{"resource":"model.private","value":{"token":"do-not-copy"},"schema":"loom.inventory.v1","source":"host_reported","observed_at":at,"freshness":"fresh","confidence":"available","location":"local_only"}]).to_string(), at, FactSource::HostReported);
        assert!(report.facts.is_empty());
        assert_eq!(report.facts, Vec::new());
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("do-not-copy"));
        assert_eq!(
            unverified_model_adapter(at).facts[0].confidence,
            FactConfidence::Unknown
        );
    }
    #[test]
    fn inventory_probe_partial_error_keeps_target_resource_visible() {
        let _guard = lock();
        let at = Utc::now();
        let input = json!([
            {"schema":"loom.inventory.v1","resource":"hardware.os","source":"host_reported","observed_at":at,"freshness":"fresh","confidence":"available","location":"local_only","value":"macos"},
            {"schema":"loom.inventory.v1","resource":"service.12","source":"host_reported","observed_at":at,"freshness":"fresh","confidence":"error","location":"local_only"}
        ]);
        let report =
            normalize_host_facts("host-a", &input.to_string(), at, FactSource::HostReported);
        assert_eq!(report.facts.len(), 2);
        assert!(report
            .facts
            .iter()
            .any(|fact| fact.resource == "service.12" && fact.confidence == FactConfidence::Error));
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("healthy\":true"));
    }
    #[test]
    fn inventory_probe_local_inspector_is_explicitly_opt_in_and_platform_bounded() {
        let _guard = lock();
        let previous = std::env::var_os(LOCAL_HARDWARE_ENV);
        std::env::remove_var(LOCAL_HARDWARE_ENV);
        let request = LocalProbeRequest {
            host_id: "test-host".into(),
            inspector: LocalHardwareInspector::Uname,
        };
        let disabled = probe_local_hardware(&request, Utc::now());
        assert!(disabled.facts.is_empty());
        assert_eq!(disabled.issues[0].code, "local_probe_disabled");
        if let Some(value) = previous {
            std::env::set_var(LOCAL_HARDWARE_ENV, value);
        }
        if std::env::consts::OS != "macos" {
            let request = LocalProbeRequest {
                host_id: "test-host".into(),
                inspector: LocalHardwareInspector::MacSystemProfiler,
            };
            let report = probe_local_hardware(&request, Utc::now());
            assert!(report.issues.iter().any(|issue| issue.code
                == "mac_probe_unavailable_on_this_platform"
                || issue.code == "local_probe_disabled"));
        }
    }
    #[test]
    fn inventory_probe_denied_and_unavailable_are_not_merged_into_success() {
        let _guard = lock();
        let at = Utc::now();
        let facts = vec![
            fact(
                "hardware.gpu",
                None,
                FactConfidence::Denied,
                at,
                FactSource::HostReported,
            ),
            fact(
                "model.something",
                None,
                FactConfidence::Missing,
                at,
                FactSource::HostReported,
            ),
        ];
        let (normalized, issues) =
            crate::inventory::normalize_reported_facts(&facts, Freshness::Fresh);
        assert!(issues.is_empty());
        assert!(normalized
            .iter()
            .any(|fact| fact.confidence == FactConfidence::Denied));
        assert!(normalized
            .iter()
            .any(|fact| fact.confidence == FactConfidence::Missing));
    }
}
