//! Single-node deterministic end-to-end benchmark using only synthetic fixtures.
use crate::api::ApiResult;
use crate::*;
use base64::Engine as _;
use reqwest::Client;
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug)]
struct Bench {
    client: Client,
    base: String,
    client_token: String,
    node_token: String,
    node_id: String,
    installation_id: String,
    key: ed25519_dalek::SigningKey,
}
impl Bench {
    // All calls carry node-specific or client credentials, never an anonymous fallback.
    async fn call(&self, url: &str, body: Value, admin: bool) -> ApiResult<(u16, Value)> {
        let token = if admin {
            &self.client_token
        } else {
            &self.node_token
        };
        let full = format!("{}/api/v1{}", self.base, url);
        let response = self
            .client
            .post(full)
            .bearer_auth(token)
            .json(&body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| crate::api::ApiError::bad("Request failed"))?;
        let status = response.status().as_u16();
        let value = response.json().await.unwrap_or(Value::Null);
        Ok((status, value))
    }
    fn envelope(&self) -> Value {
        json!({"protocol":"loom.node.v1","node_id":self.node_id,"installation_id":self.installation_id,"request_id":id("request").to_string()})
    }
    async fn auth_request(&self, path: &str, extra: Value) -> ApiResult<(u16, Value)> {
        let path = format!("/nodes{path}");
        let mut body = if extra.get("request_id").is_some() {
            json!({"protocol":"loom.node.v1","node_id":self.node_id,"installation_id":self.installation_id})
        } else {
            self.envelope()
        };
        if let Some(m) = extra.as_object() {
            for (k, v) in m {
                body[k] = v.clone();
            }
        }
        self.call(&path, body, false).await
    }
    async fn admin(&self, path: &str, body: Value) -> ApiResult<(u16, Value)> {
        self.call(path, body, true).await
    }
}

