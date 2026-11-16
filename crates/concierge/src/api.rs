//! HTTP handlers parse strictly versioned DTOs and enforce identity, scope,
//! immutable artifact lineage and Lease fencing. All writes stay in SQLite.
use crate::*;
use axum::{
    extract::State as AppState,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    // Existing Axum Body reader keeps this production-route regression dependency-free.
    use std::{
        path::Path,
        sync::{Arc, Mutex},
    };
    use tower::ServiceExt;
    #[test]
    fn static_serving_only_accepts_bounded_public_directory() {
        assert_eq!(
            public_web_path("assets/index.js"),
            Some(PathBuf::from("assets/index.js"))
        );
        for input in [
            "../../foo.js",
            ".env",
            "assets/.secret.key",
            "assets/a\\b.js",
            "assets/thing.exe",
        ] {
            assert!(
                public_web_path(input).is_none(),
                "unexpected static path: {input}"
            );
        }
    }
    #[tokio::test]
    async fn messages_can_be_retrieved_by_a_bounded_ticket_id() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::store::Store::open(directory.path()).unwrap();
        db.set_setting(
            "client_token_hash",
            &crate::store::hash("test-client-token-123456789012345"),
        )
        .unwrap();
        db.conn().execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES('global',NULL,'worker','concierge','activity','global',NULL,'summary','2026-01-01T00:00:00Z','global')", []).unwrap();
        db.conn().execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES('delegated','tkt_child','worker','concierge','session_link','delegated','{\"artifact_id\":\"source\"}','summary','2026-01-01T00:00:01Z','delegated')", []).unwrap();
        let app = router(Arc::new(State {
            store: Arc::new(Mutex::new(db)),
            bootstrap_token: "test-client-token-123456789012345".into(),
            bootstrap_token_written: false,
        }));
        let response = app
            .oneshot(
                axum::extract::Request::builder()
                    .method("GET")
                    .uri("/api/v1/messages?ticket_id=tkt_child")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer test-client-token-123456789012345",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["messages"].as_array().unwrap().len(), 1);
        assert_eq!(value["messages"][0]["id"], "delegated");
    }

    #[test]
    fn any_delegation_claim_without_a_real_parent_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::store::Store::open(directory.path()).unwrap();
        let forged = json!({
            "ticket_id": "tkt_child", "kind": "session_link",
            "session_ref": {"delegated_from": {
                "type": "artifact_ref", "artifact_id": uuid::Uuid::new_v4(),
                "ticket_id": "tkt_parent_fake", "origin_node_id": "a".repeat(64),
                "sha256": "b".repeat(64), "location": "loom://artifact/not-the-producer",
                "parents": [], "session": {"session_id":uuid::Uuid::new_v4()}
            }}
        });
        assert!(validated_delegation_relation(&db, &forged).is_err());
        let mut wrong_kind = forged;
        wrong_kind["kind"] = json!("activity");
        assert!(validated_delegation_relation(&db, &wrong_kind).is_err());
    }

    #[tokio::test]
    async fn actual_assets_are_not_false_spa_fallback_and_symlinks_fail_closed() {
        let store = tempfile::tempdir().unwrap();
        let web = store.path().join("web");
        std::fs::create_dir_all(web.join("assets")).unwrap();
        std::fs::write(web.join("index.html"), "<html>app shell</html>").unwrap();
        let expected = "export const installed = true;";
        std::fs::write(web.join("assets/app.js"), expected).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(Path::new("/etc"), web.join("assets/extra")).unwrap();
        let database = crate::store::Store::open(store.path().join("db")).unwrap();
        database
            .set_setting(
                "web_dir",
                web.canonicalize().unwrap().to_string_lossy().as_ref(),
            )
            .unwrap();
        let app = router(Arc::new(State {
            store: Arc::new(Mutex::new(database)),
            bootstrap_token: "only-synthetic-state".to_owned(),
            bootstrap_token_written: false,
        }));
        for (url, want_body) in [
            ("/assets/app.js", expected),
            ("/login", "<html>app shell</html>"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::extract::Request::builder()
                        .uri(url)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{url}");
            let body = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
                .await
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&body), want_body, "{url}");
        }
        for url in [
            "/assets/does-not-exist.js",
            "/assets/extra/passwd",
            "/api/not-a-route",
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::extract::Request::builder()
                        .uri(url)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 404, "{url}");
        }
    }
}

use std::{
    // Application state shares one durable authority.
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use tower_http::{services::ServeFile, trace::TraceLayer};

#[derive(Clone)]
pub struct State {
    pub store: Arc<Mutex<store::Store>>,
    pub bootstrap_token: String,
    pub bootstrap_token_written: bool,
}
#[derive(Clone, Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
impl ApiError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    pub fn denied(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }
    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }
    pub fn conflict(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
    pub fn missing(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for ApiError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_io_error",
            "Persistent storage operation was not completed.",
        )
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
pub type ApiResult<T> = std::result::Result<T, ApiError>;
impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "Database operation failed; state was not silently changed.",
        )
    }
}
impl std::error::Error for ApiError {}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        let lower = error.to_string();
        if lower.contains("not found") {
            Self::missing(lower)
        } else {
            Self::bad(lower)
        }
    }
}
impl From<loom_protocol::ProtocolError> for ApiError {
    fn from(e: loom_protocol::ProtocolError) -> Self {
        ApiError::bad(e.to_string())
    }
}

#[derive(Serialize, Deserialize)]
struct Identity {
    protocol: String,
    node_id: String,
    installation_id: String,
    public_key: String,
}
// The client credential isn't represented by an anonymous enrollment object.
impl State {
    pub fn open(root: impl AsRef<Path>, client_token: Option<&str>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        let store = store::Store::open(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.as_ref(), fs::Permissions::from_mode(0o700))?;
        }
        let marker = root.as_ref().join("bootstrap-client-token");
        let already_initialized = store.setting("client_token_hash").is_some();
        if client_token.is_none() && already_initialized && !marker.exists() {
            bail!("Existing center requires the configured LOOM_CLIENT_TOKEN; recovery must never silently replace its administrator credential")
        }
        let (bootstrap_token, bootstrap_token_written) = match client_token {
            Some(raw) => {
                if raw.len() < 24 {
                    bail!("LOOM_CLIENT_TOKEN must be at least 24 characters")
                }
                store.set_setting("client_token_hash", &store::hash(raw))?;
                fs::remove_file(marker).ok();
                (raw.to_owned(), false)
            }
            None if marker.exists() => (fs::read_to_string(marker)?.trim().to_owned(), false),
            None => {
                let fresh = token();
                store.set_setting("client_token_hash", &store::hash(&fresh))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&marker)?;
                    use std::io::Write;
                    Write::write_all(&mut file, fresh.as_bytes())?;
                    file.sync_all()?;
                }
                #[cfg(not(unix))]
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&marker)?;
                #[cfg(not(unix))]
                fs::write(&marker, &fresh)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))?;
                }
                (fresh, true)
            }
        };
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token,
            bootstrap_token_written,
        })
    }
    pub(crate) fn lock(&self) -> ApiResult<std::sync::MutexGuard<'_, store::Store>> {
        self.store.lock().map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_lock",
                "Store lock unavailable",
            )
        })
    }
}
fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|t| t.len() >= 16)
        .ok_or_else(|| ApiError::auth("Valid bearer authentication required"))
}
fn client(state: &State, headers: &HeaderMap) -> ApiResult<()> {
    let expected = state
        .lock()?
        .setting("client_token_hash")
        .ok_or_else(|| ApiError::auth("No administrative client has been initialized"))?;
    if store::same_secret(&expected, &store::hash(bearer(headers)?)) {
        Ok(())
    } else {
        Err(ApiError::auth("Client authentication failed"))
    }
}
// Authentication happens once per signed request in the transport handler.
pub(crate) fn node_authenticate_for_direct_offer(
    state: &State,
    headers: &HeaderMap,
    body: &Value,
) -> ApiResult<()> {
    node(state, headers, body).map(|_| ())
}
fn node(state: &State, headers: &HeaderMap, body: &Value) -> ApiResult<(String, String)> {
    let node = required(body, "node_id", 128)?.to_owned();
    let installation = required(body, "installation_id", 128)?.to_owned();
    if body["protocol"] != "loom.node.v1" {
        return Err(ApiError::new(
            StatusCode::UPGRADE_REQUIRED,
            "protocol_mismatch",
            "Use loom.node.v1; incompatible messages are not reinterpreted.",
        ));
    }
    required(body, "request_id", 160)?;
    if state
        .lock()?
        .authenticate_node(&node, &installation, bearer(headers)?)?
    {
        Ok((node, installation))
    } else {
        Err(ApiError::auth(
            "Node token, installation and revocation state do not permit this request",
        ))
    }
}
fn envelope(body: &Value) -> ApiResult<(String, String, String)> {
    if body["protocol"] != "loom.node.v1" {
        return Err(ApiError::new(
            StatusCode::UPGRADE_REQUIRED,
            "protocol_mismatch",
            "Expected loom.node.v1",
        ));
    }
    Ok((
        required(body, "node_id", 160)?.to_owned(),
        required(body, "installation_id", 160)?.to_owned(),
        required(body, "request_id", 160)?.to_owned(),
    ))
}
fn deserialize<T: serde::de::DeserializeOwned>(body: &Value) -> ApiResult<T> {
    serde_json::from_value(body.clone()).map_err(|e| ApiError::bad(e.to_string()))
}
// Responses use Json wrappers directly to preserve status and error codes.
fn admin_routes(_state: Arc<State>) -> Router<Arc<State>> {
    Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/projects", get(projects).post(create_project))
        .route("/projects/{id}/probe", post(probe_project))
        .route("/project-bindings", post(create_project_binding))
        .route("/placement/evaluate", post(evaluate_placement))
        .route("/nodes/{id}/inventory", get(node_inventory))
        .route("/grants", get(grants).post(create_grant))
        .route("/grants/{id}/revoke", post(revoke_grant))
        .route("/nodes", get(nodes))
        .route("/nodes/{id}/revoke", post(revoke_node))
        .route("/enrollment-codes", post(enrollment))
        .route("/tickets", get(tickets).post(create_ticket))
        .route("/tickets/{id}", get(ticket))
        .route("/tickets/{id}/cancel", post(cancel))
        .route("/tickets/{id}/retry", post(retry))
        .route("/tickets/{id}/approval", post(approval))
        .route("/tickets/{id}/artifacts/{artifact_id}", get(artifact))
        .route("/preferences", get(preference).put(update_preference))
        .route("/memories", get(memories).post(create_memory))
        .route("/memories/{id}", patch(edit_memory).delete(delete_memory))
        .route("/messages", get(messages).post(message))
        .route("/audit", get(audit))
        .route("/audit/verify", get(verify_audit))
        .route("/candidates", get(candidates).post(create_candidate))
        .route("/candidates/{id}", patch(review_candidate))
        .route("/models", get(models))
        .route("/models/{id}/place", post(models))
        .route("/pipelines", get(list_pipelines).post(create_pipeline))
        .route("/pipelines/{id}", get(pipeline_detail))
        .route("/pipelines/{id}/run", post(run_pipeline))
        .route("/pipelines/{id}/cancel", post(cancel_pipeline))
        .route("/inventory", get(inventory))
}

