use super::common::workspace_id;
use crate::attachment_files::{
    finalize_attachment_deletions, finalize_attachment_moves, rollback_attachment_deletions,
    rollback_attachment_moves, stage_attachment_deletions, stage_attachment_move,
    StagedAttachmentDeletion, StagedAttachmentMove,
};
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

pub fn register(registry: &mut HashMap<&'static str, ProcedureHandler>) {
    registry.insert("attachments.createFolder", create_folder);
    registry.insert("attachments.list", list);
    registry.insert("attachments.rename", rename);
    registry.insert("attachments.move", move_item);
    registry.insert("attachments.delete", delete);
    registry.insert("attachments.deleteMany", delete_many);
}

fn list(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let page = input.get("page").and_then(Value::as_i64).unwrap_or(1).max(1);
        let size = input.get("size").and_then(Value::as_i64).unwrap_or(30).clamp(1, 200);
        let offset = (page - 1) * size;
        let search = input.get("searchText").and_then(Value::as_str).unwrap_or("");
        let folder = input
            .get("folder")
            .or_else(|| input.get("perfixPath"))
            .or_else(|| input.get("prefixPath"))
            .and_then(Value::as_str)
            .unwrap_or("");

        let rows = if !search.is_empty() {
            sqlx::query(
                r#"SELECT id, path, name, CAST(size AS TEXT) AS size, type, "noteId", "sortOrder", "createdAt", "updatedAt",
                          false AS is_folder, NULL AS folder_name
                   FROM attachments
                   WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                      OR ("accountId"=$1 AND "workspaceId"=$2))
                     AND "workspaceId"=$2
                     AND (name LIKE $3 OR path LIKE $3 OR COALESCE("perfixPath", '') LIKE $3)
                   ORDER BY "sortOrder" ASC, ("updatedAt" IS NULL) ASC, "updatedAt" DESC
                   LIMIT $4 OFFSET $5"#,
            )
            .bind(user.id)
            .bind(ws)
            .bind(format!("%{search}%"))
            .bind(size)
            .bind(offset)
            .fetch_all(ctx.state.pool())
            .await?
        } else if !folder.is_empty() {
            let folder_path = slash_to_comma(folder);
            sqlx::query(
                r#"WITH owned AS (
                    SELECT * FROM attachments
                    WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                       OR ("accountId"=$1 AND "workspaceId"=$2))
                      AND "workspaceId"=$2
                  ), child_paths AS (
                    SELECT *, substr("perfixPath", length($3) + 2) AS child_path
                    FROM owned
                    WHERE "perfixPath" LIKE ($3 || ',%')
                  ), folders AS (
                    SELECT NULL AS id,
                      CASE WHEN MIN(path) LIKE '/api/s3file/%' THEN '/api/s3file/' ELSE '/api/file/' END ||
                        CASE WHEN instr(child_path, ',') = 0 THEN child_path ELSE substr(child_path, 1, instr(child_path, ',') - 1) END AS path,
                      CASE WHEN instr(child_path, ',') = 0 THEN child_path ELSE substr(child_path, 1, instr(child_path, ',') - 1) END AS name,
                      NULL AS size, NULL AS type, NULL AS "noteId", 0 AS "sortOrder",
                      NULL AS "createdAt", NULL AS "updatedAt", true AS is_folder,
                      CASE WHEN instr(child_path, ',') = 0 THEN child_path ELSE substr(child_path, 1, instr(child_path, ',') - 1) END AS folder_name
                    FROM child_paths
                    GROUP BY CASE WHEN instr(child_path, ',') = 0 THEN child_path ELSE substr(child_path, 1, instr(child_path, ',') - 1) END
                  ), combined_items AS (
                    SELECT * FROM folders
                    UNION ALL
                    SELECT id, path, name, CAST(size AS TEXT) AS size, type, "noteId", "sortOrder", "createdAt", "updatedAt", false AS is_folder, NULL AS folder_name
                    FROM owned WHERE "perfixPath"=$3
                  )
                  SELECT * FROM combined_items
                  ORDER BY is_folder DESC, "sortOrder" ASC, ("updatedAt" IS NULL) ASC, "updatedAt" DESC
                  LIMIT $4 OFFSET $5"#,
            )
            .bind(user.id)
            .bind(ws)
            .bind(folder_path)
            .bind(size)
            .bind(offset)
            .fetch_all(ctx.state.pool())
            .await?
        } else {
            sqlx::query(
                r#"WITH owned AS (
                    SELECT * FROM attachments
                    WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                       OR ("accountId"=$1 AND "workspaceId"=$2))
                      AND "workspaceId"=$2
                  ), folders AS (
                    SELECT NULL AS id,
                      CASE WHEN MIN(path) LIKE '/api/s3file/%' THEN '/api/s3file/' ELSE '/api/file/' END ||
                        CASE WHEN instr("perfixPath", ',') = 0 THEN "perfixPath" ELSE substr("perfixPath", 1, instr("perfixPath", ',') - 1) END AS path,
                      CASE WHEN instr("perfixPath", ',') = 0 THEN "perfixPath" ELSE substr("perfixPath", 1, instr("perfixPath", ',') - 1) END AS name,
                      NULL AS size, NULL AS type, NULL AS "noteId", 0 AS "sortOrder",
                      NULL AS "createdAt", NULL AS "updatedAt", true AS is_folder,
                      CASE WHEN instr("perfixPath", ',') = 0 THEN "perfixPath" ELSE substr("perfixPath", 1, instr("perfixPath", ',') - 1) END AS folder_name
                    FROM owned
                    WHERE COALESCE("perfixPath", '') != ''
                    GROUP BY CASE WHEN instr("perfixPath", ',') = 0 THEN "perfixPath" ELSE substr("perfixPath", 1, instr("perfixPath", ',') - 1) END
                  ), combined_items AS (
                    SELECT * FROM folders
                    UNION ALL
                    SELECT id, path, name, CAST(size AS TEXT) AS size, type, "noteId", "sortOrder", "createdAt", "updatedAt", false AS is_folder, NULL AS folder_name
                    FROM owned WHERE COALESCE(depth, 0)=0
                  )
                  SELECT * FROM combined_items
                  ORDER BY is_folder DESC, "sortOrder" ASC, ("updatedAt" IS NULL) ASC, "updatedAt" DESC
                  LIMIT $3 OFFSET $4"#,
            )
            .bind(user.id)
            .bind(ws)
            .bind(size)
            .bind(offset)
            .fetch_all(ctx.state.pool())
            .await?
        };

        Ok(Value::Array(rows.into_iter().map(resource_json).collect()))
    }
    .boxed()
}