fn b64(bytes: impl AsRef<[u8]>) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}
async fn create_node_key(seed: [u8; 32]) -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&seed)
}
fn register_request(
    key: &ed25519_dalek::SigningKey,
    node_id: &str,
    installation: &str,
    code: &str,
    nonce: &str,
) -> Value {
    use ed25519_dalek::Signer;
    json!({"protocol":"loom.node.v1","node_id":node_id,"installation_id":installation,"public_key":b64(key.verifying_key().as_bytes()),"enrollment_code":code,"nonce":nonce,"signed_challenge":b64(key.sign(nonce.as_bytes()).to_bytes()),"request_id":"9de22fcb-6205-43d3-aabe-7baacee914db","capabilities":[{"ticket_kind":"read_summary","permission":"read"},{"ticket_kind":"edit_file","permission":"write"}],"worker_id":"default","harness_kind":"deterministic-bare-node","profile_id":"baseline"})
}
pub async fn smoke(directory: Option<PathBuf>, listen: String) -> Result<()> {
    let temp = directory
        .is_none()
        .then(|| tempfile::tempdir().expect("isolated benchmark temporary root"));
    let root = match (&temp, &directory) {
        (Some(temp), _) => temp.path().to_owned(),
        (_, Some(dir)) => dir.clone(),
        _ => unreachable!(),
    };
    let fixture = root.join("fixture-project");
    fs::create_dir_all(&fixture)?;
    fs::write(
        fixture.join("README.md"),
        "Loom deterministic fixture\nPROJECT ALPHA\nThis read-only fixture is safe to summarize.\n",
    )?;
    let state = crate::api::State::open(
        root.join("center"),
        Some("benchmark-client-token-change-me"),
    )?;
    let server_state = state.clone();
    let listener = tokio::net::TcpListener::bind(listen).await?;
    let base = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::api::router(Arc::new(server_state))).await
    });
    let result = run(base, state, root, fixture).await;
    server.abort();
    match result {
        Ok(()) => {
            println!("\nDeterministic benchmark PASS: registration, signed challenge, authorization, authenticated long-poll, verified artifact, restart, cancellation, fencing and unknown reconciliation.");
            Ok(())
        }
        Err(e) => {
            eprintln!("Benchmark failed: {}", e);
            Err(anyhow::anyhow!(e))
        }
    }
}
async fn run(
    base: String,
    state: crate::api::State,
    root: PathBuf,
    fixture: PathBuf,
) -> ApiResult<()> {
    let key = create_node_key([22u8; 32]).await;
    let pk = b64(key.verifying_key().as_bytes());
    let node_id = store::hex(sha2::Sha256::digest(key.verifying_key().as_bytes()));
    let installation = "benchmark-installation".to_owned();
    let client = Client::new();
    let token = "benchmark-client-token-change-me".to_owned();
    let mut b = Bench {
        client: client.clone(),
        base: base.clone(),
        client_token: token.clone(),
        node_token: String::new(),
        node_id: node_id.clone(),
        installation_id: installation.clone(),
        key,
        // Authentication is per-node and stored in the dedicated state root.
    };
    let (_, code) = b.admin("/enrollment-codes", json!({})).await?;
    let challenge=client.post(format!("{}/api/v1/nodes/challenge",base)).json(&json!({"protocol":"loom.node.v1","node_id":node_id,"installation_id":installation,"public_key":pk})).send().await.map_err(|_|crate::api::ApiError::bad("challenge connection"))?.json::<Value>().await.unwrap();
    let request = register_request(
        &b.key,
        &node_id,
        &installation,
        code["code"].as_str().unwrap_or_default(),
        challenge["nonce"].as_str().unwrap(),
    );
    let (status, reg) = b.admin("/nodes/register", request.clone()).await?;
    check(
        status == 200 && reg["token"].as_str().is_some(),
        "signed enrollment and node identity binding",
    )?;
    b.node_token = reg["token"].as_str().unwrap().to_owned();
    let (duplicate_status, reg2) = b.admin("/nodes/register", request).await?;
    check(duplicate_status != 200, "replay cannot mint credential")?;
    check(
        reg2["error"].is_object(),
        "single-use code re-registration denied",
    )?;
    let (status,heartbeat)=b.auth_request("/heartbeat",json!({"status":"online","capabilities":[{"ticket_kind":"read_summary","permission":"read"},{"ticket_kind":"edit_file","permission":"write"}],"workers":[{"worker_id":"default"}],"inventory":{"source":"trusted_host_local_registration"}})).await?;
    check(
        status == 200,
        format!(
            "heartbeat status={status}, node_id={}, response_code={}",
            b.node_id,
            heartbeat["error"]["code"].as_str().unwrap_or("none")
        ),
    )?;
    let (status,prj)=b.admin("/projects",json!({"name":"Synthetic fixture","root":fixture.to_string_lossy(),"mode":"read_write"})).await?;
    check(
        status == 200 && prj["project"]["id"].is_string(),
        format!("existing project {prj}"),
    )?;
    let pid = prj["project"]["id"].as_str().unwrap().to_owned();
    let mut inventory = json!({"project_roots":{}, "harness_kind":"deterministic-local-host"});
    inventory["project_roots"][&pid] = json!(fixture.to_string_lossy());
    let (declare_status, _) = b.auth_request("/heartbeat", json!({"status":"online","capabilities":[{"ticket_kind":"read_summary","permission":"read"},{"ticket_kind":"edit_file","permission":"write"}],"workers":[{"worker_id":"default"}],"inventory":inventory})).await?;
    check(
        declare_status == 200,
        "Local host declares the same project mapping later approved by administrator",
    )?;
    let (bind_status, binding) = b.admin("/project-bindings", json!({"project_id":pid,"node_id":node_id,"worker_id":"default","root_scope":fixture.to_string_lossy()})).await?;
    check(
        bind_status == 200,
        format!(
            "exact host project location approved code:{}",
            binding["error"]["code"].as_str().unwrap_or("none")
        ),
    )?;
    let (status, grant) = b
        .admin(
            "/grants",
            json!({"project_id":pid,"operations":"read_write"}),
        )
        .await?;
    check(status == 200, "explicit project authorization")?;
    let gid = grant["grant"]["id"].as_str().unwrap().to_owned();
    let (status,t)=b.admin("/tickets",json!({"project_id":pid,"objective":"Read the fixture and produce a separate summary","kind":"read_summary","relative_path":"README.md","worker_id":"default"})).await?;
    check(status == 200, format!("ticket create {t}"))?;
    let tid = t["id"].as_str().unwrap();
    let (status, poll) = b
        .auth_request("/assignments/poll", json!({"wait_seconds":0}))
        .await?;
    check(
        status == 200 && poll["assignment"]["ticket_id"] == tid,
        format!("assignment {poll}"),
    )?;
    let a = poll["assignment"].clone();
    let epoch = a["lease_epoch"].clone();
    let artifact = uuid::Uuid::new_v4().to_string();
    let bytes = b"Deterministic fixture summary: PROJECT ALPHA\n";
    let digest = sha256(bytes);
    let upload = json!({"ticket_id":tid,"assignment_id":a["assignment_id"],"lease_epoch":epoch,"artifact_id":artifact,"bytes_base64":base64::engine::general_purpose::STANDARD.encode(bytes),"metadata":{"artifact_id":artifact,"name":"summary.txt","media_type":"text/plain","sha256":digest,"size_bytes":bytes.len()}});
    let (status, art) = b.auth_request("/artifacts", upload.clone()).await?;
    check(
        status == 200 && art["sha256"] == digest,
        format!("hash checked upload {art}"),
    )?;
    let (replay_status, _) = b.auth_request("/artifacts", upload.clone()).await?;
    check(
        replay_status == 200,
        "same ID, lineage and bytes replay is read-only idempotent",
    )?;
    // Artifact collision checks occur before the first success report.
    let mut bad_upload = upload.clone();
    bad_upload["bytes_base64"] =
        json!(base64::engine::general_purpose::STANDARD.encode(b"malicious replacement"));
    bad_upload["metadata"]["sha256"] = json!(sha256(b"malicious replacement"));
    bad_upload["metadata"]["size_bytes"] = json!(b"malicious replacement".len());
    let (conflict_status, conflict) = b.auth_request("/artifacts", bad_upload).await?;
    check(
        conflict_status == 409 && conflict["error"]["code"] == "artifact_conflict",
        "different bytes sharing existing ID must be rejected before overwrite",
    )?;
    let original_path = root
        .join("center/artifacts")
        .join(format!("{artifact}.artifact"));
    check(
        fs::read_to_string(original_path)?
            == String::from_utf8_lossy(
                &"Deterministic fixture summary: PROJECT ALPHA\n".as_bytes(),
            ),
        "original artifact bytes unchanged by colliding upload",
    )?;
    let original_index = state
        .lock()?
        .get("artifacts", &artifact)?
        .unwrap_or(Value::Null);
    check(
        original_index["sha256"] == digest,
        "original immutable index remains intact after collision",
    )?;
    let mut report = json!({"ticket_id":tid,"assignment_id":a["assignment_id"],"lease_epoch":epoch,"state":"succeeded","summary":"Read and summarised only the synthetic file.","artifact_ids":[artifact],"effects":[{"effect_id":id("effect"),"input_digest":digest,"status":"confirmed","evidence":[{"kind":"artifact","digest":digest}]}]});
    let (status, r1) = b.auth_request("/reports", report.clone()).await?;
    check(
        status == 200 && r1["ticket_status"] == "succeeded",
        format!("structured succeeded report {r1}"),
    )?;
    let replay_request_id = r1["request_id"]
        .as_str()
        .ok_or_else(|| crate::api::ApiError::bad("accepted report has no request_id"))?
        .to_owned();
    report["request_id"] = json!(replay_request_id);
    let (status, r2) = b.auth_request("/reports", report.clone()).await?;
    check(
        status == 200 && r2["duplicate"] == true,
        "identical Request ID and payload must use the idempotent result",
    )?;
    let (late_status, late_response) = b.auth_request("/reports", json!({"ticket_id":tid,"assignment_id":a["assignment_id"],"lease_epoch":epoch,"state":"failed","summary":"Different callback cannot rewrite a successful Ticket.","effects":[]})).await?;
    check(
        late_status == 409 && late_response["error"]["code"] == "terminal_result",
        "a new report cannot rewrite a successful Ticket",
    )?;
    check(
        state.lock()?.detail(tid)?["status"] == "succeeded",
        "actual successful authority state is immutable",
    )?;
    report["summary"] = json!("Changed body must not be accepted as the original receipt");
    let (invalid_replay_status, _) = b.auth_request("/reports", report.clone()).await?;
    check(
        invalid_replay_status == 409,
        "the same Request ID with altered evidence is rejected",
    );
    let fresh = crate::api::State::open(root.join("center"), Some(&token))?;
    let persisted = fresh.lock()?.detail(tid)?.clone();
    check(
        persisted["status"] == "succeeded"
            && persisted["artifacts"]
                .as_array()
                .is_some_and(|x| !x.is_empty()),
        "Successful task reconstructed after reopening SQLite",
    )?;
    let artifact = b
        .client
        .get(format!(
            "{}/api/v1/tickets/{}/artifacts/{}",
            base, tid, artifact
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .map_err(|e| crate::api::ApiError::bad(e.to_string()))?;
    check(
        artifact["content"]
            .as_str()
            .is_some_and(|s| s.contains("PROJECT ALPHA")),
        "authoritative artifact bytes can be retrieved by an authenticated client",
    )?;
    let (_, edit) = b
        .auth_request("/assignments/poll", json!({"wait_seconds":0}))
        .await?;
    let (_,t2)=b.admin("/tickets",json!({"project_id":pid,"objective":"Mutation then cancellation must not claim success","kind":"edit_file","relative_path":"result.txt","content":"fixture output","grant_id":gid,"worker_id":"default"})).await?;
    let t2 = t2["id"].as_str().unwrap().to_owned();
    let cancel = client
        .post(format!("{}/api/v1/tickets/{}/cancel", base, t2))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .map_err(|e| crate::api::ApiError::bad(e.to_string()))?;
    check(
        cancel["status"] == "cancel_requested" || cancel["status"] == "cancelled",
        format!("durable stop intent {cancel}"),
    )?;
    let (_, a2) = b
        .auth_request("/assignments/poll", json!({"wait_seconds":0}))
        .await?;
    let assignment = a2["assignment"].clone();
    let attempted = json!({"ticket_id":t2,"assignment_id":assignment["assignment_id"],"lease_epoch":1,"state":"succeeded","summary":"Deliberately invalid callback after cancellation.","artifact_ids":[artifact]});
    let (_, bad) = b.auth_request("/reports", attempted).await?;
    check(
        bad["error"].is_object(),
        "Late success after cancellation is rejected, never false success",
    )?;
    check(
        state.lock()?.detail(&t2)?["status"].as_str() == Some("cancel_requested"),
        "Cancellation retained prior to node reconciliation",
    )?;
    let (_,unknown_base)=b.admin("/tickets",json!({"project_id":pid,"objective":"An unknown outcome stays reconciling","kind":"read_summary","relative_path":"README.md","grant_id":gid,"worker_id":"default"})).await?;
    let unknown_ticket = unknown_base["id"].as_str().unwrap().to_owned();
    let (_, a3) = b
        .auth_request("/assignments/poll", json!({"wait_seconds":0}))
        .await?;
    let a3 = a3["assignment"].clone();
    let revoke = client
        .post(format!("{}/api/v1/grants/{}/revoke", base, gid))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .map_err(|e| crate::api::ApiError::bad(e.to_string()))?;
    check(revoke["revoked"] == true, "Grant revoked")?;
    let (_,r)=b.auth_request("/reports",json!({"ticket_id":unknown_ticket,"assignment_id":a3["assignment_id"],"lease_epoch":1,"state":"unknown","summary":"External effect is unknown","effects":[{"effect_id":id("effect"),"input_digest":"unknown-effect-input","status":"unknown","evidence":[{"kind":"external_agent_instance"}]}]})).await?;
    check(
        r["ticket_status"] == "reconciling",
        format!(
            "Unknown outcome must enter reconciliation, not failed or success; error_code={}",
            r["error"]["message"].as_str().unwrap_or("none")
        ),
    )?;
    let retry_request = client
        .post(format!("{}/api/v1/tickets/{}/retry", base, unknown_ticket))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|_| crate::api::ApiError::bad("retry connection failed"))?;
    let retry_status = retry_request.status().as_u16();
    let retry_response = retry_request.json::<Value>().await.unwrap_or(Value::Null);
    check(
        retry_status == 409 || retry_response["error"].is_object(),
        "Unknown outcome is protected from blind retry",
    )?;
    let reopened = crate::api::State::open(root.join("center"), Some(&token))?;
    check(
        reopened.lock()?.verify_audit()?,
        "Tamper-evident audit chain valid after restart",
    )?;
    println!("  fixture: {}\n  successful ticket: {}\n  cancel intent persisted\n  invalid late callback fenced",fixture.display(),tid);
    Ok(())
}
fn check(condition: bool, label: impl AsRef<str>) -> ApiResult<()> {
    if condition {
        println!("  PASS: {}", label.as_ref());
        Ok(())
    } else {
        Err(crate::api::ApiError::bad(format!(
            "Assertion failed: {}",
            label.as_ref()
        )))
    }
}
pub async fn doctor(root: &Path) -> Result<()> {
    let s = crate::api::State::open(root, None)?;
    let store = s.lock().map_err(|_| anyhow::anyhow!("store"))?;
    let out = json!({"schema_version":store.conn().query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0))?, "integrity":store.query("PRAGMA integrity_check",[])?,"audit_valid":store.verify_audit()?,"state_dir":root,"online_devices_note":"Actual external device checks require their local runtime; this is a local persistence inspection only."});
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
pub async fn reconcile(_root: &Path) -> Result<()> {
    println!("The center does not infer remote file/session effects. Inspect each Host's durable ledger, and resolve the recorded effect IDs through that Host after operator review; no blindly repeated external operation was performed.");
    Ok(())
}
