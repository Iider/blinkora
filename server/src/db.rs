use anyhow::{bail, Context};
use libsqlite3_sys as ffi;
use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Row, SqlitePool,
};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SCHEMA_VERSION: i64 = 2;
const MAX_CONNECTIONS: u32 = 10;
const DATABASE_SENTINEL: &str = ".blinkora-sqlite-initialized";
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
    let sentinel_path = data_dir.as_ref().join(DATABASE_SENTINEL);
    if sentinel_path.exists() && !database_path.exists() {
        bail!(
            "SQLite database is missing from an initialized data directory: {}",
            database_path.display()
        );
    }
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
        .max_connections(MAX_CONNECTIONS)
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
        let mut tx = pool.begin().await?;
        sqlx::raw_sql(&sql)
            .execute(&mut *tx)
            .await
            .with_context(|| {
                format!(
                    "failed to initialize SQLite schema {}",
                    schema_path.display()
                )
            })?;
        sqlx::query(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        tracing::info!(schema = %schema_path.display(), "SQLite schema initialized");
    }

    ensure_schema_version(pool).await?;
    ensure_required_tables(pool).await?;
    probe(pool).await?;
    write_database_sentinel(pool).await?;
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
    let mut writable_probe = pool.begin().await?;
    let changed =
        sqlx::query(r#"UPDATE "_blinkoraHealth" SET "checkedAt"=blinkora_now() WHERE id=1"#)
            .execute(&mut *writable_probe)
            .await?
            .rows_affected();
    writable_probe.rollback().await?;
    if changed != 1 {
        bail!("SQLite writable probe did not find its sentinel row");
    }
    Ok(())
}

/// Encode a list for the `json_each($n)` membership patterns used by SQLite.
/// This avoids SQLite's bind-variable limit while keeping a single statement
/// and transaction for every bulk operation.
pub fn json_array<T: Serialize + ?Sized>(values: &T) -> String {
    serde_json::to_string(values).expect("serializing a JSON-compatible ID list cannot fail")
}

async fn register_json_functions(
    connection: &mut sqlx::SqliteConnection,
) -> Result<(), sqlx::Error> {
    let mut handle = connection.lock_handle().await?;
    let status = unsafe {
        ffi::sqlite3_create_function_v2(
            handle.as_raw_handle().as_ptr(),
            c"blinkora_json_contains".as_ptr(),
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
                c"blinkora_json_merge".as_ptr(),
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
                c"blinkora_now".as_ptr(),
                0,
                ffi::SQLITE_UTF8,
                std::ptr::null_mut(),
                Some(sqlite_now),
                None,
                None,
                None,
            )
        };
        if now_status != ffi::SQLITE_OK {
            return Err(sqlx::Error::Protocol(format!(
                "could not register Blinkora SQLite clock function (SQLite error {now_status})"
            )));
        }
        let timestamp_status = unsafe {
            ffi::sqlite3_create_function_v2(
                handle.as_raw_handle().as_ptr(),
                c"blinkora_timestamp_micros".as_ptr(),
                1,
                ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC,
                std::ptr::null_mut(),
                Some(sqlite_timestamp_micros),
                None,
                None,
                None,
            )
        };
        if timestamp_status != ffi::SQLITE_OK {
            return Err(sqlx::Error::Protocol(format!(
                "could not register Blinkora SQLite timestamp function (SQLite error {timestamp_status})"
            )));
        }
        let json_has_key_status = unsafe {
            ffi::sqlite3_create_function_v2(
                handle.as_raw_handle().as_ptr(),
                c"blinkora_json_has_key".as_ptr(),
                2,
                ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC,
                std::ptr::null_mut(),
                Some(sqlite_json_has_key),
                None,
                None,
                None,
            )
        };
        if json_has_key_status != ffi::SQLITE_OK {
            return Err(sqlx::Error::Protocol(format!(
                "could not register Blinkora SQLite JSON key function (SQLite error {json_has_key_status})"
            )));
        }
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "could not register Blinkora SQLite JSON function (SQLite error {status})"
        )))
    }
}

unsafe extern "C" fn sqlite_json_has_key(
    context: *mut ffi::sqlite3_context,
    argument_count: i32,
    arguments: *mut *mut ffi::sqlite3_value,
) {
    let result = std::panic::catch_unwind(|| {
        if argument_count != 2 || arguments.is_null() {
            return false;
        }
        let Some(candidate) = sqlite_json_argument(*arguments.offset(0)) else {
            return false;
        };
        let Some(expected) = sqlite_text_argument(*arguments.offset(1)) else {
            return false;
        };
        match candidate {
            serde_json::Value::Object(object) => object.contains_key(expected),
            serde_json::Value::Array(array) => {
                array.iter().any(|value| value.as_str() == Some(expected))
            }
            serde_json::Value::String(value) => value == expected,
            _ => false,
        }
    })
    .unwrap_or(false);
    ffi::sqlite3_result_int(context, i32::from(result));
}

