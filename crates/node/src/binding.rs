use crate::storage::{ensure_private_directory, read_json};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Debug)]
pub struct Binding {
    pub project_id: String,
    pub root: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub struct Bindings {
    entries: BTreeMap<String, PathBuf>,
}

impl Bindings {
    /// CLI syntax is project_id=/absolute/approved/root and is repeatable.
    /// The optional bindings file is deliberately root > project_id: a broad root
    /// cannot be selected by guessing a logical project id.
    pub fn load(cli_roots: &[String], bindings_file: Option<&Path>) -> Result<Self> {
        Self::load_as(cli_roots, bindings_file, None)
    }

    pub fn load_as(
        cli_roots: &[String],
        bindings_file: Option<&Path>,
        identity: Option<(&str, &str, &str)>,
    ) -> Result<Self> {
        let mut entries = BTreeMap::new();
        for declaration in cli_roots {
            let (project_id, root) = declaration
                .split_once('=')
                .context("--project-root must be PROJECT_ID=/ABSOLUTE/ROOT")?;
            insert_entry(&mut entries, project_id, Path::new(root))?;
        }
        if let Some(path) = bindings_file {
            if !path.is_absolute() {
                bail!("LOOM_BINDINGS_FILE must be an absolute path owned by the node operator");
            }
            let value = read_json(path)?.context("configured bindings file is missing")?;
            let protected = value
                .get("protected_root")
                .and_then(Value::as_str)
                .context("bindings file requires protected_root")?;
            let protected = canonical_host_root(Path::new(protected), "binding protected root")?;
            if let Some(parent) = path.parent() {
                if canonical_host_root(parent, "bindings file parent")? != protected {
                    bail!("bindings file must be directly under its protected_root");
                }
            }
            let (node_id, installation_id, encoded_public_key) =
                identity.context("binding file requires an established node identity")?;
            if value["node_id"] != node_id || value["installation_id"] != installation_id {
                bail!("signed ProjectBinding declaration belongs to a different node/installation");
            }
            let signature = value["binding_signature"]
                .as_str()
                .context("signed ProjectBinding declaration is required")?;
            let signature_bytes = URL_SAFE_NO_PAD
                .decode(signature)
                .context("binding signature must be base64url")?;
            let signature_bytes: [u8; 64] = signature_bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("binding signature must be 64 bytes"))?;
            let public_key = &encoded_public_key;
            let public_key = URL_SAFE_NO_PAD
                .decode(public_key.trim())
                .context("invalid public certificate")?;
            let public_key: [u8; 32] = public_key
                .try_into()
                .map_err(|_| anyhow::anyhow!("public certificate must contain an Ed25519 key"))?;
            VerifyingKey::from_bytes(&public_key)?
                .verify(
                    binding_payload(&value)?.as_bytes(),
                    &Signature::from_bytes(&signature_bytes),
                )
                .context("operator ProjectBinding signature is invalid")?;
            let map = value
                .get("bindings")
                .or_else(|| value.get("project_roots"))
                .context("bindings file requires bindings/projects map")?;
            let object = map
                .as_object()
                .context("bindings must be a root-to-project-id JSON object")?;
            for (root, id) in object {
                let id = id.as_str().context("binding project id must be a string")?;
                insert_entry(&mut entries, id, Path::new(root))?;
            }
        }
        let mut roots = BTreeSet::new();
        for (project_id, root) in &entries {
            normalized_id(project_id)?;
            if !roots.insert(root) {
                bail!(
                    "one physical root cannot stand in for multiple projects: {}",
                    root.display()
                );
            }
        }
        Ok(Self { entries })
    }

