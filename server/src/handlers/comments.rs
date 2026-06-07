use super::common::{account_brief, note_json, workspace_id};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("comments.list", list);
    registry.insert("comments.create", create);
    registry.insert("comments.update", update);
    registry.insert("comments.delete", delete);
    registry.insert("comments.convertToTodo", convert_to_todo);
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let note_id = input.get("noteId").and_then(Value::as_i64).unwrap_or_default() as i32;
        let exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM notes WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(note_id)
            .bind(user.id)
            .bind(ws)
            .fetch_optional(ctx.state.pool())
            .await?;
        if exists.is_none() {
            bail!("note not found");
        }
        let rows = sqlx::query(&comment_select_sql(r#""noteId"=$1 AND "parentId" IS NULL ORDER BY "createdAt" ASC, id ASC"#))
            .bind(note_id)
            .fetch_all(ctx.state.pool())
            .await?;
        let mut items = Vec::new();
        for row in rows {
            items.push(comment_json(&ctx, row, true).await?);
        }
        Ok(Value::Array(items))
    }
    .boxed()
}

fn create(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let note_id = input.get("noteId").and_then(Value::as_i64).unwrap_or_default() as i32;
        let content = input.get("content").and_then(Value::as_str).unwrap_or("");
        let kind = input.get("kind").and_then(Value::as_str).unwrap_or("annotation");
        let parent_id = input.get("parentId").and_then(Value::as_i64).map(|v| v as i32);
        let metadata = input.get("metadata").cloned();
        let exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM notes WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(note_id)
            .bind(user.id)
            .bind(ws)
            .fetch_optional(ctx.state.pool())
            .await?;
        if exists.is_none() {
            bail!("note not found");
        }
        if let Some(parent_id) = parent_id {
            let parent_note: Option<i32> = sqlx::query_scalar(r#"SELECT "noteId" FROM comments WHERE id=$1"#)
                .bind(parent_id)
                .fetch_optional(ctx.state.pool())
                .await?;
            if parent_note != Some(note_id) {
                bail!("reply parent must belong to the same note");
            }
        }
        let row = sqlx::query(
            r#"INSERT INTO comments (content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "updatedAt")
               VALUES ($1,$2,'open',$3,$4,$5,$6,$7,NOW())
               RETURNING id, content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "createdAt", "updatedAt""#,
        )
        .bind(content)
        .bind(kind)
        .bind(metadata)
        .bind(user.id)
        .bind(note_id)
        .bind(ws)
        .bind(parent_id)
        .fetch_one(ctx.state.pool())
        .await?;
        Ok(comment_json(&ctx, row, false).await?)
    }
    .boxed()
}

