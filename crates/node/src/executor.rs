use crate::binding::canonical_host_root;
use crate::state::StateStore;
use crate::storage::{atomic_json, atomic_write};
use crate::wire::{digest_json, Assignment};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_FILE_BYTES: u64 = 1_048_576;

/// A controller-selected immutable parent whose transport and assignment scope
/// were validated before this value was constructed. The executor independently
/// checks this local reference against the exact bytes used for the trim.
pub struct VerifiedArtifactInput {
    parent: Value,
    bytes: Vec<u8>,
}

impl VerifiedArtifactInput {
    pub fn new(assignment: &Assignment, parent_reference: &Value, bytes: Vec<u8>) -> Result<Self> {
        let parent = parent_reference
            .as_object()
            .context("verified parent ArtifactRef must be an object")?;
        if assignment.kind != "edit_file" {
            bail!("verified parent input requires an edit_file Assignment");
        }
        if parent.len() != 7
            || parent_reference["type"] != "artifact_ref"
            || parent_reference["parents"] != json!([])
        {
            bail!("verified parent ArtifactRef must have exactly the bounded source shape");
        }
        let artifact_id = parent_reference["artifact_id"]
            .as_str()
            .context("verified parent artifact_id is required")?;
        let artifact_id =
            Uuid::parse_str(artifact_id).context("verified parent artifact_id must be a UUID")?;
        if parent_reference["artifact_id"] != json!(artifact_id.to_string())
            || parent_reference["location"] != json!(format!("loom://artifact/{artifact_id}"))
        {
            bail!("verified parent ArtifactRef has an invalid immutable identity or location");
        }
        let ticket_id = parent_reference["ticket_id"]
            .as_str()
            .context("verified parent producer Ticket is required")?;
        if ticket_id.is_empty() || ticket_id.len() > 160 || ticket_id == assignment.ticket_id {
            bail!("verified parent producer Ticket is outside the child lineage");
        }
        let sha256 = parent_reference["sha256"]
            .as_str()
            .context("verified parent SHA-256 is required")?;
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || sha256_hex(&bytes) != sha256
        {
            bail!("verified parent bytes do not match the immutable SHA-256");
        }
        let origin = parent_reference["origin_node_id"]
            .as_str()
            .context("verified parent origin Node is required")?;
        if origin.len() != 64
            || !origin
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("verified parent origin Node identity is invalid");
        }
        if verified_trim(&bytes)?.is_empty() {
            bail!("verified parent trim must produce a non-empty destination");
        }
        Ok(Self {
            parent: parent_reference.clone(),
            bytes,
        })
    }

    pub fn parent_reference(&self) -> &Value {
        &self.parent
    }
}

/// Only direct transport may create `VerifiedArtifactInput`. Passing no such
/// value preserves the original rejection of Assignment `artifact_input`.
// The direct transport integration is the production caller of this narrow gate.
#[allow(dead_code)]
pub(crate) fn execute_with_verified_input(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
    cancellation: Option<&std::sync::atomic::AtomicBool>,
    verified_input: Option<VerifiedArtifactInput>,
) -> Result<Value> {
    execute_checked(
        assignment,
        artifact_dir,
        state,
        cancellation,
        verified_input,
    )
}

