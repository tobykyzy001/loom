//! Explicit, small read-only inventory probes. No directory enumeration,
//! credential inspection, model execution, or permission is produced here.
// Pipe readers are bounded and detached on timeout: this module needs no unsafe.
use crate::inventory::{
    FactConfidence, FactSource, FactValue, Freshness, InventoryIssue, ResourceFact,
    INVENTORY_SCHEMA,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub const LOCAL_HARDWARE_ENV: &str = "LOOM_ENABLE_LOCAL_HARDWARE_PROBE";
const MAX_PROBE_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 4 * 1024;
const MAX_PROJECT_ROOT_BYTES: usize = 33312;
const LOCAL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const LOCAL_UNAME: &str = "/usr/bin/uname";
const LOCAL_SYSTEM_PROFILER: &str = "/usr/sbin/system_profiler";

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
    /// Revision and dirty state are supplied externally; no Git is executed here.
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
    /// This is a storage-class reference, never credential content.
    pub credential_location: String,
    pub permission_granted: bool,
}
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[value(rename_all = "snake_case")]
pub enum LocalHardwareInspector {
    Uname,
    /// Physical memory and graphics observations on this macOS host.
    MacSystemProfiler,
    /// An independently selectable GPU-only macOS display inspection.
    #[default]
    MacDisplaysProfiler,
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
    /// Stable issue codes only. No stderr/raw profiler report is echoed.
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
/// Typed parser for scalar observations; arbitrary host JSON is not echoed.
pub fn normalize_host_facts(
    selector: &str,
    encoded: &str,
    observed_at: DateTime<Utc>,
    source: FactSource,
) -> ProbeReport {
    let mut report = base_report(selector, None, observed_at, source);
    if !valid_selector(selector) || encoded.len() > MAX_PROBE_BYTES {
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
            fact.observed_at = Some(observed_at);
            fact.source = source;
            fact
        })
        .collect();
    report.issues = issues;
    report
}

/// Normalize this named root. No parent/child enumeration, repository command,
/// or new access permission occurs.
pub fn probe_project(input: &ProjectProbeInput) -> std::io::Result<ProjectProbe> {
    if !valid_selector(&input.host_id) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "host id is not valid",
        ));
    }
    if input.root.as_os_str().len() > MAX_PROJECT_ROOT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "project root is too long",
        ));
    }
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
fn base_report(
    host_id: &str,
    inspector: Option<&str>,
    observed_at: DateTime<Utc>,
    source: FactSource,
) -> ProbeReport {
    ProbeReport {
        schema: INVENTORY_SCHEMA.to_owned(),
        host_id: host_id.to_owned(),
        source,
        probed_at: observed_at,
        inspector: inspector.map(str::to_owned),
        facts: Vec::new(),
        issues: Vec::new(),
        permission_granted: false,
    }
}
fn unknown_observed_fact(resource: &str, observed_at: DateTime<Utc>) -> ResourceFact {
    fact(
        resource,
        None,
        FactConfidence::Unknown,
        observed_at,
        FactSource::ControllerProbed,
    )
}

/// Opt in per process to a read-only inspection of this one physical host.
/// `SPDisplaysDataType` gives graphics facts, not model/image execution support.
/// A failed inspector is an error/unknown observation, never "missing GPU".
pub fn probe_local_hardware(
    request: &LocalProbeRequest,
    observed_at: DateTime<Utc>,
) -> ProbeReport {
    let inspector = match request.inspector {
        LocalHardwareInspector::Uname => "uname",
        LocalHardwareInspector::MacSystemProfiler | LocalHardwareInspector::MacDisplaysProfiler => {
            "system_profiler"
        }
    };
    let mut report = base_report(
        &request.host_id,
        Some(inspector),
        observed_at,
        FactSource::ControllerProbed,
    );
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
    if request.inspector != LocalHardwareInspector::Uname && std::env::consts::OS != "macos" {
        report.facts.push(fact(
            "hardware.gpu",
            None,
            FactConfidence::Incompatible,
            observed_at,
            FactSource::ControllerProbed,
        ));
        report.issues.push(issue(
            "hardware.gpu",
            "mac_probe_unavailable_on_this_platform",
            FactConfidence::Incompatible,
        ));
        return report;
    }
    run_inspector(
        ProbeCommand {
            executable: Path::new(match request.inspector {
                LocalHardwareInspector::Uname => LOCAL_UNAME,
                LocalHardwareInspector::MacSystemProfiler
                | LocalHardwareInspector::MacDisplaysProfiler => LOCAL_SYSTEM_PROFILER,
            }),
            arguments: inspector_arguments(request.inspector),
            timeout: LOCAL_PROBE_TIMEOUT,
            #[cfg(test)]
            fixture: false,
        },
        request.inspector,
        observed_at,
        report,
    )
}

/// Test-only construction: the executable must be an explicitly selected,
/// regular, non-symlink, owner-writable-only file, not a PATH-resolved command.
/// All inspector arguments still come from the enum, never fixture input.
#[cfg(test)]
fn fixture_probe(
    executable: PathBuf,
    inspector: LocalHardwareInspector,
    timeout: Duration,
) -> ProbeReport {
    let at = Utc::now();
    let mut report = base_report(
        "fixture-host",
        Some("fixture_synthetic"),
        at,
        FactSource::Unverified,
    );
    let Some(executable) = validated_fixture(&executable) else {
        report.issues.push(issue(
            "hardware.probe",
            "fixture_executable_rejected",
            FactConfidence::Denied,
        ));
        return report;
    };
    run_inspector(
        ProbeCommand {
            executable: &executable,
            arguments: inspector_arguments(inspector),
            timeout,
            fixture: true,
        },
        inspector,
        at,
        report,
    )
}
#[cfg(test)]
fn validated_fixture(executable: &Path) -> Option<PathBuf> {
    if !executable.is_absolute() || executable.components().count() > 16 {
        return None;
    }
    // Canonicalize only the test-created parent (on macOS /var may resolve
    // below /private). The executable name must be an ordinary final component.
    let parent = fs::canonicalize(executable.parent()?).ok()?;
    let name = executable.file_name()?.to_str()?.to_owned();
    if name.is_empty() {
        return None;
    }
    let canonical = parent.join(name);
    // The final component is deliberately NOT canonicalized: otherwise a
    // script symlink could hide an arbitrary path behind a fixture request.
    let metadata = fs::symlink_metadata(&canonical).ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16 * 1024 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o022 != 0 {
            return None;
        }
    }
    Some(canonical)
}

