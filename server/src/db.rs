use anyhow::{bail, Context};
use libsqlite3_sys as ffi;
use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    SqlitePool,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SCHEMA_VERSION: i64 = 1;
const REQUIRED_TABLES: &[&str] = &[
    "accounts",
    "agentAccessTokens",
    "attachments",
    "cache",
    "comments",
    "config",
    "fonts",
    "noteHistory",
    "noteReference",
    "operationLog",
    "notes",
    "tag",
    "tagsToNote",
    "workspaces",
];

/// SQLite accepts only one writer. WAL plus this timeout gives the pool a
/// bounded, retryable wait instead of surfacing transient writer contention as
/// an immediate API failure. These pragmas are intentionally established for
/// every connection, not only the connection that created the database.
pub async fn connect(data_dir: impl AsRef<Path>) -> anyhow::Result<SqlitePool> {
    let database_path = database_path(data_dir.as_ref());
    prepare_data_dir(data_dir.as_ref()).await?;

    if database_path.exists() && database_path.is_dir() {
        bail!(
            "SQLite database path is a directory: {}",
            database_path.display()
        );
    }

    let options = SqliteConnectOptions::new()
        .filename(&database_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(5));

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(10))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("PRAGMA foreign_keys = ON")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("PRAGMA busy_timeout = 5000")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("PRAGMA synchronous = FULL")
                    .execute(&mut *connection)
                    .await?;
                register_json_functions(connection).await?;
                Ok(())
            })
        })
        .connect_with(options)
        .await
        .context("SQLite database connection failed")?;

    set_private_file_permissions(&database_path).await?;
    verify_connection_pragmas(&pool).await?;
    Ok(pool)
}

pub fn database_path(data_dir: &Path) -> PathBuf {
    data_dir.join("blinkora.sqlite3")
}

pub async fn init_schema(pool: &SqlitePool, schema_path: impl AsRef<Path>) -> anyhow::Result<()> {
    let table_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_one(pool)
    .await?;

    if !schema_exists(pool).await? {
        if table_count != 0 {
            bail!(
                "SQLite database contains tables but is not a Blinkora database; refusing to create an empty schema over existing data"
            );
        }
        let schema_path = schema_path.as_ref();
        let sql = tokio::fs::read_to_string(schema_path)
            .await
            .with_context(|| format!("failed to read SQLite schema {}", schema_path.display()))?;
        sqlx::raw_sql(&sql).execute(pool).await.with_context(|| {
            format!(
                "failed to initialize SQLite schema {}",
                schema_path.display()
            )
        })?;
        sqlx::query(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .execute(pool)
            .await?;
        tracing::info!(schema = %schema_path.display(), "SQLite schema initialized");
    }

    ensure_schema_version(pool).await?;
    ensure_required_tables(pool).await?;
    probe(pool).await?;
    Ok(())
}

pub async fn probe(pool: &SqlitePool) -> anyhow::Result<()> {
    let one: i64 = sqlx::query_scalar("SELECT 1").fetch_one(pool).await?;
    if one != 1 {
        bail!("SQLite probe returned an unexpected value");
    }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await?;
    if integrity != "ok" {
        bail!("SQLite integrity check failed: {integrity}");
    }
    let foreign_key_violations: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM pragma_foreign_key_check")
            .fetch_one(pool)
            .await?;
    if foreign_key_violations != 0 {
        bail!("SQLite foreign-key check found {foreign_key_violations} violation(s)");
    }
    Ok(())
}

/// Encode a list for the `json_each($n)` membership patterns used by SQLite.
/// This avoids SQLite's bind-variable limit while keeping a single statement
/// and transaction for every bulk operation.
pub fn json_array<T: Serialize>(values: &T) -> String {
    serde_json::to_string(values).expect("serializing a JSON-compatible ID list cannot fail")
}

async fn register_json_functions(
    connection: &mut sqlx::SqliteConnection,
) -> Result<(), sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    let status = unsafe {
        ffi::sqlite3_create_function_v2(
            handle.as_raw_handle().as_ptr(),
            b"blinkora_json_contains\0".as_ptr().cast(),
            2,
            ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC,
            std::ptr::null_mut(),
            Some(sqlite_json_contains),
            None,
            None,
            None,
        )
    };
    if status == ffi::SQLITE_OK {
        let merge_status = unsafe {
            ffi::sqlite3_create_function_v2(
                handle.as_raw_handle().as_ptr(),
                b"blinkora_json_merge\0".as_ptr().cast(),
                2,
                ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC,
                std::ptr::null_mut(),
                Some(sqlite_json_merge),
                None,
                None,
                None,
            )
        };
        if merge_status != ffi::SQLITE_OK {
            return Err(sqlx::Error::Protocol(format!(
                "could not register Blinkora SQLite JSON merge function (SQLite error {merge_status})"
            )));
        }
        let now_status = unsafe {
            ffi::sqlite3_create_function_v2(
                handle.as_raw_handle().as_ptr(),
                b"blinkora_now\0".as_ptr().cast(),
                0,
                ffi::SQLITE_UTF8,
                std::ptr::null_mut(),
                Some(sqlite_now),
                None,
                None,
                None,
            )
        };
        if now_status == ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(sqlx::Error::Protocol(format!(
                "could not register Blinkora SQLite clock function (SQLite error {now_status})"
            )))
        }
    } else {
        Err(sqlx::Error::Protocol(format!(
            "could not register Blinkora SQLite JSON function (SQLite error {status})"
        )))
    }
}