fn verified_trim(bytes: &[u8]) -> Result<String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        bail!("verified parent exceeds 1 MiB");
    }
    let text = std::str::from_utf8(bytes).context("verified parent is not strict UTF-8")?;
    // ECMAScript includes BOM/ZWNBSP in WhiteSpace; Rust's trim does not. The
    // fixed protocol follows the already deployed TS `String.trim()` exactly.
    let text = text.trim_matches(|character: char| {
        matches!(
            character,
            '\u{0009}'
                | '\u{000a}'
                | '\u{000b}'
                | '\u{000c}'
                | '\u{000d}'
                | '\u{0020}'
                | '\u{00a0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    });
    // Do not pass this through `DocumentEdit::TextTransform::Trim` again: its
    // standard Unicode predicate also strips NEL (U+0085) and MVS (U+180E).
    Ok(text.to_owned())
}

pub fn execute(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
) -> Result<Value> {
    execute_checked(assignment, artifact_dir, state, None, None)
}

pub fn execute_cancellable(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
    cancellation: &std::sync::atomic::AtomicBool,
) -> Result<Value> {
    execute_checked(assignment, artifact_dir, state, Some(cancellation), None)
}

fn execute_checked(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
    cancellation: Option<&std::sync::atomic::AtomicBool>,
    verified_input: Option<VerifiedArtifactInput>,
) -> Result<Value> {
    // The reference is already immutable inside the opt-in value, but repeat its
    // local integrity check at the execution boundary before any ledger write.
    if let Some(input) = verified_input.as_ref() {
        if sha256_hex(&input.bytes) != input.parent["sha256"]
            || input.parent["ticket_id"] == json!(assignment.ticket_id)
        {
            bail!("verified parent integrity or producer Ticket is invalid");
        }
    } else if assignment.raw.get("artifact_input").is_some() {
        bail!("Bare host does not accept unvalidated ArtifactInput; use a supporting documented adapter");
    }
    // Derive the written bytes solely from parent content, never replacement content.
    let direct_content = verified_input
        .as_ref()
        .map(|input| verified_trim(&input.bytes))
        .transpose()?;
    let direct_content = direct_content.as_deref().map(str::as_bytes);
    let root = canonical_host_root(&assignment.binding_root, "approved project root")?;
    let read_only = matches!(
        assignment.kind.as_str(),
        "read_summary" | "model_descriptor"
    );
    let effect_id = Uuid::new_v4();
    let artifact_id = Uuid::new_v4();
    let input = json!({"assignment_id":assignment.id,"kind":assignment.kind,"relative_path":assignment.relative_path,"content":assignment.content});
    let input_digest = if assignment.kind == "model_descriptor" {
        crate::model_descriptor::assignment_input_digest(&assignment.id)?
    } else {
        digest_json(&input)
    };
    let target = controlled_target(
        &root,
        &assignment.relative_path,
        assignment.kind == "edit_file",
    )?;
    let evidence = json!({"effect_id":effect_id,"artifact_id":artifact_id,"target_sha256":Value::Null,"input_digest":input_digest});
    atomic_json(
        &artifact_dir.join(format!("{effect_id}.effect.json")),
        &json!({"schema":"loom.effect-ledger.v1","status":"recorded","read_only":read_only,"target":assignment.relative_path,"assignment_id":assignment.id,"evidence":evidence}),
    )?;
    let execution = (|| -> Result<Vec<u8>> {
        if cancellation.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire)) {
            bail!("cancellation observed before reading the project file");
        }
        if assignment.kind == "read_summary" {
            let bytes = read_regular_bounded(&target)?;
            reconfirm_root(&root)?;
            Ok(summarize(&bytes, &assignment.relative_path))
        } else if assignment.kind == "model_descriptor" {
            let bytes = read_descriptor_bounded(&target)?;
            let proof = crate::model_descriptor::proof(&bytes)?;
            reconfirm_root(&root)?;
            Ok(proof)
        } else if assignment.kind == "edit_file" {
            let content = match direct_content {
                Some(content) => content,
                None => assignment
                    .content
                    .as_deref()
                    .context("edit content is required")?
                    .as_bytes(),
            };
            if content.len() as u64 > MAX_FILE_BYTES {
                bail!("edit content exceeds 1 MiB");
            }
            let parent = target.parent().context("controlled target has no parent")?;
            // Validate existing target before copying any bytes, then a same-directory
            // rename atomically replaces the exact project-relative path.
            let previous = read_existing_for_replace(&target)?;
            let temporary = parent.join(format!(
                ".loom-node-{}-{}.tmp",
                std::process::id(),
                Uuid::new_v4()
            ));
            let mut file = create_private_file(&temporary)?;
            let mut moved = false;
            let result = (|| -> Result<()> {
                if cancellation.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
                {
                    bail!("cancellation observed before the project file was replaced");
                }
                file.write_all(content)?;
                file.sync_all()?;
                if fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
                    bail!("target changed to a symlink");
                }
                fs::rename(&temporary, &target)?;
                moved = true;
                reconfirm_root(&root)?;
                atomic_json(
                    &artifact_dir.join(format!("{effect_id}.effect.json")),
                    &json!({"schema":"loom.effect-ledger.v1","status":"unknown","read_only":false,
                    "assignment_id":assignment.id,"target":assignment.relative_path,"previous_present":previous.is_some(),
                    "previous_sha256":previous.as_ref().map(|v|sha256_hex(v)),"evidence":{"effect_id":effect_id,"artifact_id":artifact_id,"input_digest":input_digest,"target_sha256":sha256_hex(content)}}),
                )?;
                Ok(())
            })();
            if !moved {
                let _ = fs::remove_file(&temporary);
            }
            result?;
            let evidence = summarize_json(
                assignment,
                &assignment.relative_path,
                content.len(),
                &[
                    ("operation", json!("replaced_project_file")),
                    ("target_hash", json!(sha256_hex(content))),
                ],
            );
            Ok(evidence)
        } else {
            bail!("unsupported deterministic operation")
        }
    })();
    if cancellation.is_none() && assignment.cancel_requested {
        state.set_cancel_requested(&assignment.id, true)?;
        let completion = cancel_before_effect(assignment, state)?;
        return Ok(completion);
    }
    // There is no general interruption API for a filesystem effect. Once polling
    // observes cancellation, runner may only report cancelled before execution;
    // completed/racing effects remain unknown rather than being rolled back.
    let content = match execution {
        Ok(content) => content,
        Err(error) => {
            let effect = json!({"effect_id":effect_id,"status":"unknown","evidence":[{"kind":"local_effect_ledger","digest":input_digest},{"kind":"reason","detail":error.to_string()}],"artifacts":[]});
            let mut body = assignment.envelope(
                &Uuid::new_v4().to_string(),
                &assignment.node_id,
                &assignment.installation_id,
            );
            body.insert("requested_state".into(), json!("unknown"));
            body.insert("state".into(), json!("unknown"));
            body.insert("status".into(), json!("unknown"));
            body.insert(
                "summary".into(),
                json!(format!(
                    "Local deterministic execution failed before a confirmed outcome: {error}"
                )),
            );
            body.insert("report_id".into(), json!(Uuid::new_v4()));
            body.insert("sequence".into(), json!(1));
            body.insert("created_at".into(), json!(chrono::Utc::now()));
            body.insert(
                "cancel_acknowledged".into(),
                json!(assignment.cancel_requested),
            );
            body.insert("artifacts".into(), json!([]));
            body.insert("artifact_ids".into(), json!([]));
            body.insert("effects".into(), json!([effect]));
            body.insert(
                "evidence".into(),
                json!([{"kind":"deterministic_executor","detail":error.to_string()}]),
            );
            state.enqueue("report", Value::Object(body))?;
            let completion = json!({"assignment_id":assignment.id,"digest":assignment.logical_digest(),"state":"unknown",
            "summary":format!("Local execution outcome is unknown: {error}"),"artifacts":[],"effects":[{"effect_id":effect_id,"status":"unknown"}],"report_enqueued":true,"cancel_acknowledged":assignment.cancel_requested});
            state.complete(&assignment.id, completion.clone())?;
            return Ok(completion);
        }
    };
    if content.is_empty() || content.len() as u64 > MAX_FILE_BYTES {
        bail!("artifact is outside the supported inline bounds");
    }
    let digest = sha256_hex(&content);
    let path = artifact_dir.join(format!("{artifact_id}.bin"));
    atomic_write(&path, &content)?;
    let mut reference = json!({"schema":"loom.artifact.v1","artifact_id":artifact_id,"ticket_id":assignment.ticket_id,"assignment_id":assignment.id,
        "origin_node_id":assignment.node_id,"location":format!("loom://artifact/{artifact_id}"),"name":format!("{}-{artifact_id}.json",assignment.kind),
        "media_type":"application/json","size_bytes":content.len(),"sha256":digest,"parents":[],"evidence":[]});
    if let Some(input) = verified_input.as_ref() {
        reference["parents"] = json!([input.parent["artifact_id"]]);
        reference["artifact_ref"] = input.parent.clone();
    }
    validate_generated_artifact_ref(
        &reference,
        artifact_id,
        content.len(),
        &digest,
        assignment,
        verified_input.as_ref(),
    )?;
    let mut upload = assignment.envelope(
        &Uuid::new_v4().to_string(),
        &assignment.node_id,
        &assignment.installation_id,
    );
    upload.insert("artifact_id".into(), json!(artifact_id));
    upload.insert("metadata".into(), reference.clone());
    upload.insert("bytes_base64".into(), json!(STANDARD.encode(&content)));
    state.enqueue("artifact", Value::Object(upload))?;
    let effect = json!({"effect_id":effect_id,"ticket_id":assignment.ticket_id,"assignment_id":assignment.id,"node_id":assignment.node_id,
        "attempt":assignment.attempt,"input_digest":input_digest,"status":"confirmed","evidence":[{"kind":"artifact","digest":digest}],
        "artifacts":[artifact_id]});
    atomic_json(
        &artifact_dir.join(format!("{effect_id}.effect.json")),
        &json!({"schema":"loom.effect-ledger.v1","status":"confirmed","read_only":read_only,
        "assignment_id":assignment.id,"target":assignment.relative_path,"artifact_id":artifact_id,"effect":effect}),
    )?;
    let mut body = assignment.envelope(
        &Uuid::new_v4().to_string(),
        &assignment.node_id,
        &assignment.installation_id,
    );
    body.insert("requested_state".into(), json!("succeeded"));
    body.insert("state".into(), json!("succeeded"));
    body.insert("status".into(), json!("succeeded"));
    body.insert(
        "summary".into(),
        json!(format!(
            "{} completed deterministically without calling a model.",
            assignment.kind
        )),
    );
    body.insert("report_id".into(), json!(Uuid::new_v4()));
    body.insert("sequence".into(), json!(1));
    body.insert("created_at".into(), json!(chrono::Utc::now()));
    body.insert(
        "cancel_acknowledged".into(),
        json!(assignment.cancel_requested),
    );
    body.insert("artifacts".into(), json!([reference]));
    body.insert("artifact_ids".into(), json!([artifact_id]));
    body.insert("effects".into(), json!([effect]));
    body.insert(
        "evidence".into(),
        json!([{"kind":"artifact","digest":digest}]),
    );
    // Never claim success when cancellation already arrived. The artifact stays
    // available as evidence, but an unknown outcome cannot promote an effect confirmed.
    if assignment.cancel_requested {
        let unknown_effect = json!({"effect_id":effect_id,"ticket_id":assignment.ticket_id,"assignment_id":assignment.id,"node_id":assignment.node_id,
            "attempt":assignment.attempt,"input_digest":input_digest,"status":"unknown","evidence":[{"kind":"artifact","digest":digest}],"artifacts":[artifact_id]});
        body.insert("effects".into(), json!([unknown_effect]));
        body.insert("requested_state".into(), json!("unknown"));
        body.insert("state".into(), json!("unknown"));
        body.insert("status".into(), json!("unknown"));
        body.insert(
            "summary".into(),
            json!("Cancellation raced with a completed effect; reconciliation is required."),
        );
    }
    let completed_effects = body["effects"].clone();
    state.enqueue("report", Value::Object(body))?;
    let final_state = if assignment.cancel_requested {
        "unknown"
    } else {
        "succeeded"
    };
    let completion = json!({"assignment_id":assignment.id,"digest":assignment.logical_digest(),"state":final_state,
        "summary":if final_state=="unknown"{"Cancellation raced with a completed effect; reconciliation is required."}else{"Deterministic operation completed."},
        "artifacts":[artifact_id],"effects":completed_effects,"report_enqueued":true,"cancel_acknowledged":assignment.cancel_requested});
    let mut response = completion.clone();
    response["report_body_state"] = json!(final_state);
    response["effect"] = effect;
    state.complete(&assignment.id, completion)?;
    Ok(response)
}