#[derive(Clone, Copy)]
struct ProbeCommand<'a> {
    executable: &'a Path,
    arguments: &'a [&'a str],
    timeout: Duration,
    #[cfg(test)]
    fixture: bool,
}
fn inspector_arguments(inspector: LocalHardwareInspector) -> &'static [&'static str] {
    match inspector {
        LocalHardwareInspector::Uname => &["-sm"],
        LocalHardwareInspector::MacSystemProfiler => &["SPHardwareDataType", "SPDisplaysDataType"],
        LocalHardwareInspector::MacDisplaysProfiler => &["SPDisplaysDataType"],
    }
}
fn run_inspector(
    command: ProbeCommand<'_>,
    inspector: LocalHardwareInspector,
    observed_at: DateTime<Utc>,
    mut report: ProbeReport,
) -> ProbeReport {
    match execute_bounded(command) {
        Ok(process)
            if process.status == Some(0)
                && !process.stdout_overflow
                && !process.stderr_overflow =>
        {
            if let Ok(text) = String::from_utf8(process.stdout) {
                match inspector {
                    LocalHardwareInspector::Uname => parse_uname(&text, observed_at, &mut report),
                    LocalHardwareInspector::MacSystemProfiler
                    | LocalHardwareInspector::MacDisplaysProfiler => {
                        if inspector == LocalHardwareInspector::MacSystemProfiler {
                            parse_mac_memory(&text, observed_at, &mut report);
                        }
                        parse_mac_displays(&text, observed_at, &mut report);
                    }
                }
            } else {
                probe_failure(
                    &mut report,
                    "inspector_output_not_utf8",
                    inspector,
                    observed_at,
                );
            }
        }
        Ok(process) => {
            // Never echo the process's status stderr or free-form observations.
            probe_failure(
                &mut report,
                if process.stdout_overflow {
                    "inspector_output_too_large"
                } else if process.stderr_overflow {
                    "inspector_stderr_too_large"
                } else {
                    "inspector_failed"
                },
                inspector,
                observed_at,
            );
        }
        Err(error) => probe_failure(&mut report, error, inspector, observed_at),
    }
    #[cfg(test)]
    if command.fixture {
        // Fixture observations cannot become current physical-host evidence.
        for fact in &mut report.facts {
            if fact.resource != "models" {
                fact.source = FactSource::Unverified;
            }
        }
    }
    if inspector != LocalHardwareInspector::Uname {
        let mut unknown = ResourceFact::unknown("models");
        unknown.observed_at = Some(observed_at);
        report.facts.push(unknown);
    }
    report
}
fn probe_failure(
    report: &mut ProbeReport,
    code: &'static str,
    inspector: LocalHardwareInspector,
    observed_at: DateTime<Utc>,
) {
    report.issues.push(issue(
        if inspector == LocalHardwareInspector::Uname {
            "hardware"
        } else {
            "hardware.gpu"
        },
        code,
        FactConfidence::Error,
    ));
    if inspector != LocalHardwareInspector::Uname {
        report.facts.push(fact(
            "hardware.probe",
            None,
            FactConfidence::Error,
            observed_at,
            FactSource::ControllerProbed,
        ));
        report
            .facts
            .push(unknown_observed_fact("hardware.gpu", observed_at));
    }
}