    pub fn require(&self, project_id: &str) -> Result<&Path> {
        self.entries
            .get(project_id)
            .map(PathBuf::as_path)
            .with_context(|| format!("no explicit host root configured for project {project_id}"))
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn inventory(&self) -> Value {
        Value::Object(
            self.entries
                .iter()
                .map(|(id, root)| {
                    (
                        id.clone(),
                        Value::String(root.to_string_lossy().into_owned()),
                    )
                })
                .collect(),
        )
    }

    pub fn validate_separated_from(&self, state: &Path, artifacts: &Path) -> Result<()> {
        for root in self.entries.values() {
            for owned in [state, artifacts] {
                if owned == root || owned.starts_with(root) || root.starts_with(owned) {
                    bail!("project roots must not contain or be contained by node state/artifact roots");
                }
            }
        }
        Ok(())
    }
}

fn insert_entry(
    entries: &mut BTreeMap<String, PathBuf>,
    project_id: &str,
    root: &Path,
) -> Result<()> {
    normalized_id(project_id)?;
    let canonical = canonical_host_root(root, "project root")?;
    if entries.insert(project_id.to_owned(), canonical).is_some() {
        bail!("duplicate project id {project_id}; each project requires one explicit root");
    }
    Ok(())
}

pub fn binding_payload(value: &Value) -> Result<String> {
    for root in value["bindings"]
        .as_object()
        .into_iter()
        .chain(value["project_roots"].as_object())
        .flat_map(|map| map.keys())
    {
        if let Some(id) = value["bindings"]
            .get(root)
            .or_else(|| value["project_roots"].get(root))
        {
            let id = id.as_str().context("binding project id must be a string")?;
            normalized_id(id)?;
            canonical_host_root(Path::new(root), "signed project binding")?;
        }
    }
    Ok(serde_json::to_string(
        &json!({"schema":"loom.project-bindings.v1","node_id":value["node_id"],
        "installation_id":value["installation_id"],"protected_root":value["protected_root"],
        "bindings":value["bindings"],"project_roots":value["project_roots"]}),
    )?)
}

fn normalized_id(project_id: &str) -> Result<()> {
    if project_id.trim() != project_id
        || project_id.len() > 160
        || !project_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
    {
        bail!("invalid project id {project_id:?}");
    }
    Ok(())
}

pub fn canonical_host_root(root: &Path, label: &str) -> Result<PathBuf> {
    if !root.is_absolute()
        || root
            .components()
            .any(|c| matches!(c, Component::CurDir | Component::ParentDir))
    {
        bail!("{label} must be an absolute normalized path");
    }
    let canonical = root
        .canonicalize()
        .with_context(|| format!("{label} does not exist"))?;
    let metadata = std::fs::symlink_metadata(&canonical)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("{label} must resolve to an ordinary directory");
    }
    if canonical == Path::new("/")
        || Some(canonical.as_path())
            == std::env::var_os("HOME")
                .map(PathBuf::from)
                .and_then(|x| x.canonicalize().ok())
                .as_deref()
    {
        bail!("{label} may not be filesystem root or HOME");
    }
    Ok(canonical)
}

pub fn write_signed_binding(
    state_dir: &Path,
    identity: &crate::identity::Identity,
    declarations: &[String],
) -> Result<PathBuf> {
    let roots = declarations
        .iter()
        .map(|declaration| {
            let (id, root) = declaration
                .split_once('=')
                .context("--project-root must be PROJECT_ID=/ABSOLUTE/ROOT")?;
            Ok((root.to_owned(), id.to_owned()))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut bindings = serde_json::Map::new();
    for (root, id) in roots {
        normalized_id(&id)?;
        let root = canonical_host_root(Path::new(&root), "operator ProjectBinding")?;
        if bindings
            .insert(root.to_string_lossy().into_owned(), json!(id))
            .is_some()
        {
            bail!("duplicate physical project root in declaration");
        }
    }
    let mut value = json!({"schema":"loom.project-bindings.v1","protected_root":state_dir,"node_id":identity.node_id,
        "installation_id":identity.installation_id,"bindings":Value::Object(bindings),"binding_signature":""});
    let signature = identity.sign_binding_declaration(binding_payload(&value)?.as_bytes());
    value["binding_signature"] = json!(signature);
    let path = state_dir.join("project-bindings.json");
    crate::storage::atomic_json(&path, &value)?;
    Ok(path)
}

pub fn prepare_owned_directory(path: &Path, label: &str) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("{label} must be an explicit absolute path");
    }
    for component in path.components() {
        if matches!(component, Component::CurDir | Component::ParentDir) {
            bail!("{label} must not contain . or ..");
        }
    }
    let canonical = ensure_private_directory(path).with_context(|| label.to_owned())?;
    canonical_host_root(&canonical, label)
}