pub fn router(state: Arc<State>) -> Router {
    let business = admin_routes(state.clone()).layer(axum::middleware::from_fn_with_state(
        state.clone(),
        |AppState(state): AppState<Arc<State>>,
         headers: HeaderMap,
         request: axum::extract::Request,
         next: axum::middleware::Next| async move {
            client(&state, &headers)?;
            Ok::<Response, ApiError>(next.run(request).await)
        },
    ));
    Router::new().merge(crate::node_api::routes()).route("/api/v1/health",get(||async{Json(json!({"status":"ok","protocol":"loom.node.v1","api":"api.v1","version":env!("CARGO_PKG_VERSION")}))})).nest("/api/v1",business).fallback(fallback).layer(axum::extract::DefaultBodyLimit::disable()).layer(tower_http::limit::RequestBodyLimitLayer::new(16*1024*1024)).layer(TraceLayer::new_for_http()).with_state(state)
}
fn public_web_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 4096 || !path.is_ascii() {
        return None;
    }
    let mut relative = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part.starts_with('.') || part == ".." || part.contains('\\') {
            return None;
        }
        relative.push(part);
    }
    let allowed = [
        "html", "js", "mjs", "css", "svg", "png", "jpg", "jpeg", "webp", "ico", "woff", "woff2",
        "json", "map",
    ];
    relative
        .extension()?
        .to_str()
        .filter(|extension| allowed.contains(&extension.to_lowercase().as_str()))?;
    Some(relative)
}
async fn serve_web(request: axum::extract::Request, root: PathBuf) -> Response {
    let path = request.uri().path();
    let requested_asset = path.starts_with("/assets/");
    let public_path = public_web_path(path.strip_prefix('/').unwrap_or_default());
    let candidate = if requested_asset || public_path.is_some() {
        public_path.map(|relative| root.join(relative))
    } else {
        Some(root.join("index.html"))
    };
    if let Some(candidate) = candidate {
        if let Ok(real) = std::fs::canonicalize(&candidate) {
            if real.starts_with(&root) {
                if let Ok(meta) = std::fs::symlink_metadata(&real) {
                    if meta.is_file() && meta.len() <= 2 * 1024 * 1024 {
                        return ServeFile::new(real).oneshot(request).await.into_response();
                    }
                }
            }
        }
        if requested_asset {
            return ApiError::missing("Static asset not found").into_response();
        }
    }
    ApiError::missing("Route not found").into_response()
}
async fn fallback(
    AppState(state): AppState<Arc<State>>,
    request: axum::extract::Request,
) -> Response {
    if let Some(web_dir) = state.lock().ok().and_then(|s| s.setting("web_dir")) {
        if !request.uri().path().starts_with("/api/") {
            return serve_web(request, PathBuf::from(web_dir)).await;
        }
    }
    ApiError::missing("Route not found").into_response()
}
pub async fn serve(state: Arc<State>, listen: String, web_dir: Option<PathBuf>) -> Result<()> {
    if let Some(dir) = web_dir {
        let public_root = std::fs::canonicalize(&dir)?;
        if !public_root.is_dir() {
            anyhow::bail!("Web root must be an existing directory");
        }
        state
            .lock()
            .map_err(|_| anyhow::anyhow!("store"))?
            .set_setting("web_dir", &public_root.to_string_lossy())?;
    }
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    tracing::info!(address=%listener.local_addr()?,"Loom coordinator ready");
    axum::serve(listener, router(state)).await?;
    Ok(())
}