struct ProcessOutput {
    stdout: Vec<u8>,
    status: Option<i32>,
    stdout_overflow: bool,
    stderr_overflow: bool,
}
/// Drain both pipes with bounded retained memory. The watchdog kills/waits for
/// the direct child on timeout and bounds pipe closure. It does not claim to
/// own an arbitrary fixture's descendants. Raw diagnostics are dropped.
fn execute_bounded(command: ProbeCommand<'_>) -> Result<ProcessOutput, &'static str> {
    let mut child = Command::new(command.executable)
        .args(command.arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("LANG", "C")
        .env("HOME", "/var/empty")
        .spawn()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "inspector_unavailable"
            } else {
                "inspector_start_failed"
            }
        })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "inspector_output_unavailable"
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        let _ = child.kill();
        let _ = child.wait();
        "inspector_errors_unavailable"
    })?;
    let (sender, receiver) = mpsc::channel();
    let stdout_sender = sender.clone();
    let stdout_reader = thread::spawn(move || {
        let _ = stdout_sender.send((drain_bounded(stdout, MAX_PROBE_BYTES), 0_u8));
    });
    let stderr_reader = thread::spawn(move || {
        let _ = sender.send((drain_bounded(stderr, MAX_STDERR_BYTES), 1_u8));
    });
    let mut timeout_or_wait = || -> Option<&'static str> {
        let deadline = Instant::now() + command.timeout;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Some(if status.code().is_some() {
                        ""
                    } else {
                        "inspector_terminated"
                    });
                }
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(2)),
                Ok(None) => return Some("inspector_timeout"),
                Err(_) => return Some("inspector_wait_failed"),
            }
        }
    };
    let termination = timeout_or_wait().unwrap_or("inspector_wait_failed");
    if termination == "inspector_timeout" {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|_| "inspector_wait_failed")?;
    let drain_deadline = Instant::now() + Duration::from_millis(100);
    let mut stdout = Vec::new();
    let mut stdout_overflow = false;
    let mut stderr_overflow = false;
    for _ in 0..2 {
        match receiver.recv_timeout(drain_deadline.saturating_duration_since(Instant::now())) {
            Ok(((_, overflow), 1_u8)) => stderr_overflow = overflow,
            Ok(((bytes, overflow), _)) => {
                stdout = bytes;
                stdout_overflow = overflow;
            }
            Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let stdout_finished = stdout_reader.is_finished();
    let stderr_finished = stderr_reader.is_finished();
    if !stdout_finished || !stderr_finished {
        // Dropping the handles detaches readers of a malicious fixture's
        // descendant pipe. OS tools are invoked directly, without a shell.
        return Err(if termination.is_empty() {
            "inspector_pipe_close_timeout"
        } else {
            termination
        });
    }
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    if !termination.is_empty() {
        return Err(termination);
    }
    Ok(ProcessOutput {
        stdout,
        status: status.code(),
        stdout_overflow,
        stderr_overflow,
    })
}
// Non-Unix pipe-close behavior is not asserted by the macOS-specific tests;
// the parser does not imply platform capability.
fn drain_bounded(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut buffer = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0_u8; 8192];
    let mut overflow = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                if buffer.len().saturating_add(size) > limit {
                    overflow = true;
                    buffer.clear();
                }
                if !overflow {
                    buffer.extend_from_slice(&chunk[..size]);
                }
            }
        }
    }
    (buffer, overflow)
}
fn parse_uname(text: &str, observed_at: DateTime<Utc>, report: &mut ProbeReport) {
    let fields = text.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 2
        || fields.iter().any(|field| {
            field.len() > 64
                || !field
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        })
    {
        report.issues.push(issue(
            "hardware",
            "unexpected_uname_output",
            FactConfidence::Error,
        ));
        return;
    }
    for (resource, value) in [
        (
            "hardware.os",
            match fields[0] {
                "Darwin" => "macos",
                "Linux" => "linux",
                other => other,
            },
        ),
        ("hardware.arch", fields[1]),
    ] {
        report.facts.push(fact(
            resource,
            Some(FactValue::Text(value.to_owned())),
            FactConfidence::Available,
            observed_at,
            FactSource::ControllerProbed,
        ));
    }
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
fn parse_mac_memory(text: &str, observed_at: DateTime<Utc>, report: &mut ProbeReport) {
    let raw = text.lines().take(400).find_map(|line| {
        let (key, value) = line.trim().split_once(':')?;
        (key.trim() == "Memory").then_some(value.trim())
    });
    match raw
        .and_then(memory_bytes)
        .and_then(|value| i64::try_from(value).ok())
    {
        Some(bytes) => report.facts.push(fact(
            "hardware.memory_bytes",
            Some(FactValue::Integer(bytes)),
            FactConfidence::Available,
            observed_at,
            FactSource::ControllerProbed,
        )),
        None => {
            report
                .facts
                .push(unknown_observed_fact("hardware.memory_bytes", observed_at));
            report.issues.push(issue(
                "hardware.memory_bytes",
                "memory_observation_unavailable",
                FactConfidence::Unknown,
            ));
        }
    }
}
fn gpu_vendor(model: &str) -> Option<&'static str> {
    let lower = model.to_ascii_lowercase();
    if lower.contains("apple") {
        Some("apple")
    } else if lower.contains("amd") || lower.contains("radeon") || lower.contains("ati") {
        Some("amd")
    } else if lower.contains("intel") {
        Some("intel")
    } else if lower.contains("nvidia") || lower.contains("geforce") {
        Some("nvidia")
    } else {
        None
    }
}
/// Device labels are bounded ASCII names, not file paths, UUIDs, usernames,
/// serials, or other arbitrary profiler field values.
fn gpu_label(value: &str) -> Option<String> {
    let value = bounded(Some(value), 96)?;
    let lower = value.to_ascii_lowercase();
    if [
        "token", "password", "secret", "uuid", "serial", "user", "/", "\\",
    ]
    .iter()
    .any(|part| lower.contains(part))
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '(' | ')'))
    {
        None
    } else {
        Some(value)
    }
}
fn parse_mac_displays(text: &str, observed_at: DateTime<Utc>, report: &mut ProbeReport) {
    let mut observations = 0;
    for line in text.lines().take(1000) {
        let trimmed = line.trim_start();
        if trimmed.ends_with(':') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Chipset Model" | "Chipset" | "Device Name" => {
                match gpu_label(value)
                    .and_then(|model| gpu_vendor(&model).map(|vendor| (model, vendor)))
                {
                    Some((model, vendor)) => {
                        for (resource, value) in [
                            ("hardware.gpu.model", model),
                            ("hardware.gpu.vendor", vendor.to_owned()),
                        ] {
                            report.facts.push(fact(
                                resource,
                                Some(FactValue::Text(value)),
                                FactConfidence::Available,
                                observed_at,
                                FactSource::ControllerProbed,
                            ));
                            observations += 1;
                        }
                    }
                    None => report.issues.push(issue(
                        "hardware.gpu.model",
                        "gpu_model_unavailable",
                        FactConfidence::Unknown,
                    )),
                }
            }
            "VRAM" | "VRAM (Total)" | "VRAM (Dynamic, Max)" => {
                match memory_bytes(value).and_then(|bytes| i64::try_from(bytes).ok()) {
                    Some(bytes) => {
                        report.facts.push(fact(
                            "hardware.gpu.vram_bytes",
                            Some(FactValue::Integer(bytes)),
                            FactConfidence::Available,
                            observed_at,
                            FactSource::ControllerProbed,
                        ));
                        observations += 1;
                    }
                    None => report.issues.push(issue(
                        "hardware.gpu.vram_bytes",
                        "gpu_vram_observation_unavailable",
                        FactConfidence::Unknown,
                    )),
                }
            }
            "Metal Support" | "Metal" => {
                let normalized = value.to_ascii_lowercase();
                if normalized == "metal 1"
                    || normalized == "metal 2"
                    || normalized == "metal 3"
                    || normalized == "metal 4"
                    || normalized == "supported"
                {
                    report.facts.push(fact(
                        "hardware.gpu.metal",
                        Some(FactValue::Text(normalized.replace(' ', "_"))),
                        FactConfidence::Available,
                        observed_at,
                        FactSource::ControllerProbed,
                    ));
                    observations += 1;
                } else if normalized == "not supported" || normalized == "unsupported" {
                    report.facts.push(fact(
                        "hardware.gpu.metal",
                        Some(FactValue::Text("no_metal".to_owned())),
                        FactConfidence::Missing,
                        observed_at,
                        FactSource::ControllerProbed,
                    ));
                    observations += 1;
                }
            }
            // Bus addresses, serials, UUIDs, EDIDs, paths and displays are ignored.
            _ => {}
        }
    }
    if observations == 0 {
        report
            .facts
            .push(unknown_observed_fact("hardware.gpu", observed_at));
        report.issues.push(issue(
            "hardware.gpu",
            "gpu_observation_unavailable",
            FactConfidence::Unknown,
        ));
    }
}

pub const LOCAL_HARDWARE_PROBE_SCHEMA: &str = "loom.local-hardware-probe.v1";
const MAX_TRUSTED_PROBE_BYTES: usize = 64 * 1024;

