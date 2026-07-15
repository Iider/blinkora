use crate::trpc::ProcedureContext;
use anyhow::anyhow;
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};

pub async fn workspace_id(ctx: &ProcedureContext) -> anyhow::Result<i32> {
    let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
    if let Some(id) = user.workspace_id {
        return Ok(id);
    }
    if let Some(id) = sqlx::query_scalar::<_, i32>(
        r#"SELECT id FROM workspaces WHERE "accountId"=$1 AND "isDefault"=true"#,
    )
    .bind(user.id)
    .fetch_optional(ctx.state.pool())
    .await?
    {
        return Ok(id);
    }
    sqlx::query_scalar::<_, i32>(
        r#"SELECT id FROM workspaces WHERE "accountId"=$1 ORDER BY id ASC LIMIT 1"#,
    )
    .bind(user.id)
    .fetch_optional(ctx.state.pool())
    .await?
    .ok_or_else(|| anyhow!("workspace not found"))
}

pub fn tag_json(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "icon": row.get::<String, _>("icon"),
        "parent": row.get::<i32, _>("parent"),
        "accountId": row.get::<Option<i32>, _>("accountId"),
        "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
        "sortOrder": row.get::<i32, _>("sortOrder"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
    })
}

pub fn attachment_json(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "path": row.get::<String, _>("path"),
        "size": row.get::<String, _>("size"),
        "type": row.get::<String, _>("type"),
        "noteId": row.get::<Option<i32>, _>("noteId"),
        "accountId": row.get::<Option<i32>, _>("accountId"),
        "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
        "sortOrder": row.get::<i32, _>("sortOrder"),
        "perfixPath": row.get::<Option<String>, _>("perfixPath"),
        "depth": row.get::<Option<i32>, _>("depth"),
        "metadata": row.get::<Option<Value>, _>("metadata"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
    })
}

pub async fn account_brief(ctx: &ProcedureContext, account_id: i32) -> Value {
    match sqlx::query("SELECT name, nickname, image FROM accounts WHERE id=$1")
        .bind(account_id)
        .fetch_optional(ctx.state.pool())
        .await
    {
        Ok(Some(row)) => json!({
            "name": row.get::<String, _>("name"),
            "nickname": row.get::<String, _>("nickname"),
            "image": row.get::<String, _>("image")
        }),
        _ => Value::Null,
    }
}

async fn load_note_tags_with_connection(
    connection: &mut SqliteConnection,
    note_id: i32,
) -> anyhow::Result<Vec<Value>> {
    let rows = sqlx::query(
        r#"SELECT t.id, t.name, t.icon, t.parent, t."accountId", t."workspaceId", t."sortOrder", t."createdAt", t."updatedAt"
           FROM "tagsToNote" ttn JOIN tag t ON ttn."tagId"=t.id
           WHERE ttn."noteId"=$1 ORDER BY t.parent ASC, t."sortOrder" ASC, t.id ASC"#,
    )
    .bind(note_id)
    .fetch_all(connection)
    .await?;
    Ok(rows.into_iter().map(tag_json).collect())
}

async fn load_note_attachments_with_connection(
    connection: &mut SqliteConnection,
    note_id: i32,
) -> anyhow::Result<Vec<Value>> {
    let rows = sqlx::query(
        r#"SELECT id, name, path, CAST(size AS TEXT) AS size, type, "noteId", "accountId", "workspaceId", "sortOrder", "perfixPath", depth, metadata, "createdAt", "updatedAt"
           FROM attachments WHERE "noteId"=$1 ORDER BY "sortOrder" ASC, id ASC"#,
    )
    .bind(note_id)
    .fetch_all(connection)
    .await?;
    Ok(rows.into_iter().map(attachment_json).collect())
}

pub async fn note_json(
    ctx: &ProcedureContext,
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<Value> {
    let mut connection = ctx.state.pool().acquire().await?;
    note_json_with_connection(row, &mut connection).await
}

pub(crate) async fn note_json_with_connection(
    row: sqlx::sqlite::SqliteRow,
    connection: &mut SqliteConnection,
) -> anyhow::Result<Value> {
    let id = row.get::<i32, _>("id");
    let account_id = row.get::<Option<i32>, _>("accountId").unwrap_or_default();
    let workspace_id = row.get::<Option<i32>, _>("workspaceId").unwrap_or_default();
    let is_recycle = row.get::<bool, _>("isRecycle");
    let (references, referenced_by) = crate::handlers::notes::note_references_json_with_connection(
        connection,
        id,
        account_id,
        workspace_id,
        is_recycle,
    )
    .await?;
    let tags = load_note_tags_with_connection(connection, id).await?;
    let attachments = load_note_attachments_with_connection(connection, id).await?;
    let account = match sqlx::query("SELECT name, nickname, image FROM accounts WHERE id=$1")
        .bind(account_id)
        .fetch_optional(&mut *connection)
        .await?
    {
        Some(account) => json!({
            "name": account.get::<String, _>("name"),
            "nickname": account.get::<String, _>("nickname"),
            "image": account.get::<String, _>("image")
        }),
        None => Value::Null,
    };
    Ok(json!({
        "id": id,
        "type": row.get::<i32, _>("type"),
        "content": row.get::<String, _>("content"),
        "isArchived": row.get::<bool, _>("isArchived"),
        "isRecycle": is_recycle,
        "isTop": row.get::<bool, _>("isTop"),
        "isReviewed": row.get::<bool, _>("isReviewed"),
        "metadata": row.get::<Option<Value>, _>("metadata"),
        "accountId": row.get::<Option<i32>, _>("accountId"),
        "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
        "sortOrder": row.get::<i32, _>("sortOrder"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt"),
        "tags": tags,
        "attachments": attachments,
        "references": references,
        "referencedBy": referenced_by,
        "account": account
    }))
}
