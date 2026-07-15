use crate::app::AppState;
use crate::trpc::ProcedureHandler;
use axum::routing::get;
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json, Router};
use serde_json::json;
use std::collections::HashMap;

pub mod agent_resources;
pub mod agent_tokens;
pub mod attachments;
pub mod auth;
pub mod backup;
pub mod comments;
pub mod common;
pub mod config;
pub mod files;
pub mod fonts;
pub mod mcp;
pub mod notes;
pub mod operation_logs;
pub mod system;
pub mod tags;
pub mod workspaces;

#[cfg(test)]
pub(crate) mod test_support;

pub fn router() -> Router<AppState> {
    Router::new()
        .nest("/auth", auth::router())
        .nest("/agent", agent_resources::router())
        .nest("/backup", backup::router())
        .merge(files::router())
        .route(
            "/trpc/*path",
            get(crate::trpc::trpc_get).post(crate::trpc::trpc_post),
        )
        .route("/sse", get(mcp::sse))
        .route("/messages", axum::routing::post(mcp::messages))
}

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    match crate::db::probe(state.pool()).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "status": "ok" }))).into_response(),
        Err(error) => {
            tracing::error!(%error, "health probe failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "error" })),
            )
                .into_response()
        }
    }
}

pub async fn health_head(State(state): State<AppState>) -> StatusCode {
    if crate::db::probe(state.pool()).await.is_ok() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

pub fn register_procedures(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    agent_tokens::register(registry);
    auth::register(registry);
    attachments::register(registry);
    backup::register(registry);
    comments::register(registry);
    config::register(registry);
    fonts::register(registry);
    notes::register(registry);
    operation_logs::register(registry);
    system::register(registry);
    tags::register(registry);
    workspaces::register(registry);
}