/// A direct transfer that cannot be verified never falls through to ordinary
/// `edit_file` execution. Persist this transport/integrity ambiguity explicitly:
/// no destination or Artifact bytes are created, and replaying the original
/// Assignment only attempts delivery of this exact Report. It is not `failed`
/// (which would invite a new blind attempt) and it does not assert zero effect.
pub fn record_direct_unknown(
    assignment: &Assignment,
    state: &mut StateStore,
    error: &anyhow::Error,
) -> Result<Value> {
    if assignment.kind != "edit_file"
        || assignment.content.is_some()
        || assignment.raw["artifact_input"]["direct_offer"] != true
    {
        bail!("direct transport unknown requires the original fixed direct Assignment");
    }
    let detail = error
        .to_string()
        .replace(char::is_control, " ")
        .chars()
        .take(1000)
        .collect::<String>();
    if detail.is_empty() {
        bail!("direct transport unknown requires a bounded explanation");
    }
    let effect_id = Uuid::new_v4();
    let mut body = assignment.envelope(
        &Uuid::new_v4().to_string(),
        &assignment.node_id,
        &assignment.installation_id,
    );
    for key in ["requested_state", "state", "status"] {
        body.insert(key.to_owned(), json!("unknown"));
    }
    body.insert(
        "summary".into(),
        json!(format!("Direct Artifact handoff could not be verified; no ordinary edit fallback was executed: {detail}")),
    );
    body.insert("report_id".into(), json!(Uuid::new_v4()));
    body.insert("sequence".into(), json!(1));
    body.insert("created_at".into(), json!(chrono::Utc::now()));
    body.insert("cancel_acknowledged".into(), json!(false));
    body.insert("artifacts".into(), json!([]));
    body.insert("artifact_ids".into(), json!([]));
    body.insert(
        "effects".into(),
        json!([{"effect_id":effect_id,"ticket_id":assignment.ticket_id,"assignment_id":assignment.id,
            "node_id":assignment.node_id,"attempt":assignment.attempt,"input_digest":assignment.logical_digest(),
            "status":"unknown","evidence":[{"kind":"direct_handoff_unverified","detail":detail}],"artifacts":[]}]),
    );
    body.insert(
        "evidence".into(),
        json!([{"kind":"direct_handoff_unverified","detail":detail,
            "ordinary_executor_fallback":false,"outcome":"requires_reconciliation"}]),
    );
    state.enqueue("report", Value::Object(body))?;
    let completion = json!({"assignment_id":assignment.id,"digest":assignment.logical_digest(),
        "state":"unknown","summary":"Direct Artifact handoff remains unknown; retained original evidence only.",
        "artifacts":[],"effects":[{"effect_id":effect_id,"status":"unknown","input_digest":assignment.logical_digest(),"artifacts":[]}],
        "report_enqueued":true,"cancel_acknowledged":false,
        "evidence":[{"kind":"direct_handoff_unverified","ordinary_executor_fallback":false}]});
    state.complete(&assignment.id, completion.clone())?;
    Ok(completion)
}

