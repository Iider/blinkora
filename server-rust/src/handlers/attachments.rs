use super::common::workspace_id;
use crate::s3;
use crate::trpc::{ProcedureContext, ProcedureFuture, ProcedureHandler};
use anyhow::{anyhow, bail};
use futures::FutureExt;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tokio::fs;

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
                r#"SELECT id, path, name, size::text AS size, type, "noteId", "sortOrder", "createdAt", "updatedAt",
                          false AS is_folder, NULL::text AS folder_name
                   FROM attachments
                   WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                      OR ("accountId"=$1 AND "workspaceId"=$2))
                     AND "workspaceId"=$2
                     AND (name ILIKE $3 OR path ILIKE $3 OR COALESCE("perfixPath", '') ILIKE $3)
                   ORDER BY "sortOrder" ASC, "updatedAt" DESC NULLS LAST
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
                r#"WITH combined_items AS (
                    SELECT DISTINCT ON (folder_name)
                      NULL::int AS id,
                      CASE WHEN path LIKE '/api/s3file/%' THEN '/api/s3file/' ELSE '/api/file/' END || split_part("perfixPath", ',', array_length(string_to_array($3, ','), 1) + 1) AS path,
                      split_part("perfixPath", ',', array_length(string_to_array($3, ','), 1) + 1) AS name,
                      NULL::text AS size,
                      NULL::text AS type,
                      NULL::int AS "noteId",
                      0 AS "sortOrder",
                      NULL::timestamptz AS "createdAt",
                      NULL::timestamptz AS "updatedAt",
                      true AS is_folder,
                      split_part("perfixPath", ',', array_length(string_to_array($3, ','), 1) + 1) AS folder_name
                    FROM attachments
                    WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                       OR ("accountId"=$1 AND "workspaceId"=$2))
                      AND "workspaceId"=$2
                      AND "perfixPath" LIKE ($3 || ',%')
                      AND array_length(string_to_array("perfixPath", ','), 1) > array_length(string_to_array($3, ','), 1)
                    UNION ALL
                    SELECT id, path, name, size::text AS size, type, "noteId", "sortOrder", "createdAt", "updatedAt", false AS is_folder, NULL::text AS folder_name
                    FROM attachments
                    WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                       OR ("accountId"=$1 AND "workspaceId"=$2))
                      AND "workspaceId"=$2
                      AND "perfixPath"=$3
                  )
                  SELECT * FROM combined_items
                  ORDER BY is_folder DESC, "sortOrder" ASC, "updatedAt" DESC NULLS LAST
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
                r#"WITH combined_items AS (
                    SELECT DISTINCT ON (folder_name)
                      NULL::int AS id,
                      CASE WHEN path LIKE '/api/s3file/%' THEN '/api/s3file/' ELSE '/api/file/' END || split_part("perfixPath", ',', 1) AS path,
                      split_part("perfixPath", ',', 1) AS name,
                      NULL::text AS size,
                      NULL::text AS type,
                      NULL::int AS "noteId",
                      0 AS "sortOrder",
                      NULL::timestamptz AS "createdAt",
                      NULL::timestamptz AS "updatedAt",
                      true AS is_folder,
                      split_part("perfixPath", ',', 1) AS folder_name
                    FROM attachments
                    WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                       OR ("accountId"=$1 AND "workspaceId"=$2))
                      AND "workspaceId"=$2
                      AND COALESCE("perfixPath", '') != ''
                    UNION ALL
                    SELECT id, path, name, size::text AS size, type, "noteId", "sortOrder", "createdAt", "updatedAt", false AS is_folder, NULL::text AS folder_name
                    FROM attachments
                    WHERE (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$1 AND "workspaceId"=$2))
                       OR ("accountId"=$1 AND "workspaceId"=$2))
                      AND "workspaceId"=$2
                      AND COALESCE(depth, 0)=0
                  )
                  SELECT * FROM combined_items
                  ORDER BY is_folder DESC, "sortOrder" ASC, "updatedAt" DESC NULLS LAST
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
               VALUES ('.folder',$1,0,'folder',$2,$3,$4,$5,0,NOW())"#,
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
                r#"SELECT id, path, COALESCE("perfixPath", '') AS "perfixPath"
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
            for row in rows {
                let id = row.get::<i32, _>("id");
                let old_prefix = row.get::<String, _>("perfixPath");
                let old_path = row.get::<String, _>("path");
                let next_prefix = replace_prefix(&old_prefix, &old_folder_path, &new_folder_path);
                let next_path = replace_api_folder_prefix(&old_path, &old_folder_path, &new_folder_path);
                move_local_file(&ctx, &old_path, &next_path).await;
                sqlx::query(r#"UPDATE attachments SET "perfixPath"=$1, path=$2, depth=$3, "updatedAt"=NOW() WHERE id=$4"#)
                    .bind(&next_prefix)
                    .bind(&next_path)
                    .bind(prefix_depth(&next_prefix))
                    .bind(id)
                    .execute(ctx.state.pool())
                    .await?;
            }
            return Ok(json!({ "success": true }));
        }

        if new_name.contains('/') || new_name.contains('\\') {
            bail!("File names cannot contain path separators");
        }
        let id = input.get("id").and_then(Value::as_i64).unwrap_or_default() as i32;
        let row = sqlx::query(
            r#"SELECT id, name, path FROM attachments
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
        let old_path = row.get::<String, _>("path");
        let next_path = old_path.rsplit_once('/').map(|(dir, _)| format!("{dir}/{new_name}")).unwrap_or_else(|| old_path.replace(&old_name, new_name));
        move_local_file(&ctx, &old_path, &next_path).await;
        sqlx::query(r#"UPDATE attachments SET name=$1, path=$2, "updatedAt"=NOW() WHERE id=$3"#)
            .bind(new_name)
            .bind(next_path)
            .bind(id)
            .execute(ctx.state.pool())
            .await?;
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
        let rows = sqlx::query(
            r#"SELECT id, name, path FROM attachments
               WHERE id=ANY($1) AND (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3))
                  OR ("accountId"=$2 AND "workspaceId"=$3)) AND "workspaceId"=$3"#,
        )
        .bind(&source_ids)
        .bind(user.id)
        .bind(ws)
        .fetch_all(ctx.state.pool())
        .await?;
        if rows.is_empty() {
            bail!("Attachments not found");
        }
        for row in rows {
            let id = row.get::<i32, _>("id");
            let name = row.get::<String, _>("name");
            let old_path = row.get::<String, _>("path");
            let base = if old_path.starts_with("/api/s3file/") { "/api/s3file/" } else { "/api/file/" };
            let next_path = if target_folder.is_empty() {
                format!("{base}{name}")
            } else {
                format!("{}{}/{}", base, target_folder.split(',').collect::<Vec<_>>().join("/"), name)
            };
            move_local_file(&ctx, &old_path, &next_path).await;
            sqlx::query(r#"UPDATE attachments SET "perfixPath"=$1, depth=$2, path=$3, "updatedAt"=NOW() WHERE id=$4"#)
                .bind(&target_folder)
                .bind(prefix_depth(&target_folder))
                .bind(next_path)
                .bind(id)
                .execute(ctx.state.pool())
                .await?;
        }
        Ok(json!({ "success": true, "message": "Files moved successfully" }))
    }
    .boxed()
}

