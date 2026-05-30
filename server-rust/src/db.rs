use anyhow::Context;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub async fn connect(database_url: &str) -> anyhow::Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .connect(database_url)
        .await
        .context("database connection failed")
}

pub async fn migrate(pool: &PgPool, migrations_dir: impl AsRef<Path>) -> anyhow::Result<()> {
    ensure_migration_table(pool).await?;

    let mut migrations = list_migrations(migrations_dir.as_ref())?;
    migrations.sort_by(|left, right| left.name.cmp(&right.name));

    for migration in migrations {
        let already_applied: Option<String> = sqlx::query_scalar(r#"SELECT id FROM "_prisma_migrations" WHERE migration_name=$1 AND rolled_back_at IS NULL"#)
            .bind(&migration.name)
            .fetch_optional(pool)
            .await?;
        if already_applied.is_some() {
            continue;
        }

        let sql = tokio::fs::read_to_string(&migration.sql_path)
            .await
            .with_context(|| format!("failed to read migration {}", migration.sql_path.display()))?;
        let migration_id = uuid::Uuid::new_v4().to_string();
        let checksum = checksum(&sql);

        let mut tx = pool.begin().await?;
        sqlx::query(
            r#"INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count)
               VALUES ($1,$2,$3,NOW(),0)"#,
        )
        .bind(&migration_id)
        .bind(&checksum)
        .bind(&migration.name)
        .execute(&mut *tx)
        .await?;

        sqlx::raw_sql(&sql)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("failed to apply migration {}", migration.name))?;

        sqlx::query(r#"UPDATE "_prisma_migrations" SET finished_at=NOW(), applied_steps_count=1 WHERE id=$1"#)
            .bind(&migration_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::info!(migration = %migration.name, "database migration applied");
    }

    Ok(())
}

async fn ensure_migration_table(pool: &PgPool) -> anyhow::Result<()> {
    sqlx::raw_sql(
        r#"CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            id VARCHAR(36) PRIMARY KEY,
            checksum VARCHAR(64) NOT NULL,
            finished_at TIMESTAMPTZ(6),
            migration_name VARCHAR(255) NOT NULL,
            logs TEXT,
            rolled_back_at TIMESTAMPTZ(6),
            started_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
            applied_steps_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "_prisma_migrations_migration_name_key"
            ON "_prisma_migrations" (migration_name);"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

struct Migration {
    name: String,
    sql_path: PathBuf,
}

fn list_migrations(migrations_dir: &Path) -> anyhow::Result<Vec<Migration>> {
    let mut migrations = Vec::new();
    for entry in std::fs::read_dir(migrations_dir)
        .with_context(|| format!("failed to read migrations dir {}", migrations_dir.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let sql_path = entry.path().join("migration.sql");
        if sql_path.is_file() {
            migrations.push(Migration { name, sql_path });
        }
    }
    Ok(migrations)
}

fn checksum(sql: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sql.as_bytes());
    hex::encode(hasher.finalize())
}