pub fn cancel_before_effect(assignment: &Assignment, state: &mut StateStore) -> Result<Value> {
    cancelled_before_start(assignment, state)
}

/// Called only after the center positively confirmed the cancellation intent and
/// the lease had already passed local grant/binding checks. Unknown/revoked/expired
/// signals are handled as reconciliation evidence instead of fabricating an ack.
pub fn cancelled_before_start(assignment: &Assignment, state: &mut StateStore) -> Result<Value> {
    let mut body = assignment.envelope(
        &Uuid::new_v4().to_string(),
        &assignment.node_id,
        &assignment.installation_id,
    );
    for key in ["requested_state", "state", "status"] {
        body.insert(key.to_owned(), json!("cancelled"));
    }
    body.insert("summary".into(), json!("Confirmed cancellation intent observed after local authorization but before any file effect started."));
    body.insert("report_id".into(), json!(Uuid::new_v4()));
    body.insert("sequence".into(), json!(1));
    body.insert("created_at".into(), json!(chrono::Utc::now()));
    body.insert("cancel_acknowledged".into(), json!(true));
    body.insert("artifacts".into(), json!([]));
    body.insert("artifact_ids".into(), json!([]));
    body.insert(
        "evidence".into(),
        json!([{"kind":"cancel_before_execution","assignment_id":assignment.id}]),
    );
    body.insert("effects".into(), json!([{"effect_id":Uuid::new_v4(),"input_digest":assignment.logical_digest(),"status":"unknown","evidence":[{"kind":"cancel_before_execution"}]}]));
    state.enqueue("report", Value::Object(body))?;
    let completion = json!({"assignment_id":assignment.id,"digest":assignment.logical_digest(),"state":"cancelled",
        "summary":"Confirmed cancellation before a local file effect.","artifacts":[],"effects":[],"report_enqueued":true,"cancel_acknowledged":true});
    state.complete(&assignment.id, completion.clone())?;
    Ok(completion)
}