/// Server-only provenance for one actual CLI report. Never accept this shape
/// from a Node heartbeat or copy a heartbeat's source flag into it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TrustedHardwareProbe {
    pub schema: String,
    pub node_id: String,
    pub installation_id: String,
    pub inspector: String,
    pub observed_at: DateTime<Utc>,
    pub facts: Vec<ResourceFact>,
    pub issues: Vec<InventoryIssue>,
    pub source: FactSource,
    pub permission_granted: bool,
}
pub(crate) fn hardware_key(node_id: &str, installation_id: &str) -> String {
    format!("hardware_probe:{node_id}:{installation_id}")
}
fn validate_trusted(
    report: &TrustedHardwareProbe,
    node_id: &str,
    installation_id: &str,
) -> anyhow::Result<()> {
    let valid = report.schema == LOCAL_HARDWARE_PROBE_SCHEMA
        && report.node_id == node_id
        && report.installation_id == installation_id
        && valid_selector(node_id)
        && valid_selector(installation_id)
        && bounded(Some(&report.inspector), 80).is_some()
        && report.source == FactSource::ControllerProbed
        && !report.permission_granted
        && report.facts.len() <= 64
        && report.issues.len() <= 64
        && report.facts.iter().all(|fact| {
            if fact.resource.starts_with("hardware.") {
                fact.source == FactSource::ControllerProbed
                    && fact.observed_at == Some(report.observed_at)
                    && crate::inventory::normalize_reported_facts(
                        std::slice::from_ref(fact),
                        Freshness::Fresh,
                    )
                    .1
                    .is_empty()
            } else {
                fact.resource == "models"
                    && fact.source == FactSource::Unverified
                    && fact.value.is_none()
            }
        })
        && report.issues.iter().all(|issue| {
            issue.resource.starts_with("hardware.")
                && bounded(Some(&issue.code), 80).is_some()
                && bounded(Some(&issue.resource), 160).is_some()
        });
    if valid {
        Ok(())
    } else {
        anyhow::bail!("invalid_trusted_hardware_probe")
    }
}
/// Read exact server-owned state only. Corruption fails closed rather than
/// falling back to self-reported hardware for placement.
pub(crate) fn trusted_hardware(
    store: &crate::store::Store,
    node_id: &str,
    installation_id: &str,
) -> anyhow::Result<Option<TrustedHardwareProbe>> {
    let Some(encoded) = store.setting(&hardware_key(node_id, installation_id)) else {
        return Ok(None);
    };
    if encoded.len() > MAX_TRUSTED_PROBE_BYTES {
        anyhow::bail!("invalid_trusted_hardware_probe")
    }
    let report: TrustedHardwareProbe = serde_json::from_str(&encoded)?;
    validate_trusted(&report, node_id, installation_id)?;
    Ok(Some(report))
}

/// Explicit owner CLI action. Only the fixed native wrapper's actual report is
/// committed, under its own exact identity; the Node's inventory is untouched.
pub fn local_hardware_inventory<F>(
    store: &mut crate::store::Store,
    node_id: &str,
    installation_id: &str,
    request: &LocalProbeRequest,
    enabled: bool,
    this_controller_host: bool,
    probe: F,
) -> anyhow::Result<Value>
where
    F: FnOnce(&LocalProbeRequest, DateTime<Utc>) -> ProbeReport,
{
    if !enabled {
        anyhow::bail!("local_hardware_disabled")
    }
    if !this_controller_host {
        // The registry alone cannot prove a registered Node belongs to this
        // physical controller. Only an explicit local operator may associate
        // measurement here with that identity. This is not device attestation.
        anyhow::bail!("controller-local association requires explicit --this-controller-host")
    }
    if !valid_selector(node_id) || !valid_selector(installation_id) || request.host_id != node_id {
        anyhow::bail!("scope_mismatch")
    }
    let rows = store.query(
        "SELECT * FROM nodes WHERE id=?1 AND installation_id=?2",
        rusqlite::params![node_id, installation_id],
    )?;
    let snapshot = rows.first().ok_or_else(|| {
        anyhow::anyhow!("unknown_installation: exact Node/Installation is not registered")
    })?;
    if snapshot["status"] != "online" || !snapshot["revoked_at"].is_null() {
        anyhow::bail!("inactive_installation")
    }
    let Some(inventory) = snapshot["inventory"].as_object() else {
        anyhow::bail!("future_invalid_inventory")
    };
    if inventory
        .get("hardware")
        .is_some_and(|value| !value.is_object())
        || inventory.get("resources").is_some_and(|value| {
            value.as_array().is_none_or(|facts| {
                facts
                    .iter()
                    .any(|fact| serde_json::from_value::<ResourceFact>(fact.clone()).is_err())
            })
        })
        || inventory
            .get("model_catalog")
            .is_some_and(|value| !value.is_object())
    {
        anyhow::bail!("future_invalid_inventory")
    }
    let at = Utc::now();
    let report = probe(request, at);
    if report.host_id != node_id
        || report.source != FactSource::ControllerProbed
        || report.schema != INVENTORY_SCHEMA
        || report.permission_granted
        || report.probed_at != at
        || report.facts.len() > 64
        || report.issues.len() > 64
        || report.facts.iter().any(|fact| {
            !(fact.resource.starts_with("hardware.") || fact.resource == "models")
                || fact.resource.starts_with("hardware.")
                    && fact.source != FactSource::ControllerProbed
        })
    {
        anyhow::bail!("invalid_controller_report")
    }
    let trusted = TrustedHardwareProbe {
        schema: LOCAL_HARDWARE_PROBE_SCHEMA.to_owned(),
        node_id: node_id.to_owned(),
        installation_id: installation_id.to_owned(),
        inspector: report
            .inspector
            .as_deref()
            .and_then(|value| bounded(Some(value), 80))
            .ok_or_else(|| anyhow::anyhow!("invalid_controller_report"))?,
        observed_at: report.probed_at,
        facts: report.facts.clone(),
        issues: report.issues.clone(),
        source: FactSource::ControllerProbed,
        permission_granted: false,
    };
    validate_trusted(&trusted, node_id, installation_id)?;
    let encoded = serde_json::to_string(&trusted)?;
    let snapshot_inventory = serde_json::to_string(&snapshot["inventory"])?;
    let tx = store
        .conn_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current: String = tx.query_row("SELECT inventory FROM nodes WHERE id=?1 AND installation_id=?2 AND status='online' AND revoked_at IS NULL",
        rusqlite::params![request.host_id,installation_id], |row| row.get(0))?;
    if current != snapshot_inventory {
        anyhow::bail!("inventory_changed_or_invalid")
    }
    tx.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![hardware_key(node_id, installation_id), encoded],
    )?;
    crate::store::audit_tx_plan(
        &tx,
        "owner_cli",
        "inventory.hardware_probe",
        &serde_json::json!({"node_id":request.host_id,"installation_id":snapshot["installation_id"],
            "inspector":trusted.inspector,"measured_at":trusted.observed_at,"permission_granted":false}),
    )?;
    tx.commit()?;
    // Public stdout is the same bounded DTO: no Token, stderr or raw profile.
    Ok(serde_json::to_value(trusted)?)
}

