use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("workspaces.list", list);
    registry.insert("workspaces.create", create);
    registry.insert("workspaces.update", update);
    registry.insert("workspaces.delete", delete);
    registry.insert("workspaces.setDefault", set_default);
    registry.insert("workspaces.getDefault", get_default);
}

fn list(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        ensure_default_workspace(&ctx, user.id).await?;
        let rows = sqlx::query(
            r#"SELECT id, name, description, icon, color, "accountId", "isDefault", "createdAt", "updatedAt"
               FROM workspaces WHERE "accountId"=$1 ORDER BY "isDefault" DESC, "createdAt" ASC"#,
        )
        .bind(user.id)
        .fetch_all(ctx.state.pool())
        .await?;
        Ok(Value::Array(rows.into_iter().map(workspace_json).collect()))
    }
    .boxed()
}

fn create(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let name = input.get("name").and_then(Value::as_str).unwrap_or("").trim();
        if name.is_empty() {
            bail!("name is required");
        }
        let description = input.get("description").and_then(Value::as_str).unwrap_or("");
        let icon = input.get("icon").and_then(Value::as_str).unwrap_or("");
        let color = input.get("color").and_then(Value::as_str).unwrap_or("");
        let count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM workspaces WHERE "accountId"=$1"#)
            .bind(user.id)
            .fetch_one(ctx.state.pool())
            .await?;
        let is_default = count == 0;
        let row = sqlx::query(
            r#"INSERT INTO workspaces (name, description, icon, color, "accountId", "isDefault", "updatedAt")
               VALUES ($1,$2,$3,$4,$5,$6,blinkora_now())
               RETURNING id, name, description, icon, color, "accountId", "isDefault", "createdAt", "updatedAt""#,
        )
        .bind(name)
        .bind(description)
        .bind(icon)
        .bind(color)
        .bind(user.id)
        .bind(is_default)
        .fetch_one(ctx.state.pool())
        .await?;
        Ok(workspace_json(row))
    }
    .boxed()
}

fn update(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        if id <= 0 {
            bail!("id is required");
        }
        let name = input.get("name").and_then(Value::as_str).unwrap_or("");
        let description = input.get("description").and_then(Value::as_str).unwrap_or("");
        let icon = input.get("icon").and_then(Value::as_str).unwrap_or("");
        let color = input.get("color").and_then(Value::as_str).unwrap_or("");
        let row = sqlx::query(
            r#"UPDATE workspaces SET
               name=COALESCE(NULLIF($1,''), name),
               description=COALESCE($2, description),
               icon=COALESCE($3, icon),
               color=COALESCE($4, color),
               "updatedAt"=blinkora_now()
               WHERE id=$5 AND "accountId"=$6
               RETURNING id, name, description, icon, color, "accountId", "isDefault", "createdAt", "updatedAt""#,
        )
        .bind(name)
        .bind(description)
        .bind(icon)
        .bind(color)
        .bind(id)
        .bind(user.id)
        .fetch_one(ctx.state.pool())
        .await?;
        Ok(workspace_json(row))
    }
    .boxed()
}