fn delete(ctx: ProcedureContext, input: Value) -> ProcedureFuture {
    async move {
        let is_folder = input.get("isFolder").and_then(Value::as_bool).unwrap_or(false);
        if is_folder {
            let folder_path = input.get("folderPath").and_then(Value::as_str).map(slash_to_comma).unwrap_or_default();
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
            .map(|items| items.iter().filter_map(|v| v.as_i64().map(|n| n as i32)).collect())
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
    let ids = rows.iter().map(|row| row.get::<i32, _>("id")).collect::<Vec<_>>();
    for row in rows {
        delete_local_file(&ctx, &row.get::<String, _>("path")).await;
    }
    if !ids.is_empty() {
        sqlx::query(r#"DELETE FROM attachments WHERE id=ANY($1)"#).bind(&ids).execute(ctx.state.pool()).await?;
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
           WHERE id=ANY($1) AND (("noteId" IN (SELECT id FROM notes WHERE "accountId"=$2 AND "workspaceId"=$3))
              OR ("accountId"=$2 AND "workspaceId"=$3)) AND "workspaceId"=$3"#,
    )
    .bind(&ids)
    .bind(user.id)
    .bind(ws)
    .fetch_all(ctx.state.pool())
    .await?;
    let owned_ids = rows.iter().map(|row| row.get::<i32, _>("id")).collect::<Vec<_>>();
    for row in rows {
        delete_local_file(&ctx, &row.get::<String, _>("path")).await;
    }
    if !owned_ids.is_empty() {
        sqlx::query(r#"DELETE FROM attachments WHERE id=ANY($1)"#).bind(&owned_ids).execute(ctx.state.pool()).await?;
    }
    Ok(json!({ "success": true, "message": "Files deleted successfully" }))
}

fn resource_json(row: sqlx::postgres::PgRow) -> Value {
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
    path.trim_matches('/').split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>().join(",")
}

fn prefix_depth(prefix: &str) -> i32 {
    if prefix.is_empty() { 0 } else { prefix.split(',').count() as i32 }
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

fn replace_api_folder_prefix(path: &str, old_prefix: &str, new_prefix: &str) -> String {
    let old_slash = old_prefix.split(',').collect::<Vec<_>>().join("/");
    let new_slash = new_prefix.split(',').collect::<Vec<_>>().join("/");
    path.replace(&format!("/api/file/{old_slash}"), &format!("/api/file/{new_slash}"))
        .replace(&format!("/api/s3file/{old_slash}"), &format!("/api/s3file/{new_slash}"))
}

async fn move_local_file(ctx: &ProcedureContext, old_api_path: &str, new_api_path: &str) {
    if old_api_path.starts_with("/api/s3file/") || new_api_path.starts_with("/api/s3file/") {
        let (Some(old_key), Some(new_key)) = (s3_key_from_api_path(old_api_path), s3_key_from_api_path(new_api_path)) else {
            return;
        };
        if let Ok(Some(config)) = s3::load_s3_config(&ctx.state).await {
            if s3::copy_object(&config, &old_key, &new_key).await.is_ok() {
                let _ = s3::delete_object(&config, &old_key).await;
            }
        }
        return;
    }
    let (Some(old_path), Some(new_path)) = (api_file_relative_path(old_api_path), api_file_relative_path(new_api_path)) else {
        return;
    };
    let root = Path::new(&ctx.state.config.data_dir).join("files");
    let source = root.join(old_path);
    let target = root.join(new_path);
    if fs::try_exists(&source).await.unwrap_or(false) {
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent).await;
        }
        let _ = fs::rename(source, target).await;
    }
}

async fn delete_local_file(ctx: &ProcedureContext, api_path: &str) {
    if api_path.starts_with("/api/s3file/") {
        if let (Ok(Some(config)), Some(key)) = (s3::load_s3_config(&ctx.state).await, s3_key_from_api_path(api_path)) {
            let _ = s3::delete_object(&config, &key).await;
        }
        return;
    }
    let Some(relative_path) = api_file_relative_path(api_path) else {
        return;
    };
    let path = Path::new(&ctx.state.config.data_dir).join("files").join(relative_path);
    let _ = fs::remove_file(path).await;
}

fn api_file_relative_path(path: &str) -> Option<PathBuf> {
    let relative = path.strip_prefix("/api/file/").or_else(|| path.strip_prefix("/api/s3file/"))?;
    if relative.contains('\0') || relative.contains('\\') || relative.starts_with('/') || relative.split('/').any(|part| part == "..") {
        return None;
    }
    Some(PathBuf::from(relative))
}

fn s3_key_from_api_path(path: &str) -> Option<String> {
    let key = path.strip_prefix("/api/s3file/")?;
    if key.contains('\0') || key.contains('\\') || key.starts_with('/') || key.split('/').any(|part| part == "..") {
        return None;
    }
    Some(key.to_string())
}