fn validate_generated_artifact_ref(
    reference: &Value,
    artifact_id: Uuid,
    length: usize,
    digest: &str,
    assignment: &Assignment,
    verified_input: Option<&VerifiedArtifactInput>,
) -> Result<()> {
    if reference["schema"] != "loom.artifact.v1"
        || reference["artifact_id"] != json!(artifact_id)
        || reference["ticket_id"] != json!(assignment.ticket_id)
        || reference["assignment_id"] != json!(assignment.id)
        || reference["origin_node_id"] != json!(assignment.node_id)
        || reference["location"].as_str() != Some(&format!("loom://artifact/{artifact_id}"))
        || reference["media_type"] != "application/json"
        || reference["size_bytes"].as_u64() != Some(length as u64)
        || reference["sha256"].as_str() != Some(digest)
        || reference["evidence"] != json!([])
        || reference["name"]
            .as_str()
            .is_none_or(|name| name.is_empty() || name.len() > 200)
    {
        bail!("generated artifact lineage, digest or controlled URI is invalid");
    }
    let (parents, artifact_ref) = match verified_input {
        Some(input) => (json!([input.parent["artifact_id"]]), input.parent.clone()),
        None => (json!([]), Value::Null),
    };
    if reference["parents"] != parents {
        bail!("generated artifact lineage, digest or controlled URI is invalid");
    }
    match artifact_ref {
        Value::Null => {
            // Preserve the legacy inline bytes/payload-substitution wire shape:
            // absence and an explicit parent:null are not equivalent.
            if reference.get("artifact_ref").is_some() {
                bail!("ordinary generated Artifact must not gain a parent reference");
            }
        }
        parent => {
            if reference.get("artifact_ref") != Some(&parent) {
                bail!("direct generated Artifact parent reference is missing or changed");
            }
        }
    }
    Ok(())
}

