use crate::identity::Identity;
use crate::wire::{ChallengeResponse, PollResponse, RegisterResponse};
use anyhow::{bail, Context, Result};
use loom_protocol::{Capability, NodeEnvelope, NodeStatus, Permission, TicketKind, WorkerSnapshot};
use reqwest::{header, StatusCode, Url};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug)]
pub struct HttpError {
    pub status: Option<StatusCode>,
    pub message: String,
    pub retryable: bool,
}
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for HttpError {}

#[derive(Clone, Debug)]
pub struct NodeClient {
    http: reqwest::Client,
    base: Url,
}

impl NodeClient {
    pub fn new(coordinator: &str) -> Result<Self> {
        let base =
            Url::parse(coordinator).context("coordinator must be an absolute HTTP(S) URL")?;
        if !matches!(base.scheme(), "http" | "https") || base.cannot_be_a_base() {
            bail!("coordinator must be HTTP(S)");
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("loom-node/{}", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self { http, base })
    }

    pub async fn enroll(
        &self,
        identity: &mut Identity,
        enrollment_code: &str,
        project_roots: Value,
    ) -> Result<()> {
        if enrollment_code.is_empty() || enrollment_code.len() > 128 {
            bail!("enrollment code is empty or too long");
        }
        let body = identity.public_request();
        let challenge: ChallengeResponse = self
            .request("/api/v1/nodes/challenge", body.clone(), None, 15)
            .await?;
        let signature = identity.sign_challenge(&challenge.nonce)?;
        let registration = loom_protocol::RegisterNodeRequest {
            protocol: Default::default(),
            node_id: loom_protocol::NodeId::parse(identity.node_id.clone())?,
            installation_id: loom_protocol::InstallationId::parse(
                identity.installation_id.clone(),
            )?,
            public_key: body["public_key"].as_str().unwrap_or_default().to_owned(),
            enrollment_code: enrollment_code.to_owned(),
            nonce: loom_protocol::ChallengeNonce::parse(challenge.nonce)?,
            signed_challenge: signature,
            request_id: loom_protocol::RequestId::new(),
            capabilities: capabilities(),
            worker_id: loom_protocol::WorkerId::parse("default")?,
            harness_kind: loom_protocol::HarnessKind::parse("bare-rust-deterministic")?,
            profile_id: loom_protocol::ProfileId::parse("isolated")?,
        };
        let retried_with_token = identity.token().is_ok();
        let body = serde_json::to_value(registration.clone())?;
        let response = self
            .request_raw("/api/v1/nodes/register", body, identity.token().ok(), 15)
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error)
                if retried_with_token
                    && error
                        .downcast_ref::<HttpError>()
                        .is_some_and(|e| e.status == Some(StatusCode::UNAUTHORIZED)) =>
            {
                // Reuse of the old enrollment code is never attempted. A lost token needs
                // operator-issued recovery; a failed registration may safely be retried.
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        let registration_response: RegisterResponse = serde_json::from_value(response)?;
        identity.set_token(&registration_response.token)?;
        self.heartbeat_with_roots(identity, NodeStatus::Online, project_roots)
            .await?;
        Ok(())
    }

    /// The poll endpoint returns the matching current attempt or null. It never
    /// substitutes another ticket's cancellation signal for the active attempt.
    pub async fn cancellation_for(
        &self,
        identity: &Identity,
        assignment_id: &str,
        ticket_id: &str,
    ) -> Result<bool> {
        let polled = self.poll(identity, Some(assignment_id), 1).await?;
        Ok(polled.assignment.as_ref().is_some_and(|value| {
            value["id"]
                .as_str()
                .or_else(|| value["assignment_id"].as_str())
                == Some(assignment_id)
                && value["ticket_id"].as_str() == Some(ticket_id)
                && value["purpose"].as_str() != Some("reconcile")
                && (value["cancel_requested"].as_bool() == Some(true)
                    || matches!(
                        value["status"].as_str(),
                        Some("cancel_requested" | "cancelled")
                    ))
        }))
    }

    pub async fn heartbeat_with_roots(
        &self,
        identity: &Identity,
        status: NodeStatus,
        project_roots: Value,
    ) -> Result<Value> {
        let envelope = NodeEnvelope {
            protocol: Default::default(),
            node_id: loom_protocol::NodeId::parse(identity.node_id.clone())?,
            installation_id: loom_protocol::InstallationId::parse(
                identity.installation_id.clone(),
            )?,
            request_id: loom_protocol::RequestId::new(),
            sent_at: Some(chrono::Utc::now()),
            payload: loom_protocol::Heartbeat {
                status,
                workers: vec![worker(status)],
            },
        };
        let mut body = serde_json::to_value(envelope)?;
        body["capabilities"] = serde_json::to_value(capabilities())?;
        body["workers"] = serde_json::to_value(vec![worker(status)])?;
        body["inventory"] = json!({"project_roots":project_roots,"harness_kind":"bare-rust-deterministic","source":"host_operator_explicit_config","observed_at":chrono::Utc::now()});
        self.request("/api/v1/nodes/heartbeat", body, Some(identity.token()?), 15)
            .await
    }

    pub async fn poll(
        &self,
        identity: &Identity,
        last_assignment_id: Option<&str>,
        wait_seconds: u64,
    ) -> Result<PollResponse> {
        if !(1..=15).contains(&wait_seconds) {
            bail!("poll wait_seconds must be within [1,15]");
        }
        let envelope = NodeEnvelope {
            protocol: Default::default(),
            node_id: loom_protocol::NodeId::parse(identity.node_id.clone())?,
            installation_id: loom_protocol::InstallationId::parse(
                identity.installation_id.clone(),
            )?,
            request_id: loom_protocol::RequestId::new(),
            sent_at: Some(chrono::Utc::now()),
            payload: loom_protocol::AssignmentPoll {
                last_assignment_id: None,
                wait_seconds,
            },
        };
        // The actual center accepts its own string AssignmentIds, while the shared
        // UUID AssignmentId does not represent them. Preserve the wire scalar here.
        let mut body = serde_json::to_value(envelope)?;
        body["last_assignment_id"] = last_assignment_id.map_or(Value::Null, |id| json!(id));
        self.request(
            "/api/v1/nodes/assignments/poll",
            body,
            Some(identity.token()?),
            wait_seconds + 20,
        )
        .await
    }

    pub async fn deliver(&self, identity: &Identity, kind: &str, body: &Value) -> Result<Value> {
        let path = match kind {
            "artifact" => "/api/v1/nodes/artifacts",
            "report" => "/api/v1/nodes/reports",
            _ => bail!("unsupported delivery kind"),
        };
        self.request(path, body.clone(), Some(identity.token()?), 20)
            .await
    }

    pub async fn acknowledge(
        &self,
        identity: &Identity,
        assignment: &crate::wire::Assignment,
        accepted: bool,
        reason: &str,
    ) -> Result<Value> {
        self.acknowledge_envelope(
            &mut assignment.envelope(
                &Uuid::new_v4().to_string(),
                &identity.node_id,
                &identity.installation_id,
            ),
            identity,
            accepted,
            reason,
        )
        .await
    }

    pub async fn acknowledge_envelope(
        &self,
        body: &mut serde_json::Map<String, Value>,
        identity: &Identity,
        accepted: bool,
        reason: &str,
    ) -> Result<Value> {
        body.insert("accepted".into(), json!(accepted));
        body.insert(
            "reason".into(),
            json!(reason.chars().take(1000).collect::<String>()),
        );
        body.insert(
            "acknowledgement".into(),
            json!(if accepted { "accepted" } else { "rejected" }),
        );
        self.request(
            "/api/v1/nodes/acknowledge",
            Value::Object(body.clone()),
            Some(identity.token()?),
            15,
        )
        .await
    }

    pub async fn cancellation_observed(
        &self,
        identity: &Identity,
        assignment: &crate::wire::Assignment,
        reason: &str,
    ) -> Result<Value> {
        let mut body = assignment.envelope(
            &Uuid::new_v4().to_string(),
            &identity.node_id,
            &identity.installation_id,
        );
        body.insert("accepted".into(), json!(false));
        body.insert("acknowledgement".into(), json!("cancelled"));
        body.insert("cancellation".into(), json!(true));
        body.insert("cancel_requested".into(), json!(true));
        body.insert("cancel_acknowledged".into(), json!(true));
        body.insert(
            "reason".into(),
            json!(reason.chars().take(1000).collect::<String>()),
        );
        self.request(
            "/api/v1/nodes/acknowledge",
            Value::Object(std::mem::take(&mut body)),
            Some(identity.token()?),
            15,
        )
        .await
    }

    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: Value,
        token: Option<&str>,
        timeout: u64,
    ) -> Result<T> {
        let response = self.request_raw(path, body, token, timeout).await?;
        serde_json::from_value(response)
            .context("coordinator response fields are incompatible with loom.node.v1 client")
    }

