use anyhow::{bail, Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    QueryBuilder, Sqlite, SqlitePool,
};
use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio_postgres::{Client, NoTls};

const SQLITE_SCHEMA: &str = include_str!("../../../db/schema.sqlite.sql");
const SQLITE_SCHEMA_VERSION: i64 = 2;

struct TableSpec {
    name: &'static str,
    columns: &'static [&'static str],
    json_columns: &'static [&'static str],
    bool_columns: &'static [&'static str],
    timestamp_columns: &'static [&'static str],
    blob_column: Option<&'static str>,
    size_as_text: bool,
}

const TABLES: &[TableSpec] = &[
    TableSpec {
        name: "accounts",
        columns: &[
            "id",
            "name",
            "nickname",
            "password",
            "image",
            "apiToken",
            "note",
            "role",
            "createdAt",
            "updatedAt",
            "description",
        ],
        json_columns: &[],
        bool_columns: &[],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "workspaces",
        columns: &[
            "id",
            "name",
            "description",
            "icon",
            "color",
            "accountId",
            "isDefault",
            "createdAt",
            "updatedAt",
        ],
        json_columns: &[],
        bool_columns: &["isDefault"],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "notes",
        columns: &[
            "id",
            "type",
            "content",
            "isArchived",
            "isRecycle",
            "isTop",
            "metadata",
            "createdAt",
            "updatedAt",
            "isReviewed",
            "accountId",
            "sortOrder",
            "workspaceId",
        ],
        json_columns: &["metadata"],
        bool_columns: &["isArchived", "isRecycle", "isTop", "isReviewed"],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "tag",
        columns: &[
            "id",
            "name",
            "icon",
            "parent",
            "createdAt",
            "updatedAt",
            "accountId",
            "sortOrder",
            "workspaceId",
        ],
        json_columns: &[],
        bool_columns: &[],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "tagsToNote",
        columns: &["id", "noteId", "tagId"],
        json_columns: &[],
        bool_columns: &[],
        timestamp_columns: &[],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "attachments",
        columns: &[
            "id",
            "name",
            "path",
            "size",
            "noteId",
            "createdAt",
            "updatedAt",
            "type",
            "sortOrder",
            "depth",
            "perfixPath",
            "accountId",
            "metadata",
            "workspaceId",
        ],
        json_columns: &["metadata"],
        bool_columns: &[],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: true,
    },
    TableSpec {
        name: "noteHistory",
        columns: &[
            "id",
            "noteId",
            "content",
            "metadata",
            "version",
            "accountId",
            "createdAt",
            "workspaceId",
        ],
        json_columns: &["metadata"],
        bool_columns: &[],
        timestamp_columns: &["createdAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "noteReference",
        columns: &["id", "fromNoteId", "toNoteId", "createdAt"],
        json_columns: &[],
        bool_columns: &[],
        timestamp_columns: &["createdAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "comments",
        columns: &[
            "id",
            "content",
            "accountId",
            "noteId",
            "parentId",
            "createdAt",
            "updatedAt",
            "kind",
            "status",
            "metadata",
            "workspaceId",
        ],
        json_columns: &["metadata"],
        bool_columns: &[],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "config",
        columns: &["id", "key", "config", "userId", "workspaceId"],
        json_columns: &["config"],
        bool_columns: &[],
        timestamp_columns: &[],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "fonts",
        columns: &[
            "id",
            "name",
            "displayName",
            "url",
            "fileData",
            "isLocal",
            "isSystem",
            "weights",
            "category",
            "sortOrder",
            "createdAt",
            "updatedAt",
        ],
        json_columns: &["weights"],
        bool_columns: &["isLocal", "isSystem"],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: Some("fileData"),
        size_as_text: false,
    },
    TableSpec {
        name: "agentAccessTokens",
        columns: &[
            "id",
            "name",
            "tokenHash",
            "token",
            "accountId",
            "workspaceId",
            "permissions",
            "expiresAt",
            "revokedAt",
            "lastUsedAt",
            "createdAt",
            "updatedAt",
        ],
        json_columns: &["permissions"],
        bool_columns: &[],
        timestamp_columns: &[
            "expiresAt",
            "revokedAt",
            "lastUsedAt",
            "createdAt",
            "updatedAt",
        ],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "operationLog",
        columns: &[
            "id",
            "accountId",
            "workspaceId",
            "actorType",
            "actorAccountId",
            "actorAgentTokenId",
            "actorLabel",
            "action",
            "noteId",
            "noteType",
            "noteTitle",
            "changedFields",
            "summary",
            "details",
            "createdAt",
        ],
        json_columns: &["changedFields", "details"],
        bool_columns: &[],
        timestamp_columns: &["createdAt"],
        blob_column: None,
        size_as_text: false,
    },
    TableSpec {
        name: "cache",
        columns: &["id", "key", "value", "createdAt", "updatedAt"],
        json_columns: &["value"],
        bool_columns: &[],
        timestamp_columns: &["createdAt", "updatedAt"],
        blob_column: None,
        size_as_text: false,
    },
];

struct Args {
    source_url: String,
    data_dir: PathBuf,
    snapshot_dir: PathBuf,
}

struct TableDigest {
    table: &'static str,
    count: usize,
    sha256: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = parse_args()?;
    migrate(args).await
}

async fn migrate(args: Args) -> Result<()> {
    let final_path = args.data_dir.join("blinkora.sqlite3");
    if final_path.exists() {
        bail!(
            "SQLite target already exists at {}; refusing to overwrite it",
            final_path.display()
        );
    }
    tokio::fs::create_dir_all(&args.data_dir).await?;
    tokio::fs::create_dir_all(&args.snapshot_dir).await?;
    set_private_dir(&args.data_dir).await?;
    set_private_dir(&args.snapshot_dir).await?;

    stage("connect-source");
    let (client, connection) = tokio_postgres::connect(&args.source_url, NoTls)
        .await
        .context("PostgreSQL connection failed")?;
    let source_task = tokio::spawn(async move { connection.await });
    begin_write_quiescence(&client).await?;

    let outcome = migrate_while_source_is_locked(&args, &client, &final_path).await;
    let release_result = client.batch_execute("COMMIT").await;
    source_task.abort();

    match (outcome, release_result) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => {
            Err(error).context("migration finished but PostgreSQL lock release failed")
        }
    }
}

async fn migrate_while_source_is_locked(
    args: &Args,
    client: &Client,
    final_path: &Path,
) -> Result<()> {
    stage("snapshot-postgres");
    create_postgres_snapshot(&args.source_url, &args.snapshot_dir).await?;

    stage("read-source");
    let mut source_tables = Vec::with_capacity(TABLES.len());
    for spec in TABLES {
        let rows = fetch_source_rows(client, spec).await?;
        source_tables.push((spec, rows));
    }

    let temporary_path = final_path.with_extension(format!(
        "sqlite3.migrating-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_micros()
    ));
    if temporary_path.exists() {
        bail!("temporary SQLite migration target already exists; retry after inspecting it");
    }

    stage("write-temporary-sqlite");
    let pool = open_temporary_sqlite(&temporary_path).await?;
    sqlx::raw_sql(SQLITE_SCHEMA).execute(&pool).await?;
    sqlx::query(&format!("PRAGMA user_version = {SQLITE_SCHEMA_VERSION}"))
        .execute(&pool)
        .await?;
    insert_all(&pool, &source_tables).await?;

    stage("verify-rows");
    for (spec, source_rows) in &source_tables {
        let source_digest = digest_rows(spec.name, source_rows)?;
        let target_rows = fetch_target_rows(&pool, spec).await?;
        let target_digest = digest_rows(spec.name, &target_rows)?;
        if source_digest.count != target_digest.count
            || source_digest.sha256 != target_digest.sha256
        {
            bail!(
                "validation failed for table {} (source rows {}, target rows {})",
                spec.name,
                source_digest.count,
                target_digest.count
            );
        }
        println!(
            "migration table={} rows={} sha256={}",
            source_digest.table, source_digest.count, source_digest.sha256
        );
    }
    verify_sqlite(&pool).await?;
    verify_local_attachment_files(&args.data_dir, &source_tables)?;
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await?;
    pool.close().await;
    set_private_file(&temporary_path).await?;

    if final_path.exists() {
        bail!("SQLite target appeared during migration; refusing to replace it");
    }
    stage("atomic-switch");
    tokio::fs::rename(&temporary_path, final_path)
        .await
        .context("failed to atomically activate validated SQLite database")?;
    set_private_file(final_path).await?;
    stage("complete");
    Ok(())
}

async fn begin_write_quiescence(client: &Client) -> Result<()> {
    stage("stop-postgres-writes");
    let table_names = TABLES
        .iter()
        .map(|spec| format!("public.{}", quote_identifier(spec.name)))
        .collect::<Vec<_>>()
        .join(", ");
    client
        .batch_execute(&format!(
            "BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL TIME ZONE 'UTC'; LOCK TABLE {table_names} IN SHARE ROW EXCLUSIVE MODE;"
        ))
        .await
        .context("could not acquire PostgreSQL write-quiescence locks")?;
    Ok(())
}

async fn create_postgres_snapshot(source_url: &str, snapshot_dir: &Path) -> Result<()> {
    let snapshot = snapshot_dir.join(format!(
        "blinkora-postgres-before-sqlite-{}.dump",
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
    ));
    let output = tokio::process::Command::new("pg_dump")
        .arg("--format=custom")
        .arg("--file")
        .arg(&snapshot)
        .arg(source_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .context("pg_dump is required to create the PostgreSQL safety snapshot")?;
    if !output.status.success() {
        bail!("pg_dump failed; PostgreSQL was left unchanged and SQLite was not created");
    }
    set_private_file(&snapshot).await?;
    println!("migration snapshot=created");
    Ok(())
}

async fn open_temporary_sqlite(path: &Path) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(5));
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .context("failed to create temporary SQLite migration target")?)
}

