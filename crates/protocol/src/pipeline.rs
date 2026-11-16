//! M4-foundation-only, bounded two-operation document DAGs.
//!
//! Roadmap M3 remains the owner of a general Pipeline. This module intentionally
//! supports only `read_summary(ProjectRoot)` and an explicit deterministic
//! `edit_file(registered ArtifactRef)`. It has no model, image, shell, filesystem,
//! database or Host availability premise. A coordinator still has to persist
//! Tasks/Leases/Effects and verify immutable Artifact bytes and lineage.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use uuid::Uuid;

use crate::core::RequestId;
use crate::core::{
    ArtifactId, GrantDigest, InstallationId, NodeId, ProjectId, ProtocolVersion, RelativePath,
    Sha256Digest, TicketId, WorkerId,
};
use crate::domain::{ArtifactRef, Permission, Placement, TicketKind, TicketSpec, TicketStatus};
use crate::node::NodeEnvelope;

/// This small document contract, not a claim to implement the M3/M4 pipeline.
pub const DOCUMENT_PIPELINE_SCHEMA_V1: &str = "loom.document-pipeline.v1";
pub const DOCUMENT_TASK_FRAME_SCHEMA_V1: &str = "loom.document-task-frame.v1";
pub const MAX_DOCUMENT_CHARS: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PipelineSchemaVersion {
    #[serde(rename = "loom.document-pipeline.v1")]
    V1,
}

pub type GrantId = Uuid;

/// Pipeline-local identifier. Do not reuse Assignment/Artifact/Grant UUID types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PipelineId(pub Uuid);

/// Names registry-owned binding descriptors, not host-provided authority.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct GrantBindingId(String);