unsafe extern "C" fn sqlite_now(
    context: *mut ffi::sqlite3_context,
    argument_count: i32,
    _: *mut *mut ffi::sqlite3_value,
) {
    if argument_count != 0 {
        unsafe { ffi::sqlite3_result_error_code(context, ffi::SQLITE_CONSTRAINT_FUNCTION) };
        return;
    }
    let value = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    unsafe {
        ffi::sqlite3_result_text(
            context,
            value.as_ptr().cast(),
            value.len() as i32,
            ffi::SQLITE_TRANSIENT(),
        )
    };
}

/// SQLite's JSON1 extension deliberately does not provide a native JSON
/// containment operator. Keeping the comparison in one deterministic function
/// preserves nested object, array, scalar, boolean, and null filtering without
/// introducing a second search implementation or an FTS dependency.
unsafe extern "C" fn sqlite_json_contains(
    context: *mut ffi::sqlite3_context,
    argument_count: i32,
    arguments: *mut *mut ffi::sqlite3_value,
) {
    let result = std::panic::catch_unwind(|| {
        if argument_count != 2 || arguments.is_null() {
            return false;
        }
        let candidate = sqlite_json_argument(*arguments.offset(0));
        let expected = sqlite_json_argument(*arguments.offset(1));
        match (candidate, expected) {
            (Some(candidate), Some(expected)) => json_contains(&candidate, &expected),
            _ => false,
        }
    })
    .unwrap_or(false);
    ffi::sqlite3_result_int(context, i32::from(result));
}

/// Mirrors the former database's object-concatenation behavior for comment
/// metadata updates:
/// object keys are merged one level deep, while arrays and scalars are
/// concatenated as JSON values. SQLite's json_patch is recursive and would
/// silently change nested metadata semantics.
unsafe extern "C" fn sqlite_json_merge(
    context: *mut ffi::sqlite3_context,
    argument_count: i32,
    arguments: *mut *mut ffi::sqlite3_value,
) {
    let result = std::panic::catch_unwind(|| {
        if argument_count != 2 || arguments.is_null() {
            return None;
        }
        let left = sqlite_json_argument(*arguments.offset(0))?;
        let right = sqlite_json_argument(*arguments.offset(1))?;
        let merged = match (left, right) {
            (serde_json::Value::Object(mut left), serde_json::Value::Object(right)) => {
                left.extend(right);
                serde_json::Value::Object(left)
            }
            (serde_json::Value::Array(mut left), serde_json::Value::Array(right)) => {
                left.extend(right);
                serde_json::Value::Array(left)
            }
            (serde_json::Value::Array(mut left), right) => {
                left.push(right);
                serde_json::Value::Array(left)
            }
            (left, serde_json::Value::Array(mut right)) => {
                let mut merged = vec![left];
                merged.append(&mut right);
                serde_json::Value::Array(merged)
            }
            (left, right) => serde_json::Value::Array(vec![left, right]),
        };
        serde_json::to_string(&merged).ok()
    })
    .ok()
    .flatten();

    if let Some(result) = result {
        ffi::sqlite3_result_text(
            context,
            result.as_ptr().cast(),
            result.len() as i32,
            ffi::SQLITE_TRANSIENT(),
        );
    } else {
        ffi::sqlite3_result_null(context);
    }
}