    async fn request_raw(
        &self,
        path: &str,
        body: Value,
        token: Option<&str>,
        timeout: u64,
    ) -> Result<Value> {
        let url = self
            .base
            .join(path)
            .context("invalid coordinator API route")?;
        let mut request = self
            .http
            .post(url)
            .timeout(Duration::from_secs(timeout))
            .header(header::ACCEPT, "application/json")
            .json(&body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|error| HttpError {
            status: error.status(),
            message: sanitize_http_error("coordinator request failed", &error),
            retryable: true,
        })?;
        let status = response.status();
        // reqwest's bytes limit is bounded after headers and errors are sanitized;
        // the center independently caps the assignment and inline artifact sizes.
        let bytes = response.bytes().await.map_err(|error| HttpError {
            status: Some(status),
            message: sanitize_http_error("cannot read coordinator response", &error),
            retryable: true,
        })?;
        if bytes.len() > 2 * 1024 * 1024 {
            bail!(HttpError {
                status: Some(status),
                message: "coordinator response exceeds 2 MiB".to_owned(),
                retryable: false
            });
        }
        let value: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| HttpError {
                status: Some(status),
                message: "coordinator response is not JSON".to_owned(),
                retryable: status.is_server_error(),
            })?
        };
        if !status.is_success() {
            let code = value["error"]["code"].as_str().unwrap_or("http_error");
            let message = value["error"]["message"]
                .as_str()
                .unwrap_or("coordinator rejected request");
            return Err(HttpError {
                status: Some(status),
                message: format!(
                    "HTTP {status} {code}: {}",
                    message.chars().take(1000).collect::<String>()
                ),
                retryable: status == StatusCode::REQUEST_TIMEOUT
                    || status == StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error(),
            }
            .into());
        }
        Ok(value)
    }
}

pub fn capabilities() -> Vec<Capability> {
    vec![
        Capability {
            ticket_kind: TicketKind::ReadSummary,
            permission: Permission::Read,
        },
        Capability {
            ticket_kind: TicketKind::EditFile,
            permission: Permission::Write,
        },
    ]
}
pub fn worker(status: NodeStatus) -> WorkerSnapshot {
    WorkerSnapshot {
        worker_id: loom_protocol::WorkerId::parse("default").expect("fixed worker id"),
        harness_kind: loom_protocol::HarnessKind::parse("bare-rust-deterministic")
            .expect("fixed harness"),
        profile_id: loom_protocol::ProfileId::parse("isolated").expect("fixed profile"),
        status,
        capabilities: capabilities(),
        observed_at: chrono::Utc::now(),
        supported_effects: vec!["file.replace".to_owned()],
    }
}
fn sanitize_http_error(prefix: &str, error: &reqwest::Error) -> String {
    let kind = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "connection failed"
    } else {
        "transport error"
    };
    format!("{prefix}: {kind}")
}