fn delete(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let is_default: Option<bool> = sqlx::query_scalar(r#"SELECT "isDefault" FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
            .bind(id)
            .bind(user.id)
            .fetch_optional(ctx.state.pool())
            .await?;
        match is_default {
            Some(true) => bail!("cannot delete default workspace"),
            Some(false) => {}
            None => bail!("workspace not found"),
        }
        let attachment_paths: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT path FROM attachments WHERE "workspaceId"=$1 AND COALESCE(path, '') != ''"#,
        )
        .bind(id)
        .fetch_all(ctx.state.pool())
        .await?;
        let staged_deletions =
            crate::attachment_files::stage_attachment_deletions(&ctx, &attachment_paths).await?;
        let database_result: anyhow::Result<()> = async {
            let mut tx = ctx.state.pool().begin().await?;
            for sql in [
                r#"DELETE FROM comments WHERE "workspaceId"=$1"#,
                r#"DELETE FROM "noteHistory" WHERE "workspaceId"=$1"#,
                r#"DELETE FROM "noteReference" WHERE "fromNoteId" IN (SELECT id FROM notes WHERE "workspaceId"=$1) OR "toNoteId" IN (SELECT id FROM notes WHERE "workspaceId"=$1)"#,
                r#"DELETE FROM "tagsToNote" WHERE "noteId" IN (SELECT id FROM notes WHERE "workspaceId"=$1) OR "tagId" IN (SELECT id FROM tag WHERE "workspaceId"=$1)"#,
                r#"DELETE FROM attachments WHERE "workspaceId"=$1"#,
                r#"DELETE FROM tag WHERE "workspaceId"=$1"#,
                r#"DELETE FROM notes WHERE "workspaceId"=$1"#,
                r#"DELETE FROM config WHERE "workspaceId"=$1"#,
            ] {
                sqlx::query(sql).bind(id).execute(&mut *tx).await?;
            }
            sqlx::query(r#"DELETE FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
                .bind(id)
                .bind(user.id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(database_error) = database_result {
            if let Err(rollback_error) =
                crate::attachment_files::rollback_attachment_deletions(staged_deletions).await
            {
                return Err(database_error.context(format!(
                    "workspace delete database transaction failed and attachment rollback also failed: {rollback_error}"
                )));
            }
            return Err(database_error);
        }
        if let Err(error) =
            crate::attachment_files::finalize_attachment_deletions(staged_deletions).await
        {
            tracing::error!(%error, "workspace was deleted but private attachment staging cleanup failed");
        }
        Ok(json!({ "success": true, "deletedAttachmentFiles": attachment_paths.len() }))
    }
    .boxed()
}

fn set_default(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.ok_or_else(|| anyhow!("Unauthorized"))?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let mut tx = ctx.state.pool().begin().await?;
        let exists: Option<i32> = sqlx::query_scalar(r#"SELECT id FROM workspaces WHERE id=$1 AND "accountId"=$2"#)
            .bind(id)
            .bind(user.id)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_none() {
            bail!("workspace not found");
        }
        sqlx::query(r#"UPDATE workspaces SET "isDefault"=false, "updatedAt"=blinkora_now() WHERE "accountId"=$1"#)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(r#"UPDATE workspaces SET "isDefault"=true, "updatedAt"=blinkora_now() WHERE id=$1 AND "accountId"=$2"#)
            .bind(id)
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(json!({ "success": true }))
    }
    .boxed()
}

fn get_default(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        ensure_default_workspace(&ctx, user.id).await?;
        let row = sqlx::query(
            r#"SELECT id, name, description, icon, color, "accountId", "isDefault", "createdAt", "updatedAt"
               FROM workspaces WHERE "accountId"=$1 AND "isDefault"=true LIMIT 1"#,
        )
        .bind(user.id)
        .fetch_optional(ctx.state.pool())
        .await?;
        Ok(row.map(workspace_json).unwrap_or(Value::Null))
    }
    .boxed()
}

async fn ensure_default_workspace(ctx: &ProcedureContext, user_id: i32) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM workspaces WHERE "accountId"=$1"#)
        .bind(user_id)
        .fetch_one(ctx.state.pool())
        .await?;
    if count > 0 {
        return Ok(());
    }
    sqlx::query(r#"INSERT INTO workspaces (name, "accountId", "isDefault", "updatedAt") VALUES ($1,$2,true,blinkora_now())"#)
        .bind("默认工作区")
        .bind(user_id)
        .execute(ctx.state.pool())
        .await?;
    Ok(())
}

fn workspace_json(row: sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": row.get::<i32, _>("id"),
        "name": row.get::<String, _>("name"),
        "description": row.get::<String, _>("description"),
        "icon": row.get::<String, _>("icon"),
        "color": row.get::<String, _>("color"),
        "accountId": row.get::<i32, _>("accountId"),
        "isDefault": row.get::<bool, _>("isDefault"),
        "createdAt": row.get::<chrono::DateTime<chrono::Utc>, _>("createdAt"),
        "updatedAt": row.get::<chrono::DateTime<chrono::Utc>, _>("updatedAt")
    })
}