async fn fetch_source_rows(client: &Client, spec: &TableSpec) -> Result<Vec<Value>> {
    let columns = spec
        .columns
        .iter()
        .map(|column| {
            if spec.size_as_text && *column == "size" {
                "size::text AS size".to_string()
            } else {
                quote_identifier(column)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let table = format!("public.{}", quote_identifier(spec.name));
    let sql = format!(
        "SELECT row_to_json(row_data)::text FROM (SELECT {columns} FROM {table} ORDER BY id ASC) AS row_data"
    );
    let rows = client.query(&sql, &[]).await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.try_get(0)?;
            let mut value: Value = serde_json::from_str(&raw)?;
            normalize_source_row(spec, &mut value)?;
            Ok(value)
        })
        .collect()
}

fn normalize_source_row(spec: &TableSpec, value: &mut Value) -> Result<()> {
    let object = value
        .as_object_mut()
        .context("PostgreSQL row_to_json did not return an object")?;
    for column in spec.timestamp_columns {
        let Some(value) = object.get_mut(*column) else {
            continue;
        };
        match value {
            Value::Null => {}
            Value::String(value) => {
                *value = normalize_utc_timestamp(value).with_context(|| {
                    format!("{}.{} is not a finite RFC3339 timestamp", spec.name, column)
                })?;
            }
            _ => bail!(
                "{}.{} must be text or null in the PostgreSQL source",
                spec.name,
                column
            ),
        }
    }
    for column in spec.bool_columns {
        if let Some(Value::Bool(value)) = object.get(*column) {
            object.insert((*column).to_string(), Value::from(i64::from(*value)));
        }
    }
    if let Some(column) = spec.blob_column {
        if let Some(Value::String(value)) = object.get_mut(column) {
            let normalized = value
                .strip_prefix("\\x")
                .unwrap_or(value)
                .to_ascii_lowercase();
            *value = normalized;
        }
    }
    Ok(())
}

fn normalize_utc_timestamp(value: &str) -> Result<String> {
    let timestamp = DateTime::parse_from_rfc3339(value)?;
    Ok(timestamp
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Micros, true))
}