unsafe extern "C" fn sqlite_timestamp_micros(
    context: *mut ffi::sqlite3_context,
    argument_count: i32,
    arguments: *mut *mut ffi::sqlite3_value,
) {
    if argument_count != 1 || arguments.is_null() {
        ffi::sqlite3_result_error_code(context, ffi::SQLITE_CONSTRAINT_FUNCTION);
        return;
    }
    let Some(value) = sqlite_text_argument(*arguments) else {
        ffi::sqlite3_result_null(context);
        return;
    };
    match chrono::DateTime::parse_from_rfc3339(value) {
        Ok(timestamp) => ffi::sqlite3_result_int64(context, timestamp.timestamp_micros()),
        Err(_) => {
            let message = b"invalid RFC 3339 timestamp";
            ffi::sqlite3_result_error(context, message.as_ptr().cast(), message.len() as i32);
        }
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
    let bytes = sqlite_bytes_argument(value)?;
    serde_json::from_slice(bytes).ok()
}

unsafe fn sqlite_text_argument<'a>(value: *mut ffi::sqlite3_value) -> Option<&'a str> {
    std::str::from_utf8(sqlite_bytes_argument(value)?).ok()
}

unsafe fn sqlite_bytes_argument<'a>(value: *mut ffi::sqlite3_value) -> Option<&'a [u8]> {
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
    Some(std::slice::from_raw_parts(
        text.cast::<u8>(),
        length as usize,
    ))
}

fn json_contains(candidate: &serde_json::Value, expected: &serde_json::Value) -> bool {
    if let (serde_json::Value::Array(candidate), expected) = (candidate, expected) {
        if !expected.is_array() && !expected.is_object() {
            return candidate
                .iter()
                .any(|value| json_contains_deep(value, expected));
        }
    }
    json_contains_deep(candidate, expected)
}

fn json_contains_deep(candidate: &serde_json::Value, expected: &serde_json::Value) -> bool {
    match (candidate, expected) {
        (serde_json::Value::Object(candidate), serde_json::Value::Object(expected)) => {
            expected.iter().all(|(key, expected)| {
                candidate
                    .get(key)
                    .is_some_and(|value| json_contains_deep(value, expected))
            })
        }
        (serde_json::Value::Array(candidate), serde_json::Value::Array(expected)) => {
            expected.iter().all(|expected| {
                candidate
                    .iter()
                    .any(|value| json_contains_deep(value, expected))
            })
        }
        (serde_json::Value::Number(candidate), serde_json::Value::Number(expected)) => {
            canonical_json_number(candidate) == canonical_json_number(expected)
        }
        _ => candidate == expected,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CanonicalJsonNumber {
    negative: bool,
    digits: String,
    exponent: i64,
}

fn canonical_json_number(number: &serde_json::Number) -> Option<CanonicalJsonNumber> {
    let text = number.to_string();
    let (negative, unsigned) = text
        .strip_prefix('-')
        .map_or((false, text.as_str()), |value| (true, value));
    let (mantissa, explicit_exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i64>().ok()?),
        None => (unsigned, 0),
    };
    let (integer, fraction) = mantissa
        .split_once('.')
        .map_or((mantissa, ""), |parts| parts);
    let mut digits = format!("{integer}{fraction}")
        .trim_start_matches('0')
        .to_string();
    if digits.is_empty() {
        return Some(CanonicalJsonNumber {
            negative: false,
            digits: "0".to_string(),
            exponent: 0,
        });
    }
    let fraction_length = i64::try_from(fraction.len()).ok()?;
    let mut exponent = explicit_exponent.checked_sub(fraction_length)?;
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
        exponent = exponent.checked_add(1)?;
    }
    Some(CanonicalJsonNumber {
        negative,
        digits,
        exponent,
    })
}

async fn schema_exists(pool: &SqlitePool) -> anyhow::Result<bool> {
    let exists: Option<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
            .fetch_optional(pool)
            .await?;
    Ok(exists.is_some())
}

async fn ensure_schema_version(pool: &SqlitePool) -> anyhow::Result<()> {
    let mut version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await?;
    if version > SCHEMA_VERSION {
        bail!(
            "SQLite schema version {version} is newer than this Blinkora release supports ({SCHEMA_VERSION})"
        );
    }
    if version == 1 {
        migrate_v1_to_v2(pool).await?;
        version = 2;
    }
    if version < SCHEMA_VERSION {
        bail!(
            "SQLite schema version {version} requires a migration that is not included in this release"
        );
    }
    Ok(())
}

async fn migrate_v1_to_v2(pool: &SqlitePool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::raw_sql(
        r#"
        DROP TRIGGER IF EXISTS "tagsToNote_assign_id";
        DROP TRIGGER IF EXISTS "tagsToNote_advance_id_sequence";

        CREATE TABLE IF NOT EXISTS "_blinkoraSequence" (
          name TEXT PRIMARY KEY NOT NULL,
          value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 2147483647)
        );

        INSERT INTO "_blinkoraSequence" (name, value)
        VALUES ('tagsToNote.id', (SELECT COALESCE(MAX(id), 0) FROM "tagsToNote"))
        ON CONFLICT (name) DO UPDATE SET value = MAX(
          "_blinkoraSequence".value,
          excluded.value
        );

        CREATE TABLE IF NOT EXISTS "_blinkoraHealth" (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          "checkedAt" TEXT NOT NULL
        );
        INSERT INTO "_blinkoraHealth" (id, "checkedAt")
        VALUES (1, blinkora_now())
        ON CONFLICT (id) DO NOTHING;

        CREATE TRIGGER "tagsToNote_advance_id_sequence"
        BEFORE INSERT ON "tagsToNote"
        FOR EACH ROW
        BEGIN
          UPDATE "_blinkoraSequence"
          SET value = CASE
            WHEN NEW.id = 0 THEN value + 1
            WHEN NEW.id > value THEN NEW.id
            ELSE value
          END
          WHERE name = 'tagsToNote.id';
        END;

        CREATE TRIGGER "tagsToNote_assign_id"
        AFTER INSERT ON "tagsToNote"
        FOR EACH ROW WHEN NEW.id = 0
        BEGIN
          UPDATE "tagsToNote"
          SET id = (
            SELECT value FROM "_blinkoraSequence" WHERE name = 'tagsToNote.id'
          )
          WHERE "noteId" = NEW."noteId" AND "tagId" = NEW."tagId";
        END;

        CREATE INDEX IF NOT EXISTS "workspaces_accountId_idx"
          ON workspaces ("accountId");
        CREATE INDEX IF NOT EXISTS "workspaces_isDefault_idx"
          ON workspaces ("isDefault");
        "#,
    )
    .execute(&mut *tx)
    .await
    .context("failed to upgrade SQLite schema from version 1 to 2")?;
    sqlx::query("PRAGMA user_version = 2")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(from = 1, to = 2, "SQLite schema upgraded");
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
    let mut connections = Vec::with_capacity(MAX_CONNECTIONS as usize);
    for _ in 0..MAX_CONNECTIONS {
        connections.push(pool.acquire().await?);
    }
    for connection in &mut connections {
        let foreign_keys: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&mut **connection)
            .await?;
        let busy_timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&mut **connection)
            .await?;
        let synchronous: i64 = sqlx::query_scalar("PRAGMA synchronous")
            .fetch_one(&mut **connection)
            .await?;
        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut **connection)
            .await?;
        if foreign_keys != 1 {
            bail!("SQLite foreign key enforcement is disabled on a pooled connection");
        }
        if busy_timeout < 5_000 {
            bail!("SQLite busy timeout is below 5000 ms on a pooled connection");
        }
        if synchronous != 2 {
            bail!("SQLite synchronous mode is not FULL on a pooled connection");
        }
        if !journal_mode.eq_ignore_ascii_case("wal") {
            bail!("SQLite WAL mode could not be enabled (actual mode: {journal_mode})");
        }
    }
    Ok(())
}

