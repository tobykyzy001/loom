//! The full mounted node protocol paths. Each handler authenticates its envelope.
use super::*;
use axum::{
    extract::State as AppState,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) fn routes() -> Router<Arc<api::State>> {
    Router::new()
        .route("/api/v1/nodes/challenge", post(api::challenge))
        .route("/api/v1/nodes/register", post(api::register))
        .route("/api/v1/nodes/heartbeat", post(api::heartbeat))
        .route("/api/v1/nodes/assignments/poll", post(api::poll))
        .route("/api/v1/nodes/acknowledge", post(api::acknowledge))
        .route("/api/v1/nodes/events", post(api::event))
        .route("/api/v1/nodes/assignments/source", post(api::source_input))
        .route("/api/v1/nodes/direct-offers", post(direct_offer))
        .route("/api/v1/nodes/direct-offers/scope", post(direct_scope))
        .route(
            "/api/v1/nodes/artifacts",
            post(api::artifact_upload_handler),
        )
        .route("/api/v1/nodes/reports", post(api::report))
        .route("/api/v1/nodes/effects/reconcile", post(reconcile))
}

async fn direct_offer(
    AppState(state): AppState<Arc<api::State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, api::ApiError> {
    let (node, installation) = node_identity(&state, &headers, &body)?;
    if node != body["ticket_node_id"].as_str().unwrap_or("")
        && body["ticket_node_id"] != Value::Null
    {
        return Err(api::ApiError::denied(
            "recipient_node_scope",
            "The ticket must belong to the authenticated recipient Node",
        ));
    }
    let output =
        crate::direct_offer::issue(&*api::State::lock(&state)?, &body, &node, &installation)
            .map_err(|error| api::ApiError::denied("direct_offer_denied", error.to_string()))?;
    Ok(Json(output))
}
async fn direct_scope(
    AppState(state): AppState<Arc<api::State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>, api::ApiError> {
    let (node, installation) = node_identity(&state, &headers, &body)?;
    let offer = crate::direct_offer::peek(&*api::State::lock(&state)?, &body, &node, &installation)
        .map_err(|error| api::ApiError::denied("direct_offer_source_denied", error.to_string()))?;
    Ok(Json(json!({"direct_offer":offer})))
}
fn node_identity(
    state: &Arc<api::State>,
    headers: &HeaderMap,
    body: &Value,
) -> Result<(String, String), api::ApiError> {
    // Keep authentication in the existing node transport; public HTTP direct offers never use a client credential.
    api::node_authenticate_for_direct_offer(state, headers, body)?;
    Ok((
        body["node_id"].as_str().unwrap_or_default().to_owned(),
        body["installation_id"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    ))
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