async fn bootstrap(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let tickets = store.list("tickets")?;
    Ok(Json(
        json!({"client_api":"loom.client.v1","node_protocol":"loom.node.v1","identity":{"principal":"single-user","device_role":"client"},"tickets":tickets,"preferences":{"expanded":store.setting("global_expanded")==Some("true".into())},"capabilities":{"multi_node":true,"dsh_runtime_adapter":"requires_installed_host_validation","live_llm":false}}),
    ))
}
async fn projects(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let projects = state.lock()?.list("projects")?;
    Ok(Json(json!({"projects":projects})))
}
async fn create_project(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let name = required(&body, "name", 200)?;
    let root = required(&body, "root", 4096)?;
    let mode = body["mode"].as_str().unwrap_or("read_only");
    if !matches!(mode, "read_only" | "read_write") {
        return Err(ApiError::bad("mode must be read_only or read_write"));
    }
    let canonical = std::fs::canonicalize(root).map_err(|_| {
        ApiError::bad("Project must be an existing directory accessible to this coordinator")
    })?;
    if !canonical.is_dir() {
        return Err(ApiError::bad("Project root must be a directory"));
    }
    let id = id("project");
    let p = project_probe(&canonical)?;
    let time = now();
    let store = state.lock()?;
    store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES(?1,?2,?3,?4,1,?5,?6)",params![id,name,canonical.to_string_lossy(),mode,time,serde_json::to_string(&p).unwrap()])?;
    store.audit(
        None,
        "client",
        "project.probed",
        &json!({"project_id":id,"mode":mode,"source":"controller_read_only_probe"}),
    )?;
    Ok(Json(
        json!({"project":store.get("projects",&id)?.expect("inserted project")}),
    ))
}
fn project_probe(root: &Path) -> Result<Value> {
    let git = root.join(".git").exists();
    let run = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    let revision = if git {
        run(&["rev-parse", "HEAD"])
    } else {
        None
    };
    let dirty = if git {
        run(&["status", "--porcelain"]).map(|s| !s.is_empty())
    } else {
        None
    };
    Ok(
        json!({"form":if git{"working_tree"}else{"documents"},"project_kind":"project","canonical_remote":if git{run(&["remote","get-url","origin"])}else{None},"revision":revision,"dirty":dirty,"git_available":git,"location_kind":"local_working_tree","credential_location":null,"source":"controller_probe","probed_at":now(),"pending":"No implicit Clone, credentials or access grant created."}),
    )
}
async fn probe_project(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let project = store
        .get("projects", &id)?
        .ok_or_else(|| ApiError::bad("project not found"))?;
    let p = project_probe(Path::new(project["root"].as_str().unwrap_or_default()))?;
    store.conn().execute(
        "UPDATE projects SET inventory=?1,version=version+1 WHERE id=?2",
        params![serde_json::to_string(&p).unwrap(), id],
    )?;
    Ok(Json(
        json!({"project":store.get("projects",&id)?,"read_only_probe":true}),
    ))
}
#[allow(dead_code)]
async fn grant_data(kind: &str) -> ApiResult<Value> {
    Ok(json!({"permission":kind}))
}
async fn grants(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"grants":state.lock()?.list("grants")?})))
}
fn explicit_permissions(body: &Value) -> ApiResult<Vec<&'static str>> {
    let operations = match body.get("operations") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        Some(Value::String(value)) => vec![value.as_str()],
        _ => vec![body
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("read_summary")],
    };
    let mut permissions = Vec::new();
    for operation in operations {
        match operation {
            "read"|"read_summary"=>if !permissions.contains(&"read"){permissions.push("read")},
            "write"|"edit_file"=>if !permissions.contains(&"write"){permissions.push("write")},
            "read_write"=>{if !permissions.contains(&"read"){permissions.push("read");}
                if !permissions.contains(&"write"){permissions.push("write");}},
            "invoke_text"=>if !permissions.contains(&"invoke_text"){permissions.push("invoke_text")},
            _=>return Err(ApiError::bad("Operations require explicit read/read_summary, write/edit_file, read_write or separately granted invoke_text.")),
        }
    }
    if permissions.is_empty() {
        return Err(ApiError::bad("Grant operations must not be empty."));
    }
    Ok(permissions)
}
async fn evaluate_placement(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let project_id = required(&body, "project_id", 160)?.to_owned();
    let capability = required(&body, "capability", 128)?.to_owned();
    let grant_id = required(&body, "grant_id", 160)?.to_owned();
    let project_binding_id = required(&body, "project_binding_id", 160)?.to_owned();
    let request = crate::inventory::PlacementRequest {
        project_id,
        capability,
        worker_id: body["worker_id"].as_str().unwrap_or("default").to_owned(),
        preferred_node_id: body["node_id"].as_str().map(ToOwned::to_owned),
        grant_id,
        project_binding_id,
        evaluated_at: chrono::Utc::now(),
        hardware: if body["hardware"].is_object() {
            Some(crate::inventory::HardwareTarget {
                os: body["hardware"]["os"].as_str().map(str::to_lowercase),
                arch: body["hardware"]["arch"].as_str().map(str::to_lowercase),
                minimum_memory_bytes: body["hardware"]["minimum_memory_bytes"].as_u64(),
            })
        } else {
            None
        },
    };
    let store = state.lock()?;
    let decision = crate::inventory::decide_placement(&store, &request)?;
    Ok(Json(serde_json::to_value(decision).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "inventory_encoding",
            "Cannot encode placement evaluation",
        )
    })?))
}
async fn create_project_binding(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let project = required(&body, "project_id", 160)?;
    let node = required(&body, "node_id", 160)?;
    let worker = body["worker_id"].as_str().unwrap_or("default");
    let worker = loom_protocol::WorkerId::parse(worker)?;
    let worker = worker.as_str();
    let root = required(&body, "root_scope", 4096)?;
    let mut store = state.lock()?;
    let project_data = store
        .get("projects", project)?
        .ok_or_else(|| ApiError::missing("Project is unknown"))?;
    let node_data = store
        .get("nodes", node)?
        .ok_or_else(|| ApiError::missing("Node is unknown"))?;
    if node_data["revoked_at"] != Value::Null {
        return Err(ApiError::denied(
            "revoked_node",
            "Cannot bind a revoked node",
        ));
    }
    let declared = node_data["inventory"]["project_roots"][project].as_str();
    if declared != Some(root) {
        return Err(ApiError::denied(
            "binding_not_declared_by_host",
            "The node must first declare this exact ProjectId-to-root mapping; the client cannot replace it with another location",
        ));
    }
    if node_data["workers"]
        .as_array()
        .is_some_and(|workers| !workers.is_empty())
        && !node_data["workers"].as_array().is_some_and(|workers| {
            workers.iter().any(|entry| {
                entry
                    .get("worker_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    == Some(worker)
            })
        })
    {
        return Err(ApiError::denied(
            "worker_not_registered",
            "Worker scope is not registered by this installation",
        ));
    }
    let installation = node_data["installation_id"].as_str().unwrap_or_default();
    let binding = id("binding");
    let at = now();
    let digest = store::hash(&json!({"project_id":project,"node_id":node,"installation_id":installation,"worker_id":worker,"root_scope":root}).to_string());
    store.conn_mut().execute(
        "INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![binding,project,node,installation,worker,root,digest,at],
    )?;
    store.audit(None, "client", "project.binding.approved", &json!({"binding_id":binding,"project_id":project,"node_id":node,"worker_id":worker,"root_digest":store::hash(root),"project_revision":project_data["inventory"]["revision"]}))?;
    Ok(Json(
        json!({"id":binding,"project_id":project,"node_id":node,"installation_id":installation,"worker_id":worker,"binding_digest":digest}),
    ))
}
async fn create_grant(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let project = required(&body, "project_id", 160)?.to_owned();
    let ops = explicit_permissions(&body)?;
    let node_id = body["node_id"].as_str().unwrap_or("auto").to_owned();
    let worker = body["worker_id"].as_str().unwrap_or("default").to_owned();
    if node_id.len() > 160 || worker.len() > 160 {
        return Err(ApiError::bad("Identity too long"));
    }
    let store = state.lock()?;
    let p = store
        .get("projects", &project)?
        .ok_or_else(|| ApiError::missing("Project is not registered"))?;
    if p["mode"] == "read_only" && ops.contains(&"write") {
        return Err(ApiError::denied(
            "project_scope",
            "A write grant must not exceed a read-only project boundary",
        ));
    }
    if node_id != "auto" && store.get("nodes", &node_id)?.is_none() {
        return Err(ApiError::bad("Target a registered node or auto"));
    }
    let mut bindings = store.query(
        "SELECT * FROM project_bindings WHERE project_id=?1 AND worker_id=?2 AND revoked_at IS NULL",
        params![project, worker],
    )?;
    if node_id != "auto" {
        bindings.retain(|entry| entry["node_id"] == node_id);
    }
    if let Some(requested_binding) = body["project_binding_id"].as_str() {
        bindings.retain(|entry| entry["id"] == requested_binding);
    }
    let binding = match bindings.len() {
        0 => return Err(ApiError::conflict(
            "project_binding_required",
            "Approve an exact ProjectId location on a target Node/Installation/Worker before granting operations",
        )),
        1 => bindings.remove(0),
        _ if !body["project_binding_id"].is_null() => {
            return Err(ApiError::conflict("ambiguous_binding", "The requested binding is not unique within this grant"))
        }
        _ => return Err(ApiError::conflict(
            "binding_explicit",
            "Multiple host locations exist for this project; select an exact binding, do not guess",
        )),
    };
    if binding["node_id"] != node_id && node_id != "auto" {
        return Err(ApiError::denied(
            "binding_scope",
            "Grant location and node identity disagree",
        ));
    }
    let gid = id("grant");
    let time = now();
    let op_json = json!(ops);
    let binding_id = binding["id"].as_str().unwrap_or_default();
    let installation = binding["installation_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let digest = hash_json(
        &json!({"id":gid,"project_id":project,"node_id":node_id,"worker_id":worker,"installation_id":installation,"binding":binding["binding_digest"],"operations":op_json,"version":1}),
    );
    store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES(?1,?2,?3,?4,?5,?6,1,?7,?8,?9)",params![gid,project,node_id,worker,installation,op_json.to_string(),digest,time,binding_id])?;
    store.audit(
        None,
        "client",
        "grant.created",
        &json!({"grant_id":gid,"operations":op_json,"node_id":node_id,"worker_id":worker}),
    )?;
    Ok(Json(json!({"grant":store.get("grants",&gid)?})))
}
async fn nodes(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let mut nodes = state.lock()?.list("nodes")?;
    for n in &mut nodes {
        let declared_roots = n["inventory"]["project_roots"].clone();
        let last = n["last_heartbeat"]
            .as_str()
            .and_then(|s| parse_time(s).ok());
        let online = n["revoked_at"].is_null()
            && n["status"] != "offline"
            && last.is_some_and(|at| chrono::Utc::now() - at < chrono::Duration::seconds(60));
        n["online"] = json!(online);
        n["freshness"] = if online {
            json!("fresh")
        } else {
            json!("stale_offline")
        };
        n["source"] = json!("host_heartbeat");
        let installation_id = n["installation_id"].as_str().unwrap_or_default().to_owned();
        let identity = crate::inventory::InstallationIdentity {
            node_id: n["id"].as_str().unwrap_or_default().to_owned(),
            installation_id,
        };
        let view = crate::inventory::node_view(&identity, Some(n), chrono::Utc::now());
        n["inventory"] = serde_json::to_value(view).map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "inventory_encoding",
                "Cannot encode node inventory",
            )
        })?;
        if declared_roots.is_object() {
            n["inventory"]["project_roots"] = declared_roots;
        }
        if let Value::Array(ref mut workers) = n["workers"] {
            for worker in workers.iter_mut() {
                if let Value::Object(ref mut map) = worker {
                    map.retain(|key, _| {
                        [
                            "id",
                            "worker_id",
                            "profile_id",
                            "harness_kind",
                            "status",
                            "capabilities",
                            "supported_effects",
                        ]
                        .contains(&key.as_str())
                    });
                }
            }
        }
        if let Value::Array(ref mut workers) = n["workers"] {
            for worker in workers {
                if let Value::Object(ref mut map) = worker {
                    map.retain(|key, _| {
                        [
                            "id",
                            "worker_id",
                            "profile_id",
                            "harness_kind",
                            "status",
                            "supported_effects",
                            "capabilities",
                        ]
                        .contains(&key.as_str())
                    });
                }
            }
        }
    }
    Ok(Json(json!({"nodes":nodes})))
}
async fn revoke_node(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(node): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if store.get("nodes", &node)?.is_none() {
        return Err(ApiError::missing("Node not found"));
    }
    store.conn().execute(
        "UPDATE nodes SET revoked_at=?1,status='revoked' WHERE id=?2",
        params![now(), node],
    )?;
    store.conn().execute(
        "UPDATE assignments SET lease_expires_at=?1 WHERE node_id=?2",
        params![now(), node],
    )?;
    store.audit(None, "client", "node.revoked", &json!({"node_id":node}))?;
    Ok(Json(
        json!({"revoked":true,"task_outcome":"Unknown active effects enter reconciliation"}),
    ))
}
async fn revoke_grant(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(grant): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if store.get("grants", &grant)?.is_none() {
        return Err(ApiError::missing("Grant not found"));
    }
    store.conn().execute(
        "UPDATE grants SET revoked_at=?1,version=version+1 WHERE id=?2",
        params![now(), grant],
    )?;
    store.conn().execute("UPDATE assignments SET lease_expires_at=?1 WHERE ticket_id IN(SELECT id FROM tickets WHERE grant_id=?2)",params![now(),grant])?;
    store.conn().execute("UPDATE tickets SET status='reconciling',updated_at=?1 WHERE grant_id=?2 AND status='running'",params![now(),grant])?;
    store.audit(
        None,
        "client",
        "grant.revoked",
        &json!({"grant_id":grant,"fencing":"old_leases_expired"}),
    )?;
    Ok(Json(
        json!({"revoked":true,"grant_id":grant,"effects":"running_execution_outcome_unknown_until_reconciled"}),
    ))
}
async fn enrollment(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let code = format!("enroll_{}", token());
    let expiry = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    let store = state.lock()?;
    let id = id("enrollment");
    store.conn().execute(
        "INSERT INTO enrollment_codes(id,token_hash,expires_at) VALUES(?1,?2,?3)",
        params![id, store::hash(&code), expiry],
    )?;
    store.audit(
        None,
        "client",
        "enrollment.created",
        &json!({"enrollment_id":id,"expires_at":expiry}),
    )?;
    Ok(Json(
        json!({"code":code,"expires_at":expiry,"single_use":true}),
    ))
}
// The public Ticket route invokes create_ticket with its client auth layer.
pub(crate) async fn challenge(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let _: Identity = deserialize(&body)?;
    if body["protocol"] != "loom.node.v1" {
        return Err(ApiError::bad("protocol"));
    }
    let node_id = required(&body, "node_id", 160)?;
    let installation = required(&body, "installation_id", 160)?;
    let public = required(&body, "public_key", 96)?;
    let _ = public_key_identity(public, node_id, installation)?;
    let nonce = store::hex(crate::random32());
    let challenge = id("challenge");
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    let store = state.lock()?;
    store.conn().execute("INSERT INTO challenges(id,node_id,installation_id,public_key,nonce,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",params![challenge,node_id,installation,public,nonce,expires])?;
    Ok(Json(
        json!({"challenge_id":challenge,"nonce":nonce,"expires_at":expires}),
    ))
}
pub async fn artifact_upload_handler(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    artifact_upload(Json(body), state, headers).await
}
pub(crate) async fn register(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let request: loom_protocol::RegisterNodeRequest =
        serde_json::from_value(body.clone()).map_err(|e| ApiError::bad(e.to_string()))?;
    if request.capabilities.is_empty() {
        return Err(ApiError::bad(
            "Capability declaration required; this is not permission",
        ));
    }
    let _node_type = loom_protocol::NodeId::parse(request.node_id.as_str())?;
    let key = public_key_identity(
        &request.public_key,
        request.node_id.as_str(),
        request.installation_id.as_str(),
    )?;
    let (node, installation, request_id) = envelope(&body)?;
    let store = state.lock()?;
    let existing = store
        .conn()
        .query_row(
            "SELECT public_key,revoked_at FROM nodes WHERE id=?1 AND installation_id=?2",
            params![node, installation],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((old, revoked)) = existing {
        if revoked.is_some() {
            return Err(ApiError::denied(
                "node_revoked",
                "Revoked node may not rotate credentials",
            ));
        }
        if old != request.public_key
            || !store.authenticate_node(&node, &installation, bearer(&headers)?)?
        {
            return Err(ApiError::denied(
                "credential_rotation_denied",
                "Valid existing credentials are required to rotate a node session",
            ));
        }
    } else {
        let code = required(&body, "enrollment_code", 128)?;
        let changed=store.conn().execute("UPDATE enrollment_codes SET used_at=?1 WHERE token_hash=?2 AND used_at IS NULL AND expires_at>?3",params![now(),store::hash(code),now()])?;
        if changed != 1 {
            return Err(ApiError::denied(
                "enrollment_denied",
                "A fresh, single-use enrollment code is required",
            ));
        }
    }
    let (cid,expires,pubkey): (String,String,String)=store.conn().query_row("SELECT id,expires_at,public_key FROM challenges WHERE node_id=?1 AND installation_id=?2 AND nonce=?3 AND used_at IS NULL",params![node,installation,request.nonce.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||ApiError::denied("challenge_invalid","Fresh and identity-bound challenge required"))?;
    if pubkey != request.public_key || parse_time(&expires)? <= chrono::Utc::now() {
        return Err(ApiError::denied("challenge_expired", "Expired challenge"));
    }
    signature(&key, request.nonce.as_str(), &request.signed_challenge)?;
    store.conn().execute(
        "UPDATE challenges SET used_at=?1 WHERE id=?2 AND used_at IS NULL",
        params![now(), cid],
    )?;
    let token = token();
    let cap = serde_json::to_string(&request.capabilities).unwrap();
    let workers = json!([{"id":request.worker_id.as_str(),"worker_id":request.worker_id.as_str(),"profile_id":request.profile_id.as_str(),"harness_kind":request.harness_kind.as_str()}]);
    // Registration keeps a compact self-reported worker snapshot; heartbeat supplies live inventory.
    store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES(?1,?2,?3,?4,'online',?5,?6,?7,?8,?8) ON CONFLICT(id,installation_id) DO UPDATE SET token_hash=excluded.token_hash,status='online',last_heartbeat=excluded.last_heartbeat,workers=excluded.workers,inventory=excluded.inventory,capabilities=excluded.capabilities",params![node,installation,request.public_key,store::hash(&token),cap,serde_json::to_string(&workers).unwrap(),workers.to_string(),now()])?;
    store.audit(
        None,
        "node",
        "node.registered",
        &json!({"node_id":node,"installation_id":installation,"request_id":request_id}),
    )?;
    Ok(Json(
        json!({"node_id":node,"installation_id":installation,"token":token,"node_token":token,"grant_digest":null,"protocol":"loom.node.v1"}),
    ))
}
#[derive(serde::Deserialize)]
struct InventorySelector {
    installation_id: Option<String>,
}
async fn node_inventory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(raw_id): axum::extract::Path<String>,
    axum::extract::Query(selector): axum::extract::Query<InventorySelector>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let mut candidates = store.query("SELECT id,installation_id,status,capabilities,workers,inventory,last_heartbeat,revoked_at FROM nodes WHERE id=?1", [&raw_id])?;
    if let Some(installation_id) = selector
        .installation_id
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        candidates
            .retain(|node| node["installation_id"].as_str() == Some(installation_id.as_str()));
    }
    if candidates.len() > 1 {
        return Err(ApiError::conflict(
            "exact_installation_required",
            "Select one exact installation instead of mixing worker/profile inventories",
        ));
    }
    let record = candidates.first();
    let installation_id = record
        .map(|row| {
            row["installation_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .or(selector.installation_id)
        .unwrap_or_default();
    let identity = crate::inventory::InstallationIdentity {
        node_id: raw_id,
        installation_id,
    };
    let view = crate::inventory::node_view(&identity, record, chrono::Utc::now());
    Ok(Json(serde_json::to_value(view).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "inventory_encoding",
            "Cannot encode resource inventory",
        )
    })?))
}
pub(crate) async fn heartbeat(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let capacity = json!(body["capabilities"]);
    let workers = json!(body["workers"]);
    let inventory = body["inventory"].to_string();
    let status = body["status"].as_str().unwrap_or("online");
    let store = state.lock()?;
    store.conn().execute("UPDATE nodes SET last_heartbeat=?1,status=?2,inventory=?3,capabilities=?4,workers=?5 WHERE id=?6",params![now(),status,inventory,capacity.to_string(),workers.to_string(),node])?;
    Ok(Json(
        json!({"accepted":true,"observed_at":now(),"inventory":"stale_if_heartbeats_exceed_policy"}),
    ))
}
pub(crate) async fn poll(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let wait = body["wait_seconds"].as_u64().unwrap_or(0).min(20);
    for _ in 0..=wait {
        let value = {
            let store = state.lock()?;
            crate::maintenance::assignment_for_poll(&store, &node)?
        };
        if let Some(assignment) = value {
            return Ok(Json(json!({"assignment":assignment})));
        }
        if wait > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    Ok(Json(json!({"assignment":null})))
}
pub(crate) async fn acknowledge(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    body: Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let assignment = required(&body, "assignment_id", 160)?;
    let store = state.lock()?;
    valid_lease(
        &store,
        &body,
        &node,
        body["cancel_requested"].as_bool().unwrap_or(false),
    )?;
    store.conn().execute(
        "UPDATE assignments SET acknowledged_at=?1 WHERE id=?2",
        params![now(), assignment],
    )?;
    store.audit(
        body["ticket_id"].as_str(),
        "node",
        "assignment.acknowledged",
        &json!({"assignment_id":assignment,"delivered_is_not_read":true}),
    )?;
    Ok(Json(json!({"accepted":true})))
}
pub(crate) async fn event(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let ticket = required(&body, "ticket_id", 160)?;
    let assignment = required(&body, "assignment_id", 160)?;
    let content = body["activity"]
        .as_str()
        .or_else(|| body["content"].as_str())
        .filter(|x| x.len() <= 8000 && !x.is_empty())
        .ok_or_else(|| ApiError::bad("A bounded visible event summary is required"))?;
    let store = state.lock()?;
    // A Session link is an ordinary progress reference, not the special stale
    // cancellation path; delegation provenance additionally depends on this
    // exact current Assignment, its immutable source and the real parent reference.
    valid_lease(&store, &body, &node, body["kind"] != "session_link")?;
    let session_reference = if let Some(relation) = validated_delegation_relation(&store, &body)? {
        json!({
            "harness": "dsh", "session_id": body["session_ref"]["session_id"],
            "protocol": "dsh-session-log", "host_api": body["session_ref"]["host_api"],
            "observed_seq": body["session_ref"]["observed_seq"], "delegated_from": relation,
        })
    } else {
        body.get("session_ref")
            .cloned()
            .unwrap_or_else(|| json!({"assignment_id":assignment}))
    };
    store.conn().execute("INSERT OR IGNORE INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES(?1,?2,?3,'concierge',?4,?5,?6,'summary',?7,?8)",params![id("message"),ticket,body["sender"].as_str().unwrap_or("worker"),body["kind"].as_str().unwrap_or("activity"),content,session_reference.to_string(),now(),body["request_id"].as_str()])?;
    Ok(Json(json!({"accepted":true,"node_id":node})))
}

pub(crate) async fn source_input(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let store = state.lock()?;
    valid_lease(&store, &body, &node, false)?;
    // The center reads its assigned immutable relation, never an arbitrary
    // parent/session supplied by a worker or provider. No administrative token
    // is handed to a Node or exposed in its task tool scope.
    Ok(Json(crate::pipeline::delegated_source_proof(
        &store, &body,
    )?))
}

fn validated_delegation_relation(store: &store::Store, body: &Value) -> ApiResult<Option<Value>> {
    let claimed = body["session_ref"]["delegated_from"].clone();
    if claimed.is_null() {
        return Ok(None);
    }
    if body["kind"] != "session_link"
        || !claimed.is_object()
        || claimed["session"]["session_id"].is_null()
    {
        return Err(ApiError::denied(
            "delegation_evidence",
            "Delegation claims require a real Session link and its parent Session",
        ));
    }
    let mut checked_body = body.clone();
    checked_body["source_ref"] = json!({
        "type": claimed["type"], "artifact_id": claimed["artifact_id"], "ticket_id": claimed["ticket_id"],
        "origin_node_id": claimed["origin_node_id"], "sha256": claimed["sha256"],
        "location": claimed["location"], "parents": claimed["parents"],
    });
    let proof = crate::pipeline::delegated_source_proof(store, &checked_body).map_err(|error| {
        ApiError::denied(
            "delegation_evidence",
            format!("Only the actual pipeline source and parent Session may be linked: {error}"),
        )
    })?;
    let actual_parent = proof["parent_session_ref"]["session_id"].as_str();
    if actual_parent != claimed["session"]["session_id"].as_str() {
        return Err(ApiError::denied(
            "delegation_evidence",
            "The claimed parent Session does not match the producer's actual public Session",
        ));
    }
    let reference = proof["artifact_input"]["artifact_ref"].clone();
    Ok(Some(json!({
        "type": reference["type"], "artifact_id": reference["artifact_id"], "ticket_id": reference["ticket_id"],
        "origin_node_id": reference["origin_node_id"], "sha256": reference["sha256"],
        "location": reference["location"], "parents": reference["parents"],
        "session": proof["parent_session_ref"],
        "source_verified": true, "validated_by": "current_assignment_and_pipeline_relation"
    })))
}

fn valid_lease(
    store: &store::Store,
    body: &Value,
    node: &str,
    allow_cancel: bool,
) -> ApiResult<(String, String, i64)> {
    let ticket = required(body, "ticket_id", 160)?.to_owned();
    let assignment = required(body, "assignment_id", 160)?.to_owned();
    let epoch = body["lease_epoch"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("lease_epoch integer is required"))?;
    let values=store.query("SELECT a.node_id,a.lease_epoch,a.lease_expires_at,t.attempt,t.cancel_requested,t.status,g.revoked_at FROM assignments a JOIN tickets t ON t.id=a.ticket_id JOIN grants g ON g.id=t.grant_id WHERE a.id=?1 AND t.id=?2",params![assignment,ticket])?.into_iter().next().ok_or_else(||ApiError::missing("Assignment/ticket not found"))?;
    if values["node_id"].as_str().unwrap_or_default() != node {
        return Err(ApiError::denied(
            "assignment_owner",
            "Authenticated node is not the assignment owner",
        ));
    }
    if values["lease_epoch"].as_i64() != Some(epoch) || values["attempt"].as_i64() != Some(epoch) {
        return Err(ApiError::denied(
            "stale_lease",
            "The report/artifact belongs to an old Assignment attempt or Lease",
        ));
    }
    let expired = values["lease_expires_at"]
        .as_str()
        .and_then(|x| parse_time(x).ok())
        .is_none_or(|x| x <= chrono::Utc::now());
    let cancelled = values["cancel_requested"] == true
        || values["status"]
            .as_str()
            .is_some_and(|s| ["cancelled", "cancel_requested", "reconciling"].contains(&s));
    if !allow_cancel && (expired || cancelled || values["revoked_at"] != Value::Null) {
        return Err(ApiError::conflict("outcome_unknown","Expired/revoked/cancelled execution cannot deliver a normal outcome. Reconcile its effects honestly."));
    }
    Ok((ticket, assignment, epoch))
}

async fn artifact_upload(
    Json(body): Json<Value>,
    state: Arc<State>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let (ticket, assignment, _) = valid_lease(&state.lock().unwrap(), &body, &node, false)?;
    let metadata = if body["metadata"].is_object() {
        body["metadata"].clone()
    } else {
        body.clone()
    };
    let bytes_base64 = body["bytes_base64"]
        .as_str()
        .or_else(|| body["bytes"].as_str())
        .ok_or_else(|| ApiError::bad("bytes_base64 is required"))?;
    let data = STANDARD
        .decode(bytes_base64)
        .map_err(|_| ApiError::bad("Canonical base64 artifact required"))?;
    if data.is_empty() || data.len() > 8 * 1024 * 1024 {
        return Err(ApiError::bad(
            "Inline artifact must be 1 byte through 8 MiB",
        ));
    };
    let digest = sha256(&data);
    if metadata["sha256"].as_str().is_some_and(|s| s != digest)
        || metadata["size_bytes"]
            .as_i64()
            .is_some_and(|s| s != data.len() as i64)
    {
        return Err(ApiError::bad("Artifact size/hash mismatch"));
    }
    let artifact = metadata["artifact_id"]
        .as_str()
        .or_else(|| body["artifact_id"].as_str())
        .ok_or_else(|| ApiError::bad("artifact_id metadata required"))?
        .to_owned();
    if body["artifact_id"]
        .as_str()
        .is_some_and(|it| it != artifact)
    {
        return Err(ApiError::bad(
            "The top-level artifact id and its metadata must agree",
        ));
    }
    uuid::Uuid::parse_str(&artifact)
        .map_err(|_| ApiError::bad("Artifact identifier must be UUID"))?;
    let name = metadata["name"]
        .as_str()
        .unwrap_or("artifact.txt")
        .to_owned();
    let media = metadata["media_type"]
        .as_str()
        .unwrap_or("text/plain")
        .to_owned();
    if media.len() > 100 || name.len() > 200 {
        return Err(ApiError::bad("Artifact metadata too long "));
    };
    let mut lineage = Vec::new();
    let mut store = state.lock()?;
    if metadata["parents"].is_object()
        || metadata["parents"].is_string()
        || metadata["parents"].is_number()
        || metadata["parents"].is_boolean()
    {
        return Err(ApiError::bad(
            "Artifact parents must be an empty list or an explicit bounded SourceRef",
        ));
    }
    if (!metadata["artifact_ref"].is_null() && !metadata["artifact_ref"].is_object())
        || (metadata["artifact_ref"].is_null()
            && metadata["parents"]
                .as_array()
                .is_some_and(|parents| !parents.is_empty()))
    {
        if store.get("artifacts", &artifact)?.is_some_and(|existing| {
            existing["lineage"]
                .as_array()
                .is_some_and(|parents| !parents.is_empty())
        }) {
            return Err(ApiError::conflict(
                "artifact_conflict",
                "Removing an established Artifact's immutable parent lineage is forbidden",
            ));
        }
        return Err(ApiError::bad(
            "Each declared parent needs a valid artifact_ref and controller-verified lineage",
        ));
    }
    if let Some(reference) = metadata["artifact_ref"].as_object() {
        let source_id = reference
            .get("artifact_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("Source dependency requires an actual Artifact UUID"))?;
        let source_hash = reference
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("Source dependency requires its SHA-256"))?;
        if uuid::Uuid::parse_str(source_id).is_err() || source_hash.len() != 64 {
            return Err(ApiError::bad("Invalid source artifact reference"));
        }
        let parent = store.get("artifacts", source_id)?.ok_or_else(|| {
            ApiError::denied(
                "unknown_artifact_input",
                "Only an uploaded known Artifact can be a source",
            )
        })?;
        if parent["sha256"] != source_hash {
            return Err(ApiError::denied(
                "artifact_input_hash_mismatch",
                "The source hash does not match the immutable Artifact index",
            ));
        }
        if reference
            .get("origin_node_id")
            .and_then(Value::as_str)
            .is_some_and(|origin| origin != parent["origin_node_id"].as_str().unwrap_or_default())
        {
            return Err(ApiError::denied(
                "origin_mismatch",
                "The named source host does not match the actual Artifact origin",
            ));
        }
        lineage.push(json!({
        "type": "artifact_ref", "artifact_id":source_id, "origin_node_id":parent["origin_node_id"],
        "sha256":parent["sha256"],"component_sha256":digest,
        "source_location":parent["location"],
        "source_ticket_id":parent["ticket_id"],
        "artifact_ref":{"artifact_id":parent["id"],"sha256":parent["sha256"],"origin_node_id":parent["origin_node_id"]},
        "parents":parent["lineage"],
    }));
        if metadata["parents"].as_array().is_some_and(|declared| {
            declared.len() > 1
                || declared
                    .first()
                    .is_some_and(|entry| entry.as_str() != Some(source_id))
        }) {
            return Err(ApiError::conflict("inexact_lineage", "Parents may only hold the source UUID string or be empty; provenance fields are center-verified"));
        }
    }
    let path = store
        .root
        .join("artifacts")
        .join(format!("{artifact}.artifact"));
    if let Some(current) = store.get("artifacts", &artifact)? {
        if current["sha256"] != digest
            || current["size_bytes"] != data.len()
            || current["assignment_id"] != assignment
            || current["ticket_id"] != ticket
            || current["origin_node_id"] != node
            || current["name"] != name
            || current["media_type"] != media
            || current["lineage"]
                .as_array()
                .is_some_and(|existing_lineage| existing_lineage != &lineage)
        {
            return Err(ApiError::conflict(
                "artifact_conflict",
                "An existing immutable artifact cannot change bytes or lineage",
            ));
        }
        let existing = fs::read(&path)?;
        if sha256(&existing) != digest || existing != data {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "artifact_storage_integrity",
                "Stored bytes or database evidence needs operator recovery; an upload may never repair it",
            ));
        }
        return Ok(Json(json!({
            "artifact_id":artifact,"ticket_id":ticket,"assignment_id":assignment,
            "duplicate":true,"origin_node_id":node,"name":current["name"],
            "media_type":current["media_type"],"size_bytes":current["size_bytes"],
            "sha256":current["sha256"],"location":current["location"]
        })));
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    use std::io::Write;
    if let Err(error) = Write::write_all(&mut file, &data) {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    if let Err(error) = file.sync_all() {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    let tx = store.conn_mut().transaction()?;
    let result = (|| -> rusqlite::Result<()> {
        tx.execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",params![artifact,ticket,assignment,node,name,media,data.len() as i64,digest,format!("{artifact}.artifact"),format!("loom://artifact/{artifact}"),serde_json::Value::Array(lineage.clone()).to_string(),now()])?;
        store::audit_tx(
            &tx,
            Some(&ticket),
            "node",
            "artifact.indexed",
            &json!({"artifact_id":artifact,"sha256":digest,"origin_node_id":node}),
        )
        .map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                error.to_string(),
            )))
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    if let Err(error) = tx.commit() {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    let current = store
        .get("artifacts", &artifact)?
        .expect("committed artifact");
    Ok(Json(
        json!({"artifact_id":artifact,"ticket_id":ticket,"assignment_id":assignment,"origin_node_id":node,"name":current["name"],"media_type":current["media_type"],"size_bytes":data.len(),"sha256":digest,"location":format!("loom://artifact/{artifact}")}),
    ))
}

pub(crate) async fn report(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let request_id = required(&body, "request_id", 160)?.to_owned();
    let ticket = required(&body, "ticket_id", 160)?.to_owned();
    let assignment = required(&body, "assignment_id", 160)?.to_owned();
    let epoch = body["lease_epoch"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("lease_epoch is required"))?;
    let requested_state = body["state"]
        .as_str()
        .or_else(|| body["status"].as_str())
        .or_else(|| body["requested_state"].as_str())
        .ok_or_else(|| ApiError::bad("A structured Report state is required"))?;
    if !matches!(
        requested_state,
        "running" | "succeeded" | "failed" | "cancelled" | "unknown"
    ) {
        return Err(ApiError::bad("Report state is not recognized"));
    }
    let mut store = state.lock()?;
    let payload_digest = store::hash(&body.to_string());
    let ownership = store.query(
        "SELECT t.attempt,a.lease_epoch,t.status FROM assignments a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=?1 AND a.node_id=?2 AND a.ticket_id=?3",
        params![assignment, node, ticket],
    )?.into_iter().next().ok_or_else(||ApiError::denied("assignment_owner", "A node cannot report against another Assignment"))?;
    if ownership["attempt"] != epoch || ownership["lease_epoch"] != epoch {
        return Err(ApiError::denied(
            "stale_lease",
            "A report may not belong to a superseded Assignment attempt",
        ));
    }
    // Every replay must be decided before expiry/cancellation/reducer branches. It cannot
    // mutate state twice, but a changed body with the same request identity is a conflict.
    if let Some(receipt) = store.query(
        "SELECT response,payload_digest FROM requests WHERE node_id=?1 AND route='reports' AND request_id=?2",
        params![node,request_id],
    )?.into_iter().next() {
        if receipt["payload_digest"] != payload_digest {
            return Err(ApiError::conflict("idempotency_conflict", "The same Request ID must contain the same structured evidence"));
        }
        let receipt: Value = serde_json::from_str(receipt["response"].as_str().unwrap_or("null"))
            .map_err(|_|ApiError::new(StatusCode::INTERNAL_SERVER_ERROR,"receipt_corrupt","Persisted receipt is not readable"))?;
        return Ok(Json(json!({"duplicate":true,"request_id":request_id,"receipt":receipt})));
    }
    if matches!(
        ownership["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        return Err(ApiError::conflict(
            "terminal_result",
            "A delivered terminal result cannot be changed by another report",
        ));
    }
    let evidence_only = matches!(requested_state, "unknown" | "cancelled");
    let (ticket, assignment, _) = valid_lease(&store, &body, &node, evidence_only)?;
    let ticket_record = store
        .get("tickets", &ticket)?
        .ok_or_else(|| ApiError::missing("Ticket not found"))?;
    let cancelled = ticket_record["cancel_requested"].as_bool().unwrap_or(false);
    if requested_state == "cancelled"
        && (!cancelled || body["cancel_acknowledged"].as_bool() != Some(true))
    {
        return Err(ApiError::conflict("cancel_gate", "Cancellation can only be acknowledged against durable center stop intent and an explicit ack"));
    }
    let artifacts = body["artifact_ids"].as_array().cloned().unwrap_or_else(|| {
        body["artifacts"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .map(|entry| entry["artifact_id"].clone())
                    .collect()
            })
            .unwrap_or_default()
    });
    for artifact in &artifacts {
        let id = artifact
            .as_str()
            .ok_or_else(|| ApiError::bad("artifact_ids must be strings"))?;
        let found = store.get("artifacts", id)?.ok_or_else(|| {
            ApiError::denied("artifact_lineage", "Report cites an unknown artifact")
        })?;
        if found["assignment_id"] != assignment
            || found["ticket_id"] != ticket
            || found["origin_node_id"] != node
        {
            return Err(ApiError::denied(
                "artifact_lineage",
                "Report cites an artifact from a different scope",
            ));
        }
    }
    if requested_state == "succeeded" && artifacts.is_empty() {
        return Err(ApiError::bad(
            "Success requires uploaded and verified artifacts",
        ));
    }
    let effects = body["effects"].as_array().cloned().unwrap_or_default();
    if requested_state == "unknown" && effects.is_empty() {
        return Err(ApiError::bad(
            "Unknown outcome requires a structured Effect to reconcile",
        ));
    }
    for effect in &effects {
        if effect["effect_id"].as_str().is_none()
            || effect["effect_id"].as_str().unwrap_or_default().is_empty()
        {
            return Err(ApiError::bad("An effect requires an immutable identity"));
        }
        let effect_status = effect["status"].as_str().unwrap_or("unknown");
        if !matches!(
            effect_status,
            "recorded" | "unknown" | "confirmed" | "needs_person"
        ) {
            return Err(ApiError::bad("Effect status is not recognized"));
        }
        if requested_state == "unknown" && effect_status == "confirmed" {
            return Err(ApiError::conflict(
                "effect_unknown",
                "Unknown outcome cannot promote unobserved external effects to confirmed",
            ));
        }
        for reference in effect["artifacts"].as_array().into_iter().flatten() {
            if !artifacts.contains(reference) {
                return Err(ApiError::denied(
                    "effect_lineage",
                    "Effect references an artifact not linked to this Report",
                ));
            }
        }
    }
    let authority_status = if requested_state == "unknown" {
        "reconciling"
    } else {
        requested_state
    };
    let report_id = id("report");
    let response = json!({
        "accepted":true,"report_id":report_id,"request_id":request_id,
        "ticket_status":authority_status,"disposition":if authority_status=="reconciling"{"corrected_to_reconciling"}else{"accepted"},
        "facts_already_existed":false
    });
    let at = now();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![report_id,assignment,ticket,node,epoch,request_id,requested_state,body["summary"].as_str().unwrap_or("No summary"),body["evidence"].to_string(),body["session_ref"].as_str(), requested_state == "cancelled",at],
    )?;
    for effect in effects {
        tx.execute(
            "INSERT OR IGNORE INTO effects(id,ticket_id,assignment_id,node_id,attempt,input_digest,status,evidence,artifacts,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![effect["effect_id"].as_str().unwrap(),ticket,assignment,node,epoch,effect["input_digest"].as_str().unwrap_or(""),effect["status"].as_str().unwrap_or("unknown"),effect["evidence"].to_string(),effect["artifacts"].to_string(),at],
        )?;
    }
    tx.execute(
        "UPDATE tickets SET status=?1,updated_at=?2 WHERE id=?3",
        params![authority_status, at, ticket],
    )?;
    tx.execute(
        "UPDATE assignments SET last_report_at=?1 WHERE id=?2",
        params![at, assignment],
    )?;
    tx.execute("INSERT INTO requests(node_id,route,request_id,payload_digest,response,created_at) VALUES(?1,'reports',?2,?3,?4,?5)",params![node,request_id,payload_digest,response.to_string(),at])?;
    store::audit_tx(
        &tx,
        Some(&ticket),
        "node",
        "report.accepted",
        &json!({"report_id":report_id,"status":authority_status,"request_id":request_id}),
    )
    .map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error.to_string())))
    })?;
    tx.commit()?;
    Ok(Json(response))
}

