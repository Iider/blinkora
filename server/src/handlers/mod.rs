use crate::app::AppState;
use crate::trpc::ProcedureHandler;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

pub mod agent_tokens;
pub mod agent_resources;
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
pub mod system;
pub mod tags;
pub mod workspaces;

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

pub async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

pub async fn health_head() -> &'static str {
    ""
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
    system::register(registry);
    tags::register(registry);
    workspaces::register(registry);
}
