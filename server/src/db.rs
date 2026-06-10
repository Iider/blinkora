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
    if !schema_exists(pool).await? {
        let schema_path = schema_path.as_ref();
        let sql = tokio::fs::read_to_string(schema_path)
            .await
            .with_context(|| format!("failed to read database schema {}", schema_path.display()))?;

        sqlx::raw_sql(&sql).execute(pool).await.with_context(|| {
            format!(
                "failed to initialize database schema {}",
                schema_path.display()
            )
        })?;

        tracing::info!(schema = %schema_path.display(), "database schema initialized");
    }

    ensure_runtime_schema(pool).await?;
    Ok(())
}

async fn schema_exists(pool: &PgPool) -> anyhow::Result<bool> {
    let exists: Option<String> = sqlx::query_scalar("SELECT to_regclass('public.accounts')::text")
        .fetch_one(pool)
        .await?;
    Ok(exists.is_some())
}

async fn ensure_runtime_schema(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"
        CREATE TABLE IF NOT EXISTS public."agentAccessTokens" (
            id SERIAL PRIMARY KEY,
            name character varying DEFAULT ''::character varying NOT NULL,
            "tokenHash" character varying(64) NOT NULL,
            token text,
            "accountId" integer NOT NULL REFERENCES public.accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
            "workspaceId" integer NOT NULL REFERENCES public.workspaces(id) ON UPDATE CASCADE ON DELETE CASCADE,
            permissions json DEFAULT '{"notes":["read","write"],"comments":["read","write"],"tags":["read"]}'::json NOT NULL,
            "expiresAt" timestamp(6) with time zone,
            "revokedAt" timestamp(6) with time zone,
            "lastUsedAt" timestamp(6) with time zone,
            "createdAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
            "updatedAt" timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
        );

        ALTER TABLE public."agentAccessTokens"
            ADD COLUMN IF NOT EXISTS token text;

        CREATE UNIQUE INDEX IF NOT EXISTS "agentAccessTokens_tokenHash_key"
            ON public."agentAccessTokens" USING btree ("tokenHash");
        CREATE INDEX IF NOT EXISTS "agentAccessTokens_accountId_workspaceId_idx"
            ON public."agentAccessTokens" USING btree ("accountId", "workspaceId");
        CREATE INDEX IF NOT EXISTS "agentAccessTokens_workspaceId_idx"
            ON public."agentAccessTokens" USING btree ("workspaceId");
        CREATE INDEX IF NOT EXISTS "agentAccessTokens_revokedAt_idx"
            ON public."agentAccessTokens" USING btree ("revokedAt");
        "#,
    )
    .execute(pool)
    .await
    .context("failed to ensure runtime database schema")?;

    Ok(())
}