/// A model adapter that has not been verified is absence of knowledge, not a
/// fabricated unavailable/live model installation.
pub fn unverified_model_adapter(observed_at: DateTime<Utc>) -> ProbeReport {
    let mut report = base_report("unspecified", None, observed_at, FactSource::Unverified);
    report.facts.push(fact(
        "model.adapter",
        None,
        FactConfidence::Unknown,
        observed_at,
        FactSource::Unverified,
    ));
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;

    struct RegistryFixture {
        _dir: tempfile::TempDir,
        store: crate::store::Store,
        original: Value,
    }
    fn registry_fixture() -> RegistryFixture {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','synthetic','/fixture','read_only',1,'2026-01-01T00:00:00Z','{}')", []).unwrap();
        store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','project','node-a','worker-a','install-a','[\"read\"]',1,'original-digest','2026-01-01T00:00:00Z')", []).unwrap();
        let inventory = json!({"hardware":{"os":"darwin","arch":"unchanged"},"resources":[{"schema":INVENTORY_SCHEMA,"resource":"service.runtime","value":"original","source":"host_reported","observed_at":null,"freshness":"fresh","confidence":"available","location":"local_only"}],"project_roots":{"project":"/fixture"}});
        let capabilities = json!([{"ticket_kind":"read_summary","permission":"read"}]);
        let workers = json!([{"worker_id":"worker-a","status":"online"}]);
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node-a','install-a','not-secret','not-secret','online',?1,?2,?3,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", params![capabilities.to_string(),workers.to_string(),inventory.to_string()]).unwrap();
        let original = store.get("nodes", "node-a").unwrap().unwrap();
        RegistryFixture {
            _dir: dir,
            store,
            original,
        }
    }
    fn must_not_probe(request: &LocalProbeRequest, _: DateTime<Utc>) -> ProbeReport {
        panic!(
            "native wrapper called for refused identity {}",
            request.host_id
        )
    }
    fn checked_inventory(
        fixture: &mut RegistryFixture,
        request: &LocalProbeRequest,
        enabled: bool,
    ) -> anyhow::Result<Value> {
        local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "install-a",
            request,
            enabled,
            true,
            must_not_probe,
        )
    }
    #[test]
    fn inventory_probe_registry_refusal_and_future_inventory_never_invoke_or_write() {
        for (label, setup) in [
            ("missing", "DELETE FROM nodes"),
            ("wrong_node", "UPDATE nodes SET id='node-b'"),
            (
                "scope_mismatch",
                "UPDATE nodes SET installation_id='install-b'",
            ),
            (
                "revoked",
                "UPDATE nodes SET revoked_at='2026-01-01T00:00:00Z'",
            ),
            ("offline", "UPDATE nodes SET status='offline'"),
            (
                "future_invalid_inventory",
                "UPDATE nodes SET inventory='[]'",
            ),
            (
                "future_hardware",
                "UPDATE nodes SET inventory='{\"hardware\":[]}'",
            ),
            (
                "future_resources",
                "UPDATE nodes SET inventory='{\"resources\":{}}'",
            ),
            (
                "future_resource",
                "UPDATE nodes SET inventory='{\"resources\":[{}]}'",
            ),
        ] {
            let mut fixture = registry_fixture();
            fixture.store.conn().execute(setup, []).unwrap();
            let request = LocalProbeRequest {
                host_id: "node-a".into(),
                inspector: LocalHardwareInspector::MacDisplaysProfiler,
            };
            assert!(
                checked_inventory(&mut fixture, &request, label != "missing").is_err(),
                "{label}"
            );
            assert!(
                checked_inventory(&mut fixture, &request, false).is_err(),
                "{label}"
            );
            assert!(fixture.store.audits(None).unwrap().is_empty(), "{label}");
            let after = fixture.store.query("SELECT * FROM nodes", []).unwrap();
            assert!(after.is_empty() == (label == "missing"), "{label}");
            if !after.is_empty() {
                assert_eq!(
                    after[0]["inventory"],
                    if label == "future_invalid_inventory" {
                        json!([])
                    } else if label == "future_hardware" {
                        json!({"hardware":[]})
                    } else if label == "future_resources" {
                        json!({"resources":{}})
                    } else if label == "future_resource" {
                        json!({"resources":[{}]})
                    } else {
                        fixture.original["inventory"].clone()
                    },
                    "{label}"
                );
            }
        }
        let mut fixture = registry_fixture();
        let request = LocalProbeRequest {
            host_id: "node-a".into(),
            inspector: LocalHardwareInspector::Uname,
        };
        assert!(checked_inventory(&mut fixture, &request, false).is_err());
        assert_eq!(
            fixture.store.get("nodes", "node-a").unwrap(),
            Some(fixture.original)
        );
        assert!(fixture.store.audits(None).unwrap().is_empty());
    }
    #[test]
    fn hardware_probe_requires_explicit_current_controller_association() {
        let mut fixture = registry_fixture();
        let before_audits = fixture.store.audits(None).unwrap().len();
        let request = LocalProbeRequest {
            host_id: "node-a".into(),
            inspector: LocalHardwareInspector::MacSystemProfiler,
        };
        let error = local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "install-a",
            &request,
            true,
            false,
            must_not_probe,
        )
        .unwrap_err();
        assert!(error.to_string().contains("--this-controller-host"));
        assert_eq!(
            fixture.store.get("nodes", "node-a").unwrap(),
            Some(fixture.original)
        );
        assert!(trusted_hardware(&fixture.store, "node-a", "install-a")
            .unwrap()
            .is_none());
        assert_eq!(fixture.store.audits(None).unwrap().len(), before_audits);
    }

    #[test]
    fn inventory_probe_real_upsert_is_atomic_and_preserves_registry_identity() {
        let mut fixture = registry_fixture();
        let original_grant = fixture.store.get("grants", "grant").unwrap().unwrap();
        let before_audits = fixture.store.audits(None).unwrap().len();
        let request = LocalProbeRequest {
            host_id: "node-a".into(),
            inspector: LocalHardwareInspector::MacDisplaysProfiler,
        };
        let measured = DateTime::parse_from_rfc3339("2026-11-19T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let output = local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "install-a",
            &request,
            true,
            true,
            |_, actual_at| {
                assert!(actual_at >= measured && actual_at <= Utc::now());
                let mut report = base_report(
                    "node-a",
                    Some("system_profiler"),
                    actual_at,
                    FactSource::ControllerProbed,
                );
                report.facts = vec![
                    fact(
                        "hardware.gpu.model",
                        Some(FactValue::Text("Apple M2".into())),
                        FactConfidence::Available,
                        actual_at,
                        FactSource::ControllerProbed,
                    ),
                    ResourceFact::unknown("models"),
                ];
                report
            },
        )
        .unwrap();
        assert_eq!(output["permission_granted"], false);
        assert_eq!(output["facts"].as_array().unwrap().len(), 2);
        for field in ["stderr", "node_token", "token", "raw_profile"] {
            assert!(output.get(field).is_none(), "{field}");
        }
        assert_eq!(output["node_id"], "node-a");
        assert_eq!(output["installation_id"], "install-a");
        assert_eq!(output["source"], "controller_probed");
        let node = fixture.store.get("nodes", "node-a").unwrap().unwrap();
        assert_eq!(
            node, fixture.original,
            "the whole raw Node row stays separate"
        );
        let trusted = trusted_hardware(&fixture.store, "node-a", "install-a")
            .unwrap()
            .unwrap();
        assert_eq!(serde_json::to_value(&trusted).unwrap(), output);
        assert!(node["inventory"].get("hardware_probe").is_none());
        assert_eq!(
            node["inventory"]["resources"][0]["resource"],
            "service.runtime"
        );
        let view = crate::inventory::trusted_node_view(
            &fixture.store,
            &crate::inventory::InstallationIdentity {
                node_id: "node-a".into(),
                installation_id: "install-a".into(),
            },
            Some(&node),
            Utc::now(),
        )
        .unwrap();
        let gpu = view
            .facts
            .iter()
            .find(|fact| fact.resource == "hardware.gpu.model")
            .unwrap();
        assert_eq!(gpu.source, FactSource::ControllerProbed);
        assert_eq!(gpu.observed_at, Some(trusted.observed_at));
        assert!(view
            .facts
            .iter()
            .any(|fact| fact.resource == "service.runtime"
                && fact.value == Some(FactValue::Text("original".into()))));
        assert_eq!(view.hardware_probe.unwrap().inspector, "system_profiler");
        assert_eq!(
            fixture.store.get("grants", "grant").unwrap(),
            Some(original_grant)
        );
        let audits = fixture.store.audits(None).unwrap();
        assert_eq!(audits.len(), before_audits + 1);
        let audit = &audits[0];
        assert_eq!(audit["action"], "inventory.hardware_probe");
        assert!(audit["evidence"].to_string().contains("node-a"));
        assert!(fixture.store.verify_audit().unwrap());

        let before_failed_write = node["inventory"].clone();
        let before_failed_probe = fixture.store.setting(&hardware_key("node-a", "install-a"));
        fixture.store.conn().execute("CREATE TRIGGER reject_probe_audit BEFORE INSERT ON audits WHEN NEW.action='inventory.hardware_probe' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END", []).unwrap();
        assert!(local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "install-a",
            &request,
            true,
            true,
            |_, at| {
                base_report(
                    "node-a",
                    Some("system_profiler"),
                    at,
                    FactSource::ControllerProbed,
                )
            }
        )
        .is_err());
        let rolled_back = fixture.store.get("nodes", "node-a").unwrap().unwrap();
        assert_eq!(rolled_back["inventory"], before_failed_write);
        assert_eq!(
            rolled_back["last_heartbeat"],
            fixture.original["last_heartbeat"]
        );
        assert_eq!(fixture.store.audits(None).unwrap().len(), audits.len());
        assert_eq!(
            fixture.store.setting(&hardware_key("node-a", "install-a")),
            before_failed_probe,
            "audit failure rolls back the trusted DTO too"
        );
    }

    #[test]
    fn controller_report_rejects_scope_crlf_and_ghost_model_without_a_write() {
        let mut fixture = registry_fixture();
        let request = LocalProbeRequest {
            host_id: "node-a".into(),
            inspector: LocalHardwareInspector::MacDisplaysProfiler,
        };
        for (label, invalidate) in [
            ("wrong_host", 0),
            ("host_reported_source", 1),
            ("crlf_inspector", 2),
            ("ghost_model", 3),
        ] {
            let result = local_hardware_inventory(
                &mut fixture.store,
                "node-a",
                "install-a",
                &request,
                true,
                true,
                |_, at| {
                    let mut report = base_report(
                        "node-a",
                        Some("system_profiler"),
                        at,
                        FactSource::ControllerProbed,
                    );
                    match invalidate {
                        0 => report.host_id = "other".into(),
                        1 => report.source = FactSource::HostReported,
                        2 => report.inspector = Some("system_profiler\r\ntoken".into()),
                        _ => report.facts.push(fact(
                            "model.ghost",
                            Some(FactValue::Text("invented".into())),
                            FactConfidence::Available,
                            at,
                            FactSource::ControllerProbed,
                        )),
                    }
                    report
                },
            );
            assert!(result.is_err(), "{label}");
            assert!(fixture
                .store
                .setting(&hardware_key("node-a", "install-a"))
                .is_none());
            assert!(fixture.store.audits(None).unwrap().is_empty());
            assert_eq!(
                fixture.store.get("nodes", "node-a").unwrap(),
                Some(fixture.original.clone())
            );
        }
        for bad in ["node-a\r\nother-installation", "installation"] {
            assert!(local_hardware_inventory(
                &mut fixture.store,
                "node-a",
                bad,
                &request,
                true,
                true,
                must_not_probe
            )
            .is_err());
        }
        fixture
            .store
            .set_setting(&hardware_key("node-a", "install-b"), "{}")
            .unwrap();
        assert!(trusted_hardware(&fixture.store, "node-a", "install-a")
            .unwrap()
            .is_none());
        fixture
            .store
            .set_setting(&hardware_key("node-a", "install-a"), "{}")
            .unwrap();
        assert!(trusted_hardware(&fixture.store, "node-a", "install-a").is_err());
    }

    #[test]
    fn inventory_probe_exact_installation_selection_preserves_other_rows_and_model_catalog() {
        let mut fixture = registry_fixture();
        let second = json!({"model_catalog":{"schema":"loom.model-inventory.v1","revision":1,"entries":[]},"resources":[]});
        fixture.store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) SELECT id,'install-b',public_key,token_hash,status,capabilities,workers,?1,registered_at,'2026-01-01T00:00:00Z' FROM nodes WHERE installation_id='install-a'", [second.to_string()]).unwrap();
        let request = LocalProbeRequest {
            host_id: "node-a".into(),
            inspector: LocalHardwareInspector::MacDisplaysProfiler,
        };
        let before = fixture
            .store
            .query("SELECT * FROM nodes ORDER BY installation_id", [])
            .unwrap();
        let result = local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "install-b",
            &request,
            true,
            true,
            |_, at| {
                base_report(
                    "node-a",
                    Some("system_profiler"),
                    at,
                    FactSource::ControllerProbed,
                )
            },
        )
        .unwrap();
        assert_eq!(result["permission_granted"], false);
        let after = fixture
            .store
            .query("SELECT * FROM nodes ORDER BY installation_id", [])
            .unwrap();
        assert_eq!(after[0], before[0]);
        assert_eq!(after[1]["last_heartbeat"], before[1]["last_heartbeat"]);
        assert_eq!(
            after[1]["inventory"]["model_catalog"],
            second["model_catalog"]
        );
        assert_eq!(after[1], before[1]);
        assert!(fixture
            .store
            .setting(&hardware_key("node-a", "install-a"))
            .is_none());
        let trusted = trusted_hardware(&fixture.store, "node-a", "install-b")
            .unwrap()
            .unwrap();
        assert_eq!(trusted.schema, LOCAL_HARDWARE_PROBE_SCHEMA);
        assert!(local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "unknown",
            &request,
            true,
            true,
            must_not_probe
        )
        .is_err());
        assert!(local_hardware_inventory(
            &mut fixture.store,
            "node-a",
            "",
            &request,
            true,
            true,
            must_not_probe
        )
        .is_err());
        assert_eq!(
            fixture
                .store
                .query("SELECT * FROM nodes ORDER BY installation_id", [])
                .unwrap(),
            after
        );
    }
    use std::sync::{Mutex, OnceLock};

    fn lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
    fn report() -> ProbeReport {
        base_report(
            "fixture-host",
            Some("fixture"),
            Utc::now(),
            FactSource::ControllerProbed,
        )
    }
    #[cfg(unix)]
    fn script(directory: &tempfile::TempDir, content: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.path().join("synthetic-probe.sh");
        fs::write(&path, content.replace("\\n", "\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
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
                inspector: LocalHardwareInspector::MacDisplaysProfiler,
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
    #[test]
    fn inventory_probe_parser_separates_gpu_memory_and_sensitive_ids() {
        let _guard = lock();
        let input = "Graphics/Displays:\n    Apple M2:\n      Chipset Model: Apple M2\n      Metal Support: Metal 3\n      Serial Number: PRIVATE_SERIAL\n      Device UUID: PRIVATE_UUID\n      Resolution: 2056 x 1329\n";
        let mut result = report();
        parse_mac_displays(input, result.probed_at, &mut result);
        parse_mac_memory("Memory: 24 GB", result.probed_at, &mut result);
        for resource in [
            "hardware.gpu.model",
            "hardware.gpu.vendor",
            "hardware.gpu.metal",
            "hardware.memory_bytes",
        ] {
            assert!(result
                .facts
                .iter()
                .any(|fact| fact.resource == resource
                    && fact.confidence == FactConfidence::Available));
        }
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.value == Some(FactValue::Text("apple".into()))));
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains("PRIVATE_SERIAL"));
        assert!(!public.contains("PRIVATE_UUID"));
        assert!(!public.contains("Resolution"));
        assert!(!result.permission_granted);
    }
    #[test]
    fn inventory_probe_no_metal_or_unknown_gpu_is_not_model_capability() {
        let _guard = lock();
        let mut result = report();
        let at = result.probed_at;
        parse_mac_displays("Display:\n  Chipset Model: TEST_SECRET\n", at, &mut result);
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu"
                && fact.confidence == FactConfidence::Unknown));
        assert!(!result
            .issues
            .iter()
            .any(|issue| issue.confidence == FactConfidence::Missing));
        let mut result = report();
        parse_mac_displays("GPU:\n  Chipset Model: Intel HD Graphics\n  Metal Support: Not supported\n  VRAM (Total): 512 MB\n", at, &mut result);
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu.metal"
                && fact.confidence == FactConfidence::Missing));
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu.vram_bytes"
                && fact.value == Some(FactValue::Integer(512_000_000))));
        assert_eq!(
            unverified_model_adapter(at).facts[0].confidence,
            FactConfidence::Unknown
        );
    }
    #[test]
    fn inventory_probe_arguments_have_no_free_text_or_configuration_flags() {
        assert_eq!(
            inspector_arguments(LocalHardwareInspector::MacDisplaysProfiler),
            ["SPDisplaysDataType"]
        );
        assert_eq!(
            inspector_arguments(LocalHardwareInspector::MacSystemProfiler),
            ["SPHardwareDataType", "SPDisplaysDataType"]
        );
        assert!(inspector_arguments(LocalHardwareInspector::Uname)
            .iter()
            .chain(inspector_arguments(
                LocalHardwareInspector::MacDisplaysProfiler
            ))
            .chain(inspector_arguments(
                LocalHardwareInspector::MacSystemProfiler
            ))
            .all(|arg| !arg.starts_with("--")));
    }
    #[cfg(unix)]
    #[test]
    fn inventory_probe_fixture_bounds_outputs_timeout_arguments_and_secrets() {
        let _guard = lock();
        let dir = tempfile::tempdir().unwrap();
        let executable = script(&dir, "#!/bin/sh\nif [ \"$#\" -ne 1 ] || [ \"$1\" != 'SPDisplaysDataType' ]; then exit 44; fi\nprintf 'Graphics/Displays:\\nGPU:\\n  Chipset Model: Apple M2\\n  Metal Support: Metal 3\\n  Serial Number: TEST_SECRET\\n  Device UUID: TEST_UUID\\n'\nprintf 'user=TEST_SECRET\\n' >&2\n");
        let result = fixture_probe(
            executable,
            LocalHardwareInspector::MacDisplaysProfiler,
            Duration::from_secs(1),
        );
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu.model"
                && fact.source == FactSource::Unverified));
        assert!(!result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.memory_bytes"));
        assert_eq!(result.inspector.as_deref(), Some("fixture_synthetic"));
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains("TEST_SECRET"));
        assert!(!public.contains("TEST_UUID"));
        assert!(!public.contains("system_profiler"));
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "models" && fact.confidence == FactConfidence::Unknown));
        assert!(!result.permission_granted);

        let too_large = script(&dir, "#!/bin/sh\n/usr/bin/yes AAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX &\npid=$!\n/bin/sleep 0.05\n/bin/kill \"$pid\" 2>/dev/null\n/bin/wait \"$pid\" 2>/dev/null\nexec 1>&-\nexec 2>&-\n");
        let result = fixture_probe(
            too_large,
            LocalHardwareInspector::MacDisplaysProfiler,
            Duration::from_secs(1),
        );
        assert!(
            result
                .issues
                .iter()
                .any(|issue| issue.code == "inspector_output_too_large"),
            "issues={:?}",
            result.issues
        );
        assert!(!result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu.model"));
        let secret_error = script(
            &dir,
            "#!/bin/sh\nprintf 'token=TEST_SECRET\\n' >&2\nexit 9\n",
        );
        let result = fixture_probe(
            secret_error,
            LocalHardwareInspector::MacDisplaysProfiler,
            Duration::from_secs(1),
        );
        assert_eq!(
            result
                .issues
                .iter()
                .filter(|issue| issue.code == "inspector_failed")
                .count(),
            1
        );
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("TEST_SECRET"));
        let argv_path = dir.path().join("synthetic-argv.txt");
        let bad_arguments = script(&dir, &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf 'Hardware:\\nMemory: 16 GB\\nDisplays:\\nGPU:\\nChipset Model: Apple M1\\nVRAM (Total): 8192 MB\\nMetal Support: Metal 3\\n'\n", argv_path.to_string_lossy()));
        let result = fixture_probe(
            bad_arguments,
            LocalHardwareInspector::MacSystemProfiler,
            Duration::from_secs(1),
        );
        assert_eq!(
            fs::read_to_string(&argv_path).unwrap(),
            "SPHardwareDataType\nSPDisplaysDataType\n"
        );
        assert!(result.issues.is_empty(), "issues={:?}", result.issues);
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu.model"));
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.memory_bytes"));
        assert!(result
            .facts
            .iter()
            .filter(|fact| fact.resource == "hardware.gpu.model")
            .all(|fact| fact.source == FactSource::Unverified));
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "models" && fact.confidence == FactConfidence::Unknown));
    }
    #[cfg(unix)]
    #[test]
    fn inventory_probe_fixture_missing_command_and_timeout_stay_unknown() {
        let _guard = lock();
        let dir = tempfile::tempdir().unwrap();
        let result = fixture_probe(
            dir.path().join("not-installed"),
            LocalHardwareInspector::MacDisplaysProfiler,
            Duration::from_secs(1),
        );
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.code == "fixture_executable_rejected"));
        let started = std::time::Instant::now();
        let result = fixture_probe(
            script(&dir, "#!/bin/sh\n/bin/sleep 5\n"),
            LocalHardwareInspector::MacDisplaysProfiler,
            Duration::from_millis(40),
        );
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.code == "inspector_timeout"));
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu"
                && fact.confidence == FactConfidence::Unknown));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!result
            .facts
            .iter()
            .any(|fact| fact.resource == "hardware.gpu.model"));
        let stderr = script(&dir, "#!/bin/sh\n/usr/bin/yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA >&2 &\npid=$!\n/bin/sleep 0.05\n/bin/kill \"$pid\" 2>/dev/null\n/bin/wait \"$pid\" 2>/dev/null\nexec 1>&-\nexec 2>&-\n");
        let result = fixture_probe(
            stderr,
            LocalHardwareInspector::MacDisplaysProfiler,
            Duration::from_secs(1),
        );
        assert!(
            result
                .issues
                .iter()
                .any(|issue| issue.code == "inspector_stderr_too_large"),
            "issues={:?}",
            result.issues
        );
    }
    #[test]
    #[ignore = "requires explicit LOOM_ENABLE_LOCAL_HARDWARE_PROBE=1 on this one macOS"]
    fn inventory_probe_actual_macos_once() {
        let _guard = lock();
        if std::env::consts::OS != "macos"
            || std::env::var_os(LOCAL_HARDWARE_ENV).as_deref() != Some("1".as_ref())
        {
            println!(
                "NOT RUN: actual macOS probe requires explicit LOOM_ENABLE_LOCAL_HARDWARE_PROBE=1"
            );
            return;
        }
        let result = probe_local_hardware(
            &LocalProbeRequest {
                host_id: "this-physical-macos".into(),
                inspector: LocalHardwareInspector::MacDisplaysProfiler,
            },
            Utc::now(),
        );
        let public = serde_json::to_string(&result).unwrap();
        for blocked in [
            "serial",
            "uuid",
            "user",
            "resolution",
            "bus",
            "/Users",
            "token",
        ] {
            assert!(
                !public.contains(blocked),
                "public observation includes disallowed field {blocked}"
            );
        }
        assert_eq!(result.source, FactSource::ControllerProbed);
        assert!(result
            .facts
            .iter()
            .any(|fact| fact.resource == "models" && fact.confidence == FactConfidence::Unknown));
        assert!(!result.permission_granted);
        println!("{public}");
    }

    #[test]
    fn inventory_probe_bounded_reader_bounds_bytes_and_stderr() {
        let _guard = lock();
        let source = vec![b'x'; MAX_PROBE_BYTES + 1];
        let (stdout, overflow) = drain_bounded(source.as_slice(), MAX_PROBE_BYTES);
        assert!(stdout.len() <= MAX_PROBE_BYTES);
        assert!(overflow);
        let (stderr, stderr_overflow) = drain_bounded("TEST_SECRET\n".as_bytes(), 4);
        assert!(stderr_overflow);
        let public = format!("{stdout:?}{stderr:?}");
        assert!(!public.contains("SECRET"));
    }
}