fn create_folder(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let folder_name = input
            .get("folderName")
            .or_else(|| input.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("New Folder");
        let parent_folder = input.get("parentFolder").and_then(Value::as_str).unwrap_or("");
        let folder_path = if parent_folder.is_empty() {
            folder_name.to_string()
        } else {
            format!("{},{}", slash_to_comma(parent_folder), folder_name)
        };
        let api_path = format!("/api/file/{}/.folder", folder_path.split(',').collect::<Vec<_>>().join("/"));
        sqlx::query(
            r#"INSERT INTO attachments (name, path, size, type, "accountId", "workspaceId", "perfixPath", depth, "sortOrder", "updatedAt")
               VALUES ('.folder',$1,0,'folder',$2,$3,$4,$5,0,blinkora_now())"#,
        )
        .bind(api_path)
        .bind(user.id)
        .bind(ws)
        .bind(&folder_path)
        .bind(folder_path.split(',').count() as i32)
        .execute(ctx.state.pool())
        .await?;
        Ok(json!({ "success": true, "folderName": folder_name, "folderPath": folder_path }))
    }
    .boxed()
}

fn rename(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let is_folder = input.get("isFolder").and_then(Value::as_bool).unwrap_or(false);
        let new_name = input
            .get("newName")
            .or_else(|| input.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if new_name.is_empty() {
            bail!("name is required");
        }
        if is_folder {
            let old_folder_path = input.get("oldFolderPath").and_then(Value::as_str).unwrap_or("");
            if old_folder_path.is_empty() {
                bail!("old folder path is required");
            }
            let old_folder_path = slash_to_comma(old_folder_path);
            let new_folder_path = slash_to_comma(new_name);
            let rows = sqlx::query(
                r#"SELECT id, name, type, path, COALESCE("perfixPath", '') AS "perfixPath"
                   FROM attachments
                   WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                      OR ("accountId"=$1 AND "workspaceId"=$2))
                     AND "workspaceId"=$2
                     AND ("perfixPath"=$3 OR "perfixPath" LIKE ($3 || ',%'))"#,
            )
            .bind(user.id)
            .bind(ws)
            .bind(&old_folder_path)
            .fetch_all(ctx.state.pool())
            .await?;
            let mut updates = Vec::with_capacity(rows.len());
            let mut physical_moves = Vec::with_capacity(rows.len());
            for row in rows {
                let id = row.get::<i32, _>("id");
                let name = row.get::<String, _>("name");
                let attachment_type = row.get::<String, _>("type");
                let old_prefix = row.get::<String, _>("perfixPath");
                let old_path = row.get::<String, _>("path");
                let next_prefix = replace_prefix(&old_prefix, &old_folder_path, &new_folder_path);
                let stored_name = old_path
                    .rsplit_once('/')
                    .map(|(_, name)| name)
                    .ok_or_else(|| anyhow!("Invalid attachment path"))?;
                let next_path = rebuild_api_path(
                    &old_path,
                    &old_prefix,
                    &next_prefix,
                    stored_name,
                )?;
                physical_moves.push(PhysicalMovePlan {
                    attachment_id: id,
                    old_path: old_path.clone(),
                    new_path: next_path.clone(),
                    allow_missing: name == ".folder" || attachment_type == "folder",
                });
                updates.push((id, next_prefix, next_path));
            }
            let staged_moves = stage_resource_moves(&ctx, &physical_moves).await?;
            let database_result: anyhow::Result<()> = async {
                let mut tx = ctx.state.pool().begin().await?;
                for (id, next_prefix, next_path) in updates {
                sqlx::query(r#"UPDATE attachments SET "perfixPath"=$1, path=$2, depth=$3, "updatedAt"=blinkora_now() WHERE id=$4"#)
                    .bind(&next_prefix)
                    .bind(&next_path)
                    .bind(prefix_depth(&next_prefix))
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
                }
                tx.commit().await?;
                Ok(())
            }
            .await;
            if let Err(error) = database_result {
                rollback_moves_after_database_error(staged_moves, error).await?;
            } else if let Err(error) = finalize_attachment_moves(staged_moves).await {
                tracing::error!(%error, "folder rename committed but attachment move journal cleanup failed");
            }
            return Ok(json!({ "success": true }));
        }

        if new_name.contains('/') || new_name.contains('\\') {
            bail!("File names cannot contain path separators");
        }
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(
            r#"SELECT id, name, type, path, COALESCE("perfixPath", '') AS "perfixPath" FROM attachments
               WHERE id=$1 AND (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3))
                  OR ("accountId"=$2 AND "workspaceId"=$3)) AND "workspaceId"=$3"#,
        )
        .bind(id)
        .bind(user.id)
        .bind(ws)
        .fetch_optional(ctx.state.pool())
        .await?
        .ok_or_else(|| anyhow!("Attachment not found"))?;
        let old_name = row.get::<String, _>("name");
        let attachment_type = row.get::<String, _>("type");
        let old_path = row.get::<String, _>("path");
        let current_prefix = row.get::<String, _>("perfixPath");
        let next_path = rebuild_api_path(&old_path, &current_prefix, &current_prefix, new_name)?;
        let staged_moves = stage_resource_moves(
            &ctx,
            &[PhysicalMovePlan {
                attachment_id: id,
                old_path,
                new_path: next_path.clone(),
                allow_missing: old_name == ".folder" || attachment_type == "folder",
            }],
        )
        .await?;
        let database_result: anyhow::Result<()> = async {
            let mut tx = ctx.state.pool().begin().await?;
            sqlx::query(r#"UPDATE attachments SET name=$1, path=$2, "updatedAt"=blinkora_now() WHERE id=$3"#)
                .bind(new_name)
                .bind(next_path)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(error) = database_result {
            rollback_moves_after_database_error(staged_moves, error).await?;
        } else if let Err(error) = finalize_attachment_moves(staged_moves).await {
            tracing::error!(%error, "file rename committed but attachment move journal cleanup failed");
        }
        Ok(json!({ "success": true }))
    }
    .boxed()
}