async fn write_database_sentinel(pool: &SqlitePool) -> anyhow::Result<()> {
    let row = sqlx::query("PRAGMA database_list").fetch_one(pool).await?;
    let database_file: String = row.try_get("file")?;
    let database_file = PathBuf::from(database_file);
    let data_dir = database_file
        .parent()
        .context("SQLite database path has no parent directory")?;
    let sentinel = data_dir.join(DATABASE_SENTINEL);
    tokio::fs::write(&sentinel, b"blinkora-sqlite\n")
        .await
        .with_context(|| {
            format!(
                "failed to write SQLite data sentinel {}",
                sentinel.display()
            )
        })?;
    set_private_file_permissions(&sentinel).await
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
        sqlx::query("PRAGMA user_version = 3")
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
    async fn refuses_to_recreate_a_missing_database_in_an_initialized_directory() {
        let (data_dir, pool) = initialized_pool("missing-database").await;
        pool.close().await;
        tokio::fs::remove_file(database_path(&data_dir))
            .await
            .expect("remove database fixture");

        let error = connect(&data_dir)
            .await
            .expect_err("an initialized data directory must never receive a silent empty database");
        assert!(error.to_string().contains("database is missing"));
        let _ = tokio::fs::remove_dir_all(data_dir).await;
    }

    #[tokio::test]
    async fn upgrades_v1_tag_link_sequence_without_rewriting_existing_ids() {
        let (data_dir, pool) = initialized_pool("upgrade-v1").await;
        sqlx::raw_sql(
            r#"
            INSERT INTO accounts (id, name, password, nickname, role, "updatedAt")
            VALUES (1, 'owner', 'hash', 'owner', 'superadmin', blinkora_now());
            INSERT INTO workspaces (id, name, "accountId", "isDefault")
            VALUES (1, 'main', 1, true);
            INSERT INTO notes (id, content, "updatedAt", "accountId", "workspaceId")
            VALUES (1, 'one', blinkora_now(), 1, 1), (2, 'two', blinkora_now(), 1, 1);
            INSERT INTO tag (id, name, "updatedAt", "accountId", "workspaceId")
            VALUES (1, 'one', blinkora_now(), 1, 1), (2, 'two', blinkora_now(), 1, 1);
            INSERT INTO "tagsToNote" (id, "noteId", "tagId") VALUES (41, 1, 1);

            DROP TRIGGER "tagsToNote_assign_id";
            DROP TRIGGER "tagsToNote_advance_id_sequence";
            DROP TABLE "_blinkoraSequence";
            CREATE TRIGGER "tagsToNote_assign_id"
            AFTER INSERT ON "tagsToNote"
            FOR EACH ROW WHEN NEW.id = 0
            BEGIN
              UPDATE "tagsToNote"
              SET id = (SELECT COALESCE(MAX(id), 0) + 1 FROM "tagsToNote")
              WHERE rowid = NEW.rowid;
            END;
            PRAGMA user_version = 1;
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool.close().await;

        let upgraded = connect(&data_dir).await.unwrap();
        init_schema(
            &upgraded,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect("upgrade schema v1 to v2");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA user_version")
                .fetch_one(&upgraded)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT value FROM "_blinkoraSequence" WHERE name='tagsToNote.id'"#,
            )
            .fetch_one(&upgraded)
            .await
            .unwrap(),
            41
        );

        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE id=41"#)
            .execute(&upgraded)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (2, 2)"#)
            .execute(&upgraded)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT id FROM "tagsToNote" WHERE "noteId"=2 AND "tagId"=2"#,
            )
            .fetch_one(&upgraded)
            .await
            .unwrap(),
            42
        );
        cleanup(data_dir, upgraded).await;
    }

    #[tokio::test]
    async fn json_containment_preserves_nested_json_semantics() {
        let (data_dir, pool) = initialized_pool("json").await;
        let matches: i64 = sqlx::query_scalar(
            "SELECT blinkora_json_contains($1, $2)",
        )
        .bind(r#"{"state":"open","score":2,"nested":{"rank":2,"label":"ready"},"flags":["a","b"],"active":true,"disabled":false,"empty":null}"#)
        .bind(r#"{"state":"open","score":2,"nested":{"rank":2,"label":"ready"},"flags":["b"],"active":true,"disabled":false,"empty":null}"#)
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

        let absent_array_member: i64 = sqlx::query_scalar("SELECT blinkora_json_contains($1, $2)")
            .bind(r#"{"flags":["a","b"]}"#)
            .bind(r#"{"flags":["missing"]}"#)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(absent_array_member, 0);

        let top_level_array_contains_scalar: i64 =
            sqlx::query_scalar("SELECT blinkora_json_contains($1, $2)")
                .bind(r#"["a","b"]"#)
                .bind(r#""a""#)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(top_level_array_contains_scalar, 1);

        let nested_array_does_not_contain_scalar: i64 =
            sqlx::query_scalar("SELECT blinkora_json_contains($1, $2)")
                .bind(r#"{"flags":["a","b"]}"#)
                .bind(r#"{"flags":"a"}"#)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(nested_array_does_not_contain_scalar, 0);

        let equivalent_number_formats: i64 =
            sqlx::query_scalar("SELECT blinkora_json_contains($1, $2)")
                .bind("1")
                .bind("1.0")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(equivalent_number_formats, 1);

        let distinct_large_numbers: i64 =
            sqlx::query_scalar("SELECT blinkora_json_contains($1, $2)")
                .bind("9007199254740993.0")
                .bind("9007199254740992")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(distinct_large_numbers, 0);

        for (candidate, key, expected) in [
            (r#"["content",1,true,null,{"content":true}]"#, "content", 1),
            (r#"{"content":true,"value":"content"}"#, "content", 1),
            (r#""content""#, "content", 1),
            (r#"[1]"#, "1", 0),
            (r#"{"value":"content"}"#, "content", 0),
        ] {
            let actual: i64 = sqlx::query_scalar("SELECT blinkora_json_has_key($1, $2)")
                .bind(candidate)
                .bind(key)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(actual, expected, "candidate={candidate} key={key}");
        }

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
    async fn timestamp_comparison_preserves_offsets_and_single_microseconds() {
        let (data_dir, pool) = initialized_pool("timestamp-micros").await;
        let one_microsecond: i64 = sqlx::query_scalar(
            "SELECT blinkora_timestamp_micros($1) - blinkora_timestamp_micros($2)",
        )
        .bind("2026-07-15T12:00:00.000001Z")
        .bind("2026-07-15T12:00:00.000000Z")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(one_microsecond, 1);

        let offset_equivalent: i64 = sqlx::query_scalar(
            "SELECT blinkora_timestamp_micros($1) = blinkora_timestamp_micros($2)",
        )
        .bind("2026-07-15T20:00:00+08:00")
        .bind("2026-07-15T12:00:00Z")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(offset_equivalent, 1);

        let invalid = sqlx::query_scalar::<_, i64>("SELECT blinkora_timestamp_micros($1)")
            .bind("not-a-timestamp")
            .fetch_one(&pool)
            .await
            .expect_err("invalid timestamps must fail instead of silently missing rows");
        assert!(invalid.to_string().contains("invalid RFC 3339 timestamp"));
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
    async fn failed_transaction_rolls_back_foreign_key_violation() {
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

    #[tokio::test]
    async fn tag_link_ids_preserve_migrated_values_and_never_reuse_a_deleted_maximum() {
        let (data_dir, pool) = initialized_pool("tag-link-sequence").await;
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
        sqlx::query(
            r#"WITH RECURSIVE ids(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 6
               )
               INSERT INTO notes (id, content, "updatedAt", "accountId", "workspaceId")
               SELECT id, 'note-' || id, blinkora_now(), 1, 1 FROM ids"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"WITH RECURSIVE ids(id) AS (
                 SELECT 1 UNION ALL SELECT id + 1 FROM ids WHERE id < 6
               )
               INSERT INTO tag (id, name, "updatedAt", "accountId", "workspaceId")
               SELECT id, 'tag-' || id, blinkora_now(), 1, 1 FROM ids"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (1, 1), (2, 2)"#)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO "tagsToNote" (id, "noteId", "tagId") VALUES (41, 3, 3)"#)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT id FROM "tagsToNote" WHERE "noteId" = 3 AND "tagId" = 3"#,
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            41
        );

        let ignored_duplicate = sqlx::query(
            r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (1, 1)
               ON CONFLICT DO NOTHING"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(ignored_duplicate.rows_affected(), 0);

        let duplicate_error =
            sqlx::query(r#"INSERT INTO "tagsToNote" (id, "noteId", "tagId") VALUES (99, 3, 3)"#)
                .execute(&pool)
                .await
                .expect_err("the source composite primary key must remain authoritative");
        assert!(duplicate_error
            .to_string()
            .contains("UNIQUE constraint failed"));

        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE id = 41"#)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (4, 4)"#)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT id FROM "tagsToNote" WHERE "noteId" = 4 AND "tagId" = 4"#,
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            43
        );

        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE id = 43"#)
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;

        let reopened = connect(&data_dir).await.expect("reopen SQLite");
        init_schema(
            &reopened,
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../db/schema.sqlite.sql"),
        )
        .await
        .expect("validate existing SQLite schema");
        sqlx::query(r#"INSERT INTO "tagsToNote" ("noteId", "tagId") VALUES (5, 5)"#)
            .execute(&reopened)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                r#"SELECT id FROM "tagsToNote" WHERE "noteId" = 5 AND "tagId" = 5"#,
            )
            .fetch_one(&reopened)
            .await
            .unwrap(),
            44
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                r#"SELECT group_concat(name || ':' || pk, ',') FROM (
                     SELECT name, pk FROM pragma_table_info('tagsToNote')
                     WHERE pk > 0 ORDER BY pk
                   )"#,
            )
            .fetch_one(&reopened)
            .await
            .unwrap(),
            "noteId:1,tagId:2"
        );
        probe(&reopened).await.unwrap();
        cleanup(data_dir, reopened).await;
    }
}
