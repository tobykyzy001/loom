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

pub fn execute(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
) -> Result<Value> {
    execute_checked(assignment, artifact_dir, state, None)
}

pub fn execute_cancellable(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
    cancellation: &std::sync::atomic::AtomicBool,
) -> Result<Value> {
    execute_checked(assignment, artifact_dir, state, Some(cancellation))
}

fn execute_checked(
    assignment: &Assignment,
    artifact_dir: &Path,
    state: &mut StateStore,
    cancellation: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Value> {
    if assignment.raw.get("artifact_input").is_some() {
        bail!("Bare host does not accept unvalidated ArtifactInput; use a supporting documented adapter");
    }
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
            let content = assignment
                .content
                .as_deref()
                .context("edit content is required")?
                .as_bytes();
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
    let reference = json!({"schema":"loom.artifact.v1","artifact_id":artifact_id,"ticket_id":assignment.ticket_id,"assignment_id":assignment.id,
        "origin_node_id":assignment.node_id,"location":format!("loom://artifact/{artifact_id}"),"name":format!("{}-{artifact_id}.json",assignment.kind),
        "media_type":"application/json","size_bytes":content.len(),"sha256":digest,"parents":[],"evidence":[]});
    validate_generated_artifact_ref(&reference, artifact_id, content.len(), &digest, assignment)?;
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
        || reference["parents"] != json!([])
        || reference["evidence"] != json!([])
        || reference["name"]
            .as_str()
            .is_none_or(|name| name.is_empty() || name.len() > 200)
    {
        bail!("generated artifact lineage, digest or controlled URI is invalid");
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