macro_rules! local_name {
    ($name:ident, $max:expr) => {
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: impl Into<String>) -> Result<Self, PipelineValidationError> {
                let value = value.into();
                if value.is_empty()
                    || value.len() > $max
                    || !value.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
                    })
                {
                    return Err(PipelineValidationError::InvalidIdentifier(stringify!(
                        $name
                    )));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl TryFrom<String> for $name {
            type Error = PipelineValidationError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                Self::parse(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

local_name!(StageId, 64);
local_name!(ArtifactOutputId, 64);

impl GrantBindingId {
    pub fn parse(value: impl Into<String>) -> Result<Self, PipelineValidationError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':')
            })
        {
            return Err(PipelineValidationError::InvalidIdentifier("GrantBindingId"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for GrantBindingId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for GrantBindingId {
    type Error = PipelineValidationError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(value)
    }
}

impl From<GrantBindingId> for String {
    fn from(value: GrantBindingId) -> Self {
        value.0
    }
}

/// A logical ProjectRoot location only. Registry/Host own its physical mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRootInput {
    pub project_id: ProjectId,
    pub path: RelativePath,
}

/// Upstream output selection. Optional UUID is an immutable expectation, never
/// a generated placeholder; the execution-time Registry supplies and checks hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRefSpec {
    pub producer_stage_id: StageId,
    pub output_id: ArtifactOutputId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_artifact_id: Option<ArtifactId>,
}

/// All supported operations deliberately advertise their complete input mapping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum PipelineOperation {
    ReadSummary {
        input: ProjectRootInput,
    },
    /// Planned explicit derive_artifact semantics, not an existing executor claim.
    EditFile {
        input: ArtifactRefSpec,
        target: RelativePath,
        transform: DocumentEdit,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipelineNodeKind {
    ReadSummary,
    EditFile,
}

impl PipelineNodeKind {
    pub const fn ticket_kind(self) -> TicketKind {
        match self {
            Self::ReadSummary => TicketKind::ReadSummary,
            Self::EditFile => TicketKind::EditFile,
        }
    }

    pub const fn required_permission(self) -> Permission {
        self.ticket_kind().required_permission()
    }

    pub fn validate_mapping(
        self,
        operation: &PipelineOperation,
    ) -> Result<(), PipelineValidationError> {
        let actual = match operation {
            PipelineOperation::ReadSummary { .. } => Self::ReadSummary,
            PipelineOperation::EditFile { .. } => Self::EditFile,
        };
        (self == actual)
            .then_some(())
            .ok_or(PipelineValidationError::OperationKindMismatch)
    }
}

/// Only bounded in-process transforms may be mapped to later ordinary Task
/// payload conversion. This is not a command or arbitrary script language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DocumentEdit {
    TextTransform { transform: TextTransform },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextTransform {
    Trim,
    CollapseWhitespace,
    Uppercase,
    Lowercase,
}

impl DocumentEdit {
    pub fn apply(self, input: &str) -> Result<String, PipelineError> {
        if input.chars().count() > MAX_DOCUMENT_CHARS {
            return Err(PipelineError::DocumentTooLarge);
        }
        let output = match self {
            Self::TextTransform {
                transform: TextTransform::Trim,
            } => input.trim().to_owned(),
            Self::TextTransform {
                transform: TextTransform::CollapseWhitespace,
            } => input.split_whitespace().collect::<Vec<_>>().join(" "),
            Self::TextTransform {
                transform: TextTransform::Uppercase,
            } => input.to_uppercase(),
            Self::TextTransform {
                transform: TextTransform::Lowercase,
            } => input.to_lowercase(),
        };
        if output.chars().count() > MAX_DOCUMENT_CHARS {
            return Err(PipelineError::DocumentTooLarge);
        }
        Ok(output)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineOutputSpec {
    pub output_id: ArtifactOutputId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineNode {
    pub project_id: ProjectId,
    pub grant_id: GrantId,
    pub stage_id: StageId,
    #[serde(default)]
    pub depends_on: Vec<StageId>,
    pub kind: PipelineNodeKind,
    pub operation: PipelineOperation,
    pub output: PipelineOutputSpec,
    /// Preferences constrain selection; they never add/fallback to permissions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<NodeId>,
    /// No "auto", default Worker or default Project/Host is accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<WorkerId>,
}

impl PipelineNode {
    pub fn artifact_dependencies(&self) -> Vec<&ArtifactRefSpec> {
        match &self.operation {
            PipelineOperation::ReadSummary { .. } => vec![],
            PipelineOperation::EditFile { input, .. } => vec![input],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineDefinition {
    pub schema: PipelineSchemaVersion,
    pub version: u32,
    pub pipeline_id: PipelineId,
    pub project_id: ProjectId,
    pub nodes: Vec<PipelineNode>,
}

impl PipelineDefinition {
    pub fn validate(&self) -> Result<(), PipelineValidationError> {
        if self.version != 1 || self.nodes.is_empty() {
            return Err(PipelineValidationError::UnsupportedDefinition);
        }
        if self.pipeline_id.0.is_nil()
            || self.project_id.into_inner().is_nil()
            || self.nodes.iter().any(|node| node.grant_id.is_nil())
        {
            return Err(PipelineValidationError::InvalidIdentifier("non-nil UUID"));
        }
        let mut stages = BTreeMap::new();
        let mut outputs = BTreeMap::new();
        for node in &self.nodes {
            if stages.insert(node.stage_id.clone(), node).is_some() {
                return Err(PipelineValidationError::DuplicateStage(
                    node.stage_id.clone(),
                ));
            }
            if outputs
                .insert(node.output.output_id.clone(), node.stage_id.clone())
                .is_some()
            {
                return Err(PipelineValidationError::DuplicateOutput(
                    node.output.output_id.clone(),
                ));
            }
            if node.project_id != self.project_id {
                return Err(PipelineValidationError::ProjectMismatch);
            }
            node.kind.validate_mapping(&node.operation)?;
            let mut dependencies = BTreeSet::new();
            for stage in &node.depends_on {
                if *stage == node.stage_id {
                    return Err(PipelineValidationError::SelfDependency(
                        node.stage_id.clone(),
                    ));
                }
                if !dependencies.insert(stage) {
                    return Err(PipelineValidationError::DuplicateDependency(
                        node.stage_id.clone(),
                        stage.clone(),
                    ));
                }
            }
            match &node.operation {
                PipelineOperation::ReadSummary { input } => {
                    if input.project_id != self.project_id {
                        return Err(PipelineValidationError::ProjectMismatch);
                    }
                }
                PipelineOperation::EditFile { input, .. } => {
                    if input.expected_artifact_id == Some(ArtifactId::nil()) {
                        return Err(PipelineValidationError::PlaceholderArtifact);
                    }
                    if !dependencies.contains(&input.producer_stage_id) {
                        return Err(PipelineValidationError::ArtifactDependencyMissing(
                            node.stage_id.clone(),
                            input.producer_stage_id.clone(),
                        ));
                    }
                }
            }
        }
        for node in &self.nodes {
            for dependency in &node.depends_on {
                if !stages.contains_key(dependency) {
                    return Err(PipelineValidationError::UnknownDependency(
                        node.stage_id.clone(),
                        dependency.clone(),
                    ));
                }
            }
            for input in node.artifact_dependencies() {
                let Some(producer) = stages.get(&input.producer_stage_id) else {
                    return Err(PipelineValidationError::UnknownArtifactProducer(
                        node.stage_id.clone(),
                    ));
                };
                if producer.output.output_id != input.output_id {
                    return Err(PipelineValidationError::UnknownArtifactOutput(
                        node.stage_id.clone(),
                        input.output_id.clone(),
                    ));
                }
            }
        }

        // Kahn's algorithm over indexed nodes gives a deterministic cycle check.
        let mut degrees: BTreeMap<&StageId, usize> = self
            .nodes
            .iter()
            .map(|node| (&node.stage_id, node.depends_on.len()))
            .collect();
        let mut ready: BTreeSet<&StageId> = degrees
            .iter()
            .filter_map(|(stage, count)| (*count == 0).then_some(*stage))
            .collect();
        let mut visited = 0;
        while let Some(stage) = ready.pop_first() {
            visited += 1;
            for child in &self.nodes {
                if child.depends_on.contains(stage) {
                    let degree = degrees
                        .get_mut(&child.stage_id)
                        .ok_or(PipelineValidationError::CyclicGraph)?;
                    *degree -= 1;
                    if *degree == 0 {
                        ready.insert(&child.stage_id);
                    }
                }
            }
        }
        if visited != self.nodes.len() {
            return Err(PipelineValidationError::CyclicGraph);
        }
        Ok(())
    }
}

/// Registry snapshot only. This has a different digest contract from domain::Grant;
/// its version/digest must come from the same real registry row as `binding_*`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantDescriptor {
    pub id: GrantId,
    pub version: u64,
    pub digest: GrantDigest,
    pub binding_id: GrantBindingId,
    pub binding_digest: Sha256Digest,
    pub project_id: ProjectId,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
    pub operations: BTreeSet<Permission>,
    pub revoked: bool,
    pub expires_at: Option<DateTime<Utc>>,
}

/// An immutable, already operator-verified descriptor supplied BY the Registry.
/// No constructor turns a physical path into a verified binding. `root_scope` is
/// a logical scope; the actual Host must independently enforce its approved root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantBindingDescriptor {
    pub binding_id: GrantBindingId,
    pub revision: u64,
    pub digest: Sha256Digest,
    pub project_id: ProjectId,
    pub node_id: NodeId,
    pub installation_id: InstallationId,
    pub worker_id: WorkerId,
    pub root_scope: RelativePath,
}

/// Registry lookup must compare every immutable field, not trust mere ID presence
/// or arbitrary metadata supplied by a downstream payload as authorization.
pub trait VerifiedArtifactRegistry {
    fn contains_immutable(&self, reference: &ArtifactRef) -> bool;
}

pub struct PipelineRegistry<'a> {
    pub grants: &'a [GrantDescriptor],
    pub bindings: &'a [GrantBindingDescriptor],
    pub artifacts: Option<&'a dyn VerifiedArtifactRegistry>,
    pub now: DateTime<Utc>,
}

impl PipelineRegistry<'static> {
    /// An empty registry never turns missing authorization into success.
    pub fn empty(now: DateTime<Utc>) -> Self {
        Self {
            grants: &[],
            bindings: &[],
            artifacts: None,
            now,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageState {
    Pending,
    Running,
    Paused,
    Reconciling,
    Succeeded,
    Failed,
    Cancelled,
}

impl StageState {
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageProgress {
    pub state: StageState,
    pub task_id: Option<TicketId>,
    pub outputs: BTreeMap<ArtifactOutputId, ArtifactRef>,
}

impl StageProgress {
    fn pending() -> Self {
        Self {
            state: StageState::Pending,
            task_id: None,
            outputs: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectSemantics {
    AtLeastOnce,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactInputBinding {
    pub output_id: ArtifactOutputId,
    pub artifact: ArtifactRef,
    /// Public controlled Artifact URI; never a protected Project/host location.
    pub uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyStage {
    pub pipeline_id: PipelineId,
    pub stage_id: StageId,
    pub project_id: ProjectId,
    pub kind: PipelineNodeKind,
    pub grant_id: GrantId,
    pub grant_version: u64,
    pub grant_digest: GrantDigest,
    pub binding_id: GrantBindingId,
    pub binding_revision: u64,
    pub binding_digest: Sha256Digest,
    pub placement: Placement,
    pub permission: Permission,
    pub operation: PipelineOperation,
    /// Immutable sources are data requirements, never replacement Grants.
    pub artifact_sources: Vec<ArtifactInputBinding>,
    pub effect_semantics: EffectSemantics,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorizationWaitReason {
    GrantNotSupplied,
    BindingNotSupplied,
    MultipleGrantCandidates,
    MultipleBindingCandidates,
    ImmutableArtifact(ArtifactOutputId),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorizationRequirement {
    pub grant_id: GrantId,
    pub binding_id: Option<GrantBindingId>,
    pub project_id: ProjectId,
    pub node_id: Option<NodeId>,
    pub worker_id: Option<WorkerId>,
    pub permission: Permission,
    pub reason: AuthorizationWaitReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum StageWait {
    Authorization(AuthorizationRequirement),
    Dependencies {
        pending: Vec<StageId>,
    },
    ArtifactRegistry {
        requirement: AuthorizationRequirement,
    },
    ReconcilingDependencies {
        stages: Vec<StageId>,
    },
    InFlight,
    Paused,
    Reconciling,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaitingStage {
    pub stage_id: StageId,
    pub wait: StageWait,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum FailedStageReason {
    Failed,
    Cancelled,
    ParentFailed { parent_stage_id: StageId },
    ParentCancelled { parent_stage_id: StageId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailedStage {
    pub stage_id: StageId,
    pub reason: FailedStageReason,
    /// Parent failure is not an automatic retry or a new authority grant.
    pub automatic_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextTaskCandidates {
    pub ready: Vec<ReadyStage>,
    pub waiting: Vec<WaitingStage>,
    pub failed: Vec<FailedStage>,
}

impl PipelineDefinition {
    /// Pure presentation/reduction over supplied Registry snapshots. This method
    /// never writes a registry or creates an approved task by itself.
    pub fn next_tasks(
        &self,
        states: &BTreeMap<StageId, StageProgress>,
        registry: &PipelineRegistry<'_>,
    ) -> Result<NextTaskCandidates, PipelineError> {
        self.validate()?;
        if states.len() != self.nodes.len()
            || self
                .nodes
                .iter()
                .any(|node| !states.contains_key(&node.stage_id))
        {
            return Err(PipelineError::StateSetMismatch);
        }
        let mut result = NextTaskCandidates {
            ready: vec![],
            waiting: vec![],
            failed: vec![],
        };
        for node in &self.nodes {
            let progress = &states[&node.stage_id];
            match progress.state {
                StageState::Running => {
                    result.waiting.push(WaitingStage {
                        stage_id: node.stage_id.clone(),
                        wait: StageWait::InFlight,
                    });
                    continue;
                }
                StageState::Paused => {
                    result.waiting.push(WaitingStage {
                        stage_id: node.stage_id.clone(),
                        wait: StageWait::Paused,
                    });
                    continue;
                }
                StageState::Reconciling => {
                    result.waiting.push(WaitingStage {
                        stage_id: node.stage_id.clone(),
                        wait: StageWait::Reconciling,
                    });
                    continue;
                }
                StageState::Failed | StageState::Cancelled => {
                    result.failed.push(FailedStage {
                        stage_id: node.stage_id.clone(),
                        automatic_retry: false,
                        reason: if progress.state == StageState::Failed {
                            FailedStageReason::Failed
                        } else {
                            FailedStageReason::Cancelled
                        },
                    });
                    continue;
                }
                StageState::Succeeded => continue,
                StageState::Pending => {}
            }
            let mut pending = vec![];
            let mut reconciling = vec![];
            let mut blocked = None;
            for dependency in &node.depends_on {
                let state = &states[dependency];
                match state.state {
                    StageState::Succeeded => {}
                    StageState::Failed => {
                        blocked = Some(FailedStageReason::ParentFailed {
                            parent_stage_id: dependency.clone(),
                        });
                    }
                    StageState::Cancelled => {
                        blocked = Some(FailedStageReason::ParentCancelled {
                            parent_stage_id: dependency.clone(),
                        });
                    }
                    StageState::Reconciling => reconciling.push(dependency.clone()),
                    StageState::Pending | StageState::Running | StageState::Paused => {
                        pending.push(dependency.clone());
                    }
                }
            }
            if let Some(reason) = blocked {
                result.failed.push(FailedStage {
                    stage_id: node.stage_id.clone(),
                    reason,
                    automatic_retry: false,
                });
                continue;
            }
            if !reconciling.is_empty() {
                result.waiting.push(WaitingStage {
                    stage_id: node.stage_id.clone(),
                    wait: StageWait::ReconcilingDependencies {
                        stages: reconciling,
                    },
                });
                continue;
            }
            if !pending.is_empty() {
                result.waiting.push(WaitingStage {
                    stage_id: node.stage_id.clone(),
                    wait: StageWait::Dependencies { pending },
                });
                continue;
            }
            match self.ready_stage(node, states, registry) {
                Ok(stage) => result.ready.push(stage),
                Err(PipelineError::AuthorizationPending(requirement)) => {
                    result.waiting.push(WaitingStage {
                        stage_id: node.stage_id.clone(),
                        wait: StageWait::Authorization(*requirement),
                    });
                }
                Err(PipelineError::ArtifactRegistryUnavailable { output_id, .. }) => {
                    result.waiting.push(WaitingStage {
                        stage_id: node.stage_id.clone(),
                        wait: StageWait::ArtifactRegistry {
                            requirement: AuthorizationRequirement {
                                grant_id: node.grant_id,
                                binding_id: None,
                                project_id: node.project_id,
                                node_id: node.node_id.clone(),
                                worker_id: node.worker_id.clone(),
                                permission: node.kind.required_permission(),
                                reason: AuthorizationWaitReason::ImmutableArtifact(output_id),
                            },
                        },
                    });
                }
                Err(error) => return Err(error),
            }
        }
        Ok(result)
    }

    fn ready_stage(
        &self,
        node: &PipelineNode,
        states: &BTreeMap<StageId, StageProgress>,
        registry: &PipelineRegistry<'_>,
    ) -> Result<ReadyStage, PipelineError> {
        let candidates: Vec<_> = registry
            .grants
            .iter()
            .filter(|grant| grant.id == node.grant_id)
            .collect();
        let grant = match candidates.as_slice() {
            [] => {
                return Err(PipelineError::AuthorizationPending(Box::new(
                    AuthorizationRequirement {
                        grant_id: node.grant_id,
                        binding_id: None,
                        project_id: node.project_id,
                        node_id: node.node_id.clone(),
                        worker_id: node.worker_id.clone(),
                        permission: node.kind.required_permission(),
                        reason: AuthorizationWaitReason::GrantNotSupplied,
                    },
                )));
            }
            [grant] => grant,
            _ => {
                return Err(PipelineError::AuthorizationPending(Box::new(
                    AuthorizationRequirement {
                        grant_id: node.grant_id,
                        binding_id: None,
                        project_id: node.project_id,
                        node_id: node.node_id.clone(),
                        worker_id: node.worker_id.clone(),
                        permission: node.kind.required_permission(),
                        reason: AuthorizationWaitReason::MultipleGrantCandidates,
                    },
                )));
            }
        };
        let bindings: Vec<_> = registry
            .bindings
            .iter()
            .filter(|binding| binding.binding_id == grant.binding_id)
            .collect();
        let binding = match bindings.as_slice() {
            [] => {
                return Err(PipelineError::AuthorizationPending(Box::new(
                    AuthorizationRequirement {
                        grant_id: grant.id,
                        binding_id: Some(grant.binding_id.clone()),
                        project_id: grant.project_id,
                        node_id: node.node_id.clone(),
                        worker_id: node.worker_id.clone(),
                        permission: node.kind.required_permission(),
                        reason: AuthorizationWaitReason::BindingNotSupplied,
                    },
                )));
            }
            [binding] => binding,
            _ => {
                return Err(PipelineError::AuthorizationPending(Box::new(
                    AuthorizationRequirement {
                        grant_id: grant.id,
                        binding_id: Some(grant.binding_id.clone()),
                        project_id: grant.project_id,
                        node_id: node.node_id.clone(),
                        worker_id: node.worker_id.clone(),
                        permission: node.kind.required_permission(),
                        reason: AuthorizationWaitReason::MultipleBindingCandidates,
                    },
                )));
            }
        };
        if grant.version == 0 || binding.revision == 0 {
            return Err(PipelineError::AuthorizationMismatch(
                "grant/binding revision must be explicit and positive".into(),
            ));
        }
        if Sha256Digest::parse(grant.digest.as_str()).is_err()
            || grant.binding_digest != binding.digest
        {
            return Err(PipelineError::AuthorizationMismatch(
                "grant does not pin the supplied immutable binding digest".into(),
            ));
        }
        if grant.revoked
            || grant
                .expires_at
                .is_some_and(|expiration| expiration <= registry.now)
        {
            return Err(PipelineError::AuthorizationMismatch(
                "grant is not active at the supplied registration time".into(),
            ));
        }
        if grant.binding_id != binding.binding_id
            || grant.project_id != binding.project_id
            || grant.node_id != binding.node_id
            || grant.installation_id != binding.installation_id
            || grant.worker_id != binding.worker_id
            || grant.project_id != node.project_id
            || node.node_id.as_ref().is_some_and(|id| id != &grant.node_id)
            || node
                .worker_id
                .as_ref()
                .is_some_and(|id| id != &grant.worker_id)
        {
            return Err(PipelineError::ScopeMismatch {
                stage_id: node.stage_id.clone(),
            });
        }
        if !grant.operations.contains(&node.kind.required_permission()) {
            return Err(PipelineError::PermissionMismatch {
                stage_id: node.stage_id.clone(),
                requested: node.kind.required_permission(),
            });
        }
        let (project_input, artifact_input, target) = match &node.operation {
            PipelineOperation::ReadSummary { input } => (Some(input), None, None),
            PipelineOperation::EditFile { input, target, .. } => (None, Some(input), Some(target)),
        };
        if let Some(input) = project_input {
            if input.project_id != grant.project_id || !input.path.is_within(&binding.root_scope) {
                return Err(PipelineError::OutsideBindingRoot {
                    stage_id: node.stage_id.clone(),
                });
            }
        }
        if target.is_some_and(|path| !path.is_within(&binding.root_scope)) {
            return Err(PipelineError::OutsideBindingRoot {
                stage_id: node.stage_id.clone(),
            });
        }
        let mut artifact_sources = vec![];
        if let Some(input) = artifact_input {
            let progress = &states[&input.producer_stage_id];
            let artifact = progress.outputs.get(&input.output_id).ok_or_else(|| {
                PipelineError::MissingProducerOutput {
                    stage_id: input.producer_stage_id.clone(),
                    output_id: input.output_id.clone(),
                }
            })?;
            if input
                .expected_artifact_id
                .is_some_and(|expected| expected != artifact.artifact_id)
            {
                return Err(PipelineError::ArtifactIdentityMismatch {
                    stage_id: node.stage_id.clone(),
                });
            }
            let uri = artifact_uri(artifact)?;
            let artifact_registry =
                registry
                    .artifacts
                    .ok_or_else(|| PipelineError::ArtifactRegistryUnavailable {
                        stage_id: node.stage_id.clone(),
                        output_id: input.output_id.clone(),
                    })?;
            if !artifact_registry.contains_immutable(artifact) {
                return Err(PipelineError::UnverifiedArtifact(artifact.artifact_id));
            }
            artifact_sources.push(ArtifactInputBinding {
                output_id: input.output_id.clone(),
                artifact: artifact.clone(),
                uri,
            });
        }
        Ok(ReadyStage {
            pipeline_id: self.pipeline_id,
            stage_id: node.stage_id.clone(),
            project_id: node.project_id,
            kind: node.kind,
            grant_id: grant.id,
            grant_version: grant.version,
            grant_digest: grant.digest.clone(),
            binding_id: binding.binding_id.clone(),
            binding_revision: binding.revision,
            binding_digest: binding.digest.clone(),
            placement: Placement {
                node_id: grant.node_id.clone(),
                installation_id: grant.installation_id.clone(),
                worker_id: grant.worker_id.clone(),
            },
            permission: node.kind.required_permission(),
            operation: node.operation.clone(),
            artifact_sources,
            effect_semantics: EffectSemantics::AtLeastOnce,
        })
    }
}

/// Existing TicketSpec is the intended standard Task boundary. No alternate Grant,
/// Lease or Assignment authority is embedded here.
impl ReadyStage {
    pub fn ticket_spec(&self) -> TicketSpec {
        let relative_path = match &self.operation {
            PipelineOperation::ReadSummary { input } => Some(input.path.clone()),
            PipelineOperation::EditFile { target, .. } => Some(target.clone()),
        };
        TicketSpec {
            project_id: self.project_id,
            objective: format!(
                "{} document pipeline {} stage {}",
                self.kind.ticket_kind_name(),
                self.pipeline_id.0,
                self.stage_id
            ),
            kind: self.kind.ticket_kind(),
            relative_path,
        }
    }

    /// Ordinary bounded custom payload conversion for the future Task adapter.
    /// `sent_to_node` must be the authenticated recipient chosen from placement;
    /// this function never marks the Grant active or executes the content.
    pub fn execution_frame(
        &self,
        text_inputs: &[VerifiedArtifactText],
        sent_to_node: &NodeId,
        request_id: RequestId,
    ) -> Result<NodeEnvelope<DocumentTaskFrame>, PipelineError> {
        if sent_to_node != &self.placement.node_id {
            return Err(PipelineError::FrameNodeMismatch);
        }
        let source = match &self.operation {
            PipelineOperation::ReadSummary { input } => DocumentFrameSource::ProjectRoot {
                project_id: input.project_id,
                path: input.path.clone(),
            },
            PipelineOperation::EditFile { input, .. } => {
                let required = self
                    .artifact_sources
                    .iter()
                    .find(|source| source.output_id == input.output_id)
                    .ok_or(PipelineError::FrameInputMismatch)?;
                if text_inputs.len() != 1 {
                    return Err(PipelineError::FrameInputMismatch);
                }
                let text = &text_inputs[0];
                if text.reference != required.artifact {
                    return Err(PipelineError::FrameInputMismatch);
                }
                DocumentFrameSource::RegisteredArtifact {
                    artifact_id: required.artifact.artifact_id,
                    sha256: required.artifact.sha256.clone(),
                    uri: required.uri.clone(),
                    text: text.text.clone(),
                }
            }
        };
        Ok(NodeEnvelope {
            protocol: ProtocolVersion::v1(),
            node_id: sent_to_node.clone(),
            installation_id: self.placement.installation_id.clone(),
            request_id,
            sent_at: None,
            payload: DocumentTaskFrame {
                schema: DOCUMENT_TASK_FRAME_SCHEMA_V1.to_owned(),
                pipeline_id: self.pipeline_id,
                stage_id: self.stage_id.clone(),
                kind: self.kind,
                source,
                operation: match self.operation.clone() {
                    PipelineOperation::ReadSummary { .. } => DocumentFrameOperation::ReadSummary,
                    PipelineOperation::EditFile {
                        target, transform, ..
                    } => DocumentFrameOperation::EditFile { target, transform },
                },
            },
        })
    }
}

impl PipelineNodeKind {
    fn ticket_kind_name(self) -> &'static str {
        match self {
            Self::ReadSummary => "read_summary",
            Self::EditFile => "edit_file",
        }
    }
}

/// Bytes are checked against SHA-256+size and immutable identity by the supplied
/// center Registry before text can enter a Frame. UTF-8 is a document requirement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedArtifactText {
    pub reference: ArtifactRef,
    pub text: String,
}

impl VerifiedArtifactText {
    pub fn new(
        registry: &dyn VerifiedArtifactRegistry,
        reference: ArtifactRef,
        text: String,
    ) -> Result<Self, PipelineError> {
        validate_registered_text(registry, &reference, text.as_bytes())?;
        if text.chars().count() > MAX_DOCUMENT_CHARS {
            return Err(PipelineError::DocumentTooLarge);
        }
        Ok(Self { reference, text })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentTaskFrame {
    pub schema: String,
    pub pipeline_id: PipelineId,
    pub stage_id: StageId,
    pub kind: PipelineNodeKind,
    pub source: DocumentFrameSource,
    pub operation: DocumentFrameOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum DocumentFrameSource {
    ProjectRoot {
        project_id: ProjectId,
        path: RelativePath,
    },
    RegisteredArtifact {
        artifact_id: ArtifactId,
        sha256: Sha256Digest,
        uri: String,
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum DocumentFrameOperation {
    ReadSummary,
    EditFile {
        target: RelativePath,
        transform: DocumentEdit,
    },
}

/// In-memory projection, not a persistent Task authority. Its mutations require
/// verified facts and trusted Registry inputs; no hidden retries/execution loops.
#[derive(Debug, Clone)]
pub struct PipelineExecution {
    definition: PipelineDefinition,
    pub stages: BTreeMap<StageId, StageProgress>,
}

impl PipelineExecution {
    pub fn new(definition: PipelineDefinition) -> Result<Self, PipelineValidationError> {
        definition.validate()?;
        let stages = definition
            .nodes
            .iter()
            .map(|node| (node.stage_id.clone(), StageProgress::pending()))
            .collect();
        Ok(Self { definition, stages })
    }

    pub fn next_tasks(
        &self,
        registry: &PipelineRegistry<'_>,
    ) -> Result<NextTaskCandidates, PipelineError> {
        self.definition.next_tasks(&self.stages, registry)
    }

    pub fn attach_task(
        &mut self,
        stage_id: &StageId,
        task_id: TicketId,
    ) -> Result<(), PipelineError> {
        let state = self
            .stages
            .get_mut(stage_id)
            .ok_or_else(|| PipelineError::UnknownStage(stage_id.clone()))?;
        if state.state != StageState::Pending || state.task_id.is_some() {
            return Err(PipelineError::InvalidStageTransition);
        }
        state.task_id = Some(task_id);
        state.state = StageState::Running;
        Ok(())
    }

    /// Paused and reconciling are retained distinctly. Succeeded requires the
    /// exact declared output to already exist in the immutable center Registry.
    pub fn record_task_state(
        &mut self,
        stage_id: &StageId,
        task_state: TicketStatus,
        task_id: TicketId,
        outputs: BTreeMap<ArtifactOutputId, ArtifactRef>,
        registry: &dyn VerifiedArtifactRegistry,
    ) -> Result<(), PipelineError> {
        let node = self
            .definition
            .nodes
            .iter()
            .find(|node| &node.stage_id == stage_id)
            .ok_or_else(|| PipelineError::UnknownStage(stage_id.clone()))?;
        let current = self
            .stages
            .get(stage_id)
            .ok_or_else(|| PipelineError::UnknownStage(stage_id.clone()))?;
        if current.task_id != Some(task_id)
            || matches!(
                current.state,
                StageState::Failed | StageState::Cancelled | StageState::Succeeded
            )
        {
            return Err(PipelineError::InvalidStageTransition);
        }
        let next = match (current.state, task_state) {
            (StageState::Running, TicketStatus::Pending | TicketStatus::Running) => {
                StageState::Running
            }
            (StageState::Running, TicketStatus::WaitingApproval) => StageState::Paused,
            (StageState::Paused, TicketStatus::Running) => StageState::Running,
            (StageState::Running, TicketStatus::Reconciling) => StageState::Reconciling,
            (StageState::Running, TicketStatus::Succeeded) => {
                self.validate_outputs(node, task_id, outputs.clone(), registry)?;
                StageState::Succeeded
            }
            (StageState::Running, TicketStatus::Failed) => StageState::Failed,
            (StageState::Running, TicketStatus::Cancelled) => StageState::Cancelled,
            // Unknown/reconciling needs explicit reconciliation; never infer success.
            (StageState::Reconciling, _) => return Err(PipelineError::ReconciliationRequired),
            _ => return Err(PipelineError::InvalidStageTransition),
        };
        let state = self
            .stages
            .get_mut(stage_id)
            .ok_or_else(|| PipelineError::UnknownStage(stage_id.clone()))?;
        if next == StageState::Succeeded {
            state.outputs = outputs;
        } else if !outputs.is_empty() {
            return Err(PipelineError::InvalidStageTransition);
        }
        state.state = next;
        Ok(())
    }

    fn validate_outputs(
        &self,
        node: &PipelineNode,
        task_id: TicketId,
        outputs: BTreeMap<ArtifactOutputId, ArtifactRef>,
        registry: &dyn VerifiedArtifactRegistry,
    ) -> Result<(), PipelineError> {
        if outputs.len() != 1 {
            return Err(PipelineError::MissingProducerOutput {
                stage_id: node.stage_id.clone(),
                output_id: node.output.output_id.clone(),
            });
        }
        let output = outputs.get(&node.output.output_id).ok_or_else(|| {
            PipelineError::MissingProducerOutput {
                stage_id: node.stage_id.clone(),
                output_id: node.output.output_id.clone(),
            }
        })?;
        if output.ticket_id != task_id {
            return Err(PipelineError::ArtifactTaskMismatch);
        }
        artifact_uri(output)?;
        if !registry.contains_immutable(output) {
            return Err(PipelineError::UnverifiedArtifact(output.artifact_id));
        }
        let expected_parents = match &node.operation {
            PipelineOperation::ReadSummary { .. } => vec![],
            PipelineOperation::EditFile { input, .. } => {
                let parent = self.stages[&input.producer_stage_id]
                    .outputs
                    .get(&input.output_id)
                    .ok_or_else(|| PipelineError::MissingProducerOutput {
                        stage_id: input.producer_stage_id.clone(),
                        output_id: input.output_id.clone(),
                    })?;
                if input
                    .expected_artifact_id
                    .is_some_and(|id| id != parent.artifact_id)
                {
                    return Err(PipelineError::ArtifactIdentityMismatch {
                        stage_id: node.stage_id.clone(),
                    });
                }
                vec![parent.artifact_id]
            }
        };
        if output.parents != expected_parents {
            return Err(PipelineError::ArtifactParentsMismatch);
        }
        Ok(())
    }
}

fn artifact_uri(artifact: &ArtifactRef) -> Result<String, PipelineError> {
    if artifact.artifact_id.into_inner().is_nil() {
        return Err(PipelineError::InvalidOutputArtifact);
    }
    artifact
        .validate()
        .map_err(|_| PipelineError::InvalidOutputArtifact)?;
    let expected = format!("loom://artifact/{}", artifact.artifact_id);
    (artifact.location == expected)
        .then_some(expected)
        .ok_or(PipelineError::InvalidArtifactBindingUri)
}

fn validate_registered_text(
    registry: &dyn VerifiedArtifactRegistry,
    reference: &ArtifactRef,
    bytes: &[u8],
) -> Result<(), PipelineError> {
    artifact_uri(reference)?;
    if !registry.contains_immutable(reference) {
        return Err(PipelineError::UnverifiedArtifact(reference.artifact_id));
    }
    if !matches!(
        reference.media_type.as_str(),
        "text/plain" | "text/markdown"
    ) {
        return Err(PipelineError::UnsupportedDocumentMediaType);
    }
    reference
        .verify_payload(bytes)
        .map_err(|_| PipelineError::ArtifactContentMismatch)?;
    std::str::from_utf8(bytes).map_err(|_| PipelineError::InvalidUtf8Document)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum PipelineValidationError {
    #[error("unsupported pipeline schema/revision")]
    UnsupportedDefinition,
    #[error("invalid or empty pipeline identifier: {0}")]
    InvalidIdentifier(&'static str),
    #[error("duplicate stage: {0}")]
    DuplicateStage(StageId),
    #[error("duplicate output: {0}")]
    DuplicateOutput(ArtifactOutputId),
    #[error("node kind does not map to its declared operation")]
    OperationKindMismatch,
    #[error("all operations must remain within one project")]
    ProjectMismatch,
    #[error("stage cannot depend on itself: {0}")]
    SelfDependency(StageId),
    #[error("duplicate dependency: {0} -> {1}")]
    DuplicateDependency(StageId, StageId),
    #[error("unknown dependency: {0} -> {1}")]
    UnknownDependency(StageId, StageId),
    #[error("artifact input at {0} lacks an explicit edge from {1}")]
    ArtifactDependencyMissing(StageId, StageId),
    #[error("unknown artifact producer for stage {0}")]
    UnknownArtifactProducer(StageId),
    #[error("stage {0} expects unknown output {1}")]
    UnknownArtifactOutput(StageId, ArtifactOutputId),
    #[error("definition graph is cyclic")]
    CyclicGraph,
    #[error("nil Artifact UUID is not an immutable input pin")]
    PlaceholderArtifact,
}

impl From<PipelineValidationError> for PipelineError {
    fn from(error: PipelineValidationError) -> Self {
        Self::InvalidDefinition(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum PipelineError {
    #[error("invalid pipeline definition: {0}")]
    InvalidDefinition(PipelineValidationError),
    #[error("next-stage state map does not match the definition")]
    StateSetMismatch,
    #[error("waiting for verified grant/binding: {0:?}")]
    AuthorizationPending(Box<AuthorizationRequirement>),
    #[error("grant/binding identity, version or digest mismatch: {0}")]
    AuthorizationMismatch(String),
    #[error("stage scope does not match the exact grant/binding: {stage_id}")]
    ScopeMismatch { stage_id: StageId },
    #[error("stage {stage_id} requires unavailable permission {requested:?}")]
    PermissionMismatch {
        stage_id: StageId,
        requested: Permission,
    },
    #[error("stage root/target is outside its logical binding root: {stage_id}")]
    OutsideBindingRoot { stage_id: StageId },
    #[error("producer output is absent: {stage_id}/{output_id}")]
    MissingProducerOutput {
        stage_id: StageId,
        output_id: ArtifactOutputId,
    },
    #[error("running artifact does not match the immutable expected UUID: {stage_id}")]
    ArtifactIdentityMismatch { stage_id: StageId },
    #[error("an immutable verified Artifact Registry is required for {stage_id}/{output_id}")]
    ArtifactRegistryUnavailable {
        stage_id: StageId,
        output_id: ArtifactOutputId,
    },
    #[error("artifact was not found in the immutable center Registry: {0}")]
    UnverifiedArtifact(ArtifactId),
    #[error("artifact must be produced by this exact Task")]
    ArtifactTaskMismatch,
    #[error("artifact reference is structurally invalid")]
    InvalidOutputArtifact,
    #[error("artifact public binding must be loom://artifact/<uuid>")]
    InvalidArtifactBindingUri,
    #[error("artifact bytes do not match the immutable reference")]
    ArtifactContentMismatch,
    #[error("artifact parents are not the actual declared dependencies")]
    ArtifactParentsMismatch,
    #[error("only text/plain and text/markdown document artifacts are supported")]
    UnsupportedDocumentMediaType,
    #[error("document input must be UTF-8")]
    InvalidUtf8Document,
    #[error("document text exceeds its character bound")]
    DocumentTooLarge,
    #[error("unknown stage: {0}")]
    UnknownStage(StageId),
    #[error("stage state transition is not permitted")]
    InvalidStageTransition,
    #[error("a reconciling stage requires an explicit verified outcome")]
    ReconciliationRequired,
    #[error("Frame input is not the exact verified source selection")]
    FrameInputMismatch,
    #[error("Frame must target the exact placement Node")]
    FrameNodeMismatch,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::AssignmentId;
    use crate::domain::{EvidenceRef, Permission, ReportStatus};
    use crate::state::M0StateMachine;
    use chrono::TimeZone;

    fn at(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + seconds, 0).unwrap()
    }

    fn uuid(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    fn stage(name: &str) -> StageId {
        StageId::parse(name).unwrap()
    }

    fn output(name: &str) -> ArtifactOutputId {
        ArtifactOutputId::parse(name).unwrap()
    }

    fn path(name: &str) -> RelativePath {
        RelativePath::parse(name).unwrap()
    }

    fn definition() -> PipelineDefinition {
        PipelineDefinition {
            schema: PipelineSchemaVersion::V1,
            version: 1,
            pipeline_id: PipelineId(uuid(10)),
            project_id: ProjectId(uuid(11)),
            nodes: vec![
                PipelineNode {
                    project_id: ProjectId(uuid(11)),
                    grant_id: uuid(20),
                    stage_id: stage("read"),
                    depends_on: vec![],
                    kind: PipelineNodeKind::ReadSummary,
                    operation: PipelineOperation::ReadSummary {
                        input: ProjectRootInput {
                            project_id: ProjectId(uuid(11)),
                            path: path("docs"),
                        },
                    },
                    output: PipelineOutputSpec {
                        output_id: output("summary"),
                    },
                    node_id: Some(NodeId::parse("a".repeat(64)).unwrap()),
                    worker_id: Some(WorkerId::parse("reader").unwrap()),
                },
                PipelineNode {
                    project_id: ProjectId(uuid(11)),
                    grant_id: uuid(21),
                    stage_id: stage("edit"),
                    depends_on: vec![stage("read")],
                    kind: PipelineNodeKind::EditFile,
                    operation: PipelineOperation::EditFile {
                        input: ArtifactRefSpec {
                            producer_stage_id: stage("read"),
                            output_id: output("summary"),
                            expected_artifact_id: None,
                        },
                        target: path("docs/edited.md"),
                        transform: DocumentEdit::TextTransform {
                            transform: TextTransform::CollapseWhitespace,
                        },
                    },
                    output: PipelineOutputSpec {
                        output_id: output("edited"),
                    },
                    node_id: None,
                    worker_id: Some(WorkerId::parse("editor").unwrap()),
                },
            ],
        }
    }

    fn grant(
        id: u128,
        worker: &str,
        binding_id: &str,
        permissions: &[Permission],
    ) -> GrantDescriptor {
        GrantDescriptor {
            id: uuid(id),
            version: 3,
            digest: Sha256Digest::from_bytes(format!("grant-{id}")),
            binding_id: GrantBindingId::parse(binding_id).unwrap(),
            binding_digest: Sha256Digest::from_bytes(binding_id.as_bytes()),
            project_id: ProjectId(uuid(11)),
            node_id: NodeId::parse("a".repeat(64)).unwrap(),
            installation_id: InstallationId::parse("installation-a").unwrap(),
            worker_id: WorkerId::parse(worker).unwrap(),
            operations: permissions.iter().copied().collect(),
            revoked: false,
            expires_at: Some(at(1_000)),
        }
    }

    fn binding(id: &str, worker: &str) -> GrantBindingDescriptor {
        GrantBindingDescriptor {
            binding_id: GrantBindingId::parse(id).unwrap(),
            revision: 2,
            digest: Sha256Digest::from_bytes(id.as_bytes()),
            project_id: ProjectId(uuid(11)),
            node_id: NodeId::parse("a".repeat(64)).unwrap(),
            installation_id: InstallationId::parse("installation-a").unwrap(),
            worker_id: WorkerId::parse(worker).unwrap(),
            root_scope: path("docs"),
        }
    }

    #[derive(Default)]
    struct Registry(BTreeMap<ArtifactId, ArtifactRef>);

    impl VerifiedArtifactRegistry for Registry {
        fn contains_immutable(&self, reference: &ArtifactRef) -> bool {
            self.0.get(&reference.artifact_id) == Some(reference)
        }
    }

    fn registry<'a>(
        grants: &'a [GrantDescriptor],
        bindings: &'a [GrantBindingDescriptor],
        artifacts: &'a Registry,
    ) -> PipelineRegistry<'a> {
        PipelineRegistry {
            grants,
            bindings,
            artifacts: Some(artifacts),
            now: at(10),
        }
    }

    fn artifact(id: u128, text: &str, parents: Vec<ArtifactId>) -> ArtifactRef {
        artifact_for_task(id, text, parents, TicketId(uuid(id + 1_000)))
    }

    fn artifact_for_task(
        id: u128,
        text: &str,
        parents: Vec<ArtifactId>,
        ticket_id: TicketId,
    ) -> ArtifactRef {
        ArtifactRef {
            schema: ArtifactRef::SCHEMA_V1.into(),
            artifact_id: ArtifactId(uuid(id)),
            ticket_id,
            assignment_id: AssignmentId(uuid(id + 2_000)),
            origin_node_id: NodeId::parse("a".repeat(64)).unwrap(),
            location: format!("loom://artifact/{}", Uuid::from_u128(id)),
            media_type: "text/plain".into(),
            size_bytes: text.len() as u64,
            sha256: Sha256Digest::from_bytes(text.as_bytes()),
            parents,
            evidence: vec![EvidenceRef {
                kind: "synthetic_atomic_write".into(),
                digest: Sha256Digest::from_bytes(format!("evidence-{id}")),
                uri: None,
            }],
        }
    }

    fn ready_first(execution: &PipelineExecution) -> ReadyStage {
        let grants = vec![grant(20, "reader", "binding-read", &[Permission::Read])];
        let bindings = vec![binding("binding-read", "reader")];
        let artifacts = Registry::default();
        let candidates = execution
            .next_tasks(&registry(&grants, &bindings, &artifacts))
            .unwrap();
        assert_eq!(candidates.ready.len(), 1);
        assert_eq!(candidates.waiting.len(), 1);
        candidates.ready[0].clone()
    }

    fn first_succeeded(
        execution: &mut PipelineExecution,
        artifacts: &mut Registry,
        id: u128,
    ) -> ArtifactRef {
        ready_first(execution);
        execution
            .attach_task(&stage("read"), TicketId(uuid(800)))
            .unwrap();
        let artifact = artifact_for_task(id, "  Loom\n document  ", vec![], TicketId(uuid(800)));
        artifacts.0.insert(artifact.artifact_id, artifact.clone());
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::from([(output("summary"), artifact.clone())]),
                artifacts,
            )
            .unwrap();
        artifact
    }

    #[test]
    fn valid_two_operation_graph_has_exact_read_and_write_permissions() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        let first = ready_first(&execution);
        assert_eq!(first.permission, Permission::Read);
        assert_eq!(first.kind.ticket_kind(), TicketKind::ReadSummary);
        assert_eq!(first.effect_semantics, EffectSemantics::AtLeastOnce);
        assert_eq!(first.ticket_spec().relative_path, Some(path("docs")));
        let mut artifacts = Registry::default();
        first_succeeded(&mut execution, &mut artifacts, 100);
        let grants = vec![
            grant(20, "reader", "binding-read", &[Permission::Read]),
            grant(21, "editor", "binding-edit", &[Permission::Write]),
        ];
        let bindings = vec![
            binding("binding-read", "reader"),
            binding("binding-edit", "editor"),
        ];
        let candidates = execution
            .next_tasks(&registry(&grants, &bindings, &artifacts))
            .unwrap();
        assert_eq!(candidates.ready.len(), 1);
        assert_eq!(candidates.ready[0].permission, Permission::Write);
        assert_eq!(candidates.ready[0].kind.ticket_kind(), TicketKind::EditFile);
        assert_eq!(
            candidates.ready[0].artifact_sources[0].artifact.sha256,
            artifacts.0[&ArtifactId(uuid(100))].sha256
        );
        assert_eq!(
            candidates.ready[0].artifact_sources[0].uri,
            format!("loom://artifact/{}", uuid(100))
        );
    }

    #[test]
    fn absent_registered_input_is_explicit_wait_not_silent_completion() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        execution
            .attach_task(&stage("read"), TicketId(uuid(800)))
            .unwrap();
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &Registry::default(),
            )
            .unwrap_err();
        assert_eq!(execution.stages[&stage("read")].state, StageState::Running);
        let running = execution
            .next_tasks(&PipelineRegistry::empty(at(10)))
            .unwrap();
        assert_eq!(running.ready.len(), 0);
        assert_eq!(running.waiting[0].wait, StageWait::InFlight);
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Failed,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &Registry::default(),
            )
            .unwrap();
        let terminal = execution
            .next_tasks(&PipelineRegistry::empty(at(10)))
            .unwrap();
        assert!(terminal.ready.is_empty());
        assert_eq!(terminal.failed.len(), 2);
        assert!(terminal.waiting.is_empty());
    }

    #[test]
    fn missing_artifact_registry_is_wait_not_unverified_read() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        let artifacts = &mut Registry::default();
        let artifact = artifact_for_task(100, "summary", vec![], TicketId(uuid(800)));
        artifacts.0.insert(artifact.artifact_id, artifact.clone());
        execution
            .attach_task(&stage("read"), TicketId(uuid(800)))
            .unwrap();
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::from([(output("summary"), artifact)]),
                artifacts,
            )
            .unwrap();
        let grants = vec![grant(21, "editor", "binding-edit", &[Permission::Write])];
        let bindings = vec![binding("binding-edit", "editor")];
        let mut without_artifacts = registry(&grants, &bindings, artifacts);
        without_artifacts.artifacts = None;
        let result = execution.next_tasks(&without_artifacts).unwrap();
        assert!(result.ready.is_empty());
        assert!(matches!(
            result.waiting[0].wait,
            StageWait::ArtifactRegistry { .. }
        ));
    }

    #[test]
    fn unknown_version_duplicate_ids_edges_roots_and_cycles_are_rejected() {
        let mut nil_identity = definition();
        nil_identity.nodes[0].grant_id = Uuid::nil();
        assert_eq!(
            nil_identity.validate(),
            Err(PipelineValidationError::InvalidIdentifier("non-nil UUID"))
        );
        let mut unsupported = definition();
        unsupported.version = 2;
        assert_eq!(
            unsupported.validate(),
            Err(PipelineValidationError::UnsupportedDefinition)
        );
        let mut duplicate = definition();
        duplicate.nodes[1].stage_id = stage("read");
        assert_eq!(
            duplicate.validate(),
            Err(PipelineValidationError::DuplicateStage(stage("read")))
        );
        let mut duplicate_edge = definition();
        duplicate_edge.nodes[1].depends_on.push(stage("read"));
        assert_eq!(
            duplicate_edge.validate(),
            Err(PipelineValidationError::DuplicateDependency(
                stage("edit"),
                stage("read")
            ))
        );
        let mut self_edge = definition();
        self_edge.nodes[0].depends_on = vec![stage("read")];
        assert_eq!(
            self_edge.validate(),
            Err(PipelineValidationError::SelfDependency(stage("read")))
        );
        let mut unknown = definition();
        unknown.nodes[1].depends_on = vec![stage("missing")];
        if let PipelineOperation::EditFile { input, .. } = &mut unknown.nodes[1].operation {
            input.producer_stage_id = stage("missing");
        }
        assert_eq!(
            unknown.validate(),
            Err(PipelineValidationError::UnknownDependency(
                stage("edit"),
                stage("missing")
            ))
        );
        let mut cycle = definition();
        cycle.nodes[0].depends_on = vec![stage("edit")];
        assert_eq!(cycle.validate(), Err(PipelineValidationError::CyclicGraph));
        let mut wrong_root = definition();
        let PipelineOperation::ReadSummary { input } = &mut wrong_root.nodes[0].operation else {
            panic!()
        };
        input.project_id = ProjectId(uuid(999));
        assert_eq!(
            wrong_root.validate(),
            Err(PipelineValidationError::ProjectMismatch)
        );
        let mut unknown_output = definition();
        let PipelineOperation::EditFile { input, .. } = &mut unknown_output.nodes[1].operation
        else {
            panic!()
        };
        input.output_id = output("missing");
        assert_eq!(
            unknown_output.validate(),
            Err(PipelineValidationError::UnknownArtifactOutput(
                stage("edit"),
                output("missing")
            ))
        );
    }

    #[test]
    fn missing_registry_is_explicit_wait_not_execution() {
        let execution = PipelineExecution::new(definition()).unwrap();
        let result = execution
            .next_tasks(&PipelineRegistry::empty(at(10)))
            .unwrap();
        assert!(result.ready.is_empty());
        let StageWait::Authorization(requirement) = &result.waiting[0].wait else {
            panic!()
        };
        assert_eq!(
            requirement.reason,
            AuthorizationWaitReason::GrantNotSupplied
        );
        assert_eq!(requirement.permission, Permission::Read);
        assert!(requirement.node_id.is_some());
        assert_eq!(requirement.worker_id.as_ref().unwrap().as_str(), "reader");
    }

    #[test]
    fn grant_digest_version_scope_and_binding_mismatches_are_rejected() {
        let execution = PipelineExecution::new(definition()).unwrap();
        let artifacts = Registry::default();
        let mut grants = vec![grant(20, "reader", "binding-read", &[Permission::Read])];
        let mut bindings = vec![binding("binding-read", "reader")];
        grants[0].binding_digest = Sha256Digest::from_bytes("other");
        assert!(matches!(
            ready_at(&execution, &grants, &bindings, &artifacts),
            Err(PipelineError::AuthorizationMismatch(_))
        ));
        grants[0].binding_digest = bindings[0].digest.clone();
        bindings[0].node_id = NodeId::parse("b".repeat(64)).unwrap();
        assert_eq!(
            ready_at(&execution, &grants, &bindings, &artifacts),
            Err(PipelineError::ScopeMismatch {
                stage_id: stage("read")
            })
        );
        bindings[0].node_id = grants[0].node_id.clone();
        grants[0].version = 0;
        assert!(matches!(
            ready_at(&execution, &grants, &bindings, &artifacts),
            Err(PipelineError::AuthorizationMismatch(_))
        ));
        grants[0].version = 3;
        let missing_binding = registry(&grants, &[], &artifacts);
        assert!(!execution
            .next_tasks(&missing_binding)
            .unwrap()
            .waiting
            .is_empty());
    }

    #[test]
    fn preferred_hosts_cannot_auto_select_another_grant_worker_or_root() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        let mut grants = vec![grant(20, "other", "binding-read", &[Permission::Read])];
        let bindings = vec![binding("binding-read", "other")];
        assert_eq!(
            ready_at(&execution, &grants, &bindings, &Registry::default()),
            Err(PipelineError::ScopeMismatch {
                stage_id: stage("read")
            })
        );
        let mut artifacts = Registry::default();
        first_succeeded(&mut execution, &mut artifacts, 100);
        grants = vec![grant(21, "editor", "binding-edit", &[Permission::Write])];
        let mut bindings = vec![binding("binding-edit", "editor")];
        bindings[0].root_scope = path("other-root");
        let result = execution.next_tasks(&registry(&grants, &bindings, &artifacts));
        assert_eq!(
            result,
            Err(PipelineError::OutsideBindingRoot {
                stage_id: stage("edit")
            })
        );
    }

    #[test]
    fn read_only_grant_cannot_edit() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        let mut artifacts = Registry::default();
        first_succeeded(&mut execution, &mut artifacts, 100);
        let grants = vec![grant(21, "editor", "binding-edit", &[Permission::Read])];
        let bindings = vec![binding("binding-edit", "editor")];
        assert_eq!(
            execution.next_tasks(&registry(&grants, &bindings, &artifacts)),
            Err(PipelineError::PermissionMismatch {
                stage_id: stage("edit"),
                requested: Permission::Write
            })
        );
    }

    #[test]
    fn artifact_edge_output_pin_content_and_immutable_registry_are_hard_gates() {
        let execution = PipelineExecution::new(definition()).unwrap();
        let mut states = execution.stages.clone();
        states.get_mut(&stage("read")).unwrap().state = StageState::Succeeded;
        states
            .get_mut(&stage("read"))
            .unwrap()
            .outputs
            .insert(output("summary"), artifact(100, "text", vec![]));
        let grants = vec![grant(21, "editor", "binding-edit", &[Permission::Write])];
        let bindings = vec![binding("binding-edit", "editor")];
        assert_eq!(
            definition().next_tasks(&states, &registry(&grants, &bindings, &Registry::default())),
            Err(PipelineError::UnverifiedArtifact(ArtifactId(uuid(100))))
        );
        let mut pinned = definition();
        let PipelineOperation::EditFile { input, .. } = &mut pinned.nodes[1].operation else {
            panic!()
        };
        input.expected_artifact_id = Some(ArtifactId(uuid(101)));
        let artifacts = Registry(BTreeMap::from([(
            ArtifactId(uuid(100)),
            artifact(100, "text", vec![]),
        )]));
        assert_eq!(
            pinned.next_tasks(&states, &registry(&grants, &bindings, &artifacts)),
            Err(PipelineError::ArtifactIdentityMismatch {
                stage_id: stage("edit")
            })
        );
        let PipelineOperation::EditFile { input, .. } = &mut pinned.nodes[1].operation else {
            panic!()
        };
        input.expected_artifact_id = Some(ArtifactId(uuid(100)));
        let mut changed = states.clone();
        changed
            .get_mut(&stage("read"))
            .unwrap()
            .outputs
            .get_mut(&output("summary"))
            .unwrap()
            .sha256 = Sha256Digest::from_bytes("attacker");
        assert_eq!(
            pinned.next_tasks(&changed, &registry(&grants, &bindings, &artifacts)),
            Err(PipelineError::UnverifiedArtifact(ArtifactId(uuid(100))))
        );
        let text =
            VerifiedArtifactText::new(&artifacts, artifact(100, "text", vec![]), "text".into())
                .unwrap();
        assert_eq!(text.text, "text");
        assert_eq!(
            VerifiedArtifactText::new(&artifacts, artifact(100, "text", vec![]), "changed".into()),
            Err(PipelineError::ArtifactContentMismatch)
        );
    }

    #[test]
    fn unknown_report_waits_and_never_advances_dependants() {
        assert_eq!(
            M0StateMachine::project_report(ReportStatus::Unknown),
            TicketStatus::Reconciling
        );
        let mut execution = PipelineExecution::new(definition()).unwrap();
        ready_first(&execution);
        execution
            .attach_task(&stage("read"), TicketId(uuid(800)))
            .unwrap();
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Reconciling,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &Registry::default(),
            )
            .unwrap();
        let candidates = execution
            .next_tasks(&PipelineRegistry::empty(at(10)))
            .unwrap();
        assert!(candidates.ready.is_empty());
        assert!(matches!(
            candidates.waiting[1].wait,
            StageWait::ReconcilingDependencies { .. }
        ));
        assert_eq!(
            execution.record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &Registry::default()
            ),
            Err(PipelineError::ReconciliationRequired)
        );
    }

    #[test]
    fn terminal_failed_or_cancelled_parent_blocks_without_auto_retry() {
        for (status, reason) in [
            (
                TicketStatus::Failed,
                FailedStageReason::ParentFailed {
                    parent_stage_id: stage("read"),
                },
            ),
            (
                TicketStatus::Cancelled,
                FailedStageReason::ParentCancelled {
                    parent_stage_id: stage("read"),
                },
            ),
        ] {
            let mut execution = PipelineExecution::new(definition()).unwrap();
            ready_first(&execution);
            execution
                .attach_task(&stage("read"), TicketId(uuid(800)))
                .unwrap();
            execution
                .record_task_state(
                    &stage("read"),
                    status,
                    TicketId(uuid(800)),
                    BTreeMap::new(),
                    &Registry::default(),
                )
                .unwrap();
            let candidates = execution
                .next_tasks(&PipelineRegistry::empty(at(10)))
                .unwrap();
            assert!(candidates.ready.is_empty());
            assert_eq!(
                candidates.failed[1],
                FailedStage {
                    stage_id: stage("edit"),
                    reason,
                    automatic_retry: false
                }
            );
        }
    }

    #[test]
    fn success_needs_actual_declared_output_and_correct_parent_identity() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        ready_first(&execution);
        execution
            .attach_task(&stage("read"), TicketId(uuid(800)))
            .unwrap();
        let item = artifact_for_task(100, "summary", vec![], TicketId(uuid(800)));
        let mut artifacts = Registry(BTreeMap::from([(item.artifact_id, item.clone())]));
        let borrowed = artifact_for_task(101, "borrowed", vec![], TicketId(uuid(999)));
        artifacts.0.insert(borrowed.artifact_id, borrowed.clone());
        assert_eq!(
            execution.record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::from([(output("summary"), borrowed)]),
                &artifacts
            ),
            Err(PipelineError::ArtifactTaskMismatch)
        );
        assert_eq!(execution.stages[&stage("read")].state, StageState::Running);
        assert!(matches!(
            execution.record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &artifacts
            ),
            Err(PipelineError::MissingProducerOutput { .. })
        ));
        assert_eq!(execution.stages[&stage("edit")].state, StageState::Pending);
        assert_eq!(execution.stages[&stage("read")].state, StageState::Running);
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Succeeded,
                TicketId(uuid(800)),
                BTreeMap::from([(output("summary"), item.clone())]),
                &artifacts,
            )
            .unwrap();
        let grants = vec![grant(21, "editor", "binding-edit", &[Permission::Write])];
        let bindings = vec![binding("binding-edit", "editor")];
        assert_eq!(
            execution
                .next_tasks(&registry(&grants, &bindings, &artifacts))
                .unwrap()
                .ready
                .len(),
            1
        );
        execution
            .attach_task(&stage("edit"), TicketId(uuid(801)))
            .unwrap();
        let wrong_parent = artifact_for_task(102, "edited", vec![], TicketId(uuid(801)));
        artifacts
            .0
            .insert(wrong_parent.artifact_id, wrong_parent.clone());
        assert_eq!(
            execution.record_task_state(
                &stage("edit"),
                TicketStatus::Succeeded,
                TicketId(uuid(801)),
                BTreeMap::from([(output("edited"), wrong_parent)]),
                &artifacts
            ),
            Err(PipelineError::ArtifactParentsMismatch)
        );
        assert_eq!(execution.stages[&stage("edit")].state, StageState::Running);
    }

    #[test]
    fn paused_resumes_only_through_explicit_task_fact() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        ready_first(&execution);
        execution
            .attach_task(&stage("read"), TicketId(uuid(800)))
            .unwrap();
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::WaitingApproval,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &Registry::default(),
            )
            .unwrap();
        assert_eq!(execution.stages[&stage("read")].state, StageState::Paused);
        assert!(matches!(
            execution
                .next_tasks(&PipelineRegistry::empty(at(10)))
                .unwrap()
                .waiting[0]
                .wait,
            StageWait::Paused
        ));
        execution
            .record_task_state(
                &stage("read"),
                TicketStatus::Running,
                TicketId(uuid(800)),
                BTreeMap::new(),
                &Registry::default(),
            )
            .unwrap();
        assert_eq!(execution.stages[&stage("read")].state, StageState::Running);
    }

    #[test]
    fn bounded_frame_has_verified_text_not_arbitrary_path_or_permission() {
        let mut execution = PipelineExecution::new(definition()).unwrap();
        let mut artifacts = Registry::default();
        first_succeeded(&mut execution, &mut artifacts, 100);
        let grants = vec![grant(21, "editor", "binding-edit", &[Permission::Write])];
        let bindings = vec![binding("binding-edit", "editor")];
        let ready = execution
            .next_tasks(&registry(&grants, &bindings, &artifacts))
            .unwrap()
            .ready
            .remove(0);
        let text = VerifiedArtifactText::new(
            &artifacts,
            artifacts.0[&ArtifactId(uuid(100))].clone(),
            "  Loom\n document  ".into(),
        )
        .unwrap();
        let frame = ready
            .execution_frame(&[text], &ready.placement.node_id, RequestId(uuid(700)))
            .unwrap();
        assert_eq!(frame.payload.schema, DOCUMENT_TASK_FRAME_SCHEMA_V1);
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains("\"operation\":\"edit_file\""));
        assert!(!json.contains("binding_digest"));
        assert!(!json.contains("grant_digest"));
        assert_eq!(
            DocumentEdit::TextTransform {
                transform: TextTransform::CollapseWhitespace
            }
            .apply("  Loom\n document  ")
            .unwrap(),
            "Loom document"
        );
        assert_eq!(
            ready.execution_frame(&[], &ready.placement.node_id, RequestId(uuid(700))),
            Err(PipelineError::FrameInputMismatch)
        );
        assert_eq!(
            ready.execution_frame(
                &[],
                &NodeId::parse("b".repeat(64)).unwrap(),
                RequestId(uuid(700))
            ),
            Err(PipelineError::FrameNodeMismatch)
        );
    }

    #[cfg(feature = "fixture-signing")]
    #[test]
    fn versioned_fixture_is_typed_validation_and_not_root_authorization() {
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../protocol/fixtures/pipeline/v1/document.json"
        ))
        .unwrap();
        let definition = crate::node::from_json_strict::<PipelineDefinition>(&bytes).unwrap();
        definition.validate().unwrap();
        let execution = PipelineExecution::new(definition).unwrap();
        assert!(execution
            .next_tasks(&PipelineRegistry::empty(at(10)))
            .unwrap()
            .ready
            .is_empty());
        assert!(!String::from_utf8(bytes).unwrap().contains("/Users/"));
    }

    fn ready_at(
        execution: &PipelineExecution,
        grants: &[GrantDescriptor],
        bindings: &[GrantBindingDescriptor],
        artifacts: &Registry,
    ) -> Result<NextTaskCandidates, PipelineError> {
        execution.next_tasks(&registry(grants, bindings, artifacts))
    }
}