unsafe fn sqlite_json_argument(value: *mut ffi::sqlite3_value) -> Option<serde_json::Value> {
    if value.is_null() || ffi::sqlite3_value_type(value) == ffi::SQLITE_NULL {
        return None;
    }
    let text = ffi::sqlite3_value_text(value);
    if text.is_null() {
        return None;
    }
    let length = ffi::sqlite3_value_bytes(value);
    if length < 0 {
        return None;
    }
    let bytes = std::slice::from_raw_parts(text.cast::<u8>(), length as usize);
    serde_json::from_slice(bytes).ok()
}

fn json_contains(candidate: &serde_json::Value, expected: &serde_json::Value) -> bool {
    match (candidate, expected) {
        (serde_json::Value::Object(candidate), serde_json::Value::Object(expected)) => {
            expected.iter().all(|(key, expected)| {
                candidate
                    .get(key)
                    .is_some_and(|value| json_contains(value, expected))
            })
        }
        (serde_json::Value::Array(candidate), serde_json::Value::Array(expected)) => expected
            .iter()
            .all(|expected| candidate.iter().any(|value| json_contains(value, expected))),
        (serde_json::Value::Number(candidate), serde_json::Value::Number(expected)) => {
            candidate.as_f64() == expected.as_f64()
        }
        _ => candidate == expected,
    }
}

async fn schema_exists(pool: &SqlitePool) -> anyhow::Result<bool> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
            .fetch_optional(pool)
            .await?;
    Ok(exists.is_some())
}

async fn ensure_schema_version(pool: &SqlitePool) -> anyhow::Result<()> {
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    if version > SCHEMA_VERSION {
        bail!(
            "SQLite schema version {version} is newer than this Blinkora release supports ({SCHEMA_VERSION})"
        );
    }
    if version < SCHEMA_VERSION {
        bail!(
            "SQLite schema version {version} requires a migration that is not included in this release"
        );
    }
    Ok(())
}

async fn ensure_required_tables(pool: &SqlitePool) -> anyhow::Result<()> {
    for table in REQUIRED_TABLES {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name=$1")
                .bind(table)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            bail!("SQLite schema is missing required table {table}");
        }
    }
    Ok(())
}

async fn verify_connection_pragmas(pool: &SqlitePool) -> anyhow::Result<()> {
    let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
        .fetch_one(pool)
        .await?;
    if foreign_keys != 1 {
        bail!("SQLite foreign key enforcement is disabled");
    }
    let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(pool)
        .await?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        bail!("SQLite WAL mode could not be enabled (actual mode: {journal_mode})");
    }
    Ok(())
}

async fn prepare_data_dir(data_dir: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(data_dir)
        .await
        .with_context(|| format!("failed to create data directory {}", data_dir.display()))?;
    set_private_directory_permissions(data_dir).await
}

async fn set_private_file_permissions(path: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(path).await?.permissions();
        permissions.set_mode(0o600);
        tokio::fs::set_permissions(path, permissions).await?;
    }
    Ok(())
}

