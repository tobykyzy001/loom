//! Immutable Source-provenance work specification. Stored after the user
//! explicitly authorizes a task; it never authorizes that work by itself.
use crate::{InstallationId, NodeId, RelativePath, Sha256Digest};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceWorkSpecV1 {
    pub schema: String,
    pub source_event_id: String,
    pub event_request_digest: String,
    pub ticket_id: String,
    pub project_id: String,
    pub kind: String,
    pub objective: String,
    pub relative_path: String,
    pub content: Option<String>,
    pub grant_id: String,
    pub grant_digest: String,
    pub grant_version: u64,
    pub project_binding_id: String,
    pub binding_digest: String,
    pub root_scope: String,
    pub node_id: String,
    pub installation_id: String,
    pub worker_id: String,
    pub created_at: Option<String>,
    pub digest: Option<String>,
}

impl SourceWorkSpecV1 {
    pub fn validate(&self) -> bool {
        self.schema == "loom.source-work-spec.v1"
            && matches!(self.kind.as_str(), "read_summary")
            && self.content.is_none()
            && NodeId::parse(&self.node_id).is_ok()
            && InstallationId::parse(&self.installation_id).is_ok()
            && RelativePath::parse(&self.relative_path).is_ok()
            && Sha256Digest::parse(&self.grant_digest).is_ok()
            && Sha256Digest::parse(&self.binding_digest).is_ok()
            && self.grant_version > 0
            && Sha256Digest::parse(&self.event_request_digest).is_ok()
            && opaque_prefixed(&self.source_event_id, "sre_")
            && opaque_prefixed(&self.ticket_id, "tkt_")
            && [
                &self.project_id,
                &self.grant_id,
                &self.project_binding_id,
                &self.worker_id,
            ]
            .into_iter()
            .all(|value| opaque_id(value))
            && self.objective.len() <= 16000
            && self
                .objective
                .chars()
                .all(|c| !c.is_control() || matches!(c, '\n' | '\t'))
            && self.root_scope.len() <= 4096
            && self
                .created_at
                .as_deref()
                .is_some_and(|time| chrono::DateTime::parse_from_rfc3339(time).is_ok())
            && [
                &self.project_id,
                &self.objective,
                &self.relative_path,
                &self.grant_id,
                &self.grant_digest,
                &self.project_binding_id,
                &self.binding_digest,
                &self.root_scope,
                &self.node_id,
                &self.installation_id,
                &self.worker_id,
            ]
            .into_iter()
            .all(|value| !value.is_empty() && value.len() <= 16000 && !value.contains('\0'))
            && match self.digest.as_deref() {
                Some(digest) => Sha256Digest::parse(digest).is_ok(),
                None => true,
            }
    }

    /// Exact canonical form is persisted, not another caller's reordered object.
    pub fn with_computed_digest(mut self) -> Option<Self> {
        if !self.validate() || self.digest.is_some() {
            return None;
        }
        self.digest = None;
        let serialized = serde_json::to_value(&self).ok()?;
        let bytes = crate::canonical::json(&serialized).ok()?.into_bytes();
        let digest = hex_digest(&bytes);
        self.digest = Some(digest);
        Some(self)
    }
}

fn opaque_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:@-".contains(&byte))
}

fn opaque_prefixed(value: &str, prefix: &str) -> bool {
    value.starts_with(prefix) && opaque_id(value)
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_work_freezes_identity_before_serializing() {
        let spec = SourceWorkSpecV1 {
            schema: "loom.source-work-spec.v1".into(),
            source_event_id: "sre_event".into(),
            event_request_digest: "a".repeat(64),
            ticket_id: "tkt_one".into(),
            project_id: "project".into(),
            kind: "read_summary".into(),
            objective: "Read an explicitly selected file".into(),
            relative_path: "README.md".into(),
            content: None,
            grant_id: "grant".into(),
            grant_digest: "b".repeat(64),
            grant_version: 1,
            project_binding_id: "binding".into(),
            binding_digest: "c".repeat(64),
            root_scope: "/fixture/project".into(),
            node_id: "d".repeat(64),
            installation_id: "inst-1".into(),
            worker_id: "default".into(),
            created_at: Some("2026-01-01T00:00:00Z".into()),
            digest: None,
        };
        let canonical = spec.clone().with_computed_digest().unwrap();
        assert_eq!(spec.digest, None);
        assert_eq!(canonical.digest.as_deref().unwrap().len(), 64);
        assert!(canonical.validate());
        let mut bad = canonical.clone();
        bad.source_event_id = "sre_other".into();
        bad.digest = None;
        assert_ne!(
            canonical.digest,
            bad.clone().with_computed_digest().unwrap().digest
        );
        bad.kind = "edit_file".into();
        assert!(!bad.validate());
        let mut bad_event_id = canonical.clone();
        bad_event_id.source_event_id = "sre_/not-an-opaque-source-id".into();
        assert!(!bad_event_id.validate());
        let mut control = canonical.clone();
        control.objective = "untrusted\u{7f}text".into();
        assert!(!control.validate());
    }
}