async fn insert_all(pool: &SqlitePool, tables: &[(&TableSpec, Vec<Value>)]) -> Result<()> {
    let mut transaction = pool.begin().await?;
    for (spec, rows) in tables {
        let column_list = spec
            .columns
            .iter()
            .map(|column| quote_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        for row in rows {
            let object = row.as_object().context("source row is not an object")?;
            let mut query = QueryBuilder::<Sqlite>::new(format!(
                "INSERT INTO {} ({column_list}) VALUES (",
                quote_identifier(spec.name)
            ));
            for (index, column) in spec.columns.iter().enumerate() {
                if index != 0 {
                    query.push(", ");
                }
                let value = object
                    .get(*column)
                    .with_context(|| format!("source row is missing {}.{}", spec.name, column))?;
                push_sqlite_value(&mut query, spec, column, value)?;
            }
            query.push(")");
            query.build().execute(&mut *transaction).await?;
        }
    }
    transaction.commit().await?;
    Ok(())
}

fn push_sqlite_value(
    query: &mut QueryBuilder<'_, Sqlite>,
    spec: &TableSpec,
    column: &str,
    value: &Value,
) -> Result<()> {
    if spec.json_columns.contains(&column) {
        if value.is_null() {
            query.push_bind(Option::<String>::None);
        } else {
            query.push_bind(Some(serde_json::to_string(value)?));
        }
        return Ok(());
    }
    if spec.blob_column == Some(column) {
        if value.is_null() {
            query.push_bind(Option::<Vec<u8>>::None);
        } else {
            let encoded = value
                .as_str()
                .context("PostgreSQL bytea JSON value is not text")?;
            query.push_bind(Some(hex::decode(encoded)?));
        }
        return Ok(());
    }
    match value {
        Value::Null => {
            query.push_bind(Option::<String>::None);
        }
        Value::Bool(value) => {
            query.push_bind(i64::from(*value));
        }
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                query.push_bind(value);
            } else {
                query.push_bind(value.to_string());
            }
        }
        Value::String(value) => {
            query.push_bind(value.clone());
        }
        Value::Array(_) | Value::Object(_) => {
            bail!("non-JSON column {column} contains an unexpected structured value")
        }
    };
    Ok(())
}

