use super::common::{tag_json, workspace_id};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("tags.list", list);
    registry.insert("tags.fullTagNameById", full_name);
    registry.insert("tags.updateTagMany", update_many);
    registry.insert("tags.updateTagName", update_name);
    registry.insert("tags.updateTagIcon", update_icon);
    registry.insert("tags.deleteOnlyTag", delete_only);
    registry.insert("tags.deleteTagWithAllNote", delete_with_notes);
    registry.insert("tags.updateTagOrder", update_order);
}

fn list(ctx: ProcedureContext, _input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let rows = sqlx::query(
            r#"SELECT id, name, icon, parent, "accountId", "workspaceId", "sortOrder", "createdAt", "updatedAt"
               FROM tag WHERE "accountId"=$1 AND "workspaceId"=$2 ORDER BY "sortOrder" ASC"#,
        )
        .bind(user.id)
        .bind(ws)
        .fetch_all(ctx.state.pool())
        .await?;
        Ok(Value::Array(rows.into_iter().map(tag_json).collect()))
    }
    .boxed()
}

fn full_name(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let mut id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let mut parts = Vec::new();
        while id > 0 {
            let row = sqlx::query(r#"SELECT name, parent FROM tag WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
                .bind(id)
                .bind(user.id)
                .bind(ws)
                .fetch_optional(ctx.state.pool())
                .await?;
            let Some(row) = row else { break };
            parts.insert(0, row.get::<String, _>("name"));
            id = row.get::<i32, _>("parent");
        }
        if parts.is_empty() {
            bail!("tag not found");
        }
        Ok(json!(format!("#{}", parts.join("/"))))
    }
    .boxed()
}

fn update_many(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let ids: Vec<i32> = input
            .get("ids")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|v| v.as_i64().map(|n| n as i32)).collect())
            .unwrap_or_default();
        let tag = input.get("tag").and_then(Value::as_str).unwrap_or("");
        if ids.is_empty() || tag.is_empty() {
            return Ok(json!(true));
        }
        let rows = sqlx::query(r#"SELECT id, content FROM notes WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(&ids)
            .bind(user.id)
            .bind(ws)
            .fetch_all(ctx.state.pool())
            .await?;
        for row in rows {
            let content = format!("{} #{}", row.get::<String, _>("content"), tag);
            sqlx::query(r#"UPDATE notes SET content=$1, "updatedAt"=NOW() WHERE id=$2"#)
                .bind(content)
                .bind(row.get::<i32, _>("id"))
                .execute(ctx.state.pool())
                .await?;
        }
        Ok(json!(true))
    }
    .boxed()
}

fn update_name(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let new_name = input.get("newName").and_then(Value::as_str).unwrap_or("");
        sqlx::query(r#"UPDATE tag SET name=$1, "updatedAt"=NOW() WHERE id=$2 AND "accountId"=$3 AND "workspaceId"=$4"#)
            .bind(new_name)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!(true))
    }
    .boxed()
}

fn update_icon(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    update_tag_field(ctx, input, "icon")
}

fn update_order(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let sort_order = input.get("sortOrder").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(
            r#"UPDATE tag SET "sortOrder"=$1, "updatedAt"=NOW()
               WHERE id=$2 AND "accountId"=$3 AND "workspaceId"=$4
               RETURNING id, name, icon, parent, "accountId", "workspaceId", "sortOrder", "createdAt", "updatedAt""#,
        )
        .bind(sort_order)
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .fetch_one(ctx.state.pool())
        .await?;
        Ok(tag_json(row))
    }
    .boxed()
}

fn update_tag_field(ctx: ProcedureContext, input: Value, field: &'static str) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let value = input.get(field).and_then(Value::as_str).unwrap_or("");
        let sql = format!(
            r#"UPDATE tag SET {field}=$1, "updatedAt"=NOW()
               WHERE id=$2 AND "accountId"=$3 AND "workspaceId"=$4
               RETURNING id, name, icon, parent, "accountId", "workspaceId", "sortOrder", "createdAt", "updatedAt""#
        );
        let row = sqlx::query(&sql)
            .bind(value)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .fetch_one(ctx.state.pool())
            .await?;
        Ok(tag_json(row))
    }
    .boxed()
}

fn delete_only(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "tagId"=$1"#).bind(id).execute(ctx.state.pool()).await?;
        sqlx::query(r#"DELETE FROM tag WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!(true))
    }
    .boxed()
}

fn delete_with_notes(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let note_ids: Vec<i32> = sqlx::query_scalar(r#"SELECT "noteId" FROM "tagsToNote" WHERE "tagId"=$1"#)
            .bind(id)
            .fetch_all(ctx.state.pool())
            .await?;
        if !note_ids.is_empty() {
            sqlx::query(r#"UPDATE notes SET "isRecycle"=true, "updatedAt"=NOW() WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
                .bind(&note_ids)
                .bind(user.id)
                .bind(ws)
                .execute(ctx.state.pool())
                .await?;
        }
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "tagId"=$1"#).bind(id).execute(ctx.state.pool()).await?;
        sqlx::query(r#"DELETE FROM tag WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(ctx.state.pool())
            .await?;
        Ok(json!(true))
    }
    .boxed()
}