async fn set_private_directory_permissions(path: &Path) -> anyhow::Result<()> {
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
    use sqlx::Row;

    fn test_data_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("blinkora-sqlite-{name}-{}", uuid::Uuid::new_v4()))
    }

    async fn initialized_pool(name: &str) -> (PathBuf, SqlitePool) {
        let data_dir = test_data_dir(name);
        let pool = connect(&data_dir).await.expect("connect SQLite");
        init_schema(
            &pool,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect("initialize SQLite schema");
        (data_dir, pool)
    }

    async fn cleanup(data_dir: PathBuf, pool: SqlitePool) {
        pool.close().await;
        let _ = tokio::fs::remove_dir_all(data_dir).await;
    }

    #[tokio::test]
    async fn initializes_a_private_wal_database_and_can_restart() {
        let (data_dir, pool) = initialized_pool("initialize").await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA foreign_keys")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA journal_mode")
                .fetch_one(&pool)
                .await
                .unwrap()
                .to_ascii_lowercase(),
            "wal"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA busy_timeout")
                .fetch_one(&pool)
                .await
                .unwrap(),
            5_000
        );
        probe(&pool).await.expect("healthy initialized database");
        pool.close().await;

        let reopened = connect(&data_dir).await.expect("reopen SQLite");
        init_schema(
            &reopened,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect("repeat schema initialization");
        probe(&reopened).await.expect("healthy reopened database");
        cleanup(data_dir, reopened).await;
    }

    #[tokio::test]
    async fn refuses_unknown_databases_and_newer_schema_versions() {
        let unknown_dir = test_data_dir("unknown");
        let unknown_pool = connect(&unknown_dir).await.unwrap();
        sqlx::query("CREATE TABLE external_data (id INTEGER PRIMARY KEY)")
            .execute(&unknown_pool)
            .await
            .unwrap();
        let unknown_error = init_schema(
            &unknown_pool,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect_err("unknown nonempty database must not be adopted");
        assert!(unknown_error.to_string().contains("refusing to create"));
        cleanup(unknown_dir, unknown_pool).await;

        let (version_dir, version_pool) = initialized_pool("future-version").await;
        sqlx::query("PRAGMA user_version = 2")
            .execute(&version_pool)
            .await
            .unwrap();
        let version_error = init_schema(
            &version_pool,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect_err("newer SQLite schema must be rejected");
        assert!(version_error.to_string().contains("newer"));
        cleanup(version_dir, version_pool).await;
    }

    #[tokio::test]
    async fn json_containment_preserves_nested_json_semantics() {
        let (data_dir, pool) = initialized_pool("json").await;
        let matches: i64 = sqlx::query_scalar(
            "SELECT blinkora_json_contains($1, $2)",
        )
        .bind(r#"{"state":"open","nested":{"rank":2},"flags":["a","b"],"active":true,"empty":null}"#)
        .bind(r#"{"nested":{"rank":2},"flags":["b"],"active":true,"empty":null}"#)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(matches, 1);

        let does_not_match: i64 = sqlx::query_scalar("SELECT blinkora_json_contains($1, $2)")
            .bind(r#"{"nested":{"rank":2}}"#)
            .bind(r#"{"nested":{"rank":3}}"#)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(does_not_match, 0);

        let merged: String = sqlx::query_scalar("SELECT blinkora_json_merge($1, $2)")
            .bind(r#"{"nested":{"left":true},"keep":"old"}"#)
            .bind(r#"{"nested":{"right":true},"keep":"new"}"#)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&merged).unwrap(),
            serde_json::json!({ "nested": { "right": true }, "keep": "new" })
        );
        cleanup(data_dir, pool).await;
    }

    #[tokio::test]
    async fn bulk_json_membership_handles_more_than_two_thousand_ids() {
        let (data_dir, pool) = initialized_pool("bulk").await;
        sqlx::query(
            r#"INSERT INTO accounts (name, password, nickname, role, "updatedAt")
               VALUES ('bulk', 'hash', 'bulk', 'superadmin', blinkora_now())"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO workspaces (name, "accountId", "isDefault") VALUES ('bulk', 1, true)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"WITH RECURSIVE ids(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 2_100
               )
               INSERT INTO notes (id, content, "updatedAt", "accountId", "workspaceId")
               SELECT id, 'bulk', blinkora_now(), 1, 1 FROM ids"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let ids: Vec<i32> = (1..=2_100).collect();
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notes WHERE id IN (SELECT value FROM json_each($1))",
        )
        .bind(json_array(&ids))
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 2_100);
        probe(&pool).await.unwrap();
        cleanup(data_dir, pool).await;
    }

    #[tokio::test]
    async fn failed_transaction_rolls_back_and_tag_link_ids_keep_advancing() {
        let (data_dir, pool) = initialized_pool("constraints").await;
        sqlx::query(
            r#"INSERT INTO accounts (name, password, nickname, role, "updatedAt")
               VALUES ('owner', 'hash', 'owner', 'superadmin', blinkora_now())"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO workspaces (name, "accountId", "isDefault") VALUES ('main', 1, true)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO notes (content, "updatedAt", "accountId", "workspaceId") VALUES ('n', blinkora_now(), 1, 1)"#)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO tag (name, "updatedAt", "accountId", "workspaceId") VALUES ('t', blinkora_now(), 1, 1)"#)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (1, 1)"#)
            .execute(&pool)
            .await
            .unwrap();
        let first_link_id: i64 = sqlx::query("SELECT id FROM \"tagsToNote\"")
            .fetch_one(&pool)
            .await
            .unwrap()
            .get("id");
        assert_eq!(first_link_id, 1);

        let mut transaction = pool.begin().await.unwrap();
        let error = sqlx::query(
            r#"INSERT INTO comments (content, "noteId", "updatedAt") VALUES ('invalid', 99, blinkora_now())"#,
        )
        .execute(&mut *transaction)
        .await
        .expect_err("foreign key must reject orphan comment");
        assert!(error.to_string().contains("FOREIGN KEY"));
        transaction.rollback().await.unwrap();
        let comments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM comments")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(comments, 0);
        probe(&pool).await.unwrap();
        cleanup(data_dir, pool).await;
    }
}