async fn fetch_target_rows(pool: &SqlitePool, spec: &TableSpec) -> Result<Vec<Value>> {
    let pairs = spec
        .columns
        .iter()
        .map(|column| format!("'{}', {}", column, target_json_expression(spec, column)))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT json_object({pairs}) FROM {} ORDER BY id ASC",
        quote_identifier(spec.name)
    );
    let raw_rows: Vec<String> = sqlx::query_scalar(&sql).fetch_all(pool).await?;
    raw_rows
        .into_iter()
        .map(|raw| Ok(serde_json::from_str(&raw)?))
        .collect()
}

fn target_json_expression(spec: &TableSpec, column: &str) -> String {
    let column = quote_identifier(column);
    if spec.json_columns.contains(&column.trim_matches('"')) {
        return format!("CASE WHEN {column} IS NULL THEN NULL ELSE json({column}) END");
    }
    if spec.blob_column == Some(column.trim_matches('"')) {
        return format!("CASE WHEN {column} IS NULL THEN NULL ELSE lower(hex({column})) END");
    }
    if spec.bool_columns.contains(&column.trim_matches('"')) {
        return format!("CASE WHEN {column} THEN 1 ELSE 0 END");
    }
    column
}

fn digest_rows(table: &'static str, rows: &[Value]) -> Result<TableDigest> {
    let mut hasher = Sha256::new();
    for row in rows {
        let canonical = canonical_json(row);
        hasher.update(serde_json::to_vec(&canonical)?);
        hasher.update(b"\n");
    }
    Ok(TableDigest {
        table,
        count: rows.len(),
        sha256: hex::encode(hasher.finalize()),
    })
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        Value::Object(values) => {
            let ordered = values
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json(value)))
                .collect::<BTreeMap<_, _>>();
            Value::Object(ordered.into_iter().collect::<Map<_, _>>())
        }
        value => value.clone(),
    }
}