fn move_item(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
        let ws = workspace_id(&ctx).await?;
        let source_ids = input
            .get("sourceIds")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|value| value.as_i64().map(|id| id as i32)).collect::<Vec<_>>())
            .unwrap_or_else(|| input.get("id").and_then(Value::as_i64).map(|id| vec![id as i32]).unwrap_or_default());
        let target_folder = input
            .get("targetFolder")
            .or_else(|| input.get("perfixPath"))
            .or_else(|| input.get("prefixPath"))
            .and_then(Value::as_str)
            .map(slash_to_comma)
            .unwrap_or_default();
        if source_ids.is_empty() {
            bail!("Attachments not found");
        }
        let requested_ids = source_ids.iter().copied().collect::<HashSet<_>>();
        let rows = sqlx::query(
            r#"SELECT id, name, type, path, COALESCE("perfixPath", '') AS "perfixPath" FROM attachments
               WHERE id IN (SELECT value FROM json_each($1)) AND (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3))
                  OR ("accountId"=$2 AND "workspaceId"=$3)) AND "workspaceId"=$3"#,
        )
        .bind(crate::db::json_array(&source_ids))
        .bind(user.id)
        .bind(ws)
        .fetch_all(ctx.state.pool())
        .await?;
        if rows.len() != requested_ids.len() {
            bail!("Attachments not found");
        }
        let mut updates = Vec::with_capacity(rows.len());
        let mut physical_moves = Vec::with_capacity(rows.len());
        for row in rows {
            let id = row.get::<i32, _>("id");
            let name = row.get::<String, _>("name");
            let attachment_type = row.get::<String, _>("type");
            let old_path = row.get::<String, _>("path");
            let current_prefix = row.get::<String, _>("perfixPath");
            let next_path = rebuild_api_path(&old_path, &current_prefix, &target_folder, &name)?;
            physical_moves.push(PhysicalMovePlan {
                attachment_id: id,
                old_path,
                new_path: next_path.clone(),
                allow_missing: name == ".folder" || attachment_type == "folder",
            });
            updates.push((id, next_path));
        }
        let staged_moves = stage_resource_moves(&ctx, &physical_moves).await?;
        let database_result: anyhow::Result<()> = async {
            let mut tx = ctx.state.pool().begin().await?;
            for (id, next_path) in updates {
                sqlx::query(r#"UPDATE attachments SET "perfixPath"=$1, depth=$2, path=$3, "updatedAt"=blinkora_now() WHERE id=$4"#)
                    .bind(&target_folder)
                    .bind(prefix_depth(&target_folder))
                    .bind(next_path)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            tx.commit().await?;
            Ok(())
        }
        .await;
        if let Err(error) = database_result {
            rollback_moves_after_database_error(staged_moves, error).await?;
        } else if let Err(error) = finalize_attachment_moves(staged_moves).await {
            tracing::error!(%error, "file move committed but attachment move journal cleanup failed");
        }
        Ok(json!({ "success": true, "message": "Files moved successfully" }))
    }
    .boxed()
}

