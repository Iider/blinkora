use anyhow::Context;
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::path::Path;
use std::time::Duration;

pub async fn connect(database_url: &str) -> anyhow::Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(database_url)
        .await
        .context("database connection failed")
}

pub async fn init_schema(pool: &PgPool, schema_path: impl AsRef<Path>) -> anyhow::Result<()> {
    if schema_exists(pool).await? {
        return Ok(());
    }

    let schema_path = schema_path.as_ref();
    let sql = tokio::fs::read_to_string(schema_path)
        .await
        .with_context(|| format!("failed to read database schema {}", schema_path.display()))?;

    sqlx::raw_sql(&sql)
        .execute(pool)
        .await
        .with_context(|| format!("failed to initialize database schema {}", schema_path.display()))?;

    tracing::info!(schema = %schema_path.display(), "database schema initialized");
    Ok(())
}

async fn schema_exists(pool: &PgPool) -> anyhow::Result<bool> {
    let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass('public.accounts')::text")
        .fetch_one(pool)
        .await?;
    Ok(exists.is_some())
}