async fn verify_sqlite(pool: &SqlitePool) -> Result<()> {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await?;
    if integrity != "ok" {
        bail!("SQLite integrity_check failed: {integrity}");
    }
    let foreign_key_violations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(pool)
            .await?;
    if foreign_key_violations != 0 {
        bail!("SQLite foreign_key_check found {foreign_key_violations} violation(s)");
    }
    verify_logical_relationships(pool).await?;
    verify_id_high_water_marks(pool).await?;
    Ok(())
}

async fn verify_logical_relationships(pool: &SqlitePool) -> Result<()> {
    let checks = [
        (
            "notes_workspace_scope",
            r#"SELECT COUNT(*) FROM notes n
               WHERE n."workspaceId" IS NOT NULL AND (
                 n."accountId" IS NULL OR NOT EXISTS (
                   SELECT 1 FROM workspaces w
                   WHERE w.id=n."workspaceId" AND w."accountId"=n."accountId"
                 )
               )"#,
        ),
        (
            "tag_workspace_scope",
            r#"SELECT COUNT(*) FROM tag t
               WHERE t."workspaceId" IS NOT NULL AND (
                 t."accountId" IS NULL OR NOT EXISTS (
                   SELECT 1 FROM workspaces w
                   WHERE w.id=t."workspaceId" AND w."accountId"=t."accountId"
                 )
               )"#,
        ),
        (
            "tag_parent_scope",
            r#"SELECT COUNT(*) FROM tag t LEFT JOIN tag p ON p.id=t.parent
               WHERE t.parent<>0 AND (
                 p.id IS NULL OR p."accountId" IS NOT t."accountId"
                 OR p."workspaceId" IS NOT t."workspaceId"
               )"#,
        ),
        (
            "tag_link_scope",
            r#"SELECT COUNT(*) FROM "tagsToNote" link
               JOIN notes n ON n.id=link."noteId"
               JOIN tag t ON t.id=link."tagId"
               WHERE n."accountId" IS NOT t."accountId"
                  OR n."workspaceId" IS NOT t."workspaceId""#,
        ),
        (
            "note_reference_scope",
            r#"SELECT COUNT(*) FROM "noteReference" reference
               JOIN notes source ON source.id=reference."fromNoteId"
               JOIN notes target ON target.id=reference."toNoteId"
               WHERE source."accountId" IS NOT target."accountId"
                  OR source."workspaceId" IS NOT target."workspaceId""#,
        ),
        (
            "history_note_scope",
            r#"SELECT COUNT(*) FROM "noteHistory" history
               JOIN notes n ON n.id=history."noteId"
               WHERE history."accountId" IS NOT n."accountId"
                  OR history."workspaceId" IS NOT n."workspaceId""#,
        ),
        (
            "comment_note_scope",
            r#"SELECT COUNT(*) FROM comments comment
               JOIN notes n ON n.id=comment."noteId"
               WHERE comment."accountId" IS NOT n."accountId"
                  OR comment."workspaceId" IS NOT n."workspaceId""#,
        ),
        (
            "comment_parent_scope",
            r#"SELECT COUNT(*) FROM comments comment
               JOIN comments parent ON parent.id=comment."parentId"
               WHERE comment."noteId"<>parent."noteId"
                  OR comment."workspaceId" IS NOT parent."workspaceId""#,
        ),
        (
            "attachment_workspace_scope",
            r#"SELECT COUNT(*) FROM attachments attachment
               WHERE attachment."workspaceId" IS NOT NULL AND (
                 attachment."accountId" IS NULL OR NOT EXISTS (
                   SELECT 1 FROM workspaces w
                   WHERE w.id=attachment."workspaceId"
                     AND w."accountId"=attachment."accountId"
                 )
               )"#,
        ),
        (
            "attachment_note_scope",
            r#"SELECT COUNT(*) FROM attachments attachment
               JOIN notes n ON n.id=attachment."noteId"
               WHERE attachment."accountId" IS NOT n."accountId"
                  OR attachment."workspaceId" IS NOT n."workspaceId""#,
        ),
        (
            "workspace_token_scope",
            r#"SELECT COUNT(*) FROM "agentAccessTokens" token
               JOIN workspaces w ON w.id=token."workspaceId"
               WHERE token."accountId"<>w."accountId""#,
        ),
        (
            "config_workspace_scope",
            r#"SELECT COUNT(*) FROM config c JOIN workspaces w ON w.id=c."workspaceId"
               WHERE c."userId" IS NULL OR c."userId"<>w."accountId""#,
        ),
        (
            "operation_log_workspace_scope",
            r#"SELECT COUNT(*) FROM "operationLog" log
               JOIN workspaces w ON w.id=log."workspaceId"
               WHERE log."accountId" IS NULL OR log."accountId"<>w."accountId""#,
        ),
    ];
    for (name, sql) in checks {
        let violations: i64 = sqlx::query_scalar(sql).fetch_one(pool).await?;
        if violations != 0 {
            bail!("SQLite logical check {name} found {violations} violation(s)");
        }
    }
    Ok(())
}