async fn artifact(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path((ticket, artifact)): axum::extract::Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let mut a = store
        .get("artifacts", &artifact)?
        .ok_or_else(|| ApiError::missing("Artifact unknown"))?;
    a["location"] = json!(format!("loom://artifact/{artifact}"));
    if a["ticket_id"] != ticket {
        return Err(ApiError::denied(
            "artifact_scope",
            "Ticket does not own this artifact",
        ));
    }
    let bytes = std::fs::read(
        store
            .root
            .join("artifacts")
            .join(a["storage_name"].as_str().unwrap()),
    )?;
    if sha256(&bytes) != a["sha256"].as_str().unwrap() {
        return Err(ApiError::conflict(
            "artifact_integrity",
            "Artifact no longer matches its digest",
        ));
    }
    Ok(Json(
        json!({"artifact":a,"content":String::from_utf8_lossy(&bytes),"size_bytes":bytes.len()}),
    ))
}
async fn tickets(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"tickets":state.lock()?.list("tickets")?})))
}
async fn ticket(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(state.lock()?.detail(&id)?))
}
#[derive(Deserialize)]
struct TicketRequest {
    project_id: String,
    objective: Option<String>,
    goal: Option<String>,
    #[serde(alias = "title")]
    kind: Option<String>,
    relative_path: Option<String>,
    content: Option<String>,
    grant_id: Option<String>,
    node_id: Option<String>,
    worker_id: Option<String>,
    capability: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
}
#[allow(clippy::too_many_arguments)]
async fn create_ticket(
    AppState(state): AppState<Arc<State>>,
    _headers: HeaderMap,
    Json(body): Json<TicketRequest>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let project = store
        .get("projects", &body.project_id)?
        .ok_or_else(|| ApiError::bad("Authorized project reference required"))?;
    let kind = body.kind.as_deref().unwrap_or("read_summary");
    if !matches!(kind, "read_summary" | "edit_file" | "model_text") {
        return Err(ApiError::bad("Supported task kinds are read_summary, edit_file and the separately authorized model_text"));
    }
    let path = safe_relative(
        body.relative_path
            .as_deref()
            .unwrap_or(if kind == "read_summary" {
                "README.md"
            } else {
                "not-a-file-operation"
            }),
    )?;
    let model_resource = if kind == "model_text" {
        let provider = body.provider.as_deref().unwrap_or_default();
        let model = body.model.as_deref().unwrap_or_default();
        if provider.is_empty()
            || model.is_empty()
            || [provider, model].iter().any(|value| {
                value.len() > 160
                    || !value.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/')
                    })
            })
        {
            return Err(ApiError::bad(
                "A text model request requires a bounded explicit provider and model",
            ));
        }
        // This narrowly proven fixture is not a claim that arbitrary providers
        // are installed. It must never select/bill a different remote model.
        if body.content.is_some() {
            return Err(ApiError::bad("Text-model input is the explicit goal and provider/model selection, not a hidden block payload"));
        }
        if (provider, model) != ("loom-stub", "loom-stub-v1") {
            return Err(ApiError::new(
                StatusCode::NOT_IMPLEMENTED,
                "model_unavailable",
                "Only the explicit inspected loom-stub/loom-stub-v1 text fixture is eligible",
            ));
        }
        Some((provider, model))
    } else {
        if body.provider.is_some() || body.model.is_some() {
            return Err(ApiError::bad(
                "provider/model fields are only valid on a separately granted model_text task",
            ));
        }
        None
    };
    let goal = body.objective.or(body.goal).unwrap_or_default();
    if goal.is_empty() || goal.len() > 16000 {
        return Err(ApiError::bad("Explicit objective required"));
    } // Grant permission `read|write` is separately checked against Ticket kind below;
      // the stored operation list is not a TicketKind string alias.
    let grant_id = if let Some(grant) = body.grant_id {
        grant
    } else {
        let permission = match kind {
            "read_summary" => "read",
            "edit_file" => "write",
            _ => "invoke_text",
        };
        let selections=store.query("SELECT id,operations,project_id,revoked_at FROM grants WHERE project_id=?1 AND revoked_at IS NULL ORDER BY created_at DESC",[&body.project_id])?;
        let selected = selections.into_iter().find(|g| {
            g["operations"]
                .as_array()
                .is_some_and(|ops| ops.iter().any(|v| v.as_str() == Some(permission)))
        });
        selected
            .and_then(|g| g["id"].as_str().map(ToOwned::to_owned))
            .ok_or_else(|| {
                ApiError::denied(
                    "grant_required",
                    "No current Grant permits this task's project and permission.",
                )
            })?
    };
    let grant = store
        .get("grants", &grant_id)?
        .ok_or_else(|| ApiError::bad("Grant not found"))?;
    if grant["project_id"] != body.project_id || grant["revoked_at"] != Value::Null {
        return Err(ApiError::denied(
            "grant_scope",
            "Grant is revoked or belongs to another project",
        ));
    };
    let ops = grant["operations"]
        .as_array()
        .map(|ops| ops.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    if !ops.contains(
        &(match kind {
            "read_summary" => "read",
            "edit_file" => "write",
            _ => "invoke_text",
        }),
    ) {
        return Err(ApiError::denied(
            "operation_scope",
            "Grant does not permit this operation",
        ));
    }
    if project["mode"] == "read_only" && kind == "edit_file" {
        return Err(ApiError::denied(
            "read_only",
            "Project has no write authorization",
        ));
    }
    if let Some(node_id) = &body.node_id {
        if grant["node_id"] != "auto" && grant["node_id"].as_str() != Some(node_id.as_str()) {
            return Err(ApiError::denied(
                "placement_scope",
                "This Task selects a Node different from the Grant's authorized placement",
            ));
        }
    }
    if let Some(requested_worker) = &body.worker_id {
        if grant["worker_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .is_some_and(|authorized| authorized != requested_worker)
        {
            return Err(ApiError::denied(
                "worker_scope",
                "The requested Worker is not the Grant's authorized Worker scope",
            ));
        }
    }
    let wanted = body.node_id.or_else(|| {
        grant["node_id"]
            .as_str()
            .filter(|x| *x != "auto")
            .map(str::to_owned)
    });
    let nodes = store.list("nodes")?;
    let selected = if let Some(ref target) = wanted {
        nodes
            .into_iter()
            .find(|n| n["id"].as_str() == Some(target.as_str()))
    } else {
        nodes.into_iter().find(|n| {
            n["capabilities"].as_array().is_some_and(|c| {
                c.iter().any(|v| {
                    v["ticket_kind"] == kind || v.as_str() == Some(&format!("file:{kind}"))
                })
            })
        })
    };
    let Some(_node) = selected else {
        return Err(ApiError::conflict("no_available_host","No authorized online Host currently supports this task; evidence shows capability, not a fabricated success"));
    };
    let gid = grant_id;
    let request = crate::maintenance::create_ticket(
        &store,
        &body.project_id,
        kind,
        &goal,
        &path.to_string_lossy(),
        body.content.as_deref(),
        &gid,
        wanted.as_deref(),
        body.worker_id.as_deref(),
        body.capability.as_deref(),
        model_resource,
    )?;
    Ok(Json(request))
}
async fn cancel(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(ticket): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    crate::maintenance::cancel(&store, &ticket)?;
    store.audit(
        Some(&ticket),
        "client",
        "cancel.requested",
        &json!({"stop_intent":"persistent"}),
    )?;
    Ok(Json(
        json!({"ticket_id":ticket,"status":store.get("tickets",&ticket)?.unwrap()["status"],"stop_intent":"persistent","outcome_if_effect_started":"reconciliation_required"}),
    ))
}
async fn retry(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(ticket): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    crate::maintenance::retry(&store, &ticket)?;
    store.audit(Some(&ticket), "client", "ticket.retried", &json!({}))?;
    Ok(Json(store.detail(&ticket)?))
}
async fn approval(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(ticket): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let decision = body["decision"]
        .as_str()
        .ok_or_else(|| ApiError::bad("decision needed"))?;
    if !matches!(decision, "approve" | "reject") {
        return Err(ApiError::bad("approve/reject"));
    };
    let _ = required(&body, "approval_id", 160)?;
    let store = state.lock()?;
    let t = store
        .get("tickets", &ticket)?
        .ok_or_else(|| ApiError::missing("ticket not found"))?;
    if t["status"] != "waiting_approval" {
        return Err(ApiError::conflict(
            "approval_not_pending",
            "Task is not awaiting approval",
        ));
    }
    crate::maintenance::retry(&store, &ticket)?;
    Ok(Json(store.detail(&ticket)?))
}
#[derive(Deserialize)]
struct PreferenceQuery {
    ticket_id: Option<String>,
}
async fn preference(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if let Some(ticket) = query.ticket_id {
        let pref = store.query("SELECT * FROM preferences WHERE ticket_id=?1", [ticket])?;
        if let Some(reply) = pref.first() {
            return Ok(Json(reply.clone()));
        }
    }
    Ok(Json(
        json!({"expanded":store.setting("global_expanded")==Some("true".into()),"sender_filter":null}),
    ))
}
async fn update_preference(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let expanded = body["expanded"]
        .as_bool()
        .ok_or_else(|| ApiError::bad("expanded must be boolean"))?;
    let store = state.lock()?;
    if let Some(ticket) = query.ticket_id {
        if store.get("tickets", &ticket)?.is_none() {
            return Err(ApiError::missing("ticket unknown"));
        };
        store.conn().execute("INSERT INTO preferences(ticket_id,expanded,sender_filter,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(ticket_id) DO UPDATE SET expanded=excluded.expanded,sender_filter=excluded.sender_filter,updated_at=excluded.updated_at",params![ticket,expanded as i64,body["sender_filter"].as_str(),now()])?;
    } else {
        store.set_setting("global_expanded", if expanded { "true" } else { "false" })?;
    }
    Ok(Json(
        json!({"changed_only_display":true,"expanded":expanded}),
    ))
}
async fn memories(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"memories":state.lock()?.list("memories")?})))
}
async fn create_memory(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let content = required(&body, "content", 8000)?;
    let scope = body["scope"].as_str().unwrap_or("project");
    if !matches!(scope, "project" | "user" | "worker" | "host") {
        return Err(ApiError::bad("Memory scope"));
    }
    let project = body["project_id"].as_str();
    let id = id("memory");
    let store = state.lock()?;
    if scope == "project"
        && (project.is_none() || store.get("projects", project.unwrap())?.is_none())
    {
        return Err(ApiError::bad(
            "Project memory must have an explicit valid project",
        ));
    }
    store.conn().execute("INSERT INTO memories(id,project_id,content,scope,version,created_at,updated_at,source_ticket_id) VALUES(?1,?2,?3,?4,1,?5,?5,?6)",params![id,project,content,scope,now(),body["source_ticket_id"].as_str()])?;
    store.audit(
        body["source_ticket_id"].as_str(),
        "client",
        "memory.explicit_saved",
        &json!({"memory_id":id,"scope":scope}),
    )?;
    Ok(Json(
        json!({"id":id,"content":content,"scope":scope,"version":1,"grant_created":false}),
    ))
}
async fn edit_memory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(memory): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let content = required(&body, "content", 8000)?;
    let store = state.lock()?;
    if store.conn().execute(
        "UPDATE memories SET content=?1,version=version+1,updated_at=?2 WHERE id=?3",
        params![content, now(), memory],
    )? != 1
    {
        return Err(ApiError::missing("Memory not found"));
    }
    Ok(Json(
        json!({"updated":true,"memory":store.get("memories",&memory)?}),
    ))
}
async fn delete_memory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(memory): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if store
        .conn()
        .execute("DELETE FROM memories WHERE id=?1", [memory])?
        != 1
    {
        return Err(ApiError::missing("Memory not found"));
    }
    Ok(Json(json!({"deleted":true,"grants_changed":false})))
}
async fn messages(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if let Some(ticket) = query.ticket_id {
        if ticket.trim().is_empty() || ticket.len() > 160 || ticket.chars().any(|c| c.is_control())
        {
            return Err(ApiError::bad(
                "A bounded exact Ticket ID is required for message filtering",
            ));
        }
        return Ok(Json(json!({
            "messages": store.query("SELECT * FROM messages WHERE ticket_id=?1 ORDER BY created_at,id LIMIT 1000", [ticket])?,
        })));
    }
    Ok(Json(json!({
        "messages": store.query("SELECT * FROM messages WHERE ticket_id IS NULL ORDER BY created_at LIMIT 1000", [])?,
    })))
}
async fn message(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let content = required(&body, "content", 16000)?;
    let id = id("message");
    let store = state.lock()?;
    store.conn().execute("INSERT INTO messages(id,sender,kind,content,visibility,created_at) VALUES(?1,'user','conversation',?2,'private',?3)",params![id,content,now()])?;
    Ok(Json(
        json!({"id":id,"recorded":true,"permission_granted":false}),
    ))
}
async fn audit(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"audit":state.lock()?.audits(query.ticket_id.as_deref())?}),
    ))
}
async fn verify_audit(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"valid":state.lock()?.verify_audit()?,"algorithm":"sha256_chain_v1"}),
    ))
}

