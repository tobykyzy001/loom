use serde::{Deserialize, Serialize};

use crate::core::{ArtifactId, EffectId, RequestId};
use crate::domain::{ArtifactRef, Effect, EffectStatus, Report, ReportStatus, TicketStatus};
use crate::error::{ProtocolError, ProtocolResult};
use crate::node::ReportDisposition;

/// Terminal report mapping is a single point so `Unknown` cannot become Failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct M0StateMachine;

impl M0StateMachine {
    pub fn project_report(report: ReportStatus) -> TicketStatus {
        match report {
            ReportStatus::Running => TicketStatus::Running,
            ReportStatus::Succeeded => TicketStatus::Succeeded,
            ReportStatus::Failed => TicketStatus::Failed,
            ReportStatus::Cancelled => TicketStatus::Cancelled,
            ReportStatus::Unknown => TicketStatus::Reconciling,
        }
    }

    pub fn reconcile_effect(
        current: EffectStatus,
        host_fact: HostEffectFact,
    ) -> ProtocolResult<EffectStatus> {
        match (current, host_fact) {
            (_, HostEffectFact::StillUnknown) => Ok(EffectStatus::Unknown),
            (EffectStatus::Confirmed | EffectStatus::NeedsPerson, HostEffectFact::Confirmed) => {
                Err(ProtocolError::InvalidEffectTransition(
                    "terminal effect state cannot be changed by a contradictory fact",
                ))
            }
            (_, HostEffectFact::Confirmed) => Ok(EffectStatus::Confirmed),
            (_, HostEffectFact::NeedsPerson) => Ok(EffectStatus::NeedsPerson),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostEffectFact {
    Confirmed,
    StillUnknown,
    NeedsPerson,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportOutcome {
    pub disposition: ReportDisposition,
    pub status: TicketStatus,
    pub request_id: RequestId,
    pub artifacts: Vec<ArtifactRef>,
    pub effects: Vec<Effect>,
}

impl ReportOutcome {
    pub fn duplicate(self) -> Self {
        Self {
            disposition: ReportDisposition::Duplicate,
            ..self
        }
    }

    pub fn artifact_ids(&self) -> impl Iterator<Item = ArtifactId> + '_ {
        self.artifacts.iter().map(|artifact| artifact.artifact_id)
    }

    pub fn effect_ids(&self) -> impl Iterator<Item = EffectId> + '_ {
        self.effects.iter().map(|effect| effect.effect_id)
    }
}

impl From<&Report> for M0StateMachine {
    fn from(report: &Report) -> Self {
        let _ = report;
        Self
    }
}