fn delete(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let is_folder = input
            .get("isFolder")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if is_folder {
            let folder_path = input
                .get("folderPath")
                .and_then(Value::as_str)
                .map(slash_to_comma)
                .unwrap_or_default();
            return delete_folder(ctx, &folder_path).await;
        }
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        delete_ids(ctx, vec![id]).await
    }
    .boxed()
}

fn delete_many(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let ids: Vec<i32> = input
            .get("ids")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_i64().map(|n| n as i32))
                    .collect()
            })
            .unwrap_or_default();
        delete_ids(ctx, ids).await
    }
    .boxed()
}

async fn delete_folder(ctx: ProcedureContext, folder_path: &str) -> anyhow::Result<Value> {
    let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
    let ws = workspace_id(&ctx).await?;
    let rows = sqlx::query(
        r#"SELECT id, path FROM attachments
           WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
              OR ("accountId"=$1 AND "workspaceId"=$2))
             AND "workspaceId"=$2
             AND ("perfixPath"=$3 OR "perfixPath" LIKE ($3 || ',%'))"#,
    )
    .bind(user.id)
    .bind(ws)
    .bind(folder_path)
    .fetch_all(ctx.state.pool())
    .await?;
    let ids = rows
        .iter()
        .map(|row| row.get::<i32, _>("id"))
        .collect::<Vec<_>>();
    let paths = rows
        .iter()
        .map(|row| row.get::<String, _>("path"))
        .collect::<Vec<_>>();
    let staged_deletions = stage_attachment_deletions(&ctx, &paths).await?;
    let database_result: anyhow::Result<()> = async {
        let mut tx = ctx.state.pool().begin().await?;
        if !ids.is_empty() {
            sqlx::query(r#"DELETE FROM attachments WHERE id IN (SELECT value FROM json_each($1))"#)
                .bind(crate::db::json_array(&ids))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(error) = database_result {
        rollback_deletions_after_database_error(staged_deletions, error).await?;
    } else if let Err(error) = finalize_attachment_deletions(staged_deletions).await {
        tracing::error!(%error, "attachment rows were deleted but private file staging cleanup failed");
    }
    Ok(json!({ "success": true, "message": "Folder and its contents deleted successfully" }))
}

async fn delete_ids(ctx: ProcedureContext, ids: Vec<i32>) -> anyhow::Result<Value> {
    let user = ctx.user.as_ref().ok_or_else(|| anyhow!("Unauthorized"))?;
    let ws = workspace_id(&ctx).await?;
    if ids.is_empty() {
        return Ok(json!({ "success": true, "message": "Files deleted successfully" }));
    }
    let rows = sqlx::query(
        r#"SELECT id, path FROM attachments
           WHERE id IN (SELECT value FROM json_each($1)) AND (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3))
              OR ("accountId"=$2 AND "workspaceId"=$3)) AND "workspaceId"=$3"#,
    )
    .bind(crate::db::json_array(&ids))
    .bind(user.id)
    .bind(ws)
    .fetch_all(ctx.state.pool())
    .await?;
    let owned_ids = rows
        .iter()
        .map(|row| row.get::<i32, _>("id"))
        .collect::<Vec<_>>();
    let paths = rows
        .iter()
        .map(|row| row.get::<String, _>("path"))
        .collect::<Vec<_>>();
    let staged_deletions = stage_attachment_deletions(&ctx, &paths).await?;
    let database_result: anyhow::Result<()> = async {
        let mut tx = ctx.state.pool().begin().await?;
        if !owned_ids.is_empty() {
            sqlx::query(r#"DELETE FROM attachments WHERE id IN (SELECT value FROM json_each($1))"#)
                .bind(crate::db::json_array(&owned_ids))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    .await;
    if let Err(error) = database_result {
        rollback_deletions_after_database_error(staged_deletions, error).await?;
    } else if let Err(error) = finalize_attachment_deletions(staged_deletions).await {
        tracing::error!(%error, "attachment rows were deleted but private file staging cleanup failed");
    }
    Ok(json!({ "success": true, "message": "Files deleted successfully" }))
}

fn resource_json(row: sqlx::sqlite::SqliteRow) -> Value {
    let is_folder = row.get::<bool, _>("is_folder");
    json!({
        "id": row.get::<Option<i32>, _>("id"),
        "path": row.get::<String, _>("path"),
        "name": row.get::<String, _>("name"),
        "size": row.get::<Option<String>, _>("size"),
        "type": row.get::<Option<String>, _>("type"),
        "noteId": row.get::<Option<i32>, _>("noteId"),
        "sortOrder": row.get::<i32, _>("sortOrder"),
        "createdAt": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("createdAt"),
        "updatedAt": row.get::<Option<chrono::DateTime<chrono::Utc>>, _>("updatedAt"),
        "isFolder": is_folder,
        "folderName": row.get::<Option<String>, _>("folder_name")
    })
}

fn slash_to_comma(path: &str) -> String {
    path.trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

fn prefix_depth(prefix: &str) -> i32 {
    if prefix.is_empty() {
        0
    } else {
        prefix.split(',').count() as i32
    }
}

fn replace_prefix(value: &str, old_prefix: &str, new_prefix: &str) -> String {
    if value == old_prefix {
        new_prefix.to_string()
    } else if let Some(rest) = value.strip_prefix(&format!("{old_prefix},")) {
        format!("{new_prefix},{rest}")
    } else {
        value.to_string()
    }
}

fn rebuild_api_path(
    old_path: &str,
    current_prefix: &str,
    target_prefix: &str,
    stored_name: &str,
) -> anyhow::Result<String> {
    if stored_name.is_empty() || stored_name.contains('/') || stored_name.contains('\\') {
        bail!("Invalid attachment name");
    }
    let (base, relative_path) = if let Some(relative) = old_path.strip_prefix("/api/s3file/") {
        ("/api/s3file/", relative)
    } else if let Some(relative) = old_path.strip_prefix("/api/file/") {
        ("/api/file/", relative)
    } else {
        bail!("Invalid attachment path");
    };
    let current_directory = relative_path
        .rsplit_once('/')
        .map(|(directory, _)| directory)
        .unwrap_or("");
    let current_folder = current_prefix.split(',').collect::<Vec<_>>().join("/");
    let storage_root = if current_folder.is_empty() {
        current_directory
    } else {
        current_directory
            .strip_suffix(&current_folder)
            .filter(|root| root.is_empty() || root.ends_with('/'))
            .ok_or_else(|| anyhow!("Attachment path does not match its resource folder"))?
            .trim_end_matches('/')
    };
    let target_folder = target_prefix.split(',').collect::<Vec<_>>().join("/");
    let next_relative = [storage_root, target_folder.as_str(), stored_name]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    Ok(format!("{base}{next_relative}"))
}

struct PhysicalMovePlan {
    attachment_id: i32,
    old_path: String,
    new_path: String,
    allow_missing: bool,
}

async fn stage_resource_moves(
    ctx: &ProcedureContext,
    plans: &[PhysicalMovePlan],
) -> anyhow::Result<Vec<StagedAttachmentMove>> {
    let mut staged = Vec::with_capacity(plans.len());
    for plan in plans {
        match stage_attachment_move(
            ctx,
            plan.attachment_id,
            &plan.old_path,
            &plan.new_path,
            plan.allow_missing,
        )
        .await
        {
            Ok(item) => staged.push(item),
            Err(stage_error) => {
                if let Err(rollback_error) = rollback_attachment_moves(staged).await {
                    return Err(stage_error.context(format!(
                        "physical attachment move failed and rollback also failed: {rollback_error}"
                    )));
                }
                return Err(stage_error);
            }
        }
    }
    Ok(staged)
}

async fn rollback_moves_after_database_error(
    staged: Vec<StagedAttachmentMove>,
    database_error: anyhow::Error,
) -> anyhow::Result<()> {
    match rollback_attachment_moves(staged).await {
        Ok(()) => Err(database_error),
        Err(rollback_error) => Err(database_error.context(format!(
            "attachment database transaction failed and physical rollback also failed: {rollback_error}"
        ))),
    }
}

async fn rollback_deletions_after_database_error(
    staged: Vec<StagedAttachmentDeletion>,
    database_error: anyhow::Error,
) -> anyhow::Result<()> {
    match rollback_attachment_deletions(staged).await {
        Ok(()) => Err(database_error),
        Err(rollback_error) => Err(database_error.context(format!(
            "attachment database transaction failed and physical rollback also failed: {rollback_error}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::handlers::test_support::HandlerTestFixture;
    use crate::trpc::ProcedureContext;

    fn cloned_context(fixture: &HandlerTestFixture) -> ProcedureContext {
        ProcedureContext {
            state: fixture.ctx.state.clone(),
            user: fixture.ctx.user.clone(),
        }
    }

    #[test]
    fn resource_paths_keep_their_physical_storage_root() {
        assert_eq!(
            rebuild_api_path(
                "/api/s3file/blinkora_local/existing/file-123.txt",
                "",
                "folder,nested",
                "renamed.txt",
            )
            .unwrap(),
            "/api/s3file/blinkora_local/existing/folder/nested/renamed.txt"
        );
        assert_eq!(
            rebuild_api_path(
                "/api/s3file/blinkora_local/existing/folder/old.txt",
                "folder",
                "renamed",
                "old.txt",
            )
            .unwrap(),
            "/api/s3file/blinkora_local/existing/renamed/old.txt"
        );
        assert_eq!(
            rebuild_api_path(
                "/api/file/folder/generated.txt",
                "folder",
                "",
                "original.txt",
            )
            .unwrap(),
            "/api/file/original.txt"
        );
        assert!(rebuild_api_path(
            "/api/s3file/blinkora_local/other/file.txt",
            "folder",
            "target",
            "file.txt",
        )
        .is_err());
    }

    async fn seed_local_attachment(
        fixture: &HandlerTestFixture,
        name: &str,
    ) -> (i32, std::path::PathBuf) {
        let api_path = format!("/api/file/{name}");
        let physical_path = fixture.data_dir.join("files").join(name);
        tokio::fs::create_dir_all(physical_path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&physical_path, format!("bytes for {name}"))
            .await
            .unwrap();
        let id = sqlx::query_scalar(
            r#"INSERT INTO attachments
               (name, path, size, type, "accountId", "workspaceId", "perfixPath", depth, "sortOrder", "updatedAt")
               VALUES ($1, $2, 12, 'text/plain', $3, $4, '', 0, 0, blinkora_now())
               RETURNING id"#,
        )
        .bind(name)
        .bind(api_path)
        .bind(fixture.account_id)
        .bind(fixture.workspace_id)
        .fetch_one(&fixture.pool)
        .await
        .unwrap();
        (id, physical_path)
    }

    #[tokio::test]
    async fn multi_file_move_rolls_back_database_and_files_together() {
        let fixture = HandlerTestFixture::new("attachment-move-rollback").await;
        let (first_id, first_path) = seed_local_attachment(&fixture, "first.txt").await;
        let (second_id, second_path) = seed_local_attachment(&fixture, "second.txt").await;
        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_second_attachment_move
               BEFORE UPDATE OF path ON attachments
               WHEN OLD.id={second_id}
               BEGIN SELECT RAISE(ABORT, 'forced attachment move failure'); END"#
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();

        let result = move_item(
            cloned_context(&fixture),
            json!({
                "sourceIds": [first_id, second_id],
                "targetFolder": "target"
            }),
        )
        .await;
        assert!(result.is_err());
        assert!(tokio::fs::try_exists(&first_path).await.unwrap());
        assert!(tokio::fs::try_exists(&second_path).await.unwrap());
        assert!(
            !tokio::fs::try_exists(fixture.data_dir.join("files/target/first.txt"))
                .await
                .unwrap()
        );
        assert!(
            !tokio::fs::try_exists(fixture.data_dir.join("files/target/second.txt"))
                .await
                .unwrap()
        );
        let paths: Vec<String> =
            sqlx::query_scalar(r#"SELECT path FROM attachments WHERE id IN ($1, $2) ORDER BY id"#)
                .bind(first_id)
                .bind(second_id)
                .fetch_all(&fixture.pool)
                .await
                .unwrap();
        assert_eq!(paths, vec!["/api/file/first.txt", "/api/file/second.txt"]);
        fixture.cleanup().await;
    }

    #[tokio::test]
    async fn failed_delete_restores_the_physical_file_and_database_row() {
        let fixture = HandlerTestFixture::new("attachment-delete-rollback").await;
        let (attachment_id, physical_path) = seed_local_attachment(&fixture, "delete-me.txt").await;
        sqlx::query(&format!(
            r#"CREATE TRIGGER fail_attachment_delete
               BEFORE DELETE ON attachments
               WHEN OLD.id={attachment_id}
               BEGIN SELECT RAISE(ABORT, 'forced attachment delete failure'); END"#
        ))
        .execute(&fixture.pool)
        .await
        .unwrap();

        let result = delete_ids(cloned_context(&fixture), vec![attachment_id]).await;
        assert!(result.is_err());
        assert!(tokio::fs::try_exists(&physical_path).await.unwrap());
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachments WHERE id=$1")
            .bind(attachment_id)
            .fetch_one(&fixture.pool)
            .await
            .unwrap();
        assert_eq!(row_count, 1);
        fixture.cleanup().await;
    }
}