async fn verify_id_high_water_marks(pool: &SqlitePool) -> Result<()> {
    for table in [
        "accounts",
        "workspaces",
        "notes",
        "tag",
        "attachments",
        "noteHistory",
        "noteReference",
        "comments",
        "config",
        "fonts",
        "agentAccessTokens",
        "operationLog",
        "cache",
    ] {
        let maximum: i64 = sqlx::query_scalar(&format!(
            "SELECT COALESCE(MAX(id), 0) FROM {}",
            quote_identifier(table)
        ))
        .fetch_one(pool)
        .await?;
        let sequence: Option<i64> =
            sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name=$1")
                .bind(table)
                .fetch_optional(pool)
                .await?;
        if sequence.unwrap_or_default() < maximum {
            bail!("SQLite id sequence for {table} is below the migrated maximum ({maximum})");
        }
    }
    let tag_link_maximum: i64 =
        sqlx::query_scalar(r#"SELECT COALESCE(MAX(id), 0) FROM "tagsToNote""#)
            .fetch_one(pool)
            .await?;
    let tag_link_sequence: i64 =
        sqlx::query_scalar(r#"SELECT value FROM "_blinkoraSequence" WHERE name='tagsToNote.id'"#)
            .fetch_one(pool)
            .await?;
    if tag_link_sequence < tag_link_maximum {
        bail!(
            "SQLite id sequence for tagsToNote is below the migrated maximum ({tag_link_maximum})"
        );
    }
    Ok(())
}

fn verify_local_attachment_files(
    data_dir: &Path,
    tables: &[(&TableSpec, Vec<Value>)],
) -> Result<()> {
    let (_, attachments) = tables
        .iter()
        .find(|(spec, _)| spec.name == "attachments")
        .context("attachment table is missing from migration plan")?;
    let mut hasher = Sha256::new();
    let mut verified = 0usize;
    for attachment in attachments {
        let object = attachment
            .as_object()
            .context("attachment row is not an object")?;
        if object.get("type").and_then(Value::as_str) == Some("folder") {
            continue;
        }
        let Some(path) = object.get("path").and_then(Value::as_str) else {
            continue;
        };
        let Some(relative) = path.strip_prefix("/api/file/") else {
            continue;
        };
        if relative.contains('\0') || relative.split('/').any(|part| part == "..") {
            bail!("local attachment path is unsafe");
        }
        let bytes = std::fs::read(data_dir.join("files").join(relative))
            .with_context(|| "referenced local attachment file is missing or unreadable")?;
        hasher.update(Sha256::digest(&bytes));
        verified += 1;
    }
    println!(
        "migration local_attachment_files={} sha256={}",
        verified,
        hex::encode(hasher.finalize())
    );
    Ok(())
}

fn parse_args() -> Result<Args> {
    let mut values = env::args().skip(1);
    let mut source_url = env::var("BLINKORA_POSTGRES_URL").unwrap_or_default();
    let mut data_dir = None;
    let mut snapshot_dir = None;
    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--source-url" => {
                source_url = values.next().context("--source-url requires a value")?
            }
            "--data-dir" => {
                data_dir = Some(PathBuf::from(
                    values.next().context("--data-dir requires a value")?,
                ))
            }
            "--snapshot-dir" => {
                snapshot_dir = Some(PathBuf::from(
                    values.next().context("--snapshot-dir requires a value")?,
                ))
            }
            "--help" | "-h" => {
                println!("Usage: blinkora-postgres-to-sqlite --source-url <postgres-url> --data-dir <blinkora-data-dir> [--snapshot-dir <path>]");
                std::process::exit(0);
            }
            _ => bail!("unknown argument {argument}"),
        }
    }
    if source_url.trim().is_empty() {
        bail!("--source-url or BLINKORA_POSTGRES_URL is required");
    }
    let data_dir = data_dir.context("--data-dir is required")?;
    let snapshot_dir = snapshot_dir.unwrap_or_else(|| data_dir.join("postgres-snapshots"));
    Ok(Args {
        source_url,
        data_dir,
        snapshot_dir,
    })
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn stage(name: &str) {
    println!("migration stage={name}");
}