fn update(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let exists: Option<i32> = sqlx::query_scalar(
            r#"SELECT c.id FROM comments c JOIN notes n ON c."noteId"=n.id WHERE c.id=$1 AND n."accountId"=$2 AND c."workspaceId"=$3"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .fetch_optional(ctx.state.pool())
        .await?;
        if exists.is_none() {
            bail!("annotation not found");
        }
        if let Some(content) = input.get("content").and_then(Value::as_str) {
            sqlx::query(r#"UPDATE comments SET content=$1, "updatedAt"=NOW() WHERE id=$2"#).bind(content).bind(id).execute(ctx.state.pool()).await?;
        }
        if let Some(kind) = input.get("kind").and_then(Value::as_str) {
            sqlx::query(r#"UPDATE comments SET kind=$1, "updatedAt"=NOW() WHERE id=$2"#).bind(kind).bind(id).execute(ctx.state.pool()).await?;
        }
        if let Some(status) = input.get("status").and_then(Value::as_str) {
            sqlx::query(r#"UPDATE comments SET status=$1, "updatedAt"=NOW() WHERE id=$2"#).bind(status).bind(id).execute(ctx.state.pool()).await?;
        }
        if let Some(metadata) = input.get("metadata") {
            sqlx::query(r#"UPDATE comments SET metadata=$1, "updatedAt"=NOW() WHERE id=$2"#).bind(metadata).bind(id).execute(ctx.state.pool()).await?;
        }
        let row = sqlx::query(&comment_select_sql("id=$1")).bind(id).fetch_one(ctx.state.pool()).await?;
        Ok(comment_json(&ctx, row, false).await?)
    }
    .boxed()
}

fn delete(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        sqlx::query(
            r#"DELETE FROM comments WHERE id IN (
               SELECT c.id FROM comments c JOIN notes n ON c."noteId"=n.id WHERE c.id=$1 AND n."accountId"=$2 AND c."workspaceId"=$3
            )"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .execute(ctx.state.pool())
        .await?;
        Ok(json!({ "ok": true }))
    }
    .boxed()
}

fn convert_to_todo(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(
            r#"SELECT c.content, c."noteId" FROM comments c JOIN notes n ON c."noteId"=n.id
               WHERE c.id=$1 AND n."accountId"=$2 AND c."workspaceId"=$3"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .fetch_one(ctx.state.pool())
        .await?;
        let fallback_content: String = row.get("content");
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or(&fallback_content)
            .to_string();
        let note_id: i32 = row.get("noteId");
        let metadata = json!({
            "source": { "type": "comment", "commentId": id, "noteId": note_id, "capturedAt": chrono::Utc::now() },
            "memory": { "kind": "todo", "status": "candidate", "sourceNoteIds": [note_id], "createdBy": "user" },
            "todo": { "status": "open", "convertedFromCommentId": id, "convertedFromNoteId": note_id }
        });
        let todo_id: i32 = sqlx::query_scalar(
            r#"INSERT INTO notes (content, type, "accountId", "workspaceId", metadata, "updatedAt")
               VALUES ($1,2,$2,$3,$4,NOW()) RETURNING id"#,
        )
        .bind(content)
        .bind(user.id)
        .bind(ws)
        .bind(metadata)
        .fetch_one(ctx.state.pool())
        .await?;
        sqlx::query(r#"INSERT INTO "noteReference" ("fromNoteId","toNoteId") VALUES ($1,$2) ON CONFLICT DO NOTHING"#)
            .bind(todo_id)
            .bind(note_id)
            .execute(ctx.state.pool())
            .await?;
        sqlx::query(r#"UPDATE comments SET status='resolved', metadata=((COALESCE(metadata,'{}'::json))::jsonb || $1::jsonb)::json, "updatedAt"=NOW() WHERE id=$2"#)
            .bind(json!({ "convertedToTodoId": todo_id, "convertedAt": chrono::Utc::now() }))
            .bind(id)
            .execute(ctx.state.pool())
            .await?;
        let note_row = sqlx::query(&super::notes::note_select_sql("id=$3"))
            .bind(user.id)
            .bind(ws)
            .bind(todo_id)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(note_json(&ctx, note_row).await?)
    }
    .boxed()
}

fn comment_select_sql(extra: &str) -> String {
    format!(
        r#"SELECT id, content, kind, status, metadata, "accountId", "noteId", "workspaceId", "parentId", "createdAt", "updatedAt"
           FROM comments WHERE {extra}"#
    )
}

async fn comment_json(ctx: &ProcedureContext, row: sqlx::postgres::PgRow, with_replies: bool) -> anyhow::Result<Value> {
    let id = row.get::<i32, _>("id");
    let account_id = row.get::<Option<i32>, _>("accountId");
    let replies = if with_replies {
        let rows = sqlx::query(&comment_select_sql(r#""parentId"=$1 ORDER BY "createdAt" ASC, id ASC"#))
            .bind(id)
            .fetch_all(ctx.state.pool())
            .await?;
        let mut out = Vec::new();
        for row in rows {
            out.push(Box::pin(comment_json(ctx, row, false)).await?);
        }
        out
    } else {
        Vec::new()
    };
    Ok(json!({
        "id": id,
        "content": row.get::<String, _>("content"),
        "kind": row.get::<String, _>("kind"),
        "status": row.get::<String, _>("status"),
        "metadata": row.get::<Option<Value>, _>("metadata"),
        "accountId": account_id,
        "noteId": row.get::<i32, _>("noteId"),
        "workspaceId": row.get::<Option<i32>, _>("workspaceId"),
        "parentId": row.get::<Option<i32>, _>("parentId"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt"),
        "account": match account_id { Some(id) => account_brief(ctx, id).await, None => Value::Null },
        "replies": replies
    }))
}