async fn inventory(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(
        json!({"nodes":store.list("nodes")?,"projects":store.list("projects")?,"source":"last_recorded_probe","observed_at":now(),"note":"Online status is not inferred from cached capabilities."}),
    ))
}
#[allow(dead_code)]
async fn create_pipeline(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::pipeline::create(&mut store, &body)?))
}
async fn list_pipelines(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(json!({"pipelines":crate::pipeline::list(&store)?})))
}
async fn pipeline_detail(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Pipeline ID must be UUID"))?;
    let store = state.lock()?;
    Ok(Json(
        json!({"pipeline":crate::pipeline::detail(&store, &id)?}),
    ))
}
async fn run_pipeline(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Pipeline ID must be UUID"))?;
    let store = state.lock()?;
    crate::pipeline::advance_all(&store)?;
    Ok(Json(
        json!({"pipeline":crate::pipeline::detail(&store, &id)?}),
    ))
}
async fn cancel_pipeline(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Pipeline ID must be UUID"))?;
    let store = state.lock()?;
    crate::pipeline::cancel(&store, &id)?;
    Ok(Json(
        json!({"cancel_requested":true,"pipeline":crate::pipeline::detail(&store, &id)?}),
    ))
}
async fn models(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::new(StatusCode::NOT_IMPLEMENTED, "m3_not_available", "Full model registry, verified placement lifecycle and general provider activation are not delivered yet. Only the separately verified, bounded model_text fixture exists; other models remain unknown without genuine observation."))
}
async fn candidates(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let rows = store.query("SELECT * FROM candidates ORDER BY created_at DESC", [])?;
    Ok(Json(
        json!({"candidates":rows,"policy":"Observations are not permanent Memory or a Grant"}),
    ))
}
async fn create_candidate(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::maintenance::observation_candidate(
        &store, &body,
    )?))
}
async fn review_candidate(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(candidate): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::maintenance::review_candidate(
        &store, &candidate, &body,
    )?))
}

fn hash_json(value: &Value) -> String {
    sha256(value.to_string())
}
