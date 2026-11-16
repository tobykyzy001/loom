//! The full mounted node protocol paths. Each handler authenticates its envelope.
use super::*;
use axum::{
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::Value;
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<api::State>> {
    Router::new()
        .route("/api/v1/nodes/challenge", post(api::challenge))
        .route("/api/v1/nodes/register", post(api::register))
        .route("/api/v1/nodes/heartbeat", post(api::heartbeat))
        .route("/api/v1/nodes/assignments/poll", post(api::poll))
        .route("/api/v1/nodes/acknowledge", post(api::acknowledge))
        .route("/api/v1/nodes/events", post(api::event))
        .route(
            "/api/v1/nodes/artifacts",
            post(api::artifact_upload_handler),
        )
        .route("/api/v1/nodes/reports", post(api::report))
        .route("/api/v1/nodes/effects/reconcile", post(reconcile))
}

async fn reconcile(
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, api::ApiError> {
    let _ = (headers, body);
    Err(api::ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        "host_reconciliation_unavailable",
        "Unknown effects require a Host-side verified ledger. The center does not replay or infer them.",
    ))
}
