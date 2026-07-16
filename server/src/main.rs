mod app;
mod attachment_files;
mod auth;
mod config;
mod db;
mod embedded_assets;
mod handlers;
mod s3;
mod static_files;
mod trpc;
mod util;

use anyhow::Context;
use axum::Router;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string()))
        .init();

    let cfg = config::Config::from_env();
    cfg.validate()?;
    let pool = db::connect(&cfg.data_dir).await?;
    db::init_schema(&pool).await?;
    let state = app::AppState::new(cfg.clone(), pool);
    let recovered_file_operations =
        attachment_files::recover_pending_attachment_operations(&state).await?;
    if recovered_file_operations > 0 {
        tracing::warn!(
            count = recovered_file_operations,
            "recovered interrupted attachment file operations"
        );
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let router = Router::new()
        .nest("/api", handlers::router())
        .route("/sse", axum::routing::get(handlers::mcp::sse))
        .route("/messages", axum::routing::post(handlers::mcp::messages))
        .route(
            "/health",
            axum::routing::get(handlers::health).head(handlers::health_head),
        )
        .fallback(static_files::static_handler)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr: SocketAddr = format!("{}:{}", state.config.bind_addr, state.config.port)
        .parse()
        .context("invalid bind address")?;
    let listener = TcpListener::bind(addr).await?;
    tracing::info!(%addr, env = %state.config.node_env, "rust backend started");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        let mut signal = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        signal.recv().await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
