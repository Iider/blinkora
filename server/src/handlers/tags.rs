use super::common::{tag_json, workspace_id};
use super::operation_logs::{
    content_change_detail, insert_note_log_if_enabled_tx, note_title, OperationLogDraft,
};
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
        let rows = sqlx::query(r#"SELECT id, type, content FROM notes WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(&ids)
            .bind(user.id)
            .bind(ws)
            .fetch_all(ctx.state.pool())
            .await?;
        let mut tx = ctx.state.pool().begin().await?;
        for row in rows {
            let note_id = row.get::<i32, _>("id");
            let note_type = row.get::<i32, _>("type");
            let old_content = row.get::<String, _>("content");
            let content = format!("{} #{}", old_content, tag);
            sqlx::query(r#"UPDATE notes SET content=$1, "updatedAt"=NOW() WHERE id=$2"#)
                .bind(&content)
                .bind(note_id)
                .execute(&mut *tx)
                .await?;
            super::notes::sync_tags(&ctx, &mut tx, note_id, user.id, ws, &content).await?;
            let title = note_title(&content, note_id);
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "tagUpdate".to_string(),
                    note_id,
                    note_type,
                    previous_note_type: Some(note_type),
                    note_title: title.clone(),
                    changed_fields: vec!["content".to_string(), "tags".to_string()],
                    summary: format!("Updated note tag: {title}"),
                    details: json!({
                        "content": content_change_detail(Some(&old_content), &content, None),
                        "tags": { "addedText": format!("#{tag}") }
                    }),
                },
            )
            .await?;
        }
        tx.commit().await?;
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
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "tagId"=$1"#)
            .bind(id)
            .execute(ctx.state.pool())
            .await?;
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
        let note_rows = sqlx::query(
            r#"SELECT n.id, n.type, n.content, n."isRecycle"
               FROM "tagsToNote" ttn
               JOIN notes n ON n.id=ttn."noteId"
               WHERE ttn."tagId"=$1 AND n."accountId"=$2 AND n."workspaceId"=$3"#,
        )
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .fetch_all(ctx.state.pool())
            .await?;
        let note_ids = note_rows
            .iter()
            .map(|row| row.get::<i32, _>("id"))
            .collect::<Vec<_>>();
        let mut tx = ctx.state.pool().begin().await?;
        if !note_ids.is_empty() {
            sqlx::query(r#"UPDATE notes SET "isRecycle"=true, "updatedAt"=NOW() WHERE id=ANY($1) AND "accountId"=$2 AND "workspaceId"=$3"#)
                .bind(&note_ids)
                .bind(user.id)
                .bind(ws)
                .execute(&mut *tx)
                .await?;
        }
        for row in note_rows {
            let note_id = row.get::<i32, _>("id");
            let note_type = row.get::<i32, _>("type");
            let content = row.get::<String, _>("content");
            let was_recycle = row.get::<bool, _>("isRecycle");
            let title = note_title(&content, note_id);
            let mut changed_fields = vec!["tags".to_string()];
            let mut details = json!({ "tags": { "deletedTagId": id } });
            if !was_recycle {
                changed_fields.insert(0, "flags".to_string());
                if let Some(object) = details.as_object_mut() {
                    object.insert(
                        "flags".to_string(),
                        json!({ "isRecycle": { "before": false, "after": true } }),
                    );
                }
            }
            insert_note_log_if_enabled_tx(
                &ctx,
                &mut tx,
                user,
                OperationLogDraft {
                    action: "tagDeleteWithNotes".to_string(),
                    note_id,
                    note_type,
                    previous_note_type: Some(note_type),
                    note_title: title.clone(),
                    changed_fields,
                    summary: format!("Deleted tag with note: {title}"),
                    details,
                },
            )
            .await?;
        }
        sqlx::query(r#"DELETE FROM "tagsToNote" WHERE "tagId"=$1"#).bind(id).execute(&mut *tx).await?;
        sqlx::query(r#"DELETE FROM tag WHERE id=$1 AND "accountId"=$2 AND "workspaceId"=$3"#)
            .bind(id)
            .bind(user.id)
            .bind(ws)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(json!(true))
    }
    .boxed()
}