async fn set_private_file(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(path).await?.permissions();
        permissions.set_mode(0o600);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

async fn set_private_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(path).await?.permissions();
        permissions.set_mode(0o700);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_plan_covers_every_runtime_table_once() {
        let names = TABLES.iter().map(|spec| spec.name).collect::<Vec<_>>();
        assert_eq!(names.len(), 14);
        for required in [
            "accounts",
            "workspaces",
            "notes",
            "tag",
            "tagsToNote",
            "attachments",
            "noteHistory",
            "noteReference",
            "comments",
            "config",
            "fonts",
            "agentAccessTokens",
            "operationLog",
            "cache",
        ] {
            assert_eq!(names.iter().filter(|name| **name == required).count(), 1);
        }
    }

    #[test]
    fn migration_plan_declares_every_timestamp_column() {
        for spec in TABLES {
            for column in spec.columns {
                if column.ends_with("At") {
                    assert!(
                        spec.timestamp_columns.contains(column),
                        "{}.{} is missing from timestamp_columns",
                        spec.name,
                        column
                    );
                }
            }
            for column in spec.timestamp_columns {
                assert!(
                    spec.columns.contains(column),
                    "{}.{} is not a source column",
                    spec.name,
                    column
                );
            }
        }
    }

    #[test]
    fn source_timestamps_are_normalized_to_utc_microseconds() {
        let spec = TABLES
            .iter()
            .find(|spec| spec.name == "agentAccessTokens")
            .unwrap();
        let mut row = serde_json::json!({
            "expiresAt": "2026-07-15T16:34:56.1234+08:00",
            "revokedAt": null,
            "lastUsedAt": "2026-07-14T23:59:59.999999-05:30",
            "createdAt": "2026-07-15T08:34:56Z",
            "updatedAt": "2026-07-15T08:34:56.123456Z"
        });

        normalize_source_row(spec, &mut row).unwrap();

        assert_eq!(
            row,
            serde_json::json!({
                "expiresAt": "2026-07-15T08:34:56.123400Z",
                "revokedAt": null,
                "lastUsedAt": "2026-07-15T05:29:59.999999Z",
                "createdAt": "2026-07-15T08:34:56.000000Z",
                "updatedAt": "2026-07-15T08:34:56.123456Z"
            })
        );
    }

    #[test]
    fn invalid_or_infinite_source_timestamps_block_migration() {
        let spec = TABLES.iter().find(|spec| spec.name == "notes").unwrap();
        for invalid in [
            serde_json::json!("not-a-timestamp"),
            serde_json::json!("infinity"),
            serde_json::json!(42),
        ] {
            let mut row = serde_json::json!({ "createdAt": invalid });
            let error = normalize_source_row(spec, &mut row).unwrap_err();
            assert!(error.to_string().contains("notes.createdAt"));
        }
    }

    #[test]
    fn canonical_hash_ignores_json_object_key_order_but_not_values() {
        let first: Value = serde_json::json!({"b": [2, {"z": true, "a": null}], "a": 1});
        let same: Value = serde_json::json!({"a": 1, "b": [2, {"a": null, "z": true}]});
        let different: Value = serde_json::json!({"a": 1, "b": [3, {"a": null, "z": true}]});
        assert_eq!(
            digest_rows("notes", &[first]).unwrap().sha256,
            digest_rows("notes", &[same.clone()]).unwrap().sha256
        );
        assert_ne!(
            digest_rows("notes", &[same]).unwrap().sha256,
            digest_rows("notes", &[different]).unwrap().sha256
        );
    }

    #[tokio::test]
    async fn temporary_sqlite_schema_preserves_json_blob_and_tag_link_ids() {
        let path = std::env::temp_dir().join(format!(
            "blinkora-migration-tool-test-{}.sqlite3",
            std::process::id()
        ));
        let _ = tokio::fs::remove_file(&path).await;
        let pool = open_temporary_sqlite(&path).await.unwrap();
        sqlx::raw_sql(SQLITE_SCHEMA).execute(&pool).await.unwrap();
        sqlx::query(
            r#"INSERT INTO accounts (id, name, nickname, password, role, "createdAt", "updatedAt")
               VALUES (7, 'owner', 'owner', 'hash', 'superadmin', '2026-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO workspaces (id, name, "accountId", "isDefault", "createdAt", "updatedAt")
               VALUES (9, 'main', 7, 1, '2026-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO notes (id, content, metadata, "accountId", "workspaceId", "createdAt", "updatedAt")
               VALUES (11, 'note', '{"properties":{"priority":2}}', 7, 9, '2026-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO tag (id, name, "accountId", "workspaceId", "createdAt", "updatedAt")
               VALUES (13, 'tag', 7, 9, '2026-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO "tagsToNote" (id, "noteId", "tagId") VALUES (29, 11, 13)"#)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO fonts (id, name, "displayName", "fileData", weights, "createdAt", "updatedAt")
               VALUES (17, 'font', 'Font', X'00FF', '[400]', '2026-01-01T00:00:00.000000Z', '2026-01-01T00:00:00.000000Z')"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let tag_link_id: i64 = sqlx::query_scalar("SELECT id FROM \"tagsToNote\"")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(tag_link_id, 29);
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE id = 29"#)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (11, 13)"#)
            .execute(&pool)
            .await
            .unwrap();
        let next_tag_link_id: i64 = sqlx::query_scalar("SELECT id FROM \"tagsToNote\"")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(next_tag_link_id, 30);
        let font_hex: String = sqlx::query_scalar("SELECT lower(hex(\"fileData\")) FROM fonts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(font_hex, "00ff");
        verify_sqlite(&pool).await.unwrap();
        pool.close().await;
        let _ = tokio::fs::remove_file(path).await;
    }
}