fn summarize(content: &[u8], path: &str) -> Vec<u8> {
    let text = String::from_utf8_lossy(content);
    let lines: Vec<Value> = text
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .take(20)
        .map(|line| Value::String(line.chars().take(200).collect()))
        .collect();
    // JSON string escaping makes arbitrary UTF-8 input deterministic and bounded by
    // the input cap; no language model or source-code execution is involved.
    serde_json::to_vec_pretty(
        &json!({"schema":"loom.synthetic_summary.v1","path":path,"byte_length":content.len(),
        "input_sha256":sha256_hex(content),
        "line_count":if content.is_empty(){0}else{text.split('\n').count()},"lines":lines}),
    )
    .unwrap_or_else(|_| b"{\"error\":\"summary_encoding_failed\"}".to_vec())
}
fn summarize_json(
    assignment: &Assignment,
    path: &str,
    length: usize,
    extras: &[(&str, Value)],
) -> Vec<u8> {
    let mut object = Map::new();
    object.insert("path".into(), json!(path));
    object.insert("kind".into(), json!(assignment.kind));
    for (key, value) in extras {
        object.insert(key.to_string(), value.clone());
    }
    let _ = length;
    serde_json::to_vec(&Value::Object(object)).expect("small object")
}
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn controlled_target(root: &Path, relative: &str, create: bool) -> Result<PathBuf> {
    let parsed = loom_protocol::RelativePath::parse(relative.to_owned())?;
    if parsed.as_str().len() > 1000 {
        bail!("relative path too long");
    }
    let mut current = root.to_owned();
    let parts: Vec<&str> = relative.split('/').collect();
    for component in &parts[..parts.len() - 1] {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                bail!("project path component is a symlink or non-directory")
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                fs::create_dir(&current)?
            }
            Err(error) => return Err(error.into()),
        }
    }
    if current.canonicalize()? != current {
        bail!("project parent was redirected through a symlink");
    }
    let target = current.join(parts[parts.len() - 1]);
    if target.file_name().is_none() {
        bail!("relative filename is empty");
    }
    Ok(target)
}
fn read_descriptor_bounded(path: &Path) -> Result<Vec<u8>> {
    const LIMIT: u64 = crate::model_descriptor::MAX_DESCRIPTOR_BYTES as u64;
    fn checked(metadata: &fs::Metadata, expected: Option<u64>) -> Result<u64> {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("descriptor source must be an ordinary non-link file");
        }
        let size = metadata.len();
        if !(1..=LIMIT).contains(&size) || expected.is_some_and(|before| before != size) {
            bail!("descriptor source exceeds its byte budget or changed size while open");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                bail!("descriptor source cannot be a hard link");
            }
        }
        Ok(size)
    }
    let proposed = checked(&fs::symlink_metadata(path)?, None)?;
    let file = fs::File::open(path)?;
    let opened = file.metadata()?;
    let size = checked(&opened, Some(proposed))?;
    let mut bytes = Vec::with_capacity(size as usize);
    (&file).take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size {
        bail!("descriptor source changed its readable content length while open");
    }
    checked(&file.metadata()?, Some(size))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let initial = fs::symlink_metadata(path)?;
        if initial.ino() != opened.ino() || initial.dev() != opened.dev() {
            bail!("descriptor file identity changed while reading");
        }
    }
    checked(&fs::symlink_metadata(path)?, Some(size))?;
    if path.canonicalize()? != path {
        bail!("descriptor source was replaced by a redirected path");
    }
    Ok(bytes)
}

fn read_regular_bounded(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).context("project target is not accessible")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || (metadata.len() as u64) > MAX_FILE_BYTES
    {
        bail!("only ordinary files up to 1 MiB may be read");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            bail!("hard-linked project targets are not controlled");
        }
    }
    let file = fs::File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        bail!("file exceeded 1 MiB while reading");
    }
    Ok(bytes)
}
fn read_existing_for_replace(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(_) => read_regular_bounded(path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
fn reconfirm_root(root: &Path) -> Result<()> {
    if canonical_host_root(root, "approved project root")? != root {
        bail!("project root changed during execution");
    }
    Ok(())
}
fn create_private_file(path: &Path) -> Result<fs::File> {
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_dir(path: &Path, label: &str) {
        crate::binding::prepare_owned_directory(path, label).unwrap();
    }

    fn assignment() -> Assignment {
        let project = std::env::temp_dir();
        let binding = json!({"project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","root_scope":project});
        let binding_digest = digest_json(&binding);
        let grant = json!({"id":"grant_1","project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","binding":binding_digest,"operations":["read","write"],"version":1});
        let grant_digest = digest_json(&grant);
        let raw = json!({"id":"asg_abc","ticket_id":"tkt_1","project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","attempt":1,"lease_id":"lease_1","lease_epoch":1,"lease_expires_at":(chrono::Utc::now()+chrono::Duration::seconds(30)).to_rfc3339(),"grant_digest":grant_digest,"grant_version":1,"kind":"edit_file","relative_path":"out.txt","content":"irrelevant caller content","status":"running","grant_status":true,"grant":{"id":"grant_1","project_id":"project_alpha","node_id":"a".repeat(64),"installation_id":"installation-one","worker_id":"default","operations":["read","write"],"version":1,"digest":grant_digest,"project_binding_id":"binding_1","created_at":chrono::Utc::now().to_rfc3339(),"revoked_at":null,"project_root":project},"resource":binding});
        Assignment::decode(
            &raw,
            &"a".repeat(64),
            "installation-one",
            &project,
            chrono::Utc::now(),
        )
        .unwrap()
    }

    fn reference(bytes: &[u8]) -> Value {
        let id = Uuid::new_v4();
        json!({"type":"artifact_ref","artifact_id":id,"ticket_id":"tkt_parent","sha256":sha256_hex(bytes),"origin_node_id":"b".repeat(64),"location":format!("loom://artifact/{id}"),"parents":[]})
    }

    #[test]
    fn verified_parent_requires_exact_bytes_reference_and_bounded_utf8_trim() {
        let assignment = assignment();
        let bytes = b"\x20{\"schema\":\"loom.synthetic_summary.v1\",\"lines\":[\"Heading\", \"internal  spacing\"]}\xc2\xa0\n";
        let expected = "{\n  \"schema\": \"loom.synthetic_summary.v1\",\n  \"lines\": [\"Heading\", \"internal  spacing\"]\n}";
        let original =
            serde_json::from_slice::<Value>(&verified_trim(bytes).unwrap().into_bytes()).unwrap();
        assert_eq!(original["lines"][0], "Heading");
        assert_eq!(original["lines"][1], "internal  spacing");
        assert_eq!(verified_trim("\u{00a0}x\u{00a0}".as_bytes()).unwrap(), "x");
        assert_eq!(
            verified_trim("a  b\tc\nd".as_bytes()).unwrap(),
            "a  b\tc\nd"
        );
        assert!(VerifiedArtifactInput::new(
            &assignment,
            &reference(bytes),
            expected.as_bytes().to_vec()
        )
        .is_err());
        assert!(VerifiedArtifactInput::new(&assignment, &reference(&[0xff]), vec![0xff]).is_err());
        assert!(
            VerifiedArtifactInput::new(&assignment, &reference(b"  \n"), b"  \n".to_vec()).is_err()
        );
        assert!(VerifiedArtifactInput::new(
            &assignment,
            &reference(b"x"),
            vec![0; MAX_FILE_BYTES as usize + 1]
        )
        .is_err());
        for value in [Value::Null, json!([]), json!("x")] {
            assert!(VerifiedArtifactInput::new(&assignment, &value, bytes.to_vec()).is_err());
        }
        for (key, value) in [
            ("type", json!("other")),
            ("artifact_id", json!("not-a-uuid")),
            ("ticket_id", json!(assignment.ticket_id)),
            ("sha256", json!("0".repeat(64))),
            ("origin_node_id", json!("not-a-node")),
            (
                "location",
                json!("loom://artifact/00000000-0000-0000-0000-000000000000"),
            ),
            ("parents", json!([Uuid::new_v4().to_string()])),
        ] {
            let mut altered = reference(bytes);
            altered[key] = value;
            assert!(
                VerifiedArtifactInput::new(&assignment, &altered, bytes.to_vec()).is_err(),
                "{key}"
            );
            let mut missing = reference(bytes);
            missing.as_object_mut().unwrap().remove(key).unwrap();
            assert!(
                VerifiedArtifactInput::new(&assignment, &missing, bytes.to_vec()).is_err(),
                "missing {key}"
            );
        }
    }

    #[test]
    fn opt_in_path_derives_trim_and_lineage_before_legacy_rejection() {
        let dirs = tempfile::tempdir().unwrap();
        let project = dirs.path().join("project");
        private_dir(&project, "test project");
        let artifacts = dirs.path().join("artifacts");
        private_dir(&artifacts, "test artifacts");
        private_dir(&dirs.path().join("state"), "test state");
        let mut state = StateStore::open(&dirs.path().join("state")).unwrap();
        let mut assignment = assignment();
        assignment.binding_root = project.clone();
        assignment.raw["artifact_input"] = json!({"artifact_ref":{"arbitrary":"raw HTTP value"}});
        assignment.content = Some("untrusted caller replacement".into());
        let bytes = b" \n{\"lines\":[\"Heading\",\"keep  internal\"]}\t";
        let parent = reference(bytes);
        let parent_id = parent["artifact_id"].clone();
        let input = VerifiedArtifactInput::new(&assignment, &parent, bytes.to_vec()).unwrap();
        let result =
            execute_with_verified_input(&assignment, &artifacts, &mut state, None, Some(input))
                .unwrap();
        assert_eq!(result["state"], "succeeded");
        assert_eq!(
            fs::read_to_string(project.join("out.txt")).unwrap(),
            "{\"lines\":[\"Heading\",\"keep  internal\"]}"
        );
        let artifact_id = result["artifacts"][0].as_str().unwrap();
        let proof: Value = serde_json::from_slice(
            &fs::read(artifacts.join(format!("{artifact_id}.bin"))).unwrap(),
        )
        .unwrap();
        assert_eq!(proof["path"], "out.txt");
        assert_eq!(proof["kind"], "edit_file");
        assert_eq!(proof["operation"], "replaced_project_file");
        assert_eq!(
            proof["target_hash"],
            sha256_hex(&verified_trim(bytes).unwrap().into_bytes())
        );
        assert_ne!(proof["target_hash"], parent["sha256"]);
        assert_eq!(
            state.data.outbox[0].body["metadata"]["artifact_ref"],
            parent
        );
        assert_eq!(
            state.data.outbox[0].body["metadata"]["parents"],
            json!([parent_id])
        );
        assert_eq!(state.data.outbox[0].body["metadata"]["evidence"], json!([]));
    }

    #[test]
    fn tampered_or_non_utf8_parent_has_no_destination_or_artifact_effect() {
        for bytes in [b"parent bytes changed".as_slice(), &[0xff, 0xfe]] {
            let dirs = tempfile::tempdir().unwrap();
            let project = dirs.path().join("project");
            private_dir(&project, "test project");
            let artifacts = dirs.path().join("artifacts");
            private_dir(&artifacts, "test artifacts");
            private_dir(&dirs.path().join("state"), "test state");
            let mut state = StateStore::open(&dirs.path().join("state")).unwrap();
            let mut assignment = assignment();
            assignment.binding_root = project.clone();
            assignment.raw["artifact_input"] = json!({"arbitrary":"legacy value"});
            assert!(VerifiedArtifactInput::new(
                &assignment,
                &reference(b"original"),
                bytes.to_vec()
            )
            .is_err());
            let outcome =
                execute_with_verified_input(&assignment, &artifacts, &mut state, None, None)
                    .unwrap_err();
            assert!(outcome.to_string().contains("unvalidated ArtifactInput"));
            assert!(!project.join("out.txt").exists());
            assert_eq!(fs::read_dir(&artifacts).unwrap().count(), 0);
            assert!(state.data.outbox.is_empty());
        }
    }

    #[test]
    fn legacy_execute_never_turns_raw_input_into_a_parent() {
        let dirs = tempfile::tempdir().unwrap();
        let project = dirs.path().join("project");
        private_dir(&project, "test project");
        let artifacts = dirs.path().join("artifacts");
        private_dir(&artifacts, "test artifacts");
        private_dir(&dirs.path().join("state"), "test state");
        let mut state = StateStore::open(&dirs.path().join("state")).unwrap();
        let mut assignment = assignment();
        assignment.binding_root = project.clone();
        let bytes = b"  parent source  ";
        assignment.raw["artifact_input"] =
            json!({"artifact_ref":reference(bytes),"bytes_base64":STANDARD.encode(bytes)});
        assert!(execute(&assignment, &artifacts, &mut state).is_err());
        assert!(!project.join("out.txt").exists());
        assert_eq!(fs::read_dir(&artifacts).unwrap().count(), 0);
        assert!(state.data.outbox.is_empty());
    }

    #[test]
    fn ordinary_execute_preserves_original_content_and_absent_parent_key() {
        let dirs = tempfile::tempdir().unwrap();
        let project = dirs.path().join("project");
        private_dir(&project, "test project");
        let artifacts = dirs.path().join("artifacts");
        private_dir(&artifacts, "test artifacts");
        private_dir(&dirs.path().join("state"), "test state");
        let mut state = StateStore::open(&dirs.path().join("state")).unwrap();
        let mut assignment = assignment();
        assignment.binding_root = project.clone();
        assignment.content = Some("legacy exact payload\n".to_owned());
        let original = assignment.content.clone();
        let result = execute(&assignment, &artifacts, &mut state).unwrap();
        assert_eq!(result["state"], "succeeded");
        assert_eq!(assignment.content, original);
        assert_eq!(
            fs::read_to_string(project.join("out.txt")).unwrap(),
            "legacy exact payload\n"
        );
        assert_eq!(state.data.outbox.len(), 2);
        for item in &state.data.outbox {
            assert!(item.body.get("artifact_ref").is_none());
            if item.kind == "artifact" {
                assert_eq!(item.body["metadata"]["parents"], json!([]));
                assert!(item.body["metadata"].get("artifact_ref").is_none());
            }
            if item.kind == "report" {
                assert_eq!(item.body["artifacts"][0]["parents"], json!([]));
                assert!(item.body["artifacts"][0].get("artifact_ref").is_none());
            }
        }
    }

    #[test]
    fn trim_matches_ecmascript_at_representative_unicode_boundaries() {
        for codepoint in [
            0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002,
            0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
            0x205f, 0x3000, 0xfeff,
        ] {
            let boundary = char::from_u32(codepoint).unwrap();
            assert_eq!(
                verified_trim(format!("{boundary}inside{boundary}").as_str().as_bytes()).unwrap(),
                "inside",
                "U+{codepoint:04X}"
            );
        }
        assert_eq!(
            verified_trim("\u{0085}x\u{0085}".as_bytes()).unwrap(),
            "\u{0085}x\u{0085}"
        );
        assert_eq!(
            verified_trim("\u{180e}x\u{180e}".as_bytes()).unwrap(),
            "\u{180e}x\u{180e}"
        );
        assert_eq!(
            verified_trim("\u{200b}x\u{200b}".as_bytes()).unwrap(),
            "\u{200b}x\u{200b}"
        );
    }
}
